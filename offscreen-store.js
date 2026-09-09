(function (g) {
  if (g.__vcRecordingStoreV1) return;
  g.__vcRecordingStoreV1 = true;

  function createRecordingStore(options) {
    const getDirectory = options && options.getDirectory;
    const decodeBase64 =
      (options && options.decodeBase64) || g.base64ToBytes;
    if (typeof getDirectory !== "function" || typeof decodeBase64 !== "function") {
      throw new Error("录制存储依赖无效");
    }

    let activeRecordingId = "";
    let segments = new Map();
    let flushedFrames = new Set();
    let finalizedIndex = null;

    async function reset(recordingId) {
      assertRecordingId(recordingId);
      await closeAll();
      const root = await getDirectory();
      for await (const [name] of root.entries()) {
        if (name.startsWith("recording-") || name.startsWith("merged-")) {
          await removeEntry(root, name);
        }
      }
      activeRecordingId = recordingId;
      segments = new Map();
      flushedFrames = new Set();
      finalizedIndex = null;
      return { recordingId };
    }

    async function register(meta) {
      assertActive(meta && meta.recordingId);
      validateSegmentMeta(meta);
      let segment = segments.get(meta.segmentId);
      if (segment) {
        updateMeta(segment, meta);
        return publicSegment(segment);
      }

      const root = await getDirectory();
      const opfsName = `recording-${safeIdPart(meta.recordingId)}-${safeIdPart(
        meta.segmentId,
        160
      )}.bin`;
      await removeEntry(root, opfsName);
      const fileHandle = await root.getFileHandle(opfsName, { create: true });
      const writable = await fileHandle.createWritable();
      segment = {
        recordingId: meta.recordingId,
        frameKey: String(meta.frameKey),
        groupId: meta.groupId,
        segmentId: meta.segmentId,
        mimeType: String(meta.mimeType || ""),
        videoName: sanitizeFileBase(meta.videoName || ""),
        rangeStart: finiteRange(meta.rangeStart, 0),
        rangeEnd: finiteRange(meta.rangeEnd, 0),
        opfsName,
        fileHandle,
        writable,
        nextSequence: 0,
        bytes: 0,
        queue: Promise.resolve(),
        closed: false,
      };
      segments.set(segment.segmentId, segment);
      return publicSegment(segment);
    }

    async function writeChunk(envelope) {
      assertActive(envelope && envelope.recordingId);
      const validation = validateChunkEnvelope(envelope);
      if (!validation.ok) throw new Error(validation.error);
      let segment = segments.get(envelope.segmentId);
      if (!segment) {
        await register(envelope);
        segment = segments.get(envelope.segmentId);
      }

      const operation = segment.queue.then(async () => {
        if (envelope.sequence < segment.nextSequence) {
          return { duplicate: true, sequence: envelope.sequence, bytes: segment.bytes };
        }
        if (envelope.sequence !== segment.nextSequence) {
          throw new Error(
            `分片序号不连续：期望 ${segment.nextSequence}，收到 ${envelope.sequence}`
          );
        }
        if (segment.closed || !segment.writable) {
          throw new Error("录制分片已经关闭");
        }
        const bytes = decodeBase64(envelope.base64);
        if (!bytes || bytes.byteLength !== envelope.byteLength) {
          throw new Error("录制分片长度不匹配");
        }
        await segment.writable.write(bytes);
        segment.bytes += bytes.byteLength;
        segment.nextSequence += 1;
        updateMeta(segment, envelope);
        return { duplicate: false, sequence: envelope.sequence, bytes: segment.bytes };
      });
      segment.queue = operation.catch(() => {});
      return operation;
    }

    async function flushFrame(recordingId, frameKey) {
      assertActive(recordingId);
      const key = String(frameKey || "");
      if (!key) throw new Error("frame ID 无效");
      const queues = [...segments.values()]
        .filter((segment) => segment.frameKey === key)
        .map((segment) => segment.queue);
      await Promise.all(queues);
      flushedFrames.add(key);
      return { frameKey: key };
    }

    async function finalize(recordingId) {
      assertActive(recordingId);
      if (finalizedIndex) return cloneIndex(finalizedIndex);
      await closeAll();
      const groups = new Map();
      for (const segment of segments.values()) {
        const file = await segment.fileHandle.getFile();
        segment.bytes = file.size;
        if (!groups.has(segment.groupId)) groups.set(segment.groupId, []);
        groups.get(segment.groupId).push(publicSegment(segment));
      }
      const grouped = [...groups.values()].map((group) =>
        group.sort((a, b) => a.rangeStart - b.rangeStart)
      );
      finalizedIndex = {
        recordingId: activeRecordingId,
        groups: grouped,
        flushedFrames: [...flushedFrames],
      };
      return cloneIndex(finalizedIndex);
    }

    async function getIndex(recordingId) {
      assertActive(recordingId);
      return finalizedIndex ? cloneIndex(finalizedIndex) : finalize(recordingId);
    }

    async function cleanup(recordingId) {
      assertRecordingId(recordingId);
      if (activeRecordingId === recordingId) await closeAll();
      const root = await getDirectory();
      for await (const [name] of root.entries()) {
        if (isRecordingFile(name, recordingId)) await removeEntry(root, name);
      }
      if (activeRecordingId === recordingId) {
        activeRecordingId = "";
        segments = new Map();
        flushedFrames = new Set();
        finalizedIndex = null;
      }
      return { recordingId };
    }

    async function closeAll() {
      const list = [...segments.values()];
      await Promise.all(list.map((segment) => segment.queue));
      for (const segment of list) {
        if (segment.closed || !segment.writable) continue;
        await segment.writable.close();
        segment.writable = null;
        segment.closed = true;
      }
    }

    function assertActive(recordingId) {
      assertRecordingId(recordingId);
      if (!activeRecordingId || recordingId !== activeRecordingId) {
        throw new Error("消息不是当前录制");
      }
    }

    return {
      reset,
      register,
      writeChunk,
      flushFrame,
      finalize,
      getIndex,
      cleanup,
    };
  }

  function assertRecordingId(recordingId) {
    if (!validateRecordingId(recordingId)) throw new Error("录制 ID 无效");
  }

  function validateSegmentMeta(meta) {
    if (
      !meta ||
      typeof meta.groupId !== "string" ||
      !meta.groupId.startsWith(`${meta.recordingId}:`) ||
      typeof meta.segmentId !== "string" ||
      !meta.segmentId.startsWith(`${meta.recordingId}:`)
    ) {
      throw new Error("分组或分片 ID 无效");
    }
    if (!String(meta.frameKey || "")) throw new Error("frame ID 无效");
    for (const value of [meta.rangeStart, meta.rangeEnd]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error("录制时间范围无效");
      }
    }
  }

  function updateMeta(segment, meta) {
    if (meta.videoName) segment.videoName = sanitizeFileBase(meta.videoName);
    if (meta.mimeType) segment.mimeType = String(meta.mimeType);
    if (Number.isFinite(meta.rangeStart)) segment.rangeStart = meta.rangeStart;
    if (Number.isFinite(meta.rangeEnd)) segment.rangeEnd = meta.rangeEnd;
  }

  function finiteRange(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function publicSegment(segment) {
    return {
      recordingId: segment.recordingId,
      frameKey: segment.frameKey,
      groupId: segment.groupId,
      segmentId: segment.segmentId,
      mimeType: segment.mimeType,
      videoName: segment.videoName,
      rangeStart: segment.rangeStart,
      rangeEnd: segment.rangeEnd,
      opfsName: segment.opfsName,
      bytes: segment.bytes,
      nextSequence: segment.nextSequence,
    };
  }

  function cloneIndex(index) {
    return {
      recordingId: index.recordingId,
      groups: index.groups.map((group) => group.map((item) => ({ ...item }))),
      flushedFrames: [...index.flushedFrames],
    };
  }

  async function removeEntry(root, name) {
    try {
      await root.removeEntry(name);
    } catch {
      // Missing stale files are already clean.
    }
  }

  g.createRecordingStore = createRecordingStore;
})(typeof globalThis !== "undefined" ? globalThis : this);
