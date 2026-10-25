/**
 * dsh-media — 多平台媒体下载插件的宿主半边。
 *
 * 一份操作、两个调用方：
 *   · Agent 工具  bilibili_video / bilibili_download
 *   · 界面        POST /bili-dl/probe、/bili-dl/download …（客户端同源 fetch）
 * 两者都落到 lib/bili.mjs 里的同一个 probe / startDownload。
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync as writeFileSyncSync, existsSync as existsSyncSync, statSync as statSyncSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import {
  probe, startDownload, getJob, listJobs, cancelJob, fetchImage,
  findFfmpeg, looksLikeBilibili, parseTarget, expandBiliShort, VIDEO_QN, AUDIO_ID,
  setCookie, loginStatus, hasCookie, qrGenerate, qrPoll, registerImage,
  setProxy, getProxy,
} from './lib/bili.mjs';
import { ytProbe, ytStartDownload, resolveYtDlp, setCookieOpts, getCookieOpts } from './lib/ytdlp.mjs';
import {
  startLoginSession, finishLoginSession, getLoginSession, cancelLoginSession, PLATFORMS,
  detectLogins, readNames,
} from './lib/browser-login.mjs';
import { encodeQrSvg } from './lib/qr.mjs';
import { looksLikeDouyin, douyinProbe, startDouyinDownload } from './lib/douyin.mjs';
import { looksLikeXhs, xhsProbe, startXhsDownload } from './lib/xhs.mjs';

/** 版本号的唯一事实来源：package.json */
/** 版本号每次请求现读：避免模块缓存导致升级后仍显示旧版本 */
function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const name = 'dsh-media';
export const inject = ['tools'];

const STATE_FILE = join(homedir(), '.dsh', 'bili-dl', 'state.json');
const COOKIE_FILE = join(homedir(), '.dsh', 'bili-dl', 'cookies.txt');
const DEFAULT_OUT = join(homedir(), 'Downloads', 'Bilibili');

/** 把 cookies.txt 原文或 "a=1; b=2" 的 Cookie 头规整成 Netscape 格式。 */
function toNetscape(raw, domain) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('内容为空');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  /* 已经是 Netscape：任一有效行有 7 个 tab 分隔字段 */
  if (lines.some((l) => !l.startsWith('#') && l.split('\t').length >= 7)) {
    const body = lines.filter((l) => !l.startsWith('#'));
    return `# Netscape HTTP Cookie File\n# written by dsh media downloader\n${body.join('\n')}\n`;
  }

  /* 浏览器 F12 抄出来的原始 Cookie 串，需要域名 */
  const host = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host) throw new Error('这是原始 Cookie 串，需要填一个域名（如 youtube.com）；或改用 cookies.txt');
  const expires = Math.floor(Date.now() / 1000) + 180 * 24 * 3600;
  const rows = [];
  for (const pair of text.split(';').map((s) => s.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!name || /[\t\n]/.test(name + value)) continue;
    rows.push([`.${host}`, 'TRUE', '/', 'TRUE', String(expires), name, value].join('\t'));
  }
  if (!rows.length) throw new Error('没解析出任何 cookie');
  return `# Netscape HTTP Cookie File\n# written by dsh media downloader\n${rows.join('\n')}\n`;
}

/* ─────────────────────────── 代理自动探测 ─────────────────────────── */
/* 用户的「规则代理」通常只开系统代理、不设环境变量、也不做 TUN。
   yt-dlp 会自己读注册表，但 Node 的 fetch 不会，所以这里探一次统一喂给两边。 */

let detectedProxy; // undefined = 还没探过

function detectSystemProxy() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve('');
        if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) return resolve('');
        const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout);
        if (!m) return resolve('');
        const value = m[1].trim();
        if (!value || value.includes('://') && /;/.test(value)) return resolve('');
        // 形如 "127.0.0.1:7897" 或 "http=127.0.0.1:7897;https=..."，后者取 http 那一项
        const single = value.includes('=')
          ? (/(?:http|https)=([^;\s]+)/i.exec(value) || [])[1]
          : value;
        if (!single) return resolve('');
        resolve(/^https?:\/\//i.test(single) ? single : `http://${single}`);
      });
  });
}

