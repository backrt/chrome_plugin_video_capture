importScripts("shared.js", "recording-coordinator.js");

const SESSION_KEY = "recorderState";
const FRAME_TIMEOUT_MS = 120000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_ALARM_PREFIX = "vc-frame-timeout:";

let badgeTimer = null;
let finalizePromise = null;
let offscreenCreatingPromise = null;

const coordinator = createRecordingCoordinator({
  loadState: getState,
  saveState: setState,
  now: Date.now,
  timeoutMs: FRAME_TIMEOUT_MS,
});

chrome.runtime.onInstalled.addListener(() => {
  resetUi().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  resetUi().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== TARGET.BACKGROUND) return;
  const task = handleBackgroundMessage(message, sender);
  if (task) {
    task.then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(TIMEOUT_ALARM_PREFIX)) return;
  handleFrameTimeout(alarm.name.slice(TIMEOUT_ALARM_PREFIX.length)).catch(() => {});
});

async function handleBackgroundMessage(message, sender) {
  switch (message.type) {
    case MSG.GET_STATE: {
      const state = await getState();
      if (state.status === STATUS.RECORDING && state.startTime && !badgeTimer) {
        startBadge(state.startTime);
      }
      if (state.finalizing && state.recordingId) {
        finalizeAndDownload(state.recordingId).catch(() => {});
      }
      return state;
    }
    case MSG.GET_LOGS:
      return getLogs();
    case MSG.DEBUG_LOG:
      await debugLog(message.scope || "page", message.message, message.extra);
      return { ok: true };
    case MSG.OPEN_DOWNLOAD_FOLDER:
      return openDownloadFolder();
    case MSG.START_RECORDING:
      return startRecording(message.tabId);
    case MSG.STOP_RECORDING:
      return stopRecording();
    case MSG.RECORDING_READY:
      return onFrameReady(message, sender);
    case MSG.RECORDING_FAILED:
      return onFrameFailed(message, sender);
    default:
      return undefined;
  }
}

async function startRecording(tabId) {
  const current = await getState();
  if (current.status === STATUS.RECORDING || current.status === STATUS.STOPPING) {
    throw new Error(
      i18nMessage("alreadyRecordingStopFirst", "已在录制中，请先停止")
    );
  }
  if (!tabId) {
    throw new Error(i18nMessage("activeTabMissing", "找不到当前标签页"));
  }

  await chrome.storage.session.set({ [DEBUG_LOG_KEY]: [] });
  const recordingId = crypto.randomUUID();
  const bridgeToken = crypto.randomUUID();
  await debugLog("sw", "start-requested", { tabId, recordingId });
  await ensureOffscreen();
  await requireOffscreen({ type: MSG.RESET_RECORDING, recordingId });
  await injectContent(tabId);
  const frameIds = await findVideoFrames(tabId);
  await debugLog("sw", "video-frames", { frameIds });

  const startedVideos = [];
  const startedFrameIds = [];
  const startWarnings = [];
  for (const frameId of frameIds) {
    try {
      const result = await sendToContent(tabId, frameId, {
        type: MSG.START_RECORDING,
        recordingId,
        frameKey: String(frameId),
        bridgeToken,
      });
      if (result && result.ok && (result.videos || []).length) {
        startedFrameIds.push(frameId);
        startedVideos.push(...result.videos);
      } else {
        const error =
          (result && result.error) ||
          i18nMessage("pageSessionMissing", "页面没有返回可录制会话");
        startWarnings.push({ frameId, code: "FRAME_START_FAILED", message: error });
        await debugLog("sw", "frame-start-failed", { frameId, error });
      }
    } catch (error) {
      const message = error.message || String(error);
      startWarnings.push({ frameId, code: "FRAME_START_FAILED", message });
      await debugLog("sw", "frame-start-failed", { frameId, error: message });
    }
  }

  if (!startedVideos.length) {
    await requireOffscreen({ type: MSG.CLEANUP_RECORDING, recordingId }).catch(() => {});
    throw new Error(
      startWarnings[0]?.message ||
        i18nMessage("videoFoundStartFailed", "找到了视频，但无法开始录制")
    );
  }

  const next = await coordinator.begin({
    ...idleState(),
    status: STATUS.RECORDING,
    recordingId,
    tabId,
    frameId: startedFrameIds[0],
    frameIds: startedFrameIds,
    startTime: Date.now(),
    mimeType: startedVideos[0]?.mimeType || "",
    videoName: startedVideos[0]?.videoName || "",
    videoCount: startedVideos.length,
    startWarnings,
    result: "",
    resultMessage: "",
    error: "",
  });
  startBadge(next.startTime);
  await broadcastState(next);
  return { ok: true, state: next };
}

