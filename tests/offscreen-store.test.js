const test = require("node:test");
const assert = require("node:assert/strict");

require("../shared.js");
require("../offscreen-store.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function segmentMeta(overrides = {}) {
  return {
    recordingId: "rec-12345678",
    frameKey: "0",
    groupId: "rec-12345678:f0:group:g0",
    segmentId: "rec-12345678:f0:segment:v1",
    mimeType: "video/webm",
    videoName: "video",
    rangeStart: 0,
    rangeEnd: 1,
    ...overrides,
  };
}

function chunkEnvelope(sequence, overrides = {}) {
  return {
    ...segmentMeta(),
    sequence,
    base64: "AQ==",
    byteLength: 1,
    ...overrides,
  };
}

function fakeDirectory({ writeGate = null, names = [] } = {}) {
  const files = new Map(
    names.map((name) => [name, { chunks: [], closed: false }])
  );
  return {
    async *entries() {
      for (const name of files.keys()) yield [name, {}];
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw new Error("NotFoundError");
    },
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options.create) throw new Error("NotFoundError");
        files.set(name, { chunks: [], closed: false });
      }
      const file = files.get(name);
      return {
        async createWritable() {
          return {
            async write(bytes) {
              if (writeGate) await writeGate.promise;
              file.chunks.push(Uint8Array.from(bytes));
            },
            async close() {
              file.closed = true;
            },
          };
        },
        async getFile() {
          const bytes = file.chunks.flatMap((chunk) => [...chunk]);
          return {
            size: bytes.length,
            type: "video/webm",
            arrayBuffer: async () => Uint8Array.from(bytes).buffer,
          };
        },
      };
    },
    names() {
      return [...files.keys()];
    },
  };
}

test("writeChunk acknowledges only after the OPFS write resolves", async () => {
  const gate = deferred();
  const directory = fakeDirectory({ writeGate: gate });
  const store = createRecordingStore({
    getDirectory: async () => directory,
    decodeBase64: base64ToBytes,
  });
  await store.reset("rec-12345678");
  await store.register(segmentMeta());

  let settled = false;
  const writing = store.writeChunk(chunkEnvelope(0)).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  gate.resolve();
  await writing;
  assert.equal(settled, true);
});

test("writeChunk accepts an idempotent retry and rejects a sequence gap", async () => {
  const directory = fakeDirectory();
  const store = createRecordingStore({
    getDirectory: async () => directory,
    decodeBase64: base64ToBytes,
  });
  await store.reset("rec-12345678");
  await store.register(segmentMeta());

  assert.equal((await store.writeChunk(chunkEnvelope(0))).duplicate, false);
  assert.equal((await store.writeChunk(chunkEnvelope(0))).duplicate, true);
  await assert.rejects(store.writeChunk(chunkEnvelope(2)), /分片序号不连续/);
});

test("finalize closes writers and returns serializable groups", async () => {
  const directory = fakeDirectory();
  const store = createRecordingStore({
    getDirectory: async () => directory,
    decodeBase64: base64ToBytes,
  });
  await store.reset("rec-12345678");
  await store.register(segmentMeta({ rangeEnd: undefined }));
  await store.writeChunk(chunkEnvelope(0));
  await store.register(segmentMeta({ rangeEnd: 4.5 }));
  await store.flushFrame("rec-12345678", "0");

  const result = await store.finalize("rec-12345678");
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].length, 1);
  assert.equal(result.groups[0][0].bytes, 1);
  assert.equal(result.groups[0][0].rangeEnd, 4.5);
  assert.equal(result.flushedFrames[0], "0");
  assert.doesNotThrow(() => structuredClone(result));
});

test("messages for a different recording are rejected", async () => {
  const directory = fakeDirectory();
  const store = createRecordingStore({
    getDirectory: async () => directory,
    decodeBase64: base64ToBytes,
  });
  await store.reset("rec-12345678");
  await assert.rejects(
    store.register(segmentMeta({ recordingId: "other-recording" })),
    /不是当前录制/
  );
});

test("cleanup removes segment and merged files for only one recording", async () => {
  const directory = fakeDirectory({
    names: [
      "recording-rec-12345678-a.bin",
      "merged-rec-12345678-g.bin",
      "recording-other-a.bin",
    ],
  });
  const store = createRecordingStore({
    getDirectory: async () => directory,
    decodeBase64: base64ToBytes,
  });

  await store.cleanup("rec-12345678");
  assert.deepEqual(directory.names(), ["recording-other-a.bin"]);
});
