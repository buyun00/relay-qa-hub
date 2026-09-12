import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import asar from "@electron/asar";

import { moveFileWriteThrough } from "./windows-write-through.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_ID = /^\d{8}T\d{9}Z$/u;
const LEGACY_VERSION = /^0\.2\.0-(?:preview|lan)\.[1-9]\d*$/u;
const STABLE_VERSION = /^1\.0\.0$/u;
const VERSION = /^(?:0\.2\.0-(?:preview|lan)\.[1-9]\d*|1\.0\.0)$/u;
const ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const MAX_INSTALLER_BYTES = 350 * 1024 * 1024;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url);

function isPrivateLanHostname(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/u.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function fileIdentity(file, code = "FILE_IDENTITY_INVALID") {
  const stat = lstatSync(file, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${code}_TYPE`);
  assert.equal(stat.nlink, 1n, `${code}_ALIAS`);
  return Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size, nlink: stat.nlink });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function flushAndVerifyExistingFile(file, expectedBytes, mismatchCode) {
  const pathBefore = fileIdentity(file, mismatchCode);
  const descriptor = openSync(file, "r+");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert.ok(before.isFile(), `${mismatchCode}_TYPE`);
    assert.equal(before.nlink, 1n, `${mismatchCode}_ALIAS`);
    assert.ok(sameFileIdentity(pathBefore, before), `${mismatchCode}_PATH_CHANGED`);
    fsyncSync(descriptor);
    assert.equal(before.size, BigInt(expectedBytes.length), `${mismatchCode}_SIZE`);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, expectedBytes.length));
    let offset = 0;
    while (offset < expectedBytes.length) {
      const length = Math.min(buffer.length, expectedBytes.length - offset);
      const bytesRead = readSync(descriptor, buffer, 0, length, offset);
      assert.equal(bytesRead, length, `${mismatchCode}_SHORT_READ`);
      assert.ok(
        buffer.subarray(0, bytesRead).equals(expectedBytes.subarray(offset, offset + bytesRead)),
        mismatchCode,
      );
      offset += bytesRead;
    }
    assert.equal(readSync(descriptor, buffer, 0, 1, offset), 0, `${mismatchCode}_GREW`);
    const after = fstatSync(descriptor, { bigint: true });
    assert.deepEqual(after.dev, before.dev, `${mismatchCode}_DEVICE_CHANGED`);
    assert.deepEqual(after.ino, before.ino, `${mismatchCode}_IDENTITY_CHANGED`);
    assert.deepEqual(after.size, before.size, `${mismatchCode}_SIZE_CHANGED`);
    assert.equal(after.nlink, 1n, `${mismatchCode}_ALIAS_CHANGED`);
    const current = fileIdentity(file, mismatchCode);
    assert.ok(sameFileIdentity(before, current), `${mismatchCode}_PATH_CHANGED`);
    assert.equal(current.size, before.size, `${mismatchCode}_PATH_SIZE_CHANGED`);
    return Object.freeze({
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      nlink: before.nlink,
    });
  } finally {
    closeSync(descriptor);
  }
}

export function writeFileExclusiveDurable(file, bytes, checkpoint = () => {}, moveOptions = {}) {
  assert.ok(path.isAbsolute(file), "DURABLE_FILE_PATH_INVALID");
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0, "DURABLE_FILE_BYTES_INVALID");
  assert.equal(typeof checkpoint, "function", "DURABLE_FILE_CHECKPOINT_INVALID");
  const staged = path.join(
    path.dirname(file),
    `.qa-hub-durable-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  const descriptor = openSync(staged, "wx", 0o600);
  let stagedIdentity;
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    stagedIdentity = fstatSync(descriptor, { bigint: true });
  } finally {
    closeSync(descriptor);
  }
  try {
    checkpoint("staged-durable");
  } catch (cause) {
    const currentIdentity = fileIdentity(staged, "DURABLE_FILE_STAGED_CHANGED");
    const error = new Error("DURABLE_FILE_PUBLICATION_FAILED_ORPHAN_RETAINED", { cause });
    error.orphanPath = staged;
    error.orphanSha256 = sha256(bytes);
    error.orphanIdentityMatched = sameFileIdentity(stagedIdentity, currentIdentity);
    throw error;
  }

  // MOVEFILE_WRITE_THROUGH persists the create-only directory entry after the
  // staged bytes have been flushed. Omitting REPLACE_EXISTING preserves wx.
  let moveCause = null;
  try {
    moveFileWriteThrough(staged, file, {
      ...moveOptions,
      expectedSourceSha256: sha256(bytes),
    });
  } catch (cause) {
    moveCause = cause;
  }
  if (moveCause !== null && existsSync(staged)) {
    const currentIdentity = fileIdentity(staged, "DURABLE_FILE_STAGED_CHANGED");
    const error = new Error("DURABLE_FILE_PUBLICATION_FAILED_ORPHAN_RETAINED", {
      cause: moveCause,
    });
    error.orphanPath = staged;
    error.orphanSha256 = sha256(bytes);
    error.orphanIdentityMatched = sameFileIdentity(stagedIdentity, currentIdentity);
    throw error;
  }

  try {
    assert.equal(existsSync(staged), false, "DURABLE_FILE_STAGED_REAPPEARED");
    const publishedIdentity = flushAndVerifyExistingFile(
      file,
      bytes,
      "DURABLE_FILE_READBACK_MISMATCH",
    );
    assert.ok(
      sameFileIdentity(stagedIdentity, publishedIdentity),
      "DURABLE_FILE_PUBLISHED_IDENTITY_MISMATCH",
    );
    assert.equal(publishedIdentity.nlink, 1n, "DURABLE_FILE_PUBLISHED_ALIAS_REMAINED");
  } catch (proofCause) {
    if (moveCause === null) throw proofCause;
    const error = new Error("DURABLE_FILE_PUBLICATION_UNKNOWN_OUTCOME_UNPROVEN", {
      cause: moveCause,
    });
    error.nativeError = moveCause?.nativeError ?? null;
    error.proofCause = proofCause;
    throw error;
  }
  checkpoint("published");
  const finalIdentity = verifiedPathIdentity(file, sha256(bytes), "DURABLE_FILE_FINAL_CHANGED");
  assert.ok(
    sameFileIdentity(stagedIdentity, finalIdentity),
    "DURABLE_FILE_FINAL_IDENTITY_MISMATCH",
  );
  assert.equal(existsSync(staged), false, "DURABLE_FILE_STAGED_REAPPEARED");
  return Object.freeze({ recovered: moveCause !== null });
}

export function publishFileExclusiveDurable(
  source,
  destination,
  expectedBytes,
  checkpoint = () => {},
  moveOptions = {},
) {
  assert.ok(path.isAbsolute(source), "DURABLE_PUBLICATION_SOURCE_INVALID");
  assert.ok(path.isAbsolute(destination), "DURABLE_PUBLICATION_DESTINATION_INVALID");
  assert.notEqual(
    path.resolve(source).toLowerCase(),
    path.resolve(destination).toLowerCase(),
    "DURABLE_PUBLICATION_PATH_COLLISION",
  );
  assert.ok(
    Buffer.isBuffer(expectedBytes) && expectedBytes.length > 0,
    "DURABLE_PUBLICATION_BYTES_INVALID",
  );
  assert.equal(typeof checkpoint, "function", "DURABLE_PUBLICATION_CHECKPOINT_INVALID");
  const sourceStat = lstatSync(source);
  assert.ok(
    sourceStat.isFile() && !sourceStat.isSymbolicLink(),
    "DURABLE_PUBLICATION_SOURCE_INVALID",
  );
  assert.equal(sourceStat.size, expectedBytes.length, "DURABLE_PUBLICATION_SOURCE_SIZE_MISMATCH");
  const sourceIdentity = flushAndVerifyExistingFile(
    source,
    expectedBytes,
    "DURABLE_PUBLICATION_SOURCE_READBACK_MISMATCH",
  );
  checkpoint("source-durable");
  // The public file is the source inode moved across same-volume directories.
  // No hardlink alias exists before or after exposure, and create-only preserves
  // a collision winner without any cleanup of the canonical destination.
  let moveCause = null;
  try {
    moveFileWriteThrough(source, destination, {
      ...moveOptions,
      expectedSourceSha256: sha256(expectedBytes),
    });
  } catch (cause) {
    moveCause = cause;
  }
  if (moveCause !== null && (existsSync(source) || !existsSync(destination))) throw moveCause;

  let publishedIdentity;
  try {
    const publishedPathStat = lstatSync(destination, { bigint: true });
    assert.ok(
      publishedPathStat.isFile() && !publishedPathStat.isSymbolicLink(),
      "DURABLE_PUBLICATION_PUBLISHED_PATH_INVALID",
    );
    publishedIdentity = flushAndVerifyExistingFile(
      destination,
      expectedBytes,
      "DURABLE_PUBLICATION_READBACK_MISMATCH",
    );
    assert.ok(
      sameFileIdentity(sourceIdentity, publishedIdentity),
      "DURABLE_PUBLICATION_PUBLISHED_IDENTITY_MISMATCH",
    );
    const finalPathStat = lstatSync(destination, { bigint: true });
    assert.ok(
      finalPathStat.isFile() &&
        !finalPathStat.isSymbolicLink() &&
        sameFileIdentity(publishedIdentity, finalPathStat),
      "DURABLE_PUBLICATION_PUBLISHED_PATH_CHANGED",
    );
    assert.equal(finalPathStat.nlink, 1n, "DURABLE_PUBLICATION_PUBLISHED_ALIAS_REMAINED");
    assert.equal(existsSync(source), false, "DURABLE_PUBLICATION_SOURCE_REAPPEARED");
  } catch (proofCause) {
    if (moveCause === null) throw proofCause;
    const error = new Error("DURABLE_PUBLICATION_UNKNOWN_OUTCOME_UNPROVEN", {
      cause: moveCause,
    });
    error.nativeError = moveCause?.nativeError ?? null;
    error.proofCause = proofCause;
    throw error;
  }
  checkpoint("published");
  const finalIdentity = verifiedPathIdentity(
    destination,
    sha256(expectedBytes),
    "DURABLE_PUBLICATION_FINAL_CHANGED",
  );
  assert.ok(
    sameFileIdentity(sourceIdentity, finalIdentity),
    "DURABLE_PUBLICATION_FINAL_IDENTITY_MISMATCH",
  );
  assert.equal(existsSync(source), false, "DURABLE_PUBLICATION_SOURCE_REAPPEARED");
  return Object.freeze({
    dev: sourceIdentity.dev.toString(),
    ino: sourceIdentity.ino.toString(),
    bytes: expectedBytes.length,
    recovered: moveCause !== null,
  });
}

function writeOrReuseExact(file, bytes, collisionCode, moveOptions) {
  if (existsSync(file)) {
    flushAndVerifyExistingFile(file, bytes, collisionCode);
    return { created: false, recovered: false };
  }
  const publication = writeFileExclusiveDurable(file, bytes, () => {}, moveOptions);
  return { created: true, recovered: publication.recovered };
}

function fileSha256OrNull(file) {
  if (!existsSync(file)) return null;
  const before = fileIdentity(file, "PUBLISHED_FILE_PATH_INVALID");
  const bytes = readFileSync(file);
  const after = fileIdentity(file, "PUBLISHED_FILE_PATH_INVALID");
  assert.ok(sameFileIdentity(before, after), "PUBLISHED_FILE_PATH_IDENTITY_CHANGED");
  assert.equal(before.size, after.size, "PUBLISHED_FILE_PATH_SIZE_CHANGED");
  return sha256(bytes);
}

function validRelativePackagePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) return false;
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
    for (const character of segment) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint === undefined ||
        codePoint < 32 ||
        codePoint === 127 ||
        ':*?"<>|'.includes(character)
      )
        return false;
    }
  }
  return true;
}

