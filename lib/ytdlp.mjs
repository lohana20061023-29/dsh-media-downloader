/**
 * yt-dlp 通道 —— 非 B 站站点的下载复用同一套 job / 进度 / 面板数据模型。
 *
 * 只做「公开可下载」的内容：yt-dlp 拿不到 DRM 加密流，这里也不做任何
 * 解密/破解处理，遇到受保护内容如实报错。
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createJob, publicJob, findFfmpeg, registerImage, getProxy, fetchBytes } from './bili.mjs';

const CANDIDATES = () => [
  process.env.YTDLP_PATH,
  join(homedir(), '.dsh', 'bili-dl', 'bin', 'yt-dlp.exe'),
  'D:\\VidBrowser\\resources\\vendor\\bin\\yt-dlp.exe',
  'yt-dlp.exe',
  'yt-dlp',
].filter(Boolean);

let cachedExe;

/* ── 登录态：浏览器 cookie 或 Netscape cookies.txt ────────────────────── */

let cookieOpts = { browser: '', file: '' };

export function setCookieOpts(next) {
  cookieOpts = { ...cookieOpts, ...(next || {}) };
}

export const getCookieOpts = () => ({ ...cookieOpts });

function cookieArgs() {
  if (cookieOpts.browser) return ['--cookies-from-browser', cookieOpts.browser];
  if (cookieOpts.file) return ['--cookies', cookieOpts.file];
  return [];
}

function canRun(exe) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(exe, ['--version'], { windowsHide: true, stdio: 'ignore' }); }
    catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

export async function resolveYtDlp(hint) {
  if (cachedExe && !hint) return cachedExe;
  for (const c of [hint, ...CANDIDATES()].filter(Boolean)) {
    if (await canRun(c)) { cachedExe = c; return c; }
  }
  throw new Error('找不到 yt-dlp：把 yt-dlp.exe 放到 ~/.dsh/bili-dl/bin/ 或设置环境变量 YTDLP_PATH');
}

/** 跑一次并收集输出；onLine 用于解析进度。 */
function run(exe, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    let buf = '';
    const outChunks = [];
    let outBytes = 0;
    const OUT_LIMIT = 32 * 1024 * 1024; // -J 的元数据可能上 MB，不能只留尾部

    child.stdout.on('data', (d) => {
      const text = d.toString();
      if (outBytes < OUT_LIMIT) { outChunks.push(text); outBytes += text.length; }
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        onLine?.(line);
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-20_000); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const stdout = outChunks.join('');
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.split('\n').filter(Boolean).slice(-4).join(' | ')
        || stdout.split('\n').filter(Boolean).slice(-4).join(' | ');
      reject(new Error(`yt-dlp 失败(${code})：${tail || '无输出'}`));
    });
  });
}

/* ── 探测 + 归一化成面板通用的 info 结构 ─────────────────────────────── */

const CODEC_NAME = (v) => {
  if (!v) return '?';
  if (v.startsWith('avc1')) return 'AVC';
  if (v.startsWith('hvc1') || v.startsWith('hev1')) return 'HEVC';
  if (v.startsWith('vp09') || v.startsWith('vp9')) return 'VP9';
  if (v.startsWith('vp08') || v.startsWith('vp8')) return 'VP8';
  if (v.startsWith('av01')) return 'AV1';
  return v.split('.')[0];
};

