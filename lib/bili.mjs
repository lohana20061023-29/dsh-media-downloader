/**
 * B 站下载引擎。
 *
 * 一条链路走完：WBI 签名请求 → 取 DASH 流 → 带 Referer 下载 → ffmpeg 合流成 mp4。
 *
 * 对外导出：
 *   probe()         解析链接，返回画质/音轨/封面/作者信息
 *   startDownload() 建下载任务，支持视频、音频、封面、头像
 *   findFfmpeg()    定位可用的 ffmpeg
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
const ORIGIN = 'https://www.bilibili.com';

/* ─────────────────────────── 登录 Cookie ─────────────────────────── */
/* 匿名只能拿到 ≤480P 的流；带 SESSDATA 才能解锁 720P/1080P/4K。 */

let cookieHeader = '';

export function setCookie(raw) {
  cookieHeader = String(raw || '').trim().replace(/^cookie:\s*/i, '');
  wbiCache = { at: 0, img: '', sub: '' }; // 身份变了，WBI 密钥缓存作废
}

export const hasCookie = () => cookieHeader.length > 0;

/* ───────────────────────────── 出口代理 ───────────────────────────── */
/* Node 的 fetch 不认 Windows 系统代理，而 YouTube / 各站点缩略图往往需要代理。
   这里只对「非 B 站」地址走代理，B 站直连，免得白烧机场流量。 */

let proxyUrl = '';

export function setProxy(v) { proxyUrl = String(v || '').trim(); }
export const getProxy = () => proxyUrl;

function isBiliHost(url) {
  try { return /(^|\.)(hdslb\.com|bilibili\.com)$/i.test(new URL(url).hostname); }
  catch { return false; }
}

/**
 * 由一张原图生成不同比例的封面选项。
 * B 站 CDN 用 `@<宽>w_<高>h_1c.<格式>` 后缀做等比裁剪，服务端实时生成。
 */
export function buildCovers(pic) {
  if (!pic) return [];
  const base = String(pic).split('@')[0];
  /* 普通稿件（UGC）在本站只有一张原始封面，另两种比例都是它的裁切，
     所以标注里带「裁切」二字，避免被当成平台另存的素材。 */
  return [
    { id: 'origin', label: '原图', url: base },
    { id: '16x9', label: '16:9 · 裁切', url: `${base}@672w_378h_1c.webp` },
    { id: '4x3', label: '4:3 · 裁切', url: `${base}@480w_360h_1c.webp` },
  ];
}

/** 按文件头判断图片扩展名——平台下发的可能是 webp，不能一律 .jpg。 */
export function imageExtFrom(buf) {
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (buf.length > 8 && buf.subarray(1, 4).toString() === 'PNG') return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 3 && buf.subarray(0, 3).toString() === 'GIF') return '.gif';
  return '.jpg';
}

function sniffType(buf, url) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length > 3 && buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  const m = /\.(jpe?g|png|webp|gif)(?:\?|$)/i.exec(url || '');
  return m ? `image/${m[1].toLowerCase().replace('jpg', 'jpeg')}` : 'application/octet-stream';
}

/** 走 curl 拿字节（curl 会用 --proxy 显式出口，绕开 Node fetch 不认系统代理的问题）。 */
function curlBytes(url, proxy) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl.exe', [
      '-sSL', '--max-time', '90', '--proxy', proxy, '-o', '-', url,
    ], { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    child.on('error', (e) => reject(new Error(`curl 启动失败：${e.message}`)));
    child.on('close', (code) => {
      const body = Buffer.concat(chunks);
      if (code !== 0) return reject(new Error(`经代理下载失败(${code})${err ? '：' + err.split('\n')[0].trim() : ''}`));
      if (!body.length) return reject(new Error('经代理下载到 0 字节'));
      resolve({ type: sniffType(body, url), body });
    });
  });
}

/** 取任意图片/二进制资源：非 B 站且配了代理时走 curl。 */
export async function fetchBytes(url) {
  if (proxyUrl && !isBiliHost(url)) return curlBytes(url, proxyUrl);
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  return { type, body: Buffer.from(await res.arrayBuffer()) };
}

