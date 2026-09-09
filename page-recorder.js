(() => {
  if (globalThis.__videoCapturePageV3) return;
  globalThis.__videoCapturePageV3 = true;

  const PIPE = globalThis.PAGE_CHANNEL;
  const M = globalThis.MSG;

  let attached = new WeakSet();
  const sessions = new Map();
  let running = false;
  let stopPromise = null;
  let observer = null;
  let observeTimer = null;
  let sessionSeq = 0;
  let bridgeToken = "";
  const pendingChunkReads = new Set();
  const chunkReadErrors = [];

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== PIPE || data.from !== "isolated") return;

    if (data.type === M.START_RECORDING) {
      if (!data.bridgeToken) return;
      startRecording(data.bridgeToken)
        .then((result) => postToIsolated("STARTED", result))
        .catch((error) => {
          postToIsolated("ERROR", { error: error.message || String(error) });
        });
    }
    if (data.type === M.STOP_RECORDING) {
      if (!bridgeToken || data.bridgeToken !== bridgeToken) return;
      requestStop("user")
        .then((result) => postToIsolated("STOPPED", result))
        .catch((error) => {
          postToIsolated("ERROR", { error: error.message || String(error) });
        });
    }
  });

  function postToIsolated(type, extra, transfer) {
    window.postMessage(
      {
        channel: PIPE,
        from: "page",
        bridgeToken,
        type,
        ...extra,
      },
      "*",
      transfer || []
    );
  }

  let lastAttachError = "";

  async function startRecording(nextBridgeToken) {
    if (running) {
      bridgeToken = nextBridgeToken;
      throw new Error("已在录制中");
    }
    await resetAll();
    bridgeToken = nextBridgeToken;
    running = true;
    const videos = collectEligibleVideos();
    if (!videos.length) {
      running = false;
      throw new Error("当前页面没有可录制的视频");
    }

    const started = [];
    const errors = [];
    for (const video of videos.slice(0, MAX_VIDEOS)) {
      const session = await attachSession(video, videos.length);
      if (session) started.push(summarize(session));
      else if (lastAttachError) errors.push(lastAttachError);
    }
    if (!started.length) {
      running = false;
      throw new Error(
        errors[0] || `找到 ${videos.length} 个视频，但无法捕获画面`
      );
    }
    watchNewVideos();
    logPage("recorders-started", { count: started.length });
    return { ok: true, videos: started, mimeType: started[0] && started[0].mimeType };
  }

  function collectEligibleVideos() {
    return collectVideos(document).filter((video) => scoreVideo(video) > 0);
  }

  async function attachSession(video, total) {
    lastAttachError = "";
    if (!running || sessions.size >= MAX_VIDEOS) {
      lastAttachError = "录制会话已满";
      return null;
    }
    if (attached.has(video)) {
      const live = [...sessions.values()].some((item) => item.video === video);
      if (live) {
        lastAttachError = "该视频已在录制中";
        return null;
      }
      attached.delete(video);
    }
    const mimeType = pickMimeType();
    if (!mimeType) {
      lastAttachError = "当前浏览器没有可用的录制格式";
      logPage("attach-failed", { error: lastAttachError });
      return null;
    }

    let stream;
    try {
      stream = captureElementStream(video);
    } catch (error) {
      lastAttachError = error.message || String(error);
      logPage("capture-failed", { error: lastAttachError });
      return null;
    }
    const videoTracks = stream.getVideoTracks();
    if (!videoTracks.length) {
      stream.getTracks().forEach((track) => track.stop());
      lastAttachError = "找到了视频，但没有可捕获的画面轨道（可能受保护）";
      logPage("capture-failed", { error: lastAttachError });
      return null;
    }

    attached.add(video);
    const groupId = `g${sessionSeq++}`;
    const baseName = guessSessionName(video, sessions.size + 1, total);
    const startTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const session = {
      groupId,
      videoId: "",
      video,
      stream,
      recordStream: null,
      starting: false,
      recorder: null,
      mimeType,
      baseName,
      videoName: baseName,
      rangeStart: startTime,
      playHead: startTime,
      covered: [],
      isSeeking: false,
      filling: false,
      waitingCovered: false,
      seekTimer: null,
      closing: false,
      startedAt: Date.now(),
      chunkCount: 0,
      byteCount: 0,
    };
    sessions.set(groupId, session);
    bindVideoEvents(session);
    try {
      await beginRecording(session, startTime);
    } catch (error) {
      sessions.delete(groupId);
      attached.delete(video);
      lastAttachError = error.message || String(error);
      logPage("recorder-start-failed", { error: lastAttachError });
      return null;
    }
    return session;
  }

  function bindVideoEvents(session) {
    const video = session.video;
    video.addEventListener("play", () => {
      if (!session.filling) resumeSession(session);
    });
    video.addEventListener("playing", () => {
      if (!session.filling) resumeSession(session);
    });
    video.addEventListener("pause", () => {
      if (!session.filling && !session.isSeeking) pauseSession(session);
    });
    video.addEventListener("ended", () => {
      if (!session.filling) pauseSession(session);
    });
    video.addEventListener("waiting", () => {
      if (!session.filling && !session.isSeeking) pauseSession(session);
    });
    video.addEventListener("canplay", () => {
      if (!session.filling && !video.paused && !video.ended) resumeSession(session);
    });
    video.addEventListener("seeking", () => {
      if (session.filling) return;
      session.isSeeking = true;
      pauseSession(session);
    });
    video.addEventListener("seeked", () => {
      if (session.filling) return;
      onSeeked(session);
    });
    video.addEventListener("timeupdate", () => {
      if (session.filling || session.isSeeking) return;
      session.playHead = video.currentTime;
      if (session.waitingCovered && !rangeCovers(session.covered, video.currentTime)) {
        session.waitingCovered = false;
        beginRecording(session, video.currentTime)
          .then(() => {
            if (!video.paused && !video.ended) resumeSession(session);
          })
          .catch((error) => {
            logPage("recorder-start-failed", { error: error.message || String(error) });
          });
      } else if (
        session.recorder &&
        !session.closing &&
        rangeCovers(session.covered, video.currentTime + 0.35)
      ) {
        closeCurrentSegment(session).then(() => {
          session.waitingCovered = true;
        });
      }
    });
  }

  async function beginRecording(session, startTime) {
    if (session.recorder || session.starting) return;
    session.starting = true;
    const videoId = `v${Date.now().toString(36)}-${sessionSeq++}`;
    session.videoId = videoId;
    session.videoName = session.baseName;
    session.rangeStart = Number.isFinite(startTime)
      ? startTime
      : Number.isFinite(session.video.currentTime)
        ? session.video.currentTime
        : 0;
    session.playHead = session.rangeStart;
    session.chunkCount = 0;
    session.byteCount = 0;
    try {
      session.recorder = await createAndStartRecorder(session);
      bindRecorder(session);
      logPage("segment-started", {
        groupId: session.groupId,
        videoId,
        start: session.rangeStart,
        state: session.recorder.state,
      });
      postToIsolated("REGISTER", {
        videoId,
        groupId: session.groupId,
        videoName: session.baseName,
        mimeType: session.mimeType,
        rangeStart: session.rangeStart,
      });
      if (
        !session.filling &&
        (session.video.paused ||
          session.video.ended ||
          session.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
      ) {
        pauseSession(session);
      }
    } catch (error) {
      session.recorder = null;
      releaseRecordStream(session);
      throw error;
    } finally {
      session.starting = false;
    }
  }

  async function createAndStartRecorder(session) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = openRecorderStream(session, attempt > 0);
      const optionSets = [
        {
          mimeType: session.mimeType,
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
          videoKeyFrameIntervalDuration: TIMESLICE_MS,
        },
        { mimeType: session.mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND },
        { mimeType: session.mimeType },
        {},
      ];
      for (const options of optionSets) {
        try {
          const recorder = new MediaRecorder(stream, options);
          recorder.start(TIMESLICE_MS);
          if (recorder.state !== "inactive") return recorder;
          lastError = new Error("MediaRecorder 启动后仍是 inactive");
        } catch (error) {
          lastError = error;
        }
      }
      await delay(120);
    }
    throw lastError || new Error("无法启动 MediaRecorder");
  }

  function openRecorderStream(session, recapture) {
    releaseRecordStream(session);
    if (recapture) {
      try {
        session.stream = captureElementStream(session.video);
      } catch {
        // Keep the previous base stream.
      }
    }
    try {
      session.recordStream = session.stream.clone();
    } catch {
      session.recordStream = captureElementStream(session.video);
    }
    const live = session.recordStream
      .getTracks()
      .filter((track) => track.readyState === "live");
    if (!live.length) {
      session.stream = captureElementStream(session.video);
      session.recordStream = session.stream.clone();
    }
    return session.recordStream;
  }

  function releaseRecordStream(session) {
    if (!session.recordStream) return;
    session.recordStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    });
    session.recordStream = null;
  }

  function bindRecorder(session) {
    const recorder = session.recorder;
    const videoId = session.videoId;
    recorder.ondataavailable = (event) => {
      const size = event.data ? event.data.size : 0;
      if (!event.data || size === 0) return;
      const chunk = event.data;
      const reading = chunk
        .arrayBuffer()
        .then((buffer) => {
          session.chunkCount += 1;
          session.byteCount += buffer.byteLength;
          postToIsolated(
            "CHUNK",
            {
              videoId,
              groupId: session.groupId,
              videoName: session.videoName,
              mimeType: session.mimeType,
              rangeStart: session.rangeStart,
              buffer,
              size: buffer.byteLength,
            },
            [buffer]
          );
        })
        .catch((error) => {
          logPage("chunk-read-failed", {
            videoId,
            error: error.message || String(error),
          });
          chunkReadErrors.push(error);
        })
        .finally(() => pendingChunkReads.delete(reading));
      pendingChunkReads.add(reading);
    };
    recorder.onerror = (event) => {
      logPage("recorder-error", {
        videoId,
        name: event.error && event.error.name,
        message: event.error && event.error.message,
      });
    };
  }

  function onSeeked(session) {
    const from = session.playHead;
    const to = session.video.currentTime;
    session.isSeeking = false;
    session.playHead = to;
    if (!running || session.filling || session.closing) return;
    clearSeekTimer(session);
    session.seekTimer = setTimeout(() => {
      session.seekTimer = null;
      settleSeek(session, from, to);
    }, SEEK_SETTLE_MS);
  }

  async function settleSeek(session, from, to) {
    if (!running || session.filling) return;
    const jump = Number.isFinite(from) && Number.isFinite(to) ? Math.abs(to - from) : 0;
    if (jump < SEEK_SPLIT_SECONDS) {
      if (!session.video.paused && !session.video.ended) resumeSession(session);
      return;
    }
    await closeCurrentSegment(session);
    if (rangeCovers(session.covered, to)) {
      session.waitingCovered = true;
      logPage("seek-already-covered", { to });
      return;
    }
    try {
      await beginRecording(session, to);
    } catch (error) {
      logPage("recorder-start-failed", { error: error.message || String(error) });
      return;
    }
    if (!session.video.paused && !session.video.ended) resumeSession(session);
  }

  async function closeCurrentSegment(session) {
    if (!session.recorder || session.closing) return;
    session.closing = true;
    clearSeekTimer(session);
    const end = Number.isFinite(session.video.currentTime)
      ? session.video.currentTime
      : session.playHead;
    const start = session.rangeStart;
    try {
      postToIsolated("REGISTER", {
        videoId: session.videoId,
        groupId: session.groupId,
        videoName: session.baseName,
        mimeType: session.mimeType,
        rangeStart: start,
        rangeEnd: end,
      });
      await stopRecorderOnly(session);
      if (
        end - start >= MIN_RANGE_SECONDS &&
        (session.byteCount >= MIN_SAVE_BYTES || session.filling)
      ) {
        session.covered = mergeRanges(session.covered, start, end);
        logPage("segment-closed", { start, end, bytes: session.byteCount });
      } else {
        logPage("segment-discarded", { start, end, bytes: session.byteCount });
      }
    } finally {
      session.closing = false;
    }
  }

  async function stopRecorderOnly(session) {
    const recorder = session.recorder;
    if (!recorder) {
      releaseRecordStream(session);
      return;
    }
    if (recorder.state === "inactive") {
      await drainChunkReads();
      session.recorder = null;
      releaseRecordStream(session);
      return;
    }
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      try {
        if (recorder.state === "paused") {
          recorder.resume();
        }
        if (typeof recorder.requestData === "function" && recorder.state === "recording") {
          recorder.requestData();
        }
        recorder.stop();
      } catch {
        resolve();
      }
    });
    await drainChunkReads();
    session.recorder = null;
    releaseRecordStream(session);
  }

  function resumeSession(session) {
    if (!session.recorder || session.recorder.state !== "paused") return;
    try {
      session.recorder.resume();
    } catch {
      // Ignore.
    }
  }

  function pauseSession(session) {
    if (!session.recorder || session.recorder.state !== "recording") return;
    try {
      session.recorder.pause();
    } catch {
      // Ignore.
    }
  }

  function clearSeekTimer(session) {
    if (!session.seekTimer) return;
    clearTimeout(session.seekTimer);
    session.seekTimer = null;
  }

  function watchNewVideos() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (!running) return;
      clearTimeout(observeTimer);
      observeTimer = setTimeout(() => {
        for (const video of collectEligibleVideos()) {
          attachSession(video, sessions.size + 1).catch((error) => {
            logPage("attach-failed", { error: error.message || String(error) });
          });
        }
      }, 400);
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function guessSessionName(video, index, total) {
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
    const src = video.currentSrc || video.src || "";
    try {
      const path = new URL(src, location.href).pathname;
      const file = path.split("/").filter(Boolean).pop() || "";
      const fromSrc = sanitizeFileBase(decodeURIComponent(file));
      if (fromSrc) return fromSrc;
    } catch {
      // Ignore.
    }
    if (total <= 1) {
      const shared = guessVideoName(video);
      if (shared) return shared;
    }
    return `video-${index}`;
  }

  function summarize(session) {
    return {
      videoId: session.videoId,
      groupId: session.groupId,
      videoName: session.videoName,
      mimeType: session.mimeType,
    };
  }

  function collectVideos(root, out = []) {
    out.push(...root.querySelectorAll("video"));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectVideos(el.shadowRoot, out);
    }
    return out;
  }

  function scoreVideo(video) {
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area < MIN_VIDEO_AREA) return 0;
    return area + (video.readyState >= HTMLMediaElement.HAVE_METADATA ? 1 : 0);
  }

  function captureElementStream(element) {
    const capture = element.captureStream || element.mozCaptureStream;
    if (typeof capture !== "function") {
      throw new Error("当前浏览器不支持 video.captureStream()");
    }
    try {
      return capture.call(element);
    } catch (error) {
      const name = error && error.name;
      if (name === "SecurityError" || name === "NotSupportedError") {
        throw new Error("当前视频不允许捕获（可能受保护）");
      }
      throw new Error(error.message || "无法从视频元素捕获");
    }
  }

  function requestStop(reason) {
    if (!stopPromise) {
      stopPromise = finalizeStop(reason).finally(() => {
        stopPromise = null;
      });
    }
    return stopPromise;
  }

  async function finalizeStop(reason) {
    running = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    const list = [...sessions.values()];
    for (const session of list) {
      await closeCurrentSegment(session);
    }
    const errors = [];
    if (reason === "user") {
      for (const session of list) {
        const error = await fillGapsForSession(session);
        if (error) errors.push(error);
      }
    }
    for (const session of list) {
      releaseRecordStream(session);
      session.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore.
        }
      });
    }
    const videos = list.map((session) => ({
      videoId: session.videoId,
      groupId: session.groupId,
      videoName: session.videoName,
      mimeType: session.mimeType,
      byteCount: session.byteCount,
    }));
    logPage("stopped-all", { reason, count: videos.length });
    sessions.clear();
    attached = new WeakSet();
    return {
      ok: true,
      videos,
      mimeType: videos[0] && videos[0].mimeType,
      byteCount: videos.reduce((sum, item) => sum + item.byteCount, 0),
      errors,
    };
  }

  async function fillGapsForSession(session) {
    const duration = session.video && session.video.duration;
    if (!Number.isFinite(duration) || duration < 1) {
      logPage("skip-gap-fill", { reason: "no-duration" });
      return null;
    }
    const gaps = findGaps(session.covered, 0, duration);
    if (!gaps.length) {
      logPage("gap-fill-skip", { reason: "complete" });
      return null;
    }
    session.filling = true;
    const remain = gaps.reduce((sum, item) => sum + (item.end - item.start), 0);
    postToIsolated("PROGRESS", {
      message: `正在补全未观看部分，大约还需要 ${formatDuration(remain * 1000)}，请勿关闭页面`,
      remainSec: remain,
    });
    logPage("gap-fill-start", { gaps: gaps.length, remain });
    const original = {
      currentTime: session.video.currentTime,
      paused: session.video.paused,
      volume: session.video.volume,
      playbackRate: session.video.playbackRate,
    };
    let failure = null;
    try {
      for (let i = 0; i < gaps.length; i += 1) {
        const gap = gaps[i];
        const left = gaps.slice(i).reduce((sum, item) => sum + (item.end - item.start), 0);
        postToIsolated("PROGRESS", {
          message: `正在补全第 ${i + 1}/${gaps.length} 段，大约还需要 ${formatDuration(left * 1000)}`,
          remainSec: left,
        });
        await playThrough(session.video, gap.start, gap.end, false);
        await beginRecording(session, gap.start);
        await playThrough(session.video, session.video.currentTime, gap.end, true);
        await closeCurrentSegment(session);
      }
    } catch (error) {
      logPage("gap-fill-failed", { error: error.message || String(error) });
      failure = {
        code: "GAP_FILL_FAILED",
        message: error.message || String(error),
        videoId: session.videoId,
      };
    } finally {
      try {
        session.video.pause();
        session.video.volume = original.volume;
        session.video.playbackRate = original.playbackRate;
        await seekTo(session.video, original.currentTime);
        if (!original.paused) await session.video.play();
      } catch (error) {
        if (!failure) {
          failure = {
            code: "PLAYBACK_RESTORE_FAILED",
            message: error.message || String(error),
            videoId: session.videoId,
          };
        }
      }
      session.filling = false;
    }
    return failure;
  }

  async function drainChunkReads() {
    while (pendingChunkReads.size) {
      await Promise.allSettled([...pendingChunkReads]);
    }
    if (chunkReadErrors.length) {
      const error = chunkReadErrors[0];
      chunkReadErrors.length = 0;
      throw error;
    }
  }

  async function playThrough(video, start, end, skipSeek) {
    if (!skipSeek) {
      await seekTo(video, start);
      try {
        await video.play();
      } catch {
        // Autoplay may be blocked; keep waiting on currentTime anyway.
      }
      return;
    }
    const deadline = Date.now() + Math.max(8000, (end - start) * 1000 + 20000);
    while (Date.now() < deadline) {
      if (video.ended) return;
      if (Number.isFinite(video.currentTime) && video.currentTime >= end - 0.12) return;
      await delay(200);
    }
    throw new Error("补全视频超时");
  }

  function seekTo(video, time) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener("seeked", finish);
        resolve();
      };
      video.addEventListener("seeked", finish);
      try {
        video.currentTime = time;
      } catch {
        finish();
        return;
      }
      setTimeout(finish, 2500);
    });
  }

  async function resetAll() {
    running = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    for (const session of sessions.values()) {
      clearSeekTimer(session);
      try {
        await stopRecorderOnly(session);
      } catch (error) {
        logPage("reset-recorder-failed", {
          error: error.message || String(error),
        });
      }
      releaseRecordStream(session);
      session.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore.
        }
      });
    }
    sessions.clear();
    attached = new WeakSet();
    stopPromise = null;
    try {
      await drainChunkReads();
    } catch {
      chunkReadErrors.length = 0;
    }
    bridgeToken = "";
  }

  function logPage(message, extra) {
    console.log("[VideoCapture][page]", message, extra || "");
    postToIsolated("LOG", { message, extra });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
