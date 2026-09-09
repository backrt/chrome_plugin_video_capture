(function (g) {
  if (g.__vcRecordingCoordinatorV1) return;
  g.__vcRecordingCoordinatorV1 = true;

  function createRecordingCoordinator(options) {
    const loadState = options && options.loadState;
    const saveState = options && options.saveState;
    const now = (options && options.now) || Date.now;
    const timeoutMs = Number(options && options.timeoutMs) || 120000;
    if (typeof loadState !== "function" || typeof saveState !== "function") {
      throw new Error("录制协调器存储无效");
    }

    let transitionQueue = Promise.resolve();

    function transition(change) {
      const operation = transitionQueue.then(async () => {
        const current = await loadState();
        const next = await change(current);
        if (next) await saveState(next);
        return next || current;
      });
      transitionQueue = operation.catch(() => {});
      return operation;
    }

    function begin(recording) {
      return transition(async (current) => {
        const recordingId = String(recording && recording.recordingId);
        if (!validateRecordingId(recordingId)) throw new Error("录制 ID 无效");
        const frameIds = [...new Set(recording.frameIds || [])]
          .map(Number)
          .filter(Number.isInteger);
        const timestamp = now();
        const lastProgressAt = {};
        for (const frameId of frameIds) lastProgressAt[frameId] = timestamp;
        return {
          ...(current || {}),
          ...recording,
          recordingId,
          frameIds,
          pendingFrameIds: [...frameIds],
          completedFrameIds: [],
          failedFrames: [],
          captureErrors: [],
          lastProgressAt,
        };
      });
    }

    function markReady(event) {
      return transition(async (state) => {
        assertActive(state, event && event.recordingId);
        const wasPending = (state.pendingFrameIds || []).includes(
          Number(event.frameId)
        );
        const next = nextFrameState(state, {
          type: "ready",
          frameId: event.frameId,
        });
        const incoming =
          wasPending && Array.isArray(event.errors) ? event.errors : [];
        return {
          ...next,
          captureErrors: [
            ...(state.captureErrors || []),
            ...incoming.slice(0, 50).map((error) => ({
              frameId: Number(event.frameId),
              code: String((error && error.code) || "CAPTURE_ERROR").slice(0, 64),
              message: String((error && error.message) || "录制失败").slice(0, 500),
              videoId: String((error && error.videoId) || "").slice(0, 128),
            })),
          ],
        };
      });
    }

    function markFailed(event) {
      return transition(async (state) => {
        assertActive(state, event && event.recordingId);
        return nextFrameState(state, {
          type: "failed",
          frameId: event.frameId,
          code: event.code,
          message: event.message,
        });
      });
    }

    function heartbeat(event) {
      return transition(async (state) => {
        assertActive(state, event && event.recordingId);
        const frameId = Number(event.frameId);
        if (!state.pendingFrameIds.includes(frameId)) return state;
        return {
          ...state,
          ...(event.patch && typeof event.patch.fillHint === "string"
            ? { fillHint: event.patch.fillHint.slice(0, 500) }
            : {}),
          ...(event.patch && Number.isFinite(event.patch.fillRemain)
            ? { fillRemain: Math.max(0, event.patch.fillRemain) }
            : {}),
          lastProgressAt: {
            ...(state.lastProgressAt || {}),
            [frameId]: now(),
          },
        };
      });
    }

    async function expiredFrames() {
      await transitionQueue;
      const state = await loadState();
      if (!state) return [];
      const timestamp = now();
      return (state.pendingFrameIds || []).filter((frameId) => {
        const last = Number(state.lastProgressAt && state.lastProgressAt[frameId]);
        return !Number.isFinite(last) || timestamp - last >= timeoutMs;
      });
    }

    async function canFinalize() {
      await transitionQueue;
      const state = await loadState();
      return Boolean(state && Array.isArray(state.pendingFrameIds) && !state.pendingFrameIds.length);
    }

    function assertActive(state, recordingId) {
      if (!state || state.recordingId !== recordingId) {
        throw new Error("录制会话不匹配");
      }
    }

    return {
      begin,
      markReady,
      markFailed,
      heartbeat,
      expiredFrames,
      canFinalize,
    };
  }

  g.createRecordingCoordinator = createRecordingCoordinator;
})(typeof globalThis !== "undefined" ? globalThis : this);
