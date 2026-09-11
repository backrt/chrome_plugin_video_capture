(function (g) {
  if (g.__vcSharedV3) return;
  g.__vcSharedV3 = true;

const TIMESLICE_MS = 2000;
const VIDEO_BITS_PER_SECOND = 8_000_000;
const MIN_VIDEO_AREA = 100 * 100;
const MIN_SAVE_BYTES = 128 * 1024;
const MAX_VIDEOS = 12;
const SEEK_SPLIT_SECONDS = 1;
const SEEK_SETTLE_MS = 400;
const MIN_RANGE_SECONDS = 0.4;
const RANGE_EPS = 0.25;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

const PAGE_CHANNEL = "VC_PIPE_V3";
const DEBUG_LOG_KEY = "debugLogs";
const LEGAL_NOTICE_KEY = "legalNoticeAccepted";
const LAST_DOWNLOAD_KEY = "lastDownloadId";

const MSG = {
  GET_STATE: "GET_STATE",
  GET_LOGS: "GET_LOGS",
  START_RECORDING: "START_RECORDING_V3",
  STOP_RECORDING: "STOP_RECORDING_V3",
  RECORDING_READY: "RECORDING_READY",
  RECORDING_FAILED: "RECORDING_FAILED",
  MERGE_SEGMENTS: "MERGE_SEGMENTS",
  STATE_CHANGED: "STATE_CHANGED",
  DEBUG_LOG: "DEBUG_LOG",
  OPEN_DOWNLOAD_FOLDER: "OPEN_DOWNLOAD_FOLDER",
  CREATE_DOWNLOAD_URL: "CREATE_DOWNLOAD_URL",
  REVOKE_DOWNLOAD_URL: "REVOKE_DOWNLOAD_URL",
  RESET_RECORDING: "RESET_RECORDING",
  REGISTER_SEGMENT: "REGISTER_SEGMENT",
  WRITE_CHUNK: "WRITE_CHUNK",
  FLUSH_FRAME: "FLUSH_FRAME",
  FINALIZE_RECORDING: "FINALIZE_RECORDING",
  GET_RECORDING_INDEX: "GET_RECORDING_INDEX",
  CLEANUP_RECORDING: "CLEANUP_RECORDING",
};

const TARGET = {
  BACKGROUND: "background",
  CONTENT: "content",
  POPUP: "popup",
  OFFSCREEN: "offscreen",
};

const STATUS = {
  IDLE: "idle",
  RECORDING: "recording",
  STOPPING: "stopping",
};

function i18nMessage(key, fallback, substitutions) {
  const values = Array.isArray(substitutions)
    ? substitutions.map(String)
    : substitutions === undefined
      ? []
      : [String(substitutions)];
  const override = g.__vcI18nMessages && g.__vcI18nMessages[key];
  if (typeof override === "string" && override) {
    return applySubstitutions(override, values);
  }
  try {
    const translated =
      g.chrome &&
      g.chrome.i18n &&
      typeof g.chrome.i18n.getMessage === "function" &&
      (values.length
        ? g.chrome.i18n.getMessage(key, values)
        : g.chrome.i18n.getMessage(key));
    if (translated) return translated;
  } catch {
    // Page main-world scripts use the injected message map instead.
  }
  return applySubstitutions(fallback || key, values);
}

function applySubstitutions(message, values) {
  return values.reduce(
    (text, value, index) => text.replaceAll(`$${index + 1}`, value),
    String(message || "")
  );
}

function idleState(error, terminal) {
  return {
    status: STATUS.IDLE,
    recordingId: "",
    tabId: null,
    frameId: null,
    startTime: null,
    mimeType: "",
    videoName: "",
    videoCount: 0,
    frameIds: [],
    pendingFrameIds: [],
    completedFrameIds: [],
    failedFrames: [],
    captureErrors: [],
    finalizing: false,
    result: "",
    resultMessage: "",
    error: error || "",
    ...(terminal || {}),
  };
}

function terminalPresentation(state) {
  const result = String((state && state.result) || "");
  if (!result) {
    return {
      visible: false,
      tone: "",
      title: "",
      message: "",
      showLogs: false,
    };
  }
  if (result === "success") {
    return {
      visible: true,
      tone: "success",
      title: i18nMessage("resultSavedTitle", "已保存"),
      message: state.resultMessage || i18nMessage("resultSaved", "视频已保存"),
      showLogs: false,
    };
  }
  if (result === "partial") {
    return {
      visible: true,
      tone: "warning",
      title: i18nMessage("resultPartialTitle", "已部分保存"),
      message:
        state.resultMessage ||
        i18nMessage("resultPartial", "部分视频未能完成"),
      showLogs: false,
    };
  }
  return {
    visible: true,
    tone: "error",
    title: i18nMessage("resultFailedTitle", "保存失败"),
    message:
      state.resultMessage ||
      state.error ||
      i18nMessage("noSavableRecording", "没有可保存的录制内容"),
    showLogs: true,
  };
}

function mergeRanges(ranges, start, end) {
  const next = Array.isArray(ranges)
    ? ranges.map((item) => ({ start: item.start, end: item.end }))
    : [];
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    next.push({ start, end });
  }
  next.sort((a, b) => a.start - b.start);
  const out = [];
  for (const item of next) {
    const last = out[out.length - 1];
    if (!last || item.start > last.end + RANGE_EPS) {
      out.push({ start: item.start, end: item.end });
    } else {
      last.end = Math.max(last.end, item.end);
    }
  }
  return out;
}

function rangeCovers(ranges, time) {
  return (ranges || []).some(
    (item) => time >= item.start - RANGE_EPS && time < item.end
  );
}

function safeIdPart(value, maxLength = 128) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, maxLength);
}

