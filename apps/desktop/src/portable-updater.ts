import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

import { normalizeUpdateReleaseId } from "./notification-activation.js";

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
  readonly userDataDirectory?: string;
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

function decodeResultFile(contents: Buffer): string {
  if (
    (contents.length >= 2 && contents[0] === 0xff && contents[1] === 0xfe) ||
    (contents.length >= 2 && contents[1] === 0)
  ) {
    const offset = contents[0] === 0xff && contents[1] === 0xfe ? 2 : 0;
    return contents.subarray(offset).toString("utf16le");
  }
  return contents.toString("utf8");
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
  private installOperation: Promise<boolean> | null = null;
  private activeInstallReleaseId: string | null = null;

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
        const resultBytes = await fs.readFile(
          path.join(this.options.updatesDirectory, "last-update-result.json"),
        );
        const resultRaw = decodeResultFile(resultBytes);
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
    if (this.installOperation !== null) return this.installOperation.then(() => undefined);
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
    if (this.stateValue.status === "installing") return;
    this.emit({
      status: "checking",
      currentReleaseId: current.releaseId,
      version: current.version,
    });
    try {
      // Re-read after downloading: the stable channel can advance while a full
      // installer is in flight. Bound retries if releases keep changing.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const manifest = await this.fetchLatestManifest();
        if (manifest.releaseId <= current.releaseId) {
          this.readyManifest = null;
          this.readyArchive = null;
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
        if (await this.hasVerifiedArchive(manifest)) {
          this.emit({
            status: "ready",
            releaseId: manifest.releaseId,
            version: manifest.version,
            publishedAt: manifest.publishedAt,
          });
          return;
        }
        await this.download(manifest, archiveUrl);
      }
      throw new Error("UPDATE_RELEASE_CHANGED_RETRY");
    } catch (cause) {
      this.emit({ status: "error", message: safeError(cause) });
    }
  }

  private async fetchLatestManifest(): Promise<SignedUpdateManifest> {
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
    return manifest;
  }

  private async hasVerifiedArchive(manifest: SignedUpdateManifest): Promise<boolean> {
    if (this.readyManifest?.signature !== manifest.signature || this.readyArchive === null) {
      return false;
    }
    try {
      if ((await fs.stat(this.readyArchive)).size !== manifest.archive.size) return false;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(this.readyArchive)) hash.update(chunk as Buffer);
      return hash.digest("hex") === manifest.archive.sha256;
    } catch {
      return false;
    }
  }

  private async download(manifest: SignedUpdateManifest, archiveUrl: URL): Promise<void> {
    await fs.mkdir(this.options.updatesDirectory, { recursive: true });
    const archiveExtension = archiveUrl.pathname.toLowerCase().endsWith(".exe") ? ".exe" : ".zip";
    const archiveFile = path.join(
      this.options.updatesDirectory,
      `${manifest.releaseId}${archiveExtension}`,
    );
    const temporaryFile = `${archiveFile}.${randomUUID()}.partial`;
    // Keep prior downloads and incomplete attempts available for recovery review.
    try {
      await fs.rename(archiveFile, `${archiveFile}.retained-${randomUUID()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
      await fs.rename(temporaryFile, `${temporaryFile}.failed`).catch(() => undefined);
      throw cause;
    }
    this.readyManifest = manifest;
    this.readyArchive = archiveFile;
  }

  install(): Promise<boolean> {
    return this.beginInstall(null);
  }

  installRelease(releaseId: string): Promise<boolean> {
    const normalized = normalizeUpdateReleaseId(releaseId);
    if (normalized === null) return Promise.resolve(false);
    return this.beginInstall(normalized);
  }

  private beginInstall(expectedReleaseId: string | null): Promise<boolean> {
    if (this.installOperation !== null) {
      return this.activeInstallReleaseId === expectedReleaseId
        ? this.installOperation
        : Promise.resolve(false);
    }
    if (this.stateValue.status === "installing") return Promise.resolve(false);
    this.activeInstallReleaseId = expectedReleaseId;
    this.installOperation = this.performInstall(expectedReleaseId).finally(() => {
      this.installOperation = null;
      this.activeInstallReleaseId = null;
    });
    return this.installOperation;
  }

  private async performInstall(expectedReleaseId: string | null): Promise<boolean> {
    // Serialize all entry points, then confirm the latest signed release at the
    // installation boundary instead of trusting an earlier ready notification.
    await this.operation;
    await this.performCheck();
    const manifest = this.readyManifest;
    const packageFile = this.readyArchive;
    if (manifest === null || packageFile === null || this.stateValue.status !== "ready") {
      return false;
    }
    if (expectedReleaseId !== null && manifest.releaseId !== expectedReleaseId) return false;
    if (path.extname(packageFile).toLowerCase() !== ".exe") {
      this.emit({ status: "error", message: "UPDATE_PACKAGE_UNSUPPORTED" });
      return false;
    }

    const updaterSource = path.join(this.options.installDirectory, "RelayQaHubUpdater.exe");
    try {
      await fs.access(updaterSource);
    } catch {
      this.emit({ status: "error", message: "UPDATE_UPDATER_MISSING" });
      return false;
    }

    const stagingDirectory = path.join(
      this.options.updatesDirectory,
      `updater-${manifest.releaseId}-${this.options.currentPid ?? process.pid}-${randomUUID()}`,
    );
    const updaterFile = path.join(stagingDirectory, "RelayQaHubUpdater.exe");
    const configFile = path.join(stagingDirectory, "update.ini");
    const readyFile = path.join(stagingDirectory, "ready.flag");
    const resultFile = path.join(this.options.updatesDirectory, "last-update-result.json");

    let updaterProcess: ReturnType<typeof spawn> | null = null;
    try {
      const configValues = {
        PackagePath: packageFile,
        AppPath: path.join(this.options.installDirectory, this.options.executableName),
        UserDataPath: this.options.userDataDirectory ?? "",
        ParentPid: String(this.options.currentPid ?? process.pid),
        ResultPath: resultFile,
        ReleaseId: manifest.releaseId,
        Version: manifest.version,
      };
      for (const value of Object.values(configValues)) {
        if (/[\r\n]/u.test(value)) throw new Error("UPDATE_CONFIG_INVALID");
      }
      const configText = [
        "[Update]",
        ...Object.entries(configValues).map(([key, value]) => `${key}=${value}`),
        "",
      ].join("\r\n");

      await fs.mkdir(stagingDirectory, { recursive: true });
      await fs.copyFile(updaterSource, updaterFile);
      await fs.writeFile(
        configFile,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(configText, "utf16le")]),
        { mode: 0o600 },
      );
      try {
        await fs.rename(
          resultFile,
          path.join(this.options.updatesDirectory, `retained-update-result-${randomUUID()}.json`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      this.emit({ status: "installing", releaseId: manifest.releaseId, version: manifest.version });
      const updater = spawn(updaterFile, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: stagingDirectory,
      });
      updaterProcess = updater;
      let launchError: unknown = null;
      updater.once("error", (cause) => {
        launchError = cause;
      });
      await new Promise<void>((resolve, reject) => {
        updater.once("spawn", resolve);
        updater.once("error", reject);
      });

      const deadline = Date.now() + 10_000;
      let updaterReady = false;
      while (Date.now() < deadline) {
        if (launchError !== null) throw launchError;
        try {
          updaterReady = (await fs.readFile(readyFile, "utf16le")).includes(manifest.releaseId);
          if (updaterReady) break;
        } catch {
          // The native updater writes this only after validating the handoff file.
        }
        if (updater.exitCode !== null) throw new Error("UPDATE_UPDATER_LAUNCH_FAILED");
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!updaterReady) throw new Error("UPDATE_UPDATER_READY_TIMEOUT");
      updater.unref();
    } catch (cause) {
      updaterProcess?.kill();
      this.emit({ status: "error", message: safeError(cause) });
      return false;
    }

    const quitTimer = setTimeout(() => this.options.requestQuit(), 100);
    quitTimer.unref();
    return true;
  }
}
