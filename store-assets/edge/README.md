# Microsoft Edge Add-ons 上架素材

适用版本：`1.6.0`

发布者默认值：`backrt`

支持入口：<https://github.com/backrt/chrome_plugin_video_capture/issues>

## 文件用途

- `listings.md`：五种商店语言的名称、完整描述和搜索词。
- `privacy-policy.md`：隐私政策源文档。
- `reviewer-notes.md`：单一用途、权限理由、数据声明和审核测试步骤。
- `visuals/`：可直接上传的 Logo、宣传图和各语言截图。
- `../../docs/privacy-policy.html`：可部署到 GitHub Pages 的公开隐私政策页面。

## 建议填写

- Category：`Productivity`
- Visibility：`Public`
- Mature content：`No`
- Website：<https://github.com/backrt/chrome_plugin_video_capture>
- Support：<https://github.com/backrt/chrome_plugin_video_capture/issues>
- Privacy policy：启用 GitHub Pages 后填写
  `https://backrt.github.io/chrome_plugin_video_capture/privacy-policy.html`
- Remote code：`No`
- Data collection：不向开发者或第三方传输数据。

## 上传顺序

1. 上传 `../../dist/video-recorder-edge-1.6.0.zip`。
2. 在 Privacy 页面复制 `reviewer-notes.md` 中的单一用途、权限理由和数据声明。
3. 为简中、繁中、英文、日文、韩文分别复制 `listings.md` 的对应文案。
4. 每种语言上传 `visuals/logo-300.png`；可使用 Partner Center 的 Duplicate 功能复用同一 Logo。
5. 上传对应语言的 `visuals/screenshots/<locale>/` 截图。
6. 可选上传 `visuals/promo-small-440x280.png` 和
   `visuals/promo-large-1400x560.png`。
7. 粘贴 `reviewer-notes.md` 中的审核说明，检查所有字段后提交。

## 发布前必须确认

- GitHub Pages 隐私政策 URL 可以公开访问。
- Partner Center 中显示的发布者名称与实际账号一致；如不是 `backrt`，同步修改隐私政策。
- 截图与当前版本界面一致。
- 只上传 ZIP，不要上传整个仓库或 `dist` 目录。
