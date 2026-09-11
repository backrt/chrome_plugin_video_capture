# Mozilla AMO Reviewer Notes

## Single purpose

Video Recorder records video and audio that the user is actively playing in an ordinary HTML5 media element on the selected tab, then creates a local, seekable WebM file. It does not retrieve original media URLs, reconstruct unviewed portions, bypass DRM, or upload recorded content.

## Permission explanations

### `activeTab`

Used only after the user explicitly starts recording, so the extension can identify and communicate with the selected webpage. It is not used for passive browsing monitoring.

### `scripting`

Injects the packaged recording bridge into the user-selected tab and accessible frames. This is required to locate ordinary HTML video elements and capture what they are actually playing.

### `downloads`

Saves the user-created WebM file to the local downloads folder and lets the user open that folder from the popup.

### `alarms`

Imposes a bounded timeout while waiting for frames to finish, preventing an inaccessible or closed frame from leaving the recording stuck in a saving state.

### `storage`

Stores recording state, acknowledgement of the usage notice, and up to 100 local diagnostic events. This information is not synchronized or transmitted by the extension.

### `http://*/*` and `https://*/*`

Allows the extension, only following a user-initiated recording action, to inspect the selected page and accessible cross-origin frames for HTML video elements. It is not used to intercept media requests, collect browsing history, or upload data.

## Firefox implementation notes

- Manifest V3 fixed ID: `video-recorder@backrt.github.io`.
- Minimum Firefox version: `142.0`.
- Firefox does not expose Chrome's Offscreen API. The storage/finalization handler and coordinator therefore run in the packaged non-persistent background document.
- During an active recording, the content script holds a `runtime.Port` so the background document remains available. The port is disconnected after recording finishes.
- All executable code is included in the package. There is no remote code, WebAssembly, dynamic code download, analytics, advertising, or tracking.
- `browser_specific_settings.gecko.data_collection_permissions.required` is explicitly set to `["none"]`.

## Reproducible build

Requirements: Node.js 20 or newer. No project dependency installation is required.

From the source archive root, run:

```bash
npm run check
npm run build:firefox
npx --yes web-ext@10.5.0 lint --source-dir dist/firefox-unpacked
```

The submitted file is generated as `dist/video-recorder-firefox-1.6.0.zip`. The build script copies the readable source files, converts the compatibility namespace from `chrome.*` to Firefox's Promise-based `browser.*`, and creates a deterministic ZIP. It does not minify, bundle, obfuscate, or download runtime code.

## Test procedure

No account, credentials, paid service, or external companion application is required.

1. Open an ordinary HTTPS page containing a non-DRM HTML5 video that the tester is authorized to record.
2. Start the video manually.
3. Open Video Recorder, accept the usage notice, and click Start recording.
4. Let the video play for at least 10 seconds. Optionally pause and resume; recording follows the source without modifying volume, mute state, speed, or position.
5. Click Stop and save, then wait while the extension creates a seekable WebM file.
6. Open the saved WebM and verify playback and progress-bar seeking.
7. Protected or DRM-controlled media is intentionally unsupported and may produce a clear failure instead of bypassing protection.

## Data handling

- No video, audio, page content, URL, history, diagnostics, identifier, or usage information is sent to the developer or any third party.
- Recording chunks are stored temporarily in browser-local storage and removed after finalization or cleanup.
- Finished files are saved through the standard downloads API and remain under the user's control.
- The extension records only content actually played after the user starts recording.
- It does not automatically play, seek, mute, alter the source media, or fill unviewed gaps.
