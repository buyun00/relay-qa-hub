import assert from "node:assert/strict";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import asar from "@electron/asar";

import {
  assertReleaseContentBinding,
  assertSignedUpdateManifest,
  fetchReleaseBytes,
  serializeReleaseAttestation,
  snapshotInstalledPreviewDirectory,
  snapshotReleaseAsarDirectory,
  snapshotReleasePackageAsar,
  validateReleaseContentSnapshot,
  verifyPreviewInstallerPayload,
} from "./release-content-binding.mjs";
import {
  assertPinnedPackageToolchainProvenance,
  verifyPinnedWindowsPublicationToolchain,
} from "./package-toolchain-provenance.mjs";
import { derivePreviewPackageIdentity } from "./preview-package-identity.mjs";

const execFileAsync = promisify(execFile);
const sourcePath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(sourcePath), "../..");
const BLOCKED_PORTS = new Set([4319, 4174, 4320]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INSTANCE_ID = /^qa-hub-preview-[a-z0-9](?:[a-z0-9-]{1,54}[a-z0-9])$/u;
const RELEASE_ID = /^\d{8}T\d{9}Z$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const INACCESSIBLE_TEXT = "通知所属项目当前不可访问，已保持当前项目并刷新项目列表。";
const TOAST_TITLE = "QA Hub · 这个单子已创建";
const TIMEOUT = 20_000;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileSha256 = (file) => sha256(fs.readFileSync(file));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));

function containedBy(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExisting(candidate, label) {
  assert.ok(path.isAbsolute(candidate), `${label}_MUST_BE_ABSOLUTE`);
  assert.ok(fs.existsSync(candidate), `${label}_MISSING`);
  let cursor = path.parse(path.resolve(candidate)).root;
  for (const part of path.resolve(candidate).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    assert.ok(!fs.lstatSync(cursor).isSymbolicLink(), `${label}_LINK_REFUSED`);
  }
  return fs.realpathSync.native(candidate);
}

function blockedRoots(env = process.env) {
  return [
    "D:\\Relay-QA-Hub",
    "D:\\Relay-QA-Hub-Data",
    "D:\\Relay-QA-Hub-Config",
    "E:\\Relay-QA-Hub-Archives",
    path.join(env.LOCALAPPDATA ?? "C:\\", "Programs", "RelayQaHub"),
    path.join(env.LOCALAPPDATA ?? "C:\\", "Programs", "RelayQaHubPreview"),
    path.join(env.LOCALAPPDATA ?? "C:\\", "Relay QA Hub"),
    path.join(env.APPDATA ?? "C:\\", "Relay QA Hub"),
  ].map((item) => path.resolve(item));
}

function assertNoProductionOverlap(candidate, label, env = process.env) {
  for (const blocked of blockedRoots(env)) {
    assert.ok(
      !containedBy(blocked, candidate) && !containedBy(candidate, blocked),
      `${label}_PRODUCTION_OVERLAP`,
    );
  }
}

function gitSourceAttributionState(allowedUntrackedRoot = null) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const trackedChanges = [];
  const unexpectedUntracked = [];
  let allowedUntrackedFiles = 0;
  for (const entry of raw.split("\0").filter(Boolean)) {
    if (!entry.startsWith("?? ")) {
      trackedChanges.push(entry);
      continue;
    }
    const relative = entry.slice(3);
    const absolute = path.resolve(sourceRoot, relative);
    if (
      allowedUntrackedRoot !== null &&
      !path.isAbsolute(relative) &&
      containedBy(allowedUntrackedRoot, absolute)
    ) {
      allowedUntrackedFiles += 1;
    } else {
      unexpectedUntracked.push(relative);
    }
  }
  return { head, trackedChanges, unexpectedUntracked, allowedUntrackedFiles };
}

export function parseArguments(argv) {
  if (argv.length === 0) return { usageOnly: true, execute: false };
  const result = {
    instancePath: "",
    executablePath: "",
    expectedPublicKeySha256: "",
    expectedReleaseId: "",
    expectedVersion: "",
    execute: false,
    usageOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--run") {
      assert.equal(result.execute, false, "DUPLICATE_RUN_FLAG");
      result.execute = true;
      continue;
    }
    if (
      item === "--instance" ||
      item === "--exe" ||
      item === "--key-sha256" ||
      item === "--release-id" ||
      item === "--version"
    ) {
      const value = argv[++index];
      assert.ok(value && !value.startsWith("--"), `${item.slice(2).toUpperCase()}_VALUE_REQUIRED`);
      const key = {
        "--instance": "instancePath",
        "--exe": "executablePath",
        "--key-sha256": "expectedPublicKeySha256",
        "--release-id": "expectedReleaseId",
        "--version": "expectedVersion",
      }[item];
      assert.equal(result[key], "", `DUPLICATE_${item.slice(2).toUpperCase()}`);
      result[key] = value;
      continue;
    }
    throw new Error(`UNKNOWN_ARGUMENT_${item}`);
  }
  assert.ok(result.instancePath, "EXPLICIT_INSTANCE_REQUIRED");
  assert.ok(result.executablePath, "EXPLICIT_EXE_REQUIRED");
  assert.match(result.expectedPublicKeySha256, SHA256, "EXPLICIT_PUBLIC_KEY_SHA256_REQUIRED");
  assert.match(result.expectedReleaseId, RELEASE_ID, "EXPLICIT_RELEASE_ID_REQUIRED");
  assert.match(result.expectedVersion, /^0\.2\.0-preview\.[1-9]\d*$/u, "EXPLICIT_VERSION_REQUIRED");
  assert.ok(path.isAbsolute(result.instancePath), "INSTANCE_MUST_BE_ABSOLUTE");
  assert.ok(path.isAbsolute(result.executablePath), "EXE_MUST_BE_ABSOLUTE");
  return result;
}

export function durableToastBody(notification) {
  assert.ok(notification && typeof notification === "object", "INVALID_NOTIFICATION");
  const body =
    typeof notification.body === "string" && notification.body.length > 0
      ? notification.body
      : notification.type;
  assert.ok(
    typeof body === "string" && body.length > 0 && body.length <= 500,
    "INVALID_TOAST_BODY",
  );
  return body;
}

export function normalizePreviewPackageConfigIdentity(preview, instanceId) {
  assert.ok(preview && typeof preview === "object" && !Array.isArray(preview), "PREVIEW_INVALID");
  const expectedPackageIdentity = derivePreviewPackageIdentity(instanceId);
  const legacyPackageIdentity = expectedPackageIdentity.protocolScheme !== instanceId;
  const appScheme =
    preview.appScheme === undefined && legacyPackageIdentity
      ? expectedPackageIdentity.protocolScheme
      : preview.appScheme;
  assert.equal(appScheme, expectedPackageIdentity.protocolScheme, "PREVIEW_SCHEME_MISMATCH");
  const appUserModelId =
    preview.appUserModelId === undefined && legacyPackageIdentity
      ? expectedPackageIdentity.appUserModelId
      : preview.appUserModelId;
  assert.equal(
    appUserModelId,
    expectedPackageIdentity.appUserModelId,
    "PREVIEW_AUMID_IDENTITY_MISMATCH",
  );
  const toastActivatorClsid =
    preview.toastActivatorClsid === undefined
      ? expectedPackageIdentity.toastActivatorClsid
      : preview.toastActivatorClsid;
  assert.equal(
    toastActivatorClsid,
    expectedPackageIdentity.toastActivatorClsid,
    "PREVIEW_TOAST_CLSID_IDENTITY_MISMATCH",
  );
  return {
    expectedPackageIdentity,
    normalizedPreview: { ...preview, appScheme, appUserModelId, toastActivatorClsid },
  };
}

export function canonicalPackagedPreviewConfig(instance, updatePublicKeyPem) {
  assert.ok(
    instance && typeof instance === "object" && !Array.isArray(instance),
    "INSTANCE_INVALID",
  );
  assert.ok(INSTANCE_ID.test(instance.instanceId), "PREVIEW_INSTANCE_ID_REQUIRED");
  assert.ok(
    typeof updatePublicKeyPem === "string" &&
      updatePublicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"),
    "PREVIEW_KEY_INVALID",
  );
  const packageIdentity = derivePreviewPackageIdentity(instance.instanceId);
  return {
    schemaVersion: 1,
    instanceId: instance.instanceId,
    profileDirectory: path.join(instance.desktopRoot, "profile"),
    apiBaseUrl: `http://${instance.apiHost}:${instance.apiPort}`,
    csrfOrigin: `http://${instance.webHost}:${instance.webPort}`,
    cookieName: instance.cookieName,
    appScheme: packageIdentity.protocolScheme,
    appUserModelId: packageIdentity.appUserModelId,
    toastActivatorClsid: packageIdentity.toastActivatorClsid,
    mcpPort: instance.desktopMcpPort,
    updateManifestUrl: `http://${instance.webHost}:${instance.webPort}/downloads/${instance.instanceId}-windows-latest.json`,
    updatePublicKeyPem,
  };
}

function snapshotWithCanonicalPreviewConfig(installedContent, canonicalConfigBytes) {
  validateReleaseContentSnapshot(installedContent, "RUNNER_INSTALLED_CONTENT");
  assert.ok(Buffer.isBuffer(canonicalConfigBytes), "RUNNER_PACKAGED_PREVIEW_CONFIG_INVALID");
  const previewEntries = installedContent.files.filter(
    (entry) => entry.path === "preview-instance.json",
  );
  assert.equal(previewEntries.length, 1, "RUNNER_INSTALLED_PREVIEW_CONFIG_COUNT_INVALID");
  const files = installedContent.files
    .map((entry) =>
      entry.path === "preview-instance.json"
        ? {
            path: entry.path,
            bytes: canonicalConfigBytes.length,
            sha256: sha256(canonicalConfigBytes),
          }
        : { ...entry },
    )
    .sort((left, right) => {
      if (left.path < right.path) return -1;
      if (left.path > right.path) return 1;
      return 0;
    });
  const snapshot = {
    algorithm: "sha256",
    digest: sha256(Buffer.from(JSON.stringify(files))),
    files,
  };
  return validateReleaseContentSnapshot(snapshot, "RUNNER_EXPECTED_INSTALLER_CONTENT");
}

