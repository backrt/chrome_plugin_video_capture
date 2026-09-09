(() => {
  if (globalThis.__videoCaptureContentV3) return;
  globalThis.__videoCaptureContentV3 = true;

  const PIPE = globalThis.PAGE_CHANNEL;
  const M = globalThis.MSG;
  const T = globalThis.TARGET;

  let pendingStart = null;
  let pendingStop = null;
  let protocol = null;
  let recordingId = "";
  let frameKey = "";
  let bridgeToken = "";
  let protocolError = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target && message.target !== T.CONTENT) return;
    const task = handleContentMessage(message);
    if (task) {
      task.then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
      return true;
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (
      !data ||
      data.channel !== PIPE ||
      data.from !== "page" ||
      !bridgeToken ||
      data.bridgeToken !== bridgeToken
    ) {
      return;
    }
    handlePageMessage(data);
  });

  async function handleContentMessage(message) {
    switch (message.type) {
      case M.START_RECORDING:
        return startRecording(message);
      case M.STOP_RECORDING:
        return stopRecording(message);
      default:
        return undefined;
    }
  }

  function handlePageMessage(data) {
    if (data.type === "LOG") {
      forwardLog(data.message, data.extra);
      return;
    }
    if (data.type === "CHUNK") {
      rememberProtocolTask(protocol && protocol.chunk(data));
      return;
    }
    if (data.type === "REGISTER") {
      rememberProtocolTask(protocol && protocol.register(data));
      return;
    }
    if (data.type === "PROGRESS") {
      if (pendingStop && typeof pendingStop.heartbeat === "function") {
        pendingStop.heartbeat(data.remainSec);
      }
      chrome.runtime
        .sendMessage({
          type: M.FILL_PROGRESS,
          target: T.BACKGROUND,
          recordingId,
          message: data.message || "",
          remainSec: data.remainSec || 0,
        })
        .catch(() => {});
      return;
    }
    if (data.type === "STARTED" && pendingStart) {
      pendingStart.resolve({
        ok: true,
        mimeType: data.mimeType || "",
        videoName:
          data.videoName ||
          (data.videos && data.videos[0] && data.videos[0].videoName) ||
          "",
        videos: data.videos || [],
      });
      pendingStart = null;
      return;
    }
    if (data.type === "STOPPED" && pendingStop) {
      pendingStop.resolve({
        ok: true,
        mimeType: data.mimeType || "",
        byteCount: data.byteCount || 0,
        videos: data.videos || [],
        errors: data.errors || [],
      });
      pendingStop = null;
      return;
    }
    if (data.type === "ERROR") {
      const error = new Error(data.error || "页面录制失败");
      if (pendingStart) {
        pendingStart.reject(error);
        pendingStart = null;
      }
      if (pendingStop) {
        pendingStop.reject(error);
        pendingStop = null;
      }
    }
  }

  async function startRecording(message) {
    resetBridge();
    recordingId = String(message.recordingId || "");
    frameKey = String(message.frameKey ?? "");
    bridgeToken = String(message.bridgeToken || "");
    if (!validateRecordingId(recordingId) || !frameKey || !bridgeToken) {
      throw new Error("录制桥接参数无效");
    }
    protocol = createFrameProtocol({
      recordingId,
      frameKey,
      bridgeToken,
      send: (payload) => chrome.runtime.sendMessage(payload),
    });
    try {
      const started = waitForPage("start");
      postToPage(M.START_RECORDING);
      const result = await started;
      await protocol.drain();
      if (protocolError) throw protocolError;
      return result;
    } catch (error) {
      resetBridge();
      throw error;
    }
  }

  async function stopRecording(message) {
    if (!protocol || message.recordingId !== recordingId) {
      throw new Error("录制会话已经失效");
    }
    const stopped = waitForPage("stop");
    postToPage(M.STOP_RECORDING);
    stopped
      .then(async (result) => {
        if (protocolError) throw protocolError;
        await protocol.flush(result);
        await chrome.runtime.sendMessage({
          type: M.RECORDING_READY,
          target: T.BACKGROUND,
          recordingId,
          mimeType: result.mimeType || "",
          videos: result.videos || [],
          errors: result.errors || [],
          byteCount: result.byteCount || 0,
        });
      })
      .catch((error) => {
        forwardLog("stop-failed", { error: error.message || String(error) });
        chrome.runtime
          .sendMessage({
            type: M.RECORDING_FAILED,
            target: T.BACKGROUND,
            recordingId,
            error: error.message || "停止失败",
          })
          .catch(() => {});
      });
    return { ok: true };
  }

  function rememberProtocolTask(task) {
    if (!task || typeof task.catch !== "function") {
      if (!protocolError) protocolError = new Error("录制写入协议未初始化");
      return;
    }
    task.catch((error) => {
      if (!protocolError) protocolError = error;
      forwardLog("offscreen-write-failed", {
        error: error.message || String(error),
      });
    });
  }

  function waitForPage(kind) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          reject(
            new Error(
              kind === "start" ? "页面脚本没有开始录制" : "页面脚本没有停止录制"
            )
          );
        }, ms);
      };
      arm(kind === "stop" ? 120000 : 8000);
      const wrap = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        heartbeat: (remainSec) => {
          const extra = Number.isFinite(remainSec)
            ? remainSec * 1000 + 60000
            : 120000;
          arm(Math.min(Math.max(extra, 120000), 8 * 3600 * 1000));
        },
      };
      if (kind === "start") pendingStart = wrap;
      else pendingStop = wrap;
    });
  }

  function postToPage(type) {
    window.postMessage(
      {
        channel: PIPE,
        from: "isolated",
        type,
        bridgeToken,
      },
      "*"
    );
  }

  function forwardLog(message, extra) {
    console.log("[VideoCapture][content]", message, extra || "");
    chrome.runtime
      .sendMessage({
        type: M.DEBUG_LOG,
        target: T.BACKGROUND,
        recordingId,
        scope: "content",
        message,
        extra,
      })
      .catch(() => {});
  }

  function resetBridge() {
    pendingStart = null;
    pendingStop = null;
    protocol = null;
    protocolError = null;
    recordingId = "";
    frameKey = "";
    bridgeToken = "";
  }
})();