function headers(extra = {}) {
  const h = { 'User-Agent': UA, Referer: REFERER, ...extra };
  if (cookieHeader) h.Cookie = cookieHeader;
  return h;
}

/** 校验登录态：返回 { login, uname, face }。 */
export async function loginStatus() {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: headers() });
  const json = await res.json();
  const d = json?.data || {};
  return { login: Boolean(d.isLogin), uname: d.uname || '', face: d.face || '', vip: Boolean(d.vipStatus) };
}

/* ─────────────────────────── 扫码登录 ─────────────────────────── */
/* 走 passport 的 web 二维码通道：这是官方留给第三方的无验证码登录方式，
   扫码登录是这里唯一能完全自动化的方式；短信登录要过滑块验证，宿主侧做不到。 */

export async function qrGenerate() {
  const res = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
    headers: headers(),
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data?.qrcode_key) throw new Error(json.message || '二维码生成失败');
  return { url: json.data.url, key: json.data.qrcode_key };
}

const QR_STATE = {
  0: 'ok',
  86101: 'waiting',   // 未扫码
  86090: 'scanned',   // 已扫码，待手机确认
  86038: 'expired',   // 二维码失效
};

/**
 * 轮询扫码结果。成功时把 Set-Cookie 拼成请求头，直接可以拿去用。
 * @returns {{ state: 'ok'|'waiting'|'scanned'|'expired'|'unknown', cookie?: string, message?: string }}
 */
