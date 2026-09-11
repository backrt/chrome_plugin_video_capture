(() => {
  if (globalThis.__videoCaptureContentV3) return;
  globalThis.__videoCaptureContentV3 = true;

  const PIPE = globalThis.PAGE_CHANNEL;
  const M = globalThis.MSG;
  const T = globalThis.TARGET;
  const PAGE_I18N_FALLBACKS = {
    alreadyRecording: "已在录制中",
    noRecordableVideo: "当前页面没有可录制的视频",
    foundVideosCannotCapture: "找到 $1 个视频，但无法捕获画面",
    recordingSessionFull: "录制会话已满",
    videoAlreadyRecording: "该视频已在录制中",
    noSupportedFormat: "当前浏览器没有可用的录制格式",
    noVideoTrack: "找到了视频，但没有可捕获的画面轨道（可能受保护）",
    recorderInactive: "MediaRecorder 启动后仍是 inactive",
    recorderStartFailed: "无法启动 MediaRecorder",
    captureStreamUnsupported: "当前浏览器不支持 video.captureStream()",
    captureNotAllowed: "当前视频不允许捕获（可能受保护）",
    captureElementFailed: "无法从视频元素捕获",
  };

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
      const error = new Error(
        data.error || i18nMessage("pageRecordingFailed", "页面录制失败")
      );
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
      throw new Error(i18nMessage("invalidBridgeParams", "录制桥接参数无效"));
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
      throw new Error(i18nMessage("recordingSessionExpired", "录制会话已经失效"));
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
            error: error.message || i18nMessage("stopFailed", "停止失败"),
          })
          .catch(() => {});
      });
    return { ok: true };
  }

  function rememberProtocolTask(task) {
    if (!task || typeof task.catch !== "function") {
      if (!protocolError) {
        protocolError = new Error(
          i18nMessage("writeProtocolNotReady", "录制写入协议未初始化")
        );
      }
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
              kind === "start"
                ? i18nMessage("pageStartTimeout", "页面脚本没有开始录制")
                : i18nMessage("pageStopTimeout", "页面脚本没有停止录制")
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
        localeMessages:
          type === M.START_RECORDING ? resolvedPageMessages() : undefined,
      },
      "*"
    );
  }

  function resolvedPageMessages() {
    return Object.fromEntries(
      Object.entries(PAGE_I18N_FALLBACKS).map(([key, fallback]) => {
        const indexes = [...fallback.matchAll(/\$(\d+)/g)].map((match) =>
          Number(match[1])
        );
        const markers = ["__VC_SUB_1__", "__VC_SUB_2__"].slice(
          0,
          indexes.length ? Math.max(...indexes) : 0
        );
        const translated = i18nMessage(key, fallback, markers);
        return [
          key,
          markers.reduce(
            (text, marker, index) => text.replaceAll(marker, `$${index + 1}`),
            translated
          ),
        ];
      })
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
