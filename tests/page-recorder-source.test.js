const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("gap filling never changes the page video's muted state", () => {
  const source = fs.readFileSync("page-recorder.js", "utf8");
  assert.doesNotMatch(source, /session\.video\.muted\s*=/);
});
