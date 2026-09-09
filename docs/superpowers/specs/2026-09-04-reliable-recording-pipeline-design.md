# Reliable Recording Pipeline Design

**Date:** 2026-09-04
**Status:** Implemented — automated verification passed; manual Chrome acceptance pending

## Goal

Make recordings resilient to Manifest V3 service-worker suspension, prevent cross-frame session collisions, guarantee that all acknowledged chunks are durable before download, and report partial failures honestly while preserving the extension's current element-level recording behavior.

## Product Scope

The extension continues to:

- record eligible HTML `<video>` elements rather than the whole tab;
- record video and available audio through `HTMLMediaElement.captureStream()` and `MediaRecorder`;
- support videos in the main document, child frames, and open shadow roots;
- split recordings when the viewer seeks and merge the resulting WebM segments;
- fill finite-duration gaps after the user selects “停止并保存”;
- save files through `chrome.downloads` without a remote server or runtime dependency.

The redesign does not attempt to bypass DRM, protected cross-origin media, browser capture restrictions, or autoplay restrictions. It does not introduce tab capture, cloud storage, transcoding, or a new UI framework.

## Selected Architecture

Use the Offscreen Document as the durable owner of the active recording pipeline. The service worker remains the coordinator and download controller, but it no longer owns open file handles, chunk queues, or the only copy of session metadata.

The responsibilities are:

- `popup.js`: user actions and state rendering only.
- `background.js`: create recording IDs, inject scripts, coordinate frames, track durable high-level state in `chrome.storage.session`, enforce stop timeouts, request finalization, and start downloads.
- `content.js`: bridge the page world to extension contexts, namespace local IDs, serialize metadata and chunk writes, validate payloads, and await durable acknowledgements.
- `page-recorder.js`: capture media, track viewed ranges, fill gaps, wait for pending Blob reads, and restore the page video's state.
- `offscreen.js`: own OPFS writers and session metadata, acknowledge writes only after completion, close writers on flush, merge segments, create download URLs, and delete temporary files.
- `shared.js`: protocol constants and pure validation/range/ID helpers.

## Recording Identity

The service worker creates one `recordingId` for every start request using `crypto.randomUUID()`. Every started frame receives:

```js
{
  type: MSG.START_RECORDING,
  recordingId,
  frameKey: String(frameId)
}
```

The page recorder may keep simple local identifiers such as `g0` and `v1`. The isolated content script converts them before sending extension messages:

```text
groupId   = <recordingId>:f<frameKey>:g<localGroupId>
segmentId = <recordingId>:f<frameKey>:s<localVideoId>
```

Only namespaced IDs are accepted by the Offscreen Document. Messages whose `recordingId` does not match the active recording are rejected.

## Ordered Write Protocol

New protocol messages are introduced:

- `RESET_RECORDING`: initialize an empty Offscreen recording and remove stale temporary files.
- `REGISTER_SEGMENT`: create or update segment metadata before its first chunk.
- `WRITE_CHUNK`: append one numbered chunk to a segment.
- `FLUSH_FRAME`: confirm that one frame has sent every segment update and chunk.
- `FINALIZE_RECORDING`: close all writers and return a serializable session index.
- `CLEANUP_RECORDING`: revoke object URLs and remove all segment and merged files for the recording.

Each `WRITE_CHUNK` contains:

```js
{
  recordingId,
  frameKey,
  groupId,
  segmentId,
  sequence,
  mimeType,
  videoName,
  rangeStart,
  rangeEnd,
  base64,
  byteLength
}
```

The content script uses one promise queue per frame. Registration and chunks enter the same queue, so registration cannot overtake a chunk and final metadata cannot be overtaken by `FLUSH_FRAME`.

The Offscreen Document keeps the next expected sequence for each segment. It accepts exactly the expected number, treats an already-committed lower number as an idempotent retry, and rejects gaps or conflicting duplicates. A write response is sent only after `FileSystemWritableFileStream.write()` resolves.

## MediaRecorder Drain Guarantee

`page-recorder.js` tracks every `Blob.arrayBuffer()` promise created by `dataavailable`. `stopRecorderOnly()` waits for the MediaRecorder `stop` event and then waits until the tracked set is empty. The existing fixed 150 ms delay is removed.

The page posts `STOPPED` only after:

1. every active recorder has stopped;
2. every final Blob has been converted and posted to the isolated world;
3. gap-fill work has completed or produced an explicit error result.

The content script then waits for its ordered extension-message queue, sends `FLUSH_FRAME`, and finally sends `RECORDING_READY` to the service worker.

## Service-Worker Recovery

High-level state in `chrome.storage.session` includes:

```js
{
  status,
  recordingId,
  tabId,
  frameIds,
  pendingFrameIds,
  completedFrameIds,
  failedFrames,
  startTime,
  mimeType,
  videoCount,
  fillHint,
  error
}
```

No correctness decision relies solely on a service-worker global variable. When an event wakes a new worker instance, it reads this state and queries the existing Offscreen Document. Offscreen creation is guarded by a shared creation promise to avoid concurrent `createDocument()` calls.

