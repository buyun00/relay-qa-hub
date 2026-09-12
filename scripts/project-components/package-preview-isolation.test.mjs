import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import asar from "@electron/asar";

import {
  assertCleanPreviewPackageSource,
  derivePreviewPackageIdentity,
  deriveToastActivatorClsid,
} from "./preview-package-identity.mjs";
import {
  assertSandboxPreloadBinding,
  inspectSandboxPreload,
} from "./sandbox-preload-require-gate.mjs";
import {
  assertReleaseContentBinding,
  assertSignedUpdateManifest,
  assertUpdateManifestSuccessor,
  canonicalDirectChildDirectory,
  commitPreparedPublication as commitPreparedPublicationWithValidator,
  serializeReleaseAttestation,
  serializeUpdateManifestPayload,
  snapshotInstalledPreviewDirectory,
  snapshotReleaseAsarDirectory,
  snapshotReleaseDirectory,
  snapshotReleasePackageAsar,
  snapshotReleasePackageDirectory,
  validateReleaseContentSnapshot,
  validatePreparedPreviewPublicationReceipt,
  verifyCommittedPublication,
  verifyPreviewInstallerPayload,
  writeFileExclusiveDurable,
  publishFileExclusiveDurable,
} from "./release-content-binding.mjs";
import {
  ELECTRON_WINDOWS_ZIP,
  PACKAGE_TOOLCHAIN_PIN_RELATIVE_PATH,
  assertPinnedElectronArchive,
  createPackageToolchainPin,
  verifyPinnedPackageToolchain,
  verifyPinnedWindowsPublicationToolchain,
} from "./package-toolchain-provenance.mjs";
import {
  MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH,
  moveFileWriteThrough,
  resolveWindowsPowerShellExecutable,
} from "./windows-write-through.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "../..");
const packageSource = readFileSync(resolve(scriptRoot, "package-preview.mjs"), "utf8");
const installerSource = readFileSync(resolve(scriptRoot, "preview-installer.nsi"), "utf8");
const updaterSource = readFileSync(resolve(sourceRoot, "apps/desktop/scripts/updater.nsi"), "utf8");
const gitAttributesSource = readFileSync(resolve(sourceRoot, ".gitattributes"), "utf8");
const writeThroughHelperSource = readFileSync(
  resolve(scriptRoot, "move-file-write-through.ps1"),
  "utf8",
);

const expectGateCode = (source, code) =>
  assert.throws(
    () => inspectSandboxPreload(source, "fixture-preload.cjs"),
    (error) => error?.code === code,
  );

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function validateGenericPreparedReceipt({ transaction, phase }) {
  assert.ok(typeof phase === "string" && phase.length > 0);
  assert.equal(sha256(readFileSync(transaction.receiptPath)), transaction.receiptSha256);
}

function commitPreparedPublication(options) {
  return commitPreparedPublicationWithValidator({
    ...options,
    validatePreparedReceipt: options.validatePreparedReceipt ?? validateGenericPreparedReceipt,
  });
}

function createPreparedPreviewFixture({
  root,
  pair,
  sequence,
  destination = join(root, "latest.json"),
}) {
  const releaseId = `20260911T12345${String(sequence).padStart(4, "0")}Z`;
  const version = `0.2.0-preview.${sequence}`;
  const installerName = `qa-hub-preview-unit-${version}-${releaseId}.exe`;
  const installerPath = join(root, installerName);
  const installerBytes = Buffer.from(`installer-${sequence}`);
  writeFileSync(installerPath, installerBytes, { flag: "wx" });
  const installerSha256 = sha256(installerBytes);
  const payload = {
    schemaVersion: 1,
    releaseId,
    version,
    publishedAt: `2026-09-11T12:34:${String(sequence % 60).padStart(2, "0")}.000Z`,
    archive: {
      url: `/downloads/${installerName}`,
      size: installerBytes.length,
      sha256: installerSha256,
    },
  };
  const manifest = {
    ...payload,
    signature: sign(null, serializeUpdateManifestPayload(payload), pair.privateKey).toString(
      "base64",
    ),
  };
  const replacementBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const receipt = {
    schemaVersion: 2,
    kind: "relay-qa-hub-preview-publication-receipt",
    releaseId,
    version,
    sha256: installerSha256,
    bytes: installerBytes.length,
    publication: {
      commitProtocol: "prepared-receipt-active-claim-create-only-latest-v2",
      manifestUrl: `http://127.0.0.1:4319/downloads/${destination.split(/[\\/]/u).at(-1)}`,
      manifestBytes: replacementBytes.length,
      manifestSha256: sha256(replacementBytes),
      installerUrl: `http://127.0.0.1:4319/downloads/${installerName}`,
      installerName,
      installerBytes: installerBytes.length,
      installerSha256,
      releaseId,
      version,
    },
  };
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  return Object.freeze({
    destination,
    temporary: join(root, `latest-${sequence}.tmp`),
    receiptPath: join(root, `receipt-${sequence}.json`),
    receiptBytes: Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"),
    replacementBytes,
    installerName,
    installerPath,
    installerBytes,
    validatePreparedReceipt: (evidence) =>
      validatePreparedPreviewPublicationReceipt(evidence, publicKeyPem),
  });
}

const fakeNativeHarnessSource = `param(
  [ValidateSet('CreateOnly')][string] $Mode = 'CreateOnly',
  [string] $HelperPath = $env:QA_HUB_TEST_REAL_HELPER,
  [Parameter(Mandatory = $true)][string] $Source,
  [Parameter(Mandatory = $true)][string] $Destination,
  [Parameter(Mandatory = $true)][string] $ExpectedSourceSha256,
  [Parameter(Mandatory = $true)][int] $RetryMilliseconds
)
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class QaHubMoveFileWriteThroughNative
{
    private const uint MOVEFILE_WRITE_THROUGH = 0x8;
    private static int callCount;
    private static int barrierUsed;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string existingName, string newName, uint flags);

    private static void WaitAtBarrier(string destination)
    {
        string ready = Environment.GetEnvironmentVariable("QA_HUB_TEST_NATIVE_READY");
        string release = Environment.GetEnvironmentVariable("QA_HUB_TEST_NATIVE_RELEASE");
        string target = Environment.GetEnvironmentVariable("QA_HUB_TEST_NATIVE_BARRIER_TARGET");
        if (String.IsNullOrEmpty(ready) || String.IsNullOrEmpty(release)) return;
        if (!String.IsNullOrEmpty(target) && destination.IndexOf(target, StringComparison.OrdinalIgnoreCase) < 0) return;
        if (Interlocked.Exchange(ref barrierUsed, 1) != 0) return;
        using (FileStream stream = new FileStream(ready, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        {
            byte[] bytes = new byte[] { 1 };
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
        Stopwatch timer = Stopwatch.StartNew();
        while (!File.Exists(release))
        {
            if (timer.ElapsedMilliseconds > 10000) throw new TimeoutException("TEST_NATIVE_BARRIER_TIMEOUT");
            Thread.Sleep(5);
        }
    }

    public static int Move(string source, string destination)
    {
        int call = Interlocked.Increment(ref callCount);
        WaitAtBarrier(destination);
        string sequence = Environment.GetEnvironmentVariable("QA_HUB_TEST_NATIVE_ERRORS");
        if (!String.IsNullOrEmpty(sequence))
        {
            string[] values = sequence.Split(',');
            if (call <= values.Length) return Int32.Parse(values[call - 1]);
        }
        if (!MoveFileExW(source, destination, MOVEFILE_WRITE_THROUGH))
            return Marshal.GetLastWin32Error();

        string historyOutcome = Environment.GetEnvironmentVariable("QA_HUB_TEST_HISTORY_OUTCOME");
        if (!String.IsNullOrEmpty(historyOutcome) && destination.IndexOf(".history-", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            if (historyOutcome.StartsWith("winner:", StringComparison.Ordinal))
            {
                string original = destination + ".test-original";
                if (!MoveFileExW(destination, original, MOVEFILE_WRITE_THROUGH))
                    return Marshal.GetLastWin32Error();
                byte[] winner = Convert.FromBase64String(historyOutcome.Substring("winner:".Length));
                using (FileStream stream = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                {
                    stream.Write(winner, 0, winner.Length);
                    stream.Flush(true);
                }
            }
            return 5;
        }
        if (Environment.GetEnvironmentVariable("QA_HUB_TEST_CLAIM_UNKNOWN_SUCCESS") == "1" && destination.IndexOf(".publication-claim-", StringComparison.OrdinalIgnoreCase) >= 0)
            return 5;
        if (Environment.GetEnvironmentVariable("QA_HUB_TEST_INSTALLER_UNKNOWN_SUCCESS") == "1" && destination.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            return 5;
        if (Environment.GetEnvironmentVariable("QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS") == "1")
        {
            string target = Environment.GetEnvironmentVariable("QA_HUB_TEST_DURABLE_UNKNOWN_TARGET");
            if (String.IsNullOrEmpty(target) || destination.IndexOf(target, StringComparison.OrdinalIgnoreCase) >= 0)
                return 5;
        }
        if (Environment.GetEnvironmentVariable("QA_HUB_TEST_RESTORE_UNKNOWN_SUCCESS") == "1" && source.IndexOf(".publication-claim-", StringComparison.OrdinalIgnoreCase) >= 0)
            return 5;
        return 0;
    }
}
'@
if ([String]::IsNullOrEmpty($HelperPath)) { throw 'TEST_REAL_HELPER_REQUIRED' }
& $HelperPath -Mode $Mode -Source $Source -Destination $Destination -ExpectedSourceSha256 $ExpectedSourceSha256 -RetryMilliseconds $RetryMilliseconds
exit $LASTEXITCODE
`;

function writeFakeNativeHarness(root) {
  const harness = join(root, "fake-native-harness.ps1");
  if (!existsSync(harness)) {
    writeFileSync(harness, fakeNativeHarnessSource.replace(/(?<!\r)\n/gu, "\r\n"), {
      flag: "wx",
    });
  }
  return harness;
}

function collectChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

