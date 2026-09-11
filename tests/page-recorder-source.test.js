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