export async function ytProbe(url, { hint } = {}) {
  const exe = await resolveYtDlp(hint);
  const base = ['-J', '--no-warnings', '--no-playlist', '--no-progress'];
  const proxy = getProxy();
  if (proxy) base.push('--proxy', proxy);
  base.push(...cookieArgs());
  base.push('--', url);
  const { stdout } = await run(exe, base);
  let meta;
  try { meta = JSON.parse(stdout); }
  catch { throw new Error('yt-dlp 返回的元数据无法解析'); }
  if (meta._type === 'playlist' && meta.entries?.length) meta = meta.entries[0];

  /* 同分辨率留编码最兼容/码率最高的一条 */
  const byHeight = new Map();
  for (const f of meta.formats || []) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    const pref = f.vcodec.startsWith('avc1') ? 3 : f.vcodec.startsWith('vp9') ? 2 : f.vcodec.startsWith('av01') ? 1 : 1;
    const score = pref * 1e7 + (f.tbr || 0);
    const cur = byHeight.get(f.height);
    if (!cur) byHeight.set(f.height, { f, score, codecs: new Set([CODEC_NAME(f.vcodec)]) });
    else {
      cur.codecs.add(CODEC_NAME(f.vcodec));
      if (score > cur.score) { cur.f = f; cur.score = score; }
    }
  }

  /* 实际下载时由 yt-dlp 按它自己的排序挑编码，所以这里如实列出该分辨率可用的编码 */
  const videos = [...byHeight.values()]
    .sort((a, b) => b.f.height - a.f.height)
    .map(({ f, codecs }) => ({
      qn: f.height,
      label: `${f.height}P`,
      codec: [...codecs].join('/'),
      height: f.height,
      vip: false,
      bandwidth: Math.round((f.tbr || 0) * 1000),
      url: '',
      backups: [],
    }));

  const audios = (meta.formats || [])
    .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
    .map((f, i) => ({
      id: i + 1,
      label: f.abr ? `${Math.round(f.abr)}k` : (f.format_note || '音轨'),
      kbps: Math.round(f.abr || 0),
      vip: false,
      url: '',
      backups: [],
    }));

  if (meta.thumbnail) registerImage(meta.thumbnail);

  return {
    source: 'ytdlp',
    extractor: meta.extractor_key || meta.extractor || 'generic',
    siteUrl: meta.webpage_url || url,
    mediaId: String(meta.id || ''),
    bvid: '',
    aid: 0,
    cid: 0,
    title: meta.title || '未命名',
    partTitle: '',
    page: 1,
    pageCount: 1,
    duration: Math.round(meta.duration || 0),
    cover: meta.thumbnail || '',
    up: {
      mid: 0,
      name: meta.uploader || meta.channel || meta.creator || meta.uploader_id || '',
      face: '',
    },
    videos,
    audios: audios.length ? audios : [{ id: 1, label: '跟随最佳音轨', kbps: 0, vip: false, url: '', backups: [] }],
    maxQn: videos[0]?.qn ?? 0,
    hasDurl: false,
  };
}

/* ── 下载 ────────────────────────────────────────────────────────────── */