async function stopRecording() {
  let state = await getState();
  if (state.status !== STATUS.RECORDING) {
    throw new Error(
      i18nMessage("noActiveRecording", "当前没有进行中的录制")
    );
  }
  state = {
    ...state,
    status: STATUS.STOPPING,
    finalizing: false,
  };
  await setState(state);
  for (const frameId of state.pendingFrameIds || []) {
    state = await coordinator.heartbeat({
      recordingId: state.recordingId,
      frameId,
    });
  }
  await broadcastState(state);
  await scheduleFrameTimeout(state);

  await Promise.all(
    (state.pendingFrameIds || []).map(async (frameId) => {
      try {
        await sendToContent(state.tabId, frameId, {
          type: MSG.STOP_RECORDING,
          recordingId: state.recordingId,
        });
      } catch (error) {
        await markFrameFailed(state.recordingId, frameId, {
          code: "FRAME_UNREACHABLE",
          message: error.message || String(error),
        });
      }
    })
  );
  await maybeFinalize(state.recordingId);
  return { ok: true };
}

async function onFrameReady(message, sender) {
  const frameId = senderFrameId(sender);
  const state = await getState();
  if (message.recordingId !== state.recordingId || !Number.isInteger(frameId)) {
    return { ok: false, ignored: true };
  }
  const next = await coordinator.markReady({
    recordingId: state.recordingId,
    frameId,
    errors: message.errors || [],
  });
  await debugLog("sw", "frame-ready", {
    frameId,
    pending: next.pendingFrameIds.length,
    errors: (message.errors || []).length,
  });
  await scheduleFrameTimeout(next);
  await broadcastState(next);
  await maybeFinalize(state.recordingId);
  return { ok: true };
}

async function onFrameFailed(message, sender) {
  const frameId = senderFrameId(sender);
  const state = await getState();
  if (message.recordingId !== state.recordingId || !Number.isInteger(frameId)) {
    return { ok: false, ignored: true };
  }
  await markFrameFailed(state.recordingId, frameId, {
    code: "FRAME_RECORDING_FAILED",
    message:
      message.error || i18nMessage("frameRecordingFailed", "frame 录制失败"),
  });
  await maybeFinalize(state.recordingId);
  return { ok: true };
}

async function markFrameFailed(recordingId, frameId, error) {
  const next = await coordinator.markFailed({
    recordingId,
    frameId,
    code: error.code,
    message: error.message,
  });
  await debugLog("sw", "frame-failed", { frameId, ...error });
  await scheduleFrameTimeout(next);
  await broadcastState(next);
  return next;
}

async function handleFrameTimeout(recordingId) {
  const state = await getState();
  if (
    state.status !== STATUS.STOPPING ||
    state.recordingId !== recordingId ||
    state.finalizing
  ) {
    return;
  }
  const expired = await coordinator.expiredFrames();
  for (const frameId of expired) {
    await markFrameFailed(recordingId, frameId, {
      code: "FRAME_TIMEOUT",
      message: i18nMessage("frameStopTimeout", "frame 停止录制超时"),
    });
  }
  await maybeFinalize(recordingId);
  await scheduleFrameTimeout(await getState());
}

async function handleTabRemoved(tabId) {
  let state = await getState();
  if (
    state.tabId !== tabId ||
    (state.status !== STATUS.RECORDING && state.status !== STATUS.STOPPING)
  ) {
    return;
  }
  if (state.status === STATUS.RECORDING) {
    state = { ...state, status: STATUS.STOPPING };
    await setState(state);
  }
  for (const frameId of state.pendingFrameIds || []) {
    await markFrameFailed(state.recordingId, frameId, {
      code: "TAB_CLOSED",
      message: i18nMessage("tabClosed", "标签页已关闭"),
    });
  }
  await maybeFinalize(state.recordingId);
}

