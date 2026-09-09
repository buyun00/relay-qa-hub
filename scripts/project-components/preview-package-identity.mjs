import { execFileSync as runFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const INSTANCE_PATTERN = /^qa-hub-preview-([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))$/u;
const LEGACY_INSTANCE_ID = "qa-hub-preview-7c86";

function fail(code) {
  throw new Error(code);
}

export function derivePreviewPackageIdentity(instanceId) {
  const match = INSTANCE_PATTERN.exec(instanceId);
  const suffix = match?.[1];
  if (!suffix || suffix.includes("--")) fail("PREVIEW_PACKAGE_INSTANCE_ID_INVALID");
  const legacy = instanceId === LEGACY_INSTANCE_ID;
  const executableBaseName = legacy ? "RelayQaHubPreview" : `RelayQaHubPreview-${suffix}`;
  return Object.freeze({
    instanceId,
    executableBaseName,
    installDirectoryName: executableBaseName,
    uninstallRegistryKey: executableBaseName,
    shortcutName: legacy ? "QA Hub Project Preview" : `QA Hub Project Preview - ${suffix}`,
    protocolScheme: legacy ? "qa-hub-preview" : instanceId,
    appUserModelId: legacy
      ? "com.relayqahub.desktop.preview"
      : `com.relayqahub.desktop.preview.${suffix.replaceAll("-", ".")}`,
    displayName: legacy ? "QA Hub Project Preview" : `QA Hub Project Preview (${suffix})`,
  });
}

function gitText(execute, sourceRoot, args) {
  return execute("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
}

export function assertCleanPreviewPackageSource(sourceRoot, expectedCommit, execute = runFileSync) {
  const canonicalSourceRoot = resolve(realpathSync.native(sourceRoot));
  const repositoryRoot = resolve(
    realpathSync.native(gitText(execute, canonicalSourceRoot, ["rev-parse", "--show-toplevel"])),
  );
  if (repositoryRoot.toLowerCase() !== canonicalSourceRoot.toLowerCase())
    fail("PREVIEW_PACKAGE_SOURCE_ROOT_MISMATCH");

  const sourceCommit = gitText(execute, canonicalSourceRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceCommit))
    fail("PREVIEW_PACKAGE_SOURCE_COMMIT_INVALID");
  const dirty = gitText(execute, canonicalSourceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (dirty) fail("PREVIEW_PACKAGE_SOURCE_DIRTY");
  if (expectedCommit !== undefined && sourceCommit !== expectedCommit)
    fail("PREVIEW_PACKAGE_SOURCE_CHANGED");
  return Object.freeze({ sourceRoot: canonicalSourceRoot, sourceCommit, sourceDirty: false });
}
