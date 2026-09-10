import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

import {
  MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH,
  WINDOWS_POWERSHELL_PIN_PATH,
  resolveWindowsPowerShellExecutable,
} from "./windows-write-through.mjs";

export const PACKAGE_TOOLCHAIN_PIN_RELATIVE_PATH =
  "scripts/project-components/package-toolchain-pins.json";
export const ELECTRON_WINDOWS_ZIP = "electron-v43.4.1-win32-x64.zip";

const SHA256 = /^[0-9a-f]{64}$/u;
const TREE_ALGORITHM = "sha256-path-content-v1";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactFields(value, fields, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    fail(code);
  }
}

function containedBy(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableRelative(parent, candidate, code) {
  if (!containedBy(parent, candidate)) fail(code);
  const relative = path.relative(parent, candidate).replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || relative.includes("\u0000")) fail(code);
  return relative;
}

function compareName(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export function snapshotToolchainTree(root, allowedLinkRoot = root) {
  const canonicalRoot = path.resolve(realpathSync.native(root));
  const canonicalLinkRoot = path.resolve(realpathSync.native(allowedLinkRoot));
  const records = [];
  let fileCount = 0;
  let linkCount = 0;
  let bytes = 0;

  const visit = (directory, relativeDirectory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(compareName);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.name.includes("\u0000") || /[/\\\r\n]/u.test(entry.name)) {
        fail("PACKAGE_TOOLCHAIN_PATH_INVALID");
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const rawTarget = readlinkSync(absolute);
        const canonicalTarget = path.resolve(realpathSync.native(absolute));
        const target = portableRelative(
          canonicalLinkRoot,
          canonicalTarget,
          "PACKAGE_TOOLCHAIN_LINK_OUTSIDE_SOURCE",
        );
        records.push({
          type: "link",
          path: relative,
          target,
          rawTargetType: path.isAbsolute(rawTarget) ? "absolute" : "relative",
        });
        linkCount += 1;
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) fail("PACKAGE_TOOLCHAIN_ENTRY_INVALID");
      const content = readFileSync(absolute);
      if (content.length !== stat.size) fail("PACKAGE_TOOLCHAIN_FILE_CHANGED_DURING_READ");
      records.push({
        type: "file",
        path: relative,
        bytes: content.length,
        sha256: sha256(content),
      });
      fileCount += 1;
      bytes += content.length;
    }
  };

  visit(canonicalRoot, "");
  if (fileCount === 0) fail("PACKAGE_TOOLCHAIN_TREE_EMPTY");
  return Object.freeze({
    algorithm: TREE_ALGORITHM,
    files: fileCount,
    links: linkCount,
    bytes,
    digest: sha256(Buffer.from(JSON.stringify(records), "utf8")),
  });
}

function filePin(file) {
  const canonical = realpathSync.native(file);
  const content = readFileSync(canonical);
  return Object.freeze({ bytes: content.length, sha256: sha256(content) });
}

function canonicalPinnedWindowsPowerShell(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("PACKAGE_TOOLCHAIN_WINDOWS_POWERSHELL_INVALID");
  }
  const canonical = path.resolve(realpathSync.native(file));
  if (canonical.toLowerCase() !== resolveWindowsPowerShellExecutable().toLowerCase()) {
    fail("PACKAGE_TOOLCHAIN_WINDOWS_POWERSHELL_PATH_MISMATCH");
  }
  return canonical;
}

function nsisBundle(makensisPath) {
  if (typeof makensisPath !== "string" || !existsSync(makensisPath)) {
    fail("PACKAGE_TOOLCHAIN_NSIS_BUNDLE_INVALID");
  }
  const canonicalMakensis = path.resolve(realpathSync.native(makensisPath));
  const root = path.dirname(canonicalMakensis);
  if (
    path.basename(canonicalMakensis).toLowerCase() !== "makensis.exe" ||
    !["Bin", "Include", "Plugins", "Stubs"].every((name) =>
      lstatSync(path.join(root, name)).isDirectory(),
    )
  ) {
    fail("PACKAGE_TOOLCHAIN_NSIS_BUNDLE_INVALID");
  }
  return { root, makensis: canonicalMakensis };
}

