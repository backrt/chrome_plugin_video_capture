# Reliable Recording Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the service-worker-owned recording writer with an acknowledged Offscreen pipeline that survives worker suspension, isolates frames, drains final chunks, saves partial results, and cleans up every temporary file.

**Architecture:** The service worker creates a recording identity and coordinates frame completion through durable `chrome.storage.session` state. Each content script namespaces page-local IDs and sends ordered, awaited writes directly to the Offscreen Document, which owns OPFS streams and segment metadata until finalization and cleanup.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript, MediaRecorder, Origin Private File System, `chrome.offscreen`, `chrome.storage`, `chrome.downloads`, Node.js `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-04-reliable-recording-pipeline-design.md`

**Execution status:** Tasks 1–5 implemented and verified with `npm run check` on 2026-09-04. The directory is not a Git repository, so no task commits were created. Manual Chrome acceptance remains pending.

## Global Constraints

- Minimum supported browser remains Chrome 116.
- Record HTML `<video>` elements; do not replace the feature with tab capture.
- Keep gap filling for finite-duration media.
- Do not add runtime dependencies, a bundler, cloud services, DRM bypasses, or a UI framework.
- All user-facing copy remains concise Chinese text.
- Offscreen acknowledges a chunk only after its OPFS write resolves.
- No correctness decision may depend only on service-worker global variables.
- Frame deadlines use one-shot `chrome.alarms`, not service-worker timers.
- The working directory is not currently a Git repository, so each task ends with a verification checkpoint rather than a commit. If Git is initialized before execution, use the listed commit message at that checkpoint.

---

### Task 1: Protocol helpers and dependency-free test harness

**Files:**

- Create: `package.json`
- Create: `tests/shared.test.js`
- Modify: `shared.js`

**Interfaces:**

- Consumes: existing `MSG`, range helpers, base64 helpers, and global export pattern from `shared.js`.
- Produces: `makeScopedId(recordingId, frameKey, kind, localId)`, `validateRecordingId(value)`, `validateChunkEnvelope(value)`, `nextFrameState(state, event)`, `isRecordingFile(name, recordingId)`, `MAX_CHUNK_BYTES`, and all new protocol constants.

- [ ] **Step 1: Create the Node test command and failing helper tests**

Create `package.json`:

```json
{
  "name": "chrome-plugin-video-capture",
  "private": true,
  "scripts": {
    "test": "node --test tests/*.test.js",
    "check": "npm test && node --check background.js && node --check content.js && node --check offscreen.js && node --check page-recorder.js && node --check popup.js && node --check shared.js && node --check webm-concat.js"
  }
}
```

Create `tests/shared.test.js` with separate tests that assert:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
require("../shared.js");

test("makeScopedId separates identical local IDs from different frames", () => {
  assert.notEqual(
    makeScopedId("rec-12345678", "0", "segment", "v1"),
    makeScopedId("rec-12345678", "4", "segment", "v1")
  );
});

test("validateChunkEnvelope rejects oversized and non-sequentially-shaped chunks", () => {
  assert.equal(validateChunkEnvelope({
    recordingId: "rec-12345678",
    frameKey: "0",
    groupId: "rec-12345678:f0:group:g0",
    segmentId: "rec-12345678:f0:segment:v1",
    sequence: 0,
    byteLength: MAX_CHUNK_BYTES + 1,
    base64: "AA=="
  }).ok, false);
});

test("nextFrameState completes and fails frames idempotently", () => {
  const state = { pendingFrameIds: [0, 2], completedFrameIds: [], failedFrames: [] };
  const completed = nextFrameState(state, { type: "ready", frameId: 0 });
  const repeated = nextFrameState(completed, { type: "ready", frameId: 0 });
  const failed = nextFrameState(repeated, { type: "failed", frameId: 2, message: "gone" });
  assert.deepEqual(failed.pendingFrameIds, []);
  assert.deepEqual(failed.completedFrameIds, [0]);
  assert.equal(failed.failedFrames.length, 1);
});