export function canonicalDirectChildDirectory(parent, candidate, label = "DIRECT_CHILD") {
  assert.ok(typeof parent === "string" && path.isAbsolute(parent), `${label}_PARENT_INVALID`);
  assert.ok(
    typeof candidate === "string" && path.isAbsolute(candidate),
    `${label}_CANDIDATE_INVALID`,
  );
  const parentStat = lstatSync(parent);
  const candidateStat = lstatSync(candidate);
  assert.ok(parentStat.isDirectory() && !parentStat.isSymbolicLink(), `${label}_PARENT_INVALID`);
  assert.ok(
    candidateStat.isDirectory() && !candidateStat.isSymbolicLink(),
    `${label}_CANDIDATE_INVALID`,
  );
  const canonicalParent = path.resolve(realpathSync.native(parent));
  const canonicalCandidate = path.resolve(realpathSync.native(candidate));
  const relativeCandidate = path.relative(canonicalParent, canonicalCandidate);
  assert.ok(
    relativeCandidate.length > 0 &&
      !relativeCandidate.startsWith("..") &&
      !path.isAbsolute(relativeCandidate) &&
      path.dirname(relativeCandidate) === ".",
    `${label}_OUTSIDE_PARENT`,
  );
  assert.equal(
    path.dirname(canonicalCandidate).toLowerCase(),
    canonicalParent.toLowerCase(),
    `${label}_PARENT_MISMATCH`,
  );
  return canonicalCandidate;
}

