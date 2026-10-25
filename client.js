window.__ModuleLoader__.load({
  id: 'dsh-media-downloader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ─────────────────────────── 与宿主通讯 ─────────────────────────── */

    const API = '/bili-dl';

    async function call(path, body) {
      const res = await fetch(API + path, body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let json;
      try { json = await res.json(); } catch { throw new Error(`接口返回异常（HTTP ${res.status}）`); }
      if (!json.ok) throw new Error(json.error || '请求失败');
      return json;
    }

    const img = (url) => url ? `${API}/image?url=${encodeURIComponent(url)}` : '';

    const fmtDur = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
    const fmtMB = (b) => b ? `${(b / 1048576).toFixed(1)} MB` : '';

    /* ───────────────────────────── 状态仓库 ───────────────────────────── */

    function createStore() {
      let state = {
        open: false,
        url: '',
        info: null,
        loading: false,
        error: null,
        pick: { videoQn: null, audio: true, audioId: null, audioMp3: false, cover: false, coverIds: [], imageIds: [], avatar: false },
        outDir: '',
        ffmpeg: null,
        login: { login: false },
        loginOpen: false,
        cookieDraft: '',
        qr: null,
        qrBusy: false,
        loginPanel: false,
        loginTab: 'bili',
        cookies: { browser: '', file: '' },
        logins: {},
        ckOpen: false,
        ckText: '',
        ckDomain: '',
        loginSession: { state: 'idle' },
        settingsOpen: false,
        dirDraft: '',
        proxy: '',
        proxyDetected: '',
        proxyDraft: '',
        job: null,
        busy: false,
        pasteToast: null,
      };
      const listeners = new Set();
      let pasteTimer = null;
      let timer = null;

      const get = () => state;
      const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
      const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

      function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }

      function pollJob(id) {
        stopPolling();
        timer = setInterval(async () => {
          try {
            const { job } = await call(`/job?id=${encodeURIComponent(id)}`);
            set({ job });
            if (job.status !== 'running') stopPolling();
          } catch { stopPolling(); }
        }, 700);
      }

      async function boot() {
        try {
          const info = await call('/ping');
          set({
            version: info.version || '',
            outDir: info.outDir, ffmpeg: info.ffmpeg,
            proxy: info.proxy || '', proxyDetected: info.proxyDetected || '',
            login: info.login || { login: false },
            cookies: info.cookies || { browser: '', file: '' },
            logins: info.logins || {},
          });
          if (info.pending?.info) openWith(info.pending.url, info.pending.info);
        } catch { /* 宿主还没起来 */ }
      }

      async function saveCookie(text) {
        const raw = (text ?? state.cookieDraft).trim();
        if (!raw) return;
        set({ busy: true, error: null });
        try {
          const { login } = await call('/login', { cookie: raw });
          set({ login, loginOpen: false, cookieDraft: '' });
          if (state.info) await probe(state.url);
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: false });
        }
      }

      async function logout() {
        await call('/logout', {}).catch(() => {});
        set({ login: { login: false } });
        if (state.info) await probe(state.url);
      }

      /* ── 其它站点登录（交给 yt-dlp 的 cookie 通道） ── */

      async function saveCkBrowser(browser) {
        set({ busy: true, error: null });
        try {
          const { cookies } = await call('/login/browser', { browser });
          set({ cookies, ckOpen: false });
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: false });
        }
      }

      async function saveCkText(domain) {
        const text = (state.ckText || '').trim();
        if (!text) return;
        set({ busy: true, error: null });
        try {
          const res = await call('/login/cookies', { text, domain: domain ?? state.ckDomain });
          set({ cookies: res.cookies, ckOpen: false, ckText: '' });
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: false });
        }
      }

      async function clearCk() {
        await call('/login/clear', {}).catch(() => {});
        const info = await call('/ping').catch(() => null);
        set({
          cookies: info?.cookies || { browser: '', file: '' },
          logins: info?.logins || {},
        });
      }

      /* ── 登录窗口（独立 profile 的浏览器，登录后自动抓 cookie） ── */

      let loginTimer = null;
      function stopLoginPoll() { if (loginTimer) { clearInterval(loginTimer); loginTimer = null; } }

      function watchLogin() {
        stopLoginPoll();
        loginTimer = setInterval(async () => {
          try {
            const { session } = await call('/login/session');
            set({ loginSession: session });
            if (session.state === 'starting' || session.state === 'waiting') return;
            stopLoginPoll();
            if (session.state === 'ok') {
              const info = await call('/ping');
              set({ cookies: info.cookies || { browser: '', file: '' }, logins: info.logins || {} });
            }
          } catch { stopLoginPoll(); }
        }, 2000);
      }

      async function openLogin(platform) {
        set({ busy: true, error: null });
        try {
          const { session } = await call('/login/session', { platform });
          set({ loginSession: session });
          watchLogin();
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: false });
        }
      }

      async function finishLogin() {
        set({ busy: true, error: null });
        try {
          const res = await call('/login/session/finish', {});
          set({ loginSession: res.session, cookies: res.cookies, logins: res.logins || {}, ckOpen: false });
          stopLoginPoll();
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: false });
        }
      }

      async function cancelLogin() {
        await call('/login/session/cancel', {}).catch(() => {});
        stopLoginPoll();
        set({ loginSession: { state: 'idle' } });
      }
      /* ── 扫码登录 ── */

      let qrTimer = null;
      function stopQrPoll() { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }

      async function startQr() {
        stopQrPoll();
        set({ qrBusy: true, error: null, loginOpen: false });
        try {
          const { key, svg } = await call('/qr/start', {});
          set({ qr: { key, svg, state: 'waiting', message: '' } });
          qrTimer = setInterval(async () => {
            try {
              const r = await call('/qr/poll', { key });
              if (r.state === 'ok') {
                stopQrPoll();
                set({ qr: null, login: r.login });
                if (state.info) await probe(state.url);
              } else if (r.state === 'expired') {
                stopQrPoll();
                set({ qr: { key, svg, state: 'expired', message: '二维码已失效' } });
              } else {
                set({ qr: { key, svg, state: r.state, message: r.message || '' } });
              }
            } catch { /* 单次轮询失败不打断 */ }
          }, 2000);
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ qrBusy: false });
        }
      }

      function cancelQr() { stopQrPoll(); set({ qr: null }); }

      let pendingTimer = null;
      function watchPending() {
        if (pendingTimer) return;
        pendingTimer = setInterval(async () => {
          if (state.open) return;
          try {
            const { pending } = await call('/pending');
            if (pending?.info) openWith(pending.url, pending.info);
          } catch { /* ignore */ }
        }, 1500);
      }

      /** 插件卸载 / HMR 时把两个定时器一起收掉。 */
      function dispose() {
        stopPolling();
        stopQrPoll();
        stopLoginPoll();
        if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
      }

      function openWith(url, info) {
        const videos = info?.videos || [];
        const audios = info?.audios || [];
        set({
          open: true, url: url || state.url, info: info || null, error: null,
          pick: {
            videoQn: videos[0]?.qn ?? null,
            /* 视频恒带音轨；这个勾选框只代表「只要音频」，所以默认不勾 */
            audio: false,
            audioId: audios[0]?.id ?? null,
            audioMp3: false,
            cover: false,
            coverIds: [],   /* 默认不勾封面：只下视频/音频，需要时再点 */
            imageIds: (info?.images || []).map((c) => c.id),
            avatar: false,
          },
        });
        call('/pending/clear', {}).catch(() => {});
      }

      /* ── 剪贴板里的视频链接 ── */

      const URL_RE = /https?:\/\/[^\s"'<>）)]+/i;
      const BILI_ID_RE = /(BV[0-9A-Za-z]{10})|(av\d{6,})/;
      const VIDEO_HOST_RE = /(^|\.)(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|x\.com|twitter\.com|vimeo\.com|tiktok\.com|douyin\.com|iesdouyin\.com|weibo\.com|weibo\.cn|xiaohongshu\.com|instagram\.com|twitch\.tv|nicovideo\.jp|dailymotion\.com|facebook\.com)$/i;

      function pickLink(text) {
        const raw = String(text || '').trim();
        if (!raw) return '';
        const hit = raw.match(URL_RE);
        if (hit) return hit[0];
        const id = raw.match(BILI_ID_RE);
        return id ? id[0] : '';
      }

      function looksLikeVideoLink(link) {
        if (BILI_ID_RE.test(link) || /b23\.tv/i.test(link)) return true;
        try { return VIDEO_HOST_RE.test(new URL(link).hostname); } catch { return false; }
      }

      async function readClipboard() {
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return '';
          return await navigator.clipboard.readText();
        } catch {
          /* 没授权 / 非安全上下文：静默放弃，用户手动粘 */
          return '';
        }
      }
      async function open(url) {
        if (url) {
          if (state.info && state.url === url) { set({ open: true }); return; }
          set({ open: true, url, info: null, error: null, job: null, pasteToast: null });
          await probe(url);
          return;
        }
        set({ open: true });
        /* 点图标打开时读一次剪贴板：是视频链接就直接填进去并解析 */
        const link = pickLink(await readClipboard());
        if (!link || link === state.url) return;
        set({ url: link, info: null, error: null, job: null });
        if (looksLikeVideoLink(link)) await probe(link);
      }

      async function probe(text) {
        const url = (text ?? state.url).trim();
        if (!url) return;
        set({ loading: true, error: null });
        try {
          const { info } = await call('/probe', { url });
          openWith(url, info);
        } catch (err) {
          set({ error: err.message, info: null });
        } finally {
          set({ loading: false });
        }
      }

      function patchPick(patch) { set({ pick: { ...state.pick, ...patch } }); }

      /** 页面任意位置粘贴到链接：先弹角落提示，不直接开面板 */
