/**
 * 小红书解析。
 *
 * 主路径：移动端分享页（discovery/item + xsec_token + iPhone UA）
 *   → 200 且自带 window.__INITIAL_STATE__
 *   → noteData.data.noteData 里就是笔记
 *   不需要登录、不需要浏览器、不占设备名额。
 *
 * 兜底：链接里没有 xsec_token 时，开真窗口读桌面版的 noteDetailMap。
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJob, publicJob } from './bili.mjs';

const ROOT = join(homedir(), '.dsh', 'bili-dl');
const PROFILE = join(ROOT, 'browser-profile');
const PORT = 9365;

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export const looksLikeXhs = (url) => /(xiaohongshu\.com|xhslink\.(?:com|cn))/i.test(String(url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 链接解析：noteId + xsec_token ─────────────────────────────────── */

export function parseXhsUrl(input) {
  const text = String(input || '').trim();
  const idMatch = text.match(/(?:explore|discovery\/item|item)\/([0-9a-f]{20,30})/i);
  const tokenMatch = text.match(/[?&]xsec_token=([^&#]+)/);
  return {
    id: idMatch ? idMatch[1] : '',
    token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : '',
  };
}

export async function resolveNoteId(input) {
  const parsed = parseXhsUrl(input);
  if (parsed.id) return parsed;

  let current = String(input).trim();
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': UA_MOBILE }, signal: AbortSignal.timeout(12000) });
    const loc = res.headers.get('location');
    if (!loc) break;
    current = new URL(loc, current).toString();
    const next = parseXhsUrl(current);
    if (next.id) return next;
  }
  throw new Error('没能从链接里解析出笔记 ID');
}

/* ── 移动端分享页：主路径 ──────────────────────────────────────────── */

function extractState(html) {
  const marker = 'window.__INITIAL_STATE__=';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;

  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;

  const raw = html.slice(start, end + 1);
  for (const candidate of [raw, raw.replace(/\bundefined\b/g, 'null')]) {
    try { return JSON.parse(candidate); } catch { /* next */ }
  }
  return null;
}

async function probeMobile({ id, token }) {
  const url = `https://www.xiaohongshu.com/discovery/item/${id}`
    + `?source=webshare&xhsshare=pc_web&xsec_token=${encodeURIComponent(token)}&xsec_source=pc_share`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA_MOBILE, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status !== 200) throw new Error(`分享页返回 HTTP ${res.status}`);
  const html = await res.text();
  if (/需手机扫码|笔记暂时无法浏览/.test(html)) throw new Error('小红书要求手机扫码验证，请在浏览器里打开该链接完成验证');

  const state = extractState(html);
  const note = state?.noteData?.data?.noteData;
  if (!note) throw new Error('分享页里没有笔记数据（可能已删除或私密）');
  return normalize(note, id, state);
}

/**
 * 按真实结构取视频流：note.video.media.stream.{h264|h265|h266|av1}[].masterUrl
 * 编码优先级 h264 > h265 > av1 > h266（h264 兼容性最好）。
 */
const CODEC_PREF = [['h264', 'H.264'], ['h265', 'H.265'], ['av1', 'AV1'], ['h266', 'H.266']];

function extractVideos(note) {
  const stream = note?.video?.media?.stream;
  if (!stream) return [];
  const out = [];
  for (const [key, label] of CODEC_PREF) {
    for (const item of stream[key] || []) {
      if (!item?.masterUrl) continue;
      out.push({
        qn: item.height || 720,
        label: label + (item.height ? ` ${item.height}P` : ''),
        codec: label,
        height: item.height || 0,
        vip: false,
        bandwidth: item.avgBitrate || item.videoBitrate || 0,
        url: item.masterUrl,
        backups: item.backupUrls || [],
      });
    }
  }
  return out;
}

/**
 * 小红书图片水印的两个来源：
 *   · sns-webpic-qc 的 h5_1080jpg / wgth 模板 —— 中央有「小红书」水印
 *   · sns-img-qc 的 nd_dft_wgth_webp_3 —— 同一张原图，无水印、分辨率更高
 * 所以统一把 fileId 拼到 sns-img-qc 上。
 */
function cleanImageUrl(img) {
  const raw = img?.urlDefault || img?.url || (img?.infoList || []).find((x) => /DTL|DFT/.test(x.imageScene || ''))?.url || '';
  const fileId = img?.fileId || String(raw).split('!')[0].split('?')[0].split('/').pop();
  if (!fileId) return raw;
  return `https://sns-img-qc.xhscdn.com/${fileId}!nd_dft_wgth_webp_3`;
}

function normalize(note, id, wholeState) {
  const videos = extractVideos(note);
  /* 时长：capa.duration 是秒；stream[].duration 是毫秒 */
  const rawDur = note?.video?.capa?.duration
    ?? note?.video?.media?.stream?.h264?.[0]?.duration
    ?? 0;
  const duration = rawDur > 1000 ? Math.round(rawDur / 1000) : Math.round(rawDur || 0);
  const images = (note.imageList || []).map(cleanImageUrl).filter(Boolean);

  return {
    source: 'xhs',
    bvid: '', aid: 0, cid: 0,
    title: note.title || (note.desc || '').split('\n')[0] || `小红书 ${id}`,
    partTitle: '', page: 1, pageCount: 1,
    duration,
    cover: images[0] || (note.cover?.urlDefault || note.cover?.url || '') || '',
    up: {
      mid: 0,
      name: note.user?.nickName || note.user?.nickname || '',
      face: note.user?.avatar || '',
    },
    images: videos.length ? [] : images.map((url, i) => ({
      id: `img${i + 1}`,
      label: images.length > 1 ? `图 ${i + 1}` : '图片',
      url,
    })),
    /* 图文作品的图片已经在 images 里；封面只给视频笔记用，避免重复 */
    covers: videos.length
      ? images.slice(0, 1).map((url) => ({ id: 'cover', label: '封面', url }))
      : [],
    videos,
    audios: [],
    maxQn: 0,
    hasDurl: false,
    noteId: id,
    noteType: note.type,
    desc: note.desc || '',
  };
}

/* ── 兜底：真窗口读桌面版 ──────────────────────────────────────────── */

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const seq = { n: 0 };
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq.n;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('open', () => resolve({ ws, send }), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
}

async function waitPort(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await sleep(250);
  }
  return false;
}

