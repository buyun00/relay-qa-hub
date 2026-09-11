import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ATOMIC_EXCLUSIVE_JSON_PS,
  HOST_SNAPSHOT_PS,
  TOAST_UIA_PS,
  WPN_EVENT_PS,
  assertExpectedRelease,
  assertReleaseAttestation,
  assertToastSessionMatch,
  canonicalPackagedPreviewConfig,
  classifyBugDetailRequest,
  correlateWpnToastEvents,
  durableToastBody,
  exactNotificationHistoryV2Entry,
  expectedBugKey,
  liveRequestAccept,
  normalizePreviewPackageConfigIdentity,
  notificationProjectKey,
  parseArguments,
  redactEvidence,
  relayProcessFingerprint,
  validatePublishedRelease,
} from "./desktop-notification-project-route-live.mjs";
import {
  assertReleaseContentBinding,
  serializeReleaseAttestation,
  serializeUpdateManifestPayload,
  snapshotReleaseDirectory,
} from "./release-content-binding.mjs";
import { pinnedPackageToolchainProvenance } from "./package-toolchain-provenance.mjs";
import { resolveWindowsPowerShellExecutable } from "./windows-write-through.mjs";

const INSTANCE = "C:\\isolated\\qa-hub-preview-test\\instance.json";
const EXE = "C:\\isolated\\RelayQaHubPreview-test\\RelayQaHubPreview-test.exe";
const KEY_SHA256 = "a".repeat(64);
const RELEASE_ID = "20260911T123456789Z";
const VERSION = "0.2.0-preview.18";
const RELEASE_ARGS = ["--release-id", RELEASE_ID, "--version", VERSION];
const WINDOWS_POWERSHELL = resolveWindowsPowerShellExecutable();
const runnerSource = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "desktop-notification-project-route-live.mjs",
  ),
  "utf8",
);

function publishedReleaseFixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "qa-hub-notification-release-"));
  const runtimeRoot = path.join(root, "runtime");
  const downloadsRoot = path.join(runtimeRoot, "downloads");
  const desktopRoot = path.join(runtimeRoot, "desktop");
  const installedRoot = path.join(root, "RelayQaHubPreview-unit");
  const extractedRoot = path.join(root, "extracted");
  for (const directory of [runtimeRoot, downloadsRoot, desktopRoot, installedRoot, extractedRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  const instance = {
    instanceId: "qa-hub-preview-unit",
    desktopRoot,
    downloadsRoot,
    apiHost: "127.0.0.1",
    apiPort: 49196,
    webHost: "127.0.0.1",
    webPort: 49197,
    desktopMcpPort: 49198,
    cookieName: "qa-hub-preview-unit-session",
  };
  const canonicalConfig = canonicalPackagedPreviewConfig(instance, publicKeyPem);
  const legacyConfig = { ...canonicalConfig };
  delete legacyConfig.toastActivatorClsid;
  const installedConfigBytes = Buffer.from(`${JSON.stringify(legacyConfig, null, 2)}\n`);
  const canonicalConfigBytes = Buffer.from(`${JSON.stringify(canonicalConfig, null, 2)}\n`);
  const previewConfigPath = path.join(installedRoot, "preview-instance.json");
  fs.writeFileSync(previewConfigPath, installedConfigBytes);
  fs.writeFileSync(path.join(installedRoot, ".preview-instance-id"), instance.instanceId);
  fs.writeFileSync(path.join(installedRoot, "RelayQaHubPreview-unit.exe"), "installed-app");
  fs.writeFileSync(path.join(extractedRoot, "preview-instance.json"), canonicalConfigBytes);
  fs.writeFileSync(path.join(extractedRoot, ".preview-instance-id"), instance.instanceId);
  fs.writeFileSync(path.join(extractedRoot, "RelayQaHubPreview-unit.exe"), "installed-app");

  const installerBytes = Buffer.from("fixture-installer");
  const installerName = `qa-hub-preview-unit-windows-${VERSION}-${RELEASE_ID}.exe`;
  const manifestPayload = {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    version: VERSION,
    publishedAt: "2026-09-11T12:34:56.789Z",
    archive: {
      url: `/downloads/${installerName}`,
      size: installerBytes.length,
      sha256: createHash("sha256").update(installerBytes).digest("hex"),
    },
  };
  const manifest = {
    ...manifestPayload,
    signature: sign(
      null,
      serializeUpdateManifestPayload(manifestPayload),
      pair.privateKey,
    ).toString("base64"),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  fs.writeFileSync(
    path.join(downloadsRoot, "qa-hub-preview-unit-windows-latest.json"),
    manifestBytes,
  );
  fs.writeFileSync(path.join(downloadsRoot, installerName), installerBytes);
  const manifestUrl = new URL(
    "http://127.0.0.1:49197/downloads/qa-hub-preview-unit-windows-latest.json",
  );
  const fetchImpl = async (url) => {
    const bytes = new URL(url).pathname.endsWith("-latest.json") ? manifestBytes : installerBytes;
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  };
  const installerPayloadVerifier = (_bytes, expected, _parent, label) =>
    assertReleaseContentBinding(expected, snapshotReleaseDirectory(extractedRoot), label);
  return {
    root,
    extractedRoot,
    canonicalConfig,
    installedConfigBytes,
    canonicalConfigBytes,
    fetchImpl,
    installerPayloadVerifier,
    scope: {
      manifestUrl,
      preview: canonicalConfig,
      previewConfigPath,
      previewConfigProvenance: {
        bytes: installedConfigBytes.length,
        sha256: createHash("sha256").update(installedConfigBytes).digest("hex"),
      },
      release: {
        releaseId: RELEASE_ID,
        version: VERSION,
        sourceCommit: "b".repeat(40),
      },
      instance,
      runtimeRoot,
      installedRoot,
    },
  };
}

test("CLI is inert without --run and requires both explicit absolute inputs", () => {
  assert.deepEqual(parseArguments([]), { usageOnly: true, execute: false });
  assert.deepEqual(
    parseArguments([
      "--instance",
      INSTANCE,
      "--exe",
      EXE,
      "--key-sha256",
      KEY_SHA256,
      ...RELEASE_ARGS,
    ]),
    {
      usageOnly: false,
      execute: false,
      instancePath: INSTANCE,
      executablePath: EXE,
      expectedPublicKeySha256: KEY_SHA256,
      expectedReleaseId: RELEASE_ID,
      expectedVersion: VERSION,
    },
  );
  assert.equal(
    parseArguments([
      "--run",
      "--exe",
      EXE,
      "--instance",
      INSTANCE,
      "--key-sha256",
      KEY_SHA256,
      ...RELEASE_ARGS,
    ]).execute,
    true,
  );
  assert.throws(() => parseArguments(["--run", "--instance", INSTANCE]), /EXPLICIT_EXE_REQUIRED/u);
  assert.throws(
    () => parseArguments(["--instance", INSTANCE, "--exe", EXE]),
    /EXPLICIT_PUBLIC_KEY_SHA256_REQUIRED/u,
  );
  assert.throws(
    () => parseArguments(["--instance", INSTANCE, "--exe", EXE, "--key-sha256", KEY_SHA256]),
    /EXPLICIT_RELEASE_ID_REQUIRED/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "--instance",
        INSTANCE,
        "--exe",
        EXE,
        "--key-sha256",
        KEY_SHA256,
        "--release-id",
        RELEASE_ID,
      ]),
    /EXPLICIT_VERSION_REQUIRED/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "--instance",
        INSTANCE,
        "--exe",
        EXE,
        "--key-sha256",
        KEY_SHA256,
        ...RELEASE_ARGS,
        "--force",
      ]),
    /UNKNOWN_ARGUMENT/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "--instance",
        "instance.json",
        "--exe",
        EXE,
        "--key-sha256",
        KEY_SHA256,
        ...RELEASE_ARGS,
      ]),
    /INSTANCE_MUST_BE_ABSOLUTE/u,
  );
});

