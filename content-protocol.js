(function (g) {
  if (g.__vcContentProtocolV1) return;
  g.__vcContentProtocolV1 = true;

  function createFrameProtocol(options) {
    const recordingId = String((options && options.recordingId) || "");
    const frameKey = String((options && options.frameKey) || "");
    const send = options && options.send;
    if (!validateRecordingId(recordingId) || !frameKey || typeof send !== "function") {
      throw new Error("录制桥接参数无效");
    }

    let queue = Promise.resolve();
    let queuedBytes = 0;
    const sequences = new Map();

    function register(data) {
      const ids = scopedIds(data);
      return enqueue({
        type: MSG.REGISTER_SEGMENT,
        target: TARGET.OFFSCREEN,
        recordingId,
        frameKey,
        ...ids,
        videoName: sanitizeFileBase(data.videoName || ""),
        mimeType: String(data.mimeType || ""),
        rangeStart: finiteRange(data.rangeStart),
        rangeEnd: finiteRange(data.rangeEnd),
      });
    }

    function chunk(data) {
      const bytes = toBytes(data && data.buffer);
      if (!bytes || !bytes.byteLength) {
        return Promise.reject(new Error("录制分片为空"));
      }
      if (bytes.byteLength > MAX_CHUNK_BYTES) {
        return Promise.reject(new Error("录制分片过大"));
      }
      if (queuedBytes + bytes.byteLength > MAX_QUEUED_BYTES) {
        return Promise.reject(new Error("等待写入的录制数据过多"));
      }
      const ids = scopedIds(data);
      const sequence = sequences.get(ids.segmentId) || 0;
      sequences.set(ids.segmentId, sequence + 1);
      queuedBytes += bytes.byteLength;
      const task = enqueue({
        type: MSG.WRITE_CHUNK,
        target: TARGET.OFFSCREEN,
        recordingId,
        frameKey,
        ...ids,
        sequence,
        videoName: sanitizeFileBase(data.videoName || ""),
        mimeType: String(data.mimeType || ""),
        rangeStart: finiteRange(data.rangeStart),
        rangeEnd: finiteRange(data.rangeEnd),
        base64: bytesToBase64(bytes),
        byteLength: bytes.byteLength,
      });
      return task.finally(() => {
        queuedBytes = Math.max(0, queuedBytes - bytes.byteLength);
      });
    }

    function flush(result) {
      return enqueue({
        type: MSG.FLUSH_FRAME,
        target: TARGET.OFFSCREEN,
        recordingId,
        frameKey,
        errors: normalizeErrors(result && result.errors),
      });
    }

    function enqueue(message) {
      const operation = queue.then(async () => {
        const response = await send(message);
        if (!response || response.ok === false) {
          throw new Error((response && response.error) || "录制数据写入失败");
        }
        return response;
      });
      queue = operation;
      return operation;
    }

    function scopedIds(data) {
      const localGroupId = data && data.groupId;
      const localVideoId = data && data.videoId;
      return {
        groupId: makeScopedId(recordingId, frameKey, "group", localGroupId),
        segmentId: makeScopedId(recordingId, frameKey, "segment", localVideoId),
      };
    }

    return {
      register,
      chunk,
      flush,
      drain: () => queue,
      pendingBytes: () => queuedBytes,
    };
  }

  function toBytes(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (ArrayBuffer.isView(buffer)) {
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    return null;
  }

  function finiteRange(value) {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  function normalizeErrors(errors) {
    if (!Array.isArray(errors)) return [];
    return errors.slice(0, 50).map((error) => ({
      code: String((error && error.code) || "CAPTURE_ERROR").slice(0, 64),
      message: String((error && error.message) || "录制失败").slice(0, 500),
      videoId: String((error && error.videoId) || "").slice(0, 128),
    }));
  }

  g.createFrameProtocol = createFrameProtocol;
})(typeof globalThis !== "undefined" ? globalThis : this);