async function maybeFinalize(recordingId) {
  if (await coordinator.canFinalize()) {
    return finalizeAndDownload(recordingId);
  }
  return { ok: true, waiting: true };
}

async function finalizeAndDownload(recordingId) {
  if (finalizePromise) return finalizePromise;
  finalizePromise = runFinalizeAndDownload(recordingId).finally(() => {
    finalizePromise = null;
  });
  return finalizePromise;
}

async function runFinalizeAndDownload(recordingId) {
  let state = await getState();
  if (state.recordingId !== recordingId) return { ok: false, ignored: true };
  await clearFrameTimeout(recordingId);
  state = {
    ...state,
    status: STATUS.STOPPING,
    finalizing: true,
  };
  await setState(state);
  await broadcastState(state);

  const errors = [
    ...(state.startWarnings || []),
    ...(state.failedFrames || []),
    ...(state.captureErrors || []),
  ];
  let savedCount = 0;
  let lastDownloadId = null;
  try {
    const index = await requireOffscreen({
      type: MSG.FINALIZE_RECORDING,
      recordingId,
    });
    const result = await downloadAllGroups(state, index.groups || []);
    savedCount = result.savedCount;
    lastDownloadId = result.lastDownloadId;
    errors.push(...result.errors);
  } catch (error) {
    errors.push({
      code: "FINALIZE_FAILED",
      message: error.message || String(error),
    });
  }

  if (Number.isInteger(lastDownloadId)) {
    await chrome.storage.local.set({ [LAST_DOWNLOAD_KEY]: lastDownloadId });
  }
  try {
    await requireOffscreen({ type: MSG.CLEANUP_RECORDING, recordingId });
  } catch (error) {
    await debugLog("sw", "cleanup-failed", { error: error.message || String(error) });
  }
  await closeOffscreen();

  const result = savedCount > 0 ? (errors.length ? "partial" : "success") : "failure";
  const resultMessage =
    result === "success"
      ? i18nMessage("savedVideoCount", "已保存 $1 个视频", savedCount)
      : result === "partial"
        ? i18nMessage(
            "partialSavedVideoCount",
            "已保存 $1 个视频，但有 $2 项未完成",
            [savedCount, errors.length]
          )
        : errors[0]?.message ||
          i18nMessage("noSavableRecording", "没有可保存的录制内容");
  await finishIdle(result === "failure" ? resultMessage : "", {
    result,
    resultMessage,
    failedFrames: state.failedFrames || [],
    captureErrors: errors,
  });
  return { ok: result !== "failure", result, savedCount, errors };
}

async function downloadAllGroups(state, groups) {
  if (!chrome.downloads || typeof chrome.downloads.download !== "function") {
    throw new Error(
      i18nMessage(
        "downloadApiUnavailable",
        "下载接口不可用，请重新加载扩展后重试"
      )
    );
  }
  const stampDate = new Date();
  const usedNames = new Set();
  const errors = [];
  let savedCount = 0;
  let lastDownloadId = null;
  let index = 1;

  for (const group of groups) {
    const usable = selectUsableSegments(group, MIN_SAVE_BYTES);
    if (!usable.length) {
      errors.push({
        code: "SMALL_FILE",
        message: i18nMessage("recordingTooSmall", "录制片段过小，已跳过"),
      });
      continue;
    }
    const groupId = usable[0].groupId;
    const mimeType = usable[0].mimeType || state.mimeType || "video/webm";
    const name = uniqueVideoName(usable[0].videoName, index, usedNames);
    index += 1;
    try {
      let opfsName = usable[0].opfsName;
      if (usable.length > 1 && !mimeType.includes("webm")) {
        throw new Error(
          i18nMessage("mp4MergeUnsupported", "不支持拼接 MP4 分片")
        );
      }
      if (mimeType.includes("webm")) {
        const merged = await requireOffscreen({
          type: MSG.MERGE_SEGMENTS,
          recordingId: state.recordingId,
          groupId,
          mimeType,
          parts: usable.map((item) => ({
            opfsName: item.opfsName,
            rangeStart: item.rangeStart,
            rangeEnd: item.rangeEnd,
            recordedDurationSec: item.recordedDurationSec,
            webmIndex: item.webmIndex || [],
          })),
        });
        opfsName = merged.opfsName;
      }
      const prepared = await requireOffscreen({
        type: MSG.CREATE_DOWNLOAD_URL,
        mimeType,
        opfsName,
      });
      const downloadId = await chrome.downloads.download({
        url: prepared.url,
        filename: buildFilename(mimeType, stampDate, name),
        saveAs: false,
      });
      if (!Number.isInteger(downloadId)) {
        throw new Error(
          i18nMessage("downloadTaskCreationFailed", "下载任务创建失败")
        );
      }
      const saved = await waitForDownload(downloadId);
      await sendToExistingOffscreen({ type: MSG.REVOKE_DOWNLOAD_URL }).catch(() => {});
      if (!saved || saved.state !== "complete" || saved.exists === false) {
        throw new Error(
          i18nMessage(
            "downloadNotCompleted",
            "下载未完成，磁盘上没有保存到文件"
          )
        );
      }
      savedCount += 1;
      lastDownloadId = downloadId;
      await debugLog("sw", "download-complete", {
        id: downloadId,
        filename: saved.filename,
        groupId,
      });
    } catch (error) {
      errors.push({
        code: "GROUP_SAVE_FAILED",
        message: error.message || String(error),
        groupId,
      });
      await debugLog("sw", "group-save-failed", {
        groupId,
        error: error.message || String(error),
      });
    }
  }
  return { savedCount, lastDownloadId, errors };
}