async function newestOutput(dir, mediaId) {
  let names;
  try { names = await readdir(dir); } catch { return null; }
  const scored = [];
  for (const name of names) {
    if (/\.(part|ytdl|temp)$/i.test(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = await stat(full); } catch { continue; }
    if (!st.isFile()) continue;
    const byId = mediaId && name.includes(`[${mediaId}]`) ? 1 : 0;
    scored.push({ full, byId, mtime: st.mtimeMs });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.byId - a.byId || b.mtime - a.mtime);
  return scored[0].full;
}

/**
 * 与 bili 的 startDownload 同签名，产出同样的 job 结构。
 * pick: { videoQn: height | null, audio: bool, audioMp3: bool, cover: bool }
 */
export async function ytStartDownload(req, { info, onUpdate } = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const job = createJob(info.title, req.outDir, controller);
  const notify = () => onUpdate?.(publicJob(job));
  const pick = req.pick || {};

  (async () => {
    try {
      await mkdir(req.outDir, { recursive: true });
      const exe = await resolveYtDlp(req.ytdlp);
      const ffmpeg = await findFfmpeg(req.ffmpeg);

      const wantVideo = Boolean(pick.videoQn);
      const wantMp3 = !wantVideo && Boolean(pick.audioMp3);
      const item = {
        kind: wantVideo ? 'video' : 'audio',
        label: wantVideo ? `视频 ${pick.videoQn}P` : `音频${wantMp3 ? ' · MP3' : ''}`,
        status: 'working', file: null, error: null,
        parts: [{ name: 'download', received: 0, total: 100 }],
      };
      job.items.push(item); notify();

      const args = [
        '--no-warnings', '--no-playlist', '--newline', '--no-mtime',
        '--retries', '5', '--concurrent-fragments', '4',
        '--merge-output-format', 'mp4',
        '-o', join(req.outDir, '%(title).80B [%(id)s].%(ext)s'),
      ];
      if (ffmpeg && (ffmpeg.includes('\\\\') || ffmpeg.includes('/'))) args.push('--ffmpeg-location', dirname(ffmpeg));
      const proxy = getProxy();
      if (proxy) args.push('--proxy', proxy);
      args.push(...cookieArgs());

      if (wantVideo) {
        const h = Number(pick.videoQn);
        // 优先视频流+音频流合并；站点只有合流格式时逐级退化
        args.push('-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`);
      } else if (wantMp3) {
        args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else {
        args.push('-f', 'ba/b');
      }
      args.push('--', req.url);

      let lastPct = -1;
      await run(exe, args, {
        signal,
        onLine: (line) => {
          const m = /\[download\]\s+([\d.]+)%/.exec(line);
          if (!m) return;
          const pct = Math.min(100, Number(m[1]));
          if (pct === lastPct) return;
          lastPct = pct;
          item.parts[0].received = pct;
          notify();
        },
      });

      const file = await newestOutput(req.outDir, info.mediaId);
      item.file = file;
      item.status = 'done';
      item.parts[0].received = 100;
      notify();

      /* 视频 + 勾了音频：再跑一趟只取音轨，存成独立音频文件 */
      if (wantVideo && pick.audio) {
        const aItem = {
          kind: 'audio', label: `额外音频${pick.audioMp3 ? ' · MP3' : ''}`,
          status: 'working', file: null, error: null,
          parts: [{ name: 'download', received: 0, total: 100 }],
        };
        job.items.push(aItem); notify();
        const aArgs = [
          '--no-warnings', '--no-playlist', '--newline', '--no-mtime',
          '--retries', '5', '--concurrent-fragments', '4',
          '-o', join(req.outDir, '%(title).80B [%(id)s].audio.%(ext)s'),
        ];
        if (ffmpeg) aArgs.push('--ffmpeg-location', dirname(ffmpeg));
        if (proxy) aArgs.push('--proxy', proxy);
        aArgs.push(...cookieArgs());
        if (pick.audioMp3) aArgs.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
        else aArgs.push('-f', 'ba/b');
        aArgs.push('--', req.url);
        await run(exe, aArgs, {
          signal,
          onLine: (line) => {
            const m = /\[download\]\s+([\d.]+)%/.exec(line);
            if (m) { aItem.parts[0].received = Math.min(100, Number(m[1])); notify(); }
          },
        });
        const aFile = await newestOutput(req.outDir, info.mediaId);
        aItem.file = aFile;
        aItem.status = 'done';
        aItem.parts[0].received = 100;
        notify();
      }

      if (pick.cover && info.cover) {
        const { body } = await fetchBytes(info.cover);
        const coverFile = join(req.outDir, `${info.title.slice(0, 80)}_封面${extOf(info.cover)}`);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(coverFile, body);
        job.items.push({ kind: 'cover', label: '封面', status: 'done', file: coverFile, error: null, parts: [] });
        notify();
      }

      job.status = 'done';
      job.endedAt = Date.now();
      notify();
    } catch (err) {
      for (const it of job.items) {
        if (it.status === 'working') { it.status = 'error'; it.error = signal.aborted ? '已取消' : err.message; }
      }
      job.status = signal.aborted ? 'canceled' : 'error';
      job.error = signal.aborted ? '已取消' : err.message;
      job.endedAt = Date.now();
      notify();
    }
  })();

  return publicJob(job);
}

function extOf(url) {
  const m = /\.(jpe?g|png|webp|gif)(?:\?|$)/i.exec(url || '');
  return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

async function fetchCover(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`封面下载失败 HTTP ${res.status}`);
  return { body: Buffer.from(await res.arrayBuffer()) };
}