export function expectedPublishedInstallerContent(scope, installedContent) {
  assert.ok(scope && typeof scope === "object" && !Array.isArray(scope), "RUNNER_SCOPE_INVALID");
  assert.ok(
    typeof scope.previewConfigPath === "string" && path.isAbsolute(scope.previewConfigPath),
    "RUNNER_PREVIEW_CONFIG_PATH_INVALID",
  );
  const installedConfigBytes = fs.readFileSync(scope.previewConfigPath);
  assert.equal(
    installedConfigBytes.length,
    scope.previewConfigProvenance?.bytes,
    "RUNNER_INSTALLED_PREVIEW_CONFIG_SIZE_CHANGED",
  );
  assert.equal(
    sha256(installedConfigBytes),
    scope.previewConfigProvenance?.sha256,
    "RUNNER_INSTALLED_PREVIEW_CONFIG_SHA256_CHANGED",
  );
  const installedConfig = JSON.parse(installedConfigBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const { normalizedPreview } = normalizePreviewPackageConfigIdentity(
    installedConfig,
    scope.instance.instanceId,
  );
  assert.deepEqual(
    normalizedPreview,
    scope.preview,
    "RUNNER_INSTALLED_PREVIEW_CONFIG_SCOPE_MISMATCH",
  );
  const canonicalConfig = canonicalPackagedPreviewConfig(
    scope.instance,
    scope.preview.updatePublicKeyPem,
  );
  assert.deepEqual(
    normalizedPreview,
    canonicalConfig,
    "RUNNER_INSTALLED_PREVIEW_CONFIG_SEMANTIC_MISMATCH",
  );
  const canonicalConfigBytes = Buffer.from(`${JSON.stringify(canonicalConfig, null, 2)}\n`);
  const installedPreviewEntry = installedContent.files.find(
    (entry) => entry.path === "preview-instance.json",
  );
  assert.ok(installedPreviewEntry, "RUNNER_INSTALLED_PREVIEW_CONFIG_MISSING");
  assert.equal(
    installedPreviewEntry.bytes,
    installedConfigBytes.length,
    "RUNNER_INSTALLED_PREVIEW_CONFIG_SNAPSHOT_SIZE_MISMATCH",
  );
  assert.equal(
    installedPreviewEntry.sha256,
    sha256(installedConfigBytes),
    "RUNNER_INSTALLED_PREVIEW_CONFIG_SNAPSHOT_SHA256_MISMATCH",
  );
  return {
    expectedInstallerContent: snapshotWithCanonicalPreviewConfig(
      installedContent,
      canonicalConfigBytes,
    ),
    previewConfig: {
      policy: "preserve-existing-installation",
      installed: {
        bytes: installedConfigBytes.length,
        sha256: sha256(installedConfigBytes),
      },
      packaged: {
        bytes: canonicalConfigBytes.length,
        sha256: sha256(canonicalConfigBytes),
      },
      bytesEqual: installedConfigBytes.equals(canonicalConfigBytes),
      installedBytesMatchedStaticScope: true,
      normalizedConfigMatchedCanonicalPackage: true,
    },
  };
}

function assertExactFields(value, fields, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}_INVALID`);
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), `${label}_FIELDS_INVALID`);
}

export function assertReleaseAttestation(release, publicKeyPem) {
  assertExactFields(
    release,
    [
      "attestationSignature",
      "build",
      "instanceId",
      "packageContent",
      "packageIdentity",
      "preload",
      "releaseId",
      "schemaVersion",
      "sourceCommit",
      "sourceDirty",
      "version",
    ],
    "RELEASE",
  );
  assertExactFields(
    release.packageIdentity,
    [
      "appUserModelId",
      "displayName",
      "executableBaseName",
      "installDirectoryName",
      "instanceId",
      "protocolScheme",
      "shortcutName",
      "toastActivatorClsid",
      "uninstallRegistryKey",
    ],
    "RELEASE_IDENTITY",
  );
  assertExactFields(release.preload, ["bytes", "modules", "sha256"], "RELEASE_PRELOAD");
  assert.ok(
    Number.isSafeInteger(release.preload.bytes) && release.preload.bytes > 0,
    "RELEASE_PRELOAD_BYTES_INVALID",
  );
  assert.match(release.preload.sha256, SHA256, "RELEASE_PRELOAD_SHA256_INVALID");
  assert.ok(
    Array.isArray(release.preload.modules) &&
      release.preload.modules.length > 0 &&
      release.preload.modules.length <= 64 &&
      release.preload.modules.every((item) => typeof item === "string" && item.length <= 128),
    "RELEASE_PRELOAD_MODULES_INVALID",
  );
  assertExactFields(release.build, ["artifacts", "producer", "toolchain"], "RELEASE_BUILD");
  assert.equal(release.build.producer, "package-preview.mjs", "RELEASE_PRODUCER_INVALID");
  assertExactFields(release.build.artifacts, ["desktop", "web"], "RELEASE_ARTIFACTS");
  validateReleaseContentSnapshot(release.build.artifacts.desktop, "RELEASE_DESKTOP_CONTENT");
  validateReleaseContentSnapshot(release.build.artifacts.web, "RELEASE_WEB_CONTENT");
  const toolchain = assertPinnedPackageToolchainProvenance(release.build.toolchain, sourceRoot);
  validateReleaseContentSnapshot(release.packageContent, "RELEASE_PACKAGE_CONTENT");
  assert.match(release.attestationSignature, ED25519_SIGNATURE, "RELEASE_SIGNATURE_INVALID");
  const signatureBytes = Buffer.from(release.attestationSignature, "base64");
  assert.equal(signatureBytes.length, 64, "RELEASE_SIGNATURE_BYTES_INVALID");
  assert.equal(
    signatureBytes.toString("base64"),
    release.attestationSignature,
    "RELEASE_SIGNATURE_ENCODING_INVALID",
  );
  assert.equal(typeof publicKeyPem, "string", "RELEASE_PUBLIC_KEY_INVALID");
  const publicKey = createPublicKey(publicKeyPem);
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "RELEASE_PUBLIC_KEY_TYPE_INVALID");
  assert.equal(
    verify(null, serializeReleaseAttestation(release), publicKey, signatureBytes),
    true,
    "RELEASE_ATTESTATION_INVALID",
  );
  return {
    algorithm: "Ed25519",
    attestationValid: true,
    signatureBytes: signatureBytes.length,
    publicKeySha256: sha256(publicKey.export({ type: "spki", format: "der" })),
    toolchain: {
      pinSha256: toolchain.pin.sha256,
      nodeSha256: toolchain.node.sha256,
      nodeModulesDigest: toolchain.nodeModules.digest,
      electronZipSha256: toolchain.electron.zipSha256,
      nsisDigest: toolchain.nsis.digest,
      windowsPowerShellSha256: toolchain.windowsPowerShell.sha256,
      moveFileWriteThroughSha256: toolchain.moveFileWriteThrough.sha256,
    },
  };
}

export function assertExpectedRelease(release, expectedReleaseId, expectedVersion, label) {
  assert.ok(release && typeof release === "object" && !Array.isArray(release), `${label}_INVALID`);
  assert.match(expectedReleaseId, RELEASE_ID, `${label}_EXPECTED_RELEASE_ID_INVALID`);
  assert.match(
    expectedVersion,
    /^0\.2\.0-preview\.[1-9]\d*$/u,
    `${label}_EXPECTED_VERSION_INVALID`,
  );
  assert.equal(release.releaseId, expectedReleaseId, `${label}_RELEASE_ID_MISMATCH`);
  assert.equal(release.version, expectedVersion, `${label}_VERSION_MISMATCH`);
  return release;
}

function assertLoopbackUrl(value, port, label) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:", `${label}_HTTP_REQUIRED`);
  assert.equal(url.hostname, "127.0.0.1", `${label}_LOOPBACK_REQUIRED`);
  assert.equal(Number(url.port), port, `${label}_PORT_MISMATCH`);
  assert.equal(url.username, "", `${label}_CREDENTIAL_REFUSED`);
  assert.equal(url.password, "", `${label}_CREDENTIAL_REFUSED`);
  assert.ok(!BLOCKED_PORTS.has(port), `${label}_PRODUCTION_PORT_REFUSED`);
  return url;
}

export function validateStaticScope(
  instancePathInput,
  executablePathInput,
  expectedPublicKeySha256,
  expectedReleaseId,
  expectedVersion,
  env = process.env,
) {
  assert.equal(process.platform, "win32", "WINDOWS_INTERACTIVE_DESKTOP_REQUIRED");
  const instancePath = canonicalExisting(instancePathInput, "INSTANCE");
  const executablePath = canonicalExisting(executablePathInput, "EXE");
  const instance = readJson(instancePath);
  assert.equal(instance.schemaVersion, 1, "INSTANCE_SCHEMA_REFUSED");
  assert.ok(INSTANCE_ID.test(instance.instanceId), "PREVIEW_INSTANCE_ID_REQUIRED");
  const expectedPackageIdentity = derivePreviewPackageIdentity(instance.instanceId);
  const runtimeRoot = canonicalExisting(instance.runtimeRoot, "RUNTIME_ROOT");
  assert.equal(
    path.dirname(instancePath).toLowerCase(),
    runtimeRoot.toLowerCase(),
    "INSTANCE_ROOT_MISMATCH",
  );
  assertNoProductionOverlap(runtimeRoot, "RUNTIME_ROOT", env);
  assert.equal(
    canonicalExisting(instance.sourceRoot, "SOURCE_ROOT").toLowerCase(),
    canonicalExisting(sourceRoot, "RUNNER_SOURCE_ROOT").toLowerCase(),
    "INSTANCE_SOURCE_ROOT_MISMATCH",
  );
  for (const key of ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"]) {
    assert.ok(path.isAbsolute(instance[key]), `${key}_MUST_BE_ABSOLUTE`);
    assert.ok(containedBy(runtimeRoot, instance[key]), `${key}_OUTSIDE_RUNTIME`);
    assertNoProductionOverlap(instance[key], key, env);
  }
  assert.equal(instance.apiHost, "127.0.0.1", "API_LOOPBACK_REQUIRED");
  assert.equal(instance.webHost, "127.0.0.1", "WEB_LOOPBACK_REQUIRED");
  const ports = [instance.apiPort, instance.webPort, instance.mcpPort, instance.desktopMcpPort];
  assert.equal(new Set(ports).size, ports.length, "INSTANCE_PORTS_MUST_BE_DISTINCT");
  for (const port of ports) {
    assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, "INSTANCE_PORT_INVALID");
    assert.ok(!BLOCKED_PORTS.has(port), "PRODUCTION_PORT_REFUSED");
  }
  assert.equal(instance.cookieName, `${instance.instanceId}-session`, "COOKIE_SCOPE_MISMATCH");
  assert.equal(instance.releaseChannel, instance.instanceId, "RELEASE_CHANNEL_MISMATCH");
  assert.ok(UUID.test(instance.gmUserId), "GM_USER_ID_INVALID");
  for (const key of ["secretsFile", "peopleFile"]) {
    const selected = canonicalExisting(instance[key], key.toUpperCase());
    assert.ok(containedBy(runtimeRoot, selected), `${key}_OUTSIDE_RUNTIME`);
  }
  assert.equal(path.extname(executablePath).toLowerCase(), ".exe", "EXE_EXTENSION_REQUIRED");
  assertNoProductionOverlap(executablePath, "EXE", env);
  assert.equal(
    path.basename(executablePath).toLowerCase(),
    `${expectedPackageIdentity.executableBaseName}.exe`.toLowerCase(),
    "RELEASE_EXECUTABLE_IDENTITY_MISMATCH",
  );
  assert.equal(
    path.basename(path.dirname(executablePath)).toLowerCase(),
    expectedPackageIdentity.installDirectoryName.toLowerCase(),
    "EXE_INSTALL_DIRECTORY_IDENTITY_MISMATCH",
  );
  const installedRoot = path.dirname(executablePath);
  const asarPath = canonicalExisting(path.join(installedRoot, "resources", "app.asar"), "ASAR");
  const previewConfigPath = canonicalExisting(
    path.join(installedRoot, "preview-instance.json"),
    "PREVIEW_CONFIG",
  );
  const previewConfigBytes = fs.readFileSync(previewConfigPath);
  const preview = JSON.parse(previewConfigBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  assert.equal(preview.schemaVersion, 1, "PREVIEW_CONFIG_SCHEMA_REFUSED");
  assert.equal(preview.instanceId, instance.instanceId, "PREVIEW_INSTANCE_MISMATCH");
  assert.equal(preview.cookieName, instance.cookieName, "PREVIEW_COOKIE_MISMATCH");
  assert.equal(preview.mcpPort, instance.desktopMcpPort, "PREVIEW_MCP_PORT_MISMATCH");
  const { normalizedPreview } = normalizePreviewPackageConfigIdentity(preview, instance.instanceId);
  assertLoopbackUrl(preview.apiBaseUrl, instance.apiPort, "PREVIEW_API");
  const csrf = assertLoopbackUrl(preview.csrfOrigin, instance.webPort, "PREVIEW_CSRF");
  const manifest = assertLoopbackUrl(preview.updateManifestUrl, instance.webPort, "PREVIEW_UPDATE");
  assert.equal(manifest.origin, csrf.origin, "PREVIEW_UPDATE_ORIGIN_MISMATCH");
  assert.equal(
    manifest.pathname,
    `/downloads/${instance.instanceId}-windows-latest.json`,
    "PREVIEW_UPDATE_CHANNEL_MISMATCH",
  );
  assert.equal(manifest.search, "", "PREVIEW_UPDATE_QUERY_REFUSED");
  assert.equal(manifest.hash, "", "PREVIEW_UPDATE_FRAGMENT_REFUSED");
  assert.ok(
    containedBy(instance.desktopRoot, preview.profileDirectory),
    "PREVIEW_PROFILE_OUTSIDE_DESKTOP_ROOT",
  );
  assert.ok(
    preview.updatePublicKeyPem?.startsWith("-----BEGIN PUBLIC KEY-----"),
    "PREVIEW_KEY_INVALID",
  );
  const runtimePublicKeyPath = canonicalExisting(
    path.join(runtimeRoot, "desktop-signing", "public.pem"),
    "RUNTIME_UPDATE_PUBLIC_KEY",
  );
  const runtimePublicKeyPem = fs.readFileSync(runtimePublicKeyPath, "utf8");
  assert.equal(
    normalizedPreview.updatePublicKeyPem,
    runtimePublicKeyPem,
    "RUNTIME_PREVIEW_PUBLIC_KEY_MISMATCH",
  );
  const releaseBytes = asar.extractFile(asarPath, "release.json");
  assert.ok(
    releaseBytes.length > 0 && releaseBytes.length <= 1024 * 1024,
    "RELEASE_JSON_SIZE_INVALID",
  );
  const release = JSON.parse(releaseBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const releaseAttestation = assertReleaseAttestation(release, runtimePublicKeyPem);
  const windowsPublicationToolchain = verifyPinnedWindowsPublicationToolchain({
    sourceRoot,
    provenance: release.build.toolchain,
  });
  assert.equal(
    releaseAttestation.publicKeySha256,
    expectedPublicKeySha256,
    "EXPLICIT_PUBLIC_KEY_PIN_MISMATCH",
  );
  assert.equal(release.schemaVersion, 1, "RELEASE_SCHEMA_REFUSED");
  assert.match(release.releaseId, RELEASE_ID, "RELEASE_ID_INVALID");
  assert.match(release.version, /^0\.2\.0-preview\.[1-9]\d*$/u, "RELEASE_VERSION_INVALID");
  assertExpectedRelease(release, expectedReleaseId, expectedVersion, "INSTALLED_RELEASE");
  assert.match(release.sourceCommit, SOURCE_COMMIT, "RELEASE_SOURCE_COMMIT_INVALID");
  assert.equal(release.sourceDirty, false, "RELEASE_DIRTY_SOURCE_REFUSED");
  assert.equal(release.instanceId, instance.instanceId, "RELEASE_INSTANCE_MISMATCH");
  assert.deepEqual(release.packageIdentity, expectedPackageIdentity, "RELEASE_IDENTITY_MISMATCH");
  assert.equal(
    expectedPackageIdentity.executableBaseName,
    path.basename(executablePath, path.extname(executablePath)),
    "RELEASE_EXECUTABLE_IDENTITY_MISMATCH",
  );
  assert.equal(release.build?.producer, "package-preview.mjs", "RELEASE_PRODUCER_INVALID");
  const packageContent = assertReleaseContentBinding(
    release.packageContent,
    snapshotReleasePackageAsar(asarPath),
    "INSTALLED_PACKAGE_CONTENT",
  );
  const desktopArtifacts = assertReleaseContentBinding(
    release.build?.artifacts?.desktop,
    snapshotReleaseAsarDirectory(asarPath, "dist"),
    "INSTALLED_DESKTOP_CONTENT",
  );
  const webArtifacts = assertReleaseContentBinding(
    release.build?.artifacts?.web,
    snapshotReleaseAsarDirectory(asarPath, "web"),
    "INSTALLED_WEB_CONTENT",
  );
  const preloadArtifact = desktopArtifacts.files.find((file) => file.path === "preload.cjs");
  assert.ok(preloadArtifact, "RELEASE_PRELOAD_ARTIFACT_MISSING");
  assert.equal(release.preload?.bytes, preloadArtifact.bytes, "RELEASE_PRELOAD_BYTES_MISMATCH");
  assert.equal(release.preload?.sha256, preloadArtifact.sha256, "RELEASE_PRELOAD_SHA256_MISMATCH");
  const packageJsonBytes = asar.extractFile(asarPath, "package.json");
  assert.ok(
    packageJsonBytes.length > 0 && packageJsonBytes.length <= 64 * 1024,
    "RELEASE_PACKAGE_JSON_SIZE_INVALID",
  );
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  assert.deepEqual(
    packageJson,
    {
      name: `qa-hub-project-preview-${instance.instanceId.slice("qa-hub-preview-".length)}`,
      version: release.version,
      type: "module",
      main: "dist/main.js",
      productName: expectedPackageIdentity.displayName,
      private: true,
    },
    "RELEASE_PACKAGE_JSON_INVALID",
  );
  const sourceAttribution = gitSourceAttributionState();
  assert.equal(
    sourceAttribution.head,
    release.sourceCommit,
    "INSTALLED_RELEASE_SOURCE_HEAD_MISMATCH",
  );
  assert.deepEqual(sourceAttribution.trackedChanges, [], "LIVE_RUNNER_TRACKED_SOURCE_DIRTY");
  assert.deepEqual(sourceAttribution.unexpectedUntracked, [], "LIVE_RUNNER_UNTRACKED_SOURCE_DIRTY");
  const releaseProvenance = {
    schemaVersion: release.schemaVersion,
    releaseId: release.releaseId,
    version: release.version,
    sourceCommit: release.sourceCommit,
    sourceDirty: release.sourceDirty,
    releaseJsonBytes: releaseBytes.length,
    releaseJsonSha256: sha256(releaseBytes),
    appAsarBytes: fs.statSync(asarPath).size,
    appAsarSha256: fileSha256(asarPath),
    releaseAttestation,
    explicitPublicKeyPin: {
      basis: "operator-supplied-before-upgrade",
      format: "spki-der",
      algorithm: "sha256",
      expected: expectedPublicKeySha256,
      installed: releaseAttestation.publicKeySha256,
      matched: true,
    },
    packageContent: { files: packageContent.files.length, digest: packageContent.digest },
    desktop: { files: desktopArtifacts.files.length, digest: desktopArtifacts.digest },
    web: { files: webArtifacts.files.length, digest: webArtifacts.digest },
  };
  return {
    instancePath,
    executablePath,
    installedRoot,
    asarPath,
    previewConfigPath,
    previewConfigProvenance: {
      bytes: previewConfigBytes.length,
      sha256: sha256(previewConfigBytes),
    },
    runtimePublicKeyPath,
    instance,
    preview: normalizedPreview,
    release,
    releaseProvenance,
    windowsPowerShellPath: windowsPublicationToolchain.windowsPowerShellPath,
    moveFileWriteThroughPath: windowsPublicationToolchain.moveFileWriteThroughPath,
    sourceAttribution,
    runtimeRoot,
    apiOrigin: `http://127.0.0.1:${instance.apiPort}`,
    manifestUrl: manifest,
  };
}