async function injectContent(tabId) {
  await injectWorldIfNeeded(tabId, "MAIN", "__videoCapturePageV3", [
    "shared.js",
    "page-recorder.js",
  ]);
  await injectWorldIfNeeded(tabId, "ISOLATED", "__videoCaptureContentV3", [
    "shared.js",
    "content-protocol.js",
    "content.js",
  ]);
}

async function injectWorldIfNeeded(tabId, world, flagName, files) {
  const checks = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world,
    func: (key) => !globalThis[key],
    args: [flagName],
  });
  const frameIds = checks.filter((item) => item.result).map((item) => item.frameId);
  if (!frameIds.length) return;
  await chrome.scripting.executeScript({
    target: { tabId, frameIds },
    world,
    files,
  });
}

async function findVideoFrames(tabId) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const videos = [];
      const walk = (root) => {
        videos.push(...root.querySelectorAll("video"));
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) walk(element.shadowRoot);
        }
      };
      walk(document);
      return videos.filter((video) => {
        const rect = video.getBoundingClientRect();
        return Math.max(0, rect.width) * Math.max(0, rect.height) >= 100 * 100;
      }).length;
    },
  });
  const frameIds = injections
    .filter((item) => item.result > 0)
    .map((item) => item.frameId);
  if (!frameIds.length) {
    throw new Error(
      i18nMessage("noRecordableVideo", "当前页面没有可录制的视频")
    );
  }
  return frameIds;
}

async function sendToContent(tabId, frameId, payload) {
  const options = Number.isInteger(frameId) ? { frameId } : {};
  try {
    return await chrome.tabs.sendMessage(
      tabId,
      { ...payload, target: TARGET.CONTENT },
      options
    );
  } catch {
    await delay(80);
    return chrome.tabs.sendMessage(
      tabId,
      { ...payload, target: TARGET.CONTENT },
      options
    );
  }
}

function senderFrameId(sender) {
  return Number.isInteger(sender && sender.frameId) ? sender.frameId : null;
}

function uniqueVideoName(videoName, index, usedNames) {
  const base = sanitizeFileBase(videoName) || `video-${index}`;
  let name = base;
  let suffix = 2;
  while (usedNames.has(name.toLowerCase())) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

async function openDownloadFolder() {
  const stored = await chrome.storage.local.get(LAST_DOWNLOAD_KEY);
  const lastId = stored[LAST_DOWNLOAD_KEY];
  if (Number.isInteger(lastId)) {
    const items = await chrome.downloads.search({ id: lastId });
    if (items[0] && items[0].exists !== false) {
      chrome.downloads.show(lastId);
      return { ok: true };
    }
  }
  const recent = await chrome.downloads.search({
    filenameRegex: "video-capture[/\\\\]",
    orderBy: ["-startTime"],
    limit: 10,
  });
  const file = recent.find((item) => item.exists !== false);
  if (file) chrome.downloads.show(file.id);
  else chrome.downloads.showDefaultFolder();
  return { ok: true };
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });
  if (existing.length) return;
  if (!offscreenCreatingPromise) {
    offscreenCreatingPromise = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Persist recording chunks and create download URLs",
      })
      .finally(() => {
        offscreenCreatingPromise = null;
      });
  }
  await offscreenCreatingPromise;
}

