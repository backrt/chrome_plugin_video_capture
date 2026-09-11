const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("manifest declares the Firefox MV3 background and AMO metadata", () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.equal(manifest.background.service_worker, undefined);
  assert.ok(manifest.background.scripts.includes("background.js"));
  assert.ok(manifest.background.scripts.includes("offscreen.js"));
  assert.equal(manifest.version, "1.6.0");
  assert.equal(manifest.default_locale, "zh_CN");
  assert.equal(manifest.name, "__MSG_appName__");
  assert.equal(manifest.permissions.includes("alarms"), true);
  assert.equal(manifest.permissions.includes("offscreen"), false);
  assert.equal(
    manifest.browser_specific_settings.gecko.id,
    "video-recorder@backrt.github.io"
  );
});