function notifyCopy(url) {
  pushTheme();
  call('/notify', { url })
    .then((r) => { if (!r || !r.shown) notifyPaste(url); })
    .catch(() => notifyPaste(url));
}

/* 把当前主题同步给宿主，供屏幕角落提示使用 */
function pushTheme() {
  try {
    const els = [document.body, document.documentElement].filter(Boolean);
    const raw = (name) => {
      for (const el of els) {
        const v = getComputedStyle(el).getPropertyValue(name).trim();
        if (v) return v;
      }
      return '';
    };
    const asColor = (name) => {
      const v = raw(name);
      return /^#|^rgba?\(|^color\(/.test(v) ? v : '';
    };

    /* 强调色兜底：DSH 的 --dsw-alias-brand-primary 常是 var(--edge-accent)，
       解析不出具体颜色时，统计页面上最高频的饱和色 */
    const saturated = () => {
      const tally = new Map();
      const all = document.querySelectorAll('*');
      const limit = Math.min(all.length, 4000);
      for (let i = 0; i < limit; i++) {
        const cs = getComputedStyle(all[i]);
        for (const val of [cs.backgroundColor, cs.color, cs.borderTopColor]) {
          const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(val || '');
          if (!m) continue;
          const r = +m[1], g = +m[2], b = +m[3];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max - min >= 50 && max >= 90 && max <= 250) {
            const key = `${r},${g},${b}`;
            tally.set(key, (tally.get(key) || 0) + 1);
          }
        }
      }
      let best = '', bestCount = 0;
      for (const [key, count] of tally) {
        if (count > bestCount) { bestCount = count; best = key; }
      }
      if (!best) return '';
      const [r, g, b] = best.split(',');
      return `rgb(${r}, ${g}, ${b})`;
    };

    const accent = asColor('--dsw-alias-brand-primary') || saturated();

    call('/theme', {
      accent,
      bg: asColor('--dsw-alias-bg-overlay') || asColor('--dsw-alias-bg-base') || '',
      fg: asColor('--dsw-alias-label-primary'),
      sub: asColor('--dsw-alias-label-secondary'),
      border: asColor('--dsw-alias-border-l1'),
      font: getComputedStyle(document.body).fontFamily || '',
    }).catch(() => {});
  } catch { /* 主题读取失败不影响主流程 */ }
}

