const WEBM_CLUSTER_ID = 0x1f43b675;
const WEBM_SEGMENT_ID = 0x18538067;
const WEBM_TIMECODE_ID = 0xe7;
const WEBM_INFO_ID = 0x1549a966;
const WEBM_TIMECODE_SCALE_ID = 0x2ad7b1;
const WEBM_DURATION_ID = 0x4489;
const WEBM_TRACKS_ID = 0x1654ae6b;
const WEBM_TRACK_ENTRY_ID = 0xae;
const WEBM_TRACK_NUMBER_ID = 0xd7;
const WEBM_TRACK_TYPE_ID = 0x83;
const WEBM_SEEK_HEAD_ID = 0x114d9b74;
const WEBM_SEEK_ID = 0x4dbb;
const WEBM_SEEK_ID_ID = 0x53ab;
const WEBM_SEEK_POSITION_ID = 0x53ac;
const WEBM_CUES_ID = 0x1c53bb6b;
const WEBM_CUE_POINT_ID = 0xbb;
const WEBM_CUE_TIME_ID = 0xb3;
const WEBM_CUE_TRACK_POSITIONS_ID = 0xb7;
const WEBM_CUE_TRACK_ID = 0xf7;
const WEBM_CUE_CLUSTER_POSITION_ID = 0xf1;
const WEBM_VOID_ID = 0xec;
const WEBM_CRC32_ID = 0xbf;
const WEBM_POSITION_ID = 0xa7;
const WEBM_PREV_SIZE_ID = 0xab;
const WEBM_SIMPLE_BLOCK_ID = 0xa3;
const WEBM_BLOCK_GROUP_ID = 0xa0;
const WEBM_BLOCK_ID = 0xa1;
const WEBM_REFERENCE_BLOCK_ID = 0xfb;

const CLUSTER_SIGNATURE = new Uint8Array([0x1f, 0x43, 0xb6, 0x75]);
const INDEX_TAIL_BYTES = 256;
const FILE_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

function createWebmClusterIndexer() {
  let tail = new Uint8Array(0);
  let expectedOffset = 0;
  const found = new Map();

  function push(input, absoluteOffset) {
    const bytes = toUint8Array(input);
    const startOffset = Number(absoluteOffset);
    if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
      throw new Error(
        i18nMessage("invalidWebmIndexOffset", "WebM 索引偏移无效")
      );
    }
    if (startOffset !== expectedOffset) tail = new Uint8Array(0);

    const combined = tail.length ? concatBytes([tail, bytes]) : bytes;
    const combinedOffset = startOffset - tail.length;
    scanClusterStarts(combined, combinedOffset, found);
    tail = combined.slice(Math.max(0, combined.length - INDEX_TAIL_BYTES));
    expectedOffset = startOffset + bytes.length;
  }

  function snapshot(totalBytes = expectedOffset) {
    const size = Number(totalBytes);
    const clusters = [...found.values()]
      .filter((item) => item.offset >= 0 && item.offset < size)
      .sort((a, b) => a.offset - b.offset);
    return clusters.map((item, index) => {
      const nextOffset = clusters[index + 1]?.offset ?? size;
      const declaredEnd = Number.isSafeInteger(item.declaredEnd)
        ? item.declaredEnd
        : nextOffset;
      return {
        offset: item.offset,
        end: Math.min(size, nextOffset, declaredEnd),
        timecode: item.timecode,
      };
    });
  }

  return { push, snapshot };
}