function validateRecordingId(value) {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(String(value || ""));
}

function makeScopedId(recordingId, frameKey, kind, localId) {
  if (!validateRecordingId(recordingId)) {
    throw new Error(i18nMessage("invalidRecordingId", "录制 ID 无效"));
  }
  const safeFrame = safeIdPart(frameKey, 32);
  const safeKind = safeIdPart(kind, 24);
  const safeLocal = safeIdPart(localId, 96);
  if (!safeFrame || !safeKind || !safeLocal) {
    throw new Error(i18nMessage("invalidSegmentId", "录制分片 ID 无效"));
  }
  return `${recordingId}:f${safeFrame}:${safeKind}:${safeLocal}`;
}

function validateChunkEnvelope(value) {
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      error: i18nMessage("invalidChunkMessage", "录制分片消息无效"),
    };
  }
  if (!validateRecordingId(value.recordingId)) {
    return {
      ok: false,
      error: i18nMessage("invalidRecordingId", "录制 ID 无效"),
    };
  }
  if (!safeIdPart(value.frameKey, 32)) {
    return { ok: false, error: i18nMessage("invalidFrameId", "frame ID 无效") };
  }
  if (
    typeof value.groupId !== "string" ||
    !value.groupId.startsWith(`${value.recordingId}:`) ||
    value.groupId.length > 320 ||
    typeof value.segmentId !== "string" ||
    !value.segmentId.startsWith(`${value.recordingId}:`) ||
    value.segmentId.length > 320
  ) {
    return {
      ok: false,
      error: i18nMessage("invalidGroupOrSegmentId", "分组或分片 ID 无效"),
    };
  }
  if (!Number.isInteger(value.sequence) || value.sequence < 0) {
    return {
      ok: false,
      error: i18nMessage("invalidChunkSequence", "分片序号无效"),
    };
  }
  if (
    !Number.isInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > MAX_CHUNK_BYTES
  ) {
    return {
      ok: false,
      error: i18nMessage("chunkTooLargeOrEmpty", "录制分片过大或为空"),
    };
  }
  if (typeof value.base64 !== "string" || !value.base64) {
    return {
      ok: false,
      error: i18nMessage("invalidChunkData", "录制分片数据无效"),
    };
  }
  for (const key of ["rangeStart", "rangeEnd"]) {
    if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0)) {
      return {
        ok: false,
        error: i18nMessage("invalidRecordingRange", "录制时间范围无效"),
      };
    }
  }
  if (
    Number.isFinite(value.rangeStart) &&
    Number.isFinite(value.rangeEnd) &&
    value.rangeEnd < value.rangeStart
  ) {
    return {
      ok: false,
      error: i18nMessage("invalidRecordingRange", "录制时间范围无效"),
    };
  }
  return { ok: true };
}