export async function validatePublishedRelease(
  scope,
  expectedReleaseId,
  expectedVersion,
  fetchImpl = globalThis.fetch,
  installerPayloadVerifier = verifyPreviewInstallerPayload,
) {
  const manifestBytes = await fetchReleaseBytes(
    scope.manifestUrl,
    64 * 1024,
    "RUNNER_SERVED_MANIFEST",
    fetchImpl,
  );
  const manifest = assertSignedUpdateManifest(
    JSON.parse(manifestBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    scope.preview.updatePublicKeyPem,
    "RUNNER_SERVED_MANIFEST",
  );
  assertExpectedRelease(manifest, expectedReleaseId, expectedVersion, "RUNNER_FEED");
  assert.equal(manifest.releaseId, scope.release.releaseId, "RUNNER_INSTALLED_RELEASE_ID_MISMATCH");
  assert.equal(manifest.version, scope.release.version, "RUNNER_INSTALLED_VERSION_MISMATCH");
  const expectedInstallerName = `${scope.instance.instanceId}-windows-${expectedVersion}-${expectedReleaseId}.exe`;
  assert.equal(
    manifest.archive.url,
    `/downloads/${expectedInstallerName}`,
    "RUNNER_FEED_INSTALLER_URL_MISMATCH",
  );

  const downloadsRoot = canonicalExisting(scope.instance.downloadsRoot, "DOWNLOADS_ROOT");
  assert.ok(containedBy(scope.runtimeRoot, downloadsRoot), "DOWNLOADS_ROOT_OUTSIDE_RUNTIME");
  assertNoProductionOverlap(downloadsRoot, "DOWNLOADS_ROOT");
  const manifestPath = canonicalExisting(
    path.join(downloadsRoot, `${scope.instance.instanceId}-windows-latest.json`),
    "PUBLISHED_MANIFEST",
  );
  assert.ok(containedBy(downloadsRoot, manifestPath), "PUBLISHED_MANIFEST_OUTSIDE_DOWNLOADS");
  const localManifestBytes = fs.readFileSync(manifestPath);
  assert.ok(localManifestBytes.equals(manifestBytes), "RUNNER_SERVED_MANIFEST_BYTES_MISMATCH");

  const installerPath = canonicalExisting(
    path.join(downloadsRoot, expectedInstallerName),
    "PUBLISHED_INSTALLER",
  );
  assert.ok(containedBy(downloadsRoot, installerPath), "PUBLISHED_INSTALLER_OUTSIDE_DOWNLOADS");
  const localInstallerBytes = fs.readFileSync(installerPath);
  assert.equal(localInstallerBytes.length, manifest.archive.size, "RUNNER_INSTALLER_SIZE_MISMATCH");
  assert.equal(
    fileSha256(installerPath),
    manifest.archive.sha256,
    "RUNNER_INSTALLER_SHA256_MISMATCH",
  );
  const installerUrl = new URL(manifest.archive.url, scope.manifestUrl);
  assert.equal(installerUrl.origin, scope.manifestUrl.origin, "RUNNER_INSTALLER_ORIGIN_MISMATCH");
  const servedInstallerBytes = await fetchReleaseBytes(
    installerUrl,
    manifest.archive.size,
    "RUNNER_SERVED_INSTALLER",
    fetchImpl,
  );
  assert.ok(
    servedInstallerBytes.equals(localInstallerBytes),
    "RUNNER_SERVED_INSTALLER_BYTES_MISMATCH",
  );
  assert.equal(
    sha256(servedInstallerBytes),
    manifest.archive.sha256,
    "RUNNER_SERVED_INSTALLER_SHA256_MISMATCH",
  );

  const installedContent = snapshotInstalledPreviewDirectory(scope.installedRoot);
  const installerExpectation = expectedPublishedInstallerContent(scope, installedContent);
  const extractedInstallerContent = installerPayloadVerifier(
    servedInstallerBytes,
    installerExpectation.expectedInstallerContent,
    scope.runtimeRoot,
    "RUNNER_INSTALLER_INSTALLED_CONTENT",
  );
  return {
    releaseId: manifest.releaseId,
    version: manifest.version,
    sourceCommit: scope.release.sourceCommit,
    manifestUrl: scope.manifestUrl.href,
    manifestPath,
    manifestBytes: manifestBytes.length,
    manifestSha256: sha256(manifestBytes),
    installerUrl: installerUrl.href,
    installerPath,
    installerBytes: servedInstallerBytes.length,
    installerSha256: sha256(servedInstallerBytes),
    installedContent,
    extractedInstallerContent,
    previewConfig: installerExpectation.previewConfig,
  };
}

export function redactEvidence(value, knownSecrets = new Set()) {
  if (typeof value === "string") {
    let result = value.replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]");
    result = result.replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,
      "[REDACTED_JWT]",
    );
    for (const secret of knownSecrets)
      if (secret.length >= 4) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, knownSecrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /authorization|cookie|password|secret|token|csrf|joinCode|initializationLink/iu.test(key)
        ? "[REDACTED]"
        : redactEvidence(item, knownSecrets),
    ]),
  );
}

export function classifyBugDetailRequest(entry, bugId) {
  let parsed;
  try {
    parsed = new URL(entry.url);
  } catch {
    return null;
  }
  if (entry.method !== "GET" || parsed.pathname !== `/api/v1/bugs/${bugId}` || parsed.search)
    return null;
  const headers = Object.fromEntries(
    Object.entries(entry.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return { projectId: headers["x-qa-project-id"] ?? null, requestId: entry.requestId ?? null };
}

export function notificationProjectKey(compactRunId, suffix) {
  assert.match(compactRunId, /^[0-9a-f]{32}$/iu, "RUN_ID_INVALID");
  assert.match(suffix, /^[AB]$/u, "PROJECT_SUFFIX_INVALID");
  return `N${compactRunId.slice(0, 10).toUpperCase()}${suffix}`;
}

export function expectedBugKey(projectKey, ordinal) {
  assert.match(projectKey, /^[A-Z][A-Z0-9]{1,15}$/u, "PROJECT_KEY_INVALID");
  assert.ok(Number.isSafeInteger(ordinal) && ordinal > 0, "BUG_ORDINAL_INVALID");
  return `${projectKey}-${ordinal}`;
}

function wpnEventsWithinBoundary(boundary, snapshot, appUserModelId) {
  assert.ok(Number.isSafeInteger(boundary?.newestRecordId), "WPN_BOUNDARY_RECORD_INVALID");
  const boundaryAt = Date.parse(boundary?.capturedAt);
  const queriedAt = Date.parse(snapshot?.queriedAt);
  assert.ok(Number.isFinite(boundaryAt), "WPN_BOUNDARY_TIME_INVALID");
  assert.ok(Number.isFinite(queriedAt) && queriedAt >= boundaryAt, "WPN_QUERY_TIME_INVALID");
  assert.ok(typeof appUserModelId === "string" && appUserModelId.length > 0, "WPN_AUMID_REQUIRED");
  return (snapshot.events ?? []).filter((event) => {
    const eventAt = Date.parse(event.timeCreated);
    return (
      event.appUserModelId === appUserModelId &&
      Number.isSafeInteger(event.recordId) &&
      event.recordId > boundary.newestRecordId &&
      Number.isFinite(eventAt) &&
      eventAt >= boundaryAt &&
      eventAt <= queriedAt
    );
  });
}

export function correlateWpnToastEvents(boundary, snapshot, appUserModelId) {
  const events = wpnEventsWithinBoundary(boundary, snapshot, appUserModelId);
  const accepted = events.filter(
    (event) => event.eventId === 2418 && event.notificationType === "toast",
  );
  if (accepted.length === 0) return null;
  assert.equal(accepted.length, 1, "WPN_EVENT_CORRELATION_AMBIGUOUS");
  const trackingId = String(accepted[0].trackingId ?? "");
  assert.ok(trackingId.length > 0, "WPN_TRACKING_ID_MISSING");
  const delivered = events.filter(
    (event) => event.eventId === 3052 && String(event.trackingId ?? "") === trackingId,
  );
  const presented = events.filter(
    (event) => event.eventId === 3153 && String(event.trackingId ?? "") === trackingId,
  );
  if (delivered.length === 0 || presented.length === 0) return null;
  assert.equal(delivered.length, 1, "WPN_DELIVERY_EVENT_AMBIGUOUS");
  assert.equal(presented.length, 1, "WPN_PRESENTATION_EVENT_AMBIGUOUS");
  const destinationSessionId = Number(delivered[0].sessionId);
  assert.ok(Number.isSafeInteger(destinationSessionId), "WPN_DESTINATION_SESSION_INVALID");
  assert.equal(Number(presented[0].sessionId), destinationSessionId, "WPN_SESSION_CHAIN_MISMATCH");
  const messageId = String(delivered[0].messageId ?? "");
  assert.ok(messageId.length > 0, "WPN_MESSAGE_ID_MISSING");
  assert.equal(String(presented[0].messageId ?? ""), messageId, "WPN_MESSAGE_CHAIN_MISMATCH");
  assert.ok(
    accepted[0].recordId < delivered[0].recordId && delivered[0].recordId < presented[0].recordId,
    "WPN_RECORD_CHAIN_ORDER_INVALID",
  );
  const eventTimes = [accepted[0], delivered[0], presented[0]].map((event) =>
    Date.parse(event.timeCreated),
  );
  assert.ok(eventTimes.every(Number.isFinite), "WPN_EVENT_TIME_INVALID");
  assert.ok(
    eventTimes[0] <= eventTimes[1] && eventTimes[1] <= eventTimes[2],
    "WPN_TIME_CHAIN_ORDER_INVALID",
  );
  return {
    appUserModelId,
    trackingId,
    messageId,
    destinationSessionId,
    boundary: { capturedAt: boundary.capturedAt, newestRecordId: boundary.newestRecordId },
    queriedAt: snapshot.queriedAt,
    events: [accepted[0], delivered[0], presented[0]],
  };
}

export function assertToastSessionMatch(correlation, watcherReady) {
  const destinationSessionId = Number(correlation?.destinationSessionId);
  const appSessionId = Number(watcherReady?.appSessionId);
  const observerSessionId = Number(watcherReady?.observerSessionId);
  if (
    !Number.isSafeInteger(destinationSessionId) ||
    !Number.isSafeInteger(appSessionId) ||
    !Number.isSafeInteger(observerSessionId) ||
    destinationSessionId !== appSessionId ||
    destinationSessionId !== observerSessionId
  ) {
    const error = new Error("WINDOWS_TOAST_SESSION_MISMATCH");
    error.code = "WINDOWS_TOAST_SESSION_MISMATCH";
    error.classification = "environment_blocker";
    error.details = { destinationSessionId, appSessionId, observerSessionId };
    throw error;
  }
  return true;
}

export function exactNotificationHistoryV2Entry(history, expectedEntry) {
  assert.equal(history?.schemaVersion, 2, "NOTIFICATION_HISTORY_SCHEMA_V2_REQUIRED");
  assert.ok(Array.isArray(history?.entries), "NOTIFICATION_HISTORY_ENTRIES_REQUIRED");
  const matches = history.entries.filter(
    (entry) => entry?.notificationId === expectedEntry.notificationId,
  );
  assert.equal(matches.length, 1, "NOTIFICATION_HISTORY_ENTRY_COUNT_MISMATCH");
  assert.deepEqual(matches[0], expectedEntry, "NOTIFICATION_HISTORY_ROUTE_MISMATCH");
  return matches[0];
}

export function liveRequestAccept(pathname) {
  const parsed = new URL(pathname, "http://local.invalid");
  return parsed.pathname === "/api/v1/notifications"
    ? "application/json"
    : "application/vnd.relay-qa-hub.v1.1+json";
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
}

async function freePort(forbidden) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    if (!forbidden.has(port) && port >= 1024) return port;
  }
  throw new Error("FREE_LOOPBACK_PORT_UNAVAILABLE");
}

async function allocatePorts(instance) {
  const forbidden = new Set([
    ...BLOCKED_PORTS,
    instance.apiPort,
    instance.webPort,
    instance.mcpPort,
    instance.desktopMcpPort,
  ]);
  const result = {};
  for (const key of ["mcp", "cdp", "inspector"]) {
    result[key] = await freePort(forbidden);
    forbidden.add(result[key]);
  }
  return result;
}