async function waitForFile(file, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`WAIT_FOR_FILE_TIMEOUT:${file}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function startFakeNativeMove({
  root,
  source,
  destination,
  expectedSourceSha256,
  retryMilliseconds = 1000,
  readyPath,
  releasePath,
  nativeErrors,
}) {
  const harness = writeFakeNativeHarness(root);
  const child = spawn(
    resolveWindowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      harness,
      "-HelperPath",
      resolve(scriptRoot, "move-file-write-through.ps1"),
      "-Source",
      source,
      "-Destination",
      destination,
      "-ExpectedSourceSha256",
      expectedSourceSha256,
      "-RetryMilliseconds",
      String(retryMilliseconds),
    ],
    {
      env: {
        ...process.env,
        QA_HUB_TEST_NATIVE_READY: readyPath ?? "",
        QA_HUB_TEST_NATIVE_RELEASE: releasePath ?? "",
        QA_HUB_TEST_NATIVE_ERRORS: nativeErrors ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  return { child, completion: collectChild(child) };
}

function parseLastJson(value) {
  const line = value.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  return line ? JSON.parse(line) : null;
}

function writeFixtureFile(root, relative, value) {
  const file = join(root, ...relative.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, { flag: "wx" });
  return file;
}

function createToolchainFixture() {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-package-toolchain-"));
  const originalZip = Buffer.from("pinned-electron-archive");
  const checksums = Buffer.from(
    `${JSON.stringify({ [ELECTRON_WINDOWS_ZIP]: sha256(originalZip) })}\n`,
  );
  const lock = writeFixtureFile(root, "package-lock.json", '{"lockfileVersion":3}\n');
  const nodeExecutable = writeFixtureFile(root, "node.exe", "pinned-node-runtime");
  const windowsPowerShellExecutable = resolveWindowsPowerShellExecutable();
  const moveFileWriteThrough = writeFixtureFile(
    root,
    MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH,
    "pinned-move-file-write-through",
  );
  const typescript = writeFixtureFile(root, "node_modules/typescript/bin/tsc", "pinned-tsc");
  writeFixtureFile(root, "node_modules/vite/bin/vite.js", "pinned-vite");
  writeFixtureFile(root, "node_modules/@electron/asar/package.json", '{"version":"1"}\n');
  writeFixtureFile(root, "node_modules/@electron/packager/package.json", '{"version":"1"}\n');
  const electronChecksums = writeFixtureFile(
    root,
    "node_modules/electron/checksums.json",
    checksums,
  );
  const electronArchive = writeFixtureFile(root, `cache/${ELECTRON_WINDOWS_ZIP}`, originalZip);
  const makensis = writeFixtureFile(root, "nsis/makensis.exe", "pinned-makensis");
  writeFixtureFile(root, "nsis/Bin/helper.dll", "pinned-helper");
  const nsisInclude = writeFixtureFile(root, "nsis/Include/MUI.nsh", "pinned-include");
  writeFixtureFile(root, "nsis/Plugins/x86-unicode/plugin.dll", "pinned-plugin");
  writeFixtureFile(root, "nsis/Stubs/zlib-x86-unicode", "pinned-stub");
  const pin = createPackageToolchainPin({
    sourceRoot: root,
    makensisPath: makensis,
    nodeExecutable,
    windowsPowerShellExecutable,
    moveFileWriteThroughPath: moveFileWriteThrough,
  });
  writeFixtureFile(root, PACKAGE_TOOLCHAIN_PIN_RELATIVE_PATH, `${JSON.stringify(pin, null, 2)}\n`);
  return {
    root,
    lock,
    nodeExecutable,
    windowsPowerShellExecutable,
    moveFileWriteThrough,
    typescript,
    electronChecksums,
    electronArchive,
    nsisInclude,
    makensis,
    originals: { checksums, originalZip },
  };
}

test("source-controlled toolchain pin rejects ignored dependency, Electron, and NSIS tampering", () => {
  const fixture = createToolchainFixture();
  const verifyFixture = (makensisPath = fixture.makensis) =>
    verifyPinnedPackageToolchain({
      sourceRoot: fixture.root,
      makensisPath,
      nodeExecutable: fixture.nodeExecutable,
      windowsPowerShellExecutable: fixture.windowsPowerShellExecutable,
      moveFileWriteThroughPath: fixture.moveFileWriteThrough,
    });
  try {
    const verified = verifyFixture();
    assert.equal(
      assertPinnedElectronArchive(verified.provenance, fixture.electronArchive),
      sha256(fixture.originals.originalZip),
    );

    const originalLock = readFileSync(fixture.lock);
    writeFileSync(fixture.lock, '{"lockfileVersion":2}\n');
    assert.throws(verifyFixture, (error) => error?.code === "PACKAGE_TOOLCHAIN_LOCK_MISMATCH");
    writeFileSync(fixture.lock, originalLock);

    const originalTypescript = readFileSync(fixture.typescript);
    writeFileSync(fixture.typescript, "tampered-tsc");
    assert.throws(
      verifyFixture,
      (error) => error?.code === "PACKAGE_TOOLCHAIN_NODE_MODULES_MISMATCH",
    );
    writeFileSync(fixture.typescript, originalTypescript);

    const originalNode = readFileSync(fixture.nodeExecutable);
    writeFileSync(fixture.nodeExecutable, "tampered-node-runtime");
    assert.throws(verifyFixture, (error) => error?.code === "PACKAGE_TOOLCHAIN_NODE_MISMATCH");
    writeFileSync(fixture.nodeExecutable, originalNode);

    const pinPath = join(fixture.root, ...PACKAGE_TOOLCHAIN_PIN_RELATIVE_PATH.split("/"));
    const originalPin = readFileSync(pinPath);
    const tamperedPin = JSON.parse(originalPin.toString("utf8"));
    tamperedPin.windowsPowerShell.sha256 = "0".repeat(64);
    writeFileSync(pinPath, `${JSON.stringify(tamperedPin, null, 2)}\n`);
    assert.throws(
      verifyFixture,
      (error) => error?.code === "PACKAGE_TOOLCHAIN_WINDOWS_POWERSHELL_MISMATCH",
    );
    writeFileSync(pinPath, originalPin);

    const copiedWindowsPowerShell = join(fixture.root, "copied-powershell.exe");
    copyFileSync(fixture.windowsPowerShellExecutable, copiedWindowsPowerShell);
    assert.throws(
      () =>
        verifyPinnedWindowsPublicationToolchain({
          sourceRoot: fixture.root,
          provenance: verified.provenance,
          windowsPowerShellExecutable: copiedWindowsPowerShell,
          moveFileWriteThroughPath: fixture.moveFileWriteThrough,
        }),
      (error) => error?.code === "PACKAGE_TOOLCHAIN_WINDOWS_POWERSHELL_PATH_MISMATCH",
    );

    const originalMoveFileWriteThrough = readFileSync(fixture.moveFileWriteThrough);
    writeFileSync(fixture.moveFileWriteThrough, "tampered-move-file-write-through");
    assert.throws(
      verifyFixture,
      (error) => error?.code === "PACKAGE_TOOLCHAIN_MOVE_FILE_WRITE_THROUGH_MISMATCH",
    );
    writeFileSync(fixture.moveFileWriteThrough, originalMoveFileWriteThrough);
    assert.deepEqual(
      verifyPinnedWindowsPublicationToolchain({
        sourceRoot: fixture.root,
        provenance: verified.provenance,
        windowsPowerShellExecutable: fixture.windowsPowerShellExecutable,
        moveFileWriteThroughPath: fixture.moveFileWriteThrough,
      }),
      {
        windowsPowerShellPath: fixture.windowsPowerShellExecutable,
        moveFileWriteThroughPath: resolve(fixture.moveFileWriteThrough),
      },
    );

    const forgedZip = Buffer.from("forged-electron-archive");
    writeFileSync(fixture.electronArchive, forgedZip);
    writeFileSync(
      fixture.electronChecksums,
      `${JSON.stringify({ [ELECTRON_WINDOWS_ZIP]: sha256(forgedZip) })}\n`,
    );
    assert.throws(
      verifyFixture,
      (error) => error?.code === "PACKAGE_TOOLCHAIN_NODE_MODULES_MISMATCH",
    );
    assert.throws(
      () => assertPinnedElectronArchive(verified.provenance, fixture.electronArchive),
      (error) => error?.code === "PACKAGE_TOOLCHAIN_ELECTRON_ARCHIVE_MISMATCH",
    );
    writeFileSync(fixture.electronChecksums, fixture.originals.checksums);
    writeFileSync(fixture.electronArchive, fixture.originals.originalZip);

    const originalInclude = readFileSync(fixture.nsisInclude);
    writeFileSync(fixture.nsisInclude, "tampered-include");
    assert.throws(verifyFixture, (error) => error?.code === "PACKAGE_TOOLCHAIN_NSIS_MISMATCH");
    writeFileSync(fixture.nsisInclude, originalInclude);

    const originalMakensis = readFileSync(fixture.makensis);
    writeFileSync(fixture.makensis, "tampered-makensis");
    assert.throws(verifyFixture, (error) => error?.code === "PACKAGE_TOOLCHAIN_NSIS_MISMATCH");
    writeFileSync(fixture.makensis, originalMakensis);

    const rogueMakensis = writeFixtureFile(
      fixture.root,
      "rogue-nsis/makensis.exe",
      "rogue-makensis",
    );
    writeFixtureFile(fixture.root, "rogue-nsis/Bin/helper.dll", "rogue-helper");
    writeFixtureFile(fixture.root, "rogue-nsis/Include/MUI.nsh", "rogue-include");
    writeFixtureFile(fixture.root, "rogue-nsis/Plugins/x86-unicode/plugin.dll", "rogue-plugin");
    writeFixtureFile(fixture.root, "rogue-nsis/Stubs/zlib-x86-unicode", "rogue-stub");
    assert.throws(
      () => verifyFixture(rogueMakensis),
      (error) => error?.code === "PACKAGE_TOOLCHAIN_NSIS_MISMATCH",
    );
    assert.doesNotThrow(verifyFixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("preview packaging has a clean-source gate and no shared Windows install identity", () => {
  assert.match(packageSource, /preview-package-identity\.mjs/u);
  assert.ok(
    packageSource.indexOf("assertCleanPreviewPackageSource(config.sourceRoot)") <
      packageSource.indexOf("mkdirSync(root"),
    "the clean-source gate must run before the release directory is created",
  );
  const toolchainGate = packageSource.indexOf("verifyPinnedPackageToolchain({");
  const dependencyImport = packageSource.indexOf('import("@electron/asar")');
  assert.ok(
    toolchainGate >= 0 &&
      toolchainGate < dependencyImport &&
      dependencyImport < packageSource.indexOf("mkdirSync(packagesRoot"),
    "ignored build packages and the NSIS bundle must be pinned before import or output mutation",
  );
  assert.match(packageSource, /toolchain: packageToolchain/u);
  assert.match(packageSource, /assertPinnedElectronArchive\(packageToolchain, zipTarget\)/u);
  assert.equal(
    packageSource.match(/verifyPinnedPackageToolchain\(\{/gu)?.length,
    4,
    "the complete toolchain must be checked before imports, after builds, after the installer, and before publication",
  );
  assert.equal(
    packageSource.match(/assertPinnedElectronArchive\(packageToolchain, zipTarget\)/gu)?.length,
    3,
    "the exact Electron archive must be checked before packaging, after packaging, and before publication",
  );
  assert.match(packageSource, /verifyPreviewInstallerPayload\(/u);
  assert.match(packageSource, /PUBLISHED_INSTALLER_READBACK_MISMATCH/u);
  assert.match(packageSource, /CANDIDATE_MANIFEST_READBACK_MISMATCH/u);
  assert.match(packageSource, /SERVED_MANIFEST_BYTES_MISMATCH/u);
  assert.match(packageSource, /SERVED_INSTALLER_BYTES_MISMATCH/u);
  assert.match(packageSource, /publication-failure\.json/u);
  assert.doesNotMatch(packageSource, /\.\.\.receipt/u);
  assert.match(
    packageSource,
    /const publicationOutput = \{\s*schemaVersion: 1,\s*kind: "relay-qa-hub-preview-publication-output",\s*releaseId,\s*version,\s*sourceCommit,\s*instanceId: config\.instanceId,\s*publicationCommit: summarizePublicationCommit\(publicationCommit\),\s*publicationResult,\s*publicationResultSha256,\s*publicationResultMoveRecovered: publicationResultPublication\.recovered,\s*stateValidation: committedStateValidation,\s*\};\s*console\.log\(\s*JSON\.stringify\(publicationOutput\)/u,
    "stdout must use a public evidence envelope instead of serializing the private receipt",
  );
  assert.match(packageSource, /stage: failureStage/u);
  assert.match(
    packageSource,
    /publicationCommit:\s*summarizePublicationCommit\(publicationCommit\) \?\?[\s\S]+publicationState: errorPublicationState,\s*publicationResultEvidence: publicationResult/u,
    "failure evidence must preserve the sanitized commit state and result evidence",
  );
  assert.match(
    packageSource,
    /name: publicationResultPath \? basename\(publicationResultPath\) : null,\s*sha256: publicationResultSha256 \?\? null,\s*durable: publicationResultDurable,\s*moveRecovered: publicationResultPublication\?\.recovered \?\? null/u,
  );
  for (const field of [
    "restored",
    "restoreRecovered",
    "restoreNativeError",
    "restoreHelperCode",
    "expectedIdentityMatched",
    "actualClaimSha256",
    "lockCommitCause",
    "lockRollbackCause",
    "lockCloseCause",
  ]) {
    assert.match(packageSource, new RegExp(`\\b${field}:`, "u"));
  }
  assert.ok(
    packageSource.indexOf("await fetchReleaseBytes(\n    candidateManifestUrl") <
      packageSource.indexOf("receipt = createReceipt({") &&
      packageSource.indexOf("receipt = createReceipt({") <
        packageSource.indexOf("publicationCommit = commitPreparedPublication({") &&
      packageSource.indexOf("publicationCommit = commitPreparedPublication({") <
        packageSource.lastIndexOf("console.log("),
    "HTTP validation and a prepared receipt must precede the claimed latest commit and success output",
  );
  assert.match(
    packageSource,
    /commitProtocol: "prepared-receipt-active-claim-create-only-latest-v2"/u,
  );
  assert.match(
    packageSource,
    /stateRule:\s*"canonical-manifest-hash-is-content-commit-point; completion-requires-artifact-validation-and-active-history"/u,
  );
  assert.match(
    packageSource,
    /availabilityDuringCommit: "latest-may-be-absent-between-claim-and-create"/u,
  );
  assert.match(packageSource, /installerMoveRecovered: installerPublication\.recovered/u);
  assert.match(
    packageSource,
    /candidateManifestMoveRecovered: candidateManifestPublication\.recovered/u,
  );
  assert.match(packageSource, /publicationResultPublication = writeFileExclusiveDurable\(/u);
  assert.equal(
    packageSource.match(/verifyCommittedPublication\(/gu)?.length,
    2,
    "receipt, latest, claim, active and history must be revalidated before result and stdout",
  );
  assert.match(packageSource, /stateValidation: committedStateValidation/u);
  assert.match(
    packageSource,
    /schemaVersion: 2,\s*kind: "relay-qa-hub-preview-publication-receipt"/u,
  );
  assert.match(packageSource, /installerName,\s*installerBytes:/u);
  assert.match(
    packageSource,
    /validatePreparedReceipt: \(evidence\) =>\s*validatePreparedPreviewPublicationReceipt\(evidence, updatePublicKeyPem\)/u,
  );
  const committedManifestFetch = packageSource.indexOf(
    'manifestUrl,\n    64 * 1024,\n    "COMMITTED_UPDATE_MANIFEST"',
  );
  const publicationResultWrite = packageSource.indexOf('join(root, "publication-result.json")');
  const latestCommitStage = packageSource.indexOf('publicationStage = "latest-commit"');
  const latestCommitCall = packageSource.indexOf("publicationCommit = commitPreparedPublication({");
  const committedHttpStage = packageSource.indexOf(
    'publicationStage = "committed-manifest-http-validation"',
  );
  assert.ok(
    latestCommitStage < latestCommitCall &&
      latestCommitCall < committedHttpStage &&
      committedHttpStage < committedManifestFetch &&
      committedManifestFetch < publicationResultWrite &&
      publicationResultWrite < packageSource.lastIndexOf("console.log("),
    "failure stages, canonical HTTP validation and durable result evidence must follow the latest commit",
  );
  assert.match(packageSource, /mkdirSync\(packagesRoot, \{ recursive: true \}\)/u);
  assert.match(
    packageSource,
    /const root = join\(packagesRoot, releaseId\);\s*mkdirSync\(root\);/u,
  );
  assert.doesNotMatch(packageSource, /existsSync\(root\).*PACKAGE_RELEASE_ALREADY_EXISTS/u);
  assert.match(
    packageSource,
    /canonicalDirectChildDirectory\(\s*portableRoot,\s*packaged\[0\],\s*"PACKAGE_PATH"/u,
  );
  assert.doesNotMatch(packageSource, /resolve\(packageDirectory\)\.startsWith\(resolve\(root\)\)/u);
  assert.match(packageSource, /join\(config\.sourceRoot, "node_modules\/typescript\/bin\/tsc"\)/u);
  assert.ok(
    packageSource.indexOf('runBuild(\n  "desktop"') <
      packageSource.indexOf("const sourcePreloadSnapshot = inspectSandboxPreload("),
    "the package must compile a fresh desktop artifact before inspecting its preload",
  );
  assert.match(packageSource, /node_modules\/vite\/bin\/vite\.js/u);
  assert.match(packageSource, /"--sourceMap",\s+"false"/u);
  assert.match(packageSource, /"--declaration",\s+"false"/u);
  assert.match(packageSource, /"--declarationMap",\s+"false"/u);
  assert.match(packageSource, /"--sourcemap=false"/u);
  assert.match(packageSource, /snapshotReleaseDirectory\(join\(stage, "dist"\)\)/u);
  assert.match(packageSource, /snapshotReleaseDirectory\(join\(stage, "web"\)\)/u);
  assert.match(packageSource, /dependencies: \{ "@relay-qa-hub\/upload-contract": "0\.1\.0" \}/u);
  for (const file of [
    "package.json",
    "index.js",
    "index.d.ts",
    "quick-build.js",
    "quick-build.d.ts",
  ]) {
    assert.match(packageSource, new RegExp(`"${file.replaceAll(".", "\\.")}"`, "u"));
  }
  assert.match(packageSource, /constants\.COPYFILE_EXCL/u);
  assert.match(packageSource, /ELECTRON_RUN_AS_NODE: "1"/u);
  assert.match(packageSource, /PACKAGED_RUNTIME_MODULE_RESOLUTION_FAILED/u);
  assert.match(packageSource, /schemaVersion: 1,[\s\S]+producer: "package-preview\.mjs"/u);
  assert.match(packageSource, /appScheme: packageIdentity\.protocolScheme/u);
  assert.match(packageSource, /appUserModelId: packageIdentity\.appUserModelId/u);
  assert.match(packageSource, /toastActivatorClsid: packageIdentity\.toastActivatorClsid/u);
  assert.ok(
    packageSource.indexOf("assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit)") <
      packageSource.indexOf("publishFileExclusiveDurable("),
    "the source must still be clean at the same commit before the installer is published",
  );
  const installerPublication = packageSource.indexOf("publishFileExclusiveDurable(");
  const stagedAliasRemoval = packageSource.indexOf(
    'if (existsSync(stagedInstaller)) throw new Error("STAGED_INSTALLER_ALIAS_REMOVE_FAILED")',
  );
  const singlePublishedLink = packageSource.indexOf("publishedInstallerStat.nlink !== 1n");
  const candidatePublication = packageSource.indexOf(
    "writeFileExclusiveDurable(\n    candidateManifestPath",
  );
  assert.ok(
    installerPublication < stagedAliasRemoval &&
      stagedAliasRemoval < singlePublishedLink &&
      singlePublishedLink < candidatePublication,
    "the installer move must remove its source alias and reverify one final link before candidate or latest publication",
  );

  assert.doesNotMatch(installerSource, /InstallDir "\$LOCALAPPDATA\\Programs\\RelayQaHubPreview"/u);
  for (const definition of [
    "INSTANCE_ID",
    "INSTALL_DIRECTORY_NAME",
    "EXECUTABLE_BASENAME",
    "UNINSTALL_REGISTRY_KEY",
    "SHORTCUT_NAME",
    "PROTOCOL_SCHEME",
    "APP_USER_MODEL_ID",
    "TOAST_ACTIVATOR_CLSID",
    "DISPLAY_NAME",
  ]) {
    assert.match(installerSource, new RegExp(`\\$\\{${definition}\\}`, "u"));
    assert.match(packageSource, new RegExp(`/D${definition}=`));
  }
});

test("packager output containment rejects prefix siblings and reparse children", (context) => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-package-containment-"));
  const portable = join(root, "portable");
  const inside = join(portable, "package-win32-x64");
  const prefixSibling = `${portable}-evil`;
  const outside = join(prefixSibling, "package-win32-x64");
  const junction = join(portable, "junction-win32-x64");
  try {
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    assert.equal(canonicalDirectChildDirectory(portable, inside, "FIXTURE"), resolve(inside));
    assert.throws(
      () => canonicalDirectChildDirectory(portable, outside, "FIXTURE"),
      /FIXTURE_OUTSIDE_PARENT/u,
    );
    try {
      symlinkSync(outside, junction, "junction");
    } catch (error) {
      if (error?.code === "EPERM") context.diagnostic("junction creation unavailable");
      else throw error;
    }
    if (existsSync(junction)) {
      assert.throws(
        () => canonicalDirectChildDirectory(portable, junction, "FIXTURE"),
        /FIXTURE_CANDIDATE_INVALID|FIXTURE_OUTSIDE_PARENT/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview installer exposes a silent payload-only verification path before any install mutation", () => {
  assert.match(installerSource, /!include FileFunc\.nsh/u);
  const init = installerSource.slice(
    installerSource.indexOf("Function .onInit"),
    installerSource.indexOf("Function RetryRenameDirectory"),
  );
  assert.match(init, /\$\{GetOptions\}[\s\S]+\/QA_HUB_VERIFY_PAYLOAD=/u);
  assert.match(init, /SetSilent silent/u);
  const section = installerSource.slice(
    installerSource.indexOf('Section "QA Hub Preview"'),
    installerSource.indexOf('Section "Uninstall"'),
  );
  const verificationStart = section.indexOf("verification_extract_start:");
  const existingInstallMutation = section.indexOf("StrCpy $HadExistingInstall 0");
  const payload = section.indexOf('File /r "${PACKAGE_DIR}\\*"');
  const success = section.indexOf("verification_extract_complete:");
  const firstRegistration = section.indexOf("WriteUninstaller");
  assert.ok(
    verificationStart >= 0 &&
      verificationStart < existingInstallMutation &&
      existingInstallMutation < payload &&
      payload < success &&
      success < firstRegistration,
  );
  assert.equal(section.match(/File \/r "\$\{PACKAGE_DIR\}\\\*"/gu)?.length, 1);
});

test("preview installer rejects empty install junctions and can quarantine an empty failed directory", () => {
  const init = installerSource.slice(
    installerSource.indexOf("Function .onInit"),
    installerSource.indexOf("Function RetryRenameDirectory"),
  );
  assert.doesNotMatch(init, /IfFileExists "\$INSTDIR\\\*" 0 validated/u);
  assert.match(
    init,
    /GetFileAttributesW\(w "\$INSTDIR"\)[\s\S]+IntOp \$1 \$0 & 0x10[\s\S]+IntOp \$1 \$0 & 0x400[\s\S]+normal_install_identity_check:/u,
  );

  const section = installerSource.slice(
    installerSource.indexOf('Section "QA Hub Preview"'),
    installerSource.indexOf('Section "Uninstall"'),
  );
  const installFiles = section.slice(
    section.indexOf("install_files:"),
    section.indexOf("embedded_payload:"),
  );
  assert.equal(installFiles.match(/GetFileAttributesW\(w "\$INSTDIR"\)/gu)?.length, 2);
  assert.ok(
    installFiles.indexOf('CreateDirectory "$INSTDIR"') <
      installFiles.indexOf('SetOutPath "$INSTDIR"') &&
      installFiles.indexOf('SetOutPath "$INSTDIR"') <
        installFiles.lastIndexOf('GetFileAttributesW(w "$INSTDIR")'),
    "the install directory must be created and checked again after SetOutPath before File /r",
  );
  assert.match(
    installFiles,
    /install_directory_write_not_reparse:[\s\S]+IntOp \$1 \$0 & 0x400\s+IntCmp \$1 0 embedded_payload install_directory_invalid install_directory_invalid/u,
  );
  assert.match(
    section,
    /install_directory_invalid:\s+Goto install_failed\s+install_path_invalid_before_rename:\s+SetErrorLevel 11/u,
    "directory preparation failures after an upgrade rename must enter backup recovery",
  );

  const failure = section.slice(
    section.indexOf("install_failed:"),
    section.indexOf("rename_failed:"),
  );
  assert.doesNotMatch(failure, /IfFileExists "\$INSTDIR\\\*\.\*"/u);
  assert.match(
    failure,
    /failed_payload_isolated:[\s\S]+GetFileAttributesW\(w "\$FailedDirectory"\)[\s\S]+failed_payload_canonical_absent:[\s\S]+GetFileAttributesW\(w "\$INSTDIR"\)[\s\S]+IntCmp \$0 -1 failed_payload_ready quarantine_failed quarantine_failed/u,
    "an empty failed directory must be isolated before an existing backup is restored",
  );

  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "qa-hub-empty-install-junction-"));
  const outside = join(root, "outside");
  const junction = join(root, "install");
  try {
    mkdirSync(outside);
    symlinkSync(outside, junction, "junction");
    assert.equal(readdirSync(junction).length, 0);
    assert.equal(lstatSync(junction).isSymbolicLink(), true);
    const attributes = spawnSync(
      resolveWindowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$item = Get-Item -LiteralPath $env:QA_HUB_TEST_EMPTY_JUNCTION; if (($item.Attributes -band [IO.FileAttributes]::Directory) -eq 0) { exit 40 }; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { exit 41 }; if ((Get-ChildItem -LiteralPath $env:QA_HUB_TEST_EMPTY_JUNCTION -Force).Count -ne 0) { exit 42 }",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, QA_HUB_TEST_EMPTY_JUNCTION: junction },
        windowsHide: true,
      },
    );
    assert.equal(attributes.status, 0, attributes.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview manifest keeps the updater-compatible signed wire shape", () => {
  const payloadStart = packageSource.indexOf("const payload = {");
  const signatureStart = packageSource.indexOf("const signature = sign(", payloadStart);
  const manifestBlock = packageSource.slice(payloadStart, signatureStart);
  assert.ok(payloadStart >= 0 && signatureStart > payloadStart);
  for (const field of ["schemaVersion", "releaseId", "version", "publishedAt", "archive"]) {
    assert.match(manifestBlock, new RegExp(`\\b${field}\\b`, "u"));
  }
  assert.doesNotMatch(
    manifestBlock,
    /attestation|sourceCommit|sourceDirty|packageContent|packageIdentity/u,
  );
  assert.match(
    packageSource.slice(
      signatureStart,
      packageSource.indexOf("const manifestPath", signatureStart),
    ),
    /serializeUpdateManifestPayload\(payload\)/u,
  );
});

test("signed update manifest rejects field, archive, and signature drift", () => {
  const pair = generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1,
    releaseId: "20260911T123456789Z",
    version: "0.2.0-preview.18",
    publishedAt: "2026-09-11T12:34:56.789Z",
    archive: {
      url: "/downloads/qa-hub-preview-unit-windows-0.2.0-preview.18-20260911T123456789Z.exe",
      size: 4,
      sha256: "a".repeat(64),
    },
  };
  const manifest = {
    ...payload,
    signature: sign(null, serializeUpdateManifestPayload(payload), pair.privateKey).toString(
      "base64",
    ),
  };
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  assert.equal(assertSignedUpdateManifest(manifest, publicKey), manifest);
  const lanPayload = {
    ...payload,
    version: "0.2.0-lan.18",
    archive: {
      ...payload.archive,
      url: "/downloads/qa-hub-lan-unit-windows-0.2.0-lan.18-20260911T123456789Z.exe",
    },
  };
  const lanManifest = {
    ...lanPayload,
    signature: sign(null, serializeUpdateManifestPayload(lanPayload), pair.privateKey).toString(
      "base64",
    ),
  };
  assert.equal(assertSignedUpdateManifest(lanManifest, publicKey), lanManifest);
  const stablePayload = {
    ...payload,
    version: "1.0.0",
    archive: {
      ...payload.archive,
      url: "/downloads/Relay-QA-Hub-团队版-1.0.0-20260911T123456789Z.exe",
    },
  };
  const stableManifest = {
    ...stablePayload,
    signature: sign(null, serializeUpdateManifestPayload(stablePayload), pair.privateKey).toString(
      "base64",
    ),
  };
  assert.equal(assertSignedUpdateManifest(stableManifest, publicKey), stableManifest);
  assert.throws(
    () => assertSignedUpdateManifest({ ...manifest, releaseId: "20260911T123456788Z" }, publicKey),
    /UPDATE_MANIFEST_SIGNATURE_INVALID/u,
  );
  assert.throws(
    () => assertSignedUpdateManifest({ ...manifest, unexpected: true }, publicKey),
    /UPDATE_MANIFEST_FIELDS_INVALID/u,
  );
});

test("latest publication accepts a newer preview build or stable release transaction", () => {
  const previous = {
    releaseId: "20260910T123456789Z",
    version: "0.2.0-preview.18",
    publishedAt: "2026-09-10T12:34:56.789Z",
  };
  const next = {
    releaseId: "20260911T123456789Z",
    version: "0.2.0-preview.19",
    publishedAt: "2026-09-11T12:34:56.789Z",
  };
  assert.equal(assertUpdateManifestSuccessor(previous, next), next);
  const stable = {
    ...next,
    releaseId: "20260912T123456789Z",
    version: "1.0.0",
    publishedAt: "2026-09-12T12:34:56.789Z",
  };
  assert.equal(assertUpdateManifestSuccessor(next, stable), stable);
  const stablePatch = {
    ...stable,
    releaseId: "20260913T123456789Z",
    publishedAt: "2026-09-13T12:34:56.789Z",
  };
  assert.equal(assertUpdateManifestSuccessor(stable, stablePatch), stablePatch);
  assert.throws(
    () => assertUpdateManifestSuccessor(stable, { ...stablePatch, releaseId: stable.releaseId }),
    /UPDATE_RELEASE_ID_NOT_MONOTONIC/u,
  );
  assert.throws(
    () =>
      assertUpdateManifestSuccessor(stable, { ...stablePatch, publishedAt: stable.publishedAt }),
    /UPDATE_PUBLISHED_AT_NOT_MONOTONIC/u,
  );
  assert.throws(
    () => assertUpdateManifestSuccessor(previous, { ...next, version: previous.version }),
    /UPDATE_VERSION_NOT_MONOTONIC/u,
  );
  assert.throws(
    () => assertUpdateManifestSuccessor(previous, { ...next, releaseId: previous.releaseId }),
    /UPDATE_RELEASE_ID_NOT_MONOTONIC/u,
  );
  assert.throws(
    () => assertUpdateManifestSuccessor(previous, { ...next, publishedAt: previous.publishedAt }),
    /UPDATE_PUBLISHED_AT_NOT_MONOTONIC/u,
  );
});

test("installer verification mode binds the exact extracted outer package", () => {
  const parent = mkdtempSync(join(tmpdir(), "qa-hub-installer-parent-"));
  const source = join(parent, "source");
  try {
    mkdirSync(source);
    writeFileSync(join(source, "app.exe"), "app");
    writeFileSync(join(source, "preview-instance.json"), "config");
    const expected = snapshotReleaseDirectory(source);
    const execute = (_installer, args) => {
      const option = args.find((item) => item.startsWith("/QA_HUB_VERIFY_PAYLOAD="));
      assert.ok(option);
      const output = option.slice("/QA_HUB_VERIFY_PAYLOAD=".length);
      writeFileSync(join(output, "app.exe"), "app");
      writeFileSync(join(output, "preview-instance.json"), "config");
      return { status: 0, signal: null, error: undefined };
    };
    assert.deepEqual(
      verifyPreviewInstallerPayload(
        Buffer.from("fixture-installer"),
        expected,
        parent,
        "FIXTURE",
        execute,
      ),
      expected,
    );
    assert.throws(
      () =>
        verifyPreviewInstallerPayload(
          Buffer.from("fixture-installer"),
          expected,
          parent,
          "DRIFTED",
          (_installer, args) => {
            const output = args
              .find((item) => item.startsWith("/QA_HUB_VERIFY_PAYLOAD="))
              .slice("/QA_HUB_VERIFY_PAYLOAD=".length);
            writeFileSync(join(output, "app.exe"), "changed");
            writeFileSync(join(output, "preview-instance.json"), "config");
            return { status: 0, signal: null, error: undefined };
          },
        ),
      /DRIFTED_MISMATCH/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("installed package binding keeps the packaged instance marker and excludes only the uninstaller", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-installed-binding-"));
  try {
    writeFileSync(join(root, "RelayQaHubPreview-unit.exe"), "app");
    writeFileSync(join(root, "preview-instance.json"), "config");
    writeFileSync(join(root, ".preview-instance-id"), "qa-hub-preview-unit");
    writeFileSync(join(root, "Uninstall-Preview.exe"), "generated-uninstaller");
    const snapshot = snapshotInstalledPreviewDirectory(root);
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      [".preview-instance-id", "RelayQaHubPreview-unit.exe", "preview-instance.json"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared receipt, replacement, active claim, latest, and history follow the v2 protocol", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-prepared-publication-"));
  const destination = join(root, "latest.json");
  const temporary = join(root, "latest.json.release.tmp");
  const receiptPath = join(root, "receipt.json");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const replacement = Buffer.from('{"releaseId":"new"}\n');
  const receiptBytes = Buffer.from('{"commit":"latest-sha256"}\n');
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    const checkpoints = [];
    let observedAvailabilityGap = false;
    const result = commitPreparedPublication({
      destination,
      temporary,
      replacementBytes: replacement,
      expectedPreviousBytes: previous,
      receiptPath,
      receiptBytes,
      checkpoint(step) {
        checkpoints.push(step);
        assert.ok(readFileSync(receiptPath).equals(receiptBytes));
        if (step === "previous-claimed") {
          observedAvailabilityGap = true;
          assert.equal(existsSync(destination), false);
        }
        if (
          step === "latest-created" ||
          step === "active-history-created" ||
          step === "active-archived"
        ) {
          assert.ok(readFileSync(destination).equals(replacement));
        }
      },
    });
    assert.equal(result.committed, true);
    assert.equal(result.recovered, false);
    assert.equal(observedAvailabilityGap, true);
    assert.deepEqual(checkpoints, [
      "receipt-durable",
      "lock-acquired",
      "replacement-durable",
      "active-marker-durable",
      "previous-claimed",
      "latest-created",
      "active-history-created",
      "active-archived",
    ]);
    assert.ok(readFileSync(destination).equals(replacement));
    assert.ok(readFileSync(result.claimPath).equals(previous));
    assert.equal(statSync(destination, { bigint: true }).nlink, 1n);
    assert.equal(statSync(result.claimPath, { bigint: true }).nlink, 1n);
    assert.equal(existsSync(`${destination}.publication.sqlite.active.json`), false);
    assert.ok(readFileSync(result.historyPath).length > 0);
    assert.equal(statSync(result.historyPath, { bigint: true }).nlink, 1n);
    const markerText = readFileSync(result.historyPath, "utf8");
    const marker = JSON.parse(markerText);
    assert.equal(marker.destination, undefined);
    assert.equal(marker.temporary, undefined);
    assert.equal(marker.receiptPath, undefined);
    assert.equal(marker.destinationName, "latest.json");
    assert.equal(marker.temporaryName, "latest.json.release.tmp");
    assert.doesNotMatch(markerText, new RegExp(root.replaceAll("\\", "\\\\"), "iu"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("late winner or deletion before the claim is preserved and never recreated", () => {
  for (const mutation of ["winner", "delete"]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-preclaim-${mutation}-`));
    const destination = join(root, "latest.json");
    const previous = Buffer.from('{"releaseId":"previous"}\n');
    const winner = Buffer.from('{"releaseId":"winner"}\n');
    try {
      writeFileSync(destination, previous, { flag: "wx" });
      assert.throws(
        () =>
          commitPreparedPublication({
            destination,
            temporary: join(root, "latest.tmp"),
            replacementBytes: Buffer.from('{"releaseId":"loser"}\n'),
            expectedPreviousBytes: previous,
            receiptPath: join(root, "receipt.json"),
            receiptBytes: Buffer.from("prepared-receipt"),
            checkpoint(step) {
              if (step !== "active-marker-durable") return;
              if (mutation === "winner") writeFileSync(destination, winner);
              else unlinkSync(destination);
            },
          }),
        /PUBLISHED_FILE_CHANGED_BEFORE_COMMIT|PUBLISHED_FILE_CLAIM_CREATE_FAILED/u,
      );
      if (mutation === "winner") assert.ok(readFileSync(destination).equals(winner));
      else assert.equal(existsSync(destination), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an absent latest uses create-only and keeps a late winner", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-create-only-latest-"));
  const destination = join(root, "latest.json");
  const winner = Buffer.from('{"releaseId":"winner"}\n');
  try {
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "latest.tmp"),
          replacementBytes: Buffer.from('{"releaseId":"loser"}\n'),
          expectedPreviousBytes: null,
          receiptPath: join(root, "receipt.json"),
          receiptBytes: Buffer.from("prepared-receipt"),
          checkpoint(step) {
            if (step === "active-marker-durable") {
              writeFileSync(destination, winner, { flag: "wx" });
            }
          },
        }),
      /PUBLISHED_FILE_CHANGED_BEFORE_COMMIT/u,
    );
    assert.ok(readFileSync(destination).equals(winner));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardlink aliases on latest or active fail closed and remain untouched", () => {
  for (const aliasedPath of ["latest", "active"]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-publication-alias-${aliasedPath}-`));
    const destination = join(root, "latest.json");
    const activePath = `${destination}.publication.sqlite.active.json`;
    const alias = join(root, `${aliasedPath}-alias.json`);
    const previous = Buffer.from('{"releaseId":"old"}\n');
    try {
      writeFileSync(destination, previous, { flag: "wx" });
      if (aliasedPath === "latest") linkSync(destination, alias);
      assert.throws(
        () =>
          commitPreparedPublication({
            destination,
            temporary: join(root, "latest.tmp"),
            replacementBytes: Buffer.from('{"releaseId":"new"}\n'),
            expectedPreviousBytes: previous,
            receiptPath: join(root, "receipt.json"),
            receiptBytes: Buffer.from("prepared-receipt"),
            checkpoint(step) {
              if (aliasedPath === "active" && step === "active-marker-durable") {
                linkSync(activePath, alias);
              }
            },
          }),
        /ALIAS/u,
      );
      assert.ok(readFileSync(destination).equals(previous));
      assert.ok(existsSync(alias));
      assert.equal(statSync(alias, { bigint: true }).nlink, 2n);
      if (aliasedPath === "active") {
        assert.ok(existsSync(activePath));
        assert.equal(statSync(activePath, { bigint: true }).nlink, 2n);
      } else {
        assert.equal(existsSync(activePath), false);
      }
      assert.equal(
        readdirSync(root).filter((name) => name.startsWith("latest.json.publication-claim-"))
          .length,
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an equal-byte late winner cannot impersonate the temporary-to-latest move", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-equal-late-winner-"));
  const destination = join(root, "latest.json");
  const temporary = join(root, "latest.tmp");
  const activePath = `${destination}.publication.sqlite.active.json`;
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const replacement = Buffer.from('{"releaseId":"new"}\n');
  const arguments_ = {
    destination,
    temporary,
    replacementBytes: replacement,
    expectedPreviousBytes: previous,
    receiptPath: join(root, "receipt.json"),
    receiptBytes: Buffer.from("prepared-receipt"),
  };
  let claimPath;
  let historyPath;
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          ...arguments_,
          checkpoint(step) {
            if (step !== "previous-claimed") return;
            const active = JSON.parse(readFileSync(activePath, "utf8"));
            claimPath = join(root, active.claimName);
            historyPath = join(root, active.historyName);
            writeFileSync(destination, replacement, { flag: "wx" });
          },
        }),
      /PUBLISHED_FILE_CHANGED_BEFORE_COMMIT/u,
    );
    assert.ok(readFileSync(destination).equals(replacement));
    assert.ok(readFileSync(temporary).equals(replacement));
    assert.ok(readFileSync(claimPath).equals(previous));
    assert.ok(existsSync(activePath));
    assert.equal(existsSync(historyPath), false);
    assert.throws(
      () => commitPreparedPublication(arguments_),
      /PUBLISHED_FILE_TEMPORARY_REMAINED_WITH_LATEST/u,
    );
    assert.ok(readFileSync(destination).equals(replacement));
    assert.ok(existsSync(temporary));
    assert.ok(existsSync(activePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a process exit during durable staging never exposes a torn final sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-torn-sidecar-"));
  const destination = join(root, "receipt.json");
  const bytes = Buffer.from('{"complete":true}\n');
  const moduleUrl = pathToFileURL(resolve(scriptRoot, "release-content-binding.mjs")).href;
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { writeFileExclusiveDurable } = await import(${JSON.stringify(moduleUrl)}); writeFileExclusiveDurable(${JSON.stringify(destination)}, Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"), (step) => { if (step === "staged-durable") process.exit(71); });`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(child.status, 71, child.stderr);
    assert.equal(existsSync(destination), false);
    assert.ok(readdirSync(root).some((name) => name.startsWith(".qa-hub-durable-")));
    writeFileExclusiveDurable(destination, bytes);
    assert.ok(readFileSync(destination).equals(bytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable create-only collision retains its owned orphan and canonical winner", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-durable-collision-"));
  const destination = join(root, "receipt.json");
  const bytes = Buffer.from("loser-sidecar");
  try {
    assert.throws(
      () =>
        writeFileExclusiveDurable(destination, bytes, (step) => {
          if (step === "staged-durable") writeFileSync(destination, "winner", { flag: "wx" });
        }),
      (error) => {
        assert.equal(error?.message, "DURABLE_FILE_PUBLICATION_FAILED_ORPHAN_RETAINED");
        assert.equal(error?.cause?.nativeError, 183);
        assert.equal(error?.orphanSha256, sha256(bytes));
        assert.equal(error?.orphanIdentityMatched, true);
        assert.ok(readFileSync(error.orphanPath).equals(bytes));
        return true;
      },
    );
    assert.equal(readFileSync(destination, "utf8"), "winner");
    assert.equal(readdirSync(root).filter((name) => name.startsWith(".qa-hub-durable-")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable sidecar move unknown success is recovered only from exact inode proof", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-durable-unknown-success-"));
  const destination = join(root, "sidecar.json");
  const bytes = Buffer.from("durable-unknown-success");
  const harness = writeFakeNativeHarness(root);
  const priorRealHelper = process.env.QA_HUB_TEST_REAL_HELPER;
  const priorDurableOutcome = process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS;
  try {
    process.env.QA_HUB_TEST_REAL_HELPER = resolve(scriptRoot, "move-file-write-through.ps1");
    process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS = "1";
    const result = writeFileExclusiveDurable(destination, bytes, () => {}, {
      helperPath: harness,
      retryMilliseconds: 100,
    });
    assert.equal(result.recovered, true);
    assert.ok(readFileSync(destination).equals(bytes));
    assert.equal(statSync(destination, { bigint: true }).nlink, 1n);
    assert.equal(readdirSync(root).filter((name) => name.startsWith(".qa-hub-durable-")).length, 0);
  } finally {
    if (priorRealHelper === undefined) delete process.env.QA_HUB_TEST_REAL_HELPER;
    else process.env.QA_HUB_TEST_REAL_HELPER = priorRealHelper;
    if (priorDurableOutcome === undefined) delete process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS;
    else process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS = priorDurableOutcome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt, replacement, and active unknown successes are surfaced by the commit", () => {
  const priorRealHelper = process.env.QA_HUB_TEST_REAL_HELPER;
  const priorDurableOutcome = process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS;
  const priorDurableTarget = process.env.QA_HUB_TEST_DURABLE_UNKNOWN_TARGET;
  try {
    process.env.QA_HUB_TEST_REAL_HELPER = resolve(scriptRoot, "move-file-write-through.ps1");
    process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS = "1";
    for (const phase of ["receipt", "replacement", "active"]) {
      const root = mkdtempSync(join(tmpdir(), `qa-hub-commit-${phase}-unknown-success-`));
      const destination = join(root, "latest.json");
      const temporary = join(root, "latest.tmp");
      const receiptPath = join(root, "receipt.json");
      const previous = Buffer.from('{"releaseId":"old"}\n');
      const replacement = Buffer.from('{"releaseId":"new"}\n');
      const receiptBytes = Buffer.from("prepared-receipt");
      const harness = writeFakeNativeHarness(root);
      try {
        process.env.QA_HUB_TEST_DURABLE_UNKNOWN_TARGET =
          phase === "receipt"
            ? "receipt.json"
            : phase === "replacement"
              ? "latest.tmp"
              : ".active.json";
        writeFileSync(destination, previous, { flag: "wx" });
        const result = commitPreparedPublication({
          destination,
          temporary,
          replacementBytes: replacement,
          expectedPreviousBytes: previous,
          receiptPath,
          receiptBytes,
          moveOptions: { helperPath: harness, retryMilliseconds: 100 },
        });
        assert.equal(result.recovered, true, `${phase} unknown success must be surfaced`);
        assert.ok(readFileSync(destination).equals(replacement));
        assert.equal(statSync(destination, { bigint: true }).nlink, 1n);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (priorRealHelper === undefined) delete process.env.QA_HUB_TEST_REAL_HELPER;
    else process.env.QA_HUB_TEST_REAL_HELPER = priorRealHelper;
    if (priorDurableOutcome === undefined) delete process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS;
    else process.env.QA_HUB_TEST_DURABLE_UNKNOWN_SUCCESS = priorDurableOutcome;
    if (priorDurableTarget === undefined) delete process.env.QA_HUB_TEST_DURABLE_UNKNOWN_TARGET;
    else process.env.QA_HUB_TEST_DURABLE_UNKNOWN_TARGET = priorDurableTarget;
  }
});

test("Windows helper is source-pinned, create-only, same-volume, and retries only transient locks", async () => {
  assert.match(writeThroughHelperSource, /MoveFileExW/u);
  assert.match(writeThroughHelperSource, /MOVEFILE_WRITE_THROUGH = 0x8/u);
  assert.doesNotMatch(
    writeThroughHelperSource,
    /MOVEFILE_REPLACE_EXISTING|ExpectedDestinationSha256/u,
  );
  assert.doesNotMatch(writeThroughHelperSource, /MOVEFILE_COPY_ALLOWED/u);
  assert.match(writeThroughHelperSource, /\[string\] \$ExpectedSourceSha256/u);
  assert.match(writeThroughHelperSource, /QaHubMoveFileWriteThroughNative' -as \[type\]/u);
  const retryClause = writeThroughHelperSource.match(/^\s*\$retryable = (?<clause>.+)$/mu);
  assert.ok(retryClause?.groups?.clause);
  assert.deepEqual(
    [...retryClause.groups.clause.matchAll(/\$nativeError -eq (?<code>\d+)/gu)].map(({ groups }) =>
      Number(groups.code),
    ),
    [5, 32, 33],
  );
  const retryLoop = writeThroughHelperSource.slice(writeThroughHelperSource.indexOf("do {"));
  assert.ok(
    retryLoop.indexOf("Get-FileSha256 $sourceFull") <
      retryLoop.indexOf("[QaHubMoveFileWriteThroughNative]::Move"),
  );
  assert.match(gitAttributesSource, /^\*\.ps1 text eol=crlf$/mu);
  assert.doesNotMatch(writeThroughHelperSource, /(?<!\r)\n/u);

  const root = mkdtempSync(join(tmpdir(), "qa-hub-write-through-"));
  const sourceDirectory = join(root, "source");
  const destinationDirectory = join(root, "destination");
  mkdirSync(sourceDirectory);
  mkdirSync(destinationDirectory);
  try {
    const source = join(sourceDirectory, "latest.tmp");
    const destination = join(destinationDirectory, "latest.json");
    writeFileSync(source, "replacement", { flag: "wx" });
    assert.throws(
      () =>
        moveFileWriteThrough(source, destination, {
          expectedSourceSha256: "0".repeat(64),
          retryMilliseconds: 100,
        }),
      (error) =>
        error?.helperCode === "SOURCE_PRECONDITION_CHANGED" && error?.detail?.attempts === 0,
    );
    const moved = moveFileWriteThrough(source, destination, {
      expectedSourceSha256: sha256(Buffer.from("replacement")),
      retryMilliseconds: 1000,
    });
    assert.equal(moved.flags, 8);
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(destination, "utf8"), "replacement");

    const collisionSource = join(sourceDirectory, "collision.tmp");
    writeFileSync(collisionSource, "loser", { flag: "wx" });
    assert.throws(
      () =>
        moveFileWriteThrough(collisionSource, destination, {
          expectedSourceSha256: sha256(Buffer.from("loser")),
          retryMilliseconds: 100,
        }),
      (error) => error?.nativeError === 183 && error?.detail?.attempts === 1,
    );
    assert.equal(readFileSync(collisionSource, "utf8"), "loser");
    assert.equal(readFileSync(destination, "utf8"), "replacement");

    unlinkSync(destination);
    const retrySource = join(sourceDirectory, "retry.tmp");
    writeFileSync(retrySource, "retry", { flag: "wx" });
    const retryRun = startFakeNativeMove({
      root,
      source: retrySource,
      destination,
      expectedSourceSha256: sha256(Buffer.from("retry")),
      nativeErrors: "5,32,33",
      retryMilliseconds: 1000,
    });
    const retryResult = await retryRun.completion;
    assert.equal(retryResult.status, 0, retryResult.stderr);
    assert.equal(parseLastJson(retryResult.stdout)?.attempts, 4);
    assert.equal(readFileSync(destination, "utf8"), "retry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("helper-internal post-SHA barrier preserves a late winner and never recreates a deleted source", async () => {
  for (const mutation of ["winner", "delete-source"]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-native-barrier-${mutation}-`));
    const source = join(root, "source.tmp");
    const destination = join(root, "destination.json");
    const readyPath = join(root, "ready");
    const releasePath = join(root, "release");
    try {
      writeFileSync(source, mutation === "winner" ? "loser" : "old", { flag: "wx" });
      const operation = startFakeNativeMove({
        root,
        source,
        destination,
        expectedSourceSha256: sha256(Buffer.from(mutation === "winner" ? "loser" : "old")),
        readyPath,
        releasePath,
        retryMilliseconds: 100,
      });
      await waitForFile(readyPath);
      if (mutation === "winner") writeFileSync(destination, "winner", { flag: "wx" });
      else unlinkSync(source);
      writeFileSync(releasePath, "continue", { flag: "wx" });
      const result = await operation.completion;
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const detail = parseLastJson(result.stderr);
      assert.equal(detail?.attempts, 1);
      assert.equal(detail?.nativeError, mutation === "winner" ? 183 : 2);
      if (mutation === "winner") {
        assert.equal(readFileSync(source, "utf8"), "loser");
        assert.equal(readFileSync(destination, "utf8"), "winner");
      } else {
        assert.equal(existsSync(source), false);
        assert.equal(existsSync(destination), false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("installer publication directly moves one verified inode and never cleans a canonical winner", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-installer-publication-"));
  const release = join(root, "release");
  const downloads = join(root, "downloads");
  mkdirSync(release);
  mkdirSync(downloads);
  const source = join(release, "staged-installer.exe");
  const destination = join(downloads, "installer.exe");
  const bytes = Buffer.from("installer-bytes");
  try {
    writeFileSync(source, bytes, { flag: "wx" });
    const sourceIdentity = statSync(source, { bigint: true });
    const published = publishFileExclusiveDurable(source, destination, bytes);
    const destinationStat = statSync(destination, { bigint: true });
    assert.equal(existsSync(source), false);
    assert.equal(destinationStat.dev, sourceIdentity.dev);
    assert.equal(destinationStat.ino, sourceIdentity.ino);
    assert.equal(destinationStat.dev.toString(), published.dev);
    assert.equal(destinationStat.ino.toString(), published.ino);
    assert.equal(destinationStat.nlink, 1n);
    assert.equal(published.recovered, false);
    assert.ok(readFileSync(destination).equals(bytes));

    const collisionSource = join(release, "collision.exe");
    writeFileSync(collisionSource, bytes, { flag: "wx" });
    assert.throws(
      () => publishFileExclusiveDurable(collisionSource, destination, bytes),
      (error) => error?.nativeError === 183,
    );
    assert.ok(readFileSync(collisionSource).equals(bytes));
    assert.ok(readFileSync(destination).equals(bytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer move unknown success is recovered only from exact inode and byte proof", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-installer-unknown-success-"));
  const sourceDirectory = join(root, "source");
  const destinationDirectory = join(root, "destination");
  mkdirSync(sourceDirectory);
  mkdirSync(destinationDirectory);
  const source = join(sourceDirectory, "installer.exe");
  const destination = join(destinationDirectory, "installer.exe");
  const bytes = Buffer.from("installer-unknown-success");
  const harness = writeFakeNativeHarness(root);
  const priorRealHelper = process.env.QA_HUB_TEST_REAL_HELPER;
  const priorInstallerOutcome = process.env.QA_HUB_TEST_INSTALLER_UNKNOWN_SUCCESS;
  try {
    process.env.QA_HUB_TEST_REAL_HELPER = resolve(scriptRoot, "move-file-write-through.ps1");
    process.env.QA_HUB_TEST_INSTALLER_UNKNOWN_SUCCESS = "1";
    writeFileSync(source, bytes, { flag: "wx" });
    const sourceIdentity = statSync(source, { bigint: true });
    const published = publishFileExclusiveDurable(source, destination, bytes, () => {}, {
      helperPath: harness,
      retryMilliseconds: 100,
    });
    const destinationIdentity = statSync(destination, { bigint: true });
    assert.equal(published.recovered, true);
    assert.equal(existsSync(source), false);
    assert.equal(destinationIdentity.dev, sourceIdentity.dev);
    assert.equal(destinationIdentity.ino, sourceIdentity.ino);
    assert.equal(destinationIdentity.nlink, 1n);
    assert.ok(readFileSync(destination).equals(bytes));
  } finally {
    if (priorRealHelper === undefined) delete process.env.QA_HUB_TEST_REAL_HELPER;
    else process.env.QA_HUB_TEST_REAL_HELPER = priorRealHelper;
    if (priorInstallerOutcome === undefined)
      delete process.env.QA_HUB_TEST_INSTALLER_UNKNOWN_SUCCESS;
    else process.env.QA_HUB_TEST_INSTALLER_UNKNOWN_SUCCESS = priorInstallerOutcome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer publication rejects source drift and retains a published file after post-move failure", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-installer-failures-"));
  const release = join(root, "release");
  const downloads = join(root, "downloads");
  mkdirSync(release);
  mkdirSync(downloads);
  try {
    const wrongSource = join(release, "wrong.exe");
    const wrongDestination = join(downloads, "wrong.exe");
    writeFileSync(wrongSource, "wrong-payload", { flag: "wx" });
    assert.throws(
      () =>
        publishFileExclusiveDurable(wrongSource, wrongDestination, Buffer.from("right-payload")),
      /DURABLE_PUBLICATION_SOURCE_READBACK_MISMATCH/u,
    );
    assert.equal(existsSync(wrongDestination), false);
    assert.equal(readFileSync(wrongSource, "utf8"), "wrong-payload");

    const source = join(release, "published.exe");
    const destination = join(downloads, "published.exe");
    const bytes = Buffer.from("installer-bytes");
    writeFileSync(source, bytes, { flag: "wx" });
    assert.throws(
      () =>
        publishFileExclusiveDurable(source, destination, bytes, (step) => {
          if (step === "published") throw new Error("FAIL_AFTER_PUBLICATION");
        }),
      /FAIL_AFTER_PUBLICATION/u,
    );
    assert.equal(existsSync(source), false);
    assert.ok(readFileSync(destination).equals(bytes));
    assert.equal(statSync(destination, { bigint: true }).nlink, 1n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real process exit after installer move leaves only the immutable canonical path", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-installer-process-exit-"));
  const sourceDirectory = join(root, "source");
  const destinationDirectory = join(root, "destination");
  mkdirSync(sourceDirectory);
  mkdirSync(destinationDirectory);
  const source = join(sourceDirectory, "installer.exe");
  const destination = join(destinationDirectory, "installer.exe");
  const bytes = Buffer.from("installer-process-exit");
  const moduleUrl = pathToFileURL(resolve(scriptRoot, "release-content-binding.mjs")).href;
  try {
    writeFileSync(source, bytes, { flag: "wx" });
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { publishFileExclusiveDurable } = await import(${JSON.stringify(moduleUrl)}); publishFileExclusiveDurable(${JSON.stringify(source)}, ${JSON.stringify(destination)}, Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"), (step) => { if (step === "published") process.exit(73); });`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(child.status, 73, child.stderr);
    assert.equal(existsSync(source), false);
    assert.ok(readFileSync(destination).equals(bytes));
    assert.equal(statSync(destination, { bigint: true }).nlink, 1n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only release verification imports when the optional SQLite module is disabled", () => {
  const moduleUrl = pathToFileURL(resolve(scriptRoot, "release-content-binding.mjs")).href;
  const child = spawnSync(
    process.execPath,
    [
      "--no-experimental-sqlite",
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(moduleUrl)});`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
});

test("every durable publication checkpoint is recoverable after a real process exit", () => {
  const checkpoints = [
    "receipt-durable",
    "lock-acquired",
    "replacement-durable",
    "active-marker-durable",
    "previous-claimed",
    "latest-created",
    "active-history-created",
    "active-archived",
  ];
  const moduleUrl = pathToFileURL(resolve(scriptRoot, "release-content-binding.mjs")).href;
  for (const [index, interruptAt] of checkpoints.entries()) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-publication-exit-${interruptAt}-`));
    const destination = join(root, "latest.json");
    const temporary = join(root, "latest.tmp");
    const receiptPath = join(root, "receipt.json");
    const previous = Buffer.from('{"releaseId":"old"}\n');
    const replacement = Buffer.from('{"releaseId":"new"}\n');
    const receiptBytes = Buffer.from("prepared-receipt");
    try {
      writeFileSync(destination, previous, { flag: "wx" });
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const { commitPreparedPublication } = await import(${JSON.stringify(moduleUrl)}); const decode = (value) => Buffer.from(value, "base64"); commitPreparedPublication({ destination: ${JSON.stringify(destination)}, temporary: ${JSON.stringify(temporary)}, replacementBytes: decode(${JSON.stringify(replacement.toString("base64"))}), expectedPreviousBytes: decode(${JSON.stringify(previous.toString("base64"))}), receiptPath: ${JSON.stringify(receiptPath)}, receiptBytes: decode(${JSON.stringify(receiptBytes.toString("base64"))}), validatePreparedReceipt({ transaction, phase }) { if (!phase || transaction.receiptSha256 !== ${JSON.stringify(sha256(receiptBytes))}) throw new Error("invalid receipt"); }, checkpoint(step) { if (step === ${JSON.stringify(interruptAt)}) process.exit(${80 + index}); } });`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(child.status, 80 + index, child.stderr);
      assert.ok(readFileSync(receiptPath).equals(receiptBytes));
      if (interruptAt === "previous-claimed") assert.equal(existsSync(destination), false);
      if (
        interruptAt === "latest-created" ||
        interruptAt === "active-history-created" ||
        interruptAt === "active-archived"
      ) {
        assert.ok(readFileSync(destination).equals(replacement));
      }
      const result = commitPreparedPublication({
        destination,
        temporary,
        replacementBytes: replacement,
        expectedPreviousBytes: previous,
        receiptPath,
        receiptBytes,
      });
      assert.equal(result.committed, true);
      assert.equal(result.recovered, true, interruptAt);
      assert.ok(readFileSync(destination).equals(replacement));
      assert.ok(readFileSync(result.claimPath).equals(previous));
      assert.equal(existsSync(`${destination}.publication.sqlite.active.json`), false);
      assert.ok(existsSync(result.historyPath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("postcommit validator failures carry exact content and completion state", () => {
  for (const [failurePhase, expectedCompleted] of [
    ["after-latest-create", false],
    ["publication-return", true],
    ["commit-prepared-publication-return", true],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-postcommit-${failurePhase}-`));
    const destination = join(root, "latest.json");
    const previous = Buffer.from('{"releaseId":"old"}\n');
    const replacement = Buffer.from('{"releaseId":"new"}\n');
    let publicationError;
    try {
      writeFileSync(destination, previous, { flag: "wx" });
      try {
        commitPreparedPublication({
          destination,
          temporary: join(root, "latest.tmp"),
          replacementBytes: replacement,
          expectedPreviousBytes: previous,
          receiptPath: join(root, "receipt.json"),
          receiptBytes: Buffer.from("prepared-receipt"),
          validatePreparedReceipt(evidence) {
            validateGenericPreparedReceipt(evidence);
            if (evidence.phase === failurePhase) throw new Error(`FAIL_${failurePhase}`);
          },
        });
      } catch (error) {
        publicationError = error;
      }
      assert.equal(publicationError?.message, `FAIL_${failurePhase}`);
      assert.equal(publicationError?.publicationPhase, failurePhase);
      assert.equal(publicationError?.publicationState?.contentCommitted, true);
      assert.equal(publicationError?.publicationState?.completed, expectedCompleted);
      assert.match(publicationError?.publicationState?.transactionId ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(JSON.stringify(publicationError.publicationState).includes(root), false);
      assert.ok(readFileSync(destination).equals(replacement));
      assert.ok(existsSync(join(root, publicationError.publicationState.claimName)));
      const activePath = `${destination}.publication.sqlite.active.json`;
      assert.equal(existsSync(activePath), !expectedCompleted);
      assert.equal(
        existsSync(join(root, publicationError.publicationState.historyName)),
        expectedCompleted,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("committed-state verification rejects history, claim, and receipt drift", () => {
  for (const drift of ["history", "claim", "receipt"]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-committed-${drift}-drift-`));
    const destination = join(root, "latest.json");
    const previous = Buffer.from('{"releaseId":"old"}\n');
    try {
      writeFileSync(destination, previous, { flag: "wx" });
      const result = commitPreparedPublication({
        destination,
        temporary: join(root, "latest.tmp"),
        replacementBytes: Buffer.from('{"releaseId":"new"}\n'),
        expectedPreviousBytes: previous,
        receiptPath: join(root, "receipt.json"),
        receiptBytes: Buffer.from("prepared-receipt"),
      });
      const verified = verifyCommittedPublication(result, validateGenericPreparedReceipt);
      assert.equal(verified.completed, true);
      if (drift === "history") {
        linkSync(result.historyPath, `${result.historyPath}.alias`);
      } else if (drift === "claim") {
        writeFileSync(result.claimPath, "changed-claim");
      } else {
        writeFileSync(result.verificationDescriptor.receiptPath, "changed-receipt");
      }
      assert.throws(() => verifyCommittedPublication(result, validateGenericPreparedReceipt));
      assert.ok(readFileSync(destination).equals(Buffer.from('{"releaseId":"new"}\n')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("SQLite finalize failures preserve publication state and the primary error", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  for (const failure of ["commit", "close", "rollback-close"]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-lock-${failure}-`));
    const destination = join(root, "latest.json");
    const previous = Buffer.from('{"releaseId":"old"}\n');
    const replacement = Buffer.from('{"releaseId":"new"}\n');
    const databaseFactory = (databasePath) => {
      const database = new DatabaseSync(databasePath);
      return {
        exec(statement) {
          database.exec(statement);
          if (failure === "commit" && statement === "COMMIT")
            throw new Error("COMMIT_AFTER_SUCCESS");
          if (failure === "rollback-close" && statement === "ROLLBACK")
            throw new Error("ROLLBACK_AFTER_SUCCESS");
        },
        close() {
          database.close();
          if (failure === "close" || failure === "rollback-close")
            throw new Error("CLOSE_AFTER_SUCCESS");
        },
      };
    };
    let publicationError;
    try {
      writeFileSync(destination, previous, { flag: "wx" });
      try {
        commitPreparedPublication({
          destination,
          temporary: join(root, "latest.tmp"),
          replacementBytes: replacement,
          expectedPreviousBytes: previous,
          receiptPath: join(root, "receipt.json"),
          receiptBytes: Buffer.from("prepared-receipt"),
          databaseFactory,
          validatePreparedReceipt(evidence) {
            validateGenericPreparedReceipt(evidence);
            if (failure === "rollback-close" && evidence.phase === "before-latest-claim")
              throw new Error("PRIMARY_PUBLICATION_FAILURE");
          },
        });
      } catch (error) {
        publicationError = error;
      }
      if (failure === "rollback-close") {
        assert.equal(publicationError?.message, "PRIMARY_PUBLICATION_FAILURE");
        assert.equal(publicationError?.lockRollbackCause?.message, "ROLLBACK_AFTER_SUCCESS");
        assert.equal(publicationError?.lockCloseCause?.message, "CLOSE_AFTER_SUCCESS");
        assert.ok(readFileSync(destination).equals(previous));
      } else {
        assert.equal(publicationError?.message, "PUBLISHED_FILE_LOCK_FINALIZE_FAILED");
        assert.equal(publicationError?.publicationState?.contentCommitted, true);
        assert.equal(publicationError?.publicationState?.completed, true);
        assert.equal(
          publicationError?.publicationPhase,
          failure === "commit" ? "lock-commit" : "lock-close",
        );
        assert.ok(readFileSync(destination).equals(replacement));
        if (failure === "commit")
          assert.equal(publicationError?.lockCommitCause?.message, "COMMIT_AFTER_SUCCESS");
        else assert.equal(publicationError?.lockCloseCause?.message, "CLOSE_AFTER_SUCCESS");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("active archive accepts exact unknown success and preserves a late history winner", () => {
  for (const outcome of ["exact", "late-winner"]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-history-unknown-${outcome}-`));
    const destination = join(root, "latest.json");
    const activePath = `${destination}.publication.sqlite.active.json`;
    const previous = Buffer.from('{"releaseId":"old"}\n');
    const replacement = Buffer.from('{"releaseId":"new"}\n');
    const lateWinner = Buffer.from("late-history-winner");
    const harness = writeFakeNativeHarness(root);
    const priorRealHelper = process.env.QA_HUB_TEST_REAL_HELPER;
    const priorHistoryOutcome = process.env.QA_HUB_TEST_HISTORY_OUTCOME;
    let historyPath;
    try {
      process.env.QA_HUB_TEST_REAL_HELPER = resolve(scriptRoot, "move-file-write-through.ps1");
      process.env.QA_HUB_TEST_HISTORY_OUTCOME =
        outcome === "exact" ? "error" : `winner:${lateWinner.toString("base64")}`;
      writeFileSync(destination, previous, { flag: "wx" });
      const publish = () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "latest.tmp"),
          replacementBytes: replacement,
          expectedPreviousBytes: previous,
          receiptPath: join(root, "receipt.json"),
          receiptBytes: Buffer.from("prepared-receipt"),
          moveOptions: { helperPath: harness, retryMilliseconds: 100 },
          checkpoint(step) {
            if (step === "active-marker-durable") {
              const active = JSON.parse(readFileSync(activePath, "utf8"));
              historyPath = join(root, active.historyName);
            }
          },
        });

      if (outcome === "exact") {
        const result = publish();
        assert.equal(result.committed, true);
        assert.equal(result.recovered, true);
        assert.ok(readFileSync(historyPath).length > 0);
      } else {
        assert.throws(publish, /PUBLISHED_FILE_ACTIVE_ARCHIVE_FAILED/u);
        assert.ok(readFileSync(historyPath).equals(lateWinner));
        assert.ok(existsSync(`${historyPath}.test-original`));
      }
      assert.ok(readFileSync(destination).equals(replacement));
      assert.equal(existsSync(activePath), false);
    } finally {
      if (priorRealHelper === undefined) delete process.env.QA_HUB_TEST_REAL_HELPER;
      else process.env.QA_HUB_TEST_REAL_HELPER = priorRealHelper;
      if (priorHistoryOutcome === undefined) delete process.env.QA_HUB_TEST_HISTORY_OUTCOME;
      else process.env.QA_HUB_TEST_HISTORY_OUTCOME = priorHistoryOutcome;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a claim syscall unknown success is reported as recovered after identity proof", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-claim-unknown-success-"));
  const destination = join(root, "latest.json");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const replacement = Buffer.from('{"releaseId":"new"}\n');
  const harness = writeFakeNativeHarness(root);
  const priorRealHelper = process.env.QA_HUB_TEST_REAL_HELPER;
  const priorClaimOutcome = process.env.QA_HUB_TEST_CLAIM_UNKNOWN_SUCCESS;
  try {
    process.env.QA_HUB_TEST_REAL_HELPER = resolve(scriptRoot, "move-file-write-through.ps1");
    process.env.QA_HUB_TEST_CLAIM_UNKNOWN_SUCCESS = "1";
    writeFileSync(destination, previous, { flag: "wx" });
    const result = commitPreparedPublication({
      destination,
      temporary: join(root, "latest.tmp"),
      replacementBytes: replacement,
      expectedPreviousBytes: previous,
      receiptPath: join(root, "receipt.json"),
      receiptBytes: Buffer.from("prepared-receipt"),
      moveOptions: { helperPath: harness, retryMilliseconds: 100 },
    });
    assert.equal(result.committed, true);
    assert.equal(result.recovered, true);
    assert.ok(readFileSync(destination).equals(replacement));
    assert.ok(readFileSync(result.claimPath).equals(previous));
    assert.equal(existsSync(`${destination}.publication.sqlite.active.json`), false);
  } finally {
    if (priorRealHelper === undefined) delete process.env.QA_HUB_TEST_REAL_HELPER;
    else process.env.QA_HUB_TEST_REAL_HELPER = priorRealHelper;
    if (priorClaimOutcome === undefined) delete process.env.QA_HUB_TEST_CLAIM_UNKNOWN_SUCCESS;
    else process.env.QA_HUB_TEST_CLAIM_UNKNOWN_SUCCESS = priorClaimOutcome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema v2 active markers reject null and unsafe receipt evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-active-receipt-schema-"));
  const destination = join(root, "latest.json");
  const activePath = `${destination}.publication.sqlite.active.json`;
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const arguments_ = {
    destination,
    temporary: join(root, "latest.tmp"),
    replacementBytes: Buffer.from('{"releaseId":"new"}\n'),
    expectedPreviousBytes: previous,
    receiptPath: join(root, "receipt.json"),
    receiptBytes: Buffer.from("prepared-receipt"),
  };
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          ...arguments_,
          checkpoint(step) {
            if (step === "active-marker-durable") throw new Error("STOP_WITH_ACTIVE");
          },
        }),
      /STOP_WITH_ACTIVE/u,
    );
    const original = JSON.parse(readFileSync(activePath, "utf8"));
    const cases = [
      { receiptRelativePath: null, receiptSha256: null },
      { receiptRelativePath: "", receiptSha256: original.receiptSha256 },
      { receiptRelativePath: ".", receiptSha256: original.receiptSha256 },
      { receiptRelativePath: "../receipt.json", receiptSha256: original.receiptSha256 },
      { receiptRelativePath: "/receipt.json", receiptSha256: original.receiptSha256 },
      { receiptRelativePath: "C:/receipt.json", receiptSha256: original.receiptSha256 },
      { receiptRelativePath: "a//receipt.json", receiptSha256: original.receiptSha256 },
      { receiptRelativePath: "a\\receipt.json", receiptSha256: original.receiptSha256 },
      { receiptRelativePath: "receipt.json", receiptSha256: null },
    ];
    for (const receiptFields of cases) {
      const material = {
        schemaVersion: 2,
        protocol: "active-claim-create-only-v2",
        destinationPathSha256: original.destinationPathSha256,
        destinationName: original.destinationName,
        temporaryName: original.temporaryName,
        previousSha256: original.previousSha256,
        replacementSha256: original.replacementSha256,
        ...receiptFields,
      };
      const transactionId = sha256(Buffer.from(JSON.stringify(material), "utf8"));
      const marker = {
        ...material,
        transactionId,
        claimName: `${material.destinationName}.publication-claim-${transactionId}`,
        historyName: `latest.json.publication.sqlite.history-${transactionId}.json`,
      };
      writeFileSync(activePath, `${JSON.stringify(marker)}\n`);
      assert.throws(
        () => commitPreparedPublication(arguments_),
        /PUBLISHED_FILE_RECEIPT_(?:RELATIVE_PATH|SHA256)_INVALID/u,
      );
      assert.ok(readFileSync(destination).equals(previous));
      assert.ok(existsSync(activePath));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a writer rechecks its preimage after settling another active transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-stale-preimage-after-recovery-"));
  const destination = join(root, "latest.json");
  const activePath = `${destination}.publication.sqlite.active.json`;
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const activeReplacement = Buffer.from('{"releaseId":"active"}\n');
  const requestedTemporary = join(root, "requested.tmp");
  let activeHistoryPath;
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "active.tmp"),
          replacementBytes: activeReplacement,
          expectedPreviousBytes: previous,
          receiptPath: join(root, "active-receipt.json"),
          receiptBytes: Buffer.from("active-receipt"),
          checkpoint(step) {
            if (step !== "previous-claimed") return;
            const active = JSON.parse(readFileSync(activePath, "utf8"));
            activeHistoryPath = join(root, active.historyName);
            throw new Error("ACTIVE_EXIT_IN_GAP");
          },
        }),
      /ACTIVE_EXIT_IN_GAP/u,
    );
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: requestedTemporary,
          replacementBytes: Buffer.from('{"releaseId":"stale-request"}\n'),
          expectedPreviousBytes: previous,
          receiptPath: join(root, "requested-receipt.json"),
          receiptBytes: Buffer.from("requested-receipt"),
        }),
      /PUBLISHED_FILE_CHANGED_BEFORE_COMMIT/u,
    );
    assert.ok(readFileSync(destination).equals(activeReplacement));
    assert.ok(existsSync(activeHistoryPath));
    assert.equal(existsSync(activePath), false);
    assert.equal(existsSync(requestedTemporary), false);
    assert.equal(
      readdirSync(root).filter((name) => name.startsWith("latest.json.publication-claim-")).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("winner plus active claim blocks retries while preserving winner, claim, temp, and active", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-winner-with-claim-"));
  const destination = join(root, "latest.json");
  const temporary = join(root, "latest.tmp");
  const receiptPath = join(root, "receipt.json");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const replacement = Buffer.from('{"releaseId":"loser"}\n');
  const winner = Buffer.from('{"releaseId":"winner"}\n');
  const arguments_ = {
    destination,
    temporary,
    replacementBytes: replacement,
    expectedPreviousBytes: previous,
    receiptPath,
    receiptBytes: Buffer.from("prepared-receipt"),
  };
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          ...arguments_,
          checkpoint(step) {
            if (step === "previous-claimed") writeFileSync(destination, winner, { flag: "wx" });
          },
        }),
      /PUBLISHED_FILE_CHANGED_BEFORE_COMMIT/u,
    );
    assert.ok(readFileSync(destination).equals(winner));
    assert.ok(readFileSync(temporary).equals(replacement));
    const activePath = `${destination}.publication.sqlite.active.json`;
    const active = JSON.parse(readFileSync(activePath, "utf8"));
    const claimPath = join(root, active.claimName);
    assert.ok(readFileSync(claimPath).equals(previous));
    assert.throws(
      () => commitPreparedPublication(arguments_),
      /PUBLISHED_FILE_CHANGED_BEFORE_COMMIT/u,
    );
    assert.ok(readFileSync(destination).equals(winner));
    assert.ok(readFileSync(claimPath).equals(previous));
    assert.ok(existsSync(activePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrong claim bytes are retained and block canonical publication", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-wrong-claim-"));
  const destination = join(root, "latest.json");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  let wrongClaimPath;
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "latest.tmp"),
          replacementBytes: Buffer.from('{"releaseId":"new"}\n'),
          expectedPreviousBytes: previous,
          receiptPath: join(root, "receipt.json"),
          receiptBytes: Buffer.from("prepared-receipt"),
          checkpoint(step) {
            if (step !== "active-marker-durable") return;
            const active = JSON.parse(
              readFileSync(`${destination}.publication.sqlite.active.json`, "utf8"),
            );
            wrongClaimPath = join(root, active.claimName);
            writeFileSync(wrongClaimPath, "wrong-claim", { flag: "wx" });
          },
        }),
      /PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH/u,
    );
    assert.ok(readFileSync(destination).equals(previous));
    assert.equal(readFileSync(wrongClaimPath, "utf8"), "wrong-claim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected claim restoration reports helper unknown success without accepting publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-claim-restore-unknown-"));
  const destination = join(root, "latest.json");
  const activePath = `${destination}.publication.sqlite.active.json`;
  const readyPath = join(root, "claim-ready");
  const releasePath = join(root, "claim-release");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const lateWinner = Buffer.from('{"releaseId":"late-winner"}\n');
  const harness = writeFakeNativeHarness(root);
  const environmentNames = [
    "QA_HUB_TEST_REAL_HELPER",
    "QA_HUB_TEST_NATIVE_READY",
    "QA_HUB_TEST_NATIVE_RELEASE",
    "QA_HUB_TEST_NATIVE_BARRIER_TARGET",
    "QA_HUB_TEST_RESTORE_UNKNOWN_SUCCESS",
  ];
  const priorEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  let claimPath;
  try {
    process.env.QA_HUB_TEST_REAL_HELPER = resolve(scriptRoot, "move-file-write-through.ps1");
    process.env.QA_HUB_TEST_NATIVE_READY = readyPath;
    process.env.QA_HUB_TEST_NATIVE_RELEASE = releasePath;
    process.env.QA_HUB_TEST_NATIVE_BARRIER_TARGET = ".publication-claim-";
    process.env.QA_HUB_TEST_RESTORE_UNKNOWN_SUCCESS = "1";
    writeFileSync(destination, previous, { flag: "wx" });
    const actor = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { existsSync, unlinkSync, writeFileSync } from "node:fs"; const deadline = Date.now() + 10000; while (!existsSync(${JSON.stringify(readyPath)})) { if (Date.now() >= deadline) throw new Error("ACTOR_TIMEOUT"); await new Promise((resolve) => setTimeout(resolve, 5)); } unlinkSync(${JSON.stringify(destination)}); writeFileSync(${JSON.stringify(destination)}, Buffer.from(${JSON.stringify(lateWinner.toString("base64"))}, "base64"), { flag: "wx" }); writeFileSync(${JSON.stringify(releasePath)}, "continue", { flag: "wx" });`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let publicationError;
    try {
      commitPreparedPublication({
        destination,
        temporary: join(root, "latest.tmp"),
        replacementBytes: Buffer.from('{"releaseId":"new"}\n'),
        expectedPreviousBytes: previous,
        receiptPath: join(root, "receipt.json"),
        receiptBytes: Buffer.from("prepared-receipt"),
        moveOptions: { helperPath: harness, retryMilliseconds: 100 },
        checkpoint(step) {
          if (step === "active-marker-durable") {
            const active = JSON.parse(readFileSync(activePath, "utf8"));
            claimPath = join(root, active.claimName);
          }
        },
      });
    } catch (error) {
      publicationError = error;
    }
    const actorResult = await collectChild(actor);
    assert.equal(actorResult.status, 0, actorResult.stderr);
    assert.equal(publicationError?.message, "PUBLISHED_FILE_CLAIM_PREIMAGE_MISMATCH");
    assert.equal(publicationError?.restored, true);
    assert.equal(publicationError?.restoreRecovered, true);
    assert.equal(publicationError?.restoreCause?.nativeError, 5);
    assert.ok(readFileSync(destination).equals(lateWinner));
    assert.equal(existsSync(claimPath), false);
    assert.ok(existsSync(activePath));
    assert.ok(existsSync(join(root, "latest.tmp")));
  } finally {
    for (const name of environmentNames) {
      if (priorEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = priorEnvironment[name];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale release retry settles a newer active transaction and cannot replay its old claim", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-publication-aba-"));
  const destination = join(root, "latest.json");
  const old = Buffer.from('{"releaseId":"old"}\n');
  const first = Buffer.from('{"releaseId":"first"}\n');
  const second = Buffer.from('{"releaseId":"second"}\n');
  const firstArguments = {
    destination,
    temporary: join(root, "first.tmp"),
    replacementBytes: first,
    expectedPreviousBytes: old,
    receiptPath: join(root, "first-receipt.json"),
    receiptBytes: Buffer.from("first-receipt"),
  };
  try {
    writeFileSync(destination, old, { flag: "wx" });
    commitPreparedPublication(firstArguments);
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "second.tmp"),
          replacementBytes: second,
          expectedPreviousBytes: first,
          receiptPath: join(root, "second-receipt.json"),
          receiptBytes: Buffer.from("second-receipt"),
          checkpoint(step) {
            if (step === "previous-claimed") throw new Error("SECOND_EXIT_IN_GAP");
          },
        }),
      /SECOND_EXIT_IN_GAP/u,
    );
    assert.equal(existsSync(destination), false);
    assert.throws(
      () => commitPreparedPublication(firstArguments),
      /PUBLISHED_FILE_CHANGED_BEFORE_COMMIT/u,
    );
    assert.ok(readFileSync(destination).equals(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("another writer cannot roll forward an active transaction whose prepared receipt is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-publication-missing-receipt-"));
  const destination = join(root, "latest.json");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const activeReceiptPath = join(root, "active-receipt.json");
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "active.tmp"),
          replacementBytes: Buffer.from('{"releaseId":"active"}\n'),
          expectedPreviousBytes: previous,
          receiptPath: activeReceiptPath,
          receiptBytes: Buffer.from("active-receipt"),
          checkpoint(step) {
            if (step === "previous-claimed") throw new Error("ACTIVE_EXIT_IN_GAP");
          },
        }),
      /ACTIVE_EXIT_IN_GAP/u,
    );
    unlinkSync(activeReceiptPath);
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "next.tmp"),
          replacementBytes: Buffer.from('{"releaseId":"next"}\n'),
          expectedPreviousBytes: Buffer.from('{"releaseId":"active"}\n'),
          receiptPath: join(root, "next-receipt.json"),
          receiptBytes: Buffer.from("next-receipt"),
        }),
      /ENOENT|PUBLISHED_FILE_RECOVERY_RECEIPT_MISMATCH/u,
    );
    assert.equal(existsSync(destination), false);
    assert.ok(existsSync(`${destination}.publication.sqlite.active.json`));
    assert.ok(existsSync(join(root, "active.tmp")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active recovery rejects a missing or changed installer bound by its own receipt", () => {
  for (const mutation of ["missing", "changed"]) {
    const root = mkdtempSync(join(tmpdir(), `qa-hub-recovery-installer-${mutation}-`));
    const pair = generateKeyPairSync("ed25519");
    const destination = join(root, "latest.json");
    const previous = Buffer.from('{"releaseId":"old"}\n');
    const active = createPreparedPreviewFixture({ root, pair, sequence: 18, destination });
    const next = createPreparedPreviewFixture({ root, pair, sequence: 19, destination });
    try {
      writeFileSync(destination, previous, { flag: "wx" });
      assert.throws(
        () =>
          commitPreparedPublication({
            ...active,
            expectedPreviousBytes: previous,
            checkpoint(step) {
              if (step === "previous-claimed") throw new Error("ACTIVE_EXIT_IN_GAP");
            },
          }),
        /ACTIVE_EXIT_IN_GAP/u,
      );
      if (mutation === "missing") unlinkSync(active.installerPath);
      else writeFileSync(active.installerPath, "changed-installer");
      assert.throws(
        () =>
          commitPreparedPublication({
            ...next,
            expectedPreviousBytes: active.replacementBytes,
          }),
        /PREPARED_RECEIPT_INSTALLER_(?:CHANGED|SIZE_MISMATCH)/u,
      );
      assert.equal(existsSync(destination), false);
      assert.ok(existsSync(`${destination}.publication.sqlite.active.json`));
      assert.ok(existsSync(active.temporary));
      assert.equal(existsSync(next.temporary), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("installer drift in the claim gap blocks latest creation and preserves recovery state", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-commit-window-installer-drift-"));
  const pair = generateKeyPairSync("ed25519");
  const destination = join(root, "latest.json");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const prepared = createPreparedPreviewFixture({ root, pair, sequence: 20, destination });
  let claimPath;
  let historyPath;
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          ...prepared,
          expectedPreviousBytes: previous,
          checkpoint(step) {
            if (step !== "previous-claimed") return;
            const active = JSON.parse(
              readFileSync(`${destination}.publication.sqlite.active.json`, "utf8"),
            );
            claimPath = join(root, active.claimName);
            historyPath = join(root, active.historyName);
            writeFileSync(prepared.installerPath, "changed-after-claim");
          },
        }),
      /PREPARED_RECEIPT_INSTALLER_(?:CHANGED|SIZE_MISMATCH)/u,
    );
    assert.equal(existsSync(destination), false);
    assert.ok(readFileSync(claimPath).equals(previous));
    assert.ok(existsSync(prepared.temporary));
    assert.ok(existsSync(`${destination}.publication.sqlite.active.json`));
    assert.equal(existsSync(historyPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite lock excludes a concurrent writer and is released after failure", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-locked-publication-"));
  const destination = join(root, "latest.json");
  const previous = Buffer.from('{"releaseId":"old"}\n');
  const replacement = Buffer.from('{"releaseId":"new"}\n');
  const arguments_ = {
    destination,
    temporary: join(root, "latest.tmp"),
    replacementBytes: replacement,
    expectedPreviousBytes: previous,
    receiptPath: join(root, "receipt.json"),
    receiptBytes: Buffer.from("receipt"),
  };
  try {
    writeFileSync(destination, previous, { flag: "wx" });
    assert.throws(
      () =>
        commitPreparedPublication({
          ...arguments_,
          checkpoint(step) {
            if (step !== "lock-acquired") return;
            assert.throws(
              () =>
                commitPreparedPublication({
                  destination,
                  temporary: join(root, "concurrent.tmp"),
                  replacementBytes: Buffer.from("concurrent"),
                  expectedPreviousBytes: previous,
                  receiptPath: join(root, "concurrent-receipt.json"),
                  receiptBytes: Buffer.from("concurrent-receipt"),
                }),
              /PUBLISHED_FILE_PUBLICATION_IN_PROGRESS/u,
            );
            throw new Error("OWNER_EXIT");
          },
        }),
      /OWNER_EXIT/u,
    );
    const result = commitPreparedPublication(arguments_);
    assert.equal(result.committed, true);
    assert.ok(readFileSync(destination).equals(replacement));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history prevents an externally deleted channel from being recreated as genesis", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-history-genesis-"));
  const destination = join(root, "latest.json");
  try {
    commitPreparedPublication({
      destination,
      temporary: join(root, "first.tmp"),
      replacementBytes: Buffer.from("first"),
      expectedPreviousBytes: null,
      receiptPath: join(root, "first-receipt.json"),
      receiptBytes: Buffer.from("first-receipt"),
    });
    unlinkSync(destination);
    assert.throws(
      () =>
        commitPreparedPublication({
          destination,
          temporary: join(root, "second.tmp"),
          replacementBytes: Buffer.from("second"),
          expectedPreviousBytes: null,
          receiptPath: join(root, "second-receipt.json"),
          receiptBytes: Buffer.from("second-receipt"),
        }),
      /PUBLISHED_FILE_HISTORY_PREVENTS_INITIAL_CREATE/u,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("sandbox preload AST gate accepts only direct allowlisted requires and ignores comments or strings", () => {
  const source = [
    "const text = 'require(\"./string-only.cjs\")';",
    '// require("/comment-only.cjs");',
    "/* require(dynamicComment); */",
    ...["electron", "events", "timers", "url"].map(
      (specifier) => `require(${JSON.stringify(specifier)});`,
    ),
  ].join("\n");
  const result = inspectSandboxPreload(source, "valid-preload.cjs");
  assert.equal(result.bytes, Buffer.byteLength(source));
  assert.match(result.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.modules, ["electron", "events", "timers", "url"]);

  for (const specifier of [
    "./bug-route.cjs",
    "../shared.cjs",
    "/tmp/local.cjs",
    "C:\\local\\x.cjs",
    "fs",
  ]) {
    expectGateCode(
      `require("electron"); require(${JSON.stringify(specifier)});`,
      "PREVIEW_SANDBOX_PRELOAD_REQUIRE_FORBIDDEN",
    );
  }
});

test("sandbox preload AST gate rejects syntax, missing Electron, dynamic and indirect require bypasses", () => {
  expectGateCode("const broken = ;", "PREVIEW_SANDBOX_PRELOAD_SYNTAX_INVALID");
  expectGateCode("const value = 1;", "PREVIEW_SANDBOX_PRELOAD_ELECTRON_REQUIRE_MISSING");
  expectGateCode('require("events");', "PREVIEW_SANDBOX_PRELOAD_ELECTRON_REQUIRE_MISSING");
  for (const source of [
    "require(moduleName);",
    'require("elec" + "tron");',
    "require(`electron`);",
    'require("electron", "events");',
  ]) {
    expectGateCode(source, "PREVIEW_SANDBOX_PRELOAD_REQUIRE_NON_LITERAL");
  }
  for (const source of [
    'const loader = require; loader("electron");',
    '(require)("electron");',
    'require?.("electron");',
    'globalThis.require("electron");',
    'globalThis["require"]("electron");',
    '(0, require)("electron");',
    'require.call(null, "electron");',
    'const { require: loader } = globalThis; loader("electron");',
  ]) {
    expectGateCode(source, "PREVIEW_SANDBOX_PRELOAD_REQUIRE_SHAPE_INVALID");
  }
});

test("sandbox preload byte binding rejects any staged, packaged, or final-source drift", () => {
  const source = Buffer.from('"use strict";\nconst electron = require("electron");\n');
  const snapshot = inspectSandboxPreload(source, "source-preload.cjs");
  assert.deepEqual(
    assertSandboxPreloadBinding(Buffer.from(source), source, snapshot, "staged-preload.cjs"),
    snapshot,
  );
  expectGateCode("", "PREVIEW_SANDBOX_PRELOAD_SOURCE_INVALID");
  assert.throws(
    () =>
      assertSandboxPreloadBinding(
        Buffer.concat([source, Buffer.from("\n")]),
        source,
        snapshot,
        "packaged-preload.cjs",
      ),
    (error) => error?.code === "PREVIEW_SANDBOX_PRELOAD_BINDING_MISMATCH",
  );
  assert.throws(
    () =>
      assertSandboxPreloadBinding(source, source, { ...snapshot, sha256: "0".repeat(64) }, "final"),
    (error) => error?.code === "PREVIEW_SANDBOX_PRELOAD_SOURCE_SNAPSHOT_INVALID",
  );
});

test("release content binding is deterministic and rejects drift or unsafe metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-release-binding-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "z.txt"), "z");
    writeFileSync(join(root, "nested", "a.txt"), "alpha");
    const first = snapshotReleaseDirectory(root);
    const second = snapshotReleaseDirectory(root);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.files.map((file) => file.path),
      ["nested/a.txt", "z.txt"],
    );
    assert.equal(validateReleaseContentSnapshot(first, "FIXTURE"), first);
    assert.equal(assertReleaseContentBinding(first, second, "FIXTURE"), second);

    writeFileSync(join(root, "nested", "a.txt"), "changed");
    assert.throws(
      () => assertReleaseContentBinding(first, snapshotReleaseDirectory(root), "DRIFT"),
      /DRIFT_MISMATCH/u,
    );
    assert.throws(
      () =>
        validateReleaseContentSnapshot(
          {
            ...first,
            files: [{ ...first.files[0], path: "../escape" }, ...first.files.slice(1)],
          },
          "UNSAFE",
        ),
      /UNSAFE_PATH_INVALID/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release content binding reads the exact files packed under app.asar dist", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-hub-release-asar-binding-"));
  const source = join(root, "source");
  const archive = join(root, "fixture.asar");
  try {
    mkdirSync(join(source, "dist", "nested"), { recursive: true });
    mkdirSync(join(source, "web"));
    writeFileSync(join(source, "dist", "main.js"), "main");
    writeFileSync(join(source, "dist", "nested", "preload.cjs"), "preload");
    writeFileSync(join(source, "web", "index.html"), "web");
    writeFileSync(join(source, "package.json"), '{"main":"dist/main.js"}');
    writeFileSync(join(source, "release.json"), '{"attestationSignature":"excluded"}');
    await asar.createPackage(source, archive);
    const expected = snapshotReleaseDirectory(join(source, "dist"));
    assert.deepEqual(snapshotReleaseAsarDirectory(archive, "dist"), expected);
    assert.throws(
      () =>
        assertReleaseContentBinding(
          { ...expected, digest: "0".repeat(64) },
          snapshotReleaseAsarDirectory(archive, "dist"),
          "TAMPERED_RELEASE",
        ),
      /TAMPERED_RELEASE_EXPECTED_DIGEST_INVALID/u,
    );
    const expectedPackage = snapshotReleasePackageDirectory(source);
    assert.deepEqual(snapshotReleasePackageAsar(archive), expectedPackage);
    assert.equal(
      expectedPackage.files.some((file) => file.path === "release.json"),
      false,
    );
    assert.equal(
      expectedPackage.files.some((file) => file.path === "package.json"),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release attestation serialization binds every executable package input", () => {
  const pair = generateKeyPairSync("ed25519");
  const snapshot = {
    algorithm: "sha256",
    digest: "a".repeat(64),
    files: [{ path: "main.js", bytes: 4, sha256: "b".repeat(64) }],
  };
  const release = {
    schemaVersion: 1,
    releaseId: "20260911T123456789Z",
    version: "0.2.0-preview.18",
    sourceCommit: "c".repeat(40),
    sourceDirty: false,
    instanceId: "qa-hub-preview-unit",
    packageIdentity: { executableBaseName: "RelayQaHubPreview-unit" },
    preload: { bytes: 4, sha256: "d".repeat(64), modules: ["electron"] },
    build: { producer: "package-preview.mjs", artifacts: { desktop: snapshot, web: snapshot } },
    packageContent: snapshot,
  };
  const signature = sign(null, serializeReleaseAttestation(release), pair.privateKey);
  assert.equal(verify(null, serializeReleaseAttestation(release), pair.publicKey, signature), true);
  assert.equal(
    verify(
      null,
      serializeReleaseAttestation({
        ...release,
        packageContent: { ...snapshot, digest: "e".repeat(64) },
      }),
      pair.publicKey,
      signature,
    ),
    false,
  );
  assert.equal(
    verify(
      null,
      serializeReleaseAttestation({
        ...release,
        packageIdentity: { executableBaseName: "tampered.exe" },
      }),
      pair.publicKey,
      signature,
    ),
    false,
  );
});

test("preview packaging binds source, staged and app.asar preload before publication", () => {
  const firstMkdir = packageSource.indexOf("mkdirSync(root");
  const desktopBuild = packageSource.indexOf('runBuild(\n  "desktop"');
  const webBuild = packageSource.indexOf('runBuild(\n  "web"');
  const postBuildCleanGate = packageSource.indexOf(
    "assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit)",
  );
  const sourceGate = packageSource.indexOf("const sourcePreloadSnapshot = inspectSandboxPreload(");
  const stagedGate = packageSource.indexOf(
    "const stagedPreloadSnapshot = assertSandboxPreloadBinding(",
  );
  const artifactSnapshot = packageSource.indexOf("const buildArtifacts = {");
  const packagerCall = packageSource.indexOf("const packaged = await packager(");
  const packagedGate = packageSource.indexOf(
    "const packagedPreloadSnapshot = assertSandboxPreloadBinding(",
  );
  const installerBuild = packageSource.indexOf("const installerName =");
  const archiveRead = packageSource.indexOf("const archive = readFileSync(stagedInstaller);");
  const finalPackagedGate = packageSource.indexOf(
    "const finalPackagedPreloadSnapshot = assertSandboxPreloadBinding(",
  );
  const signing = packageSource.indexOf("const signature = sign(");
  const finalSourceGate = packageSource.indexOf(
    "const finalSourcePreloadSnapshot = assertSandboxPreloadBinding(",
  );
  const finalReleaseGate = packageSource.indexOf("const finalPackagedReleaseBytes =");
  const finalStagedReleaseGate = packageSource.indexOf(
    'readFileSync(join(stage, "release.json")).equals(stageReleaseBytes)',
  );
  const finalPreviewConfigGate = packageSource.indexOf(
    'readFileSync(join(packageDirectory, "preview-instance.json")).equals(',
  );
  const finalCleanGate = packageSource.indexOf(
    "assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit)",
    finalPreviewConfigGate,
  );
  const publication = packageSource.indexOf("publishFileExclusiveDurable(");
  const postPublicationCleanGate = packageSource.lastIndexOf(
    "assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit)",
  );

  assert.ok(
    firstMkdir >= 0 &&
      firstMkdir < desktopBuild &&
      desktopBuild < webBuild &&
      webBuild < postBuildCleanGate &&
      postBuildCleanGate < sourceGate,
  );
  assert.ok(
    sourceGate < stagedGate && stagedGate < artifactSnapshot && artifactSnapshot < packagerCall,
  );
  assert.ok(packagerCall < packagedGate && packagedGate < installerBuild);
  assert.ok(archiveRead < finalPackagedGate && finalPackagedGate < signing);
  assert.ok(
    finalSourceGate < finalReleaseGate &&
      finalReleaseGate < finalStagedReleaseGate &&
      finalStagedReleaseGate < finalPreviewConfigGate &&
      finalPreviewConfigGate < finalCleanGate &&
      finalCleanGate < publication &&
      publication < postPublicationCleanGate,
  );
  assert.match(packageSource, /const stageReleaseBytes = Buffer\.from/u);
  assert.match(packageSource, /FINAL_PACKAGED_RELEASE_BINDING_MISMATCH/u);
  assert.match(packageSource, /FINAL_STAGED_RELEASE_BINDING_MISMATCH/u);
  assert.match(packageSource, /FINAL_PACKAGED_PREVIEW_CONFIG_BINDING_MISMATCH/u);
  assert.equal(
    packageSource.match(/asar\.extractFile\(packagedAsarPath, "dist\/preload\.cjs"\)/gu)?.length,
    2,
  );
  assert.equal(packageSource.match(/sourcePreloadBytes,\s+sourcePreloadSnapshot,/gu)?.length, 4);
  assert.equal(
    packageSource.match(/snapshotReleaseAsarDirectory\(packagedAsarPath, "(?:dist|web)"\)/gu)
      ?.length,
    4,
  );
  assert.equal(
    packageSource.match(/snapshotReleaseDirectory\(join\(stage, "(?:dist|web)"\)\)/gu)?.length,
    4,
  );
});

test("package identity preserves only the explicit legacy identity and isolates other instances", () => {
  const legacy = derivePreviewPackageIdentity("qa-hub-preview-7c86");
  assert.deepEqual(legacy, {
    instanceId: "qa-hub-preview-7c86",
    executableBaseName: "RelayQaHubPreview",
    installDirectoryName: "RelayQaHubPreview",
    uninstallRegistryKey: "RelayQaHubPreview",
    shortcutName: "QA Hub Project Preview",
    protocolScheme: "qa-hub-preview",
    appUserModelId: "com.relayqahub.desktop.preview",
    toastActivatorClsid: "{67209CEA-77EF-5AC8-BC78-C571C64CBAF2}",
    displayName: "QA Hub Project Preview",
  });

  const final = derivePreviewPackageIdentity("qa-hub-preview-final-sol-0909");
  assert.equal(final.executableBaseName, "RelayQaHubPreview-final-sol-0909");
  assert.equal(final.installDirectoryName, "RelayQaHubPreview-final-sol-0909");
  assert.equal(final.uninstallRegistryKey, "RelayQaHubPreview-final-sol-0909");
  assert.equal(final.shortcutName, "QA Hub Project Preview - final-sol-0909");
  assert.equal(final.protocolScheme, "qa-hub-preview-final-sol-0909");
  assert.equal(final.appUserModelId, "com.relayqahub.desktop.preview.final.sol.0909");
  assert.equal(final.toastActivatorClsid, "{447C6274-B710-5380-B7A1-1549E1EC5317}");
  assert.equal(final.displayName, "QA Hub Project Preview (final-sol-0909)");

  const lan = derivePreviewPackageIdentity("qa-hub-lan-v22-0911");
  assert.equal(lan.executableBaseName, "RelayQaHubLAN-v22-0911");
  assert.equal(lan.installDirectoryName, "RelayQaHubLAN-v22-0911");
  assert.equal(lan.uninstallRegistryKey, "RelayQaHubLAN-v22-0911");
  assert.equal(lan.shortcutName, "Relay QA Hub 团队版");
  assert.equal(lan.protocolScheme, "qa-hub-lan-v22-0911");
  assert.equal(lan.appUserModelId, "com.relayqahub.desktop.lan.v22.0911");
  assert.equal(lan.displayName, "Relay QA Hub 团队版");

  assert.equal(
    deriveToastActivatorClsid("COM.Example.MixedCase"),
    "{6B29DA0C-B46A-5724-B37C-DB14009734BE}",
  );
  assert.match(
    final.toastActivatorClsid,
    /^\{[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/u,
  );
  assert.notEqual(final.toastActivatorClsid, legacy.toastActivatorClsid);
  assert.notEqual(
    deriveToastActivatorClsid("COM.Example.MixedCase"),
    deriveToastActivatorClsid("com.example.mixedcase"),
    "UUIDv5 input must preserve the AppUserModelId's original case",
  );
  assert.throws(
    () => deriveToastActivatorClsid("com.example.bad\u0000identity"),
    /APP_USER_MODEL_ID_INVALID/u,
  );

  for (const invalid of [
    "qa-hub-preview-a",
    "qa-hub-preview--bad",
    "qa-hub-preview-bad--identity",
    "qa-hub-preview-bad-",
    "QA-HUB-PREVIEW-BAD",
    "qa-hub-preview-bad/path",
    'qa-hub-preview-bad"define',
  ]) {
    assert.throws(() => derivePreviewPackageIdentity(invalid), /INSTANCE_ID_INVALID/u);
  }
});

test("LAN release exposes stable 1.0.0 team branding while retaining its install identity", () => {
  assert.match(
    packageSource,
    /const version = teamEdition \? "1\.0\.0" : `0\.2\.0-\$\{config\.deploymentMode\}\.\$\{buildNumber\}`/u,
  );
  assert.match(packageSource, /Relay-QA-Hub-团队版-\$\{version\}-\$\{releaseId\}\.exe/u);
  assert.match(packageSource, /generate-team-windows-icon\.mjs/u);
  assert.match(packageSource, /`\/DFILE_VERSION=\$\{executableFileVersion\}`/u);
  assert.match(installerSource, /VIProductVersion "\$\{FILE_VERSION\}"/u);

  const root = mkdtempSync(join(tmpdir(), "qa-team-icon-"));
  try {
    const icon = join(root, "RelayQaHub.ico");
    const generated = spawnSync(
      process.execPath,
      [resolve(sourceRoot, "apps/desktop/scripts/generate-team-windows-icon.mjs"), icon],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = readFileSync(icon);
    assert.equal(bytes.readUInt16LE(0), 0);
    assert.equal(bytes.readUInt16LE(2), 1);
    assert.equal(bytes.readUInt16LE(4), 8);
    assert.ok(bytes.length > 300_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview installer binds Electron's canonical Start Menu shortcut and COM activation", () => {
  const shortcutFunction = installerSource.slice(
    installerSource.indexOf("Function CreateIdentityShortcut"),
    installerSource.indexOf('Section "QA Hub Preview"'),
  );
  assert.match(shortcutFunction, /\$\{PKEY_AppUserModel_ID\}/u);
  assert.match(shortcutFunction, /\$\{PKEY_AppUserModel_ToastActivatorCLSID\}/u);
  assert.match(shortcutFunction, /\$\{APP_USER_MODEL_ID\}/u);
  assert.match(shortcutFunction, /\$\{TOAST_ACTIVATOR_CLSID\}/u);
  assert.match(shortcutFunction, /\$\{VT_LPWSTR\}/u);
  assert.match(shortcutFunction, /\$\{VT_CLSID\}/u);
  assert.match(shortcutFunction, /IPropertyStore::Commit/u);
  assert.match(shortcutFunction, /IPersistFile::Save/u);
  assert.match(
    shortcutFunction,
    /!insertmacro ComHlpr_CreateInProcInstance \$\{CLSID_ShellLink\} \$\{IID_IShellLink\} r0 \.r2/u,
    "CoCreateInstance must capture HRESULT in an output register",
  );
  assert.doesNotMatch(
    shortcutFunction,
    /!insertmacro ComHlpr_CreateInProcInstance \$\{CLSID_ShellLink\} \$\{IID_IShellLink\} r0 r2/u,
    "an input-register HRESULT operand leaves the shell-link pointer unset",
  );

  const installSection = installerSource.slice(
    installerSource.indexOf('Section "QA Hub Preview"'),
    installerSource.indexOf('Section "Uninstall"'),
  );
  assert.equal(installSection.match(/Call CreateIdentityShortcut/gu)?.length, 2);
  assert.match(
    installSection,
    /StrCpy \$RegistrationMayBeDirty 1\s+StrCpy \$ShortcutPath "\$DESKTOP/u,
    "the first shell mutation marks an upgrade rollback unsafe to relaunch",
  );
  assert.equal(
    installSection.match(/\$SMPROGRAMS\\\$\{DISPLAY_NAME\}\.lnk/gu)?.length,
    2,
    "Electron's root ProductName link has one create path and one fresh-failure cleanup path",
  );
  assert.match(installSection, /StrCpy \$ShortcutPath "\$SMPROGRAMS\\\$\{DISPLAY_NAME\}\.lnk"/u);
  assert.doesNotMatch(
    installSection,
    /StrCpy \$ShortcutPath "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\\\$\{SHORTCUT_NAME\}\.lnk"/u,
  );
  assert.doesNotMatch(installSection, /CreateDirectory "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}"/u);
  assert.match(
    installSection,
    /StrCmp "\$\{DISPLAY_NAME\}" "\$\{SHORTCUT_NAME\}" cleanup_legacy_nested_shortcut\s+Delete "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\.lnk"/u,
    "a non-legacy instance removes the old root shortcut without deleting the canonical legacy link",
  );
  assert.equal(
    installSection.match(/Delete "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\\\$\{SHORTCUT_NAME\}\.lnk"/gu)
      ?.length,
    2,
    "successful migration and fresh-failure cleanup both remove the exact old nested link",
  );
  assert.doesNotMatch(installSection, /CreateShortCut/u);
  assert.match(
    installSection,
    /WriteRegStr HKCU "Software\\Classes\\CLSID\\\$\{TOAST_ACTIVATOR_CLSID\}\\LocalServer32" "" '\$\\"\$INSTDIR\\\$\{EXECUTABLE_BASENAME\}\.exe\$\\"'/u,
  );
  assert.match(
    installSection,
    /WriteRegDWORD HKCU "Software\\Classes\\CLSID\\\$\{TOAST_ACTIVATOR_CLSID\}" "CustomActivator" 1/u,
  );
  assert.match(installSection, /Section "QA Hub Preview"[\s\S]+?SetRegView 64/u);
  assert.match(
    installSection,
    /SetRegView 32\s+DeleteRegKey HKCU "Software\\Classes\\CLSID\\\$\{TOAST_ACTIVATOR_CLSID\}"[\s\S]+Call VerifyRegistryKeyAbsent\s+SetRegView 64\s+StrCmp \$RegistryKeyAbsent 1 \+2/u,
    "the installer migrates only this deterministic CLSID out of NSIS's legacy 32-bit view",
  );
  const stableRegistration = installSection.indexOf(
    'WriteRegStr HKCU "Software\\Classes\\CLSID\\${TOAST_ACTIVATOR_CLSID}\\LocalServer32"',
  );
  const stableRegistrationGate = installSection.indexOf(
    "IfErrors registration_failed",
    stableRegistration,
  );
  const legacyCleanup = installSection.indexOf("cleanup_legacy_nested_shortcut:");
  const releaseRegistration = installSection.indexOf(
    'WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"',
  );
  assert.ok(
    stableRegistration >= 0 &&
      stableRegistrationGate > stableRegistration &&
      legacyCleanup > stableRegistrationGate &&
      releaseRegistration > legacyCleanup,
    "release-specific registration must happen only after stable identity and legacy cleanup succeed",
  );
  assert.match(
    installSection,
    /Delete "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\\\$\{SHORTCUT_NAME\}\.lnk"\s+IfFileExists "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\\\$\{SHORTCUT_NAME\}\.lnk" registration_failed/u,
  );

  const uninstallSection = installerSource.slice(installerSource.indexOf('Section "Uninstall"'));
  assert.match(uninstallSection, /Delete "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"/u);
  assert.match(uninstallSection, /Delete "\$SMPROGRAMS\\\$\{DISPLAY_NAME\}\.lnk"/u);
  assert.match(uninstallSection, /Delete "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\.lnk"/u);
  assert.match(
    uninstallSection,
    /Delete "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\\\$\{SHORTCUT_NAME\}\.lnk"/u,
  );
  assert.match(
    uninstallSection,
    /DeleteRegKey HKCU "Software\\Classes\\CLSID\\\$\{TOAST_ACTIVATOR_CLSID\}"/u,
  );
  assert.match(uninstallSection, /Call un\.VerifyRegistrationRemoved/u);
  assert.match(
    uninstallSection,
    /SetRegView 32\s+DeleteRegKey HKCU "Software\\Classes\\CLSID\\\$\{TOAST_ACTIVATOR_CLSID\}"\s+SetRegView 64\s+Call un\.VerifyRegistrationRemoved/u,
  );
  assert.match(
    uninstallSection,
    /StrCmp \$RegistrationCleanupSucceeded 1 uninstall_cleanup_confirmed uninstall_cleanup_failed/u,
  );
  const uninstallCleanupFailure = uninstallSection.slice(
    uninstallSection.indexOf("uninstall_cleanup_failed:"),
  );
  assert.match(
    uninstallCleanupFailure,
    /StrCpy \$VerificationDirectory "\$BackupDirectory"\s+Call un\.VerifyPreviewInstallDirectory\s+StrCmp \$VerificationSucceeded 1 uninstall_restore_payload uninstall_rollback_failed/u,
  );
  assert.match(
    uninstallCleanupFailure,
    /uninstall_restore_payload:\s+StrCpy \$RenameSource "\$BackupDirectory"\s+StrCpy \$RenameDestination "\$INSTDIR"\s+Call un\.RetryRenameDirectory\s+StrCmp \$RenameSucceeded 1 uninstall_verify_restored_payload uninstall_rollback_failed/u,
  );
  assert.match(
    uninstallCleanupFailure,
    /uninstall_verify_restored_payload:\s+StrCpy \$VerificationDirectory "\$INSTDIR"\s+Call un\.VerifyPreviewInstallDirectory\s+StrCmp \$VerificationSucceeded 1 uninstall_cleanup_failed_rolled_back uninstall_rollback_failed/u,
  );
  assert.match(
    uninstallCleanupFailure,
    /uninstall_cleanup_failed_rolled_back:\s+SetErrorLevel 33\s+Goto uninstall_finished/u,
  );
  assert.match(uninstallCleanupFailure, /uninstall_rollback_failed:[\s\S]+SetErrorLevel 34/u);
  assert.doesNotMatch(uninstallSection, /Relay QA Hub|com\.relayqahub\.desktop(?!\.preview)/u);
});

test("preview installer bounds every update rename and verifies safe terminal states", () => {
  assert.match(installerSource, /!define INSTALL_RENAME_MAX_ATTEMPTS 40/u);
  assert.match(installerSource, /!define INSTALL_RENAME_RETRY_DELAY_MS 250/u);

  const retryFunction = installerSource.slice(
    installerSource.indexOf("Function RetryRenameDirectory"),
    installerSource.indexOf("Function VerifyPreviewInstallDirectory"),
  );
  assert.match(
    retryFunction,
    /StrCpy \$RenameAttemptsRemaining \$\{INSTALL_RENAME_MAX_ATTEMPTS\}/u,
  );
  assert.match(
    retryFunction,
    /rename_directory_attempt:\s+ClearErrors\s+Rename "\$RenameSource" "\$RenameDestination"\s+IfErrors rename_directory_retry/u,
  );
  assert.match(
    retryFunction,
    /IntOp \$RenameAttemptsRemaining \$RenameAttemptsRemaining - 1\s+IntCmp \$RenameAttemptsRemaining 0 rename_directory_exhausted rename_directory_exhausted rename_directory_wait/u,
  );
  assert.match(
    retryFunction,
    /rename_directory_wait:\s+Sleep \$\{INSTALL_RENAME_RETRY_DELAY_MS\}\s+Goto rename_directory_attempt/u,
  );
  assert.equal(installerSource.match(/Call RetryRenameDirectory/gu)?.length, 3);

  const verificationFunction = installerSource.slice(
    installerSource.indexOf("Function VerifyPreviewInstallDirectory"),
    installerSource.indexOf("Function VerifyRegistryKeyAbsent"),
  );
  assert.match(
    verificationFunction,
    /IfFileExists "\$VerificationDirectory\\\.preview-instance-id"/u,
  );
  assert.match(
    verificationFunction,
    /IfFileExists "\$VerificationDirectory\\\$\{EXECUTABLE_BASENAME\}\.exe"/u,
  );
  assert.match(
    verificationFunction,
    /StrCmp \$ExistingIdentity "\$\{INSTANCE_ID\}" 0 verification_finished/u,
  );
  const installerRegistryKeyAbsence = installerSource.slice(
    installerSource.indexOf("Function VerifyRegistryKeyAbsent"),
    installerSource.indexOf("Function un.VerifyRegistryKeyAbsent"),
  );
  assert.match(installerRegistryKeyAbsence, /advapi32::RegOpenKeyExW/u);
  assert.match(
    installerRegistryKeyAbsence,
    /IntCmp \$1 2 registry_key_absent registry_key_not_absent registry_key_not_absent/u,
  );
  assert.match(installerRegistryKeyAbsence, /advapi32::RegCloseKey/u);

  const uninstallerRegistryKeyAbsence = installerSource.slice(
    installerSource.indexOf("Function un.VerifyRegistryKeyAbsent"),
    installerSource.indexOf("Function VerifyRegistrationRemoved"),
  );
  assert.match(uninstallerRegistryKeyAbsence, /advapi32::RegOpenKeyExW/u);
  assert.match(
    uninstallerRegistryKeyAbsence,
    /IntCmp \$1 2 un_registry_key_absent un_registry_key_not_absent un_registry_key_not_absent/u,
  );
  assert.match(uninstallerRegistryKeyAbsence, /advapi32::RegCloseKey/u);

  const installerRegistrationRemoval = installerSource.slice(
    installerSource.indexOf("Function VerifyRegistrationRemoved"),
    installerSource.indexOf("Function un.VerifyRegistrationRemoved"),
  );
  const uninstallerRegistrationRemoval = installerSource.slice(
    installerSource.indexOf("Function un.VerifyRegistrationRemoved"),
    installerSource.indexOf("Function CompareFilesExact"),
  );
  for (const registrationRemoval of [
    installerRegistrationRemoval,
    uninstallerRegistrationRemoval,
  ]) {
    for (const exactPath of [
      /\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk/u,
      /\$SMPROGRAMS\\\$\{DISPLAY_NAME\}\.lnk/u,
      /\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\.lnk/u,
      /\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\\\$\{SHORTCUT_NAME\}\.lnk/u,
    ]) {
      assert.match(registrationRemoval, exactPath);
    }
    for (const exactKey of [
      "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_REGISTRY_KEY}",
      "Software\\Classes\\${PROTOCOL_SCHEME}",
      "Software\\Classes\\CLSID\\${TOAST_ACTIVATOR_CLSID}",
    ]) {
      assert.ok(registrationRemoval.includes(exactKey));
    }
    assert.match(registrationRemoval, /StrCpy \$RegistryViewAccess 0x20119/u);
    assert.match(registrationRemoval, /StrCpy \$RegistryViewAccess 0x20219/u);
  }
  assert.equal(installerRegistrationRemoval.match(/Call VerifyRegistryKeyAbsent/gu)?.length, 4);
  assert.equal(
    uninstallerRegistrationRemoval.match(/Call un\.VerifyRegistryKeyAbsent/gu)?.length,
    4,
  );

  const payloadFailure = installerSource.slice(
    installerSource.indexOf("install_failed:"),
    installerSource.indexOf("rename_failed:"),
  );
  assert.match(payloadFailure, /StrCpy \$FailedDirectory "\$INSTDIR\.failed-\$\{RELEASE_ID\}"/u);
  assert.match(
    payloadFailure,
    /find_unique_failed_directory:\s+System::Call 'kernel32::GetFileAttributesW\(w "\$FailedDirectory"\) i\.r0'\s+IntCmp \$0 -1 failed_directory_ready next_failed_directory next_failed_directory/u,
  );
  assert.match(
    payloadFailure,
    /GetFileAttributesW\(w "\$INSTDIR"\)[\s\S]+IntCmp \$1 0 choose_failed_directory quarantine_failed quarantine_failed/u,
  );
  assert.ok(
    payloadFailure.indexOf('StrCpy $RenameDestination "$FailedDirectory"') <
      payloadFailure.indexOf('StrCpy $VerificationDirectory "$BackupDirectory"'),
    "the partial payload must be isolated before the old backup is read or restored",
  );
  assert.match(
    payloadFailure,
    /failed_payload_ready:\s+StrCmp \$HadExistingInstall 1 restore_backup verify_fresh_failure/u,
  );
  assert.match(
    payloadFailure,
    /rollback_confirmed:\s+;[^\r\n]*\r?\n\s*;[^\r\n]*\r?\n\s*StrCmp \$RegistrationMayBeDirty 1 rollback_registration_dirty\s+SetErrorLevel 21\s+Goto finished\s+rollback_registration_dirty:\s+SetErrorLevel 27\s+Goto finished/u,
  );
  assert.match(
    payloadFailure,
    /verify_restored_backup:\s+StrCpy \$VerificationDirectory "\$INSTDIR"\s+Call VerifyPreviewInstallDirectory\s+StrCmp \$VerificationSucceeded 1 rollback_confirmed rollback_restore_failed/u,
  );
  assert.match(
    payloadFailure,
    /quarantine_failed:\s+;[^\r\n]*\r?\n\s*SetErrorLevel 23\s+Goto finished/u,
  );
  assert.match(
    payloadFailure,
    /rollback_restore_failed:\s+;[^\r\n]*\r?\n\s*SetErrorLevel 24\s+Goto finished/u,
  );
  assert.match(
    payloadFailure,
    /fresh_failure_confirmed:\s+;[^\r\n]*\r?\n\s*StrCmp \$RegistrationCleanupSucceeded 1 fresh_failure_cleanup_confirmed registration_cleanup_failed\s+fresh_failure_cleanup_confirmed:\s+SetErrorLevel 25\s+Goto finished\s+registration_cleanup_failed:\s+;[^\r\n]*\r?\n\s*SetErrorLevel 26\s+Goto finished/u,
  );
  assert.equal(installerSource.match(/SetErrorLevel 21/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 22/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 23/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 24/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 25/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 26/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 27/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 33/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 34/gu)?.length, 1);

  const initialRenameFailure = installerSource.slice(installerSource.indexOf("rename_failed:"));
  assert.match(
    initialRenameFailure,
    /^rename_failed:\s+StrCpy \$VerificationDirectory "\$INSTDIR"\s+Call VerifyPreviewInstallDirectory\s+StrCmp \$VerificationSucceeded 1 rename_failed_safe rollback_restore_failed/mu,
  );
  assert.match(initialRenameFailure, /rename_failed_safe:\s+SetErrorLevel 22\s+Goto finished/u);

  const uninstallerRetryFunction = installerSource.slice(
    installerSource.indexOf("Function un.RetryRenameDirectory"),
    installerSource.indexOf("Function un.VerifyPreviewInstallDirectory"),
  );
  assert.match(
    uninstallerRetryFunction,
    /StrCpy \$RenameAttemptsRemaining \$\{INSTALL_RENAME_MAX_ATTEMPTS\}/u,
  );
  assert.match(
    uninstallerRetryFunction,
    /un_rename_directory_attempt:\s+ClearErrors\s+Rename "\$RenameSource" "\$RenameDestination"\s+IfErrors un_rename_directory_retry/u,
  );
  assert.match(
    uninstallerRetryFunction,
    /IntOp \$RenameAttemptsRemaining \$RenameAttemptsRemaining - 1\s+IntCmp \$RenameAttemptsRemaining 0 un_rename_directory_exhausted un_rename_directory_exhausted un_rename_directory_wait/u,
  );

  const uninstallerVerificationFunction = installerSource.slice(
    installerSource.indexOf("Function un.VerifyPreviewInstallDirectory"),
    installerSource.indexOf("Function VerifyRegistryKeyAbsent"),
  );
  assert.match(
    uninstallerVerificationFunction,
    /IfFileExists "\$VerificationDirectory\\\.preview-instance-id"/u,
  );
  assert.match(
    uninstallerVerificationFunction,
    /IfFileExists "\$VerificationDirectory\\\$\{EXECUTABLE_BASENAME\}\.exe"/u,
  );
  assert.match(
    uninstallerVerificationFunction,
    /StrCmp \$ExistingIdentity "\$\{INSTANCE_ID\}" 0 un_verification_finished/u,
  );
});

test("preview installer transactionally restores an upgrade's exact shell registration", () => {
  const compareFiles = installerSource.slice(
    installerSource.indexOf("Function CompareFilesExact"),
    installerSource.indexOf("Function BackupRegistrationFile"),
  );
  assert.match(installerSource, /!define MAX_REGISTRATION_COMPARE_BYTES 1048576/u);
  assert.match(
    compareFiles,
    /GetFileSize\(p r0, \*i \.r4\) i\.r2[\s\S]+StrCmp \$4 0 0 compare_files_close_b/u,
  );
  assert.match(
    compareFiles,
    /GetFileSize\(p r1, \*i \.r5\) i\.r3[\s\S]+StrCmp \$5 0 0 compare_files_close_b/u,
  );
  assert.match(
    compareFiles,
    /IntCmp \$2 \$\{MAX_REGISTRATION_COMPARE_BYTES\}[\s\S]+IntCmp \$3 \$\{MAX_REGISTRATION_COMPARE_BYTES\}/u,
  );
  assert.match(compareFiles, /StrCmp \$2 \$3 compare_files_sizes_match compare_files_close_b/u);
  assert.match(compareFiles, /FileReadByte \$0 \$7[\s\S]+FileReadByte \$1 \$8/u);
  assert.match(
    compareFiles,
    /FileReadByte \$0 \$7\s+[^]*?IfErrors compare_files_close_b[\s\S]+FileReadByte \$1 \$8\s+IfErrors compare_files_close_b/u,
    "every premature EOF or read error must fail closed",
  );
  assert.doesNotMatch(compareFiles, /IfErrors compare_files_equal/u);
  assert.match(
    compareFiles,
    /compare_files_verify_final_sizes:[\s\S]+GetFileSize\(p r0,[\s\S]+StrCmp \$7 \$2 0 compare_files_close_b[\s\S]+GetFileSize\(p r1,[\s\S]+StrCmp \$7 \$3 0 compare_files_close_b/u,
    "both file sizes must remain unchanged through the full byte loop",
  );

  const backupFile = installerSource.slice(
    installerSource.indexOf("Function BackupRegistrationFile"),
    installerSource.indexOf("Function RestoreRegistrationFile"),
  );
  assert.match(
    backupFile,
    /CopyFiles \/SILENT \/FILESONLY "\$RegistrationSourcePath" "\$RegistrationBackupFile"/u,
  );
  assert.match(backupFile, /Call CompareFilesExact/u);
  assert.match(backupFile, /StrCpy \$RegistrationResourceWasPresent 1/u);

  const restoreFile = installerSource.slice(
    installerSource.indexOf("Function RestoreRegistrationFile"),
    installerSource.indexOf("Function BackupRegistryKey"),
  );
  assert.match(
    restoreFile,
    /Delete "\$RegistrationSourcePath"\s+IfFileExists "\$RegistrationSourcePath" restore_registration_file_finished/u,
  );
  assert.match(restoreFile, /Call CompareFilesExact/u);

  const backupRegistry = installerSource.slice(
    installerSource.indexOf("Function BackupRegistryKey"),
    installerSource.indexOf("Function RestoreRegistryKey"),
  );
  assert.match(backupRegistry, /Call VerifyRegistryKeyAbsent/u);
  assert.match(
    backupRegistry,
    /reg\.exe" export "HKCU\\\$RegistryKeyPath" "\$RegistrationBackupFile" \/y \/reg:\$RegistryViewName/u,
  );
  assert.match(backupRegistry, /StrCmp \$0 0 0 backup_registry_key_finished/u);

  const restoreRegistry = installerSource.slice(
    installerSource.indexOf("Function RestoreRegistryKey"),
    installerSource.indexOf("Function BackupRegistrationState"),
  );
  assert.match(
    restoreRegistry,
    /reg\.exe" delete "HKCU\\\$RegistryKeyPath" \/f \/reg:\$RegistryViewName/u,
  );
  assert.match(
    restoreRegistry,
    /reg\.exe" import "\$RegistrationBackupFile" \/reg:\$RegistryViewName/u,
  );
  assert.match(
    restoreRegistry,
    /reg\.exe" export "HKCU\\\$RegistryKeyPath" "\$CompareFileB" \/y \/reg:\$RegistryViewName/u,
  );
  assert.match(restoreRegistry, /Call CompareFilesExact/u);

  const backupState = installerSource.slice(
    installerSource.indexOf("Function BackupRegistrationState"),
    installerSource.indexOf("Function RestoreRegistrationState"),
  );
  const restoreState = installerSource.slice(
    installerSource.indexOf("Function RestoreRegistrationState"),
    installerSource.indexOf("Function CreateIdentityShortcut"),
  );
  for (const [sourcePath, backupName] of [
    ["$DESKTOP\\${SHORTCUT_NAME}.lnk", "desktop.lnk"],
    ["$SMPROGRAMS\\${DISPLAY_NAME}.lnk", "start-canonical.lnk"],
    ["$SMPROGRAMS\\${SHORTCUT_NAME}.lnk", "start-legacy-root.lnk"],
    ["$SMPROGRAMS\\${SHORTCUT_NAME}\\${SHORTCUT_NAME}.lnk", "start-legacy-nested.lnk"],
  ]) {
    assert.ok(backupState.includes(`StrCpy $RegistrationSourcePath "${sourcePath}"`));
    assert.ok(backupState.includes(`$RegistrationBackupDirectory\\${backupName}`));
    assert.ok(restoreState.includes(`StrCpy $RegistrationSourcePath "${sourcePath}"`));
    assert.ok(restoreState.includes(`$RegistrationBackupDirectory\\${backupName}`));
  }
  assert.match(
    backupState,
    /StrCpy \$LegacyNestedDirectoryWasPresent 0[\s\S]+IfFileExists "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}" 0 \+2/u,
  );
  assert.match(
    restoreState,
    /StrCmp \$LegacyNestedDirectoryWasPresent 1 restore_legacy_nested_directory_present/u,
  );

  for (const [keyPath, backupName, view] of [
    [
      "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_REGISTRY_KEY}",
      "uninstall-64.reg",
      "64",
    ],
    ["Software\\Classes\\${PROTOCOL_SCHEME}", "protocol-64.reg", "64"],
    ["Software\\Classes\\CLSID\\${TOAST_ACTIVATOR_CLSID}", "clsid-64.reg", "64"],
    ["Software\\Classes\\CLSID\\${TOAST_ACTIVATOR_CLSID}", "clsid-32.reg", "32"],
  ]) {
    assert.ok(backupState.includes(`StrCpy $RegistryKeyPath "${keyPath}"`));
    assert.ok(backupState.includes(`$RegistrationBackupDirectory\\${backupName}`));
    assert.ok(restoreState.includes(`StrCpy $RegistryViewName ${view}`));
    assert.ok(restoreState.includes(`$RegistrationBackupDirectory\\${backupName}`));
  }

  const installSection = installerSource.slice(
    installerSource.indexOf('Section "QA Hub Preview"'),
    installerSource.indexOf('Section "Uninstall"'),
  );
  const snapshot = installSection.indexOf("Call BackupRegistrationState");
  const dirty = installSection.indexOf("StrCpy $RegistrationMayBeDirty 1");
  const firstShortcutMutation = installSection.indexOf("Call CreateIdentityShortcut");
  assert.ok(snapshot >= 0 && snapshot < dirty && dirty < firstShortcutMutation);
  assert.match(
    installSection,
    /restore_existing_registration:\s+StrCmp \$RegistrationMayBeDirty 1 0 install_failed\s+Call RestoreRegistrationState\s+StrCmp \$RegistrationRestoreSucceeded 1 registration_restored install_failed\s+registration_restored:\s+StrCpy \$RegistrationMayBeDirty 0/u,
  );
  assert.match(
    installSection,
    /rollback_confirmed:[\s\S]+StrCmp \$RegistrationMayBeDirty 1 rollback_registration_dirty\s+SetErrorLevel 21[\s\S]+rollback_registration_dirty:\s+SetErrorLevel 27/u,
    "only a verified registration restoration may return the updater-relaunchable rollback code",
  );
  assert.doesNotMatch(installerSource, /AA24A0E7-B4DA-4E0F-B4E2-668C88EB5B8A/iu);
});

test("preview installer verifies its marker and uninstaller before shell registration is dirty", () => {
  const installSection = installerSource.slice(
    installerSource.indexOf('Section "QA Hub Preview"'),
    installerSource.indexOf('Section "Uninstall"'),
  );
  const markerWrite = installSection.indexOf('FileOpen $0 "$INSTDIR\\.preview-instance-id" w');
  const markerReadback = installSection.indexOf(
    'FileOpen $0 "$INSTDIR\\.preview-instance-id" r',
    markerWrite,
  );
  const uninstallerWrite = installSection.indexOf(
    'WriteUninstaller "$INSTDIR\\Uninstall-Preview.exe"',
  );
  const registrationDirty = installSection.indexOf("StrCpy $RegistrationMayBeDirty 1");
  assert.ok(
    markerWrite >= 0 &&
      markerReadback > markerWrite &&
      uninstallerWrite > markerReadback &&
      registrationDirty > uninstallerWrite,
    "payload metadata must be verified before any shortcut or registry mutation",
  );
  assert.match(
    installSection,
    /ClearErrors\s+FileOpen \$0 "\$INSTDIR\\\.preview-instance-id" w\s+IfErrors registration_failed\s+ClearErrors\s+FileWrite \$0 "\$\{INSTANCE_ID\}"\s+IfErrors marker_write_failed\s+ClearErrors\s+FileClose \$0\s+IfErrors registration_failed/u,
  );
  assert.match(
    installSection,
    /ClearErrors\s+FileOpen \$0 "\$INSTDIR\\\.preview-instance-id" r\s+IfErrors registration_failed\s+FileRead \$0 \$ExistingIdentity\s+IfErrors marker_read_failed\s+ClearErrors\s+FileClose \$0\s+IfErrors registration_failed\s+StrCmp \$ExistingIdentity "\$\{INSTANCE_ID\}" marker_verified registration_failed/u,
  );
  assert.match(installSection, /marker_write_failed:\s+FileClose \$0\s+Goto registration_failed/u);
  assert.match(installSection, /marker_read_failed:\s+FileClose \$0\s+Goto registration_failed/u);
  assert.match(
    installSection,
    /marker_verified:\s+ClearErrors\s+WriteUninstaller "\$INSTDIR\\Uninstall-Preview\.exe"\s+IfErrors registration_failed\s+IfFileExists "\$INSTDIR\\Uninstall-Preview\.exe" \+2\s+Goto registration_failed/u,
  );
  assert.match(
    installSection,
    /FileOpen \$0 "\$INSTDIR\\Uninstall-Preview\.exe" r\s+IfErrors registration_failed\s+FileSeek \$0 0 END \$1\s+IfErrors uninstaller_read_failed\s+ClearErrors\s+FileClose \$0\s+IfErrors registration_failed\s+IntCmp \$1 \$\{MIN_UNINSTALLER_BYTES\} uninstaller_verified registration_failed uninstaller_verified/u,
  );
  assert.match(
    installSection,
    /uninstaller_read_failed:\s+FileClose \$0\s+Goto registration_failed\s+uninstaller_verified:[\s\S]+StrCpy \$RegistrationMayBeDirty 1/u,
  );
});

test("preview updater records every installer failure and relaunches only confirmed-safe 21 or 22", () => {
  assert.match(updaterSource, /!define FAIL_CLOSED_INSTALLER_FAILURES 0/u);
  assert.match(packageSource, /"\/DFAIL_CLOSED_INSTALLER_FAILURES=1"/u);
  assert.match(updaterSource, /StrCpy \$FailureRelaunchBlocked 0/u);

  const installerFailure = updaterSource.slice(
    updaterSource.indexOf("install_failed:"),
    updaterSource.indexOf("invalid_config:"),
  );
  assert.match(
    installerFailure,
    /StrCpy \$FailureCode "UPDATE_INSTALLER_FAILED_\$InstallerExitCode"/u,
  );
  assert.match(installerFailure, /StrCmp \$InstallerExitCode "21" update_failed/u);
  assert.match(installerFailure, /StrCmp \$InstallerExitCode "22" update_failed/u);
  assert.match(installerFailure, /StrCpy \$FailureRelaunchBlocked 1/u);
  assert.deepEqual(
    [...installerFailure.matchAll(/StrCmp \$InstallerExitCode "([0-9]+)" update_failed/gu)].map(
      (match) => match[1],
    ),
    ["21", "22"],
  );

  const failureResult = updaterSource.slice(
    updaterSource.indexOf("update_failed:"),
    updaterSource.indexOf("relaunch_previous_app:"),
  );
  assert.ok(
    failureResult.indexOf("Call WriteResult") <
      failureResult.indexOf("StrCmp $FailureRelaunchBlocked 1 updater_exit_failed"),
    "the updater must write the failed result before blocking relaunch",
  );
  assert.ok(
    failureResult.indexOf("StrCmp $FailureRelaunchBlocked 1 updater_exit_failed") <
      failureResult.indexOf('IfFileExists "$AppPath" relaunch_previous_app updater_exit_failed'),
    "an unsafe residual AppPath must never authorize relaunch",
  );
});

test("clean-source guard rejects dirty or moving HEAD before packaging", () => {
  const commit = "a".repeat(40);
  const execute = (_file, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${sourceRoot}\n`;
    if (args[0] === "rev-parse" && args[1] === "--verify") return `${commit}\n`;
    if (args[0] === "status") return "";
    throw new Error(`unexpected git arguments: ${args.join(" ")}`);
  };
  assert.equal(
    assertCleanPreviewPackageSource(sourceRoot, undefined, execute).sourceCommit,
    commit,
  );
  assert.throws(
    () =>
      assertCleanPreviewPackageSource(sourceRoot, undefined, (_file, args) =>
        args[0] === "status" ? " M apps/desktop/src/main.ts\n" : execute(_file, args),
      ),
    /PREVIEW_PACKAGE_SOURCE_DIRTY/u,
  );
  assert.throws(
    () => assertCleanPreviewPackageSource(sourceRoot, "b".repeat(40), execute),
    /PREVIEW_PACKAGE_SOURCE_CHANGED/u,
  );
});