export async function qrPoll(key) {
  const res = await fetch(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-site-header`,
    { headers: headers() },
  );
  const json = await res.json();
  const code = json?.data?.code;
  const state = QR_STATE[code] || 'unknown';
  if (state !== 'ok') return { state, message: json?.data?.message || json?.message || '' };

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let cookie = setCookies.map((c) => c.split(';')[0]).join('; ');

  /* 有的版本不带 Set-Cookie，只在 data.url 里回这些字段 */
  if (!cookie && json.data.url) {
    const q = new URL(json.data.url).searchParams;
    const pairs = [];
    for (const name of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
      if (q.get(name)) pairs.push(`${name}=${q.get(name)}`);
    }
    cookie = pairs.join('; ');
  }
  if (!cookie) return { state: 'unknown', message: '登录成功但没拿到 Cookie' };
  return { state: 'ok', cookie };
}

/* ───────────────────────────── WBI 签名 ───────────────────────────── */

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const md5 = (s) => createHash('md5').update(s).digest('hex');

let wbiCache = { at: 0, img: '', sub: '' };

async function wbiKeys() {
  if (wbiCache.img && Date.now() - wbiCache.at < 6 * 3600_000) return wbiCache;
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: headers() });
  const json = await res.json();
  const img = json?.data?.wbi_img;
  if (!img?.img_url || !img?.sub_url) throw new Error('无法获取 WBI 密钥（nav 接口异常）');
  const pick = (u) => u.split('/').pop().split('.')[0];
  wbiCache = { at: Date.now(), img: pick(img.img_url), sub: pick(img.sub_url) };
  return wbiCache;
}

export async function signQuery(params) {
  const keys = await wbiKeys();
  const raw = keys.img + keys.sub;
  const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p).sort().map((k) => {
    const v = String(p[k]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join('&');
  return `${q}&w_rid=${md5(q + mixin)}`;
}

async function apiGet(path, params = {}, { wbi = true } = {}) {
  const q = wbi
    ? await signQuery(params)
    : new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const res = await fetch(`https://api.bilibili.com${path}?${q}`, {
    headers: headers({ Accept: 'application/json' }),
  });
  if (!res.ok) throw new Error(`B 站接口 HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`${json.message || '接口错误'}（code ${json.code}）`);
  return json.data;
}

/* ───────────────────────────── 输入解析 ───────────────────────────── */

const BV_RE = /BV[0-9A-Za-z]{10}/;
const AV_RE = /av(\d{1,20})/i;

export function parseTarget(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('请输入 B 站视频链接或 BV 号');
  const page = Number((text.match(/[?&]p=(\d+)/) || [])[1] || 1) || 1;
  const bv = text.match(BV_RE);
  if (bv) return { bvid: bv[0], page };
  if (/b23\.tv/i.test(text)) throw new Error('b23.tv 短链无法直接解析，请粘贴 www.bilibili.com/video/BV... 完整地址');
  const av = text.match(AV_RE);
  if (av) return { aid: Number(av[1]), page };
  throw new Error('没认出 B 站视频地址（支持视频链接 / BV 号 / av 号）');
}

/** True when the text looks like something this plugin can resolve. */
export function looksLikeBilibili(text) {
  return BV_RE.test(text) || AV_RE.test(text) || /bilibili\.com\/video|b23\.tv/.test(text);
}

/* ─────────────────────── 画质 / 音质映射表 ─────────────────────── */

export const VIDEO_QN = {
  127: '8K 超清', 126: '杜比视界', 125: '真彩 HDR', 120: '4K 超清',
  116: '1080P 60帧', 112: '1080P 高码率', 80: '1080P 高清', 74: '720P 60帧',
  64: '720P 高清', 32: '480P 清晰', 16: '360P 流畅', 6: '240P 极速',
};
const VIP_QN = new Set([127, 126, 125, 120, 116, 112, 74]);

export const AUDIO_ID = {
  30280: { label: '192K', kbps: 192 },
  30250: { label: '杜比全景声', kbps: 448, vip: true },
  30251: { label: 'Hi-Res 无损', kbps: 1400, vip: true },
  30232: { label: '132K', kbps: 132 },
  30216: { label: '64K', kbps: 64 },
};

const CODEC_LABEL = { 7: 'AVC', 12: 'HEVC', 13: 'AV1' };

/* ─────────────────────── 元数据 + 流清单 ─────────────────────── */

export async function probe(input) {
  const target = parseTarget(input);
  const view = await apiGet('/x/web-interface/view',
    target.bvid ? { bvid: target.bvid } : { aid: target.aid }, { wbi: false });

  const page = Math.min(Math.max(target.page, 1), view.pages?.length || 1);
  const pageInfo = view.pages?.[page - 1];
  const cid = pageInfo?.cid ?? view.cid;
  const bvid = view.bvid;

  const play = await apiGet('/x/player/wbi/playurl', {
    bvid, cid, qn: 127, fnver: 0, fnval: 4048, fourk: 1, platform: 'pc',
  });

  /* one row per quality — prefer AVC, fall back to HEVC/AV1 */
  const byQn = new Map();
  for (const v of play?.dash?.video || []) {
    const pref = v.codecid === 7 ? 0 : v.codecid === 12 ? 1 : 2;
    const cur = byQn.get(v.id);
    if (!cur || pref < cur._pref) {
      byQn.set(v.id, {
        qn: v.id,
        label: VIDEO_QN[v.id] || `${v.height}P`,
        vip: VIP_QN.has(v.id),
        height: v.height,
        codec: CODEC_LABEL[v.codecid] || `codec${v.codecid}`,
        bandwidth: v.bandwidth,
        url: v.baseUrl,
        backups: v.backupUrl || [],
        _pref: pref,
      });
    }
  }
  const videos = [...byQn.values()].sort((a, b) => b.qn - a.qn).map(({ _pref, ...v }) => v);

  const audios = (play?.dash?.audio || []).map((a) => ({
    id: a.id,
    label: AUDIO_ID[a.id]?.label || String(a.id),
    kbps: AUDIO_ID[a.id]?.kbps || Math.round(a.bandwidth / 1000),
    vip: Boolean(AUDIO_ID[a.id]?.vip),
    url: a.baseUrl,
    backups: a.backupUrl || [],
  })).sort((a, b) => b.kbps - a.kbps);

  return {
    bvid, aid: view.aid, cid,
    title: view.title,
    partTitle: view.pages?.length > 1 ? (pageInfo?.part || `P${page}`) : '',
    page, pageCount: view.pages?.length || 1,
    duration: pageInfo?.duration ?? view.duration,
    cover: view.pic,
    up: { mid: view.owner?.mid, name: view.owner?.name, face: view.owner?.face },
    videos, audios,
    /* B 站 CDN 支持按比例取图：同一张原图可出 16:9 / 4:3 两种裁切 */
    covers: buildCovers(view.pic),
    maxQn: videos[0]?.qn ?? play?.quality ?? 0,
    hasDurl: Array.isArray(play?.durl) && play.durl.length > 0,
  };
}

/* ───────────────────────────── 下载原语 ───────────────────────────── */

/** CDN 直链鉴权靠 Referer +（登录后）Cookie。 */
const streamHeaders = () => headers({ Origin: ORIGIN });

async function streamToFile(urls, filePath, onProgress, signal) {
  let lastErr;
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await fetch(url, { headers: streamHeaders(), signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('响应没有 body');
      const total = Number(res.headers.get('content-length')) || 0;
      const out = createWriteStream(filePath);
      let received = 0;
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress?.(received, total);
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (total && received !== total) throw new Error(`下载不完整 ${received}/${total}`);
      return received;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error(`所有 CDN 都失败了：${lastErr?.message || 'unknown'}`);
}

async function fetchToFile(url, filePath, signal) {
  const res = await fetch(url, { headers: streamHeaders(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(filePath, Buffer.from(await res.arrayBuffer()));
  return filePath;
}

/* 只代理我们自己解析出来的图片地址（B 站 CDN + 各站点缩略图），
   不做开放代理，避免变成 SSRF 跳板。 */
const imageAllow = new Set();

export function registerImage(url) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) imageAllow.add(url);
}

/** Proxy a video thumbnail through the Host so the page can show it without hotlink blocks. */
export async function fetchImage(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('图片地址无效'); }
  const trusted = imageAllow.has(url)
    || /(^|\.)(hdslb\.com|bilibili\.com)$/i.test(parsed.hostname);
  if (!trusted) throw new Error('该图片地址不在允许列表里');
  return fetchBytes(url);
}

/* ───────────────────────────── ffmpeg ───────────────────────────── */

let ffmpegResolved; // undefined = not probed, null = missing

function canRun(exe) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(exe, ['-hide_banner', '-version'], { windowsHide: true, stdio: 'ignore' }); }
    catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

export async function findFfmpeg(hint) {
  if (ffmpegResolved !== undefined && !hint) return ffmpegResolved;
  /* 顺序：显式配置 > PATH > 常见安装位置。
     旧版 ffmpeg（4.x）解不了部分 webm/opus，所以 PATH 优先。 */
  const candidates = [
    hint,
    process.env.FFMPEG_PATH,
    'ffmpeg',                                              // PATH 里的（优先）
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    join(homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (!(await canRun(c))) continue;
    ffmpegResolved = await absolutize(c);
    return ffmpegResolved;
  }
  ffmpegResolved = null;
  return null;
}

/** 裸命令名（'ffmpeg'）要还原成绝对路径，否则 dirname() 会得到 '.'。 */
function absolutize(cmd) {
  if (cmd.includes('\\') || cmd.includes('/')) return Promise.resolve(cmd);
  return new Promise((resolve) => {
    execFile('where', [cmd], { windowsHide: true }, (err, stdout) => {
      const first = !err && stdout ? stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] : '';
      resolve(first || cmd);
    });
  });
}

function runFfmpeg(exe, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, signal });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-8000); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg 失败(${code})：${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}`)));
  });
}


