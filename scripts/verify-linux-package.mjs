import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { verifyComplianceDirectory } from "./compliance.mjs";

const require = createRequire(import.meta.url);
const { listPackage } = require("@electron/asar");

const arch = process.argv[2];
if (arch !== "x64" && arch !== "arm64") {
  throw new Error("Usage: node scripts/verify-linux-package.mjs <x64|arm64>");
}

const manifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
// The expected native payload set is derived from package.json at verify time, never
// hard coded: a payload is REQUIRED while its declaring package is still a dependency
// and FORBIDDEN once that dependency is removed. This keeps the verifier correct across
// dependency removals without a second edit.
const declaredDependencies = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
]);
const declares = (name) => declaredDependencies.has(name);

const outputRoot = path.resolve("release");
const unpackedName = arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`;
const unpacked = readdirSync(outputRoot)
  .map((name) => path.join(outputRoot, name))
  .find((entry) => statSync(entry).isDirectory() && path.basename(entry) === unpackedName);
if (!unpacked) throw new Error(`Could not find the ${arch} unpacked Linux application.`);

// build.linux.artifactName is "${productName}-${version}-linux-${arch}.${ext}".
const expectedImage = `${manifest.build.productName}-${manifest.version}-linux-${arch}.AppImage`;
const images = readdirSync(outputRoot).filter((name) => name.endsWith(".AppImage"));
if (!images.includes(expectedImage)) {
  throw new Error(
    `Expected AppImage ${expectedImage} in release/, found: ${images.join(", ") || "none"}.`,
  );
}

// electron-builder names the Linux executable after the sanitized package name.
const appExecutable = path.join(unpacked, "skill-recorder");
const expectedMachine = arch === "arm64" ? 0xb7 : 0x3e;
verifyElfMachine(appExecutable, expectedMachine);
verifyElfMachine(path.join(unpacked, "libffmpeg.so"), expectedMachine);

const asarPath = path.join(unpacked, "resources", "app.asar");
const asarEntries = listPackage(asarPath).map((entry) =>
  entry.replace(/^[\\/]+/, "").replaceAll("\\", "/").toLowerCase(),
);
const asarFiles = asarEntries.map((entry) => `${asarPath}!${entry}`);
const files = [...walk(unpacked), ...asarFiles];
const normalizedFiles = files.map((file) => file.toLowerCase().replaceAll("\\", "/"));

const expectedPayloads = [];
const forbiddenPayloads = [];

// sharp always ships two platform packages: the N-API binding and the libvips runtime.
addConditionalPayloads(declares("sharp"), [
  {
    packagePath: `/@img/sharp-linux-${arch}/`,
    executable: `/@img/sharp-linux-${arch}/lib/sharp-linux-${arch}.node`,
  },
  {
    packagePath: `/@img/sharp-libvips-linux-${arch}/`,
    // The shared object carries a libvips version suffix (libvips-cpp.so.8.17.3).
    executablePattern: new RegExp(
      `/@img/sharp-libvips-linux-${arch}/lib/libvips-cpp\\.so(?:\\.[0-9]+)*$`,
    ),
  },
]);

// koffi resolves its prebuild through the @koromix scope on every platform.
addConditionalPayloads(declares("koffi"), [
  {
    packagePath: `/@koromix/koffi-linux-${arch}/`,
    executable: `/@koromix/koffi-linux-${arch}/linux_${arch}/koffi.node`,
  },
]);

// onnxruntime-node is transitive through @huggingface/transformers; both leave together.
addConditionalPayloads(declares("@huggingface/transformers"), [
  { packagePath: "/@huggingface/transformers/" },
  {
    packagePath: `/onnxruntime-node/bin/napi-v6/linux/${arch}/`,
    executable: `/onnxruntime-node/bin/napi-v6/linux/${arch}/onnxruntime_binding.node`,
  },
]);

addConditionalPayloads(declares("@github/copilot-sdk"), [
  {
    packagePath: `/@github/copilot-linux-${arch}/`,
    executable: `/@github/copilot-linux-${arch}/copilot`,
  },
]);

for (const payload of expectedPayloads) {
  if (!normalizedFiles.some((file) => file.includes(payload.packagePath))) {
    throw new Error(`Packaged ${arch} application is missing ${payload.packagePath}.`);
  }
  if (!payload.executable && !payload.executablePattern) continue;

  const executableIndex = payload.executable
    ? normalizedFiles.findIndex((file) => file.endsWith(payload.executable))
    : normalizedFiles.findIndex((file) => payload.executablePattern.test(file));
  if (executableIndex === -1) {
    throw new Error(
      `Packaged ${arch} application is missing ${payload.executable ?? payload.executablePattern}.`,
    );
  }
  verifyElfMachine(files[executableIndex], expectedMachine);
}

const otherArch = arch === "arm64" ? "x64" : "arm64";
const wrongArchitecturePayloads = [
  `/@koromix/koffi-linux-${otherArch}/`,
  `/@img/sharp-linux-${otherArch}/`,
  `/@img/sharp-libvips-linux-${otherArch}/`,
  `/@github/copilot-linux-${otherArch}/`,
  `/onnxruntime-node/bin/napi-v6/linux/${otherArch}/`,
];
// Foreign-platform payloads of the same packages must never reach a Linux package.
const foreignPlatformPayloads = [
  "/@koromix/koffi-win32-",
  "/@koromix/koffi-darwin-",
  "/@img/sharp-win32-",
  "/@img/sharp-darwin-",
  "/@img/sharp-libvips-darwin-",
  "/@github/copilot-win32-",
  "/@github/copilot-darwin-",
  "/onnxruntime-node/bin/napi-v6/win32/",
  "/onnxruntime-node/bin/napi-v6/darwin/",
];
for (const wrongPayload of [
  ...wrongArchitecturePayloads,
  ...foreignPlatformPayloads,
  ...forbiddenPayloads,
]) {
  if (normalizedFiles.some((file) => file.includes(wrongPayload))) {
    throw new Error(`Packaged ${arch} application contains ${wrongPayload}.`);
  }
}

// get-windows is a macOS-only optional dependency; Linux uses the in-repo X11 provider.
if (normalizedFiles.some((file) => file.includes("/node_modules/get-windows/"))) {
  throw new Error(`Packaged ${arch} application contains node_modules/get-windows/.`);
}

const forbiddenStandaloneFfmpeg = normalizedFiles.filter(
  (file) => file.includes("/ffmpeg-static/") || /\/ffmpeg$/.test(file),
);
if (forbiddenStandaloneFfmpeg.length > 0) {
  throw new Error(
    `Packaged application contains a forbidden standalone FFmpeg payload:\n${forbiddenStandaloneFfmpeg.join("\n")}`,
  );
}

for (const notice of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
  if (!normalizedFiles.includes(path.join(unpacked, notice).toLowerCase().replaceAll("\\", "/"))) {
    throw new Error(`Packaged application is missing Electron license notice ${notice}.`);
  }
}
for (const notice of ["third-party-notices.md", "license"]) {
  if (!normalizedFiles.some((file) => file.endsWith(`app.asar!${notice}`))) {
    throw new Error(`Packaged application is missing application notice ${notice}.`);
  }
}

await verifyComplianceDirectory(path.join(unpacked, "resources", "compliance"), {
  requireSources: true,
  requireElectronNotices: true,
});

const nestedOutput = asarEntries.find(
  (entry) =>
    entry.startsWith("release/") ||
    /^dist\/(?:win(?:-[^/]+)?-unpacked|mac(?:-[^/]+)?|linux(?:-[^/]+)?-unpacked)\//.test(entry),
);
if (nestedOutput) {
  throw new Error(`Packaged application recursively contains build output ${nestedOutput}.`);
}
const forbiddenSourceRoots = ["common", "docs", "electron", "evals", "scripts", "src"];
for (const root of forbiddenSourceRoots) {
  if (asarEntries.some((entry) => entry === root || entry.startsWith(`${root}/`))) {
    throw new Error(`Packaged application contains source-only directory ${root}/.`);
  }
}

console.log(
  `Verified native ${arch} Linux package (${expectedImage}), compliance sources, notices, ` +
    `no get-windows, and no standalone FFmpeg: ${path.relative(process.cwd(), unpacked)}`,
);

/**
 * Records a payload group as required when its declaring dependency is still present and
 * as forbidden once that dependency has been removed from package.json.
 */
function addConditionalPayloads(isDeclared, payloads) {
  for (const payload of payloads) {
    if (isDeclared) expectedPayloads.push(payload);
    else forbiddenPayloads.push(payload.packagePath);
  }
}

function verifyElfMachine(file, expected) {
  const executable = readFileSync(file);
  if (executable.length < 20) throw new Error(`${file} is too short to be an ELF executable.`);

  if (executable[0] !== 0x7f || executable.toString("latin1", 1, 4) !== "ELF") {
    throw new Error(`${file} is not an ELF executable.`);
  }
  if (executable[5] !== 1) {
    throw new Error(`${file} is not a little-endian ELF executable.`);
  }

  const machine = executable.readUInt16LE(18);
  if (machine !== expected) {
    throw new Error(
      `${file} has ELF machine 0x${machine.toString(16)}, expected 0x${expected.toString(16)}.`,
    );
  }
}

function walk(root) {
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walk(absolute));
    else output.push(absolute);
  }
  return output;
}
