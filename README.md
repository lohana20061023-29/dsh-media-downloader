# 媒体下载 · dsh-media

DSH 插件：粘一条链接，弹出选择器，挑你要的东西下载。

B 站、抖音、小红书走**原生解析器**（不依赖 yt-dlp 的站点适配），其余站点交给 yt-dlp。

---

## 支持的东西

| 平台 | 视频 | 图片 | 封面 | 作者头像 | 解析需要登录 |
|---|---|---|---|---|---|
| B 站 | 多画质 / 多编码 | — | 原图 + 16:9 + 4:3 | ✅ | 高清需要（匿名封顶 480P） |
| 抖音 | 无水印 | 图文多张 | ✅ | ✅ | 否 |
| 小红书 | H.264 / H.265 多档 | 图文原图 | ✅ | ✅ | 否 |
| YouTube | 由 yt-dlp 决定 | — | ✅ | ✅ | 会员/年龄限制内容需要 |
| X | 由 yt-dlp 决定 | — | ✅ | ✅ | 受保护账号需要 |
| TikTok | 由 yt-dlp 决定 | — | ✅ | ✅ | 部分视频需要 |
| 其它 | yt-dlp 支持的站点均可 | — | ✅ | — | 视站点而定 |

音频：B 站可单独下（多码率 / 转 MP3）；视频一律自带音轨。

---

## 安装

这是 DSH 插件，不是独立程序。

```bash
# 在 DSH profile 里挂成本地链接
plugin_manager install_bundle target="link:/path/to/this/repo"
```

包名 `@local/dsh-media`，宿主入口 `index.js`，客户端入口 `client.js`。

依赖：

- **ffmpeg** — 合流与转码。优先用 PATH 里的，找不到会回退到内置候选路径。
- **yt-dlp** — 非原生平台。首次使用会自动下载到 `~/.dsh/bili-dl/bin/`。
- 系统代理会被自动识别（Windows「Internet 选项」），也可在面板里改。

---

## 使用

**面板**：点输入框旁的小图标，或直接在页面任意位置粘贴链接（自动弹出）。

**工具调用**（给 Agent 用）：

```json
{ "url": "https://www.bilibili.com/video/BV...", "quality": "1080" }
```

工具名 `media_fetch`，返回落地文件的绝对路径。

---

## 三个原生引擎怎么工作

| 平台 | 入口 | 关键点 |
|---|---|---|
| B 站 | 官方 web API + WBI 签名 | `x/player/wbi/playurl` 取 DASH 流，ffmpeg `-c copy` 合流 |
| 抖音 | 移动端分享页 SSR | `_ROUTER_DATA` → `play_addr`，`/playwm/` 改 `/play/` 去水印；只需匿名 `ttwid` |
| 小红书 | 移动端分享页 SSR | `__INITIAL_STATE__` → `noteData.data.noteData`；靠链接里的 `xsec_token`，不需要登录 |

登录窗口是独立 profile 的浏览器实例，登录态只写进 `~/.dsh/bili-dl/`，不碰日常浏览器的数据。

---

## 已知限制

- **B 站**匿名最高 480P，高清必须登录。
- **小红书**链接必须带 `xsec_token`（App 里「分享 → 复制链接」得到的就有）；只有笔记 ID 时会退回浏览器读取，较慢。
- **抖音**首次解析要签一个匿名 `ttwid`（约 1 秒），之后缓存 7 天。
- 平台改版会让 SSR 字段路径失效，此时会退回 yt-dlp 或直接报错，不会静默返回错误数据。

---

## 合规

仅供个人离线观看/备份使用。请遵守各平台的服务条款与当地法律，不要用于二次分发或商业用途。

本项目不涉及 DRM 绕过，也不破解加密流；仅使用平台公开下发的页面数据与播放地址。

---

## 目录

```
index.js              宿主：路由注册、工具定义、图片代理
client.js             客户端：面板 UI（受限 React 子集）
lib/bili.mjs          B 站：WBI、probe、下载
lib/douyin.mjs        抖音：SSR 解析 + ttwid 签发
lib/xhs.mjs           小红书：移动端 SSR 解析
lib/ytdlp.mjs         yt-dlp 封装
lib/browser-login.mjs 登录窗口（CDP）
lib/qr.mjs            零依赖二维码编码
docs/架构说明.md       模块划分与数据流
```
---

## 许可

[MIT](LICENSE) © 2026 dsh-media contributors

用、改、再分发都可以，保留版权声明即可。