# Firefox Add-ons（AMO）上架素材

适用版本：`1.6.0`

扩展 ID：`video-recorder@backrt.github.io`

发布者默认值：`backrt`

支持入口：<https://github.com/backrt/chrome_plugin_video_capture/issues>

## 文件用途

- `listings.md`：简体中文、繁体中文、英文、日文、韩文商店文案与截图说明。
- `privacy-policy.md`：可直接粘贴到 AMO 自定义隐私政策字段的 Markdown 文档。
- `reviewer-notes.md`：权限说明、数据声明、构建方法及审核测试步骤。
- `visuals/icon-128.png`：AMO 商店图标。
- `visuals/screenshots/<locale>/`：对应语言的 1280×800 PNG 截图。
- `visuals/source/render.html`：截图渲染源文件。

## 建议填写

- Distribution：`On this site`（在 addons.mozilla.org 上架）
- Category：`Photos, Music & Videos`
- License：`All Rights Reserved`（仓库当前没有开源许可证；如后续加入 LICENSE，请同步修改）
- Requires payment：`No`
- Homepage：<https://github.com/backrt/chrome_plugin_video_capture>
- Support：<https://github.com/backrt/chrome_plugin_video_capture/issues>
- Data collection：`None`
- Add-on ID：`video-recorder@backrt.github.io`

## 上传顺序

1. 上传 `../../dist/video-recorder-firefox-1.6.0.zip`。
2. 选择在 AMO 上公开发布，并确认固定扩展 ID。
3. 设置名称、摘要、类别和许可证。
4. 为五种语言复制 `listings.md` 中对应的摘要、完整描述和截图说明。
5. 上传 `visuals/icon-128.png` 和对应语言的截图。
6. 将 `privacy-policy.md` 粘贴到 AMO 自定义隐私政策字段。
7. 将 `reviewer-notes.md` 的英文审核说明填入 Notes to Reviewers。
8. 如果 AMO 要求源码，上传 `../../dist/video-recorder-firefox-source-1.6.0.zip`。

## 发布前确认

- 发布者名称确实为 `backrt`；否则同步修改隐私政策。
- 扩展 ID 将作为长期稳定标识，后续版本不要更改。
- 只提交有权录制的普通 HTML5 视频测试步骤，不提供绕过 DRM 的描述。
- 正式版 Firefox 需要 Mozilla 签名；上传 ZIP 后由 AMO 完成签名。