async function finalizeWebmFiles(parts, writable) {
  if (!Array.isArray(parts) || !parts.length) {
    throw new Error(
      i18nMessage("noWebmSegmentsToFinalize", "没有可终结的 WebM 片段")
    );
  }
  if (!writable || typeof writable.write !== "function") {
    throw new Error(i18nMessage("invalidWebmOutput", "WebM 输出流无效"));
  }

  const sources = [];
  for (const part of parts) {
    const file = part && part.file;
    if (!file || !Number.isFinite(file.size) || typeof file.slice !== "function") {
      throw new Error(i18nMessage("invalidWebmInput", "WebM 输入文件无效"));
    }
    const clusters = validClusterIndex(part.webmIndex, file.size)
      ? normalizeClusterIndex(part.webmIndex, file.size)
      : await scanWebmFile(file);
    if (!clusters.length) {
      throw new Error(
        i18nMessage("noPlayableVideoData", "片段里没有可播放的视频数据")
      );
    }
    sources.push({
      file,
      clusters,
      durationSec: positiveNumber(part.durationSec),
    });
  }

  const first = sources[0];
  const prefix = new Uint8Array(
    await first.file.slice(0, first.clusters[0].offset).arrayBuffer()
  );
  const metadata = parseWebmPrefix(prefix);
  const scale = metadata.timecodeScale || 1_000_000;
  const sourceOffsets = [];
  let durationUnits = 0;
  for (const source of sources) {
    sourceOffsets.push(durationUnits);
    const suppliedUnits = source.durationSec
      ? Math.round((source.durationSec * 1e9) / scale)
      : 0;
    const firstTimecode = source.clusters[0].timecode;
    const lastTimecode = source.clusters[source.clusters.length - 1].timecode;
    const indexedUnits = Math.max(1, lastTimecode - firstTimecode + 1);
    durationUnits += Math.max(suppliedUnits, indexedUnits);
  }

  const info = rebuildInfo(metadata.infoBytes, scale, durationUnits);
  const tracks = metadata.tracksBytes;
  const trackNumber = findVideoTrackNumber(tracks) || 1;
  const otherMetadata = metadata.otherMetadata;
  const placeholderSeekHead = buildSeekHead({
    infoPosition: 0,
    tracksPosition: 0,
    cuesPosition: 0,
    includeTracks: Boolean(tracks),
  });
  const segmentHeader = concatBytes([
    writeId(WEBM_SEGMENT_ID),
    writeVint(0, 8),
  ]);

  let absolutePosition = 0;
  const write = async (bytes) => {
    const view = toUint8Array(bytes);
    await writable.write(view);
    absolutePosition += view.length;
  };

  await write(metadata.ebmlHeader);
  const segmentHeaderPosition = absolutePosition;
  await write(segmentHeader);
  const segmentDataPosition = absolutePosition;
  const seekHeadPosition = absolutePosition;
  await write(placeholderSeekHead);

  const infoPosition = absolutePosition - segmentDataPosition;
  await write(info);
  const tracksPosition = tracks
    ? absolutePosition - segmentDataPosition
    : 0;
  if (tracks) await write(tracks);
  for (const bytes of otherMetadata) await write(bytes);

  const cues = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    const sourceBase = source.clusters[0].timecode;
    for (const cluster of source.clusters) {
      const raw = new Uint8Array(
        await source.file.slice(cluster.offset, cluster.end).arrayBuffer()
      );
      const nextTimecode = Math.max(
        0,
        cluster.timecode - sourceBase + sourceOffsets[sourceIndex]
      );
      const rewritten = rewriteClusterBytes(raw, nextTimecode);
      const cueTimecode = findClusterCueTime(
        rewritten,
        trackNumber,
        nextTimecode
      );
      if (cueTimecode !== null) {
        cues.push({
          timecode: cueTimecode,
          position: absolutePosition - segmentDataPosition,
        });
      }
      await write(rewritten);
    }
  }

  if (!cues.length) {
    throw new Error(
      i18nMessage(
        "noIndexableKeyframe",
        "WebM 中没有可建立索引的视频关键帧"
      )
    );
  }
  const cuesPosition = absolutePosition - segmentDataPosition;
  await write(buildCues(cues, trackNumber));
  const segmentSize = absolutePosition - segmentDataPosition;
  const finalSeekHead = buildSeekHead({
    infoPosition,
    tracksPosition,
    cuesPosition,
    includeTracks: Boolean(tracks),
  });
  if (finalSeekHead.length !== placeholderSeekHead.length) {
    throw new Error(
      i18nMessage("webmSeekHeadSizeChanged", "WebM SeekHead 长度发生变化")
    );
  }

  await writable.write({
    type: "write",
    position: seekHeadPosition,
    data: finalSeekHead,
  });
  await writable.write({
    type: "write",
    position: segmentHeaderPosition + writeId(WEBM_SEGMENT_ID).length,
    data: writeVint(segmentSize, 8),
  });

  return {
    size: absolutePosition,
    durationUnits,
    timecodeScale: scale,
    cueCount: cues.length,
  };
}

