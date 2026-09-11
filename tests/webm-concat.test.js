const test = require("node:test");
const assert = require("node:assert/strict");

require("../shared.js");

const {
  buildElement,
  concatBytes,
  createWebmClusterIndexer,
  finalizeWebmFiles,
  readElementHeader,
  readUint,
  walkElements,
  writeId,
  writeUintMinimal,
} = require("../webm-concat.js");

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7,
  CUE_CLUSTER_POSITION: 0xf1,
};

function fixture(clusterTimes) {
  const ebml = buildElement(ID.EBML, new Uint8Array(0));
  const info = buildElement(
    ID.INFO,
    buildElement(ID.TIMECODE_SCALE, writeUintMinimal(1_000_000))
  );
  const trackEntry = buildElement(
    ID.TRACK_ENTRY,
    concatBytes([
      buildElement(ID.TRACK_NUMBER, writeUintMinimal(2)),
      buildElement(ID.TRACK_TYPE, writeUintMinimal(1)),
    ])
  );
  const tracks = buildElement(ID.TRACKS, trackEntry);
  const clusters = clusterTimes.map((timecode) =>
    buildElement(
      ID.CLUSTER,
      concatBytes([
        buildElement(ID.TIMECODE, writeUintMinimal(timecode)),
        buildElement(ID.SIMPLE_BLOCK, new Uint8Array([0x82, 0, 0, 0x80, 1, 2, 3])),
      ])
    )
  );
  const unknownSegmentSize = new Uint8Array([
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  return concatBytes([
    ebml,
    writeId(ID.SEGMENT),
    unknownSegmentSize,
    info,
    tracks,
    ...clusters,
  ]);
}

function index(bytes, splitAt = bytes.length) {
  const indexer = createWebmClusterIndexer();
  indexer.push(bytes.subarray(0, splitAt), 0);
  indexer.push(bytes.subarray(splitAt), splitAt);
  return indexer.snapshot(bytes.length);
}

function memoryWritable() {
  let bytes = new Uint8Array(0);
  let position = 0;
  return {
    async write(input) {
      const patch = input && input.type === "write";
      const data = Uint8Array.from(patch ? input.data : input);
      const start = patch ? input.position : position;
      const end = start + data.length;
      if (end > bytes.length) {
        const grown = new Uint8Array(end);
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(data, start);
      position = end;
    },
    bytes: () => bytes,
  };
}

function child(bytes, parent, id) {
  return walkElements(bytes, parent.dataStart, parent.dataEnd).find(
    (item) => item.id === id
  );
}

test("incremental indexer detects a Cluster split across recorder chunks", () => {
  const bytes = fixture([0, 1000]);
  const signature = [0x1f, 0x43, 0xb6, 0x75];
  const firstCluster = bytes.findIndex(
    (_, offset) => signature.every((value, index) => bytes[offset + index] === value)
  );
  const result = index(bytes, firstCluster + 2);

  assert.deepEqual(
    result.map((item) => item.timecode),
    [0, 1000]
  );
  assert.equal(result[0].offset, firstCluster);
  assert.equal(result[0].end, result[1].offset);
});

test("finalizer writes Duration, SeekHead and a cue for every Cluster", async () => {
  const firstBytes = fixture([0, 1000]);
  const secondBytes = fixture([0]);
  const sink = memoryWritable();
  const result = await finalizeWebmFiles(
    [
      {
        file: new Blob([firstBytes]),
        durationSec: 2,
        webmIndex: index(firstBytes),
      },
      {
        file: new Blob([secondBytes]),
        durationSec: 1,
        webmIndex: index(secondBytes),
      },
    ],
    sink
  );
  const output = sink.bytes();
  const top = walkElements(output, 0, output.length);
  const segment = top.find((item) => item.id === ID.SEGMENT);
  const children = walkElements(output, segment.dataStart, segment.dataEnd);
  const seekHead = children.find((item) => item.id === ID.SEEK_HEAD);
  const info = children.find((item) => item.id === ID.INFO);
  const cues = children.find((item) => item.id === ID.CUES);
  const clusters = children.filter((item) => item.id === ID.CLUSTER);

  assert.equal(segment.dataEnd, output.length);
  assert.equal(result.cueCount, 3);
  assert.equal(clusters.length, 3);
  assert.ok(seekHead);
  assert.ok(info);
  assert.ok(cues);

  const duration = child(output, info, ID.DURATION);
  const durationValue = new DataView(
    output.buffer,
    output.byteOffset + duration.dataStart,
    duration.dataEnd - duration.dataStart
  ).getFloat64(0, false);
  assert.equal(durationValue, 3000);

  const cuePoints = walkElements(output, cues.dataStart, cues.dataEnd).filter(
    (item) => item.id === ID.CUE_POINT
  );
  assert.deepEqual(
    cuePoints.map((point) => {
      const cueTime = child(output, point, ID.CUE_TIME);
      const positions = child(output, point, ID.CUE_TRACK_POSITIONS);
      const cueTrack = child(output, positions, ID.CUE_TRACK);
      const clusterPosition = child(output, positions, ID.CUE_CLUSTER_POSITION);
      return {
        time: readUint(output.subarray(cueTime.dataStart, cueTime.dataEnd)),
        track: readUint(output.subarray(cueTrack.dataStart, cueTrack.dataEnd)),
        position: readUint(
          output.subarray(clusterPosition.dataStart, clusterPosition.dataEnd)
        ),
      };
    }),
    [
      { time: 0, track: 2, position: clusters[0].offset - segment.dataStart },
      { time: 1000, track: 2, position: clusters[1].offset - segment.dataStart },
      { time: 2000, track: 2, position: clusters[2].offset - segment.dataStart },
    ]
  );

  const cueSeek = walkElements(output, seekHead.dataStart, seekHead.dataEnd)
    .filter((item) => item.id === ID.SEEK)
    .find((seek) => {
      const target = child(output, seek, ID.SEEK_ID);
      return readUint(output.subarray(target.dataStart, target.dataEnd)) === ID.CUES;
    });
  const cueSeekPosition = child(output, cueSeek, ID.SEEK_POSITION);
  assert.equal(
    readUint(output.subarray(cueSeekPosition.dataStart, cueSeekPosition.dataEnd)),
    cues.offset - segment.dataStart
  );
});

test("finalizer can rebuild an index by streaming the source file", async () => {
  const bytes = fixture([0, 1000]);
  const sink = memoryWritable();
  const result = await finalizeWebmFiles(
    [{ file: new Blob([bytes]), durationSec: 2, webmIndex: [] }],
    sink
  );

  assert.equal(result.cueCount, 2);
  const output = sink.bytes();
  const segment = walkElements(output, 0, output.length).find(
    (item) => item.id === ID.SEGMENT
  );
  assert.ok(child(output, segment, ID.CUES));
  assert.notEqual(readElementHeader(output, segment.offset).dataSize, -1);
});