export function validatePreparedPreviewPublicationReceipt({ transaction, phase }, publicKeyPem) {
  assert.ok(transaction && typeof transaction === "object", "PREPARED_RECEIPT_TRANSACTION_INVALID");
  assert.ok(typeof phase === "string" && phase.length > 0, "PREPARED_RECEIPT_PHASE_INVALID");
  assert.ok(
    typeof publicKeyPem === "string" && publicKeyPem.length > 0,
    "PREPARED_RECEIPT_PUBLIC_KEY_INVALID",
  );
  const receiptBytes = readFileSync(transaction.receiptPath);
  assert.equal(sha256(receiptBytes), transaction.receiptSha256, "PREPARED_RECEIPT_SHA256_MISMATCH");
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (cause) {
    throw new Error("PREPARED_RECEIPT_JSON_INVALID", { cause });
  }
  assert.equal(receipt?.schemaVersion, 2, "PREPARED_RECEIPT_SCHEMA_INVALID");
  assert.equal(
    receipt?.kind,
    "relay-qa-hub-preview-publication-receipt",
    "PREPARED_RECEIPT_KIND_INVALID",
  );
  assert.match(receipt?.releaseId ?? "", RELEASE_ID, "PREPARED_RECEIPT_RELEASE_ID_INVALID");
  assert.match(receipt?.version ?? "", VERSION, "PREPARED_RECEIPT_VERSION_INVALID");
  const publication = receipt?.publication;
  assert.equal(
    publication?.commitProtocol,
    "prepared-receipt-active-claim-create-only-latest-v2",
    "PREPARED_RECEIPT_PROTOCOL_INVALID",
  );
  assert.equal(
    publication?.manifestSha256,
    transaction.replacementSha256,
    "PREPARED_RECEIPT_MANIFEST_SHA256_MISMATCH",
  );
  assert.ok(
    Number.isSafeInteger(publication?.manifestBytes) && publication.manifestBytes > 0,
    "PREPARED_RECEIPT_MANIFEST_BYTES_INVALID",
  );
  assert.equal(
    publication?.releaseId,
    receipt.releaseId,
    "PREPARED_RECEIPT_PUBLICATION_RELEASE_ID_MISMATCH",
  );
  assert.equal(
    publication?.version,
    receipt.version,
    "PREPARED_RECEIPT_PUBLICATION_VERSION_MISMATCH",
  );
  const installerName = publication?.installerName;
  assert.ok(
    typeof installerName === "string" &&
      /^[\p{L}\p{N}._-]+\.exe$/u.test(installerName) &&
      installerName.length <= 200 &&
      path.basename(installerName) === installerName,
    "PREPARED_RECEIPT_INSTALLER_NAME_INVALID",
  );
  assert.match(
    publication?.installerSha256 ?? "",
    SHA256,
    "PREPARED_RECEIPT_INSTALLER_SHA256_INVALID",
  );
  assert.equal(
    publication.installerSha256,
    receipt?.sha256,
    "PREPARED_RECEIPT_INSTALLER_SHA256_MISMATCH",
  );
  assert.ok(
    Number.isSafeInteger(publication?.installerBytes) &&
      publication.installerBytes > 0 &&
      publication.installerBytes <= MAX_INSTALLER_BYTES &&
      publication.installerBytes === receipt?.bytes,
    "PREPARED_RECEIPT_INSTALLER_BYTES_INVALID",
  );

  const manifestUrl = new URL(publication?.manifestUrl);
  const installerUrl = new URL(publication?.installerUrl);
  const expectedManifestPathname = `/downloads/${transaction.destinationName}`;
  const expectedInstallerPathname = `/downloads/${installerName}`;
  assert.equal(manifestUrl.protocol, "http:", "PREPARED_RECEIPT_MANIFEST_URL_INVALID");
  assert.equal(
    receipt.version.includes("-lan.") || STABLE_VERSION.test(receipt.version)
      ? isPrivateLanHostname(manifestUrl.hostname)
      : manifestUrl.hostname === "127.0.0.1",
    true,
    "PREPARED_RECEIPT_MANIFEST_URL_INVALID",
  );
  assert.equal(manifestUrl.username, "", "PREPARED_RECEIPT_MANIFEST_URL_INVALID");
  assert.equal(manifestUrl.password, "", "PREPARED_RECEIPT_MANIFEST_URL_INVALID");
  assert.ok(
    /^[1-9]\d{0,4}$/u.test(manifestUrl.port) && Number(manifestUrl.port) <= 65_535,
    "PREPARED_RECEIPT_MANIFEST_URL_INVALID",
  );
  assert.equal(
    manifestUrl.pathname,
    expectedManifestPathname,
    "PREPARED_RECEIPT_MANIFEST_URL_INVALID",
  );
  assert.equal(manifestUrl.search, "", "PREPARED_RECEIPT_MANIFEST_URL_INVALID");
  assert.equal(manifestUrl.hash, "", "PREPARED_RECEIPT_MANIFEST_URL_INVALID");
  assert.equal(
    installerUrl.origin,
    manifestUrl.origin,
    "PREPARED_RECEIPT_INSTALLER_ORIGIN_INVALID",
  );
  assert.equal(installerUrl.username, "", "PREPARED_RECEIPT_INSTALLER_URL_INVALID");
  assert.equal(installerUrl.password, "", "PREPARED_RECEIPT_INSTALLER_URL_INVALID");
  assert.equal(
    decodeURI(installerUrl.pathname),
    expectedInstallerPathname,
    "PREPARED_RECEIPT_INSTALLER_URL_INVALID",
  );
  assert.equal(installerUrl.search, "", "PREPARED_RECEIPT_INSTALLER_URL_INVALID");
  assert.equal(installerUrl.hash, "", "PREPARED_RECEIPT_INSTALLER_URL_INVALID");

  const installerPath = canonicalFilePath(
    path.join(path.dirname(transaction.destination), installerName),
  );
  let installerIdentity;
  try {
    installerIdentity = verifiedPathIdentity(
      installerPath,
      publication.installerSha256,
      "PREPARED_RECEIPT_INSTALLER_CHANGED",
    );
    assert.equal(
      installerIdentity.size,
      BigInt(publication.installerBytes),
      "PREPARED_RECEIPT_INSTALLER_SIZE_MISMATCH",
    );
  } catch (cause) {
    if (cause?.message?.startsWith("PREPARED_RECEIPT_INSTALLER_")) throw cause;
    throw new Error("PREPARED_RECEIPT_INSTALLER_CHANGED", { cause });
  }

  const manifestPath = [transaction.temporary, transaction.destination].find(
    (candidate) => fileSha256OrNull(candidate) === transaction.replacementSha256,
  );
  assert.ok(manifestPath, "PREPARED_RECEIPT_MANIFEST_MISSING");
  const manifestBytes = readFileSync(manifestPath);
  assert.equal(
    manifestBytes.length,
    publication.manifestBytes,
    "PREPARED_RECEIPT_MANIFEST_SIZE_MISMATCH",
  );
  const manifest = assertSignedUpdateManifest(
    JSON.parse(manifestBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    publicKeyPem,
    "PREPARED_RECEIPT_MANIFEST",
  );
  assert.equal(manifest.releaseId, receipt.releaseId, "PREPARED_RECEIPT_MANIFEST_RELEASE_MISMATCH");
  assert.equal(manifest.version, receipt.version, "PREPARED_RECEIPT_MANIFEST_VERSION_MISMATCH");
  assert.equal(
    manifest.archive.url,
    expectedInstallerPathname,
    "PREPARED_RECEIPT_ARCHIVE_URL_INVALID",
  );
  assert.equal(
    manifest.archive.sha256,
    publication.installerSha256,
    "PREPARED_RECEIPT_ARCHIVE_SHA256_MISMATCH",
  );
  assert.equal(
    manifest.archive.size,
    publication.installerBytes,
    "PREPARED_RECEIPT_ARCHIVE_SIZE_MISMATCH",
  );
  return Object.freeze({
    phase,
    installerName,
    installerSha256: publication.installerSha256,
    installerBytes: publication.installerBytes,
    installerIdentity,
  });
}

function comparePath(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function finishSnapshot(files) {
  assert.ok(files.length > 0, "RELEASE_CONTENT_EMPTY");
  files.sort(comparePath);
  return {
    algorithm: "sha256",
    digest: sha256(Buffer.from(JSON.stringify(files))),
    files,
  };
}

function snapshotDirectory(root, excludedPaths = new Set()) {
  assert.ok(path.isAbsolute(root), "RELEASE_CONTENT_ROOT_MUST_BE_ABSOLUTE");
  const rootStat = lstatSync(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "RELEASE_CONTENT_ROOT_INVALID");
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const absolute = path.join(root, child);
      const stat = lstatSync(absolute);
      assert.equal(stat.isSymbolicLink(), false, "RELEASE_CONTENT_LINK_REFUSED");
      if (stat.isDirectory()) {
        visit(child);
        continue;
      }
      assert.ok(stat.isFile(), "RELEASE_CONTENT_NON_FILE_REFUSED");
      const packagePath = child.replaceAll("\\", "/");
      if (excludedPaths.has(packagePath)) continue;
      const bytes = readFileSync(absolute);
      files.push({
        path: packagePath,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
  };
  visit("");
  return finishSnapshot(files);
}

export function snapshotReleaseDirectory(root) {
  return snapshotDirectory(root);
}

// release.json contains the signature over this inventory, so it is the sole
// excluded file. Every other app.asar entry, including package.json and assets,
// remains covered and any unexpected executable entry changes the digest.
export function snapshotReleasePackageDirectory(root) {
  return snapshotDirectory(root, new Set(["release.json"]));
}

export function snapshotInstalledPreviewDirectory(root) {
  // The uninstaller is generated after the embedded payload is extracted.
  // The package already contains .preview-instance-id, so it remains bound.
  return snapshotDirectory(root, new Set(["Uninstall-Preview.exe"]));
}

export function snapshotReleaseAsarDirectory(archive, prefix) {
  assert.ok(path.isAbsolute(archive), "RELEASE_ASAR_MUST_BE_ABSOLUTE");
  assert.match(prefix, /^[a-z][a-z0-9-]*$/u, "RELEASE_ASAR_PREFIX_INVALID");
  const normalizedPrefix = `${prefix}/`;
  const files = asar
    .listPackage(archive)
    .map((original) => {
      const statPath = original.replace(/^[/\\]/u, "");
      return { statPath, item: statPath.replaceAll("\\", "/") };
    })
    .filter(({ item }) => item.startsWith(normalizedPrefix))
    .filter(({ statPath }) => !Object.hasOwn(asar.statFile(archive, statPath), "files"))
    .map(({ item, statPath }) => {
      const bytes = asar.extractFile(archive, statPath);
      return {
        path: item.slice(normalizedPrefix.length),
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    });
  return finishSnapshot(files);
}

export function snapshotReleasePackageAsar(archive) {
  assert.ok(path.isAbsolute(archive), "RELEASE_ASAR_MUST_BE_ABSOLUTE");
  const files = asar
    .listPackage(archive)
    .map((original) => {
      const statPath = original.replace(/^[/\\]/u, "");
      return { statPath, item: statPath.replaceAll("\\", "/") };
    })
    .filter(({ item }) => item !== "release.json")
    .filter(({ statPath }) => !Object.hasOwn(asar.statFile(archive, statPath), "files"))
    .map(({ item, statPath }) => {
      const bytes = asar.extractFile(archive, statPath);
      return {
        path: item,
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    });
  return finishSnapshot(files);
}

export function validateReleaseContentSnapshot(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}_INVALID`);
  assert.deepEqual(
    Object.keys(value).sort(),
    ["algorithm", "digest", "files"],
    `${label}_FIELDS_INVALID`,
  );
  assert.equal(value.algorithm, "sha256", `${label}_ALGORITHM_INVALID`);
  assert.ok(
    Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 10_000,
    `${label}_FILES_INVALID`,
  );
  let previous = "";
  for (const file of value.files) {
    assert.ok(file && typeof file === "object" && !Array.isArray(file), `${label}_FILE_INVALID`);
    assert.deepEqual(
      Object.keys(file).sort(),
      ["bytes", "path", "sha256"],
      `${label}_FILE_FIELDS_INVALID`,
    );
    assert.ok(validRelativePackagePath(file.path), `${label}_PATH_INVALID`);
    assert.ok(file.path > previous, `${label}_PATH_ORDER_INVALID`);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, `${label}_BYTES_INVALID`);
    assert.match(file.sha256, SHA256, `${label}_SHA256_INVALID`);
    previous = file.path;
  }
  assert.match(value.digest, SHA256, `${label}_DIGEST_INVALID`);
  assert.equal(
    value.digest,
    sha256(Buffer.from(JSON.stringify(value.files))),
    `${label}_DIGEST_INVALID`,
  );
  return value;
}

export function serializeReleaseAttestation(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "RELEASE_INVALID");
  return Buffer.from(
    JSON.stringify({
      schemaVersion: value.schemaVersion,
      releaseId: value.releaseId,
      version: value.version,
      sourceCommit: value.sourceCommit,
      sourceDirty: value.sourceDirty,
      instanceId: value.instanceId,
      packageIdentity: value.packageIdentity,
      preload: value.preload,
      build: value.build,
      packageContent: value.packageContent,
    }),
    "utf8",
  );
}

export function assertReleaseContentBinding(expected, actual, label) {
  validateReleaseContentSnapshot(expected, `${label}_EXPECTED`);
  validateReleaseContentSnapshot(actual, `${label}_ACTUAL`);
  assert.deepEqual(actual, expected, `${label}_MISMATCH`);
  return actual;
}

function assertExactFields(value, fields, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}_INVALID`);
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), `${label}_FIELDS_INVALID`);
}

export function serializeUpdateManifestPayload(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "MANIFEST_INVALID");
  return Buffer.from(
    JSON.stringify({
      schemaVersion: value.schemaVersion,
      releaseId: value.releaseId,
      version: value.version,
      publishedAt: value.publishedAt,
      archive: {
        url: value.archive?.url,
        size: value.archive?.size,
        sha256: value.archive?.sha256,
      },
    }),
    "utf8",
  );
}