async function scanWebmFile(file) {
  const indexer = createWebmClusterIndexer();
  for (let offset = 0; offset < file.size; offset += FILE_SCAN_CHUNK_BYTES) {
    const bytes = new Uint8Array(
      await file
        .slice(offset, Math.min(file.size, offset + FILE_SCAN_CHUNK_BYTES))
        .arrayBuffer()
    );
    indexer.push(bytes, offset);
  }
  return indexer.snapshot(file.size);
}

function scanClusterStarts(bytes, absoluteOffset, found) {
  for (let i = 0; i <= bytes.length - CLUSTER_SIGNATURE.length; i += 1) {
    if (!matchesAt(bytes, i, CLUSTER_SIGNATURE)) continue;
    const cluster = inspectClusterStart(bytes, i, absoluteOffset);
    if (cluster && !found.has(cluster.offset)) found.set(cluster.offset, cluster);
  }
}

function inspectClusterStart(bytes, offset, absoluteOffset) {
  const size = readVint(bytes, offset + CLUSTER_SIGNATURE.length);
  if (!size) return null;
  let cursor = offset + CLUSTER_SIGNATURE.length + size.length;
  const limit = Math.min(bytes.length, cursor + 128);
  while (cursor < limit) {
    const header = readElementHeader(bytes, cursor);
    if (!header) return null;
    const dataStart = cursor + header.headerSize;
    const dataEnd = header.dataSize < 0 ? limit : dataStart + header.dataSize;
    if (dataEnd > bytes.length) return null;
    if (header.id === WEBM_TIMECODE_ID) {
      if (header.dataSize < 1 || header.dataSize > 8) return null;
      const declaredEnd =
        size.value >= 0
          ? absoluteOffset + offset + CLUSTER_SIGNATURE.length + size.length + size.value
          : undefined;
      return {
        offset: absoluteOffset + offset,
        timecode: readUint(bytes.subarray(dataStart, dataEnd)),
        declaredEnd,
      };
    }
    if (
      ![
        WEBM_VOID_ID,
        WEBM_CRC32_ID,
        WEBM_POSITION_ID,
        WEBM_PREV_SIZE_ID,
      ].includes(header.id)
    ) {
      return null;
    }
    cursor = dataEnd;
  }
  return null;
}

function validClusterIndex(index, fileSize) {
  if (!Array.isArray(index) || !index.length) return false;
  let previous = -1;
  return index.every((item) => {
    const offset = Number(item && item.offset);
    const end = Number(item && item.end);
    const timecode = Number(item && item.timecode);
    const valid =
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(end) &&
      Number.isSafeInteger(timecode) &&
      offset > previous &&
      offset >= 0 &&
      end > offset &&
      end <= fileSize &&
      timecode >= 0;
    previous = offset;
    return valid;
  });
}

function normalizeClusterIndex(index, fileSize) {
  return index.map((item, position) => ({
    offset: Number(item.offset),
    end: Math.min(
      fileSize,
      Number(item.end),
      Number(index[position + 1]?.offset ?? fileSize)
    ),
    timecode: Number(item.timecode),
  }));
}

