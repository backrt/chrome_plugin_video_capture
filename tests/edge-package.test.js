const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

async function loadBuilder() {
  return import("../scripts/build-edge-package.mjs");
}

test("Edge package contains only runtime files", async () => {
  const { collectPackageFiles, validateEdgePackage } = await loadBuilder();
  const files = collectPackageFiles();
  const manifest = validateEdgePackage();

  assert.equal(manifest.manifest_version, 3);
  assert.equal(Object.hasOwn(manifest, "update_url"), false);
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("background.js"));
  assert.ok(files.includes("icons/icon128.png"));
  for (const locale of ["zh_CN", "zh_TW", "en", "ja", "ko"]) {
    assert.ok(files.includes(`_locales/${locale}/messages.json`));
  }
  for (const prefix of ["README.md", "package.json", "tests/", "docs/", ".git/"]) {
    assert.equal(
      files.some((file) => file === prefix || file.startsWith(prefix)),
      false,
      prefix
    );
  }
});

test("Edge ZIP output is deterministic and has a valid directory", async () => {
  const { collectPackageFiles, createZip } = await loadBuilder();
  const entries = collectPackageFiles().map((name) => ({
    name,
    data: fs.readFileSync(name),
  }));
  const first = createZip(entries);
  const second = createZip(entries);

  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
  assert.equal(first.readUInt16LE(first.length - 12), entries.length);
  assert.ok(first.includes(Buffer.from("manifest.json")));
});

test("Edge runtime compatibility fallbacks remain present", () => {
  const background = fs.readFileSync("background.js", "utf8");
  const shared = fs.readFileSync("shared.js", "utf8");

  assert.match(
    background,
    /chrome\.storage\.session\s*\|\|\s*chrome\.storage\.local/
  );
  assert.match(background, /typeof chrome\.runtime\.getContexts/);
  assert.match(background, /self\.clients\?\.matchAll/);
  assert.ok(shared.includes('url.startsWith("edge://")'));
});