test("same-commit stale package cannot satisfy an explicitly selected newer release", async () => {
  const sharedSourceCommit = "b".repeat(40);
  const oldRelease = {
    releaseId: "20260911T111111111Z",
    version: "0.2.0-preview.17",
    sourceCommit: sharedSourceCommit,
  };
  const currentRelease = {
    releaseId: RELEASE_ID,
    version: VERSION,
    sourceCommit: sharedSourceCommit,
  };
  assert.equal(
    assertExpectedRelease(currentRelease, RELEASE_ID, VERSION, "CURRENT"),
    currentRelease,
  );
  assert.throws(
    () => assertExpectedRelease(oldRelease, RELEASE_ID, VERSION, "STALE"),
    /STALE_RELEASE_ID_MISMATCH/u,
  );
  const pair = generateKeyPairSync("ed25519");
  const feedPayload = {
    schemaVersion: 1,
    releaseId: currentRelease.releaseId,
    version: currentRelease.version,
    publishedAt: "2026-09-11T12:34:56.789Z",
    archive: {
      url: `/downloads/qa-hub-preview-unit-windows-${VERSION}-${RELEASE_ID}.exe`,
      size: 4,
      sha256: "a".repeat(64),
    },
  };
  const signedFeed = {
    ...feedPayload,
    signature: sign(null, serializeUpdateManifestPayload(feedPayload), pair.privateKey).toString(
      "base64",
    ),
  };
  const feedBytes = Buffer.from(`${JSON.stringify(signedFeed)}\n`);
  await assert.rejects(
    validatePublishedRelease(
      {
        manifestUrl: new URL(
          "http://127.0.0.1:49199/downloads/qa-hub-preview-unit-windows-latest.json",
        ),
        preview: {
          updatePublicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
        },
        release: oldRelease,
      },
      RELEASE_ID,
      VERSION,
      async () =>
        new Response(feedBytes, {
          status: 200,
          headers: { "content-length": String(feedBytes.length) },
        }),
    ),
    /RUNNER_INSTALLED_RELEASE_ID_MISMATCH/u,
  );
});

