# 视频录制机

一个无服务器、无运行时第三方依赖的 Firefox Manifest V3 扩展。它使用 `video.captureStream()` / `mozCaptureStream()` 和 `MediaRecorder` 录制当前页面中用户实际播放的 HTML `<video>` 内容，而不是录制整个标签页。

录制数据只在浏览器本地流转：页面录制器生成分片，Content Script 按顺序发送到 Firefox 后台页面，后台页面将分片写入 OPFS，停止后再通过 `browser.downloads` 保存到下载目录。

## 安装

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 开发时可直接选择项目根目录的 `manifest.json`。
4. 也可以先执行 `npm run build:firefox`，再选择 `dist/firefox-unpacked/manifest.json`。
5. 打开包含 HTML `<video>` 的普通网页，点击扩展图标。

最低支持 Firefox 142。该版本同时覆盖主世界脚本注入和 AMO 当前要求的数据收集声明。临时载入只在当前 Firefox 会话有效；普通发行版长期安装需要 Mozilla 签名。

## 支持语言

界面会跟随 Firefox 的显示语言自动切换，当前提供：

- 中文（简体）
- 中文（繁體）
- English
- 日本語
- 한국어

Firefox 无法匹配当前语言时使用简体中文。

## 使用

1. 阅读并接受使用须知。
2. 点击“开始录制”。
3. 正常播放、暂停或拖动页面视频。
4. 点击“停止并保存”。
5. 等待已播放分片拼接、生成可定位索引并下载完成。

插件只保存录制期间实际播放过的内容。暂停期间不会产生有效画面；拖动进度条跳过的区间不会出现在成品中，插件也不会为了录制而自动播放或改变视频位置。

保存结果分为三类：

- `已保存`：所有已启动的 frame 和视频均完成。
- `已部分保存`：至少保存了一个视频，但部分 frame 或视频组失败。
- `保存失败`：没有生成可用输出；Popup 会同时展示最近的调试日志。

## 开发检查

项目只需要 Node.js，不需要安装 npm 依赖：

```bash
npm test
npm run check
npm run build:firefox
```

`npm test` 使用 Node 内置的 `node:test`。`npm run check` 还会检查全部 JavaScript 文件的语法。`npm run build:firefox` 会生成：

- `dist/firefox-unpacked/`：用于 `about:debugging` 临时载入。
- `dist/video-recorder-firefox-<version>.zip`：用于 AMO 校验和提交。

构建过程使用运行文件白名单，把扩展 API 转换为 Firefox 推荐的 `browser.*` Promise 接口，并生成带固定 Gecko ID、最低版本与数据收集声明的专用 manifest。AMO 提审清单见 [`docs/firefox-store-submission.md`](docs/firefox-store-submission.md)。

## 架构

- `popup.js`：操作和状态展示。
- `background.js`：Firefox 后台页面中的录制协调、frame 超时、下载和终态持久化。
- `page-recorder.js`：页面主世界中的媒体捕获和已播放区间跟踪。
- `content.js` / `content-protocol.js`：跨世界桥接、frame ID 命名空间和有序 ACK。
- `offscreen.js` / `offscreen-store.js`：在 Firefox 后台页面内完成 OPFS 写入、WebM 拼接、下载 URL 和清理。
- `webm-concat.js`：录制时建立 Cluster 索引，并在下载前流式补写 WebM 的 `Duration`、`SeekHead` 和 `Cues`。
- `shared.js`：消息协议、状态和纯函数。

## 已知限制

- 不能绕过 DRM、受保护的跨域媒体或浏览器安全限制；结果可能是拒绝录制、黑屏或无声。
- Firefox 128 之前不支持本项目需要的 `scripting` 主世界注入；为满足当前 AMO 数据声明校验，提交包最低版本设为 Firefox 142。
- Firefox 私密浏览模式可能不提供 OPFS，因此不作为支持场景。
- 只录制用户实际播放的区间；暂停或拖动跳过的内容不会被自动补录。
- 停止保存不会自动播放视频，也不会修改播放位置、音量、倍速或静音状态。
- 关闭整个浏览器会中止正在进行的录制；重新启动时会清理未完成的本地临时文件。
- 多分片拼接仅支持 WebM。单分片 MP4 可以保存，多分片 MP4 会明确报错。
- WebM 停止后需要经过一次无重编码的终结处理；耗时取决于文件大小，处理期间会保留一份 OPFS 临时输出。

## 手工验收清单

- [ ] 单个普通视频能开始、停止并下载。
- [ ] 视频暂停超过 30 秒后继续录制，停止时已有内容不丢失。
- [ ] 前后拖动进度条后生成的文件时间顺序正确。
- [ ] 同一 frame 中两个视频分别保存。
- [ ] 两个 iframe 使用相同局部 ID 时仍分别保存。
- [ ] 停止期间移除 iframe，其余内容能以“部分保存”完成。
- [ ] 录制期间动态插入的视频能被捕获。
- [ ] 拖动跳过的区间不会出现在成品中。
- [ ] 停止保存不会改变页面视频的位置、音量、倍速或静音状态。
- [ ] 下载的 WebM 能显示正确时长，并能在 Firefox 和 VLC 中拖动进度条定位。
- [ ] DRM/受保护媒体给出明确失败或部分失败提示。
- [ ] 连续执行多次多分片录制后，OPFS 中不残留 `recording-*` 或 `merged-*` 文件。

## 故障排查

若结果为“部分保存”或“保存失败”，重新打开 Popup 可以查看保留的终态和最近日志。常见错误包括：

- `FRAME_TIMEOUT`：frame 在停止阶段长时间没有进度或完成消息。
- `FRAME_UNREACHABLE`：iframe 已导航或被移除。
- `GROUP_SAVE_FAILED`：拼接、创建下载 URL 或下载任务失败。
- `SMALL_FILE`：一个视频组的全部录制内容合计仍小于最小有效文件阈值。

录制内容和日志均不会上传到远程服务。
