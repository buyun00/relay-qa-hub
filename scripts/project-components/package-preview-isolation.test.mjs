import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCleanPreviewPackageSource,
  derivePreviewPackageIdentity,
} from "./preview-package-identity.mjs";
import {
  assertSandboxPreloadBinding,
  inspectSandboxPreload,
} from "./sandbox-preload-require-gate.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "../..");
const packageSource = readFileSync(resolve(scriptRoot, "package-preview.mjs"), "utf8");
const installerSource = readFileSync(resolve(scriptRoot, "preview-installer.nsi"), "utf8");
const updaterSource = readFileSync(resolve(sourceRoot, "apps/desktop/scripts/updater.nsi"), "utf8");

const expectGateCode = (source, code) =>
  assert.throws(
    () => inspectSandboxPreload(source, "fixture-preload.cjs"),
    (error) => error?.code === code,
  );

test("preview packaging has a clean-source gate and no shared Windows install identity", () => {
  assert.match(packageSource, /preview-package-identity\.mjs/u);
  assert.ok(
    packageSource.indexOf("assertCleanPreviewPackageSource(config.sourceRoot)") <
      packageSource.indexOf("mkdirSync(root"),
    "the clean-source gate must run before the release directory is created",
  );
  assert.match(
    packageSource,
    /const preloadPath = join\(config\.sourceRoot, "apps\/desktop\/dist\/preload\.cjs"\)/u,
  );
  const sandboxGateCall = "const sourcePreloadSnapshot = inspectSandboxPreload(";
  assert.ok(
    packageSource.indexOf(sandboxGateCall) < packageSource.indexOf("mkdirSync(root"),
    "the sandbox preload gate must run before the release directory is created",
  );
  assert.match(packageSource, /appScheme: packageIdentity\.protocolScheme/u);
  assert.match(packageSource, /appUserModelId: packageIdentity\.appUserModelId/u);
  assert.ok(
    packageSource.indexOf("assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit)") <
      packageSource.indexOf("writeFileSync(installer, archive"),
    "the source must still be clean at the same commit before the installer is published",
  );

  assert.doesNotMatch(installerSource, /InstallDir "\$LOCALAPPDATA\\Programs\\RelayQaHubPreview"/u);
  for (const definition of [
    "INSTANCE_ID",
    "INSTALL_DIRECTORY_NAME",
    "EXECUTABLE_BASENAME",
    "UNINSTALL_REGISTRY_KEY",
    "SHORTCUT_NAME",
    "PROTOCOL_SCHEME",
    "DISPLAY_NAME",
  ]) {
    assert.match(installerSource, new RegExp(`\\$\\{${definition}\\}`, "u"));
    assert.match(packageSource, new RegExp(`/D${definition}=`));
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

test("preview packaging binds source, staged and app.asar preload before publication", () => {
  const firstMkdir = packageSource.indexOf("mkdirSync(root");
  const sourceGate = packageSource.indexOf("const sourcePreloadSnapshot = inspectSandboxPreload(");
  const desktopCopy = packageSource.indexOf("cpSync(join(config.sourceRoot, source)");
  const stagedGate = packageSource.indexOf(
    "const stagedPreloadSnapshot = assertSandboxPreloadBinding(",
  );
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
  const finalCleanGate = packageSource.lastIndexOf(
    "assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit)",
  );
  const finalSourceGate = packageSource.indexOf(
    "const finalSourcePreloadSnapshot = assertSandboxPreloadBinding(",
  );
  const publication = packageSource.indexOf("writeFileSync(installer, archive");

  assert.ok(sourceGate >= 0 && sourceGate < firstMkdir);
  assert.ok(desktopCopy >= 0 && desktopCopy < stagedGate && stagedGate < packagerCall);
  assert.ok(packagerCall < packagedGate && packagedGate < installerBuild);
  assert.ok(archiveRead < finalPackagedGate && finalPackagedGate < signing);
  assert.ok(finalCleanGate < finalSourceGate && finalSourceGate < publication);
  assert.equal(
    packageSource.match(/asar\.extractFile\(packagedAsarPath, "dist\/preload\.cjs"\)/gu)?.length,
    2,
  );
  assert.equal(packageSource.match(/sourcePreloadBytes,\s+sourcePreloadSnapshot,/gu)?.length, 4);
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
    displayName: "QA Hub Project Preview",
  });

  const final = derivePreviewPackageIdentity("qa-hub-preview-final-sol-0909");
  assert.equal(final.executableBaseName, "RelayQaHubPreview-final-sol-0909");
  assert.equal(final.installDirectoryName, "RelayQaHubPreview-final-sol-0909");
  assert.equal(final.uninstallRegistryKey, "RelayQaHubPreview-final-sol-0909");
  assert.equal(final.shortcutName, "QA Hub Project Preview - final-sol-0909");
  assert.equal(final.protocolScheme, "qa-hub-preview-final-sol-0909");
  assert.equal(final.appUserModelId, "com.relayqahub.desktop.preview.final.sol.0909");
  assert.equal(final.displayName, "QA Hub Project Preview (final-sol-0909)");

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
    installerSource.indexOf('Section "QA Hub Preview"'),
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

  const payloadFailure = installerSource.slice(
    installerSource.indexOf("install_failed:"),
    installerSource.indexOf("rename_failed:"),
  );
  assert.match(payloadFailure, /StrCpy \$FailedDirectory "\$INSTDIR\.failed-\$\{RELEASE_ID\}"/u);
  assert.match(
    payloadFailure,
    /find_unique_failed_directory:\s+IfFileExists "\$FailedDirectory" next_failed_directory\s+IfFileExists "\$FailedDirectory\\\*\.\*" next_failed_directory failed_directory_ready/u,
  );
  assert.match(
    payloadFailure,
    /IfFileExists "\$INSTDIR\\\*\.\*" choose_failed_directory no_failed_payload_to_isolate/u,
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
    /rollback_confirmed:\s+;[^\r\n]*\r?\n\s*SetErrorLevel 21\s+Goto finished/u,
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
    /verify_fresh_failure:\s+IfFileExists "\$INSTDIR" quarantine_failed\s+IfFileExists "\$INSTDIR\\\*\.\*" quarantine_failed fresh_failure_confirmed\s+fresh_failure_confirmed:\s+;[^\r\n]*\r?\n\s*SetErrorLevel 25\s+Goto finished/u,
  );
  assert.equal(installerSource.match(/SetErrorLevel 21/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 22/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 23/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 24/gu)?.length, 1);
  assert.equal(installerSource.match(/SetErrorLevel 25/gu)?.length, 1);

  const initialRenameFailure = installerSource.slice(installerSource.indexOf("rename_failed:"));
  assert.match(
    initialRenameFailure,
    /^rename_failed:\s+StrCpy \$VerificationDirectory "\$INSTDIR"\s+Call VerifyPreviewInstallDirectory\s+StrCmp \$VerificationSucceeded 1 rename_failed_safe rollback_restore_failed/mu,
  );
  assert.match(initialRenameFailure, /rename_failed_safe:\s+SetErrorLevel 22\s+Goto finished/u);
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