function parseWebmPrefix(prefix) {
  const top = walkElements(prefix, 0, prefix.length);
  const segment = top.find((item) => item.id === WEBM_SEGMENT_ID);
  if (!segment) {
    throw new Error(i18nMessage("webmMissingSegment", "WebM 缺少 Segment"));
  }
  const children = walkElements(prefix, segment.dataStart, prefix.length);
  const info = children.find((item) => item.id === WEBM_INFO_ID);
  const tracks = children.find((item) => item.id === WEBM_TRACKS_ID);
  let timecodeScale = 1_000_000;
  if (info) {
    const infoKids = walkElements(prefix, info.dataStart, info.dataEnd);
    const scale = infoKids.find((item) => item.id === WEBM_TIMECODE_SCALE_ID);
    if (scale) {
      const value = readUint(prefix.subarray(scale.dataStart, scale.dataEnd));
      if (value > 0) timecodeScale = value;
    }
  }
  return {
    ebmlHeader: prefix.subarray(0, segment.offset),
    infoBytes: info ? prefix.subarray(info.offset, info.dataEnd) : null,
    tracksBytes: tracks ? prefix.subarray(tracks.offset, tracks.dataEnd) : null,
    otherMetadata: children
      .filter(
        (item) =>
          ![
            WEBM_INFO_ID,
            WEBM_TRACKS_ID,
            WEBM_SEEK_HEAD_ID,
            WEBM_CUES_ID,
          ].includes(item.id)
      )
      .map((item) => prefix.subarray(item.offset, item.dataEnd)),
    timecodeScale,
  };
}

function rebuildInfo(infoBytes, timecodeScale, durationUnits) {
  const children = [];
  if (infoBytes) {
    const header = readElementHeader(infoBytes, 0);
    if (!header || header.id !== WEBM_INFO_ID) {
      throw new Error(i18nMessage("invalidWebmInfo", "WebM Info 无效"));
    }
    for (const child of walkElements(infoBytes, header.headerSize, infoBytes.length)) {
      if (child.id !== WEBM_DURATION_ID) {
        children.push(infoBytes.subarray(child.offset, child.dataEnd));
      }
    }
  } else {
    children.push(
      buildElement(WEBM_TIMECODE_SCALE_ID, writeUintMinimal(timecodeScale))
    );
  }
  children.push(buildElement(WEBM_DURATION_ID, writeFloat64(durationUnits)));
  return buildElement(WEBM_INFO_ID, concatBytes(children));
}

function findVideoTrackNumber(tracksBytes) {
  if (!tracksBytes) return 0;
  const tracksHeader = readElementHeader(tracksBytes, 0);
  if (!tracksHeader) return 0;
  const entries = walkElements(
    tracksBytes,
    tracksHeader.headerSize,
    tracksBytes.length
  ).filter((item) => item.id === WEBM_TRACK_ENTRY_ID);
  for (const entry of entries) {
    const children = walkElements(tracksBytes, entry.dataStart, entry.dataEnd);
    const type = children.find((item) => item.id === WEBM_TRACK_TYPE_ID);
    const number = children.find((item) => item.id === WEBM_TRACK_NUMBER_ID);
    if (
      type &&
      number &&
      readUint(tracksBytes.subarray(type.dataStart, type.dataEnd)) === 1
    ) {
      return readUint(tracksBytes.subarray(number.dataStart, number.dataEnd));
    }
  }
  return 0;
}