async function applyProxy(override) {
  if (detectedProxy === undefined) detectedProxy = await detectSystemProxy();
  const effective = (override !== undefined ? override : state.proxy) || detectedProxy || '';
  setProxy(effective);
  return effective;
}

/* ───────────────────────────── 持久状态 ───────────────────────────── */

let state = {
  outDir: DEFAULT_OUT, ffmpeg: '', cookie: '', proxy: '',
  cookiesBrowser: '', cookiesFile: '',
  copyToast: true,   /* 复制链接时是否在屏幕角落提示 */
};
let loaded = false;

async function loadState() {
  if (loaded) return state;
  loaded = true;
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state = { ...state, ...raw };
  } catch { /* first run */ }
  if (state.cookie) setCookie(state.cookie);
  setCookieOpts({ browser: state.cookiesBrowser, file: state.cookiesFile });
  await applyProxy();
  return state;
}

async function saveState(patch) {
  await loadState();
  state = { ...state, ...patch };
  if ('proxy' in patch) { detectedProxy = detectedProxy ?? null; await applyProxy(patch.proxy); }
  if ('cookiesBrowser' in patch || 'cookiesFile' in patch) {
    setCookieOpts({ browser: state.cookiesBrowser, file: state.cookiesFile });
  }
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/* ─────────────────────────── 待办选择器（Agent → 界面） ─────────────────────────── */
/* 工具解析完视频后在这里留一个“待选”票据，界面轮询到就自动弹选择器。 */
/* ── 屏幕角落提示窗（PowerShell + WPF，贴右下角、置顶、不占任务栏）── */
let toastProc = null;
function themeArgs() {
  const t = uiTheme;
  if (!t) return '';
  try {
    const file = join(tmpdir(), 'dsh-corner-theme.json');
    writeFileSyncSync(file, JSON.stringify(t), 'utf8');
    return ' -ThemeFile ""' + file + '""';
  } catch {
    return '';
  }
}

function showCornerToast(url, hostHeader) {
  try {
    if (safeModeOn()) return false;
    if (toastProc) { try { toastProc.kill(); } catch {} toastProc = null; }
    const dir = dirname(fileURLToPath(import.meta.url));
    const script = join(dir, 'assets', 'corner-toast.ps1');
    const base = String(hostHeader || '127.0.0.1:3000').replace(/^https?:\/\//, '').replace(/'/g, '');
    const safeUrl = String(url).replace(/"/g, '""');
    /* 用 wscript 起一个无控制台的 PowerShell：直接 spawn powershell 会带出控制台窗口，
       而 -WindowStyle Hidden 又会把 WPF 窗口一起隐藏 */
    const vbs = join(tmpdir(), 'dsh-corner-toast.vbs');
    const content = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File ""${script}"" -Url ""${safeUrl}"" -Base ""${base}""${themeArgs()}", 0, False`,
    ].join('\r\n');
    writeFileSyncSync(vbs, content, 'utf8');
    toastProc = spawn('wscript.exe', ['//B', '//nologo', vbs], { windowsHide: true, stdio: 'ignore', detached: true });
    toastProc.on('exit', () => { toastProc = null; });
    toastProc.unref();
    return true;
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}


/* ── 系统剪贴板监听（复制到受支持链接 → 弹角落窗）── */
let uiTheme = null;

/* 安全模式：不 spawn 任何外部进程（排障用，建 %TEMP%\dsh-media-safe-mode 即可） */
function safeModeOn() {
  try { return existsSyncSync(join(tmpdir(), 'dsh-media-safe-mode')); } catch { return true; }
}
let clipWatchProc = null;
let lastWatchSpawn = 0;
let lastNotified = { url: '', at: 0 };

/* 常驻监听器是独立进程，靠这个文件知道开关状态：'1' 允许弹窗，'0' 不弹 */
function syncToastFlag(on) {
  try { writeFileSyncSync(join(tmpdir(), 'dsh-toast-enabled.txt'), on ? '1' : '0', 'utf8'); } catch {}
}

function notifyOnce(url) {
  const now = Date.now();
  if (lastNotified.url === url && now - lastNotified.at < 4000) return false;
  lastNotified = { url, at: now };
  return true;
}

function ensureClipboardWatcher(hostHeader) {
  try {
    if (safeModeOn()) return false;
    /* 总开关：%TEMP%\dsh-media-no-watcher 存在时不启动（排障用） */
    if (existsSyncSync(join(tmpdir(), 'dsh-media-no-watcher'))) return false;
    if (clipWatchProc) return true;

    /* 心跳文件：监听器每轮都会刷新它；心跳新鲜就不再起新的，绝不杀任何进程 */
    const hb = join(tmpdir(), 'dsh-corner-watch.hb');
    try {
      const age = Date.now() - statSyncSync(hb).mtimeMs;
      if (age < 15000) return true;
    } catch { /* 没有心跳文件就走启动流程 */ }

    const now = Date.now();
    if (now - lastWatchSpawn < 30000) return false;   /* 至少间隔 30 秒，避免堆进程 */
    lastWatchSpawn = now;

    const dir = dirname(fileURLToPath(import.meta.url));
    const script = join(dir, 'assets', 'corner-watch.ps1');
    const base = String(hostHeader || '127.0.0.1:3000').replace(/^https?:\/\//, '').replace(/'/g, '');
    const vbs = join(tmpdir(), 'dsh-corner-watch.vbs');
    const content = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File ""${script}"" -Base ""${base}""", 0, False`,
    ].join('\r\n');
    writeFileSyncSync(vbs, content, 'utf8');
    clipWatchProc = spawn('wscript.exe', ['//B', '//nologo', vbs], { windowsHide: true, stdio: 'ignore', detached: true });
    clipWatchProc.on('error', () => { clipWatchProc = null; });
    clipWatchProc.on('exit', () => { clipWatchProc = null; });
    clipWatchProc.unref();
    return true;
  } catch {
    return false;
  }
}

let pending = null;

/* 登录态 60 秒缓存，省掉面板每次打开的 nav 请求。 */
let loginCache = null;

async function cachedLogin() {
  if (!hasCookie()) return { login: false };
  if (loginCache && Date.now() - loginCache.at < 60_000) return loginCache.value;
  try {
    const value = await loginStatus();
    loginCache = { at: Date.now(), value };
    return value;
  } catch {
    return { login: false, error: '登录态检查失败' };
  }
}

/* ───────────────────────────── 文本格式化 ───────────────────────────── */

function formatInfo(info) {
  const isYt = info.source === 'ytdlp';
  const lines = [
    `《${info.title}》${info.partTitle ? ` · ${info.partTitle}` : ''}`,
    `${isYt ? '频道' : 'UP'}：${info.up.name}　时长：${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')}　${info.pageCount > 1 ? `共 ${info.pageCount} P，当前 P${info.page}` : (isYt ? info.extractor : info.bvid)}`,
    '',
    '可用画质：',
    ...(info.videos.length
      ? info.videos.map((v) => `  · ${isYt ? `height=${v.qn}` : `qn=${v.qn}`} ${v.label}${v.vip ? '（大会员）' : ''} · ${v.codec}`)
      : ['  · （没有可选的视频流）']),
    '可用音轨：',
    ...(info.audios.length
      ? info.audios.map((a) => `  · ${isYt ? '#' + a.id : 'id=' + a.id} ${a.label}${a.vip ? '（大会员）' : ''}`)
      : ['  · （跟随最佳音轨）']),
    '',
    `封面：${info.cover || '（无）'}`,
  ];
  if (!isYt && info.up?.face) lines.push(`作者头像：${info.up.face}`);
  return lines.join('\n');
}

function formatPickResult(info) {
  return [
    formatInfo(info),
    '',
    '选择器已在界面弹出：可以勾选 音频 / 视频画质 / 封面 / 作者头像 后下载。',
    '也可以直接调用 bilibili_download 指定要什么。',
  ].join('\n');
}

function formatJob(job) {
  const bar = (p) => {
    const total = p.total || 0;
    return total ? `${Math.round((p.received / total) * 100)}%` : '…';
  };
  const lines = [`任务 ${job.id}　${job.status === 'done' ? '已完成' : job.status === 'running' ? '进行中' : job.status === 'canceled' ? '已取消' : '失败'}`];
  for (const item of job.items) {
    const state = { done: '✓', working: '↓', muxing: '⚙', error: '✗' }[item.status] || '·';
    const pct = item.parts.filter((p) => p.total).map(bar).join(' / ');
    lines.push(`  ${state} ${item.label}${pct ? `　${pct}` : ''}`);
    if (item.file) lines.push(`      → ${item.file}`);
    if (item.error) lines.push(`      ✗ ${item.error}`);
  }
  if (job.error) lines.push(`错误：${job.error}`);
  if (job.dir) lines.push(`目录：${job.dir}`);
  return lines.join('\n');
}

/* ─────────────────────── 统一入口：B 站 或 yt-dlp ─────────────────────── */

/** B 站走自己的高清链路（可登录、画质精确），其它站点交给 yt-dlp。 */
async function probeUniversal(url) {
  const text = String(url || '').trim();
  if (!text) throw new Error('请输入视频链接');
  if (looksLikeBilibili(text)) {
    /* b23.tv 短链先跟跳到完整地址，否则 parseTarget 认不出 BV 号 */
    const target = await expandBiliShort(text);
    const info = { ...await probe(target), source: 'bilibili' };
    registerImage(info.cover);
    registerImage(info.up?.face);
    (info.covers || []).forEach((c) => registerImage(c.url));
    return info;
  }
  /* 小红书：元数据只能从真浏览器读（Node 请求一律 302），图片 CDN 可直连 */
  if (looksLikeXhs(text)) {
    const info = await xhsProbe(text);
    registerImage(info.cover);
    (info.covers || []).forEach((c) => registerImage(c.url));
    (info.images || []).forEach((c) => registerImage(c.url));
    registerImage(info.up?.face);
    return info;
  }

  /* 抖音走原生 SSR 解析：yt-dlp 那条路要 msToken，实测过不去 */
  if (looksLikeDouyin(text)) {
    const info = await douyinProbe(text);
    registerImage(info.cover);
    registerImage(info.up?.face);
    (info.covers || []).forEach((x) => registerImage(x.url));
    (info.images || []).forEach((x) => registerImage(x.url));
    return info;
  }
  return ytProbe(text);
}

async function dispatchDownload(url, info, req) {
  if (info.source === 'ytdlp') return ytStartDownload({ ...req, url }, { info });
  if (info.source === 'douyin') return startDouyinDownload({ ...req, url }, { info });
  if (info.source === 'xhs') return startXhsDownload({ ...req, url }, { info });
  return startDownload({ ...req, url }, { info });
}

/** 把 "1080" / "best" / "2160" 换算成 info 里最接近的一档。 */
function chooseVideo(info, quality) {
  const list = info.videos || [];
  if (!list.length) return null;
  if (!quality || quality === 'best') return list[0];
  const want = Number(String(quality).replace(/\D/g, ''));
  if (!want) return list[0];
  return list.find((v) => (v.height || 0) <= want) || list[list.length - 1];
}

/* ───────────────────────────── HTTP 通道 ───────────────────────────── */

const MAX_BODY = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function handleHttp(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname.replace(/^\/bili-dl/, '') || '/';
  const method = req.method || 'GET';

  try {
    if (route === '/ping') {
      /* 监听器跨应用重启存活，靠这个文件拿到当前端口 */
      try { writeFileSyncSync(join(tmpdir(), 'dsh-media-host.txt'), String(req.headers.host || ''), 'utf8'); } catch {}
      ensureClipboardWatcher(req.headers.host);
      await loadState();
      syncToastFlag(state.copyToast !== false);
      const ffmpeg = await findFfmpeg(state.ffmpeg);
      const ytdlp = await resolveYtDlp().catch(() => null);
      const login = await cachedLogin();
      /* B 站的登录态存在 state.cookie 里，不在 cookies.txt，单独并进去 */
      const logins = { ...(await detectLogins()), bilibili: Boolean(login?.login) };
      return sendJson(res, 200, {
        ok: true, version: readPkgVersion(), outDir: state.outDir, ffmpeg, ytdlp, proxy: getProxy(), proxyDetected: detectedProxy || '',
        copyToast: state.copyToast !== false,
        cookies: getCookieOpts(), logins, names: await readNames(),
        hasCookie: hasCookie(), login,
        pending: pending && Date.now() - pending.at < 120000 ? pending : null,
      });
    }

    if (route === '/login' && method === 'POST') {
      const body = await readBody(req);
      const raw = String(body.cookie || '').trim();
      if (!raw) return sendJson(res, 400, { ok: false, error: '请输入 SESSDATA 或整条 Cookie' });
      /* 只认 SESSDATA 这一个字段也够用 */
      const cookie = /sessdata=/i.test(raw) ? raw : `SESSDATA=${raw.replace(/^SESSDATA=/i, '')}`;
      setCookie(cookie);
      const login = await loginStatus();
      if (!login.login) { setCookie(state.cookie || ''); return sendJson(res, 200, { ok: false, error: 'Cookie 无效或已过期，仍是未登录状态' }); }
      await saveState({ cookie });
      loginCache = { at: Date.now(), value: login };
      return sendJson(res, 200, { ok: true, login });
    }

    if (route === '/logout' && method === 'POST') {
      setCookie('');
      loginCache = null;
      await saveState({ cookie: '' });
      return sendJson(res, 200, { ok: true });
    }

    /* 从本机浏览器取登录态（yt-dlp 自己解密 DPAPI，比手抄 cookie 靠谱） */
    if (route === '/login/browser' && method === 'POST') {
      const body = await readBody(req);
      const browser = String(body.browser || '').trim().toLowerCase();
      const allowed = new Set(['chrome', 'edge', 'firefox', 'brave', 'chromium', 'opera', 'vivaldi', 'safari']);
      if (!allowed.has(browser)) return sendJson(res, 400, { ok: false, error: '不支持的浏览器' });
      await saveState({ cookiesBrowser: browser, cookiesFile: '' });
      return sendJson(res, 200, { ok: true, cookies: getCookieOpts() });
    }

    /* 粘贴 cookies.txt 或原始 Cookie 串 */
    if (route === '/login/cookies' && method === 'POST') {
      const body = await readBody(req);
      const text = toNetscape(body.text, body.domain);
      await mkdir(dirname(COOKIE_FILE), { recursive: true });
      await writeFile(COOKIE_FILE, text, 'utf8');
      await saveState({ cookiesFile: COOKIE_FILE, cookiesBrowser: '' });
      return sendJson(res, 200, {
        ok: true,
        cookies: getCookieOpts(), logins: await detectLogins(),
        lines: text.split('\n').filter((l) => l && !l.startsWith('#')).length,
      });
    }

    if (route === '/login/clear' && method === 'POST') {
      await saveState({ cookiesBrowser: '', cookiesFile: '' });
      await rm(COOKIE_FILE, { force: true }).catch(() => {});
      return sendJson(res, 200, { ok: true, cookies: getCookieOpts() });
    }

    /* 登录窗口：独立 profile 打开平台登录页，登录完自动抓 cookie */
    if (route === '/login/session' && method === 'POST') {
      const body = await readBody(req);
      await loadState();
      const s = await startLoginSession(body.platform, (snap) => {
        if (snap.state === 'ok') {
          saveState({ cookiesFile: COOKIE_FILE, cookiesBrowser: '' }).catch(() => {});
        }
      });
      return sendJson(res, 200, { ok: true, session: s });
    }

    if (route === '/login/session' && method === 'GET') {
      return sendJson(res, 200, { ok: true, session: getLoginSession(), platforms: PLATFORMS });
    }

    if (route === '/login/session/finish' && method === 'POST') {
      const s = await finishLoginSession();
      await saveState({ cookiesFile: COOKIE_FILE, cookiesBrowser: '' });
      return sendJson(res, 200, { ok: true, session: s, cookies: getCookieOpts() });
    }

    if (route === '/login/session/cancel' && method === 'POST') {
      cancelLoginSession();
      return sendJson(res, 200, { ok: true, session: getLoginSession() });
    }
    /* 扫码登录：出二维码 */
    if (route === '/qr/start' && method === 'POST') {
      const { url, key } = await qrGenerate();
      const svg = encodeQrSvg(url, { scale: 4, margin: 4, dark: '#111', light: '#fff' });
      return sendJson(res, 200, { ok: true, key, svg, url });
    }

    /* 扫码登录：轮询状态，成功即落盘 */
    if (route === '/qr/poll' && method === 'POST') {
      const body = await readBody(req);
      if (!body.key) return sendJson(res, 400, { ok: false, error: '缺少 key' });
      const result = await qrPoll(body.key);
      if (result.state !== 'ok') return sendJson(res, 200, { ok: true, ...result });

      setCookie(result.cookie);
      const login = await loginStatus();
      if (!login.login) {
        setCookie(state.cookie || '');
        return sendJson(res, 200, { ok: true, state: 'unknown', message: '扫码已完成但 Cookie 无效，请重试' });
      }
      await saveState({ cookie: result.cookie });
      loginCache = { at: Date.now(), value: login };
      return sendJson(res, 200, { ok: true, state: 'ok', login });
    }

    if (route === '/theme' && method === 'GET') {
      return sendJson(res, 200, { ok: true, theme: uiTheme });
    }

    if (route === '/theme' && method === 'POST') {
      const body = await readBody(req);
      uiTheme = {
        accent: String(body.accent || ''),
        bg: String(body.bg || ''),
        fg: String(body.fg || ''),
        sub: String(body.sub || ''),
        border: String(body.border || ''),
        font: String(body.font || ''),
        debug: body.debug || null,
      };
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/notify' && method === 'POST') {
      const body = await readBody(req);
      const target = String(body.url || '');
      if (state.copyToast === false) return sendJson(res, 200, { ok: true, shown: false, disabled: true });
      if (!notifyOnce(target)) return sendJson(res, 200, { ok: true, shown: false, dedup: true });
      /* 常驻监听器活着时由它自己弹窗（250ms 内），这里不再另起进程免重复 */
      try {
        const age = Date.now() - statSyncSync(join(tmpdir(), 'dsh-corner-watch.hb')).mtimeMs;
        if (age < 15000) return sendJson(res, 200, { ok: true, shown: true, via: 'watcher' });
      } catch { }
      const r = showCornerToast(target, req.headers.host);
      return sendJson(res, 200, { ok: true, shown: r === true, error: r && r.error ? r.error : null });
    }

    if (route === '/toast/open' && method === 'POST') {
      const body = await readBody(req);
      const url = String(body.url || '').trim();
      try {
        await loadState();
        const info = await probeUniversal(url);
        pending = { url, at: Date.now(), info };
      } catch { pending = null; }
      return sendJson(res, 200, { ok: true, ready: Boolean(pending) });
    }

    if (route === '/pending') {
      const fresh = pending && Date.now() - pending.at < 120000 ? pending : null;
      return sendJson(res, 200, { ok: true, pending: fresh });
    }

    if (route === '/pending/clear' && method === 'POST') {
      pending = null;
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/probe' && method === 'POST') {
      const body = await readBody(req);
      await loadState();
      const info = await probeUniversal(body.url);
      if (body.open !== false) pending = { url: body.url, info, at: Date.now() };
      return sendJson(res, 200, { ok: true, info });
    }

    if (route === '/download' && method === 'POST') {
      const body = await readBody(req);
      await loadState();
      const info = body.info || await probeUniversal(body.url);
      const job = await dispatchDownload(body.url, info, {
        /* 目录以宿主保存的为准：客户端状态可能没同步，跟着它走会下错地方 */
        outDir: state.outDir || body.outDir,
        pick: body.pick || {},
        ffmpeg: state.ffmpeg,
      });
      pending = null;
      return sendJson(res, 200, { ok: true, job });
    }

    if (route === '/job') {
      const job = getJob(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在' });
      return sendJson(res, 200, { ok: true, job: publicJobOf(job) });
    }

    if (route === '/jobs') {
      return sendJson(res, 200, { ok: true, jobs: listJobs() });
    }

    if (route === '/cancel' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: cancelJob(body.id) });
    }

    if (route === '/image') {
      const target = url.searchParams.get('url');
      if (!target) return sendJson(res, 400, { ok: false, error: '缺少 url' });
      const img = await fetchImage(target);
      res.writeHead(200, { 'content-type': img.type, 'content-length': img.body.length, 'cache-control': 'max-age=3600' });
      return res.end(img.body);
    }

    if (route === '/reveal' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.path !== 'string' || !body.path) return sendJson(res, 400, { ok: false, error: '缺少 path' });
      const isDir = !/\.[a-z0-9]{1,6}$/i.test(body.path);
      spawn('explorer.exe', isDir ? [body.path] : ['/select,', body.path], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/config' && method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.outDir === 'string' && body.outDir.trim()) patch.outDir = body.outDir.trim();
      if (typeof body.ffmpeg === 'string') patch.ffmpeg = body.ffmpeg.trim();
      if (typeof body.proxy === 'string') patch.proxy = body.proxy.trim();
      if (typeof body.copyToast === 'boolean') patch.copyToast = body.copyToast;
      const next = await saveState(patch);
      syncToastFlag(next.copyToast !== false);
      return sendJson(res, 200, { ok: true, outDir: next.outDir, ffmpeg: next.ffmpeg, proxy: getProxy(), copyToast: next.copyToast !== false });
    }

    /* 系统“选择文件夹”对话框：借宿主的 directoryPicker，拿不到就让界面自己输 */
    if (route === '/pick-dir' && method === 'POST') {
      const picker = ctx?.get?.('directoryPickerController') || ctx?.get?.('directoryPicker');
      if (!picker || typeof picker.pick !== 'function') {
        return sendJson(res, 200, { ok: false, error: '当前环境没有系统选择框，请直接把路径粘进输入框' });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      try {
        const dir = await picker.pick(controller.signal);
        return sendJson(res, 200, { ok: true, dir: dir || null });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: `选择窗口没能打开：${err?.message || err}` });
      } finally {
        clearTimeout(timer);
      }
    }

    return sendJson(res, 404, { ok: false, error: `未知路由 ${route}` });
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: err?.message || String(err) });
  }
}

/** `getJob` returns the internal record; strip the AbortController before serialising. */
function publicJobOf(job) {
  const { controller, ...rest } = job;
  return rest;
}

/* ───────────────────────────── Agent 工具 ───────────────────────────── */

function waitForJob(id, timeoutMs = 15 * 60_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const job = getJob(id);
      if (!job || job.status !== 'running' || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(job);
      }
    }, 500);
  });
}

export function apply(ctx, config) {
  loadState().then(() => { if (config && config.outDir) saveState({ outDir: config.outDir }); });

  /* ── 工具 1：解析并弹出选择器 ── */
  ctx.tools.register({
    name: 'bilibili_video',
    description: '解析 B 站视频链接（BV 号 / av 号 / 视频地址 / 带 ?p= 的分P），返回标题、UP、封面、作者头像、可用画质和音轨，并在界面弹出下载选择器（音频 / 视频画质 / 封面 / 作者头像）。用户发来 B 站链接时先调用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'B 站视频链接或 BV 号' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      if (!looksLikeBilibili(args.url)) throw new Error('这不是 B 站视频地址');
      const info = await probe(args.url);
      pending = { url: args.url, info, at: Date.now() };
      return formatPickResult(info);
    },
  });

  /* ── 工具 2：下载 ── */
  ctx.tools.register({
    name: 'bilibili_download',
    description: '下载 B 站视频的指定内容。视频按所选画质下载并自动合流最佳音轨（音频恒带，无需额外指定）；audio=true 且不传 videoQn 时只下音频（可选音质或转 MP3）；cover / avatar 下载封面与作者头像，可任意组合。等待下载完成后返回保存路径。画质用 qn 编号（80=1080P，64=720P，32=480P，16=360P，120=4K，116=1080P60）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'B 站视频链接或 BV 号' },
        videoQn: { type: 'number', description: '要下载的视频画质 qn（不传则不下视频）。1080P=80、720P=64、480P=32、360P=16、4K=120、1080P60=116、1080P高码率=112' },
        audio: { type: 'boolean', description: '是否单独下载音频；不传 videoQn 时生效。传了 videoQn 时视频会自动带音轨' },
        audioId: { type: 'number', description: '音轨 id：30280=192K、30232=132K、30216=64K（默认最高）' },
        audioMp3: { type: 'boolean', description: '纯音频时是否转成 MP3（需要 ffmpeg）' },
        cover: { type: 'boolean', description: '是否下载封面图' },
        avatar: { type: 'boolean', description: '是否下载 作者头像' },
        outDir: { type: 'string', description: '保存目录，默认 ~/Downloads/Bilibili' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30 * 60_000,
    async execute(args) {
      const pick = {
        videoQn: args.videoQn, audio: args.audio, audioId: args.audioId,
        audioMp3: args.audioMp3, cover: args.cover, avatar: args.avatar,
      };
      if (!pick.videoQn && !pick.audio && !pick.cover && !pick.avatar) {
        throw new Error('至少选一项：videoQn / audio / cover / avatar');
      }
      await loadState();
      const info = await probe(args.url);
      const job = await startDownload(
        { url: args.url, outDir: args.outDir || state.outDir, pick, ffmpeg: state.ffmpeg },
        { info },
      );
      const done = await waitForJob(job.id);
      if (!done) throw new Error('任务不存在');
      pending = null;
      return formatJob(publicJobOf(done));
    },
  });

  /* ── 工具 3：全平台（B 站 + yt-dlp 支持的站点） ── */
  ctx.tools.register({
    name: 'media_fetch',
    description: '全平台媒体下载：B 站走本地高清链路（多画质 / 音频 / 封面 / 作者头像），抖音走原生解析（无水印视频、图文图片），小红书走移动端分享页（图文原图、视频流），其余站点交给 yt-dlp。传链接时会弹出选择器；下载完成后返回落地路径，可直接接着做抽帧、转音频等处理。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: '任意视频页面链接' },
        quality: { type: 'string', description: '目标画质上限：best / 2160 / 1440 / 1080 / 720 / 480 / 360，默认 best' },
        audioOnly: { type: 'boolean', description: '只下音频' },
        audioMp3: { type: 'boolean', description: '只下音频时转 MP3（需要 ffmpeg）' },
        cover: { type: 'boolean', description: '同时下载封面/缩略图' },
        outDir: { type: 'string', description: '保存目录，默认插件设置里的下载目录' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30 * 60_000,
    async execute(args) {
      await loadState();
      const info = await probeUniversal(args.url);
      const video = args.audioOnly ? null : chooseVideo(info, args.quality);
      const pick = {
        videoQn: video?.qn ?? null,
        audio: true,
        audioMp3: Boolean(args.audioMp3),
        cover: Boolean(args.cover),
        avatar: false,
      };
      if (!pick.videoQn && !args.audioOnly) pick.audio = true;
      const job = await dispatchDownload(args.url, info, {
        outDir: args.outDir || state.outDir,
        pick,
        ffmpeg: state.ffmpeg,
      });
      const done = await waitForJob(job.id);
      if (!done) throw new Error('任务不存在');
      pending = null;
      return `${formatInfo(info)}\n\n${formatJob(publicJobOf(done))}`;
    },
  });

  /* ── 界面通道 ── */
  /* 必须用 ctx.inject：webServer 可能比本插件晚激活，ctx.get 取不到时
     原来会静默跳过注册，导致 /bili-dl/* 全 404 而插件看起来是活的。 */
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/bili-dl',
      handler: (req, res) => handleHttp(req, res, webCtx),
    }), 'dsh-media: web routes');
  });
}