export const HOST_SNAPSHOT_PS = String.raw`
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class QaHubWtsNative {
  public sealed class WtsSession {
    public int SessionId { get; set; }
    public string StationName { get; set; }
    public int State { get; set; }
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct WTS_SESSION_INFO {
    public int SessionId;
    public IntPtr StationName;
    public int State;
  }
  [DllImport("wtsapi32.dll", EntryPoint="WTSEnumerateSessionsW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
  [DllImport("wtsapi32.dll")]
  private static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();
  public static WtsSession[] EnumerateSessions() {
    IntPtr buffer = IntPtr.Zero;
    int count = 0;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out buffer, out count)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var result = new List<WtsSession>();
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      for (int index = 0; index < count; index++) {
        var row = (WTS_SESSION_INFO)Marshal.PtrToStructure(IntPtr.Add(buffer, index * size), typeof(WTS_SESSION_INFO));
        result.Add(new WtsSession {
          SessionId = row.SessionId,
          StationName = row.StationName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(row.StationName),
          State = row.State
        });
      }
      return result.ToArray();
    } finally {
      if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
    }
  }
}
"@
$inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding utf8 | ConvertFrom-Json
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'RelayQaHub*.exe' } | ForEach-Object {
  $created = try { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') } catch { [string]$_.CreationDate }
  [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; sessionId=[int]$_.SessionId; name=[string]$_.Name; path=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine; startedAt=$created }
})
$desktopProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('explorer.exe','ShellExperienceHost.exe') } | ForEach-Object {
  [pscustomobject]@{ pid=[int]$_.ProcessId; sessionId=[int]$_.SessionId; name=[string]$_.Name }
})
$wtsSessions = @([QaHubWtsNative]::EnumerateSessions() | Sort-Object SessionId | ForEach-Object {
  [pscustomobject]@{ sessionId=[int]$_.SessionId; stationName=[string]$_.StationName; state=[int]$_.State }
})
$activeConsoleRaw = [QaHubWtsNative]::WTSGetActiveConsoleSessionId()
$activeConsoleSessionId = if ($activeConsoleRaw -eq [uint32]::MaxValue) { $null } else { [int]$activeConsoleRaw }
$listeners = @($inputData.ports | ForEach-Object {
  $port = [int]$_
  $rows = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if ($rows.Count -eq 0) { [pscustomobject]@{ port=$port; listening=$false } }
  else { $rows | ForEach-Object { [pscustomobject]@{ port=$port; listening=$true; address=[string]$_.LocalAddress; pid=[int]$_.OwningProcess } } }
})
[pscustomobject]@{
  capturedAt=[datetime]::UtcNow.ToString('o')
  sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
  sessionTopology=[pscustomobject]@{
    runnerSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
    activeConsoleSessionId=$activeConsoleSessionId
    wtsSessions=$wtsSessions
    explorer=@($desktopProcesses | Where-Object { $_.name -eq 'explorer.exe' })
    shellExperienceHost=@($desktopProcesses | Where-Object { $_.name -eq 'ShellExperienceHost.exe' })
  }
  processes=$processes
  listeners=$listeners
} | ConvertTo-Json -Depth 8 -Compress
`;

export const ATOMIC_EXCLUSIVE_JSON_PS = String.raw`
function WriteExclusiveJson($file, $value) {
  $target = [IO.Path]::GetFullPath([string]$file)
  $directory = [IO.Path]::GetDirectoryName($target)
  $leaf = [IO.Path]::GetFileName($target)
  $temporary = [IO.Path]::Combine($directory, [string]::Concat($leaf, '.tmp-', [Diagnostics.Process]::GetCurrentProcess().Id, '-', [guid]::NewGuid().ToString('N')))
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 8 -Compress))
  $temporaryCreated = $false
  $published = $false
  try {
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $temporaryCreated = $true
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    [IO.File]::Move($temporary, $target)
    $published = $true
  } finally {
    if ($temporaryCreated -and -not $published -and [IO.File]::Exists($temporary)) {
      [IO.File]::Delete($temporary)
    }
  }
}
`;

export const TOAST_UIA_PS = String.raw`
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class QaHubToastWtsNative {
  public sealed class WtsSession {
    public int SessionId { get; set; }
    public string StationName { get; set; }
    public int State { get; set; }
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct WTS_SESSION_INFO {
    public int SessionId;
    public IntPtr StationName;
    public int State;
  }
  [DllImport("wtsapi32.dll", EntryPoint="WTSEnumerateSessionsW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessions, out int count);
  [DllImport("wtsapi32.dll")]
  private static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();
  public static WtsSession[] EnumerateSessions() {
    IntPtr buffer = IntPtr.Zero;
    int count = 0;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out buffer, out count)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var result = new List<WtsSession>();
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      for (int index = 0; index < count; index++) {
        var row = (WTS_SESSION_INFO)Marshal.PtrToStructure(IntPtr.Add(buffer, index * size), typeof(WTS_SESSION_INFO));
        result.Add(new WtsSession {
          SessionId = row.SessionId,
          StationName = row.StationName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(row.StationName),
          State = row.State
        });
      }
      return result.ToArray();
    } finally {
      if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
    }
  }
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding utf8 | ConvertFrom-Json
$appRows = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$inputData.appPid))
if ($appRows.Count -ne 1) { throw 'TOAST_APP_PROCESS_NOT_FOUND' }
$desktopProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('explorer.exe','ShellExperienceHost.exe') } | ForEach-Object {
  [pscustomobject]@{ pid=[int]$_.ProcessId; sessionId=[int]$_.SessionId; name=[string]$_.Name }
})
$wtsSessions = @([QaHubToastWtsNative]::EnumerateSessions() | Sort-Object SessionId | ForEach-Object {
  [pscustomobject]@{ sessionId=[int]$_.SessionId; stationName=[string]$_.StationName; state=[int]$_.State }
})
$activeConsoleRaw = [QaHubToastWtsNative]::WTSGetActiveConsoleSessionId()
$activeConsoleSessionId = if ($activeConsoleRaw -eq [uint32]::MaxValue) { $null } else { [int]$activeConsoleRaw }
${ATOMIC_EXCLUSIVE_JSON_PS}
$ready = [ordered]@{
  schemaVersion=1
  ready=$true
  readyAt=[datetime]::UtcNow.ToString('o')
  observerPid=[Diagnostics.Process]::GetCurrentProcess().Id
  observerSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
  appPid=[int]$appRows[0].ProcessId
  appSessionId=[int]$appRows[0].SessionId
  activeConsoleSessionId=$activeConsoleSessionId
  wtsSessions=$wtsSessions
  explorer=@($desktopProcesses | Where-Object { $_.name -eq 'explorer.exe' })
  shellExperienceHost=@($desktopProcesses | Where-Object { $_.name -eq 'ShellExperienceHost.exe' })
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Ancestors($element) {
  $items = New-Object System.Collections.ArrayList
  $cursor = $element
  for ($i=0; $i -lt 16 -and $null -ne $cursor; $i++) { [void]$items.Add($cursor); $cursor=$walker.GetParent($cursor) }
  return $items
}
function Same($a,$b) { return [System.Windows.Automation.Automation]::Compare($a,$b) }
WriteExclusiveJson $inputData.readyPath $ready
$deadline = [datetime]::UtcNow.AddMilliseconds([int]$inputData.timeoutMs)
do {
  $titles = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$inputData.title))))
  $bodies = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$inputData.body))))
  $matches = @()
  foreach($title in $titles) { foreach($body in $bodies) {
    $ta = @(Ancestors $title); $ba = @(Ancestors $body); $common = $null
    foreach($left in $ta) { if (@($ba | Where-Object { Same $left $_ }).Count -gt 0) { $common=$left; break } }
    if ($null -eq $common) { continue }
    $invokeElement=$common; $pattern=$null
    for($i=0; $i -lt 10 -and $null -ne $invokeElement; $i++) {
      if($invokeElement.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){ break }
      $pattern=$null; $invokeElement=$walker.GetParent($invokeElement)
    }
    if($null -ne $pattern){ $matches += [pscustomobject]@{title=$title;body=$body;invoke=$invokeElement;pattern=$pattern} }
  }}
  if($matches.Count -eq 1){
    $match=$matches[0]
    $evidence=[ordered]@{ observedAt=[datetime]::UtcNow.ToString('o'); title=$match.title.Current.Name; body=$match.body.Current.Name; titleOffscreen=$match.title.Current.IsOffscreen; bodyOffscreen=$match.body.Current.IsOffscreen; invokeName=$match.invoke.Current.Name; invokeControlType=$match.invoke.Current.ControlType.ProgrammaticName; invoked=$false }
    WriteExclusiveJson $inputData.observedPath $evidence
    if($inputData.mode -eq 'observe-wait-invoke'){
      $signalDeadline=[datetime]::UtcNow.AddMilliseconds([int]$inputData.signalTimeoutMs)
      while(-not (Test-Path -LiteralPath $inputData.signalPath) -and [datetime]::UtcNow -lt $signalDeadline){ Start-Sleep -Milliseconds 50 }
      if(-not (Test-Path -LiteralPath $inputData.signalPath)){ throw 'TOAST_INVOKE_SIGNAL_TIMEOUT' }
      $match.pattern.Invoke(); $evidence.invoked=$true; $evidence.invokedAt=[datetime]::UtcNow.ToString('o')
    }
    $evidence | ConvertTo-Json -Compress
    exit 0
  }
  if($matches.Count -gt 1){ throw 'AMBIGUOUS_EXACT_TOAST' }
  Start-Sleep -Milliseconds 100
} while([datetime]::UtcNow -lt $deadline)
throw 'EXACT_TOAST_NOT_FOUND'
`;

export const WPN_EVENT_PS = String.raw`
param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding utf8 | ConvertFrom-Json
$logName = 'Microsoft-Windows-PushNotification-Platform/Operational'
if ($inputData.mode -eq 'boundary') {
  $latest = @(Get-WinEvent -LogName $logName -MaxEvents 1 -ErrorAction Stop)
  $newestRecordId = if ($latest.Count -eq 0) { 0 } else { [long]$latest[0].RecordId }
  [pscustomobject]@{ schemaVersion=1; capturedAt=[datetime]::UtcNow.ToString('o'); newestRecordId=$newestRecordId } | ConvertTo-Json -Compress
  exit 0
}
if ($inputData.mode -ne 'query') { throw 'WPN_MODE_REFUSED' }
$boundaryAt = [datetime]::Parse([string]$inputData.boundary.capturedAt).ToUniversalTime()
$rows = @(Get-WinEvent -FilterHashtable @{ LogName=$logName; StartTime=$boundaryAt.AddSeconds(-1) } -ErrorAction SilentlyContinue | Where-Object {
  [long]$_.RecordId -gt [long]$inputData.boundary.newestRecordId -and $_.Id -in @(2418,3052,3153)
} | ForEach-Object {
  $event = $_
  $xml = [xml]$event.ToXml()
  $fields = @{}
  foreach ($item in @($xml.Event.EventData.Data)) { $fields[[string]$item.Name] = [string]$item.'#text' }
  if ([StringComparer]::Ordinal.Equals([string]$fields['AppUserModelId'], [string]$inputData.appUserModelId)) {
    [pscustomobject]@{
      eventId=[int]$event.Id
      recordId=[long]$event.RecordId
      timeCreated=$event.TimeCreated.ToUniversalTime().ToString('o')
      providerProcessId=[int]$xml.Event.System.Execution.ProcessID
      appUserModelId=[string]$fields['AppUserModelId']
      notificationType=[string]$fields['NotificationType']
      trackingId=[string]$fields['TrackingId']
      sessionId=if ($null -eq $fields['SessionId'] -or [string]$fields['SessionId'] -eq '') { $null } else { [int]$fields['SessionId'] }
      messageId=[string]$fields['MessageId']
    }
  }
})
[pscustomobject]@{ schemaVersion=1; queriedAt=[datetime]::UtcNow.ToString('o'); events=@($rows | Sort-Object recordId) } | ConvertTo-Json -Depth 6 -Compress
`;

function sanitizeHostSnapshot(value, secrets) {
  return {
    capturedAt: value.capturedAt,
    sessionId: value.sessionId,
    processes: (value.processes ?? []).map((item) => ({
      pid: item.pid,
      parentPid: item.parentPid,
      sessionId: item.sessionId,
      name: item.name,
      path: item.path,
      startedAt: item.startedAt,
      commandLineSha256: sha256(String(item.commandLine ?? "")),
      commandLine: redactEvidence(
        String(item.commandLine ?? "").replace(/--[^ =]+(?:=|\s+)(?:"[^"]*"|\S+)/gu, (match) =>
          match.startsWith("--user-data-dir") ? match : match.split(/[=\s]/u)[0],
        ),
        secrets,
      ),
    })),
    sessionTopology: {
      runnerSessionId: value.sessionTopology?.runnerSessionId,
      activeConsoleSessionId: value.sessionTopology?.activeConsoleSessionId ?? null,
      wtsSessions: value.sessionTopology?.wtsSessions ?? [],
      explorer: value.sessionTopology?.explorer ?? [],
      shellExperienceHost: value.sessionTopology?.shellExperienceHost ?? [],
    },
    listeners: value.listeners ?? [],
  };
}

export function relayProcessFingerprint(snapshot) {
  return snapshot.processes
    .map(({ pid, parentPid, name, path: exe, startedAt, commandLineSha256 }) => ({
      pid,
      parentPid,
      name,
      path: exe,
      startedAt,
      commandLineSha256,
    }))
    .sort((a, b) => a.pid - b.pid);
}

function listenerFingerprint(snapshot, ownPorts) {
  return snapshot.listeners
    .filter((item) => !ownPorts.has(item.port))
    .map(({ port, listening, address = null, pid = null }) => ({
      port,
      listening,
      address,
      pid,
    }))
    .sort((a, b) => a.port - b.port || Number(a.pid ?? 0) - Number(b.pid ?? 0));
}

class CdpClient {
  constructor(socket, expectedPort) {
    this.socket = socket;
    this.expectedPort = expectedPort;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error)
          waiter.reject(new Error(`CDP_${message.error.code}_${message.error.message}`));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {});
    });
  }
  static async connect(url, expectedPort) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "ws:", "CDP_WS_REQUIRED");
    assert.equal(parsed.hostname, "127.0.0.1", "CDP_LOOPBACK_REQUIRED");
    assert.equal(Number(parsed.port), expectedPort, "CDP_PORT_MISMATCH");
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP_CONNECT_TIMEOUT")), TIMEOUT);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP_CONNECT_FAILED"));
        },
        { once: true },
      );
    });
    return new CdpClient(socket, expectedPort);
  }
  on(method, listener) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }
  call(method, params = {}, timeoutMs = TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP_TIMEOUT_${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(result.exceptionDetails, undefined, "CDP_EXPRESSION_FAILED");
    return result.result?.value;
  }
  close() {
    this.socket.close();
  }
}