/** 跨卷时 rename 会抛 EXDEV（临时目录在 C:、输出目录可能在 G:），退化成拷贝再删。 */
async function moveFile(from, to) {
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
/* ───────────────────────────── 文件名 ───────────────────────────── */

const RESERVED = /[\\/:*?"<>|\x00-\x1f]/g;

export function safeName(name, max = 90) {
  return String(name || 'bilibili').replace(RESERVED, '_').replace(/[. ]+$/, '').trim().slice(0, max) || 'bilibili';
}

/* ───────────────────────────── 任务表 ───────────────────────────── */

const jobs = new Map();
export const getJob = (id) => jobs.get(id);
export const listJobs = () => [...jobs.values()].map(publicJob);

export function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    dir: job.dir,
    items: job.items.map((i) => ({
      kind: i.kind, label: i.label, status: i.status, file: i.file, error: i.error,
      parts: i.parts.map((p) => ({ name: p.name, received: p.received, total: p.total })),
    })),
  };
}

export function createJob(title, dir, controller) {
  const job = {
    id: randomUUID().slice(0, 8), title, dir, controller,
    status: 'running', error: null,
    startedAt: Date.now(), endedAt: null, items: [],
  };
  jobs.set(job.id, job);
  if (jobs.size > 50) {
    for (const [id, j] of jobs) if (j.status !== 'running' && jobs.size > 50) jobs.delete(id);
  }
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (job?.status === 'running') { job.controller.abort(); return true; }
  return false;
}