function findClusterCueTime(clusterBytes, trackNumber, clusterTimecode) {
  const cluster = readElementHeader(clusterBytes, 0);
  if (!cluster || cluster.id !== WEBM_CLUSTER_ID) return null;
  const children = walkElements(
    clusterBytes,
    cluster.headerSize,
    clusterBytes.length
  );
  for (const child of children) {
    if (child.id === WEBM_SIMPLE_BLOCK_ID) {
      const block = readBlockHeader(clusterBytes, child);
      if (block && block.trackNumber === trackNumber && block.keyframe) {
        return Math.max(0, clusterTimecode + block.relativeTimecode);
      }
    }
    if (child.id === WEBM_BLOCK_GROUP_ID) {
      const groupChildren = walkElements(
        clusterBytes,
        child.dataStart,
        child.dataEnd
      );
      const blockElement = groupChildren.find((item) => item.id === WEBM_BLOCK_ID);
      const reference = groupChildren.find(
        (item) => item.id === WEBM_REFERENCE_BLOCK_ID
      );
      const block = blockElement
        ? readBlockHeader(clusterBytes, blockElement, !reference)
        : null;
      if (block && block.trackNumber === trackNumber && block.keyframe) {
        return Math.max(0, clusterTimecode + block.relativeTimecode);
      }
    }
  }
  return null;
}

function readBlockHeader(bytes, element, keyframeOverride) {
  const track = readVint(bytes, element.dataStart);
  if (!track || track.value < 1) return null;
  const timecodeOffset = element.dataStart + track.length;
  const flagsOffset = timecodeOffset + 2;
  if (flagsOffset >= element.dataEnd) return null;
  let relativeTimecode = bytes[timecodeOffset] * 256 + bytes[timecodeOffset + 1];
  if (relativeTimecode & 0x8000) relativeTimecode -= 0x10000;
  return {
    trackNumber: track.value,
    relativeTimecode,
    keyframe:
      keyframeOverride === undefined
        ? Boolean(bytes[flagsOffset] & 0x80)
        : Boolean(keyframeOverride),
  };
}

function buildSeekHead({
  infoPosition,
  tracksPosition,
  cuesPosition,
  includeTracks,
}) {
  const entries = [buildSeekEntry(WEBM_INFO_ID, infoPosition)];
  if (includeTracks) entries.push(buildSeekEntry(WEBM_TRACKS_ID, tracksPosition));
  entries.push(buildSeekEntry(WEBM_CUES_ID, cuesPosition));
  return buildElement(WEBM_SEEK_HEAD_ID, concatBytes(entries));
}

function buildSeekEntry(targetId, position) {
  return buildElement(
    WEBM_SEEK_ID,
    concatBytes([
      buildElement(WEBM_SEEK_ID_ID, writeId(targetId)),
      buildElement(WEBM_SEEK_POSITION_ID, writeUintBE(position, 8)),
    ])
  );
}

function buildCues(cues, trackNumber) {
  return buildElement(
    WEBM_CUES_ID,
    concatBytes(
      cues.map((cue) =>
        buildElement(
          WEBM_CUE_POINT_ID,
          concatBytes([
            buildElement(WEBM_CUE_TIME_ID, writeUintMinimal(cue.timecode)),
            buildElement(
              WEBM_CUE_TRACK_POSITIONS_ID,
              concatBytes([
                buildElement(
                  WEBM_CUE_TRACK_ID,
                  writeUintMinimal(trackNumber)
                ),
                buildElement(
                  WEBM_CUE_CLUSTER_POSITION_ID,
                  writeUintBE(cue.position, 8)
                ),
              ])
            ),
          ])
        )
      )
    )
  );
}

function rewriteClusterBytes(input, timecode) {
  const full = toUint8Array(input);
  const header = readElementHeader(full, 0);
  if (!header || header.id !== WEBM_CLUSTER_ID) {
    throw new Error(i18nMessage("invalidWebmCluster", "WebM Cluster 无效"));
  }
  const kids = walkElements(full, header.headerSize, full.length);
  const parts = [];
  let changed = false;
  for (const kid of kids) {
    if (kid.id === WEBM_TIMECODE_ID) {
      parts.push(buildElement(WEBM_TIMECODE_ID, writeUintMinimal(timecode)));
      changed = true;
    } else {
      parts.push(full.subarray(kid.offset, kid.dataEnd));
    }
  }
  if (!changed) {
    throw new Error(
      i18nMessage("webmClusterMissingTimecode", "WebM Cluster 缺少时间码")
    );
  }
  return buildElement(WEBM_CLUSTER_ID, concatBytes(parts));
}