function nextFrameState(state, event) {
  const frameId = Number(event && event.frameId);
  const pending = Array.isArray(state && state.pendingFrameIds)
    ? [...state.pendingFrameIds]
    : [];
  const completed = Array.isArray(state && state.completedFrameIds)
    ? [...state.completedFrameIds]
    : [];
  const failed = Array.isArray(state && state.failedFrames)
    ? state.failedFrames.map((item) => ({ ...item }))
    : [];
  if (!Number.isInteger(frameId) || !pending.includes(frameId)) {
    return { ...state, pendingFrameIds: pending, completedFrameIds: completed, failedFrames: failed };
  }
  const pendingFrameIds = pending.filter((item) => item !== frameId);
  if (event.type === "ready") {
    if (!completed.includes(frameId)) completed.push(frameId);
  } else if (event.type === "failed") {
    failed.push({
      frameId,
      code: event.code || "FRAME_FAILED",
      message:
        event.message || i18nMessage("frameRecordingFailed", "frame 录制失败"),
    });
  } else {
    return { ...state, pendingFrameIds: pending, completedFrameIds: completed, failedFrames: failed };
  }
  return {
    ...state,
    pendingFrameIds,
    completedFrameIds: completed,
    failedFrames: failed,
  };
}

function isRecordingFile(name, recordingId) {
  if (!validateRecordingId(recordingId)) return false;
  const safe = safeIdPart(recordingId);
  const filename = String(name || "");
  return (
    filename.startsWith(`recording-${safe}-`) ||
    filename.startsWith(`merged-${safe}-`)
  );
}

function selectUsableSegments(segments, minBytes = MIN_SAVE_BYTES) {
  const ordered = (Array.isArray(segments) ? segments : [])
    .filter((segment) => Number(segment && segment.bytes) > 0)
    .slice()
    .sort((a, b) => Number(a.rangeStart || 0) - Number(b.rangeStart || 0));
  const totalBytes = ordered.reduce(
    (sum, segment) => sum + Number(segment.bytes || 0),
    0
  );
  return totalBytes >= minBytes ? ordered : [];
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function extensionForMime(mimeType) {
  return mimeType && mimeType.includes("mp4") ? "mp4" : "webm";
}

function sanitizeFileBase(name) {
  const cleaned = String(name || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^blob|media|video|playlist|manifest|index$/i.test(cleaned)) {
    return "";
  }
  return cleaned.slice(0, 100);
}

function guessVideoName(video) {
  if (!video) return "";
  const fromAttr = [
    video.getAttribute("title"),
    video.getAttribute("aria-label"),
    video.dataset && (video.dataset.title || video.dataset.name),
    video.title,
  ];
  for (const value of fromAttr) {
    const name = sanitizeFileBase(value);
    if (name) return name;
  }

  const og = document.querySelector('meta[property="og:title"], meta[name="title"]');
  const ogName = sanitizeFileBase(og && og.getAttribute("content"));
  if (ogName) return ogName;

  const pageTitle = sanitizeFileBase(
    String(document.title || "").replace(/\s*[-–|].*$/, "")
  );
  if (pageTitle) return pageTitle;

  const src = video.currentSrc || video.src || "";
  try {
    const path = new URL(src, location.href).pathname;
    const file = path.split("/").filter(Boolean).pop() || "";
    const fromSrc = sanitizeFileBase(decodeURIComponent(file));
    if (fromSrc) return fromSrc;
  } catch {
    // Ignore invalid media URLs.
  }
  return "";
}

function buildFilename(mimeType, date, videoName) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const base = sanitizeFileBase(videoName) || "video-capture";
  return `video-capture/${base}-${stamp}.${extensionForMime(mimeType)}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatBadge(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return i18nMessage("recordBadge", "REC");
}

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof u8.toBase64 === "function") {
    return u8.toBase64();
  }
  let binary = "";
  const chunk = 0x4000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(base64);
  }
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://")
  );
}

  Object.assign(g, {
    TIMESLICE_MS,
    VIDEO_BITS_PER_SECOND,
    MIN_VIDEO_AREA,
    MIN_SAVE_BYTES,
    MAX_VIDEOS,
    SEEK_SPLIT_SECONDS,
    SEEK_SETTLE_MS,
    MIN_RANGE_SECONDS,
    RANGE_EPS,
    MAX_CHUNK_BYTES,
    MAX_QUEUED_BYTES,
    PAGE_CHANNEL,
    DEBUG_LOG_KEY,
    LEGAL_NOTICE_KEY,
    LAST_DOWNLOAD_KEY,
    MSG,
    TARGET,
    STATUS,
    i18nMessage,
    idleState,
    terminalPresentation,
    mergeRanges,
    rangeCovers,
    safeIdPart,
    validateRecordingId,
    makeScopedId,
    validateChunkEnvelope,
    nextFrameState,
    isRecordingFile,
    selectUsableSegments,
    pickMimeType,
    extensionForMime,
    sanitizeFileBase,
    guessVideoName,
    buildFilename,
    formatDuration,
    formatBadge,
    bytesToBase64,
    base64ToBytes,
    isRestrictedUrl,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
