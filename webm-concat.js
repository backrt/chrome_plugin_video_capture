const WEBM_CLUSTER_ID = 0x1f43b675;
const WEBM_SEGMENT_ID = 0x18538067;
const WEBM_TIMECODE_ID = 0xe7;
const WEBM_INFO_ID = 0x1549a966;
const WEBM_TIMECODE_SCALE_ID = 0x2ad7b1;

function concatWebmParts(parts) {
  if (!parts || !parts.length) {
    throw new Error("没有可拼接的片段");
  }
  if (parts.length === 1) {
    return parts[0].bytes;
  }

  const parsed = parts.map((part) => parseWebm(part.bytes));
  const header = parsed[0].header;
  const scale = parsed[0].timecodeScale || 1_000_000;
  const clusters = [];
  let offset = 0;

  for (let i = 0; i < parsed.length; i += 1) {
    const part = parts[i];
    const item = parsed[i];
    for (const cluster of item.clusters) {
      clusters.push(rewriteClusterTimecode(part.bytes, cluster, offset));
    }
    const durationSec = Number(part.durationSec);
    if (Number.isFinite(durationSec) && durationSec > 0) {
      offset += Math.round((durationSec * 1e9) / scale);
    } else {
      offset += Math.max(item.durationUnits, 1);
    }
  }

  return concatBytes([header, ...clusters]);
}

function parseWebm(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const top = walkElements(view, 0, view.length);
  const segment = top.find((item) => item.id === WEBM_SEGMENT_ID);
  const children = segment
    ? walkElements(view, segment.dataStart, segment.dataEnd)
    : top;
  const clusters = children.filter((item) => item.id === WEBM_CLUSTER_ID);
  if (!clusters.length) {
    throw new Error("片段里没有可播放的视频数据");
  }
  const headerEnd = clusters[0].offset;
  const info = children.find((item) => item.id === WEBM_INFO_ID);
  let timecodeScale = 1_000_000;
  if (info) {
    const infoKids = walkElements(view, info.dataStart, info.dataEnd);
    const scaleEl = infoKids.find((item) => item.id === WEBM_TIMECODE_SCALE_ID);
    if (scaleEl) {
      const value = readUint(view.subarray(scaleEl.dataStart, scaleEl.dataEnd));
      if (value > 0) timecodeScale = value;
    }
  }
  let durationUnits = 0;
  for (const cluster of clusters) {
    const tc = readClusterTimecode(view, cluster);
    if (tc > durationUnits) durationUnits = tc;
  }
  return {
    header: view.subarray(0, headerEnd),
    clusters,
    timecodeScale,
    durationUnits: durationUnits + 1,
  };
}

function rewriteClusterTimecode(bytes, cluster, addUnits) {
  const full = bytes.subarray(cluster.offset, cluster.dataEnd);
  if (!addUnits) return full;
  const header = readElementHeader(full, 0);
  if (!header) return full;
  const kids = walkElements(full, header.headerSize, full.length);
  const parts = [];
  let changed = false;
  for (const kid of kids) {
    if (kid.id === WEBM_TIMECODE_ID) {
      const next = readUint(full.subarray(kid.dataStart, kid.dataEnd)) + addUnits;
      parts.push(buildElement(WEBM_TIMECODE_ID, writeUintBE(next, 8)));
      changed = true;
    } else {
      parts.push(full.subarray(kid.offset, kid.dataEnd));
    }
  }
  if (!changed) return full;
  return buildElement(WEBM_CLUSTER_ID, concatBytes(parts));
}

function readClusterTimecode(bytes, cluster) {
  const kids = walkElements(bytes, cluster.dataStart, cluster.dataEnd);
  const tc = kids.find((item) => item.id === WEBM_TIMECODE_ID);
  if (!tc) return 0;
  return readUint(bytes.subarray(tc.dataStart, tc.dataEnd));
}

function walkElements(view, start, end) {
  const out = [];
  let offset = start;
  while (offset < end) {
    const header = readElementHeader(view, offset);
    if (!header) break;
    const dataStart = offset + header.headerSize;
    const dataEnd = header.dataSize < 0 ? end : Math.min(end, dataStart + header.dataSize);
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
  if (offset + length > view.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) {
    id = (id << 8) | view[offset + i];
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
  if (offset + length > view.length) return null;
  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + view[offset + i];
    if (view[offset + i] !== 0xff) unknown = false;
  }
  if (unknown) value = -1;
  return { value, length };
}

function writeVint(value) {
  if (value < 0) {
    return new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  }
  let length = 1;
  let max = 127;
  while (value > max && length < 8) {
    length += 1;
    max = (1 << (7 * length)) - 1;
  }
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  out[0] |= 1 << (8 - length);
  return out;
}

function writeId(id) {
  if (id <= 0xff) return new Uint8Array([id]);
  if (id <= 0xffff) return new Uint8Array([(id >> 8) & 0xff, id & 0xff]);
  if (id <= 0xffffff) {
    return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
  }
  return new Uint8Array([
    (id >> 24) & 0xff,
    (id >> 16) & 0xff,
    (id >> 8) & 0xff,
    id & 0xff,
  ]);
}

function writeUintBE(value, size) {
  const out = new Uint8Array(size);
  let next = value;
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = next & 0xff;
    next = Math.floor(next / 256);
  }
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
