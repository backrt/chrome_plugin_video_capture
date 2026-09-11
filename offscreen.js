let objectUrl = null;

const recordingStore = createRecordingStore({
  getDirectory: getStorageDirectory,
  decodeBase64: base64ToBytes,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target && message.target !== TARGET.OFFSCREEN) return;

  const task = handleOffscreenRequest(message);
  if (task) {
    task.then(sendResponse);
    return true;
  }
});

globalThis.__videoCaptureInlineOffscreenV1 = handleOffscreenRequest;

async function handleOffscreenRequest(message) {
  try {
    const result = await handleMessage(message);
    return { ok: true, ...(result || {}) };
  } catch (error) {
    return {
      ok: false,
      code: error.code || "OFFSCREEN_ERROR",
      error: error.message || String(error),
    };
  }
}

async function handleMessage(message) {
  switch (message.type) {
    case MSG.RESET_RECORDING:
      revoke();
      return recordingStore.reset(message.recordingId);
    case MSG.REGISTER_SEGMENT:
      return recordingStore.register(message);
    case MSG.WRITE_CHUNK:
      return recordingStore.writeChunk(message);
    case MSG.FLUSH_FRAME:
      return recordingStore.flushFrame(message.recordingId, message.frameKey);
    case MSG.FINALIZE_RECORDING:
      return recordingStore.finalize(message.recordingId);
    case MSG.GET_RECORDING_INDEX:
      return recordingStore.getIndex(message.recordingId);
    case MSG.CLEANUP_RECORDING:
      revoke();
      return recordingStore.cleanup(message.recordingId);
    case MSG.CREATE_DOWNLOAD_URL:
      return createDownloadUrl(message.mimeType, message.opfsName);
    case MSG.REVOKE_DOWNLOAD_URL:
      revoke();
      return {};
    case MSG.MERGE_SEGMENTS:
      return mergeSegments(message);
    default:
      return undefined;
  }
}

async function createDownloadUrl(mimeType, opfsName) {
  revoke();
  const root = await getStorageDirectory();
  const handle = await root.getFileHandle(opfsName);
  const file = await handle.getFile();
  if (!file.size) throw new Error(i18nMessage("cachedFileEmpty", "缓存文件为空"));
  const blob = new Blob([file], { type: mimeType || file.type || "video/webm" });
  objectUrl = URL.createObjectURL(blob);
  return { url: objectUrl, size: file.size };
}

async function mergeSegments(message) {
  const recordingId = String(message.recordingId || "");
  if (!validateRecordingId(recordingId)) {
    throw new Error(i18nMessage("invalidRecordingId", "录制 ID 无效"));
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (!parts.length) {
    throw new Error(i18nMessage("noSegmentsToMerge", "没有可拼接的片段"));
  }
  const mimeType = String(message.mimeType || "");
  if (parts.length > 1 && !mimeType.includes("webm")) {
    throw new Error(i18nMessage("mp4MergeUnsupported", "不支持拼接 MP4 分片"));
  }

  const root = await getStorageDirectory();
  const sources = [];
  for (const part of parts) {
    const handle = await root.getFileHandle(part.opfsName);
    const file = await handle.getFile();
    if (!file.size) continue;
    sources.push({
      file,
      durationSec:
        Number(part.recordedDurationSec) > 0
          ? Number(part.recordedDurationSec)
          : Math.max(
              0,
              Number(part.rangeEnd || 0) - Number(part.rangeStart || 0)
            ),
      webmIndex: Array.isArray(part.webmIndex) ? part.webmIndex : [],
    });
  }
  if (!sources.length) {
    throw new Error(i18nMessage("segmentFileEmpty", "片段文件为空"));
  }

  const outName = `merged-${safeIdPart(recordingId)}-${safeIdPart(
    message.groupId || "group",
    160
  )}.bin`;
  try {
    await root.removeEntry(outName);
  } catch {
    // File may not exist.
  }
  const outHandle = await root.getFileHandle(outName, { create: true });
  const writable = await outHandle.createWritable();
  try {
    const result = await finalizeWebmFiles(sources, writable);
    await writable.close();
    return {
      opfsName: outName,
      size: result.size,
      cueCount: result.cueCount,
      durationUnits: result.durationUnits,
    };
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

function revoke() {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

function getStorageDirectory() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
    throw new Error(
      i18nMessage(
        "opfsUnsupported",
        "当前浏览器版本不支持本地录制缓存，请升级浏览器后重试"
      )
    );
  }
  return navigator.storage.getDirectory();
}
