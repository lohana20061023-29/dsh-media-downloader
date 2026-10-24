/**
 * 抖音原生解析：短视频走分享页 SSR（iesdouyin.com），不依赖 yt-dlp 的 msToken。
 *
 * 链路：v.douyin.com 短链 → 跟跳拿 aweme_id → 分享页 HTML
 *      → window._ROUTER_DATA → videoInfoRes.item_list[0]
 *      → video.play_addr（把 /playwm/ 换成 /play/ 即无水印）
 */
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJob, publicJob, imageExtFrom } from './bili.mjs';

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const COOKIE_FILE = join(homedir(), '.dsh', 'bili-dl', 'cookies.txt');

export const looksLikeDouyin = (url) => /(^|\/\/)([a-z0-9-]+\.)?(douyin|iesdouyin)\.com\//i.test(String(url));

const TTWID_FILE = join(homedir(), '.dsh', 'bili-dl', 'ttwid.json');
let ttwidCache = null;

/** 从 cookies.txt 里捞一个现成的 ttwid（有就用，省一次注册） */
function ttwidFromJar() {
  try {
    const text = readFileSync(COOKIE_FILE, 'utf8');
    const rows = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
    const hit = rows.find((r) => r.length >= 7 && r[5] === 'ttwid' && /douyin/.test(r[0]));
    return hit ? hit[6] : '';
  } catch {
    return '';
  }
}

/**
 * 抖音只需要一个匿名访客标识 ttwid，不需要登录。
 * 本地没有就向字节的 union register 接口领一个，并缓存 7 天。
 */
async function getTtwid() {
  if (ttwidCache) return ttwidCache;

  try {
    const saved = JSON.parse(readFileSync(TTWID_FILE, 'utf8'));
    if (saved?.ttwid && Date.now() - (saved.at || 0) < 7 * 86400_000) {
      ttwidCache = saved.ttwid;
      return ttwidCache;
    }
  } catch { /* 没有缓存 */ }

  const fromJar = ttwidFromJar();
  if (fromJar) {
    ttwidCache = fromJar;
    return ttwidCache;
  }

  try {
    const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA_MOBILE },
      body: JSON.stringify({
        region: 'cn', aid: 1768, needFid: false, service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of cookies) {
      const m = /^ttwid=([^;]+)/.exec(sc);
      if (m) {
        ttwidCache = m[1];
        try { writeFileSync(TTWID_FILE, JSON.stringify({ ttwid: m[1], at: Date.now() }), 'utf8'); } catch { /* ignore */ }
        return ttwidCache;
      }
    }
  } catch { /* 签发失败就退回空 cookie */ }

  return '';
}

async function douyinCookieHeader() {
  const ttwid = await getTtwid();
  return ttwid ? `ttwid=${ttwid}` : '';
}

async function follow(url, jar) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, {
      headers: { 'User-Agent': UA_MOBILE, Cookie: jar, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const location = res.headers.get('location');
    if (!location) return current;
    current = new URL(location, current).toString();
  }
  return current;
}

/** 从任意抖音链接里拿到 aweme_id。 */
export async function resolveAwemeId(input) {
  const text = String(input || '').trim();
  const direct = text.match(/(?:video|note|share\/video)\/(\d{15,25})/);
  if (direct) return direct[1];
  const jar = await douyinCookieHeader();
  const finalUrl = await follow(text, jar);
  const m = finalUrl.match(/(?:video|note|share\/video)\/(\d{15,25})/);
  if (!m) throw new Error('没能从链接里解析出视频 ID');
  return m[1];
}

function toNoWatermark(u) {
  return String(u).replace('/playwm/', '/play/');
}