test("published release accepts a byte-preserved legacy installed config with canonical installer config", async () => {
  const fixture = publishedReleaseFixture();
  try {
    const result = await validatePublishedRelease(
      fixture.scope,
      RELEASE_ID,
      VERSION,
      fixture.fetchImpl,
      fixture.installerPayloadVerifier,
    );
    assert.equal(result.previewConfig.policy, "preserve-existing-installation");
    assert.equal(result.previewConfig.bytesEqual, false);
    assert.equal(result.previewConfig.installedBytesMatchedStaticScope, true);
    assert.equal(result.previewConfig.normalizedConfigMatchedCanonicalPackage, true);
    assert.equal(
      result.previewConfig.installed.sha256,
      createHash("sha256").update(fixture.installedConfigBytes).digest("hex"),
    );
    assert.equal(
      result.previewConfig.packaged.sha256,
      createHash("sha256").update(fixture.canonicalConfigBytes).digest("hex"),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("published release rejects a semantic-equivalent installed config changed after static scope", async () => {
  const fixture = publishedReleaseFixture();
  try {
    const changedBytes = Buffer.from(fixture.installedConfigBytes);
    changedBytes[changedBytes.length - 1] = 0x20;
    fs.writeFileSync(fixture.scope.previewConfigPath, changedBytes);
    await assert.rejects(
      validatePublishedRelease(
        fixture.scope,
        RELEASE_ID,
        VERSION,
        fixture.fetchImpl,
        fixture.installerPayloadVerifier,
      ),
      /RUNNER_INSTALLED_PREVIEW_CONFIG_SHA256_CHANGED/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("published release rejects installed config semantics outside the canonical package", async () => {
  const fixture = publishedReleaseFixture();
  try {
    const noncanonicalConfig = { ...fixture.canonicalConfig, unexpected: "refused" };
    const noncanonicalBytes = Buffer.from(`${JSON.stringify(noncanonicalConfig, null, 2)}\n`);
    fs.writeFileSync(fixture.scope.previewConfigPath, noncanonicalBytes);
    fixture.scope.preview = noncanonicalConfig;
    fixture.scope.previewConfigProvenance = {
      bytes: noncanonicalBytes.length,
      sha256: createHash("sha256").update(noncanonicalBytes).digest("hex"),
    };
    await assert.rejects(
      validatePublishedRelease(
        fixture.scope,
        RELEASE_ID,
        VERSION,
        fixture.fetchImpl,
        fixture.installerPayloadVerifier,
      ),
      /RUNNER_INSTALLED_PREVIEW_CONFIG_SEMANTIC_MISMATCH/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("published release rejects drift in every installed non-config payload file", async () => {
  const fixture = publishedReleaseFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.extractedRoot, "RelayQaHubPreview-unit.exe"),
      "different-app",
    );
    await assert.rejects(
      validatePublishedRelease(
        fixture.scope,
        RELEASE_ID,
        VERSION,
        fixture.fetchImpl,
        fixture.installerPayloadVerifier,
      ),
      /RUNNER_INSTALLER_INSTALLED_CONTENT_MISMATCH/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("published release rejects a packaged config that is not the exact canonical bytes", async () => {
  const fixture = publishedReleaseFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.extractedRoot, "preview-instance.json"),
      `${JSON.stringify(fixture.canonicalConfig)}\n`,
    );
    await assert.rejects(
      validatePublishedRelease(
        fixture.scope,
        RELEASE_ID,
        VERSION,
        fixture.fetchImpl,
        fixture.installerPayloadVerifier,
      ),
      /RUNNER_INSTALLER_INSTALLED_CONTENT_MISMATCH/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("live scope pins installed artifacts to a clean exact source commit", () => {
  assert.match(runnerSource, /asar\.extractFile\(asarPath, "release\.json"\)/u);
  assert.match(
    runnerSource,
    /assert\.equal\(release\.schemaVersion, 1, "RELEASE_SCHEMA_REFUSED"\)/u,
  );
  assert.match(runnerSource, /release\.sourceDirty, false, "RELEASE_DIRTY_SOURCE_REFUSED"/u);
  assert.match(runnerSource, /derivePreviewPackageIdentity\(instanceId\)/u);
  assert.match(
    runnerSource,
    /preview\.appScheme === undefined && legacyPackageIdentity[\s\S]+expectedPackageIdentity\.protocolScheme/u,
  );
  assert.match(
    runnerSource,
    /preview\.appUserModelId === undefined && legacyPackageIdentity[\s\S]+expectedPackageIdentity\.appUserModelId/u,
  );
  assert.match(
    runnerSource,
    /preview\.toastActivatorClsid === undefined[\s\S]+expectedPackageIdentity\.toastActivatorClsid/u,
  );
  assert.match(
    runnerSource,
    /release\.packageIdentity, expectedPackageIdentity, "RELEASE_IDENTITY_MISMATCH"/u,
  );
  assert.match(runnerSource, /snapshotReleaseAsarDirectory\(asarPath, "dist"\)/u);
  assert.match(runnerSource, /snapshotReleaseAsarDirectory\(asarPath, "web"\)/u);
  assert.match(runnerSource, /snapshotReleasePackageAsar\(asarPath\)/u);
  assert.match(runnerSource, /assertReleaseAttestation\(release, runtimePublicKeyPem\)/u);
  assert.match(runnerSource, /verifyPinnedWindowsPublicationToolchain\(/u);
  assert.equal(runnerSource.match(/reverifyWindowsPublicationToolchain\(scope\);/gu)?.length, 4);
  assert.match(runnerSource, /scope\.windowsPowerShellPath/u);
  assert.match(runnerSource, /scope\.moveFileWriteThroughPath/u);
  assert.doesNotMatch(runnerSource, /["']powershell\.exe["']/u);
  assert.match(runnerSource, /RUNTIME_PREVIEW_PUBLIC_KEY_MISMATCH/u);
  assert.match(runnerSource, /EXPLICIT_PUBLIC_KEY_PIN_MISMATCH/u);
  assert.match(runnerSource, /basis: "operator-supplied-before-upgrade"/u);
  assert.match(runnerSource, /format: "spki-der"/u);
  assert.match(runnerSource, /algorithm: "sha256"/u);
  assert.match(runnerSource, /<pre-upgrade-spki-der-sha256>/u);
  assert.match(runnerSource, /must be recorded before the installer runs/u);
  assert.match(runnerSource, /scope\.runtimePublicKeyPath/u);
  assert.match(runnerSource, /main: "dist\/main\.js"/u);
  assert.match(
    runnerSource,
    /sourceAttribution\.head,[\s\S]+release\.sourceCommit,[\s\S]+"INSTALLED_RELEASE_SOURCE_HEAD_MISMATCH"/u,
  );
  assert.match(runnerSource, /"status", "--porcelain=v1", "-z", "--untracked-files=all"/u);
  assert.match(runnerSource, /"LIVE_RUNNER_TRACKED_SOURCE_DIRTY"/u);
  assert.match(runnerSource, /"LIVE_RUNNER_UNTRACKED_SOURCE_DIRTY"/u);
  assert.match(runnerSource, /releaseProvenance: scope\.releaseProvenance/u);
  assert.match(runnerSource, /gitSourceAttributionState\(evidence\)/u);
  assert.match(runnerSource, /"source HEAD unchanged through live run"/u);
  assert.match(runnerSource, /"tracked source unchanged through live run"/u);
  assert.match(runnerSource, /"no unexpected untracked source through live run"/u);
});

test("release attestation requires exact signed fields and a pinned Ed25519 key", () => {
  const pair = generateKeyPairSync("ed25519");
  const file = { path: "dist/main.js", bytes: 4, sha256: "a".repeat(64) };
  const files = [file];
  const snapshot = {
    algorithm: "sha256",
    digest: createHash("sha256")
      .update(Buffer.from(JSON.stringify(files)))
      .digest("hex"),
    files,
  };
  const toolchain = pinnedPackageToolchainProvenance(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const payload = {
    schemaVersion: 1,
    releaseId: "20260911T123456789Z",
    version: "0.2.0-preview.18",
    sourceCommit: "b".repeat(40),
    sourceDirty: false,
    instanceId: "qa-hub-preview-unit",
    packageIdentity: {
      instanceId: "qa-hub-preview-unit",
      executableBaseName: "RelayQaHubPreview-unit",
      installDirectoryName: "RelayQaHubPreview-unit",
      uninstallRegistryKey: "RelayQaHubPreview-unit",
      shortcutName: "QA Hub Project Preview - unit",
      protocolScheme: "qa-hub-preview-unit",
      appUserModelId: "com.relayqahub.desktop.preview.unit",
      toastActivatorClsid: "{CF811D77-1C3F-5A20-B2DA-30AA57C3EB86}",
      displayName: "QA Hub Project Preview (unit)",
    },
    preload: { bytes: 4, sha256: "a".repeat(64), modules: ["electron"] },
    build: {
      producer: "package-preview.mjs",
      artifacts: { desktop: snapshot, web: snapshot },
      toolchain,
    },
    packageContent: snapshot,
  };
  const signature = sign(null, serializeReleaseAttestation(payload), pair.privateKey).toString(
    "base64",
  );
  const release = { ...payload, attestationSignature: signature };
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  assert.deepEqual(assertReleaseAttestation(release, publicKeyPem), {
    algorithm: "Ed25519",
    attestationValid: true,
    signatureBytes: 64,
    publicKeySha256: createHash("sha256")
      .update(pair.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    toolchain: {
      pinSha256: toolchain.pin.sha256,
      nodeSha256: toolchain.node.sha256,
      nodeModulesDigest: toolchain.nodeModules.digest,
      electronZipSha256: toolchain.electron.zipSha256,
      nsisDigest: toolchain.nsis.digest,
      windowsPowerShellSha256: toolchain.windowsPowerShell.sha256,
      moveFileWriteThroughSha256: toolchain.moveFileWriteThrough.sha256,
    },
  });
  assert.throws(
    () => assertReleaseAttestation({ ...release, unexpected: true }, publicKeyPem),
    /RELEASE_FIELDS_INVALID/u,
  );
  assert.throws(
    () =>
      assertReleaseAttestation(
        { ...release, packageContent: { ...snapshot, digest: "c".repeat(64) } },
        publicKeyPem,
      ),
    /RELEASE_PACKAGE_CONTENT_DIGEST_INVALID|RELEASE_ATTESTATION_INVALID/u,
  );
  const forgedPayload = {
    ...payload,
    build: {
      ...payload.build,
      toolchain: {
        ...toolchain,
        nodeModules: { ...toolchain.nodeModules, digest: "f".repeat(64) },
      },
    },
  };
  const forgedRelease = {
    ...forgedPayload,
    attestationSignature: sign(
      null,
      serializeReleaseAttestation(forgedPayload),
      pair.privateKey,
    ).toString("base64"),
  };
  assert.throws(
    () => assertReleaseAttestation(forgedRelease, publicKeyPem),
    /RELEASE_TOOLCHAIN_PROVENANCE_MISMATCH/u,
  );
});

test("runner normalizes only documented preview identity omissions", () => {
  const legacy = normalizePreviewPackageConfigIdentity({}, "qa-hub-preview-7c86");
  assert.equal(legacy.normalizedPreview.appScheme, "qa-hub-preview");
  assert.equal(legacy.normalizedPreview.appUserModelId, "com.relayqahub.desktop.preview");
  assert.equal(
    legacy.normalizedPreview.toastActivatorClsid,
    "{67209CEA-77EF-5AC8-BC78-C571C64CBAF2}",
  );
  assert.throws(
    () => normalizePreviewPackageConfigIdentity({}, "qa-hub-preview-final-sol-0909"),
    /PREVIEW_SCHEME_MISMATCH/u,
  );
  const current = normalizePreviewPackageConfigIdentity(
    {
      appScheme: "qa-hub-preview-v21-e2e-fresh-0910",
      appUserModelId: "com.relayqahub.desktop.preview.v21.e2e.fresh.0910",
    },
    "qa-hub-preview-v21-e2e-fresh-0910",
  );
  assert.equal(
    current.normalizedPreview.toastActivatorClsid,
    "{27F8E9AF-5D78-5B08-8ED1-4E810F2046D5}",
  );
  assert.throws(
    () =>
      normalizePreviewPackageConfigIdentity(
        {
          appScheme: "qa-hub-preview-final-sol-0909",
          appUserModelId: "com.relayqahub.desktop.preview.final.sol.0909",
          toastActivatorClsid: "{00000000-0000-5000-8000-000000000000}",
        },
        "qa-hub-preview-final-sol-0909",
      ),
    /PREVIEW_TOAST_CLSID_IDENTITY_MISMATCH/u,
  );
});

test("toast body follows the frozen v1.1 Inbox shape and accepts a future explicit body", () => {
  assert.equal(durableToastBody({ type: "occurrence.appended" }), "occurrence.appended");
  assert.equal(
    durableToastBody({ type: "occurrence.appended", body: "QA-12 · Login failure" }),
    "QA-12 · Login failure",
  );
  assert.throws(() => durableToastBody({ type: "" }), /INVALID_TOAST_BODY/u);
});

test("live notification reads request the base representation with the durable body", () => {
  assert.equal(
    liveRequestAccept("/api/v1/notifications?projectId=10000000-0000-4000-8000-000000000001"),
    "application/json",
  );
  assert.equal(liveRequestAccept("/api/v1/bugs"), "application/vnd.relay-qa-hub.v1.1+json");
});

test("detail classifier requires an exact GET path and preserves the project header", () => {
  const bugId = "10000000-0000-4000-8000-000000000001";
  const projectId = "20000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    classifyBugDetailRequest(
      {
        requestId: "9.2",
        method: "GET",
        url: `qa-hub-preview-test://app/api/v1/bugs/${bugId}`,
        headers: { "X-QA-Project-ID": projectId },
      },
      bugId,
    ),
    { projectId, requestId: "9.2" },
  );
  assert.equal(
    classifyBugDetailRequest(
      { method: "GET", url: `qa-hub-preview-test://app/api/v1/bugs/${bugId}?extra=1` },
      bugId,
    ),
    null,
  );
  assert.equal(
    classifyBugDetailRequest(
      { method: "GET", url: `qa-hub-preview-test://app/api/v1/bugs/${bugId}/comments` },
      bugId,
    ),
    null,
  );
});

test("notification fixture project keys satisfy the API uppercase key contract", () => {
  assert.equal(notificationProjectKey("ea8556055d1044f79a4bbb4b59b10176", "A"), "NEA8556055DA");
  assert.match(
    notificationProjectKey("0123456789abcdef0123456789abcdef", "B"),
    /^[A-Z][A-Z0-9]{1,15}$/u,
  );
  assert.throws(() => notificationProjectKey("too-short", "A"), /RUN_ID_INVALID/u);
  assert.throws(
    () => notificationProjectKey("0123456789abcdef0123456789abcdef", "C"),
    /PROJECT_SUFFIX_INVALID/u,
  );
});

test("fresh-project Bug keys are predicted without creating a probe Bug", () => {
  assert.equal(expectedBugKey("N0123456789A", 1), "N0123456789A-1");
  assert.equal(expectedBugKey("N0123456789A", 2), "N0123456789A-2");
  assert.throws(() => expectedBugKey("bad", 1), /PROJECT_KEY_INVALID/u);
  assert.throws(() => expectedBugKey("N0123456789A", 0), /BUG_ORDINAL_INVALID/u);
});

test("WPN correlation binds the exact AUMID, boundary, TrackingId, message, and session", () => {
  const appUserModelId = "com.relayqahub.desktop.preview.test";
  const boundary = { capturedAt: "2026-09-10T00:00:00.000Z", newestRecordId: 100 };
  const row = (eventId, recordId, extra = {}) => ({
    eventId,
    recordId,
    timeCreated: `2026-09-10T00:00:0${recordId - 100}.000Z`,
    appUserModelId,
    trackingId: "5638",
    ...extra,
  });
  const snapshot = {
    queriedAt: "2026-09-10T00:00:10.000Z",
    events: [
      row(2418, 101, { notificationType: "toast" }),
      row(3052, 102, { sessionId: 2, messageId: "{message}" }),
      row(3153, 103, { sessionId: 2, messageId: "{message}" }),
      row(2418, 99, { notificationType: "toast" }),
      row(2418, 104, {
        appUserModelId: "com.relayqahub.desktop.preview.other",
        notificationType: "toast",
      }),
    ],
  };
  const result = correlateWpnToastEvents(boundary, snapshot, appUserModelId);
  assert.equal(result.trackingId, "5638");
  assert.equal(result.messageId, "{message}");
  assert.equal(result.destinationSessionId, 2);
  assert.deepEqual(
    result.events.map((event) => event.recordId),
    [101, 102, 103],
  );
  assert.equal(
    correlateWpnToastEvents(boundary, { ...snapshot, events: [] }, appUserModelId),
    null,
  );
  assert.throws(
    () =>
      correlateWpnToastEvents(
        boundary,
        {
          ...snapshot,
          events: [...snapshot.events, row(2418, 105, { notificationType: "toast" })],
        },
        appUserModelId,
      ),
    /WPN_EVENT_CORRELATION_AMBIGUOUS/u,
  );
  assert.throws(
    () =>
      correlateWpnToastEvents(
        boundary,
        {
          ...snapshot,
          events: [
            row(2418, 103, { notificationType: "toast" }),
            row(3052, 102, { sessionId: 2, messageId: "{message}" }),
            row(3153, 104, { sessionId: 2, messageId: "{message}" }),
          ],
        },
        appUserModelId,
      ),
    /WPN_RECORD_CHAIN_ORDER_INVALID/u,
  );
  assert.throws(
    () =>
      correlateWpnToastEvents(
        boundary,
        {
          ...snapshot,
          events: [
            row(2418, 101, {
              notificationType: "toast",
              timeCreated: "2026-09-10T00:00:03.000Z",
            }),
            row(3052, 102, {
              sessionId: 2,
              messageId: "{message}",
              timeCreated: "2026-09-10T00:00:02.000Z",
            }),
            row(3153, 103, {
              sessionId: 2,
              messageId: "{message}",
              timeCreated: "2026-09-10T00:00:04.000Z",
            }),
          ],
        },
        appUserModelId,
      ),
    /WPN_TIME_CHAIN_ORDER_INVALID/u,
  );
});

test("cross-session WPN delivery is an explicit environment blocker", () => {
  assert.equal(
    assertToastSessionMatch({ destinationSessionId: 2 }, { appSessionId: 2, observerSessionId: 2 }),
    true,
  );
  assert.throws(
    () =>
      assertToastSessionMatch(
        { destinationSessionId: 1 },
        { appSessionId: 2, observerSessionId: 2 },
      ),
    (error) =>
      error.message === "WINDOWS_TOAST_SESSION_MISMATCH" &&
      error.code === "WINDOWS_TOAST_SESSION_MISMATCH" &&
      error.classification === "environment_blocker",
  );
});

test("B3 history requires one exact scoped v2 entry and rejects v1", () => {
  const expected = {
    notificationId: "10000000-0000-4000-8000-000000000001",
    acknowledged: false,
    projectId: "20000000-0000-4000-8000-000000000001",
    userId: "30000000-0000-4000-8000-000000000001",
    bugId: "40000000-0000-4000-8000-000000000001",
  };
  assert.deepEqual(
    exactNotificationHistoryV2Entry(
      { schemaVersion: 2, entries: [{ notificationId: "unrelated" }, expected] },
      expected,
    ),
    expected,
  );
  assert.throws(
    () =>
      exactNotificationHistoryV2Entry(
        { schemaVersion: 1, notificationIds: [expected.notificationId] },
        expected,
      ),
    /NOTIFICATION_HISTORY_SCHEMA_V2_REQUIRED/u,
  );
  assert.throws(
    () =>
      exactNotificationHistoryV2Entry(
        { schemaVersion: 2, entries: [expected, expected] },
        expected,
      ),
    /NOTIFICATION_HISTORY_ENTRY_COUNT_MISMATCH/u,
  );
  assert.throws(
    () =>
      exactNotificationHistoryV2Entry(
        { schemaVersion: 2, entries: [{ ...expected, bugId: "wrong" }] },
        expected,
      ),
    /NOTIFICATION_HISTORY_ROUTE_MISMATCH/u,
  );
});

test("acknowledged restart waits for a successful Inbox reconciliation that returns B3", () => {
  assert.match(runnerSource, /desktop\.notification\.inbox\.reconciled/u);
  assert.match(runnerSource, /ACKNOWLEDGED_B3_INBOX_RECONCILED/u);
  assert.match(runnerSource, /item\.notificationIds\.includes\(notice3\.id\)/u);
  assert.match(runnerSource, /item\.unreadNotificationIds\.includes\(notice3\.id\)/u);
  assert.match(runnerSource, /item\.locallyAcknowledgedNotificationIds\.includes\(notice3\.id\)/u);
  assert.match(
    runnerSource,
    /acknowledgedReconciliation\.presentationAttemptedNotificationIds\.includes\(notice3\.id\)/u,
  );
  const acknowledgedRestart = runnerSource.slice(
    runnerSource.indexOf('await launch("route-3-acknowledged"'),
    runnerSource.indexOf("proof.fixtures.bugs ="),
  );
  assert.doesNotMatch(acknowledgedRestart, /await delay\(10_000\)/u);
});

test("evidence redaction removes auth material from keys and free text", () => {
  const secret = "gm-secret-value";
  const value = redactEvidence(
    {
      authorization: `Bearer ${secret}`,
      nested: {
        accessToken: "token-value",
        joinCode: "0042",
        initializationLink: "http://lan/#initialize=credential-value",
        safe: `prefix ${secret} suffix`,
      },
      line: "Bearer abc.def_123",
    },
    new Set([secret]),
  );
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("token-value"), false);
  assert.equal(serialized.includes("0042"), false);
  assert.equal(serialized.includes("credential-value"), false);
  assert.match(serialized, /REDACTED/u);
});

test("Relay process fingerprint includes canonical and pre-existing processes", () => {
  const snapshot = {
    processes: [
      {
        pid: 22,
        parentPid: 2,
        name: "RelayQaHubPreview-test.exe",
        path: "C:\\isolated\\RelayQaHubPreview-test\\RelayQaHubPreview-test.exe",
        startedAt: "2026-09-10T00:00:00.000Z",
        commandLineSha256: "b".repeat(64),
      },
      {
        pid: 11,
        parentPid: 1,
        name: "RelayQaHub.exe",
        path: "D:\\Relay-QA-Hub\\RelayQaHub.exe",
        startedAt: "2026-09-09T00:00:00.000Z",
        commandLineSha256: "a".repeat(64),
      },
    ],
  };
  assert.deepEqual(
    relayProcessFingerprint(snapshot).map((item) => item.pid),
    [11, 22],
  );
});

test("toast helper performs exact title/body lookup and only invokes through InvokePattern", () => {
  assert.match(TOAST_UIA_PS, /Get-Content[^\n]+-Encoding utf8/u);
  assert.match(TOAST_UIA_PS, /AutomationElement\]::NameProperty/u);
  assert.match(TOAST_UIA_PS, /\$inputData\.title/u);
  assert.match(TOAST_UIA_PS, /\$inputData\.body/u);
  assert.match(TOAST_UIA_PS, /InvokePattern\]::Pattern/u);
  assert.match(TOAST_UIA_PS, /AMBIGUOUS_EXACT_TOAST/u);
  assert.match(TOAST_UIA_PS, /readyPath/u);
  assert.match(TOAST_UIA_PS, /FileMode\]::CreateNew/u);
  assert.match(TOAST_UIA_PS, /observerSessionId/u);
  assert.match(TOAST_UIA_PS, /appSessionId/u);
  assert.match(TOAST_UIA_PS, /activeConsoleSessionId/u);
  assert.match(TOAST_UIA_PS, /wtsSessions/u);
  assert.match(TOAST_UIA_PS, /ShellExperienceHost\.exe/u);
  assert.doesNotMatch(TOAST_UIA_PS, /SendKeys|mouse_event|SetCursorPos/iu);
});

test("PowerShell JSON publication is atomic, create-only, and cleans only its temporary file", () => {
  assert.match(ATOMIC_EXCLUSIVE_JSON_PS, /Path\]::Combine\(\$directory/u);
  assert.match(ATOMIC_EXCLUSIVE_JSON_PS, /NewGuid\(\)\.ToString\('N'\)/u);
  assert.match(ATOMIC_EXCLUSIVE_JSON_PS, /FileMode\]::CreateNew/u);
  assert.match(ATOMIC_EXCLUSIVE_JSON_PS, /\$stream\.Flush\(\$true\)/u);
  assert.match(ATOMIC_EXCLUSIVE_JSON_PS, /\$stream\.Dispose\(\)/u);
  assert.match(ATOMIC_EXCLUSIVE_JSON_PS, /File\]::Move\(\$temporary, \$target\)/u);
  assert.match(
    ATOMIC_EXCLUSIVE_JSON_PS,
    /\$temporaryCreated -and -not \$published[\s\S]+File\]::Delete\(\$temporary\)/u,
  );
  assert.ok(
    ATOMIC_EXCLUSIVE_JSON_PS.indexOf("$stream.Flush($true)") <
      ATOMIC_EXCLUSIVE_JSON_PS.indexOf("[IO.File]::Move($temporary, $target)"),
  );

  const root = fs.mkdtempSync(path.join(tmpdir(), "qa-hub-atomic-json-"));
  const target = path.join(root, "ready.json");
  const harness = path.join(root, "atomic-json.test.ps1");
  try {
    fs.writeFileSync(
      harness,
      `${ATOMIC_EXCLUSIVE_JSON_PS}\n$target = $env:QA_HUB_ATOMIC_JSON_TARGET\nWriteExclusiveJson $target ([ordered]@{ value='first' })\n$secondFailed = $false\ntry { WriteExclusiveJson $target ([ordered]@{ value='second' }) } catch { $secondFailed = $true }\n$leaf = [IO.Path]::GetFileName($target)\n[pscustomobject]@{ secondFailed=$secondFailed; temporaryCount=@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($target)) -Filter ([string]::Concat($leaf,'.tmp-*'))).Count } | ConvertTo-Json -Compress\n`,
      "utf8",
    );
    const result = spawnSync(
      WINDOWS_POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
      {
        encoding: "utf8",
        env: { ...process.env, QA_HUB_ATOMIC_JSON_TARGET: target },
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { value: "first" });
    assert.deepEqual(JSON.parse(result.stdout), { secondFailed: true, temporaryCount: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("embedded PowerShell helpers are syntactically valid", () => {
  const parser = [
    "$source=[Console]::In.ReadToEnd()",
    "$tokens=$null",
    "$errors=$null",
    "[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)|Out-Null",
    "if($errors.Count){$errors|ForEach-Object{[Console]::Error.WriteLine($_.Message)};exit 1}",
  ].join(";");
  for (const source of [HOST_SNAPSHOT_PS, TOAST_UIA_PS, WPN_EVENT_PS]) {
    const parsed = spawnSync(
      WINDOWS_POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-Command", parser],
      { input: source, encoding: "utf8", windowsHide: true },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test("host and WPN helpers capture session topology and the exact event chain", () => {
  assert.match(HOST_SNAPSHOT_PS, /WTSGetActiveConsoleSessionId/u);
  assert.match(HOST_SNAPSHOT_PS, /WTSEnumerateSessions/u);
  assert.match(HOST_SNAPSHOT_PS, /sessionId=\[int\]\$_.SessionId/u);
  assert.match(HOST_SNAPSHOT_PS, /explorer\.exe/u);
  assert.match(HOST_SNAPSHOT_PS, /ShellExperienceHost\.exe/u);
  assert.match(WPN_EVENT_PS, /Microsoft-Windows-PushNotification-Platform\/Operational/u);
  assert.match(WPN_EVENT_PS, /2418,3052,3153/u);
  assert.match(WPN_EVENT_PS, /\[StringComparer\]::Ordinal\.Equals/u);
  assert.match(WPN_EVENT_PS, /TrackingId/u);
  assert.match(WPN_EVENT_PS, /SessionId/u);
  assert.match(runnerSource, /WPN_RECORD_CHAIN_ORDER_INVALID/u);
  assert.match(runnerSource, /WPN_TIME_CHAIN_ORDER_INVALID/u);
  assert.match(runnerSource, /\$\{label\}-wpn-query-/u);
  assert.match(runnerSource, /\$\{label\}-wpn-\$\{inputValue\.mode\}-error-/u);
  assert.match(runnerSource, /\$\{label\}-wpn-timeout\.json/u);
});

test("toast watcher handles early PowerShell rejection before delayed invocation", () => {
  assert.match(runnerSource, /let watcherOutcome = null/u);
  assert.match(runnerSource, /watcherOutcome = \{ error \}/u);
  assert.match(runnerSource, /if \(watcherOutcome\?\.error\) throw watcherOutcome\.error/u);
  assert.match(runnerSource, /signalTimeoutMs: 120_000/u);
  assert.match(runnerSource, /timeout: 160_000/u);
});

test("native session preflight gates every business write with a real canonical toast", () => {
  const launch = runnerSource.indexOf('launch("quit-probe"');
  const arm = runnerSource.indexOf("const sessionProbeWatcher = await armToastWatcher(", launch);
  const boundary = runnerSource.indexOf('captureWpnBoundary("session-preflight")', arm);
  const submit = runnerSource.indexOf("showNativeSessionProbe(", boundary);
  const correlate = runnerSource.indexOf(
    "const sessionProbeCorrelation = await waitForWpnCorrelation(",
    submit,
  );
  const observe = runnerSource.indexOf("sessionProbeWatcher.finishObserve()", correlate);
  const passed = runnerSource.indexOf("nativeSessionPreflightPassed = true", observe);
  const stop = runnerSource.indexOf('stopOwn("quit-probe")', passed);
  const gmPost = runnerSource.indexOf('api("GM login", "POST"', stop);
  assert.ok(
    [launch, arm, boundary, submit, correlate, observe, passed, stop, gmPost].every(
      (offset, index, offsets) => offset >= 0 && (index === 0 || offset > offsets[index - 1]),
    ),
  );
  assert.match(runnerSource, /new electron\.Notification/u);
  assert.match(runnerSource, /Notification\.isSupported\(\)/u);
  assert.match(runnerSource, /BUSINESS_WRITE_BEFORE_NATIVE_SESSION_PREFLIGHT/u);
  assert.match(runnerSource, /environmentOnly: true[\s\S]+productPass: false/u);
  assert.match(runnerSource, /status: "blocked"/u);
  assert.match(runnerSource, /blocker\.classification = "environment_blocker"/u);
  assert.match(
    runnerSource,
    /if \(sessionProbeSubmitted\)[\s\S]+await closeNativeSessionProbe\(\)/u,
  );
});

test("each case arms a ready watcher and WPN boundary before its single Bug creation", () => {
  for (const [label, createLabel] of [
    ["a1", "actor creates assigned A1 Bug"],
    ["a2", "actor creates assigned A2 Bug"],
    ["b3", "separate actor creates assigned B3 Bug"],
  ]) {
    const arm = runnerSource.indexOf(`armToastWatcher("${label}"`);
    const boundary = runnerSource.indexOf(`captureWpnBoundary("${label}")`, arm);
    const create = runnerSource.indexOf(`api("${createLabel}"`, boundary);
    const correlate = runnerSource.indexOf(`waitForWpnCorrelation("${label}"`, create);
    const shown = runnerSource.indexOf(
      `item.event === "desktop.notification.shown" && item.notificationId === notice${label === "a1" ? "1" : label === "a2" ? "2" : "3"}.id`,
      correlate,
    );
    const observed = runnerSource.indexOf(
      `watcher${label === "a1" ? "1" : label === "a2" ? "2" : "3"}.waitForObserved()`,
      shown,
    );
    assert.ok(
      arm >= 0 &&
        boundary > arm &&
        create > boundary &&
        correlate > create &&
        shown > correlate &&
        observed > shown,
    );
    assert.equal(runnerSource.split(`api("${createLabel}"`).length - 1, 1);
  }
  assert.match(runnerSource, /proof\.error[\s\S]+classification: error\?\.classification/u);
});

test("B3 restart proof replays unacknowledged route, globally clicks it, then suppresses it", () => {
  assert.doesNotMatch(runnerSource, /historyBeforeRestart\.notificationIds/u);
  assert.match(runnerSource, /notificationId: notice3\.id/u);
  assert.match(runnerSource, /checkB3History\("before restart", historyBeforeRestart, false\)/u);
  assert.match(runnerSource, /projectId: projectB\.id/u);
  assert.match(runnerSource, /userId: targetB\.userId/u);
  assert.match(runnerSource, /bugId: created3\.bug\.id/u);
  const signedOutBeforeRestart = runnerSource.indexOf(
    "await signOut(renderer);",
    runnerSource.indexOf('checkB3History("before restart"'),
  );
  const stopUnacknowledged = runnerSource.indexOf('stopOwn("controlled-restart-stop")');
  const restartLaunch = runnerSource.indexOf('launch("route-2-restart"', stopUnacknowledged);
  const restartWatcher = runnerSource.indexOf('armToastWatcher("b3-restart"', restartLaunch);
  const restartBoundary = runnerSource.indexOf('captureWpnBoundary("b3-restart")', restartWatcher);
  const restartLogin = runnerSource.indexOf(
    "rendererLogin(renderer, projectB.id, targetName)",
    restartBoundary,
  );
  const restartCorrelation = runnerSource.indexOf(
    'waitForWpnCorrelation("b3-restart"',
    restartLogin,
  );
  const restartInvoke = runnerSource.indexOf("watcher3Restart.invoke()", restartCorrelation);
  const globalSource = runnerSource.indexOf(
    'check("B3 restart click source", clicked3.source, "global")',
    restartInvoke,
  );
  const acknowledged = runnerSource.indexOf(
    'checkB3History("after restart global click", historyAfterClick, true)',
    globalSource,
  );
  const acknowledgedRestart = runnerSource.indexOf('launch("route-3-acknowledged"', acknowledged);
  const noReplay = runnerSource.indexOf(
    '"acknowledged B3 not replayed on next restart"',
    acknowledgedRestart,
  );
  assert.ok(
    [
      signedOutBeforeRestart,
      stopUnacknowledged,
      restartLaunch,
      restartWatcher,
      restartBoundary,
      restartLogin,
      restartCorrelation,
      restartInvoke,
      globalSource,
      acknowledged,
      acknowledgedRestart,
      noReplay,
    ].every(
      (offset, index, offsets) => offset >= 0 && (index === 0 || offset > offsets[index - 1]),
    ),
  );
  assert.match(
    runnerSource,
    /checkB3History\("after acknowledged restart", historyAfterAcknowledgedRestart, true\)/u,
  );
});

test("A1 and A2 require global activation events before route assertions", () => {
  for (const ordinal of [1, 2]) {
    const invoke = runnerSource.indexOf(`watcher${ordinal}.invoke()`);
    const clicked = runnerSource.indexOf(
      `item.event === "desktop.notification.clicked" && item.notificationId === notice${ordinal}.id`,
      invoke,
    );
    const source = runnerSource.indexOf(
      `check("A${ordinal} click source", clicked${ordinal}.source, "global")`,
      clicked,
    );
    assert.ok(invoke >= 0 && clicked > invoke && source > clicked);
  }
});

test("second A notification is observed in A and only then clicked from B", () => {
  const draftVerified = runnerSource.indexOf('"B_DRAFT_ROUNDTRIP"');
  const enterA = runnerSource.indexOf("await switchProject(renderer, projectA.id);", draftVerified);
  const createA2 = runnerSource.indexOf("const description2", enterA);
  const shownA2 = runnerSource.indexOf('"A2_SHOWN"', createA2);
  const enterB = runnerSource.indexOf("await switchProject(renderer, projectB.id);", shownA2);
  const revokeA = runnerSource.indexOf('"GM revokes target A membership"', enterB);
  const invokeA2 = runnerSource.indexOf("await watcher2.invoke();", revokeA);
  assert.ok(
    [draftVerified, enterA, createA2, shownA2, enterB, revokeA, invokeA2].every(
      (offset, index, offsets) => offset >= 0 && (index === 0 || offset > offsets[index - 1]),
    ),
  );
});

test("runner directly launches the canonical EXE with isolated config and verified cleanup", () => {
  assert.doesNotMatch(runnerSource, /taskkill|Stop-Process|TerminateProcess|\.kill\s*\(/iu);
  assert.doesNotMatch(runnerSource, /copyTreeExclusive|installed-copy|copiedExe/u);
  assert.match(runnerSource, /child = spawn\(\s*scope\.executablePath/u);
  assert.match(runnerSource, /cwd: scope\.installedRoot/u);
  assert.match(runnerSource, /env\.QA_HUB_PREVIEW_DESKTOP_CONFIG = config\.file/u);
  assert.match(runnerSource, /\$\{phase\} exact installed canonical EXE/u);
  assert.match(runnerSource, /\$\{phase\} exact isolated profile/u);
  assert.match(runnerSource, /canonical inputs unchanged before launch/u);
  assert.match(runnerSource, /CLEANUP_PID_MISMATCH/u);
  assert.match(runnerSource, /FINAL_CLEANUP_NO_VERIFIED_GRACEFUL_CHANNEL/u);
  assert.match(runnerSource, /proof\.cleanupError[\s\S]+proof\.passed = false/u);
  assert.match(runnerSource, /relayProcessFingerprint\(hostAfter\)/u);
  const quitRequest = runnerSource.indexOf("OWN_APP_QUIT_SCHEDULED");
  const inspectorDetach = runnerSource.indexOf("stoppingInspector.close()", quitRequest);
  const exitWait = runnerSource.indexOf("stoppingChild.exitCode === null", inspectorDetach);
  assert.ok(quitRequest >= 0 && inspectorDetach > quitRequest && exitWait > inspectorDetach);
  assert.match(runnerSource, /app\.quit\(\)/u);
  assert.match(runnerSource, /NO_GRACEFUL_CHANNEL/u);
});