export function assertSignedUpdateManifest(value, publicKeyPem, label = "UPDATE_MANIFEST") {
  assertExactFields(
    value,
    ["archive", "publishedAt", "releaseId", "schemaVersion", "signature", "version"],
    label,
  );
  assertExactFields(value.archive, ["sha256", "size", "url"], `${label}_ARCHIVE`);
  assert.equal(value.schemaVersion, 1, `${label}_SCHEMA_INVALID`);
  assert.match(value.releaseId, RELEASE_ID, `${label}_RELEASE_ID_INVALID`);
  assert.match(value.version, VERSION, `${label}_VERSION_INVALID`);
  assert.ok(Number.isFinite(Date.parse(value.publishedAt)), `${label}_PUBLISHED_AT_INVALID`);
  assert.ok(
    typeof value.archive.url === "string" &&
      value.archive.url.startsWith("/downloads/") &&
      value.archive.url.length <= 2048 &&
      !value.archive.url.includes("\\") &&
      !value.archive.url.includes("?") &&
      !value.archive.url.includes("#"),
    `${label}_ARCHIVE_URL_INVALID`,
  );
  assert.ok(
    Number.isSafeInteger(value.archive.size) &&
      value.archive.size > 0 &&
      value.archive.size <= MAX_INSTALLER_BYTES,
    `${label}_ARCHIVE_SIZE_INVALID`,
  );
  assert.match(value.archive.sha256, SHA256, `${label}_ARCHIVE_SHA256_INVALID`);
  assert.match(value.signature, ED25519_SIGNATURE, `${label}_SIGNATURE_INVALID`);
  const signatureBytes = Buffer.from(value.signature, "base64");
  assert.equal(signatureBytes.length, 64, `${label}_SIGNATURE_BYTES_INVALID`);
  assert.equal(
    signatureBytes.toString("base64"),
    value.signature,
    `${label}_SIGNATURE_ENCODING_INVALID`,
  );
  const publicKey = createPublicKey(publicKeyPem);
  assert.equal(publicKey.asymmetricKeyType, "ed25519", `${label}_PUBLIC_KEY_TYPE_INVALID`);
  assert.equal(
    verify(null, serializeUpdateManifestPayload(value), publicKey, signatureBytes),
    true,
    `${label}_SIGNATURE_INVALID`,
  );
  return value;
}

export function assertUpdateManifestSuccessor(previous, next) {
  assert.ok(previous && typeof previous === "object", "PREVIOUS_UPDATE_MANIFEST_INVALID");
  assert.ok(next && typeof next === "object", "NEXT_UPDATE_MANIFEST_INVALID");
  assert.match(previous.releaseId, RELEASE_ID, "PREVIOUS_UPDATE_RELEASE_ID_INVALID");
  assert.match(next.releaseId, RELEASE_ID, "NEXT_UPDATE_RELEASE_ID_INVALID");
  assert.match(previous.version, VERSION, "PREVIOUS_UPDATE_VERSION_INVALID");
  assert.match(next.version, VERSION, "NEXT_UPDATE_VERSION_INVALID");
  const order = (version) =>
    STABLE_VERSION.test(version)
      ? [1, 0, 0, 0]
      : [0, 2, 0, Number(version.slice(version.lastIndexOf(".") + 1))];
  const previousOrder = order(previous.version);
  const nextOrder = order(next.version);
  const newer = nextOrder.some(
    (value, index) =>
      value > previousOrder[index] &&
      nextOrder.slice(0, index).every((part, earlier) => part === previousOrder[earlier]),
  );
  assert.ok(
    (LEGACY_VERSION.test(previous.version) || STABLE_VERSION.test(previous.version)) &&
      (LEGACY_VERSION.test(next.version) || STABLE_VERSION.test(next.version)) &&
      newer,
    "UPDATE_VERSION_NOT_MONOTONIC",
  );
  assert.ok(next.releaseId > previous.releaseId, "UPDATE_RELEASE_ID_NOT_MONOTONIC");
  assert.ok(
    Date.parse(next.publishedAt) > Date.parse(previous.publishedAt),
    "UPDATE_PUBLISHED_AT_NOT_MONOTONIC",
  );
  return next;
}

export async function fetchReleaseBytes(
  url,
  maxBytes,
  label,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
) {
  assert.ok(url instanceof URL, `${label}_URL_INVALID`);
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0, `${label}_LIMIT_INVALID`);
  assert.equal(typeof fetchImpl, "function", `${label}_FETCH_INVALID`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200, `${label}_HTTP_STATUS_INVALID`);
    assert.ok(response.body, `${label}_BODY_MISSING`);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      assert.match(declaredLength, /^(?:0|[1-9]\d*)$/u, `${label}_CONTENT_LENGTH_INVALID`);
      assert.ok(Number(declaredLength) <= maxBytes, `${label}_CONTENT_LENGTH_TOO_LARGE`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        assert.fail(`${label}_TOO_LARGE`);
      }
      chunks.push(Buffer.from(item.value));
    }
    if (declaredLength !== null)
      assert.equal(total, Number(declaredLength), `${label}_CONTENT_LENGTH_MISMATCH`);
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timeout);
  }
}

function sameResolvedPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function canonicalFilePath(file) {
  assert.ok(path.isAbsolute(file), "PUBLISHED_FILE_PATH_INVALID");
  const name = path.basename(file);
  assert.ok(name.length > 0 && name !== "." && name !== "..", "PUBLISHED_FILE_PATH_INVALID");
  return path.join(path.resolve(realpathSync.native(path.dirname(file))), name);
}

function assertSameCanonicalParent(left, right, code) {
  assert.equal(
    path.resolve(realpathSync.native(path.dirname(left))).toLowerCase(),
    path.resolve(realpathSync.native(path.dirname(right))).toLowerCase(),
    code,
  );
}

function verifiedPathIdentity(file, expectedSha256, code) {
  const before = fileIdentity(file, code);
  const bytes = readFileSync(file);
  const after = fileIdentity(file, code);
  assert.ok(sameFileIdentity(before, after), `${code}_IDENTITY_CHANGED`);
  assert.equal(before.size, after.size, `${code}_SIZE_CHANGED`);
  assert.equal(sha256(bytes), expectedSha256, code);
  return before;
}

function publicationTransaction({
  destination,
  temporary,
  previousSha256,
  replacementSha256,
  receiptPath,
  receiptSha256,
  lockDatabasePath,
}) {
  assert.ok(path.isAbsolute(receiptPath), "PUBLISHED_FILE_RECEIPT_INVALID");
  assert.match(receiptSha256, SHA256, "PUBLISHED_FILE_RECEIPT_SHA256_INVALID");
  const resolvedDestination = canonicalFilePath(destination);
  const resolvedTemporary = canonicalFilePath(temporary);
  let resolvedReceipt;
  try {
    const suppliedReceiptStat = lstatSync(receiptPath);
    assert.ok(
      suppliedReceiptStat.isFile() && !suppliedReceiptStat.isSymbolicLink(),
      "PUBLISHED_FILE_RECEIPT_INVALID",
    );
    resolvedReceipt = path.resolve(realpathSync.native(receiptPath));
    const receiptStat = lstatSync(resolvedReceipt);
    assert.ok(
      receiptStat.isFile() && !receiptStat.isSymbolicLink(),
      "PUBLISHED_FILE_RECEIPT_INVALID",
    );
  } catch (cause) {
    if (cause?.message === "PUBLISHED_FILE_RECEIPT_INVALID") throw cause;
    throw new Error("PUBLISHED_FILE_RECEIPT_INVALID", { cause });
  }
  const resolvedLockDatabase = canonicalFilePath(lockDatabasePath);
  const stateRoot = path.resolve(realpathSync.native(path.dirname(resolvedLockDatabase)));
  const receiptRelativePath = path.relative(stateRoot, resolvedReceipt).replaceAll("\\", "/");
  assert.ok(
    validRelativePackagePath(receiptRelativePath),
    "PUBLISHED_FILE_RECEIPT_OUTSIDE_STATE_ROOT",
  );
  assertSameCanonicalParent(
    resolvedDestination,
    resolvedTemporary,
    "PUBLISHED_FILE_TEMPORARY_DIRECTORY_MISMATCH",
  );
  const destinationPathSha256 = sha256(Buffer.from(resolvedDestination.toLowerCase(), "utf8"));
  const transactionMaterial = Object.freeze({
    schemaVersion: 2,
    protocol: "active-claim-create-only-v2",
    destinationPathSha256,
    destinationName: path.basename(resolvedDestination),
    temporaryName: path.basename(resolvedTemporary),
    previousSha256,
    replacementSha256,
    receiptRelativePath,
    receiptSha256,
  });
  const transactionId = sha256(Buffer.from(JSON.stringify(transactionMaterial), "utf8"));
  const activePath = `${resolvedLockDatabase}.active.json`;
  const claimName = `${path.basename(resolvedDestination)}.publication-claim-${transactionId}`;
  const claimPath = path.join(path.dirname(resolvedDestination), claimName);
  const historyPath = `${resolvedLockDatabase}.history-${transactionId}.json`;
  assertSameCanonicalParent(
    resolvedDestination,
    claimPath,
    "PUBLISHED_FILE_CLAIM_DIRECTORY_MISMATCH",
  );
  assertSameCanonicalParent(activePath, historyPath, "PUBLISHED_FILE_STATE_DIRECTORY_MISMATCH");
  const marker = Object.freeze({
    ...transactionMaterial,
    transactionId,
    claimName,
    historyName: path.basename(historyPath),
  });
  const markerBytes = Buffer.from(`${JSON.stringify(marker)}\n`, "utf8");
  return Object.freeze({
    schemaVersion: marker.schemaVersion,
    protocol: marker.protocol,
    transactionId,
    destinationPathSha256,
    destinationName: marker.destinationName,
    temporaryName: marker.temporaryName,
    claimName,
    historyName: marker.historyName,
    destination: resolvedDestination,
    temporary: resolvedTemporary,
    claimPath,
    historyPath,
    previousSha256,
    replacementSha256,
    receiptPath: resolvedReceipt,
    receiptSha256,
    activePath,
    lockDatabasePath: resolvedLockDatabase,
    markerBytes,
    markerSha256: sha256(markerBytes),
  });
}

