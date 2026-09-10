import { execFileSync as runFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const INSTANCE_PATTERN = /^qa-hub-preview-([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))$/u;
const LEGACY_INSTANCE_ID = "qa-hub-preview-7c86";
const DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const MAX_APP_USER_MODEL_ID_BYTES = 512;

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function fail(code) {
  throw new Error(code);
}

export function deriveToastActivatorClsid(appUserModelId) {
  if (
    typeof appUserModelId !== "string" ||
    !appUserModelId ||
    Buffer.byteLength(appUserModelId, "utf8") > MAX_APP_USER_MODEL_ID_BYTES ||
    containsControlCharacter(appUserModelId)
  ) {
    fail("PREVIEW_PACKAGE_APP_USER_MODEL_ID_INVALID");
  }
  const bytes = createHash("sha1")
    .update(DNS_NAMESPACE)
    .update(Buffer.from(`${appUserModelId}.toast-activator`, "utf8"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex").toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

export function derivePreviewPackageIdentity(instanceId) {
  const match = INSTANCE_PATTERN.exec(instanceId);
  const suffix = match?.[1];
  if (!suffix || suffix.includes("--")) fail("PREVIEW_PACKAGE_INSTANCE_ID_INVALID");
  const legacy = instanceId === LEGACY_INSTANCE_ID;
  const executableBaseName = legacy ? "RelayQaHubPreview" : `RelayQaHubPreview-${suffix}`;
  const appUserModelId = legacy
    ? "com.relayqahub.desktop.preview"
    : `com.relayqahub.desktop.preview.${suffix.replaceAll("-", ".")}`;
  return Object.freeze({
    instanceId,
    executableBaseName,
    installDirectoryName: executableBaseName,
    uninstallRegistryKey: executableBaseName,
    shortcutName: legacy ? "QA Hub Project Preview" : `QA Hub Project Preview - ${suffix}`,
    protocolScheme: legacy ? "qa-hub-preview" : instanceId,
    appUserModelId,
    toastActivatorClsid: deriveToastActivatorClsid(appUserModelId),
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