function electronChecksum(sourceRoot, zipName) {
  const checksumsPath = path.join(sourceRoot, "node_modules", "electron", "checksums.json");
  const checksumsBytes = readFileSync(checksumsPath);
  let checksums;
  try {
    checksums = JSON.parse(checksumsBytes.toString("utf8"));
  } catch {
    fail("PACKAGE_TOOLCHAIN_ELECTRON_CHECKSUMS_INVALID");
  }
  const zipSha256 = checksums?.[zipName];
  if (typeof zipSha256 !== "string" || !SHA256.test(zipSha256)) {
    fail("PACKAGE_TOOLCHAIN_ELECTRON_ZIP_PIN_INVALID");
  }
  return {
    checksumsSha256: sha256(checksumsBytes),
    zipName,
    zipSha256,
  };
}

export function createPackageToolchainPin({
  sourceRoot,
  makensisPath,
  nodeExecutable = process.execPath,
  windowsPowerShellExecutable = resolveWindowsPowerShellExecutable(),
  moveFileWriteThroughPath,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  electronZipName = ELECTRON_WINDOWS_ZIP,
}) {
  const canonicalSourceRoot = path.resolve(realpathSync.native(sourceRoot));
  const requestedMoveFileWriteThrough =
    moveFileWriteThroughPath ??
    path.join(canonicalSourceRoot, ...MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH.split("/"));
  const moveFileWriteThroughStat = lstatSync(requestedMoveFileWriteThrough);
  if (!moveFileWriteThroughStat.isFile() || moveFileWriteThroughStat.isSymbolicLink()) {
    fail("PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_INVALID");
  }
  const canonicalWindowsPowerShell = canonicalPinnedWindowsPowerShell(windowsPowerShellExecutable);
  const canonicalMoveFileWriteThrough = path.resolve(
    realpathSync.native(requestedMoveFileWriteThrough),
  );
  if (
    portableRelative(
      canonicalSourceRoot,
      canonicalMoveFileWriteThrough,
      "PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_INVALID",
    ) !== MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH
  ) {
    fail("PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_INVALID");
  }
  const nodeModulesRoot = path.join(canonicalSourceRoot, "node_modules");
  const lockPath = path.join(canonicalSourceRoot, "package-lock.json");
  for (const required of [
    "typescript/bin/tsc",
    "vite/bin/vite.js",
    "@electron/asar/package.json",
    "@electron/packager/package.json",
    "electron/checksums.json",
  ]) {
    const candidate = path.join(nodeModulesRoot, ...required.split("/"));
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
      fail("PACKAGE_TOOLCHAIN_REQUIRED_INPUT_MISSING");
    }
  }
  const nsis = nsisBundle(makensisPath);
  return Object.freeze({
    schemaVersion: 2,
    lock: { path: "package-lock.json", ...filePin(lockPath) },
    node: {
      version: nodeVersion,
      platform,
      arch,
      ...filePin(nodeExecutable),
    },
    nodeModules: {
      path: "node_modules",
      ...snapshotToolchainTree(nodeModulesRoot, canonicalSourceRoot),
    },
    electron: {
      checksumsPath: "node_modules/electron/checksums.json",
      ...electronChecksum(canonicalSourceRoot, electronZipName),
    },
    nsis: {
      makensisPath: "makensis.exe",
      ...snapshotToolchainTree(nsis.root, nsis.root),
    },
    windowsPowerShell: {
      path: WINDOWS_POWERSHELL_PIN_PATH,
      ...filePin(canonicalWindowsPowerShell),
    },
    moveFileWriteThrough: {
      path: MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH,
      ...filePin(canonicalMoveFileWriteThrough),
    },
  });
}

function validateTreePin(value, code) {
  exactFields(value, ["algorithm", "bytes", "digest", "files", "links", "path"], code);
  if (
    value.algorithm !== TREE_ALGORITHM ||
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.files) ||
    value.files < 1 ||
    !Number.isSafeInteger(value.links) ||
    value.links < 0 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    typeof value.digest !== "string" ||
    !SHA256.test(value.digest)
  ) {
    fail(code);
  }
}

function validateFilePin(value, expectedPath, code) {
  exactFields(value, ["bytes", "path", "sha256"], code);
  if (
    value.path !== expectedPath ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256)
  ) {
    fail(code);
  }
}