function readPublicationTransaction(activePath, lockDatabasePath, destination) {
  const stat = lstatSync(activePath);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 32 * 1024,
    "PUBLISHED_FILE_ACTIVE_MARKER_INVALID",
  );
  const bytes = readFileSync(activePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error("PUBLISHED_FILE_ACTIVE_MARKER_INVALID", { cause });
  }
  assert.equal(value?.schemaVersion, 2, "PUBLISHED_FILE_ACTIVE_MARKER_INVALID");
  assert.equal(
    value?.protocol,
    "active-claim-create-only-v2",
    "PUBLISHED_FILE_ACTIVE_MARKER_INVALID",
  );
  assert.equal(
    value?.destinationName,
    path.basename(destination),
    "PUBLISHED_FILE_DESTINATION_INVALID",
  );
  assert.equal(
    value?.destinationPathSha256,
    sha256(Buffer.from(canonicalFilePath(destination).toLowerCase(), "utf8")),
    "PUBLISHED_FILE_DESTINATION_INVALID",
  );
  assert.equal(
    value?.temporaryName,
    path.basename(value?.temporaryName ?? ""),
    "PUBLISHED_FILE_TEMPORARY_INVALID",
  );
  assert.ok(
    validRelativePackagePath(value?.receiptRelativePath),
    "PUBLISHED_FILE_RECEIPT_RELATIVE_PATH_INVALID",
  );
  assert.match(value?.receiptSha256 ?? "", SHA256, "PUBLISHED_FILE_RECEIPT_SHA256_INVALID");
  const stateRoot = path.resolve(realpathSync.native(path.dirname(lockDatabasePath)));
  const receiptPath = path.join(stateRoot, ...value.receiptRelativePath.split("/"));
  let transaction;
  try {
    transaction = publicationTransaction({
      destination,
      temporary: path.join(path.dirname(destination), value.temporaryName),
      previousSha256: value?.previousSha256,
      replacementSha256: value?.replacementSha256,
      receiptPath,
      receiptSha256: value?.receiptSha256,
      lockDatabasePath,
    });
  } catch (cause) {
    if (cause?.message === "PUBLISHED_FILE_RECEIPT_INVALID") {
      throw new Error("PUBLISHED_FILE_RECOVERY_RECEIPT_MISMATCH", { cause });
    }
    throw cause;
  }
  assert.ok(bytes.equals(transaction.markerBytes), "PUBLISHED_FILE_ACTIVE_MARKER_INVALID");
  assert.ok(
    sameResolvedPath(activePath, transaction.activePath),
    "PUBLISHED_FILE_ACTIVE_PATH_INVALID",
  );
  return transaction;
}

function assertTransactionInputs(transaction) {
  assert.match(transaction.transactionId, SHA256, "PUBLISHED_FILE_TRANSACTION_ID_INVALID");
  assert.match(transaction.replacementSha256, SHA256, "PUBLISHED_FILE_REPLACEMENT_SHA256_INVALID");
  assert.ok(
    transaction.previousSha256 === null || SHA256.test(transaction.previousSha256),
    "PUBLISHED_FILE_PREVIOUS_SHA256_INVALID",
  );
  assert.match(transaction.receiptSha256, SHA256, "PUBLISHED_FILE_RECEIPT_SHA256_INVALID");
  assert.ok(path.isAbsolute(transaction.receiptPath), "PUBLISHED_FILE_RECEIPT_INVALID");
  try {
    const receiptStat = lstatSync(transaction.receiptPath);
    assert.ok(
      receiptStat.isFile() && !receiptStat.isSymbolicLink(),
      "PUBLISHED_FILE_RECOVERY_RECEIPT_MISMATCH",
    );
    verifiedPathIdentity(
      transaction.receiptPath,
      transaction.receiptSha256,
      "PUBLISHED_FILE_RECOVERY_RECEIPT_MISMATCH",
    );
  } catch (cause) {
    if (cause?.message?.startsWith("PUBLISHED_FILE_RECOVERY_RECEIPT_MISMATCH")) throw cause;
    throw new Error("PUBLISHED_FILE_RECOVERY_RECEIPT_MISMATCH", { cause });
  }
}

function assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, phase) {
  assertTransactionInputs(transaction);
  assert.equal(
    typeof validatePreparedReceipt,
    "function",
    "PUBLISHED_FILE_RECEIPT_VALIDATOR_INVALID",
  );
  validatePreparedReceipt(Object.freeze({ transaction, phase }));
}

function moveCreateOnly(source, destination, expectedSourceSha256, moveOptions, code) {
  try {
    return moveFileWriteThrough(source, destination, {
      ...moveOptions,
      expectedSourceSha256,
    });
  } catch (cause) {
    const error = new Error(code, { cause });
    error.nativeError = cause?.nativeError ?? null;
    error.helperCode = cause?.helperCode ?? null;
    throw error;
  }
}

function restoreUnexpectedClaim(transaction, expectedIdentity, moveOptions, cause) {
  let restored = false;
  let restoreRecovered = false;
  let restoreCause = null;
  const actualClaimSha256 = fileSha256OrNull(transaction.claimPath);
  const claimIdentity = existsSync(transaction.claimPath)
    ? fileIdentity(transaction.claimPath)
    : null;
  if (claimIdentity !== null && fileSha256OrNull(transaction.destination) === null) {
    let moveRestoreCause = null;
    try {
      moveCreateOnly(
        transaction.claimPath,
        transaction.destination,
        actualClaimSha256,
        moveOptions,
        "PUBLISHED_FILE_UNEXPECTED_CLAIM_RESTORE_FAILED",
      );
    } catch (error) {
      moveRestoreCause = error;
    }
    try {
      assert.equal(
        fileSha256OrNull(transaction.claimPath),
        null,
        "PUBLISHED_FILE_UNEXPECTED_CLAIM_RESTORE_SOURCE_REMAINED",
      );
      const restoredIdentity = verifiedPathIdentity(
        transaction.destination,
        actualClaimSha256,
        "PUBLISHED_FILE_UNEXPECTED_CLAIM_RESTORE_MISMATCH",
      );
      assert.ok(
        sameFileIdentity(claimIdentity, restoredIdentity),
        "PUBLISHED_FILE_UNEXPECTED_CLAIM_RESTORE_IDENTITY_MISMATCH",
      );
      restored = true;
      restoreRecovered = moveRestoreCause !== null;
      restoreCause = moveRestoreCause;
    } catch (proofCause) {
      restoreCause = moveRestoreCause ?? proofCause;
      if (moveRestoreCause !== null) moveRestoreCause.proofCause = proofCause;
    }
  }
  const error = new Error("PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH", { cause });
  error.expectedIdentityMatched =
    claimIdentity !== null &&
    expectedIdentity !== null &&
    sameFileIdentity(expectedIdentity, claimIdentity);
  error.actualClaimSha256 = actualClaimSha256;
  error.restored = restored;
  error.restoreRecovered = restoreRecovered;
  error.restoreCause = restoreCause;
  throw error;
}

function archiveActiveTransaction(transaction, checkpoint, moveOptions) {
  const activeIdentity = verifiedPathIdentity(
    transaction.activePath,
    transaction.markerSha256,
    "PUBLISHED_FILE_ACTIVE_MARKER_CHANGED",
  );
  let moveCause = null;
  let archiveRecovered = false;
  try {
    moveCreateOnly(
      transaction.activePath,
      transaction.historyPath,
      transaction.markerSha256,
      moveOptions,
      "PUBLISHED_FILE_ACTIVE_ARCHIVE_FAILED",
    );
  } catch (cause) {
    moveCause = cause;
  }
  if (
    moveCause !== null &&
    existsSync(transaction.historyPath) &&
    !existsSync(transaction.activePath)
  ) {
    const historySha256 = fileSha256OrNull(transaction.historyPath);
    const historyIdentity = fileIdentity(transaction.historyPath);
    if (
      historySha256 === transaction.markerSha256 &&
      sameFileIdentity(activeIdentity, historyIdentity)
    ) {
      archiveRecovered = true;
      moveCause = null;
    }
  }
  if (moveCause !== null) throw moveCause;
  checkpoint("active-history-created");
  const historyIdentity = verifiedPathIdentity(
    transaction.historyPath,
    transaction.markerSha256,
    "PUBLISHED_FILE_HISTORY_MARKER_CHANGED",
  );
  assert.ok(
    sameFileIdentity(activeIdentity, historyIdentity),
    "PUBLISHED_FILE_HISTORY_MARKER_IDENTITY_MISMATCH",
  );
  assert.equal(existsSync(transaction.activePath), false, "PUBLISHED_FILE_ACTIVE_MARKER_REMAINED");
  checkpoint("active-archived");
  verifiedPathIdentity(
    transaction.historyPath,
    transaction.markerSha256,
    "PUBLISHED_FILE_HISTORY_MARKER_CHANGED",
  );
  assert.equal(
    existsSync(transaction.activePath),
    false,
    "PUBLISHED_FILE_ACTIVE_MARKER_REAPPEARED",
  );
  return archiveRecovered;
}

