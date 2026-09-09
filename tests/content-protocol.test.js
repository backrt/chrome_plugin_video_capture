const test = require("node:test");
const assert = require("node:assert/strict");

require("../shared.js");
require("../content-protocol.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function options(frameKey, send) {
  return {
    recordingId: "rec-12345678",
    frameKey,
    bridgeToken: "bridge-12345678",
    send,
  };
}

function registration(groupId = "g0", videoId = "v1", overrides = {}) {
  return {
    groupId,
    videoId,
    videoName: "video",
    mimeType: "video/webm",
    rangeStart: 0,
    ...overrides,
  };
}

function chunk(groupId = "g0", videoId = "v1", bytes = [1]) {
  return {
    groupId,
    videoId,
    videoName: "video",
    mimeType: "video/webm",
    buffer: Uint8Array.from(bytes),
  };
}

test("identical page IDs in two frames become different extension IDs", async () => {
  const sent = [];
  const send = async (message) => {
    sent.push(message);
    return { ok: true };
  };
  const first = createFrameProtocol(options("0", send));
  const second = createFrameProtocol(options("7", send));

  await first.register(registration());
  await second.register(registration());

  assert.notEqual(sent[0].segmentId, sent[1].segmentId);
  assert.notEqual(sent[0].groupId, sent[1].groupId);
  assert.equal(sent[0].bridgeToken, undefined);
});

test("flush waits for registration and chunk acknowledgements", async () => {
  const calls = [];
  const registerGate = deferred();
  const chunkGate = deferred();
  const protocol = createFrameProtocol(
    options("0", async (message) => {
      calls.push(message.type);
      if (message.type === MSG.REGISTER_SEGMENT) await registerGate.promise;
      if (message.type === MSG.WRITE_CHUNK) await chunkGate.promise;
      return { ok: true };
    })
  );

  const registering = protocol.register(registration());
  const writing = protocol.chunk(chunk());
  const flushing = protocol.flush({ errors: [] });
  await Promise.resolve();
  assert.deepEqual(calls, [MSG.REGISTER_SEGMENT]);

  registerGate.resolve();
  await registering;
  await Promise.resolve();
  assert.deepEqual(calls, [MSG.REGISTER_SEGMENT, MSG.WRITE_CHUNK]);

  chunkGate.resolve();
  await writing;
  await flushing;
  assert.equal(calls.at(-1), MSG.FLUSH_FRAME);
});

test("chunk sequence is independent for each local segment", async () => {
  const sent = [];
  const protocol = createFrameProtocol(
    options("0", async (message) => {
      sent.push(message);
      return { ok: true };
    })
  );

  await protocol.chunk(chunk("g0", "v1"));
  await protocol.chunk(chunk("g0", "v2"));
  await protocol.chunk(chunk("g0", "v1"));

  const writes = sent.filter((message) => message.type === MSG.WRITE_CHUNK);
  assert.deepEqual(
    writes.map((message) => [message.segmentId.split(":").at(-1), message.sequence]),
    [
      ["v1", 0],
      ["v2", 0],
      ["v1", 1],
    ]
  );
});

test("failed Offscreen acknowledgement rejects the frame queue", async () => {
  const protocol = createFrameProtocol(
    options("0", async () => ({ ok: false, error: "disk full" }))
  );
  await assert.rejects(protocol.register(registration()), /disk full/);
  await assert.rejects(protocol.flush({ errors: [] }), /disk full/);
});

test("one chunk larger than the bridge limit is rejected before send", async () => {
  let calls = 0;
  const protocol = createFrameProtocol(
    options("0", async () => {
      calls += 1;
      return { ok: true };
    })
  );
  const tooLarge = { ...chunk(), buffer: new Uint8Array(MAX_CHUNK_BYTES + 1) };
  await assert.rejects(protocol.chunk(tooLarge), /过大/);
  assert.equal(calls, 0);
});

test("drain waits for all queued registration acknowledgements", async () => {
  const gate = deferred();
  const protocol = createFrameProtocol(
    options("0", async () => {
      await gate.promise;
      return { ok: true };
    })
  );
  protocol.register(registration());
  let drained = false;
  const draining = protocol.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  gate.resolve();
  await draining;
  assert.equal(drained, true);
});