/** 探测：返回与面板通用的 info 结构。 */
export async function douyinProbe(input) {
  const id = await resolveAwemeId(input);
  const jar = await douyinCookieHeader();
  const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
  const res = await fetch(shareUrl, {
    headers: { 'User-Agent': UA_MOBILE, Cookie: jar, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`分享页返回 HTTP ${res.status}`);
  const html = await res.text();

  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!m) throw new Error('分享页里没找到数据（可能改版）');

  let data;
  try { data = JSON.parse(m[1]); }
  catch { throw new Error('分享页数据结构无法解析'); }

  const loader = data.loaderData || {};
  let item = null;
  for (const value of Object.values(loader)) {
    const list = value?.videoInfoRes?.item_list;
    if (Array.isArray(list) && list.length) { item = list[0]; break; }
  }
  if (!item) throw new Error('没有拿到视频信息（可能已删除、私密，或需要登录）');

  const playList = item.video?.play_addr?.url_list || [];
  const images = (item.images || [])
    .map((img) => (img.url_list || [])[0] || (img.download_url_list || [])[0])
    .filter(Boolean);

  /* 图文作品：没有视频流但有图片，走图片下载 */
  if (!playList.length) {
    if (!images.length) throw new Error('这个作品既没有视频也没有图片');
    return {
      source: 'douyin', bvid: '', aid: 0, cid: 0,
      title: item.desc || `抖音 ${id}`,
      partTitle: '', page: 1, pageCount: 1,
      duration: 0,
      cover: images[0],
      up: { mid: 0, name: item.author?.nickname || '', face: (item.author?.avatar_thumb?.url_list || [])[0] || '' },
      videos: [], audios: [],
      images: images.map((url, i) => ({ id: `img${i + 1}`, label: `图 ${i + 1}`, url })),
      covers: [],
      awemeId: id, maxQn: 0, hasDurl: false,
    };
  }
  const watermarked = playList[0];
  const clean = toNoWatermark(watermarked);
  const height = /ratio=(\d+)p/.exec(watermarked)?.[1] || '';

  return {
    source: 'douyin',
    bvid: '', aid: 0, cid: 0,
    title: item.desc || `抖音 ${id}`,
    partTitle: '',
    page: 1, pageCount: 1,
    duration: Math.round((item.video?.duration || 0) / 1000) || 0,
    cover: item.video?.origin_cover?.url_list?.[0] || item.video?.cover?.url_list?.[0] || '',
    /* 抖音同时可能给 3:4 / 4:3 / 动态封面，逐份列出来 */
    covers: [
      { id: 'origin', label: '原图', url: item.video?.origin_cover?.url_list?.[0] },
      { id: 'cover', label: '封面', url: item.video?.cover?.url_list?.[0] },
      { id: 'dynamic', label: '动态封面', url: item.video?.dynamic_cover?.url_list?.[0] },
    ].filter((c, i, arr) => c.url && arr.findIndex((x) => x.url === c.url) === i),
    up: { mid: 0, name: item.author?.nickname || '', face: (item.author?.avatar_thumb?.url_list || [])[0] || '' },
    videos: [{
      qn: Number(height) || 720,
      label: `无水印${height ? ' ' + height + 'P' : ''}`,
      codec: 'H.264',
      height: Number(height) || 720,
      vip: false,
      bandwidth: 0,
      url: clean,
      backups: [watermarked],
    }],
    audios: [],
    images,
    awemeId: id,
    maxQn: Number(height) || 720,
    hasDurl: false,
  };
}

/* ── 下载 ────────────────────────────────────────────────────────────── */

const STREAM_HEADERS = { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' };

async function streamTo(urls, filePath, onProgress, signal) {
  let lastErr;
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await fetch(url, { headers: STREAM_HEADERS, signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const out = createWriteStream(filePath);
      let received = 0;
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress?.(received, total);
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (total && received !== total) throw new Error('下载不完整');
      return received;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error(`下载失败：${lastErr?.message || 'unknown'}`);
}

const safe = (s, n = 80) => String(s || 'douyin').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, n) || 'douyin';

export async function startDouyinDownload(req, { info, onUpdate } = {}) {
  const controller = new AbortController();
  const job = createJob(info.title, req.outDir, controller);
  const notify = () => onUpdate?.(publicJob(job));
  const pick = req.pick || {};

  (async () => {
    try {
      await mkdir(req.outDir, { recursive: true });
      const base = `${safe(info.title, 45)}[${info.awemeId}]`;

      if (pick.videoQn && info.videos[0]) {
        const v = info.videos[0];
        const item = { kind: 'video', label: `视频 ${v.label}`, status: 'working', file: null, error: null, parts: [{ name: 'download', received: 0, total: 0 }] };
        job.items.push(item); notify();
        const target = join(req.outDir, `${base}.mp4`);
        await streamTo([v.url, ...v.backups], target, (r, t) => {
          item.parts[0].received = r;
          if (t) item.parts[0].total = t;
          notify();
        }, controller.signal);
        item.file = target;
        item.status = 'done';
        notify();
      }

      /* 图文作品：按选中的图片下载 */
      const wantedImages = (info.images || []).filter((c) => (pick.imageIds || []).includes(c.id));
      for (const img of wantedImages) {
        const item = { kind: 'image', label: img.label, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        try {
          const res = await fetch(img.url, { headers: STREAM_HEADERS, signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const ext = buf.subarray(0, 4).toString() === 'RIFF' ? '.webp'
            : buf.subarray(1, 4).toString() === 'PNG' ? '.png' : '.jpg';
          const target = join(req.outDir, `${base}_${safe(img.label, 12)}${ext}`);
          const { writeFile } = await import('node:fs/promises');
          await writeFile(target, buf);
          item.file = target; item.status = 'done';
        } catch (err) { item.status = 'error'; item.error = err.message; }
        notify();
      }

      const wantedCovers = (info.covers || []).filter((c) =>
        pick.coverIds ? pick.coverIds.includes(c.id) : pick.cover);
      for (const c of wantedCovers) {
        const item = { kind: 'cover', label: `封面 · ${c.label}`, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        try {
          const res = await fetch(c.url, { headers: STREAM_HEADERS, signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const target = join(req.outDir, `${base}_封面_${safe(c.label, 12)}${imageExtFrom(buf)}`);
          const { writeFile } = await import('node:fs/promises');
          await writeFile(target, buf);
          item.file = target;
          item.status = 'done';
        } catch (err) {
          item.status = 'error';
          item.error = err.message;
        }
        notify();
      }

      if (pick.avatar && info.up?.face) {
        const item = { kind: 'avatar', label: `作者头像 · ${info.up.name}`, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        const res = await fetch(info.up.face, { headers: STREAM_HEADERS, signal: controller.signal });
        if (!res.ok) throw new Error(`头像 HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const target = join(req.outDir, `${safe(info.up.name, 40)}_头像${imageExtFrom(buf)}`);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(target, buf);
        item.file = target;
        item.status = 'done';
        notify();
      }

      if (!job.items.length) throw new Error('没有勾选任何项目');
      job.status = 'done';
      job.endedAt = Date.now();
      notify();
    } catch (err) {
      for (const it of job.items) {
        if (it.status === 'working') { it.status = 'error'; it.error = controller.signal.aborted ? '已取消' : err.message; }
      }
      job.status = controller.signal.aborted ? 'canceled' : 'error';
      job.error = controller.signal.aborted ? '已取消' : err.message;
      job.endedAt = Date.now();
      notify();
    }
  })();

  return publicJob(job);
}