function observePublicationState(
  transaction,
  expectedLatestIdentity,
  expectedMarkerIdentity,
  recovered,
) {
  let contentCommitted = false;
  let completed = false;
  try {
    assert.equal(existsSync(transaction.temporary), false);
    const latestIdentity = verifiedPathIdentity(
      transaction.destination,
      transaction.replacementSha256,
      "PUBLISHED_FILE_STATE_LATEST_INVALID",
    );
    assert.ok(sameFileIdentity(expectedLatestIdentity, latestIdentity));
    contentCommitted = true;

    verifiedPathIdentity(
      transaction.receiptPath,
      transaction.receiptSha256,
      "PUBLISHED_FILE_STATE_RECEIPT_INVALID",
    );
    if (transaction.previousSha256 === null) {
      assert.equal(existsSync(transaction.claimPath), false);
    } else {
      verifiedPathIdentity(
        transaction.claimPath,
        transaction.previousSha256,
        "PUBLISHED_FILE_STATE_CLAIM_INVALID",
      );
    }
    assert.equal(existsSync(transaction.activePath), false);
    const historyIdentity = verifiedPathIdentity(
      transaction.historyPath,
      transaction.markerSha256,
      "PUBLISHED_FILE_STATE_HISTORY_INVALID",
    );
    assert.ok(sameFileIdentity(expectedMarkerIdentity, historyIdentity));
    completed = true;
  } catch {
    // Failure evidence reports only states proved from exact, stable, single-link files.
  }
  return Object.freeze({
    schemaVersion: 1,
    transactionId: transaction.transactionId,
    receiptSha256: transaction.receiptSha256,
    replacementSha256: transaction.replacementSha256,
    previousSha256: transaction.previousSha256,
    markerSha256: transaction.markerSha256,
    claimSha256: transaction.previousSha256,
    claimName: transaction.claimName,
    historyName: transaction.historyName,
    contentCommitted,
    completed,
    recovered: Boolean(recovered),
  });
}

function errorWithPublicationState(cause, publicationState, phase) {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
  try {
    error.publicationState = publicationState;
    error.publicationPhase = phase;
    return error;
  } catch {
    const wrapped = new Error(error.message, { cause: error });
    wrapped.publicationState = publicationState;
    wrapped.publicationPhase = phase;
    return wrapped;
  }
}

function publicationStateWithRecovery(publicationState, recovered) {
  return Object.freeze({
    ...publicationState,
    recovered: publicationState.recovered || Boolean(recovered),
  });
}

function addRecoveryToPublicationError(cause, recovered) {
  if (!recovered || !cause?.publicationState) return cause;
  return errorWithPublicationState(
    cause,
    publicationStateWithRecovery(cause.publicationState, true),
    cause.publicationPhase ?? "publication",
  );
}

function reconcileActiveTransaction(
  transaction,
  checkpoint,
  moveOptions,
  validatePreparedReceipt,
  resuming,
) {
  assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, "reconcile-start");
  const activeIdentity = verifiedPathIdentity(
    transaction.activePath,
    transaction.markerSha256,
    "PUBLISHED_FILE_ACTIVE_MARKER_CHANGED",
  );
  const destinationSha256 = fileSha256OrNull(transaction.destination);
  const claimSha256 = fileSha256OrNull(transaction.claimPath);
  let claimRecovered = false;

  if (destinationSha256 === transaction.replacementSha256) {
    assert.equal(
      fileSha256OrNull(transaction.temporary),
      null,
      "PUBLISHED_FILE_TEMPORARY_REMAINED_WITH_LATEST",
    );
    const latestIdentity = verifiedPathIdentity(
      transaction.destination,
      transaction.replacementSha256,
      "PUBLISHED_FILE_LATEST_CHANGED",
    );
    if (transaction.previousSha256 === null) {
      assert.equal(claimSha256, null, "PUBLISHED_FILE_UNEXPECTED_CLAIM");
    } else {
      assert.equal(
        claimSha256,
        transaction.previousSha256,
        "PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH",
      );
      verifiedPathIdentity(
        transaction.claimPath,
        transaction.previousSha256,
        "PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH",
      );
    }
    let publicationPhase = "before-active-archive";
    try {
      assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, publicationPhase);
      publicationPhase = "active-archive";
      archiveActiveTransaction(transaction, checkpoint, moveOptions);
      publicationPhase = "recovery-return";
      assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, publicationPhase);
      verifiedPathIdentity(
        transaction.destination,
        transaction.replacementSha256,
        "PUBLISHED_FILE_LATEST_CHANGED_AFTER_ARCHIVE",
      );
      if (transaction.previousSha256 !== null) {
        verifiedPathIdentity(
          transaction.claimPath,
          transaction.previousSha256,
          "PUBLISHED_FILE_CLAIM_CHANGED_AFTER_ARCHIVE",
        );
      }
      const publicationState = observePublicationState(
        transaction,
        latestIdentity,
        activeIdentity,
        true,
      );
      return { transaction, recovered: true, publicationState };
    } catch (cause) {
      throw errorWithPublicationState(
        cause,
        observePublicationState(transaction, latestIdentity, activeIdentity, true),
        publicationPhase,
      );
    }
  }

  verifiedPathIdentity(
    transaction.temporary,
    transaction.replacementSha256,
    "PUBLISHED_FILE_TEMPORARY_MISMATCH",
  );

  if (transaction.previousSha256 === null) {
    assert.equal(claimSha256, null, "PUBLISHED_FILE_UNEXPECTED_CLAIM");
    if (destinationSha256 !== null) throw new Error("PUBLISHED_FILE_CHANGED_BEFORE_COMMIT");
  } else if (claimSha256 === null) {
    if (destinationSha256 !== transaction.previousSha256) {
      throw new Error("PUBLISHED_FILE_CHANGED_BEFORE_COMMIT");
    }
    assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, "before-latest-claim");
    const expectedIdentity = verifiedPathIdentity(
      transaction.destination,
      transaction.previousSha256,
      "PUBLISHED_FILE_PREIMAGE_CHANGED",
    );
    let moveCause = null;
    try {
      moveCreateOnly(
        transaction.destination,
        transaction.claimPath,
        transaction.previousSha256,
        moveOptions,
        "PUBLISHED_FILE_CLAIM_CREATE_FAILED",
      );
    } catch (cause) {
      moveCause = cause;
    }
    const claimedSha256 = fileSha256OrNull(transaction.claimPath);
    const claimedIdentity = existsSync(transaction.claimPath)
      ? fileIdentity(transaction.claimPath)
      : null;
    if (
      claimedSha256 !== transaction.previousSha256 ||
      claimedIdentity === null ||
      !sameFileIdentity(expectedIdentity, claimedIdentity)
    ) {
      if (claimedIdentity !== null && fileSha256OrNull(transaction.destination) === null) {
        restoreUnexpectedClaim(transaction, expectedIdentity, moveOptions, moveCause);
      }
      if (moveCause) throw moveCause;
      throw new Error("PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH");
    }
    assert.equal(
      fileSha256OrNull(transaction.destination),
      null,
      "PUBLISHED_FILE_DESTINATION_RECREATED_DURING_CLAIM",
    );
    claimRecovered = moveCause !== null;
    checkpoint("previous-claimed");
  } else {
    if (claimSha256 !== transaction.previousSha256) {
      throw new Error("PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH");
    }
    verifiedPathIdentity(
      transaction.claimPath,
      transaction.previousSha256,
      "PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH",
    );
    if (destinationSha256 !== null) throw new Error("PUBLISHED_FILE_CHANGED_BEFORE_COMMIT");
  }

  if (
    transaction.previousSha256 !== null &&
    fileSha256OrNull(transaction.claimPath) !== transaction.previousSha256
  ) {
    throw new Error("PUBLISHED_FILE_CLAIM_CHANGED_BEFORE_COMMIT");
  }

  assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, "before-latest-create");
  const temporaryIdentity = verifiedPathIdentity(
    transaction.temporary,
    transaction.replacementSha256,
    "PUBLISHED_FILE_TEMPORARY_CHANGED_BEFORE_COMMIT",
  );
  let createCause = null;
  try {
    moveCreateOnly(
      transaction.temporary,
      transaction.destination,
      transaction.replacementSha256,
      moveOptions,
      "PUBLISHED_FILE_LATEST_CREATE_FAILED",
    );
  } catch (cause) {
    createCause = cause;
  }
  let latestProofCause = null;
  try {
    assert.equal(
      fileSha256OrNull(transaction.temporary),
      null,
      "PUBLISHED_FILE_TEMPORARY_REMAINED_AFTER_LATEST_CREATE",
    );
    const latestIdentity = verifiedPathIdentity(
      transaction.destination,
      transaction.replacementSha256,
      "PUBLISHED_FILE_LATEST_CREATE_POSTCONDITION_FAILED",
    );
    assert.ok(
      sameFileIdentity(temporaryIdentity, latestIdentity),
      "PUBLISHED_FILE_LATEST_CREATE_IDENTITY_MISMATCH",
    );
  } catch (cause) {
    latestProofCause = cause;
  }
  if (latestProofCause !== null) {
    const error = new Error("PUBLISHED_FILE_CHANGED_BEFORE_COMMIT", {
      cause: createCause ?? latestProofCause,
    });
    error.nativeError = createCause?.nativeError ?? null;
    error.proofCause = latestProofCause;
    throw error;
  }
  let archiveRecovered = false;
  let publicationPhase = "after-latest-create";
  try {
    assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, publicationPhase);
    checkpoint("latest-created");
    publicationPhase = "claim-validation-after-commit";
    if (transaction.previousSha256 !== null) {
      verifiedPathIdentity(
        transaction.claimPath,
        transaction.previousSha256,
        "PUBLISHED_FILE_CLAIM_CHANGED_AFTER_COMMIT",
      );
    }
    publicationPhase = "before-active-archive";
    assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, publicationPhase);
    publicationPhase = "active-archive";
    archiveRecovered = archiveActiveTransaction(transaction, checkpoint, moveOptions);
    publicationPhase = "publication-return";
    assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, publicationPhase);
    verifiedPathIdentity(
      transaction.destination,
      transaction.replacementSha256,
      "PUBLISHED_FILE_LATEST_CHANGED_AFTER_ARCHIVE",
    );
    if (transaction.previousSha256 !== null) {
      verifiedPathIdentity(
        transaction.claimPath,
        transaction.previousSha256,
        "PUBLISHED_FILE_CLAIM_CHANGED_AFTER_ARCHIVE",
      );
    }
    const recovered = resuming || claimRecovered || createCause !== null || archiveRecovered;
    const publicationState = observePublicationState(
      transaction,
      temporaryIdentity,
      activeIdentity,
      recovered,
    );
    return { transaction, recovered, publicationState };
  } catch (cause) {
    const recovered = resuming || claimRecovered || createCause !== null || archiveRecovered;
    throw errorWithPublicationState(
      cause,
      observePublicationState(transaction, temporaryIdentity, activeIdentity, recovered),
      publicationPhase,
    );
  }
}