function snapshotExpression() {
  return `(async()=>{const text=(document.body?.innerText??'').slice(0,12000);const runtime=await window.qaHubDesktop?.getRuntimeInfo?.();const connection=await window.qaHubDesktop?.getConnectionStatus?.();const project=document.querySelector('select[aria-label="切换项目"]');const alert=document.querySelector('div.banner.error-banner[role="alert"]');return {url:location.href,ready:!!document.querySelector('.app-shell'),login:!!document.querySelector('.auth-form'),projectId:project?.value??null,projects:[...(project?.options??[])].map(o=>({id:o.value,name:o.textContent?.trim()??''})),createOpen:!!document.querySelector('.create-modal'),draft:document.querySelector('.create-modal textarea')?.value??null,detailOpen:!!document.querySelector('.detail-modal'),detailKey:document.querySelector('.detail-key')?.textContent?.trim()??null,detailError:document.querySelector('.detail-load-error,.detail-inline-warning')?.textContent?.trim()??null,alert:alert?.textContent?.trim()??null,inaccessibleExact:alert?.textContent?.trim()===${JSON.stringify(INACCESSIBLE_TEXT)},bodyText:text,runtime,connection};})()`;
}

async function waitFor(client, predicate, label, timeoutMs = TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await client.evaluate(snapshotExpression());
    if (predicate(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}_TIMEOUT_${JSON.stringify(redactEvidence(value))}`);
}

function inputExpression(selector, value) {
  return `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!(input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement||input instanceof HTMLSelectElement))return false;const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')?.set?.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`;
}

async function rendererLogin(client, projectId, name) {
  await waitFor(client, (s) => s.login, "LOGIN_FORM");
  assert.equal(
    await client.evaluate(inputExpression("#login-project", projectId)),
    true,
    "PROJECT_INPUT_MISSING",
  );
  assert.equal(
    await client.evaluate(inputExpression("#login-name", name)),
    true,
    "NAME_INPUT_MISSING",
  );
  assert.equal(
    await client.evaluate(
      "(()=>{const f=document.querySelector('.auth-form');if(!(f instanceof HTMLFormElement))return false;f.requestSubmit();return true})()",
    ),
    true,
  );
  return waitFor(
    client,
    (s) => s.ready && s.projectId === projectId && s.connection?.state === "connected",
    "DESKTOP_LOGIN",
  );
}

async function switchProject(client, projectId) {
  assert.equal(
    await client.evaluate(inputExpression('select[aria-label="切换项目"]', projectId)),
    true,
    "PROJECT_SWITCH_MISSING",
  );
  return waitFor(client, (s) => s.ready && s.projectId === projectId, "PROJECT_SWITCH");
}

