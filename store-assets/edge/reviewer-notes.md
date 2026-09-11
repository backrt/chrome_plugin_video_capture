# Partner Center 审核填写内容

## Single purpose description

Video Recorder records the video and audio that a user is actively playing in an ordinary HTML5 media element on the current tab, then creates a local, seekable WebM file. It does not retrieve original media URLs, fill unviewed portions, bypass DRM, or upload recorded content.

## Permission justifications

### activeTab

Used only after the user clicks Start recording, so the extension can identify and communicate with the currently selected webpage. The permission is not used for passive browsing monitoring.

### scripting

Injects the packaged recording bridge into the user-selected tab and its accessible frames after an explicit recording request. This is required to locate HTML video elements and capture what they are actually playing.

### offscreen

Keeps local recording chunks in Origin Private File System storage, finalizes WebM duration and seek indexes, and creates a local download URL without opening an additional visible page.

### downloads

Saves the user-created WebM file to the browser’s downloads folder and allows the user to open that folder from the extension popup.

### alarms

Provides a bounded timeout while waiting for frames to finish, preventing an inaccessible or closed frame from leaving the recording permanently stuck in a saving state.

### storage

Stores the current local recording state, the user’s acknowledgement of the usage notice, and up to 100 local diagnostic log entries. These values are not synchronized or transmitted by the extension.

### http://*/* and https://*/* host access

Allows the extension, only after a user-initiated recording action, to inspect the selected page and accessible cross-origin frames for HTML video elements. Host access is not used to read browsing history, intercept network media, or upload data.

## Remote code declaration

No. The extension uses Manifest V3 and contains all executable JavaScript in the submitted package. It does not load or execute remotely hosted code, WebAssembly, or external scripts.

## Data handling declaration

- No recorded video, audio, page content, URL, diagnostic information, identifier, or usage information is sent to the developer or a third party.
- Recorded chunks are written to temporary browser-local storage and removed after finalization or cleanup.
- Diagnostic logs remain in browser-local storage, contain operational events and error messages, are limited to 100 entries, and are replaced when a new recording starts.
- The extension has no analytics, advertising, tracking, account, payment, or cloud service.
- The user can remove local extension data by uninstalling the extension or clearing its stored data.

## Notes for certification

Version: 1.6.0

No account or test credentials are required.

Suggested test procedure:

1. Open a normal HTTPS page containing a non-DRM HTML5 video that the tester is authorized to record.
2. Start the video manually.
3. Open Video Recorder, review and accept the usage notice, and click Start recording.
4. Let the video play for at least 10 seconds. Optionally pause and resume it; the recording follows the source playback without modifying its volume, mute state, playback speed, or position.
5. Click Stop and save. Wait while the extension creates a seekable WebM file.
6. Open the downloaded WebM file and confirm that it plays and that the progress bar can seek.
7. Protected or DRM-controlled video is intentionally unsupported and can produce a clear failure rather than bypassing protection.

Important behavior for review:

- The extension records only content actually played after the user starts recording.
- It does not automatically play, seek, mute, or alter the source media.
- It does not fill unviewed gaps or download the original media resource.
- All processing is local and the result is saved through the standard downloads API.