function openPublicationDatabase(lockDatabasePath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (cause) {
    throw new Error("PUBLISHED_FILE_LOCK_DATABASE_UNAVAILABLE", { cause });
  }
  return new DatabaseSync(lockDatabasePath);
}

function publicationHistoryFiles(lockDatabasePath) {
  const prefix = `${path.basename(lockDatabasePath)}.history-`;
  return readdirSync(path.dirname(lockDatabasePath)).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".json"),
  );
}

function throwPublicationLockFinalizeError(
  settledResult,
  lockFinalizePhase,
  lockFinalizeCause,
  lockCloseCause,
) {
  const finalizeCause = lockFinalizeCause ?? lockCloseCause;
  const finalizePhase = lockFinalizeCause ? lockFinalizePhase : "lock-close";
  const error = errorWithPublicationState(
    new Error("PUBLISHED_FILE_LOCK_FINALIZE_FAILED", { cause: finalizeCause }),
    settledResult.publicationState,
    finalizePhase,
  );
  error.lockCommitCause = lockFinalizePhase === "lock-commit" ? lockFinalizeCause : null;
  error.lockRollbackCause = lockFinalizePhase === "lock-rollback" ? lockFinalizeCause : null;
  error.lockCloseCause = lockCloseCause;
  throw error;
}

function commitClaimPublication({
  destination,
  temporary,
  replacementBytes,
  expectedPreviousBytes,
  receiptPath,
  receiptSha256,
  lockDatabasePath,
  checkpoint,
  moveOptions,
  validatePreparedReceipt,
  databaseFactory,
}) {
  const replacementSha256 = sha256(replacementBytes);
  const previousSha256 = expectedPreviousBytes === null ? null : sha256(expectedPreviousBytes);
  const requested = publicationTransaction({
    destination,
    temporary,
    previousSha256,
    replacementSha256,
    receiptPath,
    receiptSha256,
    lockDatabasePath,
  });
  assertTransactionInputs(requested);

  const database = databaseFactory(requested.lockDatabasePath);
  let transactionOpen = false;
  let succeeded = false;
  let settledResult = null;
  let primaryError = null;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
    } catch (cause) {
      if (/\b(?:busy|locked)\b/iu.test(cause?.message ?? "")) {
        throw new Error("PUBLISHED_FILE_PUBLICATION_IN_PROGRESS", { cause });
      }
      throw new Error("PUBLISHED_FILE_LOCK_DATABASE_FAILED", { cause });
    }
    checkpoint("lock-acquired");

    if (existsSync(requested.activePath)) {
      const active = readPublicationTransaction(
        requested.activePath,
        requested.lockDatabasePath,
        requested.destination,
      );
      const settled = reconcileActiveTransaction(
        active,
        checkpoint,
        moveOptions,
        validatePreparedReceipt,
        true,
      );
      if (active.transactionId === requested.transactionId) {
        succeeded = true;
        settledResult = settled;
        return settledResult;
      }
    }

    if (existsSync(requested.historyPath)) {
      const historyStat = lstatSync(requested.historyPath);
      assert.ok(
        historyStat.isFile() && !historyStat.isSymbolicLink(),
        "PUBLISHED_FILE_HISTORY_MARKER_COLLISION",
      );
      const historyIdentity = verifiedPathIdentity(
        requested.historyPath,
        requested.markerSha256,
        "PUBLISHED_FILE_HISTORY_MARKER_COLLISION",
      );
      if (fileSha256OrNull(requested.destination) !== requested.replacementSha256) {
        throw new Error("PUBLISHED_FILE_CHANGED_BEFORE_COMMIT");
      }
      assertPreparedReceiptEvidence(requested, validatePreparedReceipt, "history-return");
      const latestIdentity = verifiedPathIdentity(
        requested.destination,
        requested.replacementSha256,
        "PUBLISHED_FILE_LATEST_CHANGED_AT_HISTORY_RETURN",
      );
      const publicationState = observePublicationState(
        requested,
        latestIdentity,
        historyIdentity,
        true,
      );
      succeeded = true;
      settledResult = { transaction: requested, recovered: true, publicationState };
      return settledResult;
    }

    if (
      requested.previousSha256 === null &&
      publicationHistoryFiles(requested.lockDatabasePath).length > 0
    ) {
      throw new Error("PUBLISHED_FILE_HISTORY_PREVENTS_INITIAL_CREATE");
    }

    if (fileSha256OrNull(requested.destination) !== requested.previousSha256) {
      throw new Error("PUBLISHED_FILE_CHANGED_BEFORE_COMMIT");
    }

    const replacementPublication = writeOrReuseExact(
      requested.temporary,
      replacementBytes,
      "PUBLISHED_FILE_TEMPORARY_COLLISION",
      moveOptions,
    );
    assert.equal(
      fileSha256OrNull(requested.temporary),
      requested.replacementSha256,
      "PUBLISHED_FILE_TEMPORARY_MISMATCH",
    );
    checkpoint("replacement-durable");
    assertPreparedReceiptEvidence(requested, validatePreparedReceipt, "before-active-marker");
    const activePublication = writeFileExclusiveDurable(
      requested.activePath,
      requested.markerBytes,
      () => {},
      moveOptions,
    );
    checkpoint("active-marker-durable");
    let committed;
    try {
      committed = reconcileActiveTransaction(
        requested,
        checkpoint,
        moveOptions,
        validatePreparedReceipt,
        !replacementPublication.created,
      );
    } catch (cause) {
      throw addRecoveryToPublicationError(
        cause,
        replacementPublication.recovered || activePublication.recovered,
      );
    }
    succeeded = true;
    const recovered =
      committed.recovered || replacementPublication.recovered || activePublication.recovered;
    settledResult = {
      ...committed,
      recovered,
      publicationState: publicationStateWithRecovery(committed.publicationState, recovered),
    };
    return settledResult;
  } catch (cause) {
    primaryError = cause instanceof Error ? cause : new Error(String(cause), { cause });
    throw primaryError;
  } finally {
    let lockFinalizePhase = null;
    let lockFinalizeCause = null;
    try {
      if (transactionOpen) {
        lockFinalizePhase = succeeded ? "lock-commit" : "lock-rollback";
        database.exec(succeeded ? "COMMIT" : "ROLLBACK");
      }
    } catch (cause) {
      lockFinalizeCause = cause;
    }
    let lockCloseCause = null;
    try {
      database.close();
    } catch (cause) {
      lockCloseCause = cause;
    }
    if (primaryError && (lockFinalizeCause || lockCloseCause)) {
      try {
        if (lockFinalizePhase === "lock-rollback")
          primaryError.lockRollbackCause = lockFinalizeCause;
        else if (lockFinalizeCause) primaryError.lockCommitCause = lockFinalizeCause;
        primaryError.lockCloseCause = lockCloseCause;
      } catch {
        // Preserve the primary error even when an unusual frozen Error rejects metadata.
      }
    } else if (!primaryError && (lockFinalizeCause || lockCloseCause)) {
      throwPublicationLockFinalizeError(
        settledResult,
        lockFinalizePhase,
        lockFinalizeCause,
        lockCloseCause,
      );
    }
  }
}