function validatePackageToolchainPin(pin) {
  exactFields(
    pin,
    [
      "electron",
      "lock",
      "moveFileWriteThrough",
      "node",
      "nodeModules",
      "nsis",
      "schemaVersion",
      "windowsPowerShell",
    ],
    "PACKAGE_TOOLCHAIN_PIN_FIELDS_INVALID",
  );
  if (pin.schemaVersion !== 2) fail("PACKAGE_TOOLCHAIN_PIN_SCHEMA_INVALID");
  validateFilePin(pin.lock, "package-lock.json", "PACKAGE_TOOLCHAIN_LOCK_PIN_INVALID");
  exactFields(
    pin.node,
    ["arch", "bytes", "platform", "sha256", "version"],
    "PACKAGE_TOOLCHAIN_NODE_PIN_INVALID",
  );
  if (
    typeof pin.node.version !== "string" ||
    !/^v24\.[0-9]+\.[0-9]+$/u.test(pin.node.version) ||
    pin.node.platform !== "win32" ||
    pin.node.arch !== "x64" ||
    !Number.isSafeInteger(pin.node.bytes) ||
    pin.node.bytes < 1 ||
    typeof pin.node.sha256 !== "string" ||
    !SHA256.test(pin.node.sha256)
  ) {
    fail("PACKAGE_TOOLCHAIN_NODE_PIN_INVALID");
  }
  validateTreePin(pin.nodeModules, "PACKAGE_TOOLCHAIN_NODE_MODULES_PIN_INVALID");
  if (pin.nodeModules.path !== "node_modules") {
    fail("PACKAGE_TOOLCHAIN_NODE_MODULES_PIN_INVALID");
  }
  exactFields(
    pin.electron,
    ["checksumsPath", "checksumsSha256", "zipName", "zipSha256"],
    "PACKAGE_TOOLCHAIN_ELECTRON_PIN_INVALID",
  );
  if (
    pin.electron.checksumsPath !== "node_modules/electron/checksums.json" ||
    pin.electron.zipName !== ELECTRON_WINDOWS_ZIP ||
    typeof pin.electron.checksumsSha256 !== "string" ||
    !SHA256.test(pin.electron.checksumsSha256) ||
    typeof pin.electron.zipSha256 !== "string" ||
    !SHA256.test(pin.electron.zipSha256)
  ) {
    fail("PACKAGE_TOOLCHAIN_ELECTRON_PIN_INVALID");
  }
  exactFields(
    pin.nsis,
    ["algorithm", "bytes", "digest", "files", "links", "makensisPath"],
    "PACKAGE_TOOLCHAIN_NSIS_PIN_INVALID",
  );
  validateTreePin(
    {
      algorithm: pin.nsis.algorithm,
      bytes: pin.nsis.bytes,
      digest: pin.nsis.digest,
      files: pin.nsis.files,
      links: pin.nsis.links,
      path: pin.nsis.makensisPath,
    },
    "PACKAGE_TOOLCHAIN_NSIS_PIN_INVALID",
  );
  if (pin.nsis.makensisPath !== "makensis.exe") fail("PACKAGE_TOOLCHAIN_NSIS_PIN_INVALID");
  validateFilePin(
    pin.windowsPowerShell,
    WINDOWS_POWERSHELL_PIN_PATH,
    "PACKAGE_TOOLCHAIN_WINDOWS_POWERSHELL_PIN_INVALID",
  );
  validateFilePin(
    pin.moveFileWriteThrough,
    MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH,
    "PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_PIN_INVALID",
  );
  return pin;
}

export function pinnedPackageToolchainProvenance(sourceRoot) {
  const canonicalSourceRoot = path.resolve(realpathSync.native(sourceRoot));
  const pinPath = path.join(canonicalSourceRoot, PACKAGE_TOOLCHAIN_PIN_RELATIVE_PATH);
  const pinBytes = readFileSync(pinPath);
  let pin;
  try {
    pin = JSON.parse(pinBytes.toString("utf8"));
  } catch {
    fail("PACKAGE_TOOLCHAIN_PIN_JSON_INVALID");
  }
  validatePackageToolchainPin(pin);
  return Object.freeze({
    pin: {
      path: PACKAGE_TOOLCHAIN_PIN_RELATIVE_PATH,
      bytes: pinBytes.length,
      sha256: sha256(pinBytes),
    },
    ...pin,
  });
}

function equalValue(actual, expected, code) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(code);
  }
}