async function putDraft(client, value) {
  assert.equal(
    await client.evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent??'').includes('新建 Bug'));if(!b)return false;b.click();return true})()`,
    ),
    true,
    "CREATE_BUTTON_MISSING",
  );
  await waitFor(client, (s) => s.createOpen, "CREATE_MODAL");
  assert.equal(
    await client.evaluate(inputExpression(".create-modal textarea", value)),
    true,
    "DRAFT_INPUT_MISSING",
  );
  await delay(400);
  return waitFor(client, (s) => s.createOpen && s.draft === value, "DRAFT_WRITE");
}

async function closeDetail(client) {
  await client.evaluate(
    "(()=>{const b=document.querySelector('.detail-close');if(!b)return false;b.click();return true})()",
  );
  await waitFor(client, (s) => !s.detailOpen, "DETAIL_CLOSE");
}

async function signOut(client) {
  assert.equal(
    await client.evaluate(
      "(()=>{const b=document.querySelector('button.profile');if(!b)return false;b.click();return true})()",
    ),
    true,
    "SIGN_OUT_MISSING",
  );
  await waitFor(client, (s) => s.login, "SIGN_OUT");
}

function makeBugBody(projectId, targetId, description) {
  const submission = randomUUID();
  return {
    submission,
    body: {
      submissionContractVersion: "1.1.0",
      projectId,
      clientSubmissionId: submission,
      title: description,
      description,
      expectedBehavior: "点击通知后进入正确项目与精确 Bug 详情",
      severity: "S2",
      priority: "P2",
      ownerId: targetId,
      verificationOwnerId: targetId,
      occurrence: {
        observedAt: new Date().toISOString(),
        platform: "windows",
        steps: ["由独立 actor 创建并分配给目标员工"],
        actualBehavior: description,
      },
      attachmentIds: [],
    },
  };
}

function criticalFiles(scope) {
  return [
    scope.instancePath,
    scope.executablePath,
    scope.asarPath,
    scope.previewConfigPath,
    scope.runtimePublicKeyPath,
    scope.instance.secretsFile,
    scope.publishedRelease?.manifestPath,
    scope.publishedRelease?.installerPath,
    scope.windowsPowerShellPath,
    scope.moveFileWriteThroughPath,
  ]
    .filter(Boolean)
    .map((file) => ({ path: file, bytes: fs.statSync(file).size, sha256: fileSha256(file) }));
}

function reverifyWindowsPublicationToolchain(scope) {
  const verified = verifyPinnedWindowsPublicationToolchain({
    sourceRoot,
    provenance: scope.release.build.toolchain,
    windowsPowerShellExecutable: scope.windowsPowerShellPath,
    moveFileWriteThroughPath: scope.moveFileWriteThroughPath,
  });
  assert.equal(
    verified.windowsPowerShellPath,
    scope.windowsPowerShellPath,
    "LIVE_WINDOWS_POWERSHELL_PATH_CHANGED",
  );
  assert.equal(
    verified.moveFileWriteThroughPath,
    scope.moveFileWriteThroughPath,
    "LIVE_MOVE_FILE_WRITE_THROUGH_PATH_CHANGED",
  );
}

async function runLive(scope) {
  reverifyWindowsPublicationToolchain(scope);
  const criticalBefore = criticalFiles(scope);
  const runId = randomUUID();
  const compact = runId.replaceAll("-", "");
  const experiment = path.join(
    scope.runtimeRoot,
    "acceptance",
    "desktop-notification-project-route-live",
    runId,
  );
  const evidence = path.join(
    sourceRoot,
    "docs",
    "evidence",
    "project-components",
    "desktop-notification-project-route-live",
    runId,
  );
  assert.ok(!fs.existsSync(experiment) && !fs.existsSync(evidence), "RUN_DIRECTORY_EXISTS");
  fs.mkdirSync(path.join(experiment, "raw"), { recursive: true });
  fs.mkdirSync(path.join(evidence, "raw"), { recursive: true });
  const knownSecrets = new Set();
  const proof = {
    schemaVersion: 1,
    runId,
    startedAt: new Date().toISOString(),
    instanceId: scope.instance.instanceId,
    releaseProvenance: scope.releaseProvenance,
    passed: false,
    checks: [],
    fixtures: {},
    requests: [],
    processes: [],
    network: [],
    watchers: [],
    wpn: [],
    sessionPreflight: {
      environmentOnly: true,
      productPass: false,
      status: "pending",
    },
    guarantees: {
      productionRootsRejected: blockedRoots(),
      productionPortsRejected: [...BLOCKED_PORTS],
      foreignProcessesAreNeverSignaled: true,
      noForceKillFallback: true,
      fixturesAreRetained: true,
      installedCanonicalRunsDirectly: true,
      isolatedProfileAndPreviewConfig: true,
    },
  };
  const check = (label, actual, expected = true) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    proof.checks.push({
      label,
      passed,
      actual: redactEvidence(actual, knownSecrets),
      expected: redactEvidence(expected, knownSecrets),
      at: new Date().toISOString(),
    });
    assert.ok(passed, label);
  };
  const ports = await allocatePorts(scope.instance);
  proof.ports = ports;
  proof.inputFingerprints = criticalBefore;
  writeExclusive(path.join(experiment, "host-snapshot.ps1"), HOST_SNAPSHOT_PS);
  writeExclusive(path.join(experiment, "toast-uia.ps1"), TOAST_UIA_PS);
  writeExclusive(path.join(experiment, "wpn-events.ps1"), WPN_EVENT_PS);
  check("canonical inputs unchanged before preparation", criticalFiles(scope), criticalBefore);
  const configFor = (name) => {
    const profileDirectory = path.join(experiment, "profiles", scope.instance.instanceId, name);
    return {
      ...scope.preview,
      profileDirectory,
      mcpPort: ports.mcp,
      updateManifestUrl: `${new URL(scope.preview.csrfOrigin).origin}/downloads/${scope.instance.instanceId}-notification-route-${runId}-not-published.json`,
    };
  };
  const configs = {};
  for (const name of ["quit-probe", "route"]) {
    configs[name] = configFor(name);
    const file = path.join(experiment, `${name}-preview-instance.json`);
    configs[name].file = file;
    writeExclusive(
      file,
      Object.fromEntries(Object.entries(configs[name]).filter(([key]) => key !== "file")),
    );
  }
  const watchedPorts = [
    ...BLOCKED_PORTS,
    scope.instance.apiPort,
    scope.instance.webPort,
    scope.instance.mcpPort,
    scope.instance.desktopMcpPort,
    ports.mcp,
    ports.cdp,
    ports.inspector,
  ];
  const snapshotHost = async (phase) => {
    const input = path.join(experiment, `host-${phase}-input.json`);
    writeExclusive(input, { ports: watchedPorts });
    reverifyWindowsPublicationToolchain(scope);
    const { stdout } = await execFileAsync(
      scope.windowsPowerShellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(experiment, "host-snapshot.ps1"),
        "-InputPath",
        input,
      ],
      { windowsHide: true, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
    );
    const value = sanitizeHostSnapshot(JSON.parse(stdout), knownSecrets);
    writeExclusive(path.join(evidence, "raw", `host-${phase}.json`), value);
    return value;
  };
  let wpnQuerySequence = 0;
  const runWpnHelper = async (label, inputValue) => {
    const sequence = ++wpnQuerySequence;
    const input = path.join(
      experiment,
      `${label}-wpn-${String(sequence).padStart(3, "0")}-input.json`,
    );
    writeExclusive(input, inputValue);
    try {
      reverifyWindowsPublicationToolchain(scope);
      const { stdout } = await execFileAsync(
        scope.windowsPowerShellPath,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(experiment, "wpn-events.ps1"),
          "-InputPath",
          input,
        ],
        { windowsHide: true, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
      );
      return { sequence, value: JSON.parse(stdout) };
    } catch (error) {
      const failure = {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        label,
        mode: inputValue.mode,
        sequence,
        error: {
          name: error?.name ?? "Error",
          code: error?.code ?? null,
          message: redactEvidence(error?.message ?? String(error), knownSecrets),
        },
      };
      writeExclusive(
        path.join(
          evidence,
          "raw",
          `${label}-wpn-${inputValue.mode}-error-${String(sequence).padStart(3, "0")}.json`,
        ),
        failure,
      );
      throw error;
    }
  };
  const captureWpnBoundary = async (label) => {
    const { value: boundary } = await runWpnHelper(label, { mode: "boundary" });
    check(`${label} WPN boundary schema`, boundary.schemaVersion, 1);
    check(
      `${label} WPN boundary record valid`,
      Number.isSafeInteger(boundary.newestRecordId),
      true,
    );
    check(
      `${label} WPN boundary time valid`,
      Number.isFinite(Date.parse(boundary.capturedAt)),
      true,
    );
    writeExclusive(path.join(evidence, "raw", `${label}-wpn-boundary.json`), boundary);
    return boundary;
  };
  const waitForWpnCorrelation = async (label, boundary, watcherReady) => {
    const deadline = Date.now() + TIMEOUT;
    let attempts = 0;
    let lastSnapshot = null;
    let lastQueryError = null;
    do {
      attempts += 1;
      let query;
      try {
        query = await runWpnHelper(label, {
          mode: "query",
          boundary,
          appUserModelId: scope.preview.appUserModelId,
        });
      } catch (error) {
        lastQueryError = {
          name: error?.name ?? "Error",
          code: error?.code ?? null,
          message: redactEvidence(error?.message ?? String(error), knownSecrets),
        };
        await delay(200);
        continue;
      }
      const snapshot = query.value;
      lastSnapshot = snapshot;
      writeExclusive(
        path.join(
          evidence,
          "raw",
          `${label}-wpn-query-${String(query.sequence).padStart(3, "0")}.json`,
        ),
        snapshot,
      );
      const correlation = correlateWpnToastEvents(boundary, snapshot, scope.preview.appUserModelId);
      if (correlation) {
        const evidenceValue = { boundary, snapshot, correlation, watcherReady };
        writeExclusive(path.join(evidence, "raw", `${label}-wpn-events.json`), snapshot);
        writeExclusive(path.join(evidence, "raw", `${label}-wpn-correlation.json`), evidenceValue);
        proof.wpn.push({ label, ...correlation });
        assertToastSessionMatch(correlation, watcherReady);
        check(`${label} WPN AUMID`, correlation.appUserModelId, scope.preview.appUserModelId);
        check(
          `${label} WPN destination app session`,
          correlation.destinationSessionId,
          watcherReady.appSessionId,
        );
        check(
          `${label} WPN destination observer session`,
          correlation.destinationSessionId,
          watcherReady.observerSessionId,
        );
        return correlation;
      }
      await delay(200);
    } while (Date.now() < deadline);
    writeExclusive(path.join(evidence, "raw", `${label}-wpn-timeout.json`), {
      schemaVersion: 1,
      timedOutAt: new Date().toISOString(),
      boundary,
      attempts,
      lastSnapshot,
      lastQueryError,
    });
    throw new Error(`${label}_WPN_EVENT_CORRELATION_TIMEOUT`);
  };
  let hostBefore;
  let child = null;
  let mainInspector = null;
  let renderer = null;
  let processEvents = [];
  let activeLaunch = null;
  let nativeSessionPreflightPassed = false;
  const sessionProbeSlot = `__qaHubNotificationSessionProbe_${compact}`;
  const launch = async (phase, config) => {
    check(
      `${phase} canonical inputs unchanged before launch`,
      criticalFiles(scope),
      criticalBefore,
    );
    const stdoutFile = path.join(experiment, `${phase}-stdout.ndjson`);
    const stderrFile = path.join(experiment, `${phase}-stderr.txt`);
    const stdout = fs.createWriteStream(stdoutFile, { flags: "wx" });
    const stderr = fs.createWriteStream(stderrFile, { flags: "wx" });
    processEvents = [];
    let pendingLine = "";
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^QA_HUB_|^NODE_OPTIONS$|^ELECTRON_|PROXY$|^NODE_EXTRA_CA_CERTS$/iu.test(key),
      ),
    );
    env.QA_HUB_PREVIEW_DESKTOP_CONFIG = config.file;
    child = spawn(
      scope.executablePath,
      [
        `--inspect=${ports.inspector}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${ports.cdp}`,
        `--user-data-dir=${config.profileDirectory}`,
        "--hidden",
      ],
      { cwd: scope.installedRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    activeLaunch = { phase, config, pid: child.pid };
    child.stdout.on("data", (chunk) => {
      const safe = redactEvidence(String(chunk), knownSecrets);
      stdout.write(safe);
      pendingLine += safe;
      for (;;) {
        const end = pendingLine.indexOf("\n");
        if (end < 0) break;
        const line = pendingLine.slice(0, end);
        pendingLine = pendingLine.slice(end + 1);
        try {
          processEvents.push(JSON.parse(line));
        } catch {
          /* retained as text */
        }
      }
    });
    child.stdout.on("end", () => stdout.end());
    child.stderr.on("data", (chunk) => stderr.write(redactEvidence(String(chunk), knownSecrets)));
    child.stderr.on("end", () => stderr.end());
    proof.processes.push({
      phase: `${phase}_launch`,
      pid: child.pid,
      executable: scope.executablePath,
      profile: config.profileDirectory,
      at: new Date().toISOString(),
    });
    let mainTarget;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      assert.equal(child.exitCode, null, `${phase}_EXITED_EARLY`);
      try {
        const response = await fetch(`http://127.0.0.1:${ports.inspector}/json/list`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const items = await response.json();
          mainTarget = items[0];
          if (mainTarget?.webSocketDebuggerUrl) break;
        }
      } catch {
        /* bounded startup */
      }
      await delay(100);
    }
    assert.ok(mainTarget?.webSocketDebuggerUrl, `${phase}_MAIN_INSPECTOR_UNAVAILABLE`);
    mainInspector = await CdpClient.connect(mainTarget.webSocketDebuggerUrl, ports.inspector);
    await mainInspector.call("Runtime.enable");
    const electron =
      "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
    const metadata = await mainInspector.evaluate(
      `(()=>{const app=${electron}.app;setTimeout(()=>app.quit(),600000).unref();return {pid:process.pid,exe:process.execPath,profile:app.getPath('userData'),ready:app.isReady(),version:app.getVersion()}})()`,
    );
    check(`${phase} exact PID`, metadata.pid, child.pid);
    check(
      `${phase} exact installed canonical EXE`,
      path.resolve(metadata.exe),
      path.resolve(scope.executablePath),
    );
    check(
      `${phase} exact isolated profile`,
      path.resolve(metadata.profile),
      path.resolve(config.profileDirectory),
    );
    let pageTarget;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${ports.cdp}/json/list`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const items = await response.json();
          pageTarget = items.find(
            (item) =>
              item.type === "page" && item.url.startsWith(`${scope.instance.instanceId}://app/`),
          );
          if (pageTarget?.webSocketDebuggerUrl) break;
        }
      } catch {
        /* bounded startup */
      }
      await delay(100);
    }
    assert.ok(pageTarget?.webSocketDebuggerUrl, `${phase}_RENDERER_CDP_UNAVAILABLE`);
    renderer = await CdpClient.connect(pageTarget.webSocketDebuggerUrl, ports.cdp);
    await renderer.call("Runtime.enable");
    await renderer.call("Network.enable");
    await renderer.call("Page.enable");
    renderer.on("Network.requestWillBeSent", ({ requestId, request, timestamp, wallTime }) => {
      const headers = Object.fromEntries(
        Object.entries(request.headers ?? {}).filter(([key]) =>
          ["accept", "content-type", "origin", "x-qa-project-id"].includes(key.toLowerCase()),
        ),
      );
      proof.network.push({
        phase,
        requestId,
        method: request.method,
        url: request.url,
        headers,
        timestamp,
        wallTime,
      });
    });
    renderer.on("Network.requestWillBeSentExtraInfo", ({ requestId, headers }) => {
      const entry = [...proof.network].reverse().find((item) => item.requestId === requestId);
      if (!entry) return;
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (["accept", "content-type", "origin", "x-qa-project-id"].includes(key.toLowerCase())) {
          entry.headers[key] = value;
        }
      }
    });
    return metadata;
  };
  const reconnectMainInspectorForCleanup = async () => {
    assert.ok(child && activeLaunch, "CLEANUP_CHILD_METADATA_UNAVAILABLE");
    let target;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (child.exitCode !== null) return null;
      try {
        const response = await fetch(`http://127.0.0.1:${ports.inspector}/json/list`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const items = await response.json();
          target = items[0];
          if (target?.webSocketDebuggerUrl) break;
        }
      } catch {
        /* bounded safe cleanup reconnect */
      }
      await delay(100);
    }
    if (!target?.webSocketDebuggerUrl) return null;
    let candidate;
    try {
      candidate = await CdpClient.connect(target.webSocketDebuggerUrl, ports.inspector);
      await candidate.call("Runtime.enable");
      const electron =
        "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
      const metadata = await candidate.evaluate(
        `(()=>{const app=${electron}.app;return {pid:process.pid,exe:process.execPath,profile:app.getPath('userData')}})()`,
      );
      assert.equal(metadata.pid, child.pid, "CLEANUP_PID_MISMATCH");
      assert.equal(
        path.resolve(metadata.exe),
        path.resolve(scope.executablePath),
        "CLEANUP_EXE_MISMATCH",
      );
      assert.equal(
        path.resolve(metadata.profile),
        path.resolve(activeLaunch.config.profileDirectory),
        "CLEANUP_PROFILE_MISMATCH",
      );
      proof.processes.push({
        phase: `${activeLaunch.phase}_cleanup_reconnect`,
        pid: metadata.pid,
        executable: metadata.exe,
        profile: metadata.profile,
        at: new Date().toISOString(),
      });
      return candidate;
    } catch (error) {
      candidate?.close();
      throw error;
    }
  };
  const stopOwn = async (phase) => {
    assert.ok(child && mainInspector, `${phase}_NO_GRACEFUL_CHANNEL`);
    const stoppingChild = child;
    const stoppingInspector = mainInspector;
    const electron =
      "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
    const ack = await stoppingInspector.evaluate(
      `(()=>{const app=${electron}.app;setTimeout(()=>app.quit(),50);return 'OWN_APP_QUIT_SCHEDULED'})()`,
    );
    check(`${phase} graceful quit acknowledged`, ack, "OWN_APP_QUIT_SCHEDULED");
    renderer?.close();
    renderer = null;
    // Node's inspector intentionally keeps the Electron main process alive until
    // every debugger detaches. Disconnect after the verified app.quit request;
    // the bounded cleanup path can reconnect to the same exact PID if exit stalls.
    stoppingInspector.close();
    if (mainInspector === stoppingInspector) mainInspector = null;
    for (let attempt = 0; attempt < 150 && stoppingChild.exitCode === null; attempt += 1)
      await delay(100);
    check(`${phase} exact child exited`, stoppingChild.exitCode !== null, true);
    check(`${phase} exit code`, stoppingChild.exitCode, 0);
    proof.processes.push({
      phase: `${phase}_quit`,
      pid: stoppingChild.pid,
      exitCode: stoppingChild.exitCode,
      at: new Date().toISOString(),
    });
    if (child === stoppingChild) child = null;
    activeLaunch = null;
  };
  const eventFor = async (predicate, label, timeoutMs = TIMEOUT) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const item = processEvents.find(predicate);
      if (item) return item;
      await delay(50);
    } while (Date.now() < deadline);
    throw new Error(`${label}_APP_EVENT_TIMEOUT`);
  };
  const api = async (label, method, pathname, options = {}) => {
    if (method !== "GET") {
      assert.equal(
        nativeSessionPreflightPassed,
        true,
        "BUSINESS_WRITE_BEFORE_NATIVE_SESSION_PREFLIGHT",
      );
    }
    const parsedPath = new URL(pathname, "http://local.invalid");
    const permitted =
      (method === "GET" && parsedPath.pathname === "/api/v1/health/ready" && !parsedPath.search) ||
      (method === "POST" &&
        [
          "/api/v1/auth/gm/login",
          "/api/v1/auth/login",
          "/api/v1/gm/projects",
          "/api/v1/bugs",
        ].includes(parsedPath.pathname) &&
        !parsedPath.search) ||
      (method === "GET" &&
        /^\/api\/v1\/projects\/[0-9a-f-]{36}\/users$/u.test(parsedPath.pathname) &&
        !parsedPath.search) ||
      (method === "GET" &&
        parsedPath.pathname === "/api/v1/notifications" &&
        [...parsedPath.searchParams.keys()].every((key) =>
          ["projectId", "unreadOnly", "limit"].includes(key),
        )) ||
      (method === "PUT" &&
        /^\/api\/v1\/gm\/projects\/[0-9a-f-]{36}\/members\/[0-9a-f-]{36}$/u.test(
          parsedPath.pathname,
        ) &&
        !parsedPath.search);
    assert.ok(permitted, `HTTP_ROUTE_REFUSED_${method}_${parsedPath.pathname}`);
    if (parsedPath.pathname === "/api/v1/bugs") {
      assert.ok(UUID.test(options.projectId), "BUG_PROJECT_HEADER_REQUIRED");
      assert.equal(options.body?.projectId, options.projectId, "BUG_PROJECT_SCOPE_MISMATCH");
      assert.equal(
        options.key,
        `submission:${options.body.clientSubmissionId}:commit`,
        "BUG_IDEMPOTENCY_SCOPE_MISMATCH",
      );
    }
    const requestEntry = {
      label,
      method,
      path: pathname,
      projectId: options.projectId ?? null,
      request: redactEvidence(options.body ?? null, knownSecrets),
      at: new Date().toISOString(),
    };
    proof.requests.push(requestEntry);
    const response = await fetch(scope.apiOrigin + pathname, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        accept: liveRequestAccept(pathname),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.projectId ? { "x-qa-project-id": options.projectId } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const value = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
    requestEntry.status = response.status;
    requestEntry.responseSha256 = sha256(bytes);
    requestEntry.response = redactEvidence(value, knownSecrets);
    check(`${label} status`, response.status, options.status ?? 200);
    if (!pathname.startsWith("/api/v1/auth/"))
      writeExclusive(
        path.join(experiment, "raw", `http-${String(proof.requests.length).padStart(3, "0")}.json`),
        redactEvidence(value, knownSecrets),
      );
    return value;
  };
  const armToastWatcher = async (label, body, mode = "observe-wait-invoke") => {
    assert.ok(child && child.exitCode === null, `${label}_WATCHER_APP_NOT_RUNNING`);
    assert.ok(["observe", "observe-wait-invoke"].includes(mode), `${label}_WATCHER_MODE_REFUSED`);
    const input = path.join(experiment, `${label}-toast-input.json`),
      readyPath = path.join(experiment, `${label}-toast-ready.json`),
      observedPath = path.join(experiment, `${label}-toast-observed.json`),
      signalPath = path.join(experiment, `${label}-toast-invoke.signal`);
    writeExclusive(input, {
      mode,
      title: TOAST_TITLE,
      body,
      appPid: child.pid,
      readyPath,
      timeoutMs: 30_000,
      signalTimeoutMs: 120_000,
      observedPath,
      signalPath,
    });
    let watcherOutcome = null;
    reverifyWindowsPublicationToolchain(scope);
    const promise = execFileAsync(
      scope.windowsPowerShellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(experiment, "toast-uia.ps1"),
        "-InputPath",
        input,
      ],
      { windowsHide: true, timeout: 160_000, maxBuffer: 1024 * 1024 },
    ).then(
      (value) => {
        watcherOutcome = { value };
        return watcherOutcome;
      },
      (error) => {
        watcherOutcome = { error };
        return watcherOutcome;
      },
    );
    const waitForWatcherFile = async (file, errorLabel, attempts) => {
      for (
        let attempt = 0;
        attempt < attempts && !fs.existsSync(file) && !watcherOutcome;
        attempt += 1
      )
        await delay(100);
      if (watcherOutcome?.error) throw watcherOutcome.error;
      assert.ok(fs.existsSync(file), errorLabel);
      return readJson(file);
    };
    const ready = await waitForWatcherFile(readyPath, `${label}_WATCHER_NOT_READY`, 300);
    check(`${label} watcher ready`, ready.ready, true);
    check(`${label} watcher app PID`, ready.appPid, child.pid);
    check(`${label} watcher observer PID valid`, Number.isSafeInteger(ready.observerPid), true);
    check(`${label} watcher app session valid`, Number.isSafeInteger(ready.appSessionId), true);
    check(
      `${label} watcher observer session valid`,
      Number.isSafeInteger(ready.observerSessionId),
      true,
    );
    writeExclusive(path.join(evidence, "raw", `${label}-toast-ready.json`), ready);
    proof.watchers.push({ label, mode, ready });
    // A UIAutomation observer in a different session cannot inspect the app's notification.
    // Classify this before creating the one business fact for the case.
    assertToastSessionMatch({ destinationSessionId: ready.appSessionId }, ready);
    let observed = null;
    const waitForObserved = async () => {
      if (observed) return observed;
      observed = await waitForWatcherFile(observedPath, `${label}_REAL_TOAST_NOT_OBSERVED`, 300);
      check(`${label} exact toast title`, observed.title, TOAST_TITLE);
      check(`${label} exact toast body`, observed.body, body);
      check(`${label} toast title visible`, observed.titleOffscreen, false);
      check(`${label} toast body visible`, observed.bodyOffscreen, false);
      writeExclusive(path.join(evidence, "raw", `${label}-toast-observed.json`), observed);
      return observed;
    };
    const finish = async () => {
      const outcome = await promise;
      if (outcome.error) throw outcome.error;
      return JSON.parse(outcome.value.stdout);
    };
    return {
      ready,
      waitForObserved,
      finishObserve: async () => {
        assert.equal(mode, "observe", `${label}_WATCHER_NOT_OBSERVE_ONLY`);
        await waitForObserved();
        const result = await finish();
        check(`${label} UIAutomation observe only`, result.invoked, false);
        return result;
      },
      invoke: async () => {
        assert.equal(mode, "observe-wait-invoke", `${label}_WATCHER_NOT_INVOKABLE`);
        await waitForObserved();
        writeExclusive(signalPath, `${new Date().toISOString()}\n`);
        const result = await finish();
        check(`${label} UIAutomation Invoke`, result.invoked, true);
        writeExclusive(path.join(evidence, "raw", `${label}-toast-invoked.json`), result);
        return result;
      },
    };
  };
  const showNativeSessionProbe = async (notificationId, body) => {
    assert.ok(mainInspector && child && child.exitCode === null, "SESSION_PROBE_APP_NOT_RUNNING");
    const electron =
      "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
    const result = await mainInspector.evaluate(
      `(()=>{const electron=${electron};const supported=electron.Notification.isSupported();if(!supported)return {pid:process.pid,supported:false,submitted:false};const notification=new electron.Notification({id:${JSON.stringify(notificationId)},title:${JSON.stringify(TOAST_TITLE)},body:${JSON.stringify(body)},silent:false});globalThis[${JSON.stringify(sessionProbeSlot)}]=notification;notification.show();return {pid:process.pid,supported:true,submitted:true,notificationId:${JSON.stringify(notificationId)}}})()`,
    );
    writeExclusive(path.join(evidence, "raw", "session-preflight-native-submit.json"), result);
    check("session preflight exact main PID", result.pid, child.pid);
    if (!result.supported) {
      const error = new Error("WINDOWS_NATIVE_NOTIFICATION_UNSUPPORTED");
      error.code = "WINDOWS_NATIVE_NOTIFICATION_UNSUPPORTED";
      error.classification = "environment_blocker";
      throw error;
    }
    check("session preflight native notification submitted", result.submitted, true);
    check("session preflight notification id", result.notificationId, notificationId);
    return result;
  };
  const closeNativeSessionProbe = async () => {
    assert.ok(mainInspector, "SESSION_PROBE_NO_GRACEFUL_CHANNEL");
    const result = await mainInspector.evaluate(
      `(()=>{const slot=${JSON.stringify(sessionProbeSlot)};const notification=globalThis[slot];if(!notification)return {pid:process.pid,closed:false};try{notification.close()}finally{delete globalThis[slot]}return {pid:process.pid,closed:true}})()`,
    );
    writeExclusive(path.join(evidence, "raw", "session-preflight-native-close.json"), result);
    check("session preflight close exact main PID", result.pid, child?.pid);
    check("session preflight native notification closed", result.closed, true);
  };
  try {
    hostBefore = await snapshotHost("before");
    check("interactive desktop session", hostBefore.sessionId > 0, true);
    check(
      "input preview has no running process",
      hostBefore.processes.filter(
        (item) => path.resolve(item.path || "C:\\missing") === path.resolve(scope.executablePath),
      ).length,
      0,
    );
    check(
      "same instance has no running process",
      hostBefore.processes.filter((item) =>
        String(item.path)
          .toLowerCase()
          .includes(scope.instance.instanceId.slice("qa-hub-preview-".length)),
      ).length,
      0,
    );
    for (const port of [ports.mcp, ports.cdp, ports.inspector])
      check(
        `new port ${port} vacant`,
        hostBefore.listeners.filter((item) => item.port === port && item.listening).length,
        0,
      );
    const ready = await api(
      "read-only readiness before any business write",
      "GET",
      "/api/v1/health/ready",
    );
    check("isolated API ready", ready.status, "ready");
    await launch("quit-probe", configs["quit-probe"]);
    const sessionProbeNotificationId = randomUUID();
    const sessionProbeBody = `通知会话预检-${compact}`;
    let sessionProbeSubmitted = false;
    try {
      const sessionProbeWatcher = await armToastWatcher(
        "session-preflight",
        sessionProbeBody,
        "observe",
      );
      const sessionProbeBoundary = await captureWpnBoundary("session-preflight");
      await showNativeSessionProbe(sessionProbeNotificationId, sessionProbeBody);
      sessionProbeSubmitted = true;
      const sessionProbeCorrelation = await waitForWpnCorrelation(
        "session-preflight",
        sessionProbeBoundary,
        sessionProbeWatcher.ready,
      );
      const sessionProbeObserved = await sessionProbeWatcher.waitForObserved();
      await sessionProbeWatcher.finishObserve();
      await closeNativeSessionProbe();
      sessionProbeSubmitted = false;
      nativeSessionPreflightPassed = true;
      proof.sessionPreflight = {
        environmentOnly: true,
        productPass: false,
        status: "passed",
        notificationId: sessionProbeNotificationId,
        appUserModelId: scope.preview.appUserModelId,
        appSessionId: sessionProbeWatcher.ready.appSessionId,
        observerSessionId: sessionProbeWatcher.ready.observerSessionId,
        destinationSessionId: sessionProbeCorrelation.destinationSessionId,
        observedAt: sessionProbeObserved.observedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (cause) {
      if (sessionProbeSubmitted) {
        try {
          await closeNativeSessionProbe();
        } catch (cleanupError) {
          proof.sessionPreflightCleanupError = redactEvidence(
            cleanupError?.message ?? String(cleanupError),
            knownSecrets,
          );
        }
      }
      proof.sessionPreflight = {
        environmentOnly: true,
        productPass: false,
        status: "blocked",
        notificationId: sessionProbeNotificationId,
        completedAt: new Date().toISOString(),
        error: redactEvidence(cause?.message ?? String(cause), knownSecrets),
      };
      const blocker = new Error(cause?.message ?? "WINDOWS_NATIVE_SESSION_PREFLIGHT_FAILED", {
        cause,
      });
      blocker.code = cause?.code ?? "WINDOWS_NATIVE_SESSION_PREFLIGHT_FAILED";
      blocker.classification = "environment_blocker";
      throw blocker;
    }
    await stopOwn("quit-probe");
    const afterProbe = await snapshotHost("after-quit-probe");
    check(
      "all Relay QA Hub processes unchanged by quit probe",
      relayProcessFingerprint(afterProbe),
      relayProcessFingerprint(hostBefore),
    );
    check(
      "installed canonical EXE absent after quit probe",
      afterProbe.processes.filter(
        (item) => path.resolve(item.path || "C:\\missing") === path.resolve(scope.executablePath),
      ).length,
      0,
    );
    check("canonical inputs unchanged after quit probe", criticalFiles(scope), criticalBefore);
    for (const port of [ports.mcp, ports.cdp, ports.inspector])
      check(
        `probe port ${port} released`,
        afterProbe.listeners.filter((item) => item.port === port && item.listening).length,
        0,
      );

    // Business writes start only after the exact installed EXE has produced a real native toast
    // whose WPN destination matches both the app and UIAutomation observer sessions, then exited.
    const secrets = readJson(scope.instance.secretsFile);
    knownSecrets.add(secrets.gmPassword);
    const gm = await api("GM login", "POST", "/api/v1/auth/gm/login", {
      body: { password: secrets.gmPassword, client: "android" },
    });
    knownSecrets.add(gm.accessToken);
    check("GM identity", gm.isGm, true);
    const projects = [];
    for (const suffix of ["A", "B"])
      projects.push(
        await api(`create project ${suffix}`, "POST", "/api/v1/gm/projects", {
          token: gm.accessToken,
          body: {
            id: randomUUID(),
            key: notificationProjectKey(compact, suffix),
            name: `通知路由${suffix}-${compact.slice(0, 8)}`,
          },
        }),
      );
    const [projectA, projectB] = projects;
    const targetName = `NotifyTarget${compact.slice(0, 12)}`,
      actorName = `NotifyActor${compact.slice(0, 12)}`;
    const login = (label, name, projectId) =>
      api(label, "POST", "/api/v1/auth/login", { body: { name, projectId, client: "android" } });
    const targetA = await login("target joins A", targetName, projectA.id);
    knownSecrets.add(targetA.accessToken);
    const targetB = await login("same target joins B", targetName, projectB.id);
    knownSecrets.add(targetB.accessToken);
    const actorA = await login("separate actor joins A", actorName, projectA.id);
    knownSecrets.add(actorA.accessToken);
    const actorB = await login("same separate actor joins B", actorName, projectB.id);
    knownSecrets.add(actorB.accessToken);
    check("same target identity A B", targetB.userId, targetA.userId);
    check("same actor identity A B", actorB.userId, actorA.userId);
    check("actor distinct", actorA.userId !== targetA.userId, true);
    proof.fixtures = {
      projectA,
      projectB,
      target: { userId: targetA.userId, name: targetName },
      actorA: { userId: actorA.userId, name: actorName },
    };
    await launch("route-1", configs.route);
    await rendererLogin(renderer, projectA.id, targetName);

    const description1 = `通知路由A1-${compact}`;
    const bug1Input = makeBugBody(projectA.id, targetA.userId, description1);
    const expectedBugKey1 = expectedBugKey(projectA.key, 1);
    const body1 = `${expectedBugKey1} · ${description1}`;
    const watcher1 = await armToastWatcher("a1", body1);
    const wpnBoundary1 = await captureWpnBoundary("a1");
    const created1 = await api("actor creates assigned A1 Bug", "POST", "/api/v1/bugs", {
      token: actorA.accessToken,
      projectId: projectA.id,
      key: `submission:${bug1Input.submission}:commit`,
      body: bug1Input.body,
      status: 201,
    });
    check("A1 deterministic first Bug key", created1.bug.key, expectedBugKey1);
    const notices1 = await api(
      "target reads durable A1 notification",
      "GET",
      `/api/v1/notifications?projectId=${projectA.id}&unreadOnly=true&limit=100`,
      { token: targetA.accessToken, projectId: projectA.id },
    );
    const notice1 = notices1.items.find((item) => item.bugId === created1.bug.id);
    check("durable A1 notification exists", Boolean(notice1), true);
    check("durable A1 notification body", durableToastBody(notice1), body1);
    await waitForWpnCorrelation("a1", wpnBoundary1, watcher1.ready);
    await eventFor(
      (item) => item.event === "desktop.notification.shown" && item.notificationId === notice1.id,
      "A1_SHOWN",
    );
    await watcher1.waitForObserved();
    await switchProject(renderer, projectB.id);
    const draft = `B项目唯一未提交草稿-${compact}`;
    await putDraft(renderer, draft);
    const requestStart1 = proof.network.length;
    await watcher1.invoke();
    const clicked1 = await eventFor(
      (item) => item.event === "desktop.notification.clicked" && item.notificationId === notice1.id,
      "A1_GLOBAL_CLICK",
    );
    check("A1 click source", clicked1.source, "global");
    check("A1 click project route", clicked1.projectId, projectA.id);
    check("A1 click user route", clicked1.userId, targetA.userId);
    check("A1 click Bug route", clicked1.bugId, created1.bug.id);
    const routed1 = await waitFor(
      renderer,
      (s) => s.projectId === projectA.id && s.detailOpen && s.detailKey === created1.bug.key,
      "A1_ROUTE",
      30_000,
    );
    const details1 = proof.network
      .slice(requestStart1)
      .map((item) => classifyBugDetailRequest(item, created1.bug.id))
      .filter(Boolean);
    check("A1 exact detail requested", details1.length > 0, true);
    check("A1 first detail carries project A", details1[0].projectId, projectA.id);
    writeExclusive(path.join(evidence, "raw", "a1-routed-renderer.json"), routed1);
    await closeDetail(renderer);
    await switchProject(renderer, projectB.id);
    const draftBack = await waitFor(
      renderer,
      (s) => s.createOpen && s.draft === draft,
      "B_DRAFT_ROUNDTRIP",
    );
    check("B draft roundtrip exact", draftBack.draft, draft);
    await renderer.evaluate(
      "(()=>{const b=document.querySelector('.create-modal .modal-head button');if(!b)return false;b.click();return true})()",
    );

    // Re-enter A before creating A2 so the desktop transport's remembered project scope is A.
    // The toast itself is then clicked from B, which is the cross-project route under test.
    await switchProject(renderer, projectA.id);
    const description2 = `通知撤权A2-${compact}`;
    const bug2Input = makeBugBody(projectA.id, targetA.userId, description2);
    const expectedBugKey2 = expectedBugKey(projectA.key, 2);
    const body2 = `${expectedBugKey2} · ${description2}`;
    const watcher2 = await armToastWatcher("a2", body2);
    const wpnBoundary2 = await captureWpnBoundary("a2");
    const created2 = await api("actor creates assigned A2 Bug", "POST", "/api/v1/bugs", {
      token: actorA.accessToken,
      projectId: projectA.id,
      key: `submission:${bug2Input.submission}:commit`,
      body: bug2Input.body,
      status: 201,
    });
    check("A2 deterministic second Bug key", created2.bug.key, expectedBugKey2);
    const notices2 = await api(
      "target reads durable A2 notification",
      "GET",
      `/api/v1/notifications?projectId=${projectA.id}&unreadOnly=true&limit=100`,
      { token: targetA.accessToken, projectId: projectA.id },
    );
    const notice2 = notices2.items.find((item) => item.bugId === created2.bug.id);
    check("durable A2 notification exists", Boolean(notice2), true);
    check("durable A2 notification body", durableToastBody(notice2), body2);
    await waitForWpnCorrelation("a2", wpnBoundary2, watcher2.ready);
    await eventFor(
      (item) => item.event === "desktop.notification.shown" && item.notificationId === notice2.id,
      "A2_SHOWN",
    );
    await watcher2.waitForObserved();
    await switchProject(renderer, projectB.id);
    const usersA = await api(
      "GM reads A membership version",
      "GET",
      `/api/v1/projects/${projectA.id}/users`,
      { token: gm.accessToken, projectId: projectA.id },
    );
    const membership = usersA.items.find((item) => item.userId === targetA.userId);
    check("target A membership found", Boolean(membership), true);
    await api(
      "GM revokes target A membership",
      "PUT",
      `/api/v1/gm/projects/${projectA.id}/members/${targetA.userId}`,
      {
        token: gm.accessToken,
        body: { active: false, expectedVersion: membership.membershipVersion },
      },
    );
    const requestStart2 = proof.network.length;
    await watcher2.invoke();
    const clicked2 = await eventFor(
      (item) => item.event === "desktop.notification.clicked" && item.notificationId === notice2.id,
      "A2_GLOBAL_CLICK",
    );
    check("A2 click source", clicked2.source, "global");
    check("A2 click project route", clicked2.projectId, projectA.id);
    check("A2 click user route", clicked2.userId, targetA.userId);
    check("A2 click Bug route", clicked2.bugId, created2.bug.id);
    const denied = await waitFor(
      renderer,
      (s) =>
        s.projectId === projectB.id &&
        s.inaccessibleExact &&
        !s.projects.some((item) => item.id === projectA.id),
      "A2_REVOKED_ROUTE",
      30_000,
    );
    check("revoked route stays B", denied.projectId, projectB.id);
    check("revoked route exact visible alert", denied.alert, INACCESSIBLE_TEXT);
    check(
      "revoked route sends no A2 detail request",
      proof.network
        .slice(requestStart2)
        .map((item) => classifyBugDetailRequest(item, created2.bug.id))
        .filter(Boolean).length,
      0,
    );
    writeExclusive(path.join(evidence, "raw", "a2-denied-renderer.json"), denied);

    await signOut(renderer);
    await rendererLogin(renderer, projectB.id, targetName);
    const description3 = `通知重启B3-${compact}`;
    const bug3Input = makeBugBody(projectB.id, targetB.userId, description3);
    const expectedBugKey3 = expectedBugKey(projectB.key, 1);
    const body3 = `${expectedBugKey3} · ${description3}`;
    const watcher3 = await armToastWatcher("b3", body3, "observe");
    const wpnBoundary3 = await captureWpnBoundary("b3");
    const created3 = await api("separate actor creates assigned B3 Bug", "POST", "/api/v1/bugs", {
      token: actorB.accessToken,
      projectId: projectB.id,
      key: `submission:${bug3Input.submission}:commit`,
      body: bug3Input.body,
      status: 201,
    });
    check("B3 deterministic first Bug key", created3.bug.key, expectedBugKey3);
    const notices3 = await api(
      "target reads durable unread B3 notification",
      "GET",
      `/api/v1/notifications?projectId=${projectB.id}&unreadOnly=true&limit=100`,
      { token: targetB.accessToken, projectId: projectB.id },
    );
    const notice3 = notices3.items.find((item) => item.bugId === created3.bug.id);
    check(
      "durable unread B3 notification exists",
      Boolean(notice3) && notice3.readAt === null,
      true,
    );
    check("durable B3 notification body", durableToastBody(notice3), body3);
    await waitForWpnCorrelation("b3", wpnBoundary3, watcher3.ready);
    await eventFor(
      (item) => item.event === "desktop.notification.shown" && item.notificationId === notice3.id,
      "B3_SHOWN",
    );
    await watcher3.waitForObserved();
    await watcher3.finishObserve();
    const historyFile = path.join(configs.route.profileDirectory, "notification-history.json");
    const expectedHistoryEntry3 = (acknowledged) => ({
      notificationId: notice3.id,
      acknowledged,
      projectId: projectB.id,
      userId: targetB.userId,
      bugId: created3.bug.id,
    });
    const checkB3History = (phase, history, acknowledged) => {
      const expected = expectedHistoryEntry3(acknowledged);
      check(`B3 history schema v2 ${phase}`, history?.schemaVersion, 2);
      check(`B3 history entries array ${phase}`, Array.isArray(history?.entries), true);
      const matches = history.entries.filter((entry) => entry?.notificationId === notice3.id);
      check(`B3 history exactly once ${phase}`, matches.length, 1);
      const matched = exactNotificationHistoryV2Entry(history, expected);
      check(`B3 history exact scoped route ${phase}`, matched, expected);
    };
    const historyBeforeRestart = readJson(historyFile);
    checkB3History("before restart", historyBeforeRestart, false);
    // Persist a signed-out profile so the restarted transport cannot reconcile
    // until the UIA watcher and WPN boundary are armed below.
    await signOut(renderer);
    checkB3History("after signout before restart", readJson(historyFile), false);
    await stopOwn("controlled-restart-stop");
    await launch("route-2-restart", configs.route);
    const watcher3Restart = await armToastWatcher("b3-restart", body3);
    const wpnBoundary3Restart = await captureWpnBoundary("b3-restart");
    await rendererLogin(renderer, projectB.id, targetName);
    await waitForWpnCorrelation("b3-restart", wpnBoundary3Restart, watcher3Restart.ready);
    await eventFor(
      (item) => item.event === "desktop.notification.shown" && item.notificationId === notice3.id,
      "B3_RESTART_SHOWN",
    );
    await watcher3Restart.waitForObserved();
    await waitFor(
      renderer,
      (s) => s.ready && s.projectId === projectB.id && s.connection?.state === "connected",
      "RESTART_REAUTH",
      30_000,
    );
    const requestStart3 = proof.network.length;
    await watcher3Restart.invoke();
    const clicked3 = await eventFor(
      (item) => item.event === "desktop.notification.clicked" && item.notificationId === notice3.id,
      "B3_RESTART_GLOBAL_CLICK",
    );
    check("B3 restart click source", clicked3.source, "global");
    check("B3 restart click project route", clicked3.projectId, projectB.id);
    check("B3 restart click user route", clicked3.userId, targetB.userId);
    check("B3 restart click Bug route", clicked3.bugId, created3.bug.id);
    const routed3 = await waitFor(
      renderer,
      (s) => s.projectId === projectB.id && s.detailOpen && s.detailKey === created3.bug.key,
      "B3_RESTART_ROUTE",
      30_000,
    );
    const details3 = proof.network
      .slice(requestStart3)
      .map((item) => classifyBugDetailRequest(item, created3.bug.id))
      .filter(Boolean);
    check("B3 restart exact detail requested", details3.length > 0, true);
    check("B3 restart first detail carries project B", details3[0].projectId, projectB.id);
    writeExclusive(path.join(evidence, "raw", "b3-restart-routed-renderer.json"), routed3);
    const historyAfterClick = readJson(historyFile);
    checkB3History("after restart global click", historyAfterClick, true);
    await closeDetail(renderer);
    await stopOwn("acknowledged-restart-stop");
    await launch("route-3-acknowledged", configs.route);
    await waitFor(
      renderer,
      (s) => s.ready && s.projectId === projectB.id && s.connection?.state === "connected",
      "ACKNOWLEDGED_RESTART_REAUTH",
      30_000,
    );
    const acknowledgedReconciliation = await eventFor(
      (item) =>
        item.event === "desktop.notification.inbox.reconciled" &&
        item.projectId === projectB.id &&
        Array.isArray(item.notificationIds) &&
        item.notificationIds.includes(notice3.id) &&
        Array.isArray(item.unreadNotificationIds) &&
        item.unreadNotificationIds.includes(notice3.id) &&
        Array.isArray(item.locallyAcknowledgedNotificationIds) &&
        item.locallyAcknowledgedNotificationIds.includes(notice3.id),
      "ACKNOWLEDGED_B3_INBOX_RECONCILED",
      30_000,
    );
    check(
      "acknowledged B3 reconciliation attempted no presentation",
      acknowledgedReconciliation.presentationAttemptedNotificationIds.includes(notice3.id),
      false,
    );
    writeExclusive(
      path.join(evidence, "raw", "b3-acknowledged-inbox-reconciliation.json"),
      acknowledgedReconciliation,
    );
    check(
      "acknowledged B3 not replayed on next restart",
      processEvents.filter(
        (item) => item.event === "desktop.notification.shown" && item.notificationId === notice3.id,
      ).length,
      0,
    );
    const historyAfterAcknowledgedRestart = readJson(historyFile);
    checkB3History("after acknowledged restart", historyAfterAcknowledgedRestart, true);
    check(
      "acknowledged notification history stable across restart",
      historyAfterAcknowledgedRestart,
      historyAfterClick,
    );
    proof.fixtures.bugs = { a1: created1.bug, a2: created2.bug, b3: created3.bug };
    proof.fixtures.notifications = { a1: notice1.id, a2: notice2.id, b3: notice3.id };
    proof.passed = true;
  } catch (error) {
    proof.error = {
      name: error?.name ?? "Error",
      code: error?.code ?? null,
      classification: error?.classification ?? null,
      message: redactEvidence(error?.message ?? String(error), knownSecrets),
      details: redactEvidence(error?.details ?? null, knownSecrets),
    };
    throw error;
  } finally {
    if (child) {
      try {
        if (child.exitCode !== null) {
          const exitedChild = child;
          renderer?.close();
          renderer = null;
          mainInspector?.close();
          mainInspector = null;
          child = null;
          activeLaunch = null;
          proof.processes.push({
            phase: "final-cleanup_already_exited",
            pid: exitedChild.pid,
            exitCode: exitedChild.exitCode,
            at: new Date().toISOString(),
          });
          check("final-cleanup already-exited code", exitedChild.exitCode, 0);
        } else {
          if (!mainInspector) mainInspector = await reconnectMainInspectorForCleanup();
          assert.ok(mainInspector, "FINAL_CLEANUP_NO_VERIFIED_GRACEFUL_CHANNEL");
          await stopOwn("final-cleanup");
        }
      } catch (error) {
        proof.cleanupError = redactEvidence(error?.message ?? String(error), knownSecrets);
        proof.passed = false;
      }
    }
    try {
      const hostAfter = await snapshotHost("after");
      if (hostBefore) {
        check(
          "all pre-existing QA Hub processes unchanged",
          relayProcessFingerprint(hostAfter),
          relayProcessFingerprint(hostBefore),
        );
        check(
          "configured and production listeners unchanged",
          listenerFingerprint(hostAfter, new Set([ports.mcp, ports.cdp, ports.inspector])),
          listenerFingerprint(hostBefore, new Set([ports.mcp, ports.cdp, ports.inspector])),
        );
        for (const port of [ports.mcp, ports.cdp, ports.inspector])
          check(
            `final own port ${port} released`,
            hostAfter.listeners.filter((item) => item.port === port && item.listening).length,
            0,
          );
        check(
          "installed canonical EXE absent after final cleanup",
          hostAfter.processes.filter(
            (item) =>
              path.resolve(item.path || "C:\\missing") === path.resolve(scope.executablePath),
          ).length,
          0,
        );
      }
      check(
        "instance and installed preview inputs unchanged",
        criticalFiles(scope),
        criticalBefore,
      );
      const sourceAttributionAfter = gitSourceAttributionState(evidence);
      check(
        "source HEAD unchanged through live run",
        sourceAttributionAfter.head,
        scope.release.sourceCommit,
      );
      check("tracked source unchanged through live run", sourceAttributionAfter.trackedChanges, []);
      check(
        "no unexpected untracked source through live run",
        sourceAttributionAfter.unexpectedUntracked,
        [],
      );
      proof.sourceAttributionAfter = sourceAttributionAfter;
      proof.hostAfter = hostAfter;
    } catch (error) {
      proof.finalizationError = redactEvidence(error?.message ?? String(error), knownSecrets);
      proof.passed = false;
    }
    proof.finishedAt = new Date().toISOString();
    proof.network = redactEvidence(proof.network, knownSecrets);
    const safe = redactEvidence(proof, knownSecrets);
    const serialized = `${JSON.stringify(safe, null, 2)}\n`;
    for (const secret of knownSecrets)
      assert.ok(!serialized.includes(secret), "SECRET_LITERAL_IN_EVIDENCE");
    writeExclusive(path.join(evidence, "proof.json"), serialized);
    process.stdout.write(
      `${JSON.stringify({ runId, passed: proof.passed, evidence: path.join(evidence, "proof.json") })}\n`,
    );
  }
  assert.equal(proof.passed, true, "LIVE_NOTIFICATION_ROUTE_FAILED");
}

function usage() {
  return [
    "Review/dry-run (read-only):",
    "  node scripts/project-components/desktop-notification-project-route-live.mjs --instance <absolute-instance.json> --exe <absolute-installed-preview.exe> --key-sha256 <pre-upgrade-spki-der-sha256> --release-id <expected-release-id> --version <expected-version>",
    "Authorized live run:",
    "  node scripts/project-components/desktop-notification-project-route-live.mjs --instance <absolute-instance.json> --exe <absolute-installed-preview.exe> --key-sha256 <pre-upgrade-spki-der-sha256> --release-id <expected-release-id> --version <expected-version> --run",
    "The key pin is SHA-256 over the public key's SPKI DER bytes and must be recorded before the installer runs.",
    "Dry-run fetches and verifies the exact signed feed and installer, then uses the installer's verification-only extraction mode in a contained temporary directory.",
    "The live path refuses production roots/ports and any already-running copy of the selected preview instance.",
  ].join("\n");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.usageOnly) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const staticScope = validateStaticScope(
    args.instancePath,
    args.executablePath,
    args.expectedPublicKeySha256,
    args.expectedReleaseId,
    args.expectedVersion,
  );
  const publishedRelease = await validatePublishedRelease(
    staticScope,
    args.expectedReleaseId,
    args.expectedVersion,
  );
  const scope = { ...staticScope, publishedRelease };
  const review = {
    mode: args.execute ? "live" : "dry-run",
    instanceId: scope.instance.instanceId,
    instancePath: scope.instancePath,
    executablePath: scope.executablePath,
    executableSha256: fileSha256(scope.executablePath),
    appAsarSha256: fileSha256(scope.asarPath),
    publicKeySha256: scope.releaseProvenance.releaseAttestation.publicKeySha256,
    releaseId: scope.release.releaseId,
    version: scope.release.version,
    publishedRelease,
    apiOrigin: scope.apiOrigin,
    productionPortsRejected: [...BLOCKED_PORTS],
    liveRequiresEmptySelectedInstance: true,
    gracefulQuitProbeBeforeBusinessWrites: true,
  };
  if (!args.execute) {
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
    return;
  }
  await runLive(scope);
}

if (path.resolve(process.argv[1] ?? "") === sourcePath) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        passed: false,
        error: redactEvidence(error?.message ?? String(error)),
        code: error?.code ?? null,
        classification: error?.classification ?? null,
      })}\n`,
    );
    process.exitCode = 1;
  });
}