async function probeBrowser(targetUrl, id) {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('需要 Edge 或 Chrome 才能读取小红书');

  await mkdir(ROOT, { recursive: true });
  const child = spawn(exe, [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check', '--new-window', targetUrl,
  ], { stdio: 'ignore', windowsHide: false });

  const cleanup = () => {
    try { child.kill(); } catch { /* ignore */ }
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  };

  try {
    if (!(await waitPort(PORT))) throw new Error('浏览器没起来');
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && /xiaohongshu/.test(t.url)) || list.find((t) => t.type === 'page');
    const { ws, send } = await connect(page.webSocketDebuggerUrl);
    await send('Runtime.enable');

    const expr = `(() => {
      try {
        const map = window.__INITIAL_STATE__?.note?.noteDetailMap;
        if (!map) return { ready: false };
        const entry = map['${id}'];
        const note = entry?.note || entry;
        if (!note || !note.noteId) return { ready: false };
        return { ready: true, note: {
          noteId: note.noteId, type: note.type, title: note.title, desc: note.desc,
          user: { nickName: note.user?.nickname || '', avatar: note.user?.avatar || '' },
          imageList: (note.imageList || []).map((i) => ({ urlDefault: i.urlDefault || i.url, infoList: i.infoList })),
        } };
      } catch (e) { return { ready: false }; }
    })()`;

    let note = null;
    let wallHit = false;
    let deadline = Date.now() + 25000;
    const wallExpr = `(() => /需手机扫码|笔记暂时无法浏览|安全验证|请完成验证/.test(document.body ? document.body.innerText : ''))()`;

    for (let i = 0; Date.now() < deadline; i++) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      const v = r.result?.result?.value;
      if (v?.ready && v.note) { note = v.note; break; }
      if (!wallHit && i % 2 === 1) {
        const w = await send('Runtime.evaluate', { expression: wallExpr, returnByValue: true });
        if (w.result?.result?.value === true) { wallHit = true; deadline = Date.now() + 150000; }
      }
      await sleep(500);
    }
    ws.close();
    if (!note) throw new Error(wallHit
      ? '小红书要求手机扫码验证：请在刚弹出的窗口里扫码，通过后再点一次「解析」'
      : '页面里没等到笔记数据，可能登录态失效');
    return normalize(note, id, null);
  } finally {
    cleanup();
  }
}