export function verifyPinnedPackageToolchain({
  sourceRoot,
  makensisPath,
  nodeExecutable = process.execPath,
  windowsPowerShellExecutable = resolveWindowsPowerShellExecutable(),
  moveFileWriteThroughPath,
}) {
  const canonicalSourceRoot = path.resolve(realpathSync.native(sourceRoot));
  const expected = pinnedPackageToolchainProvenance(canonicalSourceRoot);
  const actual = createPackageToolchainPin({
    sourceRoot: canonicalSourceRoot,
    makensisPath,
    nodeExecutable,
    windowsPowerShellExecutable,
    moveFileWriteThroughPath,
  });
  equalValue(actual.lock, expected.lock, "PACKAGE_TOOLCHAIN_LOCK_MISMATCH");
  equalValue(actual.node, expected.node, "PACKAGE_TOOLCHAIN_NODE_MISMATCH");
  equalValue(actual.nodeModules, expected.nodeModules, "PACKAGE_TOOLCHAIN_NODE_MODULES_MISMATCH");
  equalValue(actual.electron, expected.electron, "PACKAGE_TOOLCHAIN_ELECTRON_MISMATCH");
  equalValue(actual.nsis, expected.nsis, "PACKAGE_TOOLCHAIN_NSIS_MISMATCH");
  equalValue(
    actual.windowsPowerShell,
    expected.windowsPowerShell,
    "PACKAGE_TOOLCHAIN_WINDOWS_POWERSHELL_MISMATCH",
  );
  equalValue(
    actual.moveFileWriteThrough,
    expected.moveFileWriteThrough,
    "PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_MISMATCH",
  );
  const nsis = nsisBundle(makensisPath);
  const canonicalMoveFileWriteThrough = path.resolve(
    realpathSync.native(
      moveFileWriteThroughPath ??
        path.join(canonicalSourceRoot, ...MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH.split("/")),
    ),
  );
  return Object.freeze({
    provenance: expected,
    nodeModulesRoot: path.join(canonicalSourceRoot, "node_modules"),
    makensisPath: nsis.makensis,
    windowsPowerShellPath: canonicalPinnedWindowsPowerShell(windowsPowerShellExecutable),
    moveFileWriteThroughPath: canonicalMoveFileWriteThrough,
  });
}

export function assertPinnedPackageToolchainProvenance(value, sourceRoot) {
  const expected = pinnedPackageToolchainProvenance(sourceRoot);
  equalValue(value, expected, "RELEASE_TOOLCHAIN_PROVENANCE_MISMATCH");
  return value;
}

export function verifyPinnedWindowsPublicationToolchain({
  sourceRoot,
  provenance = pinnedPackageToolchainProvenance(sourceRoot),
  windowsPowerShellExecutable = resolveWindowsPowerShellExecutable(),
  moveFileWriteThroughPath,
}) {
  const canonicalSourceRoot = path.resolve(realpathSync.native(sourceRoot));
  const expected = pinnedPackageToolchainProvenance(canonicalSourceRoot);
  equalValue(provenance, expected, "RELEASE_TOOLCHAIN_PROVENANCE_MISMATCH");
  const requestedMoveFileWriteThrough =
    moveFileWriteThroughPath ??
    path.join(canonicalSourceRoot, ...MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH.split("/"));
  const moveStat = lstatSync(requestedMoveFileWriteThrough);
  if (!moveStat.isFile() || moveStat.isSymbolicLink()) {
    fail("PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_INVALID");
  }
  const canonicalMoveFileWriteThrough = path.resolve(
    realpathSync.native(requestedMoveFileWriteThrough),
  );
  if (
    portableRelative(
      canonicalSourceRoot,
      canonicalMoveFileWriteThrough,
      "PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_INVALID",
    ) !== MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH
  ) {
    fail("PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_INVALID");
  }
  const canonicalWindowsPowerShell = canonicalPinnedWindowsPowerShell(windowsPowerShellExecutable);
  equalValue(
    { path: WINDOWS_POWERSHELL_PIN_PATH, ...filePin(canonicalWindowsPowerShell) },
    expected.windowsPowerShell,
    "PACKAGE_TOOLCHAIN_WINDOWS_POWERSHELL_MISMATCH",
  );
  equalValue(
    {
      path: MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH,
      ...filePin(canonicalMoveFileWriteThrough),
    },
    expected.moveFileWriteThrough,
    "PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_MISMATCH",
  );
  return Object.freeze({
    windowsPowerShellPath: canonicalWindowsPowerShell,
    moveFileWriteThroughPath: canonicalMoveFileWriteThrough,
  });
}

export function assertPinnedElectronArchive(value, archivePath) {
  const provenance = value?.provenance ?? value;
  const expected = provenance?.electron?.zipSha256;
  if (typeof expected !== "string" || !SHA256.test(expected)) {
    fail("PACKAGE_TOOLCHAIN_ELECTRON_PIN_INVALID");
  }
  if (!existsSync(archivePath) || filePin(archivePath).sha256 !== expected) {
    fail("PACKAGE_TOOLCHAIN_ELECTRON_ARCHIVE_MISMATCH");
  }
  return expected;
}