function walkElements(view, start, end) {
  const out = [];
  let offset = start;
  while (offset < end) {
    const header = readElementHeader(view, offset);
    if (!header) break;
    const dataStart = offset + header.headerSize;
    const dataEnd =
      header.dataSize < 0 ? end : Math.min(end, dataStart + header.dataSize);
    if (dataEnd < dataStart) break;
    out.push({
      id: header.id,
      offset,
      headerSize: header.headerSize,
      dataStart,
      dataEnd,
    });
    if (dataEnd <= offset) break;
    offset = dataEnd;
  }
  return out;
}

function readElementHeader(view, offset) {
  const id = readId(view, offset);
  if (!id) return null;
  const size = readVint(view, offset + id.length);
  if (!size) return null;
  return {
    id: id.id,
    headerSize: id.length + size.length,
    dataSize: size.value,
  };
}

function readId(view, offset) {
  if (offset >= view.length) return null;
  const first = view[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 4 || offset + length > view.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) {
    id = id * 256 + view[offset + i];
  }
  return { id, length };
}

function readVint(view, offset) {
  if (offset >= view.length) return null;
  const first = view[offset];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > view.length) return null;
  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + view[offset + i];
    if (view[offset + i] !== 0xff) unknown = false;
  }
  if (unknown) value = -1;
  return { value, length };
}

function writeVint(value, forcedLength) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(i18nMessage("invalidEbmlSize", "EBML 长度无效"));
  }
  let length = forcedLength || 1;
  if (!forcedLength) {
    while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
  }
  if (length < 1 || length > 8 || value >= 2 ** (7 * length) - 1) {
    throw new Error(i18nMessage("ebmlSizeOutOfRange", "EBML 长度超出范围"));
  }
  const out = writeUintBE(value, length);
  out[0] |= 2 ** (8 - length);
  return out;
}

function writeId(id) {
  if (id <= 0xff) return new Uint8Array([id]);
  if (id <= 0xffff) return new Uint8Array([(id >> 8) & 0xff, id & 0xff]);
  if (id <= 0xffffff) {
    return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
  }
  return new Uint8Array([
    Math.floor(id / 2 ** 24) & 0xff,
    Math.floor(id / 2 ** 16) & 0xff,
    Math.floor(id / 2 ** 8) & 0xff,
    id & 0xff,
  ]);
}

function writeUintBE(value, size) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(i18nMessage("invalidEbmlInteger", "EBML 整数无效"));
  }
  const out = new Uint8Array(size);
  let next = value;
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = next % 256;
    next = Math.floor(next / 256);
  }
  if (next) {
    throw new Error(
      i18nMessage("ebmlIntegerOutOfRange", "EBML 整数超出范围")
    );
  }
  return out;
}

function writeUintMinimal(value) {
  let size = 1;
  while (size < 8 && value >= 2 ** (8 * size)) size += 1;
  return writeUintBE(value, size);
}

function writeFloat64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, Number(value), false);
  return out;
}

function readUint(bytes) {
  let value = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    value = value * 256 + bytes[i];
  }
  return value;
}

function buildElement(id, data) {
  return concatBytes([writeId(id), writeVint(data.length), data]);
}

function concatBytes(chunks) {
  const size = chunks.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function matchesAt(bytes, offset, pattern) {
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error(i18nMessage("invalidWebmBytes", "WebM 字节数据无效"));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

if (typeof globalThis !== "undefined") {
  globalThis.createWebmClusterIndexer = createWebmClusterIndexer;
  globalThis.finalizeWebmFiles = finalizeWebmFiles;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildElement,
    concatBytes,
    createWebmClusterIndexer,
    finalizeWebmFiles,
    readElementHeader,
    readUint,
    walkElements,
    writeId,
    writeUintMinimal,
    writeVint,
  };
}
