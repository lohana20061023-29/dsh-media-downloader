/**
 * 登录窗口：用一个独立的浏览器 profile 打开平台登录页，
 * 用户在里面正常登录，宿主通过 CDP 读出 cookie 并写成 Netscape cookies.txt。
 *
 * 为什么不用 --cookies-from-browser：
 *   Edge/Chrome 127+ 的 cookie 是应用绑定加密（ABE），yt-dlp 解不开；
 *   而且日常浏览器的 cookie 库常常被进程锁住。独立 profile 是自己的，
 *   加密密钥由浏览器自己持有，通过 DevTools 协议读出来的就是明文。
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.dsh', 'bili-dl');
const PROFILE_DIR = join(ROOT, 'browser-profile');
const COOKIE_FILE = join(ROOT, 'cookies.txt');

export const PLATFORMS = {
  youtube: {
    label: 'YouTube',
    url: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/',
    nameExpr: '(document.querySelector("#account-name")?.textContent || "").trim()',
    check: ['SID', 'HSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'],
    domains: ['youtube.com', 'google.com', 'googleapis.com', 'gstatic.com', 'ytimg.com'],
  },
  bilibili: {
    label: 'B 站',
    url: 'https://passport.bilibili.com/login',
    check: ['SESSDATA'],
    domains: ['bilibili.com', 'hdslb.com', 'bilivideo.com', 'biliapi.net'],
  },
  twitter: {
    label: 'X',
    url: 'https://x.com/i/flow/login',
    nameExpr: '(document.querySelector(\'[data-testid="SideNav_AccountSwitcher_Button"]\')?.innerText || "").match(/@[A-Za-z0-9_]+/)?.[0] || ""',
    check: ['auth_token'],   // ct0 匿名访客也会下发，不能作为登录依据
    domains: ['x.com', 'twitter.com', 'twimg.com'],
  },
  vimeo: {
    label: 'Vimeo',
    url: 'https://vimeo.com/log_in',
    check: ['vimeo', 'is_logged_in'],
    domains: ['vimeo.com', 'vimeocdn.com'],
  },
  tiktok: {
    label: 'TikTok',
    url: 'https://www.tiktok.com/login',
    check: ['sessionid', 'sid_tt', 'uid_tt'],
    domains: ['tiktok.com', 'ttwstatic.com', 'tiktokcdn.com'],
  },
  douyin: {
    label: '抖音',
    url: 'https://www.douyin.com/',
    /* 抖音是独立服务（douyin.com），和 TikTok 的 tiktok.com 不通用 */
    check: ['sessionid', 'sessionid_ss', 'sid_guard'],
    domains: ['douyin.com', 'iesdouyin.com', 'douyinpic.com', 'douyinvod.com', 'amemv.com', 'byteimg.com', 'snssdk.com'],
  },
  xiaohongshu: {
    label: '小红书',
    url: 'https://www.xiaohongshu.com/login',
    nameExpr: '(window.__INITIAL_STATE__?.user?.userInfo?.nickname || document.querySelector(".user .name")?.textContent || "").trim()',
    /* 匿名访客就有 web_session（长度也一样），不能用它判登录；
       登录后才会出现 id_token / unread。 */
    check: ['id_token', 'unread'],
    domains: ['xiaohongshu.com', 'xhscdn.com'],
  },
};

const BROWSERS = [
  { name: 'edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'edge', exe: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'chrome', exe: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'chrome', exe: join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe') },
];

function findBrowser() {
  for (const b of BROWSERS) if (b.exe && existsSync(b.exe)) return b;
  return null;
}

/* ── 会话状态 ─────────────────────────────────────────────────────────── */

let session = null;

export const getLoginSession = () => (session ? publicSession() : { state: 'idle' });

function publicSession() {
  return {
    state: session.state,          // starting | waiting | ok | error | closed | timeout
    platform: session.platform,
    message: session.message || '',
    browser: session.browser || '',
    count: session.count || 0,
    startedAt: session.startedAt,
  };
}

export function cancelLoginSession() {
  if (!session) return false;
  cleanup();
  session.state = 'closed';
  session.message = '已取消';
  const s = session;
  session = null;
  return Boolean(s);
}

function cleanup() {
  if (!session?.child) return;
  const pid = session.child.pid;
  const port = session.port;
  session.child = null;

  /* 先请浏览器自己退出：否则 cookie 还在内存/WAL 里，强杀会丢，
     下次启动 profile 就少了这些登录态。 */
  (async () => {
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) })).json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 1500);
        ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws')); }, { once: true });
      });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await new Promise((r) => setTimeout(r, 1500));
      try { ws.close(); } catch { /* ignore */ }
    } catch { /* 端口已关或浏览器已退 */ }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  })();
}

/* ── CDP 客户端（Node 22+ 自带 WebSocket） ─────────────────────────────── */

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
    });
  }

  ready() {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}



const NAMES_FILE = join(ROOT, 'names.json');

export async function readNames() {
  try { return JSON.parse(await readFile(NAMES_FILE, 'utf8')); } catch { return {}; }
}

