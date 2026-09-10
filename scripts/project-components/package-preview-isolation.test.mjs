import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCleanPreviewPackageSource,
  derivePreviewPackageIdentity,
} from "./preview-package-identity.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptRoot, "../..");
const packageSource = readFileSync(resolve(scriptRoot, "package-preview.mjs"), "utf8");
const installerSource = readFileSync(resolve(scriptRoot, "preview-installer.nsi"), "utf8");

test("preview packaging has a clean-source gate and no shared Windows install identity", () => {
  assert.match(packageSource, /preview-package-identity\.mjs/u);
  assert.ok(
    packageSource.indexOf("assertCleanPreviewPackageSource(config.sourceRoot)") <
      packageSource.indexOf("mkdirSync(root"),
    "the clean-source gate must run before the release directory is created",
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

test("preview installer retries transient install-directory locks before returning 22", () => {
  assert.match(installerSource, /!define INSTALL_RENAME_MAX_ATTEMPTS 40/u);
  assert.match(installerSource, /!define INSTALL_RENAME_RETRY_DELAY_MS 250/u);

  const retryBlock = installerSource.slice(
    installerSource.indexOf("backup_ready:"),
    installerSource.indexOf("install_files:"),
  );
  assert.match(retryBlock, /SetOutPath "\$TEMP"/u);
  assert.match(retryBlock, /StrCpy \$RenameAttemptsRemaining \$\{INSTALL_RENAME_MAX_ATTEMPTS\}/u);
  assert.match(
    retryBlock,
    /rename_install_directory:\s+ClearErrors\s+Rename "\$INSTDIR" "\$BackupDirectory"\s+IfErrors rename_retry install_files/u,
  );
  assert.match(
    retryBlock,
    /rename_retry:\s+IntOp \$RenameAttemptsRemaining \$RenameAttemptsRemaining - 1\s+IntCmp \$RenameAttemptsRemaining 0 rename_failed rename_failed rename_retry_wait/u,
  );
  assert.match(
    retryBlock,
    /rename_retry_wait:\s+Sleep \$\{INSTALL_RENAME_RETRY_DELAY_MS\}\s+Goto rename_install_directory/u,
  );

  const exhaustedFailure = installerSource.slice(installerSource.indexOf("rename_failed:"));
  assert.match(exhaustedFailure, /^rename_failed:\s+SetErrorLevel 22\s+Goto finished/mu);
  assert.equal(installerSource.match(/SetErrorLevel 22/gu)?.length, 1);

  const payloadFailure = installerSource.slice(
    installerSource.indexOf("install_failed:"),
    installerSource.indexOf("rename_failed:"),
  );
  assert.match(
    payloadFailure,
    /SetOutPath "\$TEMP"\s+Rename "\$INSTDIR" "\$INSTDIR\.failed-\$\{RELEASE_ID\}"\s+Rename "\$BackupDirectory" "\$INSTDIR"\s+SetErrorLevel 21/u,
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
