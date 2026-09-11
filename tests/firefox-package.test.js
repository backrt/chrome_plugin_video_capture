const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

async function loadBuilder() {
  return import("../scripts/build-firefox-package.mjs");
}

test("Firefox manifest uses a document background and AMO metadata", async () => {
  const { loadFirefoxManifest } = await loadBuilder();
  const manifest = loadFirefoxManifest();
  const gecko = manifest.browser_specific_settings.gecko;

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, undefined);
  assert.ok(manifest.background.scripts.includes("offscreen.js"));
  assert.ok(manifest.background.scripts.includes("background.js"));
  assert.equal(manifest.permissions.includes("offscreen"), false);
  assert.equal(gecko.id, "video-recorder@backrt.github.io");
  assert.equal(gecko.strict_min_version, "142.0");
  assert.deepEqual(gecko.data_collection_permissions.required, ["none"]);
});

test("Firefox package contains only runtime files using the browser namespace", async () => {
  const { collectFirefoxEntries } = await loadBuilder();
  const entries = collectFirefoxEntries();
  const names = entries.map((entry) => entry.name);

  assert.ok(names.includes("manifest.json"));
  assert.ok(names.includes("background.js"));
  assert.ok(names.includes("icons/icon128.png"));
  assert.ok(names.includes("icons/icon-recording-dim.svg"));
  assert.equal(names.includes("offscreen.html"), false);
  assert.equal(names.some((name) => name.startsWith("tests/")), false);
  assert.equal(names.some((name) => name.startsWith("docs/")), false);

  for (const entry of entries.filter((item) => item.name.endsWith(".js"))) {
    assert.doesNotMatch(entry.data.toString("utf8"), /\bchrome\./, entry.name);
  }
});

test("Firefox background lifecycle is protected during recording", () => {
  const background = fs.readFileSync("background.js", "utf8");
  const content = fs.readFileSync("content.js", "utf8");
  const offscreen = fs.readFileSync("offscreen.js", "utf8");

  assert.match(background, /typeof importScripts === "function"/);
  assert.match(background, /chrome\.runtime\.onConnect/);
  assert.match(background, /keepAlivePorts\.add/);
  assert.match(content, /chrome\.runtime\.connect/);
  assert.match(content, /video-capture-recording/);
  assert.match(
    offscreen,
    /__videoCaptureInlineOffscreenV1 = handleOffscreenRequest/
  );
  assert.match(background, /await globalThis\.__videoCaptureInlineOffscreenV1/);
});

test("Firefox toolbar icon blinks only while recording", () => {
  const background = fs.readFileSync("background.js", "utf8");

  assert.match(background, /ICON_BLINK_INTERVAL_MS = 700/);
  assert.match(background, /function startIconBlink\(\)/);
  assert.match(background, /function stopIconBlink\(\)/);
  assert.match(background, /chrome\.action\.setIcon/);
  assert.match(background, /RECORDING_ACTION_ICON/);
  assert.match(background, /startBadge[\s\S]*startIconBlink\(\)/);
  assert.match(background, /stopBadge[\s\S]*stopIconBlink\(\)/);
});

test("ZIP helper produces deterministic Firefox submission data", async () => {
  const { collectFirefoxEntries } = await loadBuilder();
  const { createZip } = await import("../scripts/zip.mjs");
  const entries = collectFirefoxEntries();
  const first = createZip(entries);
  const second = createZip(entries);

  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
  assert.equal(first.readUInt16LE(first.length - 12), entries.length);
});
