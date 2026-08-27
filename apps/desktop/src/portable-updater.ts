import { createHash, createPublicKey, verify } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const RELEASE_ID_PATTERN = /^\d{8}T\d{9}Z$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 350 * 1024 * 1024;

export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvfjO+0bc+qmlPygd1+lVUpq+bTGT5cq6f40h5ZtkG5s=
-----END PUBLIC KEY-----`;

export interface DesktopRelease {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly version: string;
}

interface UpdateArchive {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface SignedUpdateManifest extends DesktopRelease {
  readonly publishedAt: string;
  readonly archive: UpdateArchive;
  readonly signature: string;
}

export type DesktopUpdateState =
  | { readonly status: "disabled"; readonly message: string }
  | { readonly status: "idle"; readonly currentReleaseId: string; readonly version: string }
  | { readonly status: "checking"; readonly currentReleaseId: string; readonly version: string }
  | { readonly status: "up-to-date"; readonly currentReleaseId: string; readonly version: string }
  | {
      readonly status: "downloading";
      readonly releaseId: string;
      readonly version: string;
      readonly progressPercent: number;
    }
  | {
      readonly status: "ready";
      readonly releaseId: string;
      readonly version: string;
      readonly publishedAt: string;
    }
  | {
      readonly status: "installing";
      readonly releaseId: string;
      readonly version: string;
    }
  | { readonly status: "error"; readonly message: string };

interface PortableUpdaterOptions {
  readonly currentReleaseFile: string;
  readonly updatesDirectory: string;
  readonly installDirectory: string;
  readonly executableName: string;
  readonly manifestUrl: URL;
  readonly publicKeyPem?: string;
  readonly fetchImpl?: typeof fetch;
  readonly currentPid?: number;
  readonly onState?: (state: DesktopUpdateState) => void;
  readonly requestQuit: () => void;
}

interface UpdateInstallResult {
  readonly schemaVersion: 1;
  readonly status: "installed" | "failed";
  readonly releaseId: string;
  readonly version: string;
  readonly recordedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRelease(value: unknown): DesktopRelease | null {
  if (!isRecord(value)) return null;
  const releaseId = value["releaseId"];
  const version = value["version"];
  if (
    value["schemaVersion"] !== 1 ||
    typeof releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(releaseId) ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version)
  ) {
    return null;
  }
  return { schemaVersion: 1, releaseId, version };
}

function manifestPayload(manifest: Omit<SignedUpdateManifest, "signature">): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    releaseId: manifest.releaseId,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    archive: {
      url: manifest.archive.url,
      size: manifest.archive.size,
      sha256: manifest.archive.sha256,
    },
  });
}

export function parseAndVerifyUpdateManifest(
  value: unknown,
  publicKeyPem = UPDATE_PUBLIC_KEY_PEM,
): SignedUpdateManifest | null {
  if (!isRecord(value)) return null;
  const release = parseRelease(value);
  const publishedAt = value["publishedAt"];
  const archiveValue = value["archive"];
  const signature = value["signature"];
  if (
    release === null ||
    typeof publishedAt !== "string" ||
    !Number.isFinite(Date.parse(publishedAt)) ||
    !isRecord(archiveValue) ||
    typeof archiveValue["url"] !== "string" ||
    archiveValue["url"].length > 2_048 ||
    !Number.isSafeInteger(archiveValue["size"]) ||
    (archiveValue["size"] as number) <= 0 ||
    (archiveValue["size"] as number) > MAX_ARCHIVE_BYTES ||
    typeof archiveValue["sha256"] !== "string" ||
    !SHA256_PATTERN.test(archiveValue["sha256"]) ||
    typeof signature !== "string" ||
    signature.length > 256
  ) {
    return null;
  }
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature) return null;
  const manifest: SignedUpdateManifest = {
    ...release,
    publishedAt,
    archive: {
      url: archiveValue["url"],
      size: archiveValue["size"] as number,
      sha256: archiveValue["sha256"],
    },
    signature,
  };
  try {
    const payload = manifestPayload(manifest);
    return verify(null, Buffer.from(payload, "utf8"), createPublicKey(publicKeyPem), signatureBytes)
      ? manifest
      : null;
  } catch {
    return null;
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) throw new Error("UPDATE_MANIFEST_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      throw new Error("UPDATE_MANIFEST_TOO_LARGE");
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeError(cause: unknown): string {
  if (cause instanceof Error && /^[A-Z0-9_]{3,80}$/u.test(cause.message)) return cause.message;
  return cause instanceof Error ? cause.name : "UPDATE_FAILED";
}

function parseInstallResult(value: unknown): UpdateInstallResult | null {
  if (!isRecord(value)) return null;
  const status = value["status"];
  const releaseId = value["releaseId"];
  const version = value["version"];
  const recordedAt = value["recordedAt"];
  if (
    value["schemaVersion"] !== 1 ||
    (status !== "installed" && status !== "failed") ||
    typeof releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(releaseId) ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    typeof recordedAt !== "string" ||
    !Number.isFinite(Date.parse(recordedAt))
  ) {
    return null;
  }
  return { schemaVersion: 1, status, releaseId, version, recordedAt };
}

export class PortableUpdater {
  private stateValue: DesktopUpdateState = {
    status: "disabled",
    message: "UPDATE_NOT_INITIALIZED",
  };
  private currentRelease: DesktopRelease | null = null;
  private readyManifest: SignedUpdateManifest | null = null;
  private readyArchive: string | null = null;
  private operation: Promise<void> | null = null;

  constructor(private readonly options: PortableUpdaterOptions) {}

  get state(): DesktopUpdateState {
    return this.stateValue;
  }

  private emit(state: DesktopUpdateState): void {
    this.stateValue = state;
    this.options.onState?.(state);
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.options.currentReleaseFile, "utf8");
      const release = parseRelease(JSON.parse(raw) as unknown);
      if (release === null) throw new Error("CURRENT_RELEASE_INVALID");
      this.currentRelease = release;
      try {
        const resultRaw = await fs.readFile(
          path.join(this.options.updatesDirectory, "last-update-result.json"),
          "utf8",
        );
        const result = parseInstallResult(JSON.parse(resultRaw.replace(/^\uFEFF/u, "")) as unknown);
        if (result !== null && result.status === "failed" && result.releaseId > release.releaseId) {
          this.emit({ status: "error", message: "UPDATE_INSTALL_FAILED" });
          return;
        }
      } catch {
        // A missing or malformed local result does not disable signed update checks.
      }
      this.emit({
        status: "idle",
        currentReleaseId: release.releaseId,
        version: release.version,
      });
    } catch (cause) {
      this.emit({ status: "disabled", message: safeError(cause) });
    }
  }

  check(): Promise<void> {
    if (this.operation !== null) return this.operation;
    this.operation = this.performCheck().finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async performCheck(): Promise<void> {
    const current = this.currentRelease;
    if (current === null) {
      this.emit({ status: "disabled", message: "CURRENT_RELEASE_UNAVAILABLE" });
      return;
    }
    if (this.stateValue.status === "ready" || this.stateValue.status === "installing") return;
    this.emit({
      status: "checking",
      currentReleaseId: current.releaseId,
      version: current.version,
    });
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.manifestUrl, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`UPDATE_MANIFEST_HTTP_${response.status}`);
      const text = await readBoundedText(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("UPDATE_MANIFEST_JSON_INVALID");
      }
      const manifest = parseAndVerifyUpdateManifest(
        parsed,
        this.options.publicKeyPem ?? UPDATE_PUBLIC_KEY_PEM,
      );
      if (manifest === null) throw new Error("UPDATE_MANIFEST_SIGNATURE_INVALID");
      if (manifest.releaseId <= current.releaseId) {
        this.emit({
          status: "up-to-date",
          currentReleaseId: current.releaseId,
          version: current.version,
        });
        return;
      }
      const archiveUrl = new URL(manifest.archive.url, this.options.manifestUrl);
      if (archiveUrl.origin !== this.options.manifestUrl.origin) {
        throw new Error("UPDATE_ARCHIVE_ORIGIN_NOT_ALLOWED");
      }
      await this.download(manifest, archiveUrl);
    } catch (cause) {
      this.emit({ status: "error", message: safeError(cause) });
    }
  }

  private async download(manifest: SignedUpdateManifest, archiveUrl: URL): Promise<void> {
    await fs.mkdir(this.options.updatesDirectory, { recursive: true });
    const archiveFile = path.join(this.options.updatesDirectory, `${manifest.releaseId}.zip`);
    const temporaryFile = `${archiveFile}.partial`;
    await fs.rm(temporaryFile, { force: true });
    await fs.rm(archiveFile, { force: true });
    this.emit({
      status: "downloading",
      releaseId: manifest.releaseId,
      version: manifest.version,
      progressPercent: 0,
    });
    const response = await (this.options.fetchImpl ?? fetch)(archiveUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`UPDATE_ARCHIVE_HTTP_${response.status}`);
    }
    const advertisedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertisedLength) && advertisedLength !== manifest.archive.size) {
      throw new Error("UPDATE_ARCHIVE_SIZE_MISMATCH");
    }
    const hash = createHash("sha256");
    let received = 0;
    let lastPercent = -1;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > manifest.archive.size || received > MAX_ARCHIVE_BYTES) {
          callback(new Error("UPDATE_ARCHIVE_TOO_LARGE"));
          return;
        }
        hash.update(chunk);
        const progressPercent = Math.min(100, Math.floor((received / manifest.archive.size) * 100));
        if (progressPercent !== lastPercent) {
          lastPercent = progressPercent;
          this.emit({
            status: "downloading",
            releaseId: manifest.releaseId,
            version: manifest.version,
            progressPercent,
          });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        meter,
        createWriteStream(temporaryFile, { flags: "wx", mode: 0o600 }),
      );
      if (received !== manifest.archive.size) throw new Error("UPDATE_ARCHIVE_SIZE_MISMATCH");
      if (hash.digest("hex") !== manifest.archive.sha256) {
        throw new Error("UPDATE_ARCHIVE_HASH_MISMATCH");
      }
      await fs.rename(temporaryFile, archiveFile);
    } catch (cause) {
      await fs.rm(temporaryFile, { force: true }).catch(() => undefined);
      throw cause;
    }
    this.readyManifest = manifest;
    this.readyArchive = archiveFile;
    this.emit({
      status: "ready",
      releaseId: manifest.releaseId,
      version: manifest.version,
      publishedAt: manifest.publishedAt,
    });
  }

  async install(): Promise<boolean> {
    const manifest = this.readyManifest;
    const archiveFile = this.readyArchive;
    if (manifest === null || archiveFile === null || this.stateValue.status !== "ready") {
      return false;
    }
    const helperFile = path.join(this.options.updatesDirectory, "install-update.ps1");
    const readyFile = path.join(this.options.updatesDirectory, "install-update-ready.json");
    const logFile = path.join(this.options.updatesDirectory, "install-update.log");
    const resultFile = path.join(this.options.updatesDirectory, "last-update-result.json");
    await fs.rm(readyFile, { force: true });
    await fs.rm(resultFile, { force: true });
    await fs.writeFile(helperFile, INSTALL_HELPER, { encoding: "utf8", mode: 0o600 });
    this.emit({ status: "installing", releaseId: manifest.releaseId, version: manifest.version });
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperFile,
        "-CurrentPid",
        String(this.options.currentPid ?? process.pid),
        "-PackageDirectory",
        this.options.installDirectory,
        "-ArchivePath",
        archiveFile,
        "-ExecutableName",
        this.options.executableName,
        "-LogPath",
        logFile,
        "-ResultPath",
        resultFile,
        "-ReadyPath",
        readyFile,
        "-ReleaseId",
        manifest.releaseId,
        "-Version",
        manifest.version,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: this.options.updatesDirectory,
      },
    );
    let launchError: unknown = null;
    child.once("error", (cause) => {
      launchError = cause;
    });
    child.unref();
    try {
      const deadline = Date.now() + 10_000;
      let helperReady = false;
      while (Date.now() < deadline) {
        if (launchError !== null) throw launchError;
        try {
          const marker = JSON.parse(await fs.readFile(readyFile, "utf8")) as Record<
            string,
            unknown
          >;
          helperReady =
            marker["schemaVersion"] === 1 &&
            marker["status"] === "ready" &&
            marker["releaseId"] === manifest.releaseId;
          if (helperReady) break;
        } catch {
          // The helper writes the marker atomically after validating every install path.
        }
        if (child.exitCode !== null) throw new Error("UPDATE_HELPER_LAUNCH_FAILED");
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!helperReady) throw new Error("UPDATE_HELPER_READY_TIMEOUT");
    } catch (cause) {
      child.kill();
      this.emit({ status: "error", message: safeError(cause) });
      return false;
    }
    const quitTimer = setTimeout(() => this.options.requestQuit(), 100);
    quitTimer.unref();
    return true;
  }
}

export const INSTALL_HELPER = String.raw`param(
  [Parameter(Mandatory = $true)][int]$CurrentPid,
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$ExecutableName,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$ReleaseId,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"
$package = [IO.Path]::GetFullPath($PackageDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$archive = [IO.Path]::GetFullPath($ArchivePath)
$parent = [IO.Directory]::GetParent($package).FullName
$leaf = [IO.Path]::GetFileName($package)
$resultPathFull = [IO.Path]::GetFullPath($ResultPath)
$readyPathFull = [IO.Path]::GetFullPath($ReadyPath)
if ([string]::IsNullOrWhiteSpace($leaf) -or
    [IO.Path]::GetFileName($ExecutableName) -ne $ExecutableName -or
    $ReleaseId -notmatch '^\d{8}T\d{9}Z$' -or
    $Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$' -or
    -not (Test-Path -LiteralPath $package -PathType Container) -or
    -not (Test-Path -LiteralPath $archive -PathType Leaf) -or
    [IO.Path]::GetDirectoryName($readyPathFull) -ne [IO.Path]::GetDirectoryName($resultPathFull)) {
  throw "Unsafe update paths."
}
$suffix = [Guid]::NewGuid().ToString("N")
$extractRoot = Join-Path $parent ($leaf + ".extract-" + $suffix)
$backup = Join-Path $parent ($leaf + ".backup-" + (Get-Date -Format "yyyyMMddHHmmss") + "-" + $suffix)
foreach ($candidate in @($extractRoot, $backup)) {
  if ([IO.Directory]::GetParent([IO.Path]::GetFullPath($candidate)).FullName -ne $parent) {
    throw "Unsafe update target."
  }
}

function Write-UpdateResult([string]$Status, [string]$Message) {
  $resultDirectory = [IO.Path]::GetDirectoryName($resultPathFull)
  [IO.Directory]::CreateDirectory($resultDirectory) | Out-Null
  $safeMessage = ([string]$Message -replace '[\r\n]+', ' ').Trim()
  if ($safeMessage.Length -gt 500) { $safeMessage = $safeMessage.Substring(0, 500) }
  $result = [ordered]@{
    schemaVersion = 1
    status = $Status
    releaseId = $ReleaseId
    version = $Version
    recordedAt = [DateTime]::UtcNow.ToString("o")
    message = $safeMessage
  }
  $temporaryResult = $resultPathFull + "." + $suffix + ".tmp"
  $utf8 = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText(
    $temporaryResult,
    (($result | ConvertTo-Json -Depth 3) + [Environment]::NewLine),
    $utf8
  )
  Move-Item -LiteralPath $temporaryResult -Destination $resultPathFull -Force
}

function Get-PackageProcesses {
  $prefix = $package + [IO.Path]::DirectorySeparatorChar
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
        $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
      }
  )
}