async function saveName(key, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return;
  const all = await readNames();
  if (all[key] === clean) return;
  all[key] = clean;
  await writeFile(NAMES_FILE, JSON.stringify(all, null, 2), 'utf8');
}

/** 在登录成功的那个真窗口里问一次名字（小红书无头会被风控，必须趁窗口还开着）。 */
async function captureName(port, platform) {
  if (!platform.nameExpr) return '';
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })).json();
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) return '';
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready();
    const res = await cdp.send('Runtime.evaluate', { expression: platform.nameExpr, returnByValue: true, awaitPromise: true });
    cdp.close();
    const v = res?.result?.value;
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

/* ── 行为验证：cookie 名字会说谎，请求结果不会 ───────────────────────── */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function headerFrom(items, platform) {
  const pairs = [];
  for (const it of items) {
    const domain = String(it.domain || '').replace(/^\./, '').toLowerCase();
    const onDomain = platform.domains.some((d) => domain === d || domain.endsWith(`.${d}`));
    if (!onDomain) continue;
    if (!it.name) continue;
    pairs.push(`${it.name}=${it.value ?? ''}`);
  }
  return pairs.join('; ');
}

async function xhsAuthed(cookieHeader) {
  if (!cookieHeader) return false;
  try {
    const res = await fetch('https://www.xiaohongshu.com/explore', {
      headers: { 'User-Agent': BROWSER_UA, Cookie: cookieHeader, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const location = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400) return !/login/i.test(location);
    /* 200 也可能是一张登录墙，粗判一下 */
    if (res.status === 200) {
      /* 未登录时 explore 仍然返回 200，只是渲染一张登录墙；必须认出墙上的特征文案 */
      const text = await res.text();
      const wall = /登录后推荐更懂你的笔记|扫码登录|手机号登录|login_qrcode|login-container/i.test(text);
      return !wall;
    }
    return false;
  } catch {
    return false;
  }
}

async function verifyPlatform(platform, items) {
  if (platform.verify !== 'xhs') return true;
  return xhsAuthed(headerFrom(items, platform));
}
/* ── 只保留视频站相关的 cookie ────────────────────────────────────────── */
/* 这个文件会被 yt-dlp 整份读取；登录窗口里逛别的站点产生的 cookie
   不该跟着进去（尤其是别家站点的会话）。 */

const KEEP_DOMAINS = [
  'bilibili.com', 'b23.tv', 'bilivideo.com', 'biliapi.net', 'hdslb.com',
  'youtube.com', 'youtu.be', 'google.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'googleapis.com', 'gstatic.com',
  'x.com', 'twitter.com', 'twimg.com',
  'vimeo.com', 'vimeocdn.com',
  'tiktok.com', 'tiktokcdn.com', 'ttwstatic.com',
  'xiaohongshu.com', 'xhscdn.com',
  'douyin.com', 'iesdouyin.com', 'weibo.com', 'weibo.cn',
  'instagram.com', 'facebook.com', 'twitch.tv', 'nicovideo.jp', 'dailymotion.com',
  'iqiyi.com', 'youku.com', 'bilibili.cn',
];

export function keepCookieDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!d) return false;
  return KEEP_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`));
}
/* ── Netscape 序列化 ──────────────────────────────────────────────────── */

function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# written by dsh media downloader'];
  for (const c of cookies) {
    if (!c.domain || !c.name) continue;
    const domain = c.domain.startsWith('.') ? c.domain : c.domain;
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = !c.expires || c.expires < 0 ? '0' : String(Math.floor(c.expires));
    const name = String(c.name);
    const value = String(c.value ?? '');
    if (/\t|\n/.test(name + value)) continue;
    lines.push([domain, includeSub, c.path || '/', secure, expires, name, value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/* ── 端口 ─────────────────────────────────────────────────────────────── */

async function freePort() {
  for (let p = 9335; p < 9360; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(300) });
      if (res.ok) continue; // 被占用
    } catch { return p; }
  }
  throw new Error('找不到可用端口');
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */

/**
 * 打开登录窗口。
 * @param {string} platformKey youtube | bilibili | twitter | vimeo | tiktok
 * @param {(s: object) => void} [onUpdate]
 */
export async function startLoginSession(platformKey, onUpdate) {
  const platform = PLATFORMS[platformKey];
  if (!platform) throw new Error(`不支持的平台：${platformKey}`);
  if (session && session.state === 'waiting') throw new Error('已经有一个登录窗口在开着');

  const browser = findBrowser();
  if (!browser) throw new Error('没找到 Edge 或 Chrome，无法打开登录窗口');

  await mkdir(PROFILE_DIR, { recursive: true });
  const port = await freePort();

  const child = spawn(browser.exe, [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    platform.url,
  ], { detached: false, stdio: 'ignore', windowsHide: false });

  session = {
    state: 'starting', platform: platformKey, browser: browser.name,
    startedAt: Date.now(), child, port, count: 0, message: '正在启动浏览器…',
  };
  const notify = () => onUpdate?.(publicSession());
  notify();

  /* 用户直接关窗口时立刻结束等待，别干等到超时 */
  child.on('exit', () => {
    if (!session || session.child !== child) return;
    if (session.state !== 'starting' && session.state !== 'waiting') return;
    session.child = null;
    session.state = 'closed';
    session.message = '登录窗口已关闭';
    notify();
  });

  /* 后台跑：等端口 → 连 CDP → 轮询 cookie */
  (async () => {
    try {
      let up = false;
      for (let i = 0; i < 100; i++) {
        if (session?.state !== 'starting') return;
        try {
          const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
          if (r.ok) { up = true; break; }
        } catch { /* 还没起来 */ }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!up) throw new Error('浏览器没能开启调试端口');
      if (!session) return;

      session.state = 'waiting';
      session.message = '请在弹出的窗口里完成登录';
      notify();

      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline && session?.state === 'waiting') {
        await new Promise((r) => setTimeout(r, 2000));
        if (!session || session.state !== 'waiting') return;

        const cookies = await readCookies(port);
        if (!cookies) continue;

        session.count = cookies.length;
        const nameHit = cookies.some((c) => platform.check.includes(c.name));
        if (!nameHit) continue;
        if (!(await verifyPlatform(platform, cookies))) continue;

        await persist(cookies, platformKey);
        await saveName(platformKey, await captureName(port, platform));
        cleanup();
        session.state = 'ok';
        session.message = `已拿到 ${cookies.length} 条 cookie`;
        notify();
        return;
      }
      if (session?.state === 'waiting') {
        cleanup();
        session.state = 'timeout';
        session.message = '等待超时（8 分钟），窗口已关闭';
        notify();
      }
    } catch (err) {
      cleanup();
      if (session) {
        session.state = 'error';
        session.message = err.message;
        notify();
      }
    }
  })();

  return publicSession();
}

/** 用户在窗口里点「我已登录」时手动抓一次。 */
export async function finishLoginSession() {
  if (!session || !session.port) throw new Error('没有进行中的登录窗口');
  const cookies = await readCookies(session.port);
  if (!cookies || !cookies.length) throw new Error('没读到任何 cookie，确认已经登录了吗？');
  await persist(cookies, session.platform);
  const platform = PLATFORMS[session.platform];
  if (platform) await saveName(session.platform, await captureName(session.port, platform));
  cleanup();
  session.state = 'ok';
  session.message = `已拿到 ${cookies.length} 条 cookie`;
  return publicSession();
}

async function readCookies(port) {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    return null;
  }
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) return null;

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  try {
    await cdp.ready();
    const res = await cdp.send('Network.getAllCookies');
    return res.cookies || [];
  } catch {
    return null;
  } finally {
    cdp.close();
  }
}

async function persist(cookies, platformKey) {
  await mkdir(ROOT, { recursive: true });
  const platform = PLATFORMS[platformKey];
  const owns = (domain) => {
    const d = String(domain || '').replace(/^\./, '').toLowerCase();
    return Boolean(platform?.domains.some((x) => d === x || d.endsWith('.' + x)));
  };

  let rows = [];
  try {
    const text = await readFile(COOKIE_FILE, 'utf8');
    rows = text.split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('\t'))
      .filter((r) => r.length >= 7 && !owns(r[0]));
  } catch { /* 首次没有文件 */ }

  for (const c of cookies) {
    if (!keepCookieDomain(c.domain)) continue;
    const domain = c.domain?.startsWith('.') ? c.domain : (c.domain || '');
    const expires = !c.expires || c.expires < 0 ? '0' : String(Math.floor(c.expires));
    rows.push([domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/',
      c.secure ? 'TRUE' : 'FALSE', expires, String(c.name), String(c.value ?? '')]);
  }

  const header = ['# Netscape HTTP Cookie File', '# written by dsh media downloader'];
  await writeFile(COOKIE_FILE, header.concat(rows.map((r) => r.join('\t'))).join('\n') + '\n', 'utf8');
}


/**
 * 从 cookies.txt 反推「哪些平台已登录」——文件是唯一事实来源，
 * 所以重启、重登、清除之后状态都自洽。
 * @returns {Promise<Record<string, boolean>>}
 */
export async function detectLogins() {
  let text = '';
  try { text = await readFile(COOKIE_FILE, 'utf8'); } catch { return {}; }
  const rows = text.split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'));
  const items = rows.filter((r) => r.length >= 7).map((r) => ({ domain: r[0], name: r[5], value: r[6] }));
  const result = {};
  for (const [key, p] of Object.entries(PLATFORMS)) {
    const nameHit = items.some((it) => {
      const domain = String(it.domain).replace(/^\./, '').toLowerCase();
      const onDomain = p.domains.some((d) => domain === d || domain.endsWith('.' + d));
      return onDomain && p.check.includes(it.name);
    });
    result[key] = nameHit ? await verifyPlatform(p, items) : false;
  }
  return result;
}
export { COOKIE_FILE };