test("isRecordingFile matches segment and merged files for only one recording", () => {
  assert.equal(isRecordingFile("recording-rec_1-segment.bin", "rec_1"), true);
  assert.equal(isRecordingFile("merged-rec_1-group.bin", "rec_1"), true);
  assert.equal(isRecordingFile("merged-rec_2-group.bin", "rec_1"), false);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test`

Expected: the file loads, then tests fail because `makeScopedId`, `validateChunkEnvelope`, `nextFrameState`, `isRecordingFile`, and `MAX_CHUNK_BYTES` are not defined.

- [ ] **Step 3: Add protocol constants and minimal pure helpers**

In `shared.js`:

- replace `REGISTER_VIDEO`/`RECORDING_CHUNK` with `REGISTER_SEGMENT`/`WRITE_CHUNK` for the Offscreen target;
- add `RESET_RECORDING`, `FLUSH_FRAME`, `FINALIZE_RECORDING`, `GET_RECORDING_INDEX`, and `CLEANUP_RECORDING`;
- add `MAX_CHUNK_BYTES = 16 * 1024 * 1024` and `MAX_QUEUED_BYTES = 64 * 1024 * 1024`;
- implement scoped IDs in the exact shape `<recordingId>:f<frameKey>:<kind>:<localId>` after replacing characters outside `[a-zA-Z0-9_-]` with `_`;
- validate finite non-negative ranges, integer sequence numbers, bounded IDs, base64 strings, and `byteLength <= MAX_CHUNK_BYTES`;
- make `nextFrameState` remove a frame from `pendingFrameIds` exactly once and add it to either `completedFrameIds` or `failedFrames`;
- make `isRecordingFile` match both `recording-<safeRecordingId>-` and `merged-<safeRecordingId>-` prefixes;
- export the new values through the existing `Object.assign(g, ...)` block.

- [ ] **Step 4: Run tests and syntax checks and verify GREEN**

Run: `npm run check`

Expected: all Task 1 tests pass and every JavaScript file parses.

- [ ] **Step 5: Record the checkpoint**

If Git exists:

```bash
git add package.json tests/shared.test.js shared.js
git commit -m "test: define reliable recording protocol"
```

Otherwise record: `Task 1 verified with npm run check; no commit because the directory is not a Git repository.`

---

### Task 2: Offscreen-owned ordered OPFS writer

**Files:**

- Create: `tests/offscreen-store.test.js`
- Create: `offscreen-store.js`
- Modify: `offscreen.html`
- Modify: `offscreen.js`

**Interfaces:**

- Consumes: `validateChunkEnvelope`, `base64ToBytes`, `isRecordingFile`, `concatWebmParts`.
- Produces: `createRecordingStore({ getDirectory, decodeBase64 })` with methods `reset(recordingId)`, `register(meta)`, `writeChunk(envelope)`, `flushFrame(recordingId, frameKey)`, `finalize(recordingId)`, `createDownload(recordingId, opfsName, mimeType)`, and `cleanup(recordingId)`.

- [ ] **Step 1: Write failing ordered-writer tests**

Create a fake OPFS directory whose writable records `write`, `close`, and file contents. Add tests proving:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
require("../shared.js");
require("../offscreen-store.js");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function segmentMeta() {
  return {
    recordingId: "rec-12345678",
    frameKey: "0",
    groupId: "rec-12345678:f0:group:g0",
    segmentId: "rec-12345678:f0:segment:v1",
    mimeType: "video/webm",
    videoName: "video",
    rangeStart: 0,
    rangeEnd: 1
  };
}

function chunkEnvelope(sequence) {
  return { ...segmentMeta(), sequence, base64: "AQ==", byteLength: 1 };
}

function fakeDirectory({ writeGate = null, names = [] } = {}) {
  const files = new Map(names.map(name => [name, { chunks: [], closed: false }]));
  return {
    async *entries() {
      for (const name of files.keys()) yield [name, {}];
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw new Error("NotFoundError");
    },
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options.create) throw new Error("NotFoundError");
        files.set(name, { chunks: [], closed: false });
      }
      const file = files.get(name);
      return {
        async createWritable() {
          return {
            async write(bytes) {
              if (writeGate) await writeGate.promise;
              file.chunks.push(Uint8Array.from(bytes));
            },
            async close() { file.closed = true; }
          };
        },
        async getFile() {
          const size = file.chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0);
          return { size, arrayBuffer: async () => new Uint8Array(size).buffer };
        }
      };
    },
    names() { return [...files.keys()]; }
  };
}

test("writeChunk acknowledges only after the write resolves", async () => {
  const gate = deferred();
  const directory = fakeDirectory({ writeGate: gate });
  const store = createRecordingStore({ getDirectory: async () => directory });
  await store.reset("rec-12345678");
  await store.register(segmentMeta());
  let settled = false;
  const writing = store.writeChunk(chunkEnvelope(0)).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await writing;
  assert.equal(settled, true);
});

test("writeChunk accepts an idempotent retry and rejects a sequence gap", async () => {
  const directory = fakeDirectory();
  const store = createRecordingStore({ getDirectory: async () => directory });
  await store.reset("rec-12345678");
  await store.register(segmentMeta());
  assert.equal((await store.writeChunk(chunkEnvelope(0))).duplicate, false);
  assert.equal((await store.writeChunk(chunkEnvelope(0))).duplicate, true);
  await assert.rejects(store.writeChunk(chunkEnvelope(2)), /分片序号不连续/);
});

test("cleanup removes both segment and merged files", async () => {
  const directory = fakeDirectory({ names: [
    "recording-rec-12345678-a.bin",
    "merged-rec-12345678-g.bin",
    "recording-other-a.bin"
  ]});
  const store = createRecordingStore({ getDirectory: async () => directory });
  await store.cleanup("rec-12345678");
  assert.deepEqual(directory.names(), ["recording-other-a.bin"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/offscreen-store.test.js`

Expected: failure because `offscreen-store.js` or `createRecordingStore` does not exist.

- [ ] **Step 3: Implement the isolated store**

Implement `offscreen-store.js` as a browser/Node-compatible IIFE. Maintain an in-memory map keyed by `segmentId`; each record contains metadata, `nextSequence`, `bytes`, `fileHandle`, `writable`, and a promise queue. `register()` opens `recording-<safeRecordingId>-<safeSegmentId>.bin` once. `writeChunk()` validates the envelope, checks the sequence, awaits that segment's queue, writes decoded bytes, then increments `nextSequence`. `finalize()` closes every writer and returns plain serializable groups sorted by `rangeStart`.

Keep Blob URL creation and WebM merging in `offscreen.js`, but make them consume the finalized index returned by the store. Reject multi-part non-WebM groups with `不支持拼接 MP4 分片`.

Load scripts in `offscreen.html` in this order:

```html
<script src="shared.js"></script>
<script src="webm-concat.js"></script>
<script src="offscreen-store.js"></script>
<script src="offscreen.js"></script>
```

Map targeted runtime messages to the store methods and return `{ ok: true, ...result }`; return `{ ok: false, code, error }` on validation, sequence, and OPFS errors.

- [ ] **Step 4: Verify the store and full baseline**

Run: `npm run check`

Expected: ordered-writer, cleanup, shared helper, and syntax checks all pass.

- [ ] **Step 5: Record the checkpoint**

If Git exists:

```bash
git add tests/offscreen-store.test.js offscreen-store.js offscreen.html offscreen.js
git commit -m "feat: move recording writes into offscreen storage"
```

Otherwise record the successful `npm run check` result.

---

### Task 3: Drained page capture and ordered content bridge

**Files:**

- Create: `tests/content-protocol.test.js`
- Create: `content-protocol.js`
- Modify: `content.js`
- Modify: `page-recorder.js`
- Modify: `background.js` only to pass `recordingId`, `frameKey`, and `bridgeToken` in the start payload.

**Interfaces:**

- Consumes: `makeScopedId`, `validateChunkEnvelope`, `MAX_CHUNK_BYTES`, `MAX_QUEUED_BYTES`, and Offscreen protocol messages.
- Produces: `createFrameProtocol({ recordingId, frameKey, bridgeToken, send })` with `register(data)`, `chunk(data)`, `flush(result)`, and `pendingBytes()`; page `STOPPED` result includes `videos` and `errors`.

- [ ] **Step 1: Write failing frame namespacing and ordering tests**

Add tests that use a deferred fake `send` and assert:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
require("../shared.js");
require("../content-protocol.js");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function protocolOptions(frameKey, sent) {
  return {
    recordingId: "rec-12345678",
    frameKey,
    bridgeToken: "bridge-12345678",
    send: async message => { sent.push(message); return { ok: true }; }
  };
}

function localRegistration(groupId, videoId) {
  return { groupId, videoId, videoName: "video", mimeType: "video/webm", rangeStart: 0 };
}

function localChunk(groupId, videoId, buffer) {
  return { groupId, videoId, videoName: "video", mimeType: "video/webm", buffer };
}

test("identical page IDs in two frames become different extension IDs", async () => {
  const sent = [];
  const a = createFrameProtocol(protocolOptions("0", sent));
  const b = createFrameProtocol(protocolOptions("7", sent));
  await a.register(localRegistration("g0", "v1"));
  await b.register(localRegistration("g0", "v1"));
  assert.notEqual(sent[0].segmentId, sent[1].segmentId);
  assert.notEqual(sent[0].groupId, sent[1].groupId);
});

test("flush waits for registration and chunk acknowledgements", async () => {
  const calls = [];
  const gates = [deferred(), deferred()];
  const protocol = createFrameProtocol({
    ...protocolOptions("0", calls),
    send: async message => {
      calls.push(message.type);
      if (message.type === MSG.REGISTER_SEGMENT) await gates[0].promise;
      if (message.type === MSG.WRITE_CHUNK) await gates[1].promise;
      return { ok: true };
    }
  });
  protocol.register(localRegistration("g0", "v1"));
  protocol.chunk(localChunk("g0", "v1", new Uint8Array([1])));
  const flushing = protocol.flush({ errors: [] });
  gates[0].resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [MSG.REGISTER_SEGMENT, MSG.WRITE_CHUNK]);
  gates[1].resolve();
  await flushing;
  assert.equal(calls.at(-1), MSG.FLUSH_FRAME);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/content-protocol.test.js`

Expected: failure because `createFrameProtocol` is not defined.

- [ ] **Step 3: Implement and integrate the ordered bridge**

Implement `content-protocol.js` as a browser/Node-compatible IIFE. Give every local segment its own sequence starting at zero, but serialize all messages through one frame queue. Track queued byte count before base64 conversion; reject one chunk above 16 MiB or a frame queue above 64 MiB. Await `chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, ...message })` and throw when it returns `ok: false`.

Update `content.js` to:

- receive `recordingId`, `frameKey`, and `bridgeToken` from `START_RECORDING`;
- pass the token into page-world start/stop messages;
- accept only page messages with the active token;
- enqueue both registration and chunks through `createFrameProtocol`;
- call `protocol.flush(result)` before `RECORDING_READY`;
- include `recordingId`, `videos`, and `errors` in `RECORDING_READY`; the background derives the numeric frame ID from `sender.frameId`;
- remove the recorder Port and its disconnect behavior.

Update `page-recorder.js` to keep a `Set` of pending chunk-read promises. In `ondataavailable`, add the `arrayBuffer()` promise before awaiting it and remove it in `finally`. After the recorder `stop` event, loop until the set is empty instead of sleeping 150 ms. Include the active bridge token on every page message.

Capture `currentTime`, `paused`, `muted`, `volume`, and `playbackRate` before gap fill and restore them in `finally`. Return structured per-video gap errors rather than swallowing them.

- [ ] **Step 4: Verify ordering, syntax, and existing range behavior**

Run: `npm run check`

Expected: frame protocol tests and all earlier tests pass; all scripts parse.

- [ ] **Step 5: Record the checkpoint**

If Git exists:

```bash
git add tests/content-protocol.test.js content-protocol.js content.js page-recorder.js background.js
git commit -m "feat: drain recorder chunks through an ordered bridge"
```

Otherwise record the successful `npm run check` result.

---

### Task 4: Durable background coordination and partial finalization

**Files:**

- Create: `tests/coordinator.test.js`
- Create: `recording-coordinator.js`
- Modify: `background.js`
- Modify: `shared.js`

**Interfaces:**

- Consumes: `nextFrameState`, Offscreen `RESET_RECORDING`, `FINALIZE_RECORDING`, `GET_RECORDING_INDEX`, `MERGE_SEGMENTS`, `CREATE_DOWNLOAD_URL`, and `CLEANUP_RECORDING`.
- Produces: `createRecordingCoordinator({ loadState, saveState, now, timeoutMs })` with `begin(recording)`, `markReady(event)`, `markFailed(event)`, `heartbeat(event)`, `expiredFrames()`, and `canFinalize()`.

- [ ] **Step 1: Write failing coordinator tests**

Cover idempotent readiness, send failure, timeout, and restart recovery:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
require("../recording-coordinator.js");

function memoryState() {
  let state = null;
  return {
    loadState: async () => state && structuredClone(state),
    saveState: async next => { state = structuredClone(next); },
  };
}

test("one failed frame cannot block finalization of a ready frame", async () => {
  const storage = memoryState();
  const coordinator = createRecordingCoordinator({ ...storage, now: () => 1000, timeoutMs: 120000 });
  await coordinator.begin({ recordingId: "rec-12345678", frameIds: [0, 2] });
  await coordinator.markReady({ recordingId: "rec-12345678", frameId: 0 });
  await coordinator.markFailed({ recordingId: "rec-12345678", frameId: 2, message: "frame removed" });
  assert.equal(await coordinator.canFinalize(), true);
});

test("a new coordinator instance recovers pending frames from storage", async () => {
  const storage = memoryState();
  const first = createRecordingCoordinator({ ...storage, now: () => 1000, timeoutMs: 120000 });
  await first.begin({ recordingId: "rec-12345678", frameIds: [0, 2] });
  const restarted = createRecordingCoordinator({ ...storage, now: () => 2000, timeoutMs: 120000 });
  await restarted.markReady({ recordingId: "rec-12345678", frameId: 0 });
  assert.deepEqual((await storage.loadState()).pendingFrameIds, [2]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/coordinator.test.js`

Expected: failure because `recording-coordinator.js` or `createRecordingCoordinator` does not exist.

- [ ] **Step 3: Implement coordinator and replace background globals**

Implement the coordinator as a browser/Node-compatible IIFE whose every transition loads the latest state and saves the next state. Persist per-frame `lastProgressAt`; `expiredFrames()` returns pending frames older than 120 seconds.

Refactor `background.js` to:

- guard `ensureOffscreen()` with `offscreenCreatingPromise`;
- call `RESET_RECORDING` before page injection;
- generate `recordingId` and `bridgeToken` with `crypto.randomUUID()`;
- send frame-specific start data and persist exact started frame IDs;
- mark stop-send failures immediately through the coordinator;
- process `RECORDING_READY`, `RECORDING_FAILED`, and `FILL_PROGRESS` only when `recordingId` matches;
- create/update one-shot `chrome.alarms` deadlines for pending frames and re-check expirations on every incoming event;
- derive frame identity for ready, failed, and progress events from Chrome message sender metadata rather than message payload fields;
- finalize whenever persisted `pendingFrameIds` becomes empty;
- ask Offscreen to close writers and return groups before downloading;
- save valid groups even when failures exist and store a terminal `result: "success" | "partial" | "failure"` plus concise Chinese summary;
- request `CLEANUP_RECORDING` after downloads or terminal failure;
- remove service-worker `sessions`, writable handles, chunk handling, and writer reset logic.

Keep the download creation and `waitForDownload()` logic in the service worker. Add a 10-minute download wait timeout that removes its listener and returns an interrupted result.

- [ ] **Step 4: Verify restart, timeout, and complete test suite**

Run: `npm run check`

Expected: coordinator restart and timeout tests pass together with all earlier tests and syntax checks.

- [ ] **Step 5: Record the checkpoint**

If Git exists:

```bash
git add tests/coordinator.test.js recording-coordinator.js background.js shared.js
git commit -m "fix: make frame finalization durable and partial-safe"
```

Otherwise record the successful `npm run check` result.

---

### Task 5: Popup result reporting, cleanup verification, and documentation

**Files:**

- Create: `README.md`
- Create: `tests/manifest.test.js`
- Modify: `popup.js`
- Modify: `popup.html`
- Modify: `popup.css`
- Modify: `manifest.json`
- Modify: `docs/superpowers/specs/2026-09-04-reliable-recording-pipeline-design.md` only to change status to Implemented after all automated verification succeeds.

**Interfaces:**

- Consumes: terminal state fields `result`, `resultMessage`, `failedFrames`, and existing debug log API.
- Produces: persistent success/partial/failure presentation and documented load/test/limitations procedure.

- [ ] **Step 1: Write failing manifest and state contract tests**

Create `tests/manifest.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("manifest keeps Chrome 116 and loads the revised background worker", () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.version, "1.3.0");
});
```

Extend `tests/shared.test.js` with the exact state contract:

```js
test("idleState carries an explicit terminal result and otherwise starts clean", () => {
  const partial = idleState("", {
    result: "partial",
    resultMessage: "已保存 1 个文件，1 个 frame 失败",
    failedFrames: [{ frameId: 2, message: "frame removed" }]
  });
  assert.equal(partial.result, "partial");
  assert.equal(partial.failedFrames.length, 1);
  assert.equal(idleState().result, "");
  assert.deepEqual(idleState().failedFrames, []);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test`

Expected: failure because the manifest is still version 1.2.0 and the terminal state contract is absent.

- [ ] **Step 3: Implement terminal-result UI and documentation**

Update `popup.js` so:

- `success` displays `已保存`;
- `partial` displays `已部分保存` and keeps the warning visible after reopening;
- `failure` displays `保存失败` and shows debug logs;
- clicking start clears the prior terminal result only after the new start request is accepted.

Add an `aria-live="polite"` result paragraph to `popup.html` and style success, warning, and failure states in `popup.css`. Increment `manifest.json` to version `1.3.0` and add the `alarms` permission used for frame deadlines.

Write `README.md` with:

- unpacked-extension installation steps through `chrome://extensions`;
- `npm test` and `npm run check` commands;
- architecture summary and local-only data statement;
- limitations for DRM, cross-origin protection, live media, autoplay, real-time gap fill, and browser shutdown;
- the eleven manual acceptance scenarios from the design spec;
- a recovery section explaining how partial-save messages and debug logs are interpreted.

- [ ] **Step 4: Run final automated verification**

Run: `npm run check`

Then run:

```bash
node -e 'const m=JSON.parse(require("fs").readFileSync("manifest.json","utf8")); if(m.version!=="1.3.0") process.exit(1); console.log("manifest 1.3.0 valid")'
```

Expected: every test passes, all JavaScript parses, and the manifest validation prints `manifest 1.3.0 valid`.

- [ ] **Step 5: Perform or explicitly defer manual Chrome acceptance**

Load the unpacked extension in Chrome and record the result of each README acceptance scenario. If browser extension loading is unavailable in the execution environment, state exactly: `Automated verification passed; manual Chrome acceptance remains pending` and leave the design document status as `Implemented — manual acceptance pending`.

- [ ] **Step 6: Record the final checkpoint**

If Git exists:

```bash
git add README.md tests popup.js popup.html popup.css manifest.json docs/superpowers/specs/2026-09-04-reliable-recording-pipeline-design.md
git commit -m "docs: finish reliable recording pipeline"
```

Otherwise record all verification output and list the modified files in the final handoff.
