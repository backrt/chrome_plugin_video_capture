import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILES = [
  "background.js",
  "shared.js",
  "recording-coordinator.js",
  "content.js",
  "content-protocol.js",
  "page-recorder.js",
  "offscreen.js",
  "offscreen-store.js",
  "webm-concat.js",
  "popup.html",
  "popup.js",
  "popup.css",
];
const ASSET_DIRECTORIES = ["icons", "_locales"];

function walkFiles(rootDirectory, relativeDirectory) {
  return fs
    .readdirSync(path.join(rootDirectory, relativeDirectory), {
      withFileTypes: true,
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Firefox package cannot contain symbolic links: ${relativePath}`);
      }
      return entry.isDirectory()
        ? walkFiles(rootDirectory, relativePath)
        : [relativePath];
    });
}

export function loadFirefoxManifest(rootDirectory = PROJECT_ROOT) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, "manifest.json"), "utf8")
  );
  if (manifest.manifest_version !== 3) {
    throw new Error("Firefox package must use Manifest V3");
  }
  if (manifest.background?.service_worker) {
    throw new Error("Firefox does not support background.service_worker");
  }
  if (!manifest.background?.scripts?.includes("background.js")) {
    throw new Error("Firefox package requires background scripts");
  }
  if (manifest.permissions?.includes("offscreen")) {
    throw new Error("Firefox package must not request the unsupported offscreen permission");
  }
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko?.id || !gecko?.strict_min_version) {
    throw new Error("Firefox package requires a Gecko ID and minimum version");
  }
  if (!gecko.data_collection_permissions?.required?.includes("none")) {
    throw new Error("Firefox package must explicitly declare its data collection policy");
  }
  return manifest;
}

function firefoxJavaScript(source) {
  return source.replaceAll("chrome.", "browser.");
}

export function collectFirefoxEntries(rootDirectory = PROJECT_ROOT) {
  const manifest = loadFirefoxManifest(rootDirectory);
  const files = [
    ...ROOT_FILES,
    ...ASSET_DIRECTORIES.flatMap((directory) =>
      walkFiles(rootDirectory, directory)
    ),
  ].sort();
  const entries = [
    {
      name: "manifest.json",
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    },
  ];
  for (const name of files) {
    const absolutePath = path.join(rootDirectory, name);
    if (!fs.statSync(absolutePath).isFile()) {
      throw new Error(`Missing Firefox package file: ${name}`);
    }
    const data = fs.readFileSync(absolutePath);
    entries.push({
      name,
      data: name.endsWith(".js")
        ? Buffer.from(firefoxJavaScript(data.toString("utf8")))
        : data,
    });
  }

  const popup = entries.find((entry) => entry.name === "popup.html").data.toString();
  if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(popup)) {
    throw new Error("Remote scripts are not allowed in the Firefox package");
  }
  return entries;
}

export function buildFirefoxPackage(rootDirectory = PROJECT_ROOT) {
  const manifest = loadFirefoxManifest(rootDirectory);
  const entries = collectFirefoxEntries(rootDirectory);
  const distDirectory = path.join(rootDirectory, "dist");
  const unpackedDirectory = path.join(distDirectory, "firefox-unpacked");
  const outputPath = path.join(
    distDirectory,
    `video-recorder-firefox-${manifest.version}.zip`
  );

  fs.rmSync(unpackedDirectory, { recursive: true, force: true });
  for (const entry of entries) {
    const outputFile = path.join(unpackedDirectory, entry.name);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, entry.data);
  }
  fs.writeFileSync(outputPath, createZip(entries));
  return { outputPath, unpackedDirectory, entries };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = buildFirefoxPackage();
  const size = fs.statSync(result.outputPath).size;
  console.log(`Firefox package: ${result.outputPath}`);
  console.log(`Unpacked directory: ${result.unpackedDirectory}`);
  console.log(`Files: ${result.entries.length}, size: ${size} bytes`);
}