function notifyPaste(url) {
        if (!url) return;
        if (state.open) return;
        if (pasteTimer) clearTimeout(pasteTimer);
        set({ pasteToast: { url } });
        pasteTimer = setTimeout(() => set({ pasteToast: null }), 6000);
      }

      function dismissPaste() {
        if (pasteTimer) clearTimeout(pasteTimer);
        set({ pasteToast: null });
      }

      async function start() {
        const { pick, info, url } = state;
        const any = pick.videoQn || pick.audio || (pick.coverIds || []).length || (pick.imageIds || []).length || pick.avatar;
        if (!any) { set({ error: '至少勾选一项' }); return; }
        set({ busy: true, error: null, job: null });
        try {
          const { job } = await call('/download', { url, info, pick, outDir: state.outDir });
          set({ job });
          pollJob(job.id);
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: false });
        }
      }

      async function cancel() {
        if (state.job) await call('/cancel', { id: state.job.id }).catch(() => {});
      }

      async function reveal(path) {
        await call('/reveal', { path }).catch(() => {});
      }

      async function setOutDir(dir, proxyOverride) {
        const next = String(dir || '').trim();
        if (!next) return;
        const prev = state.outDir;
        /* 先乐观更新：目录立刻反映到底部，网络慢或失败也不会看起来"没反应" */
        set({ outDir: next, dirDraft: next, settingsOpen: false, error: null });
        try {
          const body = { outDir: next };
          if (proxyOverride !== undefined) body.proxy = proxyOverride;
          const res = await call('/config', body);
          if (res && res.outDir) {
            set({ outDir: res.outDir, dirDraft: res.outDir, proxy: res.proxy || '' });
          }
        } catch (e) {
          /* 失败就回滚，并把原因显出来，不再静默 */
          set({
            outDir: prev, dirDraft: prev,
            error: '保存目录失败：' + (e && e.message ? e.message : String(e)),
          });
        }
      }

      function setCopyToast(on) {
      set({ copyToast: on });
      call('/config', { copyToast: on }).catch(() => {});
    }

    function openSettings() {
        set({
          settingsOpen: true,
          dirDraft: state.outDir || '',
          proxyDraft: state.proxy || '',
        });
      }

      async function browseDir() {
        set({ busy: true, error: null });
        try {
          const res = await call('/pick-dir', {});
          if (res.dir) set({ dirDraft: res.dir });
          else if (res.error) set({ error: res.error });
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: false });
        }
      }

      return { get, set, subscribe, notifyCopy, pushTheme, setCopyToast, boot, watchPending, open, probe, patchPick, start, cancel, reveal, setOutDir, saveCookie, logout, openSettings, browseDir, startQr, cancelQr, saveCkBrowser, saveCkText, clearCk, openLogin, finishLogin, cancelLogin, notifyPaste, dismissPaste, dispose };
    }

    /* ───────────────────────────── 样式 ───────────────────────────── */

    const CSS = `
.bili-backdrop{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.42);backdrop-filter:blur(2px);padding:24px;animation:bili-fade .14s ease-out}
@keyframes bili-fade{from{opacity:0}to{opacity:1}}
@keyframes bili-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
.bili-card{width:min(600px,100%);max-height:min(88vh,860px);display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:14px;
  box-shadow:0 24px 64px rgba(0,0,0,.28);animation:bili-pop .16s ease-out;font-size:13px}
.bili-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.bili-title{font-weight:600;font-size:13.5px;letter-spacing:.2px}
.bili-tag{font-size:11px;padding:1px 6px;border-radius:5px;background:rgba(251,114,153,.14);color:#fb7299;font-weight:600}
.bili-gear{width:26px;height:26px;border-radius:7px;border:none;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#666);display:grid;place-items:center;margin-left:auto}
.bili-gear:hover,.bili-gear[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2,#f2f2f2);
  color:var(--dsw-alias-brand-primary,#4d6bfe)}
.bili-x{width:26px;height:26px;border-radius:7px;border:none;background:transparent;cursor:pointer;
  margin-left:2px;color:var(--dsw-alias-label-secondary,#666);font-size:16px;line-height:1;display:grid;place-items:center}
.bili-x:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}
.bili-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:13px}
.bili-row{display:flex;gap:8px;align-items:center}
.bili-input{flex:1;min-width:0;height:34px;padding:0 11px;border-radius:9px;font:inherit;font-size:12.5px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fafafa);
  color:inherit;outline:none}
.bili-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 3px rgba(77,107,254,.13)}
.bili-btn{height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));
  background:var(--dsw-alias-bg-layer-1,#fafafa);color:inherit;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.bili-btn:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}
.bili-btn:disabled{opacity:.45;cursor:default}
.bili-btn-on{border-color:var(--dsw-alias-button-info-fill,#14d0d0);
  color:var(--dsw-alias-button-info-fill,#14d0d0);font-weight:600}
.bili-btn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff;font-weight:600}
.bili-btn-primary:hover{filter:brightness(1.06);background:var(--dsw-alias-brand-primary,#4d6bfe)}
.bili-meta{display:flex;gap:12px}
.bili-cover{height:82px;width:auto;max-width:190px;border-radius:9px;object-fit:contain;background:var(--dsw-alias-bg-layer-2,#eee);flex:none}
.bili-meta-txt{min-width:0;display:flex;flex-direction:column;gap:6px;justify-content:center}
.bili-vtitle{font-weight:600;font-size:13px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bili-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b6b6b);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.bili-face{width:18px;height:18px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-2,#eee)}
.bili-login{display:flex;flex-direction:column;gap:8px;font-size:11.5px;padding:8px 10px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));
  color:var(--dsw-alias-label-secondary,#6b6b6b);line-height:1.5}
/* 折叠栏的平台图标 */
.bili-chips{display:inline-flex;gap:5px;align-items:center;flex:1;min-width:0;overflow:hidden}
.bili-chip{width:18px;height:18px;flex:none;display:grid;place-items:center;
  color:var(--dsw-alias-label-tertiary,#9a9a9a);
  opacity:.42;filter:saturate(.35);transition:opacity .12s ease,filter .12s ease}
.bili-chip[data-on="1"]{opacity:1;filter:none}
.bili-login-head{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;padding:0;
  font:inherit;color:inherit;cursor:pointer;text-align:left;line-height:1.5}
.bili-login-title{font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.bili-login-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bili-caret{font-size:10px;opacity:.65}
.bili-login-body{display:flex;flex-direction:column;gap:9px;padding-top:8px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.bili-tabs{display:flex;gap:6px;flex-wrap:wrap}
.bili-tab{padding:3px 10px;border-radius:7px;font-size:11.5px;cursor:pointer;user-select:none;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));color:var(--dsw-alias-label-secondary,#6b6b6b)}
.bili-tab:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}
.bili-tab[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);
  color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.08);font-weight:600}.bili-login .bili-input{height:28px;font-size:12px}
.bili-ok{color:var(--dsw-alias-state-success-primary,#18a058);font-weight:700}
.bili-warn{color:var(--dsw-alias-state-warn-primary,#e0932f);font-weight:700}
.bili-lnk{border:none;background:none;padding:0;font:inherit;cursor:pointer;
  color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:underline;white-space:nowrap}
.bili-qr{display:flex;gap:14px;padding:10px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));background:var(--dsw-alias-bg-layer-1,#fafafa)}
.bili-qr-box{width:172px;height:172px;flex:none;background:#fff;border-radius:9px;padding:6px;
  box-sizing:border-box;display:grid;place-items:center}
.bili-qr-box svg{display:block;width:100%;height:100%}
.bili-qr-side{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;justify-content:center}
.bili-qr-state{font-size:12.5px;font-weight:600;line-height:1.4}
.bili-lnk:disabled{opacity:.5;cursor:default;text-decoration:none}.bili-sec{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;overflow:hidden}
.bili-sec-h{display:flex;align-items:center;gap:7px;padding:8px 11px;background:var(--dsw-alias-bg-layer-1,#fafafa);
  font-size:12px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.bili-sec-h small{font-weight:400;color:var(--dsw-alias-label-secondary,#6b6b6b);margin-left:auto;font-size:11px}
.bili-sec-b{padding:8px 11px;display:flex;flex-direction:column;gap:7px}
.bili-opts{display:flex;flex-wrap:wrap;gap:6px}
.bili-opt{display:inline-flex;align-items:center;gap:6px;height:29px;padding:0 10px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));font-size:12px;user-select:none;white-space:nowrap}
.bili-opt:hover{background:var(--dsw-alias-bg-layer-2,#f4f4f4)}
.bili-opt[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.09);
  color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
.bili-opt[data-vip="1"]::after{content:'VIP';font-size:9px;padding:0 3px;border-radius:3px;background:#f0a020;color:#fff}
.bili-chk{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;user-select:none}
.bili-chk input{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;margin:0}
.bili-sel{height:29px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  background:var(--dsw-alias-bg-layer-1,#fafafa);color:inherit;font:inherit;font-size:12px;padding:0 6px}
.bili-err{padding:8px 11px;border-radius:9px;font-size:12px;line-height:1.5;
  background:rgba(240,90,80,.1);color:var(--dsw-alias-state-error-primary,#d33)}
.bili-job{display:flex;flex-direction:column;gap:7px;padding:9px 11px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.bili-item{display:flex;flex-direction:column;gap:4px;font-size:12px}
.bili-item-top{display:flex;gap:8px;align-items:center}
.bili-item-top b{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bili-pct{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:11.5px}
.bili-bar{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-2,#e8e8e8);overflow:hidden}
.bili-bar i{display:block;height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary,#4d6bfe);
  transition:width .3s ease}
.bili-file{font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b6b);word-break:break-all;line-height:1.45}
.bili-foot{display:flex;gap:8px;align-items:center;padding:11px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  background:var(--dsw-alias-bg-layer-1,#fafafa)}
.bili-dir{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b6b);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.bili-dir:hover{color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:underline}
.bili-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(77,107,254,.25);border-top-color:#4d6bfe;
  animation:bili-rot .7s linear infinite;flex:none}
@keyframes bili-rot{to{transform:rotate(360deg)}}
/* 常态：暗色底 + 强调色图标；悬停对调。无边框、无描边。 */
.bili-trigger{corner-shape:round;width:28px;height:28px;flex:none;border:none;border-radius:999px;margin:0 4px 0 2px;
  background:var(--dsw-specific-selector,#2c2e2a);
  color:var(--dsw-alias-button-info-fill,#14d0d0);
  cursor:pointer;display:grid;place-items:center;padding:0;
  transition:background-color .12s ease,color .12s ease}
.bili-trigger:hover{background:var(--dsw-alias-button-info-fill,#14d0d0);
  color:var(--dsw-specific-selector,#2c2e2a)}
.bili-trigger:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#14d0d0);outline-offset:2px}
/* 悬浮提示：照宿主 Tooltip 的样子 —— 深底、圆角、字重跟随主题 */
.bili-tip{position:fixed;z-index:9600;transform:translate(-50%,-100%);pointer-events:none;
  background:var(--dsw-alias-tooltip-bg,#2a2b28);color:#fff;white-space:nowrap;
  font-family:inherit;font-size:12px;font-weight:600;line-height:1.25;
  padding:6px 10px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.28);
  animation:bili-tip-in .12s ease-out}
@keyframes bili-tip-in{
  from{opacity:0;transform:translate(-50%,calc(-100% + 4px))}
  to{opacity:1;transform:translate(-50%,-100%)}
}/* 粘贴后的角落提示条 */
.bili-toast{position:fixed;right:26px;bottom:104px;z-index:2147483000;display:flex;align-items:center;gap:10px;
  max-width:330px;padding:11px 13px;border-radius:13px;cursor:pointer;
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#17233a);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  box-shadow:0 12px 32px rgba(16,32,66,.16),0 2px 6px rgba(16,32,66,.08);
  font-size:13px;line-height:1.35;user-select:none}
.bili-toast:hover{border-color:var(--dsw-alias-button-info-fill,#2b6cf0)}
.bili-toast-ic{width:26px;height:26px;border-radius:8px;flex:none;display:grid;place-items:center;
  background:var(--dsw-alias-button-info-fill,#2b6cf0);color:#fff;font-size:14px}
.bili-toast-tx{display:flex;flex-direction:column;gap:1px;min-width:0}
.bili-toast-tx b{font-weight:600;font-size:13px}
.bili-toast-tx span{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7788)}
.bili-toast-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8c97a6);
  font-size:13px;padding:2px 4px;cursor:pointer;border-radius:6px}
.bili-toast-x:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}

/* 图文笔记的图片网格 */
.bili-plats{display:flex;flex-wrap:wrap;align-items:center;gap:5px;justify-content:center;max-width:320px;margin-top:2px}
.bili-plat{font-size:11px;padding:1px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));
  color:var(--dsw-alias-label-secondary,inherit)}
.bili-imgs{display:flex;flex-wrap:wrap;gap:6px}
.bili-img{width:56px;height:56px;border-radius:7px;object-fit:cover;cursor:pointer;
  opacity:.45;border:2px solid transparent;background:var(--dsw-alias-bg-layer-2,#eee);
  transition:opacity .12s ease,border-color .12s ease}
.bili-img:hover{opacity:.8}
.bili-img[data-on="1"]{opacity:1;border-color:var(--dsw-alias-button-info-fill,#14d0d0)}
.bili-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b6b6b);line-height:1.6}
.bili-empty{display:flex;flex-direction:column;align-items:center;gap:9px;padding:26px 10px;text-align:center;
  color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:12px}
`;

    function useStore(store) {
      const [snap, setSnap] = React.useState(store.get());
      React.useEffect(() => store.subscribe(() => setSnap(store.get())), [store]);
      return snap;
    }

    /* ───────────────────────────── 选择器 ───────────────────────────── */

    function Panel({ store }) {
      const s = useStore(store);

      React.useEffect(() => {
        if (!s.open) return undefined;
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          if (s.settingsOpen) store.set({ settingsOpen: false });
          else store.set({ open: false });
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [s.open, s.settingsOpen, store]);

      if (!s.open) return null;

      const { info, pick, job } = s;
      const videos = info?.videos || [];
      const audios = info?.audios || [];
      const running = job?.status === 'running';
      const finished = job && job.status !== 'running';

      const pickVideo = (qn) => store.patchPick({ videoQn: pick.videoQn === qn ? null : qn });

      /* ── 登录板块 ── */
      /* 只有这些平台的解析需要登录态；小红书/抖音都能匿名取到内容，故不列出 */
      const PLATFORM_TABS = [['youtube', 'YouTube'], ['twitter', 'X'], ['tiktok', 'TikTok']];



/* B 站图标：用户提供的素材，已抠掉白底并压到 64px */
      const BILI_ICON = 'data:image/png;base64,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';

            /* 平台图标：自己画的简化几何形（不复制官方素材），缩到 16px 还能认出来 */
      const ICON_PATHS = {
        bili: () => [
          h('image', { x: 0, y: 0, width: 24, height: 24, href: BILI_ICON, preserveAspectRatio: 'xMidYMid meet' }),
        ],
        youtube: (c) => [
          h('path', {
            fill: '#FF0033',
            fillRule: 'evenodd',
            d: 'M6.6 5h10.8A4.6 4.6 0 0 1 22 9.6v4.8a4.6 4.6 0 0 1-4.6 4.6H6.6A4.6 4.6 0 0 1 2 14.4V9.6A4.6 4.6 0 0 1 6.6 5Z M10 8.6 16 12 10 15.4Z',
          }),
        ],
        twitter: (c) => [
          h('path', { d: 'M3.6 3.2h4.3l4.1 5.6 4.8-5.6h3.6l-6.6 7.6 7 9.8h-4.3l-4.6-6.3-5.4 6.3H2.9l7.1-8.3z', fill: c }),
        ],
        douyin: (c) => [
          h('path', { d: 'M14 15.3V3.6c0 2.7 1.9 4.5 4.4 4.8', stroke: '#25F4EE', strokeWidth: 3, fill: 'none', strokeLinecap: 'round', transform: 'translate(-0.55,-0.35)' }),
          h('path', { d: 'M14 15.3V3.6c0 2.7 1.9 4.5 4.4 4.8', stroke: '#FE2C55', strokeWidth: 3, fill: 'none', strokeLinecap: 'round', transform: 'translate(0.55,0.35)' }),
          h('path', { d: 'M14 15.3V3.6c0 2.7 1.9 4.5 4.4 4.8', stroke: '#fff', strokeWidth: 3, fill: 'none', strokeLinecap: 'round' }),
          h('circle', { cx: 10.2, cy: 15.3, r: 3.7, fill: 'none', stroke: '#25F4EE', strokeWidth: 3, transform: 'translate(-0.55,-0.35)' }),
          h('circle', { cx: 10.2, cy: 15.3, r: 3.7, fill: 'none', stroke: '#FE2C55', strokeWidth: 3, transform: 'translate(0.55,0.35)' }),
          h('circle', { cx: 10.2, cy: 15.3, r: 3.7, fill: 'none', stroke: '#fff', strokeWidth: 3 }),
        ],
        tiktok: (c) => [
          h('path', { d: 'M14.3 15.3V3.6c0 2.7 1.9 4.5 4.4 4.8', stroke: c, strokeWidth: 3, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('circle', { cx: 10.5, cy: 15.3, r: 3.7, fill: 'none', stroke: c, strokeWidth: 3 }),
        ],
      };

      const iconOf = (key, label, color) => h('svg', {
        width: 15, height: 15, viewBox: '0 0 24 24', 'aria-hidden': false, role: 'img',
      }, h('title', { key: 't' }, label), ...ICON_PATHS[key](color));

      /* 折叠栏只放平台图标：亮=已登录，暗=未登录；名字放 title 里，不占位置 */
      const chipSpecs = [
        ['bili', 'B 站', Boolean(s.login?.login), s.login?.uname ? `B 站 ${s.login.uname}` : 'B 站 未登录'],
        ...PLATFORM_TABS.map(([key, label]) => [
          key, label, Boolean(s.logins?.[key]),
          s.logins?.[key]
            ? `${label} 已登录${s.names?.[key] ? ' · ' + s.names[key] : ''}`
            : `${label} 未登录`,
        ]),
      ];
      const anyLogin = chipSpecs.some((c) => c[2]);
      const loginChips = h('span', { className: 'bili-chips' },
        chipSpecs.map(([key, label, on, tip]) => h('span', {
          key, 'data-on': on ? '1' : '0', title: tip, className: 'bili-chip',
        }, iconOf(key, label, 'currentColor'))));

      const tabBtn = (id, label) => h('div', {
        className: 'bili-tab', key: id, 'data-on': s.loginTab === id ? '1' : '0',
        role: 'tab', 'aria-selected': s.loginTab === id,
        onClick: () => store.set({ loginTab: id }),
      }, label);

      const renderBiliTab = () => {
        if (s.login?.login) {
          return h('div', { className: 'bili-row', key: 'done' }, [
            h('span', { className: 'bili-ok', key: 'o' }, '✓'),
            h('span', { key: 'n' }, `${s.login.uname}${s.login.vip ? '（大会员）' : ''} · 高清画质已解锁`),
            h('button', { className: 'bili-lnk', key: 'x', style: { marginLeft: 'auto' }, onClick: () => store.logout() }, '退出'),
          ]);
        }
        if (s.loginOpen) {
          return h('div', { className: 'bili-row', key: 'paste' }, [
            h('input', {
              className: 'bili-input', key: 'i', spellCheck: false, autoFocus: true,
              placeholder: '粘贴 SESSDATA 后回车',
              value: s.cookieDraft,
              onChange: (e) => store.set({ cookieDraft: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter') store.saveCookie(); },
            }),
            h('button', { className: 'bili-btn bili-btn-primary', key: 's', onClick: () => store.saveCookie() }, '登录'),
            h('button', { className: 'bili-btn', key: 'c', onClick: () => store.set({ loginOpen: false }) }, '取消'),
          ]);
        }
        return h('div', { className: 'bili-row', key: 'act' }, [
          h('span', { className: 'bili-warn', key: 'w' }, '⚠'),
          h('span', { key: 't' }, '未登录 · 最高只有 480P'),
          h('button', {
            className: 'bili-lnk', key: 'q', style: { marginLeft: 'auto' },
            disabled: s.qrBusy, onClick: () => store.startQr(),
          }, s.qrBusy ? '生成中…' : '扫码登录'),
          h('button', {
            className: 'bili-lnk', key: 'l', style: { marginLeft: 12 },
            onClick: () => store.set({ loginOpen: true }),
          }, '粘 Cookie'),
        ]);
      };

      /* 每个站点独立一屏：只处理它自己的登录 */
      const renderSiteTab = (key) => {
        /* 不登录会缺什么——按平台说清楚，别只说「要登录」 */
      const LOGIN_NEED = {
        bili: '不登录：最高只给 480P，大会员清晰度、部分版权番剧拿不到。',
        youtube: '不登录：会员专享、年龄限制视频拿不到，部分视频会被压低画质。',
        twitter: '不登录：受保护账号、敏感内容、长视频拿不到，多数只给低码率预览。',
        tiktok: '不登录：部分视频不给播放地址，能拿到的也常是带水印的低码率版本。',
      };

      const label = (PLATFORM_TABS.find(([k]) => k === key) || [null, key])[1];
        const sess = s.loginSession || { state: 'idle' };
        const running = sess.state === 'starting' || sess.state === 'waiting';
        const liveHere = running && sess.platform === key;
        const logged = Boolean(s.logins?.[key]);

        if (s.ckOpen) {
          return h('div', { key: 'paste', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
            h('textarea', {
              className: 'bili-input', key: 't', rows: 4, spellCheck: false,
              style: { height: 'auto', padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit' },
              placeholder: '粘贴 cookies.txt 全文（# Netscape HTTP Cookie File 开头的那种）',
              value: s.ckText,
              onChange: (e) => store.set({ ckText: e.target.value }),
            }),
            h('div', { className: 'bili-row', key: 'r' }, [
              h('input', {
                className: 'bili-input', key: 'd', spellCheck: false,
                placeholder: '若粘的是 a=1; b=2 这种原始串，这里填域名（如 youtube.com）',
                value: s.ckDomain,
                onChange: (e) => store.set({ ckDomain: e.target.value }),
              }),
              h('button', { className: 'bili-btn bili-btn-primary', key: 's', disabled: s.busy, onClick: () => store.saveCkText() }, '导入'),
              h('button', { className: 'bili-btn', key: 'c', onClick: () => store.set({ ckOpen: false }) }, '取消'),
            ]),
          ]);
        }

        return h('div', { key: 'act', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          liveHere
            ? h('div', { className: 'bili-row', key: 'live' }, [
              h('div', { className: 'bili-spin', key: 'sp' }),
              h('span', { key: 't' }, sess.message || '请在弹出的浏览器窗口里登录'),
              h('button', {
                className: 'bili-btn bili-btn-primary', key: 'f', style: { marginLeft: 'auto' },
                disabled: s.busy, onClick: () => store.finishLogin(),
              }, '我已登录'),
              h('button', { className: 'bili-btn', key: 'c', onClick: () => store.cancelLogin() }, '取消'),
            ])
            : h('div', { className: 'bili-row', key: 'b' }, [
              h('span', {
                className: logged ? 'bili-ok' : 'bili-hint',
                key: 'h', style: { flex: 'none' },
              }, logged ? `\u2713 ${label} 已登录` : `${label} 未登录`),
              h('button', {
                className: logged ? 'bili-btn' : 'bili-btn bili-btn-primary',
                key: 'go', disabled: s.busy || running,
                onClick: () => store.openLogin(key),
              }, logged ? '重新登录' : '打开登录窗口'),
              h('button', {
                className: 'bili-lnk', key: 'p', style: { marginLeft: 'auto' },
                onClick: () => store.set({ ckOpen: true }),
              }, '粘贴 cookies.txt'),
            ]),
          h('div', { className: 'bili-hint', key: 'n' }, liveHere
            ? '登录完成后会自动保存；也可以在里面登完就点「我已登录」。'
            : LOGIN_NEED[key] || `${label}：不登录通常拿不到完整内容或最高画质。`),
        ]);
      };


      const progressOf = (item) => {
        const parts = item.parts.filter((p) => p.total > 0);
        if (!parts.length) return null;
        const got = parts.reduce((a, p) => a + p.received, 0);
        const total = parts.reduce((a, p) => a + p.total, 0);
        return { pct: Math.min(100, Math.round((got / total) * 100)), got, total };
      };

      return h('div', {
        className: 'bili-backdrop',
        onMouseDown: (e) => { if (e.target === e.currentTarget) store.set({ open: false }); },
      }, h('div', { className: 'bili-card', role: 'dialog', 'aria-label': '媒体下载' }, [
        h('div', { className: 'bili-head', key: 'head' }, [
          h('span', { className: 'bili-title', key: 't' }, '媒体下载'),
          h('span', { className: 'bili-tag', key: 'g', title: '版本' }, s.version ? `v${s.version}` : ''),
          h('button', {
            className: 'bili-gear', key: 'set',
            title: '设置下载目录',
            'aria-pressed': s.settingsOpen,
            onClick: () => (s.settingsOpen ? store.set({ settingsOpen: false }) : store.openSettings()),
          }, h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('circle', { cx: 12, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
            h('path', {
              d: 'M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
              stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
            }))),
          h('button', { className: 'bili-x', key: 'x', title: '关闭 (Esc)', onClick: () => store.set({ open: false }) }, '✕'),
        ]),

        h('div', { className: 'bili-body', key: 'body' }, [
          /* 设置：下载目录 */
          s.settingsOpen ? h('div', { className: 'bili-sec', key: 'settings' }, [
            h('div', { className: 'bili-sec-h' }, [
              h('span', { key: 'a' }, '设置 · 下载目录'),
              h('small', { key: 'b' }, s.ffmpeg ? 'ffmpeg 已就绪' : '未找到 ffmpeg'),
            ]),
            h('div', { className: 'bili-sec-b' }, [
              h('div', { className: 'bili-row' }, [
                h('input', {
                  className: 'bili-input', key: 'i', spellCheck: false, autoFocus: true,
                  placeholder: '例如 D:\\视频\\B站',
                  value: s.dirDraft,
                  onChange: (e) => store.set({ dirDraft: e.target.value }),
                  onKeyDown: (e) => { if (e.key === 'Enter' && s.dirDraft.trim()) store.setOutDir(s.dirDraft); },
                }),
                h('button', {
                  className: 'bili-btn', key: 'b', disabled: s.busy,
                  onClick: () => store.browseDir(),
                }, s.busy ? '…' : '选择…'),
              ]),
              h('div', { className: 'bili-row' }, [
                h('input', {
                  className: 'bili-input', key: 'p', spellCheck: false,
                  placeholder: s.proxyDetected ? `留空 = 跟随系统代理（${s.proxyDetected}）` : '代理地址，如 http://127.0.0.1:7897（可留空）',
                  value: s.proxyDraft,
                  onChange: (e) => store.set({ proxyDraft: e.target.value }),
                }),
              ]),
              h('div', { className: 'bili-row' }, [
                h('label', { className: 'bili-chk', key: 'ct' }, [
                  h('input', {
                    type: 'checkbox', key: 'i',
                    checked: s.copyToast !== false,
                    onChange: (e) => store.setCopyToast(e.target.checked),
                  }),
                  h('span', { key: 's' }, '复制链接时在屏幕角落提示'),
                ]),
                h('span', { className: 'bili-hint', key: 'cth', style: { flex: 1 } }, '关掉后复制不再弹窗'),
              ]),
              h('div', { className: 'bili-row' }, [
                h('span', {
                  className: 'bili-hint', key: 'h', style: { flex: 1 },
                }, '所有文件都保存到这一个目录，目录不存在会自动创建。代理只用于 B 站以外的站点。'),
                h('button', { className: 'bili-btn', key: 'c', onClick: () => store.set({ settingsOpen: false }) }, '取消'),
                h('button', {
                  className: 'bili-btn bili-btn-primary', key: 's',
                  disabled: !s.dirDraft.trim() || s.busy,
                  onClick: () => store.setOutDir(s.dirDraft, s.proxyDraft),
                }, '保存'),
              ]),
            ]),
          ]) : null,
          /* 地址栏 */
          h('div', { className: 'bili-row', key: 'url' }, [
            h('input', {
              className: 'bili-input', key: 'i', spellCheck: false,
              placeholder: '粘贴视频链接（B 站 / YouTube / X…），回车解析',
              value: s.url,
              onChange: (e) => store.set({ url: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter') store.probe(); },
            }),
            h('button', {
              className: 'bili-btn bili-btn-primary', key: 'go',
              disabled: s.loading || !s.url.trim(),
              onClick: () => store.probe(),
            }, s.loading ? '解析中…' : '解析'),
          ]),

          /* 登录板块 */
          h('div', { className: 'bili-login', key: 'login' }, [
            h('button', {
              className: 'bili-login-head', key: 'head',
              onClick: () => store.set({ loginPanel: !s.loginPanel }),
            }, [
              h('span', { className: 'bili-login-title', key: 't' }, '登录'),
              anyLogin ? loginChips : h('span', { className: 'bili-login-sum', key: 's' }, '都未登录 · B 站最高 480P'),
              h('span', { className: 'bili-caret', key: 'c' }, s.loginPanel ? '▴' : '▾'),
            ]),

            s.loginPanel ? h('div', { className: 'bili-login-body', key: 'body' }, [
              h('div', { className: 'bili-tabs', key: 'tabs' }, [
                tabBtn('bili', (s.logins?.bilibili || s.login?.login ? '✓ ' : '') + 'B 站'),
                ...PLATFORM_TABS.map(([id, label]) => tabBtn(id, (s.logins?.[id] ? '✓ ' : '') + label)),
              ]),
              s.loginTab === 'bili' ? renderBiliTab() : renderSiteTab(s.loginTab),
            ]) : null,
          ]),

          /* 扫码登录 */
          s.qr ? h('div', { className: 'bili-qr', key: 'qr' }, [
            h('div', {
              className: 'bili-qr-box', key: 'b',
              dangerouslySetInnerHTML: { __html: s.qr.svg },
            }),
            h('div', { className: 'bili-qr-side', key: 's' }, [
              h('div', { className: 'bili-qr-state', key: 'st' }, {
                waiting: '等待扫码…',
                scanned: '已扫码，请在手机上点「确认登录」',
                expired: '二维码已失效',
                unknown: s.qr.message || '状态未知',
              }[s.qr.state] || s.qr.message || '等待扫码…'),
              h('div', { className: 'bili-hint', key: 'h' },
                s.qr.state === 'expired'
                  ? '二维码有效期约 3 分钟，点下面刷新重新出码。'
                  : '打开手机 B 站 App，点右上角「扫一扫」。扫码登录不需要任何验证码。'),
              h('div', { className: 'bili-row', key: 'r' }, [
                h('button', { className: 'bili-btn', key: 're', onClick: () => store.startQr() }, '刷新二维码'),
                h('button', { className: 'bili-btn', key: 'x', onClick: () => store.cancelQr() }, '取消'),
              ]),
            ]),
          ]) : null,

          s.error ? h('div', { className: 'bili-err', key: 'err' }, s.error) : null,

          !info && !s.loading ? h('div', { className: 'bili-empty', key: 'empty' }, [
            h('div', { key: 'a', style: { fontSize: 22 } }, '⬇'),
            h('div', { key: 'b' }, '把视频链接粘到上面的输入框，回车即可解析。'),
            h('div', { key: 'c', className: 'bili-hint' }, '复制到支持的链接时，右下角会先提示，点一下才打开。'),
            h('div', { key: 'p', className: 'bili-hint bili-plats' }, [
              h('span', { key: 'l', className: 'bili-hint' }, '支持：'),
              h('span', { key: 'b', className: 'bili-plat' }, 'B 站'),
              h('span', { key: 'dy', className: 'bili-plat' }, '抖音'),
              h('span', { key: 'xhs', className: 'bili-plat' }, '小红书'),
              h('span', { key: 'yt', className: 'bili-plat' }, 'YouTube'),
              h('span', { key: 'x', className: 'bili-plat' }, 'X'),
              h('span', { key: 'tk', className: 'bili-plat' }, 'TikTok'),
              h('span', { key: 'vm', className: 'bili-plat' }, 'Vimeo'),
              h('span', { key: 'more', className: 'bili-hint' }, '及 yt-dlp 能解析的其它站点'),
            ]),
            h('div', { key: 'nl', className: 'bili-hint' }, 'B 站、YouTube、X、TikTok 需登录才能拿最高画质；抖音和小红书免登录即可。'),
          ]) : null,

          info ? h('div', { className: 'bili-meta', key: 'meta' }, [
            h('img', { className: 'bili-cover', key: 'cv', src: img(info.cover), alt: '封面' }),
            h('div', { className: 'bili-meta-txt', key: 'mt' }, [
              h('div', { className: 'bili-vtitle', key: 'vt', title: info.title },
                info.title + (info.partTitle ? ` · ${info.partTitle}` : '')),
              h('div', { className: 'bili-sub', key: 'sb' }, [
                info.up.face ? h('img', { className: 'bili-face', key: 'f', src: img(info.up.face), alt: '' }) : null,
                h('span', { key: 'u' }, info.up.name),
                h('span', { key: 'd' }, fmtDur(info.duration)),
                info.pageCount > 1 ? h('span', { key: 'p' }, `P${info.page} / ${info.pageCount}`) : null,
                h('span', { key: 'b' }, info.bvid),
              ]),
            ]),
          ]) : null,

          /* 视频画质 */
          info ? h('div', { className: 'bili-sec', key: 'v' }, [
            h('div', { className: 'bili-sec-h' }, [
              h('span', { key: 'a' }, '视频'),
              h('small', { key: 'b' }, pick.videoQn ? '点一下取消' : '未选择 = 只要音频/图'),
            ]),
            h('div', { className: 'bili-sec-b' }, [
              videos.length
                ? h('div', { className: 'bili-opts' }, videos.map((v) => h('div', {
                  key: String(v.qn),
                  className: 'bili-opt',
                  role: 'radio',
                  'aria-checked': pick.videoQn === v.qn,
                  'data-on': pick.videoQn === v.qn ? '1' : '0',
                  'data-vip': v.vip ? '1' : '0',
                  title: `${v.height}P · ${v.codec} · ${Math.round(v.bandwidth / 1000)} kbps`,
                  onClick: () => pickVideo(v.qn),
                }, `${v.label} · ${v.codec}`)))
                : h('div', { className: 'bili-hint' }, {
                  bilibili: '该链接没有可下载的 DASH 画质流。',
                  xhs: info.noteType === 'video' ? '这个笔记没有取到视频流。' : '这是图文笔记，用上面的「图片」区下载。',
                  douyin: '这个作品没有视频流（图文作品请用图片区）。',
                  ytdlp: '该链接没有可下载的视频流。',
                }[info.source] || '该链接没有可下载的视频流。'),
            ]),
          ]) : null,

          /* 图片（图文笔记） */
          info && info.images && info.images.length ? h('div', { className: 'bili-sec', key: 'imgs' }, [
            h('div', { className: 'bili-sec-h' }, [
              h('span', { key: 'a' }, `图片 · ${info.images.length} 张`),
              h('button', {
                className: 'bili-lnk', key: 'all', style: { marginLeft: 'auto' },
                onClick: () => store.patchPick({ imageIds: info.images.map((i) => i.id) }),
              }, '全选'),
              h('button', {
                className: 'bili-lnk', key: 'none', style: { marginLeft: 10 },
                onClick: () => store.patchPick({ imageIds: [] }),
              }, '清空'),
            ]),
            h('div', { className: 'bili-sec-b' }, [
              h('div', { className: 'bili-imgs' }, info.images.map((c) => h('img', {
                key: c.id, src: img(c.url), alt: c.label, title: c.label,
                className: 'bili-img',
                'data-on': (pick.imageIds || []).includes(c.id) ? '1' : '0',
                onClick: () => {
                  const cur = pick.imageIds || [];
                  store.patchPick({
                    imageIds: cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id],
                  });
                },
              }))),
            ]),
          ]) : null,

          /* 音频 */
          info ? h('div', { className: 'bili-sec', key: 'a' }, [
            h('div', { className: 'bili-sec-h' }, [
              h('span', { key: 'a' }, '音频'),
              h('small', { key: 'b' }, pick.videoQn ? '视频自带音轨' : '勾选 = 只要音频'),
            ]),
            h('div', { className: 'bili-sec-b' }, [
              h('div', { className: 'bili-row' }, [
                h('label', { className: 'bili-chk', key: 'c' }, [
                  h('input', {
                    type: 'checkbox', key: 'i',
                    /* 有视频时音轨恒合流，这个框降级成「只下音频」的开关 */
                    checked: Boolean(pick.audio) && audios.length > 0,
                    disabled: !audios.length,
                    onChange: (e) => store.patchPick({ audio: e.target.checked }),
                  }),
                  h('span', { key: 's' },
                    !audios.length ? '无独立音轨' : pick.videoQn ? '下载为额外音频文件' : '只下载音频'),
                ]),
                audios.length ? h('select', {
                  className: 'bili-sel', key: 'sel', value: pick.audioId ?? '',
                  disabled: !audios.length,
                  title: pick.videoQn ? '合流进视频的音轨' : '要保存的音轨',
                  onChange: (e) => store.patchPick({ audioId: Number(e.target.value) }),
                }, audios.map((a) => h('option', { key: String(a.id), value: a.id },
                  `${a.label}${a.vip ? ' (VIP)' : ''}${a.kbps ? ` · ${a.kbps}kbps` : ''}`))) : null,
                !pick.videoQn && audios.length ? h('label', { className: 'bili-chk', key: 'mp3' }, [
                  h('input', {
                    type: 'checkbox', key: 'i', checked: Boolean(pick.audioMp3),
                    disabled: !pick.audio || !s.ffmpeg,
                    onChange: (e) => store.patchPick({ audioMp3: e.target.checked }),
                  }),
                  h('span', { key: 's' }, s.ffmpeg ? '转成 MP3' : 'MP3（缺 ffmpeg）'),
                ]) : null,
              ]),
            ]),
          ]) : null,

          /* 封面 / 头像 */
          info ? h('div', { className: 'bili-sec', key: 'e' }, [
            h('div', { className: 'bili-sec-h' }, [
              h('span', { key: 'a' }, '封面 / 头像'),
              h('small', { key: 'b' }, (pick.coverIds || []).length
                ? '点一下取消'
                : (pick.avatar ? '未选封面 = 只下头像' : '未选择 = 不下载')),
            ]),
            h('div', { className: 'bili-sec-b' }, [
              h('div', { className: 'bili-row', style: { gap: 18 } }, [
                h('div', { key: 'cv', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                  (info.covers && info.covers.length
                    ? info.covers.map((c) => h(CoverChip, {
                      key: c.id, cover: c,
                      on: (pick.coverIds || []).includes(c.id),
                      onToggle: () => {
                        const cur = pick.coverIds || [];
                        store.patchPick({
                          coverIds: cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id],
                        });
                      },
                    }))
                    : [h('span', { className: 'bili-hint', key: 'none' }, '无封面')])),
                h('label', { className: 'bili-chk', key: 'av' }, [
                  h('input', {
                    type: 'checkbox', key: 'i', checked: pick.avatar,
                    onChange: (e) => store.patchPick({ avatar: e.target.checked }),
                  }),
                  h('span', { key: 's' }, `下载 作者头像（${info.up.name}）`),
                ]),
              ]),
            ]),
          ]) : null,

          /* 进度 */
          job ? h('div', { className: 'bili-job', key: 'job' }, [
            h('div', { className: 'bili-item-top', key: 'h' }, [
              running ? h('div', { className: 'bili-spin', key: 's' }) : null,
              h('b', { key: 't' }, running ? '正在下载' : job.status === 'done' ? '已全部完成' : job.status === 'canceled' ? '已取消' : '下载失败'),
              h('span', { className: 'bili-pct', key: 'p' }, job.error || ''),
            ]),
            ...job.items.map((item, i) => {
              const pr = progressOf(item);
              return h('div', { className: 'bili-item', key: `i${i}` }, [
                h('div', { className: 'bili-item-top', key: 't' }, [
                  h('b', { key: 'l' }, item.label),
                  h('span', { className: 'bili-pct', key: 'p' },
                    item.status === 'muxing' ? '合流中…'
                      : item.status === 'done' ? (pr ? `${pr.pct}%` : '✓')
                        : item.status === 'error' ? '✗'
                          : pr ? `${pr.pct}%` : '…'),
                ]),
                item.status === 'working' || item.status === 'muxing'
                  ? h('div', { className: 'bili-bar', key: 'b' }, h('i', { style: { width: `${pr?.pct || 0}%` } }))
                  : null,
                item.file ? h('div', { className: 'bili-file', key: 'f' }, item.file) : null,
                item.error ? h('div', { className: 'bili-file', key: 'e', style: { color: 'var(--dsw-alias-state-error-primary,#d33)' } }, item.error) : null,
              ]);
            }),
          ]) : null,
        ]),

        h('div', { className: 'bili-foot', key: 'foot' }, [
          h('div', {
            className: 'bili-dir', key: 'dir',
            title: s.outDir + '\n（点击进入设置，修改下载目录）',
            onClick: () => store.openSettings(),
          }, '📁 ' + (s.outDir || '~/Downloads/Bilibili')),
          finished ? h('button', {
            className: 'bili-btn', key: 'open',
            onClick: () => store.reveal(job.items.find((i) => i.file)?.file || job.dir),
          }, '打开文件夹') : null,
          running ? h('button', { className: 'bili-btn', key: 'stop', onClick: () => store.cancel() }, '取消') : null,
          h('button', {
            className: 'bili-btn bili-btn-primary', key: 'dl',
            disabled: !info || running || s.busy,
            onClick: () => store.start(),
          }, running ? '下载中…' : '开始下载'),
        ]),
      ]));
    }


    /**
     * 样式必须常驻：只挂在 Panel 里的话，面板没打开过时整份 CSS 就不存在，
     * 输入框旁那个按钮会退回浏览器默认样式（方块）。
     */
    /** 角落提示条：页面任意位置粘到链接时出现，点了才打开面板 */
    function PasteToast({ store }) {
      const s = useStore(store);
      const t = s.pasteToast;
      if (!t || s.open) return null;
      return h('div', {
        className: 'bili-toast', role: 'status', title: '点击打开媒体下载',
        onClick: () => store.open(t.url),
      }, [
        h('span', { className: 'bili-toast-ic', key: 'i' }, '⬇'),
        h('span', { className: 'bili-toast-tx', key: 't' }, [
          h('b', { key: 'a' }, '检测到视频链接'),
          h('span', { key: 'b' }, '点击打开媒体下载'),
        ]),
        h('button', {
          className: 'bili-toast-x', key: 'x', title: '关闭',
          onClick: (e) => { e.stopPropagation(); store.dismissPaste(); },
        }, '✕'),
      ]);
    }

    function Root({ store }) {
      return h(React.Fragment, null,
        h('style', { key: 'bili-css' }, CSS),
        h(Panel, { store }),
        h(PasteToast, { store }),
      );
    }
    /** 一份封面：缩略图 + 实测比例（3:4 / 4:3 / 16:9） */
    function CoverChip({ cover, on, onToggle }) {
      const [ratio, setRatio] = React.useState('');
      return h('div', {
        className: 'bili-opt', 'data-on': on ? '1' : '0',
        role: 'checkbox', 'aria-checked': Boolean(on),
        title: '点一下切换是否下载这份封面',
        onClick: onToggle,
        style: { paddingLeft: 6, gap: 7 },
      }, [
        h('img', {
          key: 'img', src: img(cover.url), alt: '', width: 20, height: 20,
          style: { borderRadius: 4, objectFit: 'cover', background: 'rgba(0,0,0,.15)' },
          onLoad: (e) => {
            const el = e.currentTarget;
            const r = el.naturalWidth / el.naturalHeight;
            const near = (v) => Math.abs(r - v) < 0.06;
            setRatio(near(0.75) ? '3:4' : near(1.333) ? '4:3' : near(1.777) ? '16:9' : r.toFixed(2));
          },
        }),
        h('span', { key: 't' }, `${cover.label}${ratio ? ` · ${ratio}` : ''}`),
      ]);
    }

    /* ───────────────────────── 输入框旁的小按钮 ───────────────────────── */

    function Trigger({ store }) {
      const s = useStore(store);
      const [tip, setTip] = React.useState(null);
      const ref = React.useRef(null);
      const timer = React.useRef(null);

      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

      const show = () => {
        const el = ref.current;
        if (!el) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const r = el.getBoundingClientRect();
          setTip({ x: r.left + r.width / 2, y: r.top - 6 });
        }, 400);
      };
      const hide = () => {
        if (timer.current) clearTimeout(timer.current);
        setTip(null);
      };

      if (s.open) return null;

      return h(React.Fragment, null,
        h('button', {
          ref, className: 'bili-trigger', 'aria-label': '媒体下载',
          onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide,
          onClick: () => store.open(),
        }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
            stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          }))),
        /* 宿主那套 tooltip 外观。注意：客户端模块的 React 是受限子集，
           没有 createPortal —— 用 position:fixed 就够，fixed 不会被祖先 overflow 裁掉。 */
        tip ? h('div', { className: 'bili-tip', style: { left: tip.x, top: tip.y } }, '媒体下载') : null,
      );
    }

    /* ───────────────────────────── 插件装配 ───────────────────────────── */

    /* 粘贴检测：覆盖所有原生支持的平台，其余站点交给输入框手动回车 */
    const BILI_RE = /(BV[0-9A-Za-z]{10})|(av\d{6,})|(bilibili\.com\/video)|(b23\.tv)|(xiaohongshu\.com|xhslink\.(?:com|cn))|(douyin\.com)|youtube\.com|youtu\.be|(?:^|\/\/)x\.com|tiktok\.com|vimeo\.com/i;

    return {
      inject: ['slots'],
      apply(ctx) {
        const store = createStore();

        ctx.effect(() => {
          store.boot();
          store.watchPending();
  store.pushTheme();
          /* 复制到支持的链接 → 角落提示；粘贴不再触发 */
          const handleCopyText = (text) => {
            const raw = String(text || '');
            if (!BILI_RE.test(raw)) return;
            if (store.get().copyToast === false) return;
            const hit = raw.match(/https?:\/\/[^\s"'<>]+/);
            store.notifyCopy(hit ? hit[0] : raw.trim());
          };
          const onCopy = (e) => {
            /* 有些「复制链接」按钮会把内容写进事件本身 */
            const fromEvent = String(e?.clipboardData?.getData?.('text') || '');
            if (BILI_RE.test(fromEvent)) { handleCopyText(fromEvent); return; }
            /* 其次用当前选区（选中文字后 Ctrl+C 的情形） */
            const selected = String(window.getSelection?.()?.toString() || '');
            if (BILI_RE.test(selected)) { handleCopyText(selected); return; }
            /* 「复制链接」按钮这类没有选区的情况，读一次剪贴板 */
            navigator.clipboard?.readText?.()
              .then((text) => handleCopyText(text))
              .catch(() => {});
          };
          document.addEventListener('copy', onCopy, true);
          return () => {
            document.removeEventListener('copy', onCopy, true);
            store.dispose();
          };
        }, 'media-downloader');

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'media-downloader', order: 60 },
          () => h(Root, { store }),
        ));

        /* 工具行左侧簇：结构是 [+][权限][计划][conversation.input.left]。
           「+」与权限之间没有可注册的 seat，所以落在权限右侧、同一簇内。 */
        try {
          ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
            { name: 'conversation.input.left', id: 'media-downloader', order: 0 },
            () => h(Trigger, { store }),
          ));
        } catch {
          try {
            ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
              { name: 'conversation.input.right', id: 'media-downloader', order: 30 },
              () => h(Trigger, { store }),
            ));
          } catch { /* 两个槽位都不存在时忽略 */ }
        }
      },
    };
  },
});
