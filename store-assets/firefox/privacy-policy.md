# Video Recorder Privacy Policy

Effective date: September 11, 2026

Publisher: backrt

Video Recorder is designed to process recordings locally in Mozilla Firefox. The extension does not operate a backend service and does not send recorded content or usage information to the publisher or third parties.

## Information processed locally

When the user explicitly starts a recording, the extension processes video and audio currently played by HTML media elements in the selected tab. It may process the page title to create a local filename. Recorded chunks and temporary WebM files are stored in browser-local temporary storage while recording is active or being finalized.

The extension stores current recording state, the user's acknowledgement of the usage notice, and limited diagnostic events and error messages. Diagnostic logs are capped at 100 entries and replaced when a new recording starts.

## Data collection, transmission, and sharing

The extension does not transmit recorded video, audio, page content, URLs, browsing history, diagnostic logs, identifiers, or usage data to the publisher or any third party. It contains no analytics, advertising, tracking, accounts, payments, or cloud synchronization.

The extension declares `data_collection_permissions.required: ["none"]` in its Firefox manifest.

## Storage, retention, and user control

Recorded chunks are retained only in browser-local temporary storage while a recording is processed. The extension attempts to remove temporary recording data after creating the final WebM file or cleaning up a failed task. The finished file is saved to the user's downloads folder and remains under the user's control.

Settings and diagnostics remain in extension-local Firefox storage until replaced, cleared by the user, or removed when the extension is uninstalled. Users can delete downloaded files independently through their operating system.

## Permissions

Video Recorder uses browser permissions only to find video elements after an explicit user request, run packaged recording code, store local temporary chunks, create seekable WebM files, save files to the downloads folder, handle bounded completion timeouts, and retain local settings and diagnostics.

## Protected content and user responsibility

The extension does not retrieve original media files and does not bypass DRM, subscriptions, paywalls, access controls, or website protections. Users should record only content they created, are authorized to save, is in the public domain, or may otherwise lawfully record.

## Children's privacy

Video Recorder is not directed to children and does not knowingly collect personal information from children or other users.

## Changes

This policy may be updated when the extension's functionality or data practices change. The effective date above identifies the latest revision.

## Contact

For privacy questions or support, open an issue at:
<https://github.com/backrt/chrome_plugin_video_capture/issues>

---

# 视频录制机隐私政策

生效日期：2026 年 9 月 11 日

发布者：backrt

视频录制机只在 Mozilla Firefox 本地处理录制数据。本扩展没有后端服务，不会把录制内容或使用信息发送给发布者或任何第三方。

## 本地处理的信息

用户主动开始录制后，本扩展会处理所选标签页中 HTML 媒体元素实际播放的视频和音频，并可能使用页面标题生成本地文件名。录制分片和临时 WebM 文件只会在录制或终结处理期间保存在浏览器本地临时存储中。

本扩展还会在本地保存当前录制状态、用户对使用须知的确认，以及有限的诊断事件和错误信息。诊断日志最多保留 100 条，并会在开始新的录制时被替换。

## 数据收集、传输与共享

本扩展不会向发布者或第三方传输录制的视频、音频、页面内容、网址、浏览历史、诊断日志、标识符或使用数据。扩展不包含分析、广告、跟踪、账号、支付或云同步功能。

Firefox 清单明确声明 `data_collection_permissions.required: ["none"]`。

## 存储、保留与用户控制

录制分片只在处理录制任务期间保存在浏览器本地临时存储中。生成最终 WebM 文件或清理失败任务后，扩展会尝试删除临时录制数据。最终文件保存在用户的下载目录中，由用户自行控制。

设置和诊断信息会保留在 Firefox 扩展本地存储中，直到被新数据替换、用户清除或卸载扩展。用户可以通过操作系统自行删除下载文件。

## 权限用途

视频录制机只会为了以下用途使用浏览器权限：在用户主动请求后查找视频元素、运行随扩展打包的录制代码、保存本地临时分片、生成支持进度定位的 WebM 文件、保存到下载目录、处理有时限的录制结束等待，以及保存本地设置和诊断信息。

## 受保护内容与用户责任

本扩展不会获取原始媒体文件，也不会绕过 DRM、订阅、付费墙、访问控制或网站保护。用户应仅录制自己创作、已经获得授权、属于公有领域或法律允许录制的内容。

## 儿童隐私

视频录制机不以儿童为目标用户，也不会有意收集儿童或其他用户的个人信息。

## 政策变更

扩展功能或数据处理方式发生变化时，本政策可能更新。页面顶部的生效日期代表最新修订时间。

## 联系方式

如有隐私或支持问题，请提交 GitHub Issue：
<https://github.com/backrt/chrome_plugin_video_capture/issues>
