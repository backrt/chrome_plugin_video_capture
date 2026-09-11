# Firefox Add-ons（AMO）提交说明

## 构建与校验

```bash
npm run check
npm run build:firefox
npx web-ext lint --source-dir dist/firefox-unpacked
```

提交文件为 `dist/video-recorder-firefox-<version>.zip`。ZIP 根目录直接包含 `manifest.json`，且只包含运行时需要的脚本、图标和本地化资源。

Firefox 正式版与 Beta 版要求扩展经过 Mozilla 签名。当前 Manifest V3 专用清单已经设置固定 ID：`video-recorder@backrt.github.io`。首发前应确认该 ID 将作为此产品的长期稳定标识，后续版本不要更换。

## 本地侧载验收

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”，选择项目根目录的 `manifest.json`，或构建后的 `dist/firefox-unpacked/manifest.json`。
3. 在普通 HTTP/HTTPS 页面测试开始、暂停、拖动、停止和下载。
4. 确认停止保存不会改变视频音量、静音状态、倍速或播放位置。
5. 用 Firefox 播放下载的 WebM，确认时长正确并能拖动进度条。
6. 测试多个视频、跨域 iframe、页面刷新、标签页关闭和受保护媒体提示。

## AMO 权限说明

- `activeTab`：仅在用户主动点击录制后访问当前标签页。
- `scripting`：在当前页及视频 iframe 中注入本地录制代码；`MAIN` 执行环境从 Firefox 128 起可用，提交包最低版本设为 142，以兼容 AMO 当前的数据声明机制。
- `downloads`：将用户生成的视频保存到本机下载目录。
- `alarms`：frame 停止响应时结束等待，避免保存流程永久挂起。
- `storage`：保存录制状态、使用须知确认状态和本地诊断日志。
- `http://*/*`、`https://*/*`：识别当前页和跨域 iframe 中的视频，仅在用户主动录制时使用。

## 隐私与审核说明

Firefox manifest 声明 `data_collection_permissions.required: ["none"]`：

- 视频数据、OPFS 临时文件和诊断日志只在扩展与本地浏览器内处理。
- 不上传页面 URL、视频、日志、标识符、分析数据或遥测数据。
- 不加载远程代码。
- 不绕过 DRM，不自动播放，不补全未观看区段。
- 不修改页面视频的音量、静音状态、倍速或播放位置。
- 用户应只录制自己有权保存的内容。

建议在 AMO Reviewer Notes 中说明：Firefox 不提供 Chrome Offscreen API，因此录制存储处理器与协调器运行在同一个非持久后台页面中；录制期间 Content Script 通过 `runtime.Port` 保持后台页面存活，停止完成后立即断开。

## 官方参考

- [Firefox Manifest V3 后台脚本](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [跨浏览器扩展开发](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension)
- [Firefox 128 主世界脚本支持](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/128)
- [Firefox 数据收集权限声明](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [打包 Firefox 扩展](https://extensionworkshop.com/documentation/publish/package-your-extension/)
- [提交附加组件](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