export function verifyCommittedPublication(publicationCommit, validatePreparedReceipt) {
  assert.equal(publicationCommit?.committed, true, "PUBLISHED_FILE_COMMIT_INVALID");
  assert.equal(
    typeof validatePreparedReceipt,
    "function",
    "PUBLISHED_FILE_RECEIPT_VALIDATOR_INVALID",
  );
  const transaction = publicationCommit.verificationDescriptor;
  assert.ok(transaction && typeof transaction === "object", "PUBLISHED_FILE_DESCRIPTOR_INVALID");
  assert.equal(
    transaction.transactionId,
    publicationCommit.transactionId,
    "PUBLISHED_FILE_TRANSACTION_ID_MISMATCH",
  );
  assert.equal(
    transaction.receiptSha256,
    publicationCommit.receiptSha256,
    "PUBLISHED_FILE_RECEIPT_SHA256_MISMATCH",
  );
  assertPreparedReceiptEvidence(transaction, validatePreparedReceipt, "committed-verification");
  assert.equal(existsSync(transaction.temporary), false, "PUBLISHED_FILE_TEMPORARY_REAPPEARED");
  assert.equal(
    existsSync(transaction.activePath),
    false,
    "PUBLISHED_FILE_ACTIVE_MARKER_REAPPEARED",
  );
  const latestIdentity = verifiedPathIdentity(
    transaction.destination,
    transaction.replacementSha256,
    "PUBLISHED_FILE_COMMITTED_LATEST_INVALID",
  );
  if (transaction.previousSha256 === null) {
    assert.equal(existsSync(transaction.claimPath), false, "PUBLISHED_FILE_UNEXPECTED_CLAIM");
  } else {
    verifiedPathIdentity(
      transaction.claimPath,
      transaction.previousSha256,
      "PUBLISHED_FILE_COMMITTED_CLAIM_INVALID",
    );
  }
  const historyIdentity = verifiedPathIdentity(
    transaction.historyPath,
    transaction.markerSha256,
    "PUBLISHED_FILE_COMMITTED_HISTORY_INVALID",
  );
  const publicationState = observePublicationState(
    transaction,
    latestIdentity,
    historyIdentity,
    publicationCommit.recovered,
  );
  assert.equal(publicationState.contentCommitted, true, "PUBLISHED_FILE_CONTENT_NOT_COMMITTED");
  assert.equal(publicationState.completed, true, "PUBLISHED_FILE_COMMIT_INCOMPLETE");
  return Object.freeze({
    ...publicationState,
    stateValidation: "exact-single-link-receipt-latest-claim-history; temporary-and-active-absent",
  });
}

// The prepared receipt and private active marker are durable before latest is
// vacated. A fixed active slot prevents an older release from replaying its
// retained claim while a newer transaction is in progress. Canonical latest is
// changed only by two create-only write-through moves: latest to its immutable
// claim, then the prepared replacement to latest.
export function commitPreparedPublication({
  destination,
  temporary,
  replacementBytes,
  expectedPreviousBytes,
  receiptPath,
  receiptBytes,
  lockDatabasePath = `${destination}.publication.sqlite`,
  checkpoint = () => {},
  moveOptions = {},
  validatePreparedReceipt,
  databaseFactory = openPublicationDatabase,
}) {
  assert.ok(path.isAbsolute(destination), "PUBLISHED_FILE_DESTINATION_INVALID");
  assert.ok(path.isAbsolute(temporary), "PUBLISHED_FILE_TEMPORARY_INVALID");
  assert.equal(
    path.dirname(destination).toLowerCase(),
    path.dirname(temporary).toLowerCase(),
    "PUBLISHED_FILE_TEMPORARY_DIRECTORY_MISMATCH",
  );
  assert.equal(typeof databaseFactory, "function", "PUBLISHED_FILE_DATABASE_FACTORY_INVALID");
  assert.notEqual(
    destination.toLowerCase(),
    temporary.toLowerCase(),
    "PUBLISHED_FILE_PATH_COLLISION",
  );
  assert.ok(path.isAbsolute(receiptPath), "PUBLISHED_FILE_RECEIPT_INVALID");
  assert.ok(path.isAbsolute(lockDatabasePath), "PUBLISHED_FILE_LOCK_DATABASE_INVALID");
  assert.ok(
    Buffer.isBuffer(replacementBytes) && replacementBytes.length > 0,
    "PUBLISHED_FILE_BYTES_INVALID",
  );
  assert.ok(
    expectedPreviousBytes === null || Buffer.isBuffer(expectedPreviousBytes),
    "PUBLISHED_FILE_PREVIOUS_BYTES_INVALID",
  );
  assert.ok(
    Buffer.isBuffer(receiptBytes) && receiptBytes.length > 0,
    "PUBLISHED_FILE_RECEIPT_INVALID",
  );
  assert.equal(typeof checkpoint, "function", "PUBLISHED_FILE_CHECKPOINT_INVALID");
  assert.equal(
    typeof validatePreparedReceipt,
    "function",
    "PUBLISHED_FILE_RECEIPT_VALIDATOR_INVALID",
  );

  const receiptSha256 = sha256(receiptBytes);

  const receiptPublication = writeOrReuseExact(
    receiptPath,
    receiptBytes,
    "RELEASE_RECEIPT_COLLISION",
    moveOptions,
  );
  assert.ok(readFileSync(receiptPath).equals(receiptBytes), "RELEASE_RECEIPT_READBACK_MISMATCH");
  checkpoint("receipt-durable");

  let committed;
  try {
    committed = commitClaimPublication({
      destination,
      temporary,
      replacementBytes,
      expectedPreviousBytes,
      receiptPath,
      receiptSha256,
      lockDatabasePath,
      checkpoint,
      moveOptions,
      validatePreparedReceipt,
      databaseFactory,
    });
    assert.equal(fileSha256OrNull(receiptPath), receiptSha256, "PUBLISHED_FILE_RECEIPT_CHANGED");
    assertPreparedReceiptEvidence(
      committed.transaction,
      validatePreparedReceipt,
      "commit-prepared-publication-return",
    );
  } catch (cause) {
    const receiptRecovered = receiptPublication.recovered || !receiptPublication.created;
    if (committed?.publicationState) {
      throw errorWithPublicationState(
        cause,
        publicationStateWithRecovery(committed.publicationState, receiptRecovered),
        "commit-prepared-publication-return",
      );
    }
    throw addRecoveryToPublicationError(cause, receiptRecovered);
  }
  const previousSha256 = expectedPreviousBytes === null ? null : sha256(expectedPreviousBytes);
  const replacementSha256 = sha256(replacementBytes);
  const recovered =
    committed.recovered || receiptPublication.recovered || !receiptPublication.created;
  const publicationState = publicationStateWithRecovery(committed.publicationState, recovered);
  return {
    committed: true,
    previousExisted: expectedPreviousBytes !== null,
    previousSha256,
    replacementSha256,
    receiptSha256,
    recovered,
    transactionId: committed.transaction.transactionId,
    claimPath: committed.transaction.claimPath,
    historyPath: committed.transaction.historyPath,
    publicationState,
    verificationDescriptor: committed.transaction,
  };
}

export function verifyPreviewInstallerPayload(
  installerBytes,
  expectedSnapshot,
  verificationParent,
  label = "INSTALLER_PAYLOAD",
  execute = spawnSync,
) {
  assert.ok(
    Buffer.isBuffer(installerBytes) &&
      installerBytes.length > 0 &&
      installerBytes.length <= MAX_INSTALLER_BYTES,
    `${label}_INSTALLER_INVALID`,
  );
  validateReleaseContentSnapshot(expectedSnapshot, `${label}_EXPECTED`);
  assert.ok(path.isAbsolute(verificationParent), `${label}_VERIFICATION_PARENT_INVALID`);
  const canonicalParent = path.resolve(realpathSync.native(verificationParent));
  const parentStat = lstatSync(canonicalParent);
  assert.ok(
    parentStat.isDirectory() && !parentStat.isSymbolicLink(),
    `${label}_VERIFICATION_PARENT_INVALID`,
  );
  const temporaryRoot = mkdtempSync(path.join(canonicalParent, ".installer-payload-"));
  const canonicalTemporaryRoot = path.resolve(realpathSync.native(temporaryRoot));
  const relativeTemporaryRoot = path.relative(canonicalParent, canonicalTemporaryRoot);
  assert.ok(
    relativeTemporaryRoot &&
      !relativeTemporaryRoot.startsWith("..") &&
      !path.isAbsolute(relativeTemporaryRoot),
    `${label}_VERIFICATION_ROOT_OUTSIDE_PARENT`,
  );
  const installer = path.join(canonicalTemporaryRoot, "installer.exe");
  const payloadRoot = path.join(canonicalTemporaryRoot, "payload");
  try {
    writeFileSync(installer, installerBytes, { flag: "wx" });
    mkdirSync(payloadRoot);
    const result = execute(installer, ["/S", `/QA_HUB_VERIFY_PAYLOAD=${payloadRoot}`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, `${label}_EXTRACTION_FAILED`);
    assert.equal(result.signal, null, `${label}_EXTRACTION_SIGNALLED`);
    assert.equal(result.status, 0, `${label}_EXTRACTION_EXIT_INVALID`);
    return assertReleaseContentBinding(
      expectedSnapshot,
      snapshotReleaseDirectory(payloadRoot),
      label,
    );
  } finally {
    const cleanupRoot = path.resolve(realpathSync.native(canonicalTemporaryRoot));
    const cleanupRelative = path.relative(canonicalParent, cleanupRoot);
    assert.ok(
      cleanupRoot === canonicalTemporaryRoot &&
        cleanupRelative &&
        !cleanupRelative.startsWith("..") &&
        !path.isAbsolute(cleanupRelative),
      `${label}_CLEANUP_ROOT_INVALID`,
    );
    rmSync(cleanupRoot, { recursive: true, force: true });
  }
}