/* ── 对外 ──────────────────────────────────────────────────────────── */

export async function xhsProbe(input) {
  const { id, token } = await resolveNoteId(input);
  if (token) {
    try {
      return await probeMobile({ id, token });
    } catch (err) {
      if (!/需手机扫码/.test(err.message)) {
        try { return await probeBrowser(String(input).trim(), id); } catch { /* 抛原始错误 */ }
      }
      throw err;
    }
  }
  return probeBrowser(String(input).trim(), id);
}

/* ── 下载 ──────────────────────────────────────────────────────────── */

const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', Referer: 'https://www.xiaohongshu.com/' };
const safe = (s, n = 60) => String(s || 'xiaohongshu').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, n) || 'xiaohongshu';

const extOf = (buf) => (buf.subarray(0, 4).toString() === 'RIFF' ? '.webp'
  : buf.subarray(1, 4).toString() === 'PNG' ? '.png'
    : buf[0] === 0xff ? '.jpg' : '.jpg');

export async function startXhsDownload(req, { info, onUpdate } = {}) {
  const controller = new AbortController();
  const job = createJob(info.title, req.outDir, controller);
  const notify = () => onUpdate?.(publicJob(job));
  const pick = req.pick || {};

  (async () => {
    try {
      await mkdir(req.outDir, { recursive: true });
      const base = `${safe(info.title, 45)}[${info.noteId}]`;
      const wanted = [
        ...((info.covers || []).filter((c) => (pick.coverIds || []).includes(c.id))),
        ...((info.images || []).filter((c) => (pick.imageIds || []).includes(c.id))),
      ];

      for (const c of wanted) {
        const item = { kind: 'image', label: c.label, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        try {
          const res = await fetch(c.url, { headers: H, signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const file = join(req.outDir, `${base}_${safe(c.label, 16)}${extOf(buf)}`);
          await writeFile(file, buf);
          item.file = file; item.status = 'done';
        } catch (err) {
          item.status = 'error'; item.error = err.message;
        }
        notify();
      }

      if (pick.videoQn !== null && pick.videoQn !== undefined && info.videos?.[0]) {
        const v = info.videos[0];
        const item = { kind: 'video', label: '视频', status: 'working', file: null, error: null, parts: [{ name: 'download', received: 0, total: 0 }] };
        job.items.push(item); notify();
        try {
          let last = 0;
          for (const url of [v.url, ...(v.backups || [])]) {
            const res = await fetch(url, { headers: H, signal: controller.signal, redirect: 'follow' });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const total = Number(res.headers.get('content-length')) || 0;
            const chunks = [];
            let received = 0;
            for await (const chunk of res.body) {
              chunks.push(chunk);
              received += chunk.length;
              if (received - last > 262144) { last = received; item.parts[0].received = received; item.parts[0].total = total; notify(); }
            }
            const buf = Buffer.concat(chunks);
            const file = join(req.outDir, `${base}.mp4`);
            await writeFile(file, buf);
            item.file = file; item.status = 'done';
            item.parts[0].received = received; item.parts[0].total = total || received;
            notify();
            break;
          }
          if (item.status !== 'done') throw new Error('全部 CDN 均失败');
        } catch (err) {
          item.status = 'error'; item.error = err.message;
        }
        notify();
      }

      if (pick.avatar && info.up?.face) {
        const item = { kind: 'avatar', label: `作者头像 · ${info.up.name}`, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        try {
          const res = await fetch(info.up.face, { headers: H, signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const file = join(req.outDir, `${safe(info.up.name, 40)}_头像${extOf(buf)}`);
          await writeFile(file, buf);
          item.file = file; item.status = 'done';
        } catch (err) { item.status = 'error'; item.error = err.message; }
        notify();
      }

      if (!job.items.length) throw new Error('没有勾选任何项目');
      job.status = 'done'; job.endedAt = Date.now(); notify();
    } catch (err) {
      for (const it of job.items) if (it.status === 'working') { it.status = 'error'; it.error = err.message; }
      job.status = controller.signal.aborted ? 'canceled' : 'error';
      job.error = controller.signal.aborted ? '已取消' : err.message;
      job.endedAt = Date.now(); notify();
    }
  })();

  return publicJob(job);
}
