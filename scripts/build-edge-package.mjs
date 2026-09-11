import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILES = [
  "manifest.json",
  "background.js",
  "shared.js",
  "recording-coordinator.js",
  "content.js",
  "content-protocol.js",
  "page-recorder.js",
  "offscreen.html",
  "offscreen.js",
  "offscreen-store.js",
  "webm-concat.js",
  "popup.html",
  "popup.js",
  "popup.css",
];
const ASSET_DIRECTORIES = ["icons", "_locales"];
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01, making the package reproducible.
const UTF8_FLAG = 0x0800;

function walkFiles(rootDirectory, relativeDirectory) {
  const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
  return fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Edge package cannot contain symbolic links: ${relativePath}`);
      }
      return entry.isDirectory()
        ? walkFiles(rootDirectory, relativePath)
        : [relativePath];
    });
}

export function collectPackageFiles(rootDirectory = PROJECT_ROOT) {
  const files = [
    ...ROOT_FILES,
    ...ASSET_DIRECTORIES.flatMap((directory) =>
      walkFiles(rootDirectory, directory)
    ),
  ].sort();

  for (const relativePath of files) {
    const absolutePath = path.join(rootDirectory, relativePath);
    if (!fs.statSync(absolutePath).isFile()) {
      throw new Error(`Missing Edge package file: ${relativePath}`);
    }
  }
  return files;
}

export function validateEdgePackage(rootDirectory = PROJECT_ROOT) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, "manifest.json"), "utf8")
  );
  if (manifest.manifest_version !== 3) {
    throw new Error("Microsoft Edge Add-ons requires a Manifest V3 package");
  }
  if (Object.hasOwn(manifest, "update_url")) {
    throw new Error("Remove update_url before submitting to Microsoft Edge Add-ons");
  }
  const localePath = path.join(
    rootDirectory,
    "_locales",
    String(manifest.default_locale || ""),
    "messages.json"
  );
  if (!manifest.default_locale || !fs.existsSync(localePath)) {
    throw new Error("manifest.default_locale must point to an included locale");
  }

  for (const htmlFile of ["popup.html", "offscreen.html"]) {
    const html = fs.readFileSync(path.join(rootDirectory, htmlFile), "utf8");
    if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(html)) {
      throw new Error(`Remote script is not allowed in Manifest V3: ${htmlFile}`);
    }
  }
  return manifest;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll(path.sep, "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function buildEdgePackage(rootDirectory = PROJECT_ROOT) {
  const manifest = validateEdgePackage(rootDirectory);
  const files = collectPackageFiles(rootDirectory);
  const entries = files.map((name) => ({
    name,
    data: fs.readFileSync(path.join(rootDirectory, name)),
  }));
  const outputDirectory = path.join(rootDirectory, "dist");
  const outputPath = path.join(
    outputDirectory,
    `video-recorder-edge-${manifest.version}.zip`
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(outputPath, createZip(entries));
  return { outputPath, files };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = buildEdgePackage();
  const size = fs.statSync(result.outputPath).size;
  console.log(`Edge package: ${result.outputPath}`);
  console.log(`Files: ${result.files.length}, size: ${size} bytes`);
}
