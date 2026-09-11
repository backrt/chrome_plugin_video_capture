const test = require("node:test");
const assert = require("node:assert/strict");

require("../shared.js");

test("makeScopedId separates identical local IDs from different frames", () => {
  assert.notEqual(
    makeScopedId("rec-12345678", "0", "segment", "v1"),
    makeScopedId("rec-12345678", "4", "segment", "v1")
  );
});

test("validateChunkEnvelope rejects an oversized chunk", () => {
  const result = validateChunkEnvelope({
    recordingId: "rec-12345678",
    frameKey: "0",
    groupId: "rec-12345678:f0:group:g0",
    segmentId: "rec-12345678:f0:segment:v1",
    sequence: 0,
    byteLength: MAX_CHUNK_BYTES + 1,
    base64: "AA==",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /过大/);
});

test("validateChunkEnvelope accepts a well-formed chunk", () => {
  assert.deepEqual(
    validateChunkEnvelope({
      recordingId: "rec-12345678",
      frameKey: "0",
      groupId: "rec-12345678:f0:group:g0",
      segmentId: "rec-12345678:f0:segment:v1",
      sequence: 0,
      byteLength: 1,
      base64: "AQ==",
      rangeStart: 0,
      rangeEnd: 1,
    }),
    { ok: true }
  );
});

test("nextFrameState completes and fails frames idempotently", () => {
  const state = {
    pendingFrameIds: [0, 2],
    completedFrameIds: [],
    failedFrames: [],
  };
  const completed = nextFrameState(state, { type: "ready", frameId: 0 });
  const repeated = nextFrameState(completed, { type: "ready", frameId: 0 });
  const failed = nextFrameState(repeated, {
    type: "failed",
    frameId: 2,
    message: "gone",
  });
  assert.deepEqual(failed.pendingFrameIds, []);
  assert.deepEqual(failed.completedFrameIds, [0]);
  assert.equal(failed.failedFrames.length, 1);
  assert.equal(failed.failedFrames[0].frameId, 2);
});

test("isRecordingFile matches only files for the selected recording", () => {
  assert.equal(
    isRecordingFile("recording-rec_1-segment.bin", "rec_1"),
    true
  );
  assert.equal(isRecordingFile("merged-rec_1-group.bin", "rec_1"), true);
  assert.equal(isRecordingFile("merged-rec_2-group.bin", "rec_1"), false);
});

test("idleState carries an explicit terminal result and otherwise starts clean", () => {
  const partial = idleState("", {
    result: "partial",
    resultMessage: "已保存 1 个文件，1 个 frame 失败",
    failedFrames: [{ frameId: 2, message: "frame removed" }],
  });
  assert.equal(partial.result, "partial");
  assert.equal(partial.failedFrames.length, 1);
  assert.equal(idleState().result, "");
  assert.deepEqual(idleState().failedFrames, []);
  assert.equal("fillHint" in idleState(), false);
  assert.equal("fillRemain" in idleState(), false);
});

test("terminalPresentation maps partial saves to a persistent warning", () => {
  assert.deepEqual(
    terminalPresentation({
      result: "partial",
      resultMessage: "已保存 1 个视频，但有 1 项未完成",
    }),
    {
      visible: true,
      tone: "warning",
      title: "已部分保存",
      message: "已保存 1 个视频，但有 1 项未完成",
      showLogs: false,
    }
  );
});

test("terminalPresentation asks to show logs for a failure", () => {
  const presentation = terminalPresentation({
    result: "failure",
    resultMessage: "磁盘空间不足",
  });
  assert.equal(presentation.title, "保存失败");
  assert.equal(presentation.showLogs, true);
});

test("selectUsableSegments keeps small segments when their group total is valid", () => {
  const segments = [
    { segmentId: "b", bytes: 70, rangeStart: 2 },
    { segmentId: "a", bytes: 60, rangeStart: 0 },
  ];
  assert.deepEqual(
    selectUsableSegments(segments, 100).map((item) => item.segmentId),
    ["a", "b"]
  );
  assert.deepEqual(selectUsableSegments(segments, 200), []);
});