Content scripts do not rely on a long-lived port for delivery. They use awaited `chrome.runtime.sendMessage()` calls targeted to the Offscreen Document. A service-worker restart therefore does not disconnect the active data path.

## Stop Coordination and Partial Results

The service worker stores exact `pendingFrameIds`, not only a counter. Each ready or failed message is idempotently applied by frame ID.

When stopping:

- the service worker asks every started frame to stop;
- a frame that cannot receive the stop request is immediately marked failed;
- responsive frames may continue gap filling;
- progress heartbeats extend that frame's deadline;
- a frame without progress or completion for 120 seconds is marked timed out;
- once no frames remain pending, the worker finalizes all successfully flushed data.

Deadlines are enforced with one-shot `chrome.alarms` entries so timeout processing wakes a suspended service worker. Frame completion identity is taken from Chrome's message sender metadata rather than trusted message payload fields.

If at least one valid output exists, it is downloaded and the popup reports that the recording was partially saved, including the number of failed frames. If no valid output exists, the operation fails without claiming a successful save.

## Gap Fill and Page Restoration

Before modifying a video for gap fill, the page recorder stores:

- `currentTime`;
- `paused` state;
- `muted` state;
- `volume`;
- `playbackRate`.

These values are restored in a `finally` block. A video that was paused remains paused. A video that was playing is resumed only when `play()` succeeds.

Gap-fill failures are collected per video and returned through `STOPPED`; they are not reduced to debug logs. Successfully captured ranges remain downloadable, but the result is marked partial. Gap filling remains real-time and the UI continues to show the estimated remaining media duration.

## Validation and Trust Boundary

The isolated content script validates page-world messages before forwarding them:

- message channel and direction must match;
- a start-scoped token must match the active bridge session;
- identifiers and names have bounded string lengths;
- ranges must be finite and non-negative;
- chunk payloads must be transferable buffers with a maximum size of 16 MiB;
- cumulative queued bytes are bounded to prevent unbounded bridge memory growth.

The token prevents stale recording messages from being accepted. It is not described as protection against a fully hostile page-world script, because the recorder itself executes in that world.

## File Lifecycle

OPFS names include the recording ID and a sanitized segment ID. Cleanup removes:

- all segment files for the completed or abandoned recording;
- every `merged-*` file produced for that recording;
- active object URLs;
- in-memory session metadata and write queues.

Cleanup occurs after every successful download, after a terminal failure, at the next recording start for stale recordings, and when the extension is installed or updated. Cleanup errors are logged but do not overwrite a more useful recording error.

## WebM and Format Handling

Segment merging remains WebM-specific. The recorder prefers VP9/Opus, VP8/Opus, then generic WebM. MP4 may be used only when a recording has one segment; a multi-segment MP4 recording fails with an explicit unsupported-merge message rather than being passed to the WebM parser.

The WebM concatenator receives segments already sorted by `rangeStart`. Invalid or overlapping ranges are rejected before merge. Small files are reported as discarded instead of silently disappearing.

## Error Reporting

Errors are represented as structured records containing `code`, `message`, `frameKey`, and optional `segmentId`. User-facing messages remain concise Chinese text; debug logs retain structured context.

Terminal outcomes are:

- `success`: all started frames flushed and all valid groups downloaded;
- `partial`: at least one output downloaded, with one or more frame, video, gap-fill, merge, or small-file failures;
- `failure`: no output downloaded.

The popup keeps the last terminal result until the next start request, so reopening the popup does not erase a partial-result warning.

## Testing Strategy

The repository gains a dependency-free Node test harness using `node:test`.

Pure unit tests cover:

- global ID namespacing across frames;
- ordered sequence acceptance, duplicate retries, and gap rejection;
- frame readiness updates and timeout transitions;
- range merging and gap detection;
- file cleanup name matching;
- protocol payload validation;
- WebM concatenation using small binary fixtures.

Component tests execute `background.js`, `content.js`, and `offscreen.js` in VM contexts with narrow fake Chrome APIs and fake writable files. They verify that finalization cannot occur before write acknowledgement, a failed frame cannot block stopping forever, and recovery reads durable state rather than worker globals.

Manual Chrome acceptance covers:

1. one normal video;
2. paused recording for more than 30 seconds;
3. seeking forward and backward;
4. two videos in one frame;
5. videos in two iframes with identical local IDs;
6. iframe removal during stop;
7. a dynamically inserted video;
8. a finite video requiring gap fill;
9. a live or infinite-duration video;
10. protected media failure;
11. repeated multi-segment recordings with OPFS usage checked after cleanup.

## Compatibility and Rollout

The minimum supported browser remains Chrome 116. There is no migration requirement for an in-progress recording when the extension is updated; install/update initialization abandons and cleans it. The legal acknowledgement and last successful download ID remain compatible with version 1.2.0.

Implementation is complete only when automated tests pass, all JavaScript files pass `node --check`, `manifest.json` parses, and the manual acceptance checklist has either been exercised in Chrome or clearly reported as pending.
