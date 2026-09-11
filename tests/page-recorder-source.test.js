const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("recording pipeline has no automatic gap filling", () => {
  const files = ["page-recorder.js", "content.js", "background.js", "shared.js"];
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(
    source,
    /fillGapsForSession|findGaps|playThrough|FILL_PROGRESS/
  );
  assert.doesNotMatch(source, /fillHint|fillRemain|session\.filling/);
});

test("page-to-content chunks are cloned instead of transferred across realms", () => {
  const source = fs.readFileSync("page-recorder.js", "utf8");
  assert.doesNotMatch(source, /postToIsolated\([\s\S]*?"CHUNK"[\s\S]*?\[buffer\]/);
});
