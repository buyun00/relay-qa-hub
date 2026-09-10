import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_POWERSHELL_PIN_PATH =
  "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
export const MOVE_FILE_WRITE_THROUGH_HELPER_RELATIVE_PATH =
  "scripts/project-components/move-file-write-through.ps1";

const SHA256 = /^[0-9a-f]{64}$/u;

export const MOVE_FILE_WRITE_THROUGH_HELPER_PATH = fileURLToPath(
  new URL("./move-file-write-through.ps1", import.meta.url),
);

export function resolveWindowsPowerShellExecutable() {
  assert.equal(process.platform, "win32", "WINDOWS_WRITE_THROUGH_PLATFORM_REQUIRED");
  const executable = path.resolve(WINDOWS_POWERSHELL_PIN_PATH);
  const stat = lstatSync(executable);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "WINDOWS_POWERSHELL_EXECUTABLE_INVALID");
  const canonical = path.resolve(realpathSync.native(executable));
  assert.equal(
    canonical.toLowerCase(),
    executable.toLowerCase(),
    "WINDOWS_POWERSHELL_CANONICAL_PATH_MISMATCH",
  );
  return canonical;
}

function parseHelperResult(value) {
  const line = value.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function canonicalParent(file) {
  const parent = path.resolve(realpathSync.native(path.dirname(file)));
  const stat = statSync(parent, { bigint: true });
  assert.ok(stat.isDirectory(), "WINDOWS_WRITE_THROUGH_PARENT_INVALID");
  return Object.freeze({ path: parent, dev: stat.dev });
}

export function moveFileWriteThrough(
  source,
  destination,
  {
    retryMilliseconds = 2000,
    expectedSourceSha256,
    powershellExecutable = resolveWindowsPowerShellExecutable(),
    helperPath = MOVE_FILE_WRITE_THROUGH_HELPER_PATH,
  } = {},
) {
  assert.ok(path.isAbsolute(source), "WINDOWS_WRITE_THROUGH_SOURCE_INVALID");
  assert.ok(path.isAbsolute(destination), "WINDOWS_WRITE_THROUGH_DESTINATION_INVALID");
  assert.notEqual(
    path.resolve(source).toLowerCase(),
    path.resolve(destination).toLowerCase(),
    "WINDOWS_WRITE_THROUGH_PATH_COLLISION",
  );
  const sourceParent = canonicalParent(source);
  const destinationParent = canonicalParent(destination);
  assert.deepEqual(
    sourceParent.dev,
    destinationParent.dev,
    "WINDOWS_WRITE_THROUGH_VOLUME_MISMATCH",
  );
  assert.ok(
    Number.isInteger(retryMilliseconds) && retryMilliseconds >= 0 && retryMilliseconds <= 5000,
    "WINDOWS_WRITE_THROUGH_RETRY_INVALID",
  );
  assert.match(
    expectedSourceSha256 ?? "",
    SHA256,
    "WINDOWS_WRITE_THROUGH_EXPECTED_SOURCE_SHA256_REQUIRED",
  );
  const sourceStat = lstatSync(source);
  assert.ok(
    sourceStat.isFile() && !sourceStat.isSymbolicLink(),
    "WINDOWS_WRITE_THROUGH_SOURCE_INVALID",
  );
  for (const [file, code] of [
    [powershellExecutable, "WINDOWS_POWERSHELL_EXECUTABLE_INVALID"],
    [helperPath, "WINDOWS_WRITE_THROUGH_HELPER_INVALID"],
  ]) {
    const stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), code);
  }
  const canonicalPowerShell = path.resolve(realpathSync.native(powershellExecutable));
  assert.equal(
    canonicalPowerShell.toLowerCase(),
    resolveWindowsPowerShellExecutable().toLowerCase(),
    "WINDOWS_POWERSHELL_CANONICAL_PATH_MISMATCH",
  );
  const canonicalHelper = path.resolve(realpathSync.native(helperPath));
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  const arguments_ = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    canonicalHelper,
    "-Mode",
    "CreateOnly",
    "-Source",
    resolvedSource,
    "-Destination",
    resolvedDestination,
    "-RetryMilliseconds",
    String(retryMilliseconds),
    "-ExpectedSourceSha256",
    expectedSourceSha256,
  ];
  const result = spawnSync(canonicalPowerShell, arguments_, {
    encoding: "utf8",
    windowsHide: true,
    timeout: retryMilliseconds + 10_000,
    maxBuffer: 64 * 1024,
  });
  const detail = parseHelperResult(result.status === 0 ? result.stdout : result.stderr);
  if (result.status !== 0 || result.signal !== null || result.error) {
    const error = new Error("WINDOWS_MOVE_FILE_WRITE_THROUGH_FAILED", {
      cause: result.error,
    });
    error.status = result.status;
    error.signal = result.signal;
    error.helperCode = detail?.code ?? null;
    error.nativeError = detail?.nativeError ?? null;
    error.detail = detail;
    throw error;
  }
  assert.equal(detail?.succeeded, true, "WINDOWS_WRITE_THROUGH_RESULT_INVALID");
  assert.equal(detail?.mode, "CreateOnly", "WINDOWS_WRITE_THROUGH_MODE_INVALID");
  assert.equal(detail?.flags, 8, "WINDOWS_WRITE_THROUGH_FLAGS_INVALID");
  assert.equal(
    detail?.expectedSourceSha256,
    expectedSourceSha256,
    "WINDOWS_WRITE_THROUGH_EXPECTED_SOURCE_RESULT_INVALID",
  );
  assert.equal(
    detail?.source?.toLowerCase(),
    resolvedSource.toLowerCase(),
    "WINDOWS_WRITE_THROUGH_SOURCE_RESULT_INVALID",
  );
  assert.equal(
    detail?.destination?.toLowerCase(),
    resolvedDestination.toLowerCase(),
    "WINDOWS_WRITE_THROUGH_DESTINATION_RESULT_INVALID",
  );
  assert.ok(
    Number.isInteger(detail?.attempts) && detail.attempts >= 1,
    "WINDOWS_WRITE_THROUGH_ATTEMPTS_INVALID",
  );
  assert.equal(detail?.sourceExistsAfter, false, "WINDOWS_WRITE_THROUGH_SOURCE_REMAINED");
  assert.equal(detail?.destinationExistsAfter, true, "WINDOWS_WRITE_THROUGH_DESTINATION_MISSING");
  assert.equal(existsSync(source), false, "WINDOWS_WRITE_THROUGH_SOURCE_REMAINED");
  assert.equal(existsSync(destination), true, "WINDOWS_WRITE_THROUGH_DESTINATION_MISSING");
  return Object.freeze(detail);
}
