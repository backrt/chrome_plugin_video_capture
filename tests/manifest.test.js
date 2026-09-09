const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("manifest declares the reliable pipeline version and alarm permission", () => {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.version, "1.3.0");
  assert.equal(manifest.permissions.includes("alarms"), true);
});
