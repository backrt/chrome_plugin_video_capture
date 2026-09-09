const test = require("node:test");
const assert = require("node:assert/strict");

require("../shared.js");
require("../recording-coordinator.js");

function memoryState() {
  let state = null;
  return {
    loadState: async () => (state ? structuredClone(state) : null),
    saveState: async (next) => {
      state = structuredClone(next);
    },
  };
}

test("one failed frame cannot block finalization of a ready frame", async () => {
  const storage = memoryState();
  const coordinator = createRecordingCoordinator({
    ...storage,
    now: () => 1000,
    timeoutMs: 120000,
  });
  await coordinator.begin({ recordingId: "rec-12345678", frameIds: [0, 2] });
  await coordinator.markReady({ recordingId: "rec-12345678", frameId: 0 });
  await coordinator.markFailed({
    recordingId: "rec-12345678",
    frameId: 2,
    message: "frame removed",
  });

  assert.equal(await coordinator.canFinalize(), true);
  const state = await storage.loadState();
  assert.deepEqual(state.completedFrameIds, [0]);
  assert.equal(state.failedFrames[0].frameId, 2);
});

test("a new coordinator instance recovers pending frames from storage", async () => {
  const storage = memoryState();
  const first = createRecordingCoordinator({
    ...storage,
    now: () => 1000,
    timeoutMs: 120000,
  });
  await first.begin({ recordingId: "rec-12345678", frameIds: [0, 2] });

  const restarted = createRecordingCoordinator({
    ...storage,
    now: () => 2000,
    timeoutMs: 120000,
  });
  await restarted.markReady({ recordingId: "rec-12345678", frameId: 0 });

  assert.deepEqual((await storage.loadState()).pendingFrameIds, [2]);
});

test("heartbeat extends only the matching pending frame deadline", async () => {
  let clock = 1000;
  const storage = memoryState();
  const coordinator = createRecordingCoordinator({
    ...storage,
    now: () => clock,
    timeoutMs: 120000,
  });
  await coordinator.begin({ recordingId: "rec-12345678", frameIds: [0, 2] });
  clock = 100000;
  await coordinator.heartbeat({ recordingId: "rec-12345678", frameId: 2 });
  clock = 122000;

  assert.deepEqual(await coordinator.expiredFrames(), [0]);
});

test("duplicate ready events do not duplicate completed frames", async () => {
  const storage = memoryState();
  const coordinator = createRecordingCoordinator({
    ...storage,
    now: () => 1000,
    timeoutMs: 120000,
  });
  await coordinator.begin({ recordingId: "rec-12345678", frameIds: [0] });
  const event = {
    recordingId: "rec-12345678",
    frameId: 0,
    errors: [{ code: "GAP_FILL_FAILED", message: "timeout" }],
  };
  await coordinator.markReady(event);
  await coordinator.markReady(event);

  const state = await storage.loadState();
  assert.deepEqual(state.completedFrameIds, [0]);
  assert.equal(state.captureErrors.length, 1);
});

test("events from a stale recording cannot mutate active state", async () => {
  const storage = memoryState();
  const coordinator = createRecordingCoordinator({
    ...storage,
    now: () => 1000,
    timeoutMs: 120000,
  });
  await coordinator.begin({ recordingId: "rec-12345678", frameIds: [0] });
  await assert.rejects(
    coordinator.markFailed({
      recordingId: "old-recording",
      frameId: 0,
      message: "stale",
    }),
    /录制会话不匹配/
  );
  assert.deepEqual((await storage.loadState()).pendingFrameIds, [0]);
});

test("heartbeat persists UI progress in the same state transition", async () => {
  const storage = memoryState();
  const coordinator = createRecordingCoordinator({
    ...storage,
    now: () => 1000,
    timeoutMs: 120000,
  });
  await coordinator.begin({ recordingId: "rec-12345678", frameIds: [0] });
  await coordinator.heartbeat({
    recordingId: "rec-12345678",
    frameId: 0,
    patch: { fillHint: "正在补全", fillRemain: 12 },
  });
  const state = await storage.loadState();
  assert.equal(state.fillHint, "正在补全");
  assert.equal(state.fillRemain, 12);
});

test("ready event persists page errors without losing completion", async () => {
  const storage = memoryState();
  const coordinator = createRecordingCoordinator({
    ...storage,
    now: () => 1000,
    timeoutMs: 120000,
  });
  await coordinator.begin({ recordingId: "rec-12345678", frameIds: [0] });
  await coordinator.markReady({
    recordingId: "rec-12345678",
    frameId: 0,
    errors: [{ code: "GAP_FILL_FAILED", message: "timeout", videoId: "v1" }],
  });
  const state = await storage.loadState();
  assert.deepEqual(state.pendingFrameIds, []);
  assert.equal(state.captureErrors[0].code, "GAP_FILL_FAILED");
});