async function requireOffscreen(payload) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    ...payload,
    target: TARGET.OFFSCREEN,
  });
  if (!response || response.ok === false) {
    throw new Error(
      (response && response.error) ||
        i18nMessage("offscreenOperationFailed", "Offscreen 操作失败")
    );
  }
  return response;
}

async function sendToExistingOffscreen(payload) {
  return chrome.runtime.sendMessage({ ...payload, target: TARGET.OFFSCREEN });
}

async function closeOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    });
    if (existing.length) await chrome.offscreen.closeDocument();
  } catch {
    // The document may already be closed.
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      const items = await chrome.downloads.search({ id: downloadId });
      resolve(items[0] || null);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") {
        finish();
      }
    };
    const timer = setTimeout(finish, DOWNLOAD_TIMEOUT_MS);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items[0];
      if (item && (item.state === "complete" || item.state === "interrupted")) finish();
    });
  });
}

async function scheduleFrameTimeout(state) {
  if (
    !state ||
    state.status !== STATUS.STOPPING ||
    state.finalizing ||
    !(state.pendingFrameIds || []).length
  ) {
    if (state && state.recordingId) await clearFrameTimeout(state.recordingId);
    return;
  }
  const deadlines = state.pendingFrameIds.map((frameId) => {
    const last = Number(state.lastProgressAt && state.lastProgressAt[frameId]);
    return (Number.isFinite(last) ? last : Date.now()) + FRAME_TIMEOUT_MS;
  });
  await chrome.alarms.create(`${TIMEOUT_ALARM_PREFIX}${state.recordingId}`, {
    when: Math.max(Date.now() + 1000, Math.min(...deadlines)),
  });
}

async function clearFrameTimeout(recordingId) {
  await chrome.alarms.clear(`${TIMEOUT_ALARM_PREFIX}${recordingId}`);
}

async function debugLog(scope, message, extra) {
  const line = {
    at: new Date().toISOString(),
    scope,
    message,
    extra: extra || null,
  };
  console.log("[VideoCapture]", scope, message, extra || "");
  const stored = await chrome.storage.session.get(DEBUG_LOG_KEY);
  const logs = stored[DEBUG_LOG_KEY] || [];
  logs.push(line);
  await chrome.storage.session.set({ [DEBUG_LOG_KEY]: logs.slice(-100) });
}

async function getLogs() {
  const stored = await chrome.storage.session.get(DEBUG_LOG_KEY);
  return stored[DEBUG_LOG_KEY] || [];
}

async function finishIdle(error, terminal) {
  stopBadge();
  const state = { ...idleState(error), ...(terminal || {}) };
  await setState(state);
  await broadcastState(state);
}

async function getState() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || idleState();
}

async function setState(state) {
  await chrome.storage.session.set({ [SESSION_KEY]: state });
}

async function broadcastState(state) {
  const current = state || (await getState());
  try {
    await chrome.runtime.sendMessage({
      type: MSG.STATE_CHANGED,
      target: TARGET.POPUP,
      state: current,
    });
  } catch {
    // Popup may be closed.
  }
}

function startBadge(startTime) {
  stopBadge();
  chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  }
  const tick = () => {
    chrome.action.setBadgeText({ text: formatBadge(Date.now() - startTime) });
  };
  tick();
  badgeTimer = setInterval(tick, 1000);
}

function stopBadge() {
  if (badgeTimer) clearInterval(badgeTimer);
  badgeTimer = null;
  chrome.action.setBadgeText({ text: "" });
}

async function resetUi() {
  stopBadge();
  const state = await getState();
  if (state.recordingId) {
    try {
      await requireOffscreen({
        type: MSG.CLEANUP_RECORDING,
        recordingId: state.recordingId,
      });
    } catch {
      // Cleanup will be retried on the next recording reset.
    }
  }
  await closeOffscreen();
  await setState(idleState());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
