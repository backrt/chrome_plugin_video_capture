const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

require("../shared.js");

const LOCALES = ["zh_CN", "zh_TW", "en", "ja", "ko"];
const SOURCE_FILES = [
  "shared.js",
  "popup.js",
  "content.js",
  "content-protocol.js",
  "page-recorder.js",
  "background.js",
  "offscreen.js",
  "offscreen-store.js",
  "recording-coordinator.js",
  "webm-concat.js",
];

function loadMessages(locale) {
  return JSON.parse(
    fs.readFileSync(`_locales/${locale}/messages.json`, "utf8")
  );
}

function referencedMessageKeys() {
  const source = SOURCE_FILES.map((file) => fs.readFileSync(file, "utf8")).join(
    "\n"
  );
  const keys = new Set(
    [...source.matchAll(/i18nMessage\(\s*"([A-Za-z0-9_]+)"/g)].map(
      (match) => match[1]
    )
  );
  const html = fs.readFileSync("popup.html", "utf8");
  for (const match of html.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) {
    keys.add(match[1]);
  }
  const manifest = fs.readFileSync("manifest.json", "utf8");
  for (const match of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    keys.add(match[1]);
  }
  const pageMap = source.match(/PAGE_I18N_FALLBACKS\s*=\s*{([\s\S]*?)};/);
  assert.ok(pageMap, "page-world locale message map must exist");
  for (const match of pageMap[1].matchAll(/^\s*([A-Za-z0-9_]+):/gm)) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

test("all five locale catalogs contain the same complete message set", () => {
  const catalogs = Object.fromEntries(
    LOCALES.map((locale) => [locale, loadMessages(locale)])
  );
  const expected = Object.keys(catalogs.zh_CN).sort();
  const referenced = referencedMessageKeys();

  for (const locale of LOCALES) {
    const catalog = catalogs[locale];
    assert.deepEqual(Object.keys(catalog).sort(), expected, locale);
    for (const key of referenced) {
      assert.equal(typeof catalog[key]?.message, "string", `${locale}:${key}`);
      assert.notEqual(catalog[key].message, "", `${locale}:${key}`);
    }
  }
});

test("locale placeholders are declared and consistent", () => {
  const base = loadMessages("zh_CN");
  for (const locale of LOCALES) {
    const catalog = loadMessages(locale);
    for (const [key, entry] of Object.entries(catalog)) {
      assert.deepEqual(
        Object.keys(entry.placeholders || {}).sort(),
        Object.keys(base[key].placeholders || {}).sort(),
        `${locale}:${key}`
      );
      for (const placeholder of entry.message.matchAll(/\$([A-Z0-9_]+)\$/g)) {
        assert.ok(
          entry.placeholders?.[placeholder[1].toLowerCase()],
          `${locale}:${key}:${placeholder[1]}`
        );
      }
    }
  }
});

test("page-world translations preserve runtime substitutions", () => {
  globalThis.__vcI18nMessages = { sampleCount: "Count: $1" };
  assert.equal(i18nMessage("sampleCount", "数量：$1", 3), "Count: 3");
  delete globalThis.__vcI18nMessages;
});