function Move-PackageWithRetry([string]$Source, [string]$Destination) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $lastError = $null
  do {
    try {
      Move-Item -LiteralPath $Source -Destination $Destination
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 250
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $lastError
}

Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToString("o") + " update helper started")
$readyMarker = [ordered]@{
  schemaVersion = 1
  status = "ready"
  releaseId = $ReleaseId
  processId = $PID
  recordedAt = [DateTime]::UtcNow.ToString("o")
}
$readyTemporary = $readyPathFull + "." + $suffix + ".tmp"
$readyEncoding = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText(
  $readyTemporary,
  (($readyMarker | ConvertTo-Json -Depth 3) + [Environment]::NewLine),
  $readyEncoding
)
Move-Item -LiteralPath $readyTemporary -Destination $readyPathFull -Force

try {
  $exitDeadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $mainStillRunning = $null -ne (Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue)
    $packageProcesses = @(Get-PackageProcesses)
    if (-not $mainStillRunning -and $packageProcesses.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $exitDeadline)
  if ($null -ne (Get-Process -Id $CurrentPid -ErrorAction SilentlyContinue) -or
      @(Get-PackageProcesses).Count -gt 0) {
    throw "QA Hub processes did not exit before the update timeout."
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
  $incomingCandidates = @()
  if (Test-Path -LiteralPath (Join-Path $extractRoot $ExecutableName) -PathType Leaf) {
    $incomingCandidates += $extractRoot
  }
  $incomingCandidates += @(
    Get-ChildItem -LiteralPath $extractRoot -Directory -Force |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName $ExecutableName) -PathType Leaf } |
      ForEach-Object { $_.FullName }
  )
  if ($incomingCandidates.Count -ne 1) {
    throw "The downloaded package layout is invalid."
  }
  $incoming = [IO.Path]::GetFullPath([string]$incomingCandidates[0])
  $incomingExe = Join-Path $incoming $ExecutableName
  $runtime = Join-Path $package "desktop-runtime.json"
  if (Test-Path -LiteralPath $runtime -PathType Leaf) {
    Copy-Item -LiteralPath $runtime -Destination (Join-Path $incoming "desktop-runtime.json") -Force
  }
  $uninstaller = Join-Path $package "Uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Copy-Item -LiteralPath $uninstaller -Destination (Join-Path $incoming "Uninstall.exe") -Force
  }
  Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToString("o") + " update payload extracted")
  Move-PackageWithRetry -Source $package -Destination $backup
  try {
    Move-PackageWithRetry -Source $incoming -Destination $package
    Start-Process -FilePath (Join-Path $package $ExecutableName) -ArgumentList "--updated"
  } catch {
    if (Test-Path -LiteralPath $package) {
      Move-Item -LiteralPath $package -Destination ($package + ".failed-" + $suffix)
    }
    Move-PackageWithRetry -Source $backup -Destination $package
    throw
  }
  Write-UpdateResult -Status "installed" -Message "Update installed."
  Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToString("o") + " update installed")
} catch {
  $failureMessage = $_.Exception.Message
  Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToString("o") + " " + $failureMessage)
  try { Write-UpdateResult -Status "failed" -Message $failureMessage } catch {}
  $restoredExe = Join-Path $package $ExecutableName
  if (Test-Path -LiteralPath $restoredExe -PathType Leaf) {
    try { Start-Process -FilePath $restoredExe -ArgumentList "--update-failed" } catch {}
  }
  exit 1
} finally {
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
}
exit 0
`;