/* ───────────────────────────── 主下载流程 ───────────────────────────── */

/**
 * Download the artifacts the user picked from the picker.
 *
 * @param {object} req
 * @param {string} req.url               视频地址 / BV 号
 * @param {string} req.outDir            输出目录
 * @param {string} [req.ffmpeg]          ffmpeg 路径提示
 * @param {object} req.pick              { videoQn?, audio?, audioId?, audioMp3?, cover?, avatar? }
 * @param {object} [info]                已经 probe 过的元数据，省一次请求
 */
export async function startDownload(req, { info: known, onUpdate } = {}) {
  const info = known || await probe(req.url);
  const controller = new AbortController();
  const signal = controller.signal;
  const job = createJob(info.title, req.outDir, controller);
  const notify = () => onUpdate?.(publicJob(job));

  const addItem = (kind, label) => {
    const item = { kind, label, status: 'working', file: null, error: null, parts: [] };
    job.items.push(item); notify(); return item;
  };
  const track = (item, name) => {
    const part = { name, received: 0, total: 0 };
    item.parts.push(part); notify();
    return (received, total) => {
      part.received = received;
      if (total) part.total = total;
      notify();
    };
  };

  const finish = (status, error) => {
    job.status = status;
    job.error = error || null;
    job.endedAt = Date.now();
    notify();
  };

  /* run in the background: the caller gets the job handle immediately */
  (async () => {
    try {
      await mkdir(req.outDir, { recursive: true });
      const ffmpeg = await findFfmpeg(req.ffmpeg);
      const part = info.pageCount > 1 ? ` P${info.page}` : '';
      const base = `${safeName(info.title)}${part}`;
      const tag = `[${info.bvid}${info.pageCount > 1 ? `_P${info.page}` : ''}]`;
      const pick = req.pick || {};

      /* ── 视频 ───────────────────────────────────────────────── */
      if (pick.videoQn) {
        const want = info.videos.find((v) => v.qn === Number(pick.videoQn));
        if (!want) throw new Error(`该视频没有「${VIDEO_QN[pick.videoQn] || pick.videoQn}」画质`);
        /* 音轨恒合流；pick.audio 表示「另外再存一份音频文件」 */
        const audio = pickAudio(info.audios, pick.audioId);
        const extraAudio = Boolean(pick.audio) && Boolean(audio);
        const item = addItem('video', `视频 ${want.label} · ${want.codec}${audio ? ` ＋ 音频 ${audio.label}` : ''}`);
        const tmpV = join(tmpdir(), `bili-${job.id}-v.m4s`);
        const tmpA = join(tmpdir(), `bili-${job.id}-a.m4s`);

        const estimate = Math.round((want.bandwidth * info.duration) / 8);
        const onV = track(item, 'video');
        await streamToFile([want.url, ...want.backups], tmpV,
          (r, t) => onV(r, t || estimate), signal);

        if (!audio) {
          const target = join(req.outDir, `${base}${tag}.mp4`);
          await moveFile(tmpV, target);
          item.file = target; item.status = 'done';
        } else if (ffmpeg) {
          const onA = track(item, 'audio');
          const aEstimate = Math.round((audio.kbps * 1000 * info.duration) / 8);
          await streamToFile([audio.url, ...audio.backups], tmpA,
            (r, t) => onA(r, t || aEstimate), signal);
          const target = join(req.outDir, `${base}${tag}.mp4`);
          item.status = 'muxing'; notify();
          await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', tmpV, '-i', tmpA,
            '-c', 'copy', '-movflags', '+faststart', target], signal);
          await rm(tmpV, { force: true });
          item.file = target; item.status = 'done';
          if (extraAudio) {
            /* 勾了「下载为额外音频文件」：把已经下好的音轨另存一份 */
            const aOut = join(req.outDir, `${base}${tag}.m4a`);
            await moveFile(tmpA, aOut);
            job.items.push({
              kind: 'audio', label: `额外音频 ${audio.label}`, status: 'done',
              file: aOut, error: null, parts: [],
            });
          } else {
            await rm(tmpA, { force: true });
          }
        } else {
          /* no ffmpeg: keep both tracks rather than a silent video */
          const vFile = join(req.outDir, `${base}${tag}.video.mp4`);
          const aFile = join(req.outDir, `${base}${tag}.audio.m4a`);
          const onA = track(item, 'audio');
          await streamToFile([audio.url, ...audio.backups], tmpA, (r, t) => onA(r, t), signal);
          await moveFile(tmpV, vFile);
          await moveFile(tmpA, aFile);
          item.file = `${vFile} + ${aFile}`; item.status = 'done';
          item.note = '未找到 ffmpeg，视频与音频分开保存';
        }
        for (const p of item.parts) if (!p.total) p.total = p.received;
        notify();
      }

      /* ── 封面 ───────────────────────────────────────────────── */
      const wantedCovers = (info.covers || []).filter((c) =>
        pick.coverIds ? pick.coverIds.includes(c.id) : pick.cover);
      for (const c of wantedCovers) {
        const item = addItem('cover', `封面 · ${c.label}`);
        item.parts.push({ name: 'image', received: 0, total: 0 });
        try {
          const img = await fetchBytes(c.url);
          const file = join(req.outDir, `${base}${tag}_封面_${safeName(c.label, 12)}${imageExtFrom(img.body)}`);
          await writeFile(file, img.body);
          item.file = file; item.status = 'done';
        } catch (err) {
          item.status = 'error'; item.error = err.message;
        }
        notify();
      }

      /* ── UP 头像 ─────────────────────────────────────────────── */
      if (pick.avatar) {
        const item = addItem('avatar', `作者头像 · ${info.up.name}`);
        item.parts.push({ name: 'image', received: 0, total: 0 });
        const img = await fetchBytes(info.up.face);
        const file = join(req.outDir, `${safeName(info.up.name, 40)}_头像${imageExtFrom(img.body)}`);
        await writeFile(file, img.body);
        item.file = file; item.status = 'done'; notify();
      }

      /* ── 纯音频 ─────────────────────────────────────────────── */
      if (pick.audio && !pick.videoQn) {
        const audio = pickAudio(info.audios, pick.audioId);
        if (!audio) throw new Error('这个视频没有可下载的音频流');
        const wantMp3 = Boolean(pick.audioMp3) && Boolean(ffmpeg);
        const item = addItem('audio', `音频 ${audio.label} · ${wantMp3 ? 'MP3' : 'M4A'}`);
        const tmpA = join(tmpdir(), `bili-${job.id}-a.m4s`);
        const onA = track(item, 'audio');
        const estimate = Math.round((audio.kbps * 1000 * info.duration) / 8);
        await streamToFile([audio.url, ...audio.backups], tmpA, (r, t) => onA(r, t || estimate), signal);
        const file = join(req.outDir, `${base}${tag}.${wantMp3 ? 'mp3' : 'm4a'}`);
        if (wantMp3) {
          item.status = 'muxing'; notify();
          await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', tmpA,
            '-vn', '-c:a', 'libmp3lame', '-q:a', '0', '-f', 'mp3', file], signal);
          await rm(tmpA, { force: true });
        } else {
          await moveFile(tmpA, file);
        }
        for (const p of item.parts) if (!p.total) p.total = p.received;
        item.file = file; item.status = 'done'; notify();
      }

      if (!job.items.length) throw new Error('没有勾选任何项目');
      finish('done');
    } catch (err) {
      for (const item of job.items) {
        if (item.status === 'working' || item.status === 'muxing') {
          item.status = 'error';
          item.error = signal.aborted ? '已取消' : err.message;
        }
      }
      finish(signal.aborted ? 'canceled' : 'error', signal.aborted ? '已取消' : err.message);
    }
  })();

  return publicJob(job);
}

function pickAudio(audios, id) {
  if (!audios?.length) return null;
  if (id) return audios.find((a) => a.id === Number(id)) || audios[0];
  return audios[0];
}
