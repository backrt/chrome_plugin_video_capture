# Microsoft Edge Add-ons 提交说明

完整的五语言商店文案、隐私政策、审核说明、Logo、宣传图和截图位于
`store-assets/edge/`。

## 生成提交包

```bash
npm run check
npm run build:edge
```

提交包生成在 `dist/video-recorder-edge-<version>.zip`。构建脚本采用运行文件白名单，不会包含源码仓库元数据、测试、开发文档或 npm 配置；同时会拒绝 Manifest V2、`update_url` 和 HTML 远程脚本。

## Edge 侧载验收

1. 打开 `edge://extensions` 并启用“开发人员模式”。
2. 点击“加载解压缩的扩展”，选择项目根目录。
3. 在普通网页中测试开始、暂停、拖动、停止和下载流程。
4. 确认停止保存不会改变页面视频的音量、静音状态、倍速或播放位置。
5. 用 Edge 播放下载的 WebM，确认时长正确且进度条可以定位。
6. 检查多 iframe、多视频、页面刷新和受保护媒体的失败提示。

## Partner Center 填写要点

单一用途建议描述：

> 视频录制机只在用户主动点击后，录制当前网页中用户实际播放的 HTML 视频画面，并将结果保存在用户本机。它不补录未观看区间，不绕过 DRM，也不上传录制内容。

权限用途：

- `activeTab`：仅在用户点击录制后访问当前标签页。
- `scripting`：把本地录制代码注入当前页及其中的视频 frame。
- `offscreen`：持续写入本地临时分片、终结 WebM 索引并创建下载 URL。
- `downloads`：把用户生成的视频保存到下载目录。
- `alarms`：在 frame 停止响应时结束等待并返回部分成功或失败结果。
- `storage`：保存录制状态、使用须知确认状态和本地诊断日志。
- `http://*/*`、`https://*/*`：查找当前页及跨域 iframe 内的视频；只在用户主动录制时使用，不用于网络上传。

合规声明建议：

- Manifest V3，无远程代码。
- 视频分片、临时文件和诊断日志只在浏览器本地处理。
- 不提供 DRM 绕过，不自动播放，不补全用户未观看内容。
- 不修改页面视频的音量、静音、倍速或播放位置。
- 用户应只录制自己有权保存的内容。

当前扩展声明了简体中文、繁体中文、英语、日语和韩语。Partner Center 中应为每种商店语言补齐说明、图标和所需截图；正式提交前还需要按实际业务情况完成隐私与数据使用问卷。

## 官方参考

- [将 Chrome 扩展移植到 Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)
- [Microsoft Edge 支持的扩展 API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)
- [发布 Microsoft Edge 扩展](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
