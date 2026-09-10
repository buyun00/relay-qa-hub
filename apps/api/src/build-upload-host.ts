import { promises as fs } from "node:fs";
import path from "node:path";
import { quickBuildPreset, quickUploadInput } from "@relay-qa-hub/upload-contract";
import { pinBuildSource, type BuildResult } from "./build-artifacts.js";
import {
  parseNewUploadInput,
  readJson,
  record,
  UPLOAD_SOURCE,
  writeJson,
} from "./uploader-host.js";
import type { BuildUploadChain, UploadInput, UploadSourceIdentity } from "./uploader-types.js";
interface QaHubJsonRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = (c: BuildUploadChain) =>
  ["upload_started", "failed", "cancelled"].includes(c.status);
interface Options {
  root: string;
  api: { json: (url: string, request?: QaHubJsonRequest) => Promise<unknown> };
  uploader: {
    checkAuth: () => Promise<boolean>;
    accountIdentity: () => Promise<string>;
    hasBuildJob: (id: string) => Promise<boolean>;
    startForBuild: (
      input: UploadInput,
      id: string,
      source: UploadSourceIdentity,
      accountIdentity: string,
    ) => Promise<string>;
  };
  fetch?: typeof fetch;
}
function sourceFromHeaders(headers: Headers): UploadSourceIdentity {
  const size = Number(headers.get("content-length"));
  const modified = Date.parse(headers.get("last-modified") ?? "");
  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isFinite(modified))
    throw new Error("BUILD_ZIP_UNVERIFIABLE");
  return { size, lastModified: new Date(modified).toUTCString() };
}
const sameSource = (a: UploadSourceIdentity | null, b: UploadSourceIdentity) =>
  a?.size === b.size && a.lastModified === b.lastModified;
function code(error: unknown): string {
  const value = record(error)["code"] ?? (error instanceof Error ? error.message : "");
  return typeof value === "string" && /^[A-Z_]{3,80}$/.test(value)
    ? value
    : "BUILD_SERVICE_UNAVAILABLE";
}

// Runs on the API server with an immutable owner, independently of browser sessions.
export class BuildUploadHost {
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  constructor(private readonly options: Options) {}
  private file(id: unknown): string {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("INVALID_INPUT");
    return path.join(this.options.root, `${id}.json`);
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("BUILD_CHAIN_BUSY");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  private async owner(): Promise<string> {
    const id = record(await this.options.api.json("/api/v1/auth/me"))["userId"];
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("AUTH_REQUIRED");
    return id;
  }
  private async all(): Promise<BuildUploadChain[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const result: BuildUploadChain[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const id = name.slice(0, -5);
      const raw = await readJson(this.file(id));
      if (
        !raw ||
        raw["id"] !== id ||
        typeof raw["ownerId"] !== "string" ||
        !UUID.test(raw["ownerId"]) ||
        ![
          "submitting",
          "submission_unknown",
          "building",
          "waiting_zip",
          "starting_upload",
          "upload_started",
          "failed",
          "cancelled",
        ].includes(String(raw["status"]))
      )
        throw new Error("LOCAL_STATE_INVALID");
      const chain = raw as unknown as BuildUploadChain;
      if (chain.preset !== undefined && !quickBuildPreset(chain.preset))
        throw new Error("LOCAL_STATE_INVALID");
      chain.input = parseNewUploadInput(chain.input);
      if (
        !Number.isFinite(Date.parse(chain.createdAt)) ||
        (chain.queueId !== null && (!Number.isSafeInteger(chain.queueId) || chain.queueId <= 0)) ||
        (chain.buildNumber !== null &&
          (!Number.isSafeInteger(chain.buildNumber) || chain.buildNumber <= 0))
      )
        throw new Error("LOCAL_STATE_INVALID");
      result.push(chain);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async save(chain: BuildUploadChain): Promise<BuildUploadChain> {
    chain.updatedAt = new Date().toISOString();
    await writeJson(this.file(chain.id), chain);
    return chain;
  }
  async list(): Promise<BuildUploadChain[]> {
    const owner = await this.owner();
    return (await this.all()).filter((c) => c.ownerId === owner).slice(0, 20);
  }
  private async source(allowMissing = false): Promise<UploadSourceIdentity | null> {
    const response = await (this.options.fetch ?? fetch)(UPLOAD_SOURCE, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error("BUILD_ZIP_UNAVAILABLE");
    return sourceFromHeaders(response.headers);
  }
  async start(value: unknown): Promise<BuildUploadChain> {
    return this.exclusive(async () => {
      const raw = record(value),
        id = raw["requestId"];
      this.file(id);
      const selection = quickBuildPreset(raw["preset"] ?? "android-release-app");
      if (!selection) throw new Error("INVALID_INPUT");
      const input = parseNewUploadInput(
          quickUploadInput(parseNewUploadInput(raw["upload"]), selection.id),
        ),
        ownerId = await this.owner();
      const chains = await this.all(),
        prior = chains.find((c) => c.id === id);
      if (prior) {
        if (
          prior.ownerId !== ownerId ||
          prior.preset !== selection.id ||
          JSON.stringify({
            ...prior.input,
            version: "",
            summary: "自动版本号",
            description: "自动版本号",
          }) !== JSON.stringify(input)
        )
          throw new Error("BUILD_CHAIN_CONFLICT");
        return prior;
      }
      if (chains.some((c) => !terminal(c))) throw new Error("BUILD_CHAIN_ACTIVE");
      await this.options.uploader.checkAuth();
      const accountIdentity = await this.options.uploader.accountIdentity();
      const baseline = null;
      const now = new Date().toISOString();
      const chain: BuildUploadChain = {
        id: String(id),
        preset: selection.id,
        ownerId,
        accountIdentity,
        createdAt: now,
        updatedAt: now,
        input,
        baseline,
        source: null,
        queueId: null,
        buildNumber: null,
        status: "submitting",
        errorCode: "",
        uploadJobId: null,
      };
      await this.save(chain);
      try {
        const result = record(
          await this.options.api.json("/api/v1/packaging/builds", {
            method: "POST",
            headers: { "idempotency-key": chain.id },
            body: { preset: selection.id },
          }),
        );
        if (!Number.isSafeInteger(result["queueId"]) || Number(result["queueId"]) <= 0)
          throw new Error("JENKINS_SUBMISSION_UNKNOWN");
        chain.queueId = Number(result["queueId"]);
        chain.status = "building";
      } catch (error) {
        chain.errorCode = code(error);
        // A timeout/lost response may follow an accepted build. Do not replay POST on restart.
        chain.status = [
          "JENKINS_PARAMETERS_CHANGED",
          "JENKINS_JOB_DISABLED",
          "JENKINS_AUTH_FAILED",
          "FORBIDDEN",
          "AUTH_REQUIRED",
        ].includes(chain.errorCode)
          ? "failed"
          : "submission_unknown";
      }
      return this.save(chain);
    });
  }
  async cancel(id: unknown): Promise<boolean> {
    return this.exclusive(async () => {
      this.file(id);
      const owner = await this.owner(),
        chain = (await this.all()).find((c) => c.id === id && c.ownerId === owner);
      if (!chain) throw new Error("JOB_NOT_FOUND");
      if (
        chain.status === "upload_started" ||
        (chain.status === "starting_upload" && (await this.options.uploader.hasBuildJob(chain.id)))
      )
        throw new Error("BUILD_UPLOAD_ALREADY_STARTED");
      chain.status = "cancelled";
      chain.errorCode = "";
      await this.save(chain);
      return true;
    });
  }
  startPolling(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const poll = async () => {
      try {
        await this.tick();
      } catch {
        /* Read-only service failures retry; persisted chain remains. */
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => void poll(), 5000);
        this.timer.unref();
      }
    };
    void poll();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    return this.exclusive(async () => {
      const chains = (await this.all()).filter((c) => !terminal(c));
      if (!chains.length) return;
      const owner = await this.owner();
      for (const chain of chains) {
        if (chain.ownerId !== owner) continue;
        try {
          await this.advance(chain);
        } catch (error) {
          chain.errorCode = code(error);
          if (
            [
              "BUILD_ZIP_CHANGED",
              "BUILD_ZIP_UNVERIFIABLE",
              "BUILD_NO_ZIP",
              "BUILD_FAILED",
              "BUILD_IDENTITY_MISMATCH",
              "BUILD_TIMED_OUT",
              "BUILD_ARTIFACT_MISMATCH",
              "BUILD_PROJECT_PATH_INVALID",
            ].includes(chain.errorCode)
          )
            chain.status = "failed";
          await this.save(chain);
        }
      }
    });
  }
  private async advance(chain: BuildUploadChain): Promise<void> {
    if (chain.status === "submitting" || chain.status === "submission_unknown") {
      if (chain.status === "submitting") {
        chain.status = "submission_unknown";
        chain.errorCode = "JENKINS_SUBMISSION_UNKNOWN";
        await this.save(chain);
      }
      return;
    }
    // Handoff uses a stable job ID. A crash cannot create a second upload task.
    if (chain.status === "starting_upload") {
      if (!chain.source) throw new Error("LOCAL_STATE_INVALID");
      if ((await this.options.uploader.accountIdentity()) !== chain.accountIdentity)
        throw new Error("UPLOAD_ACCOUNT_CHANGED");
      chain.uploadJobId = await this.options.uploader.startForBuild(
        chain.input,
        chain.id,
        chain.source,
        chain.accountIdentity,
      );
      chain.status = "upload_started";
      chain.errorCode = "";
      await this.save(chain);
      return;
    }
    if (Date.now() - Date.parse(chain.createdAt) > 24 * 3600_000)
      throw new Error("BUILD_TIMED_OUT");
    const progress = record(
      await this.options.api.json(
        `/api/v1/packaging/progress?queues=${chain.queueId}${chain.buildNumber ? `&builds=${chain.buildNumber}` : ""}${chain.preset ? "" : "&legacy=1"}`,
      ),
    );
    const builds = Array.isArray(progress["builds"]) ? progress["builds"].map(record) : [];
    const queues = Array.isArray(progress["queues"]) ? progress["queues"].map(record) : [];
    const build = chain.buildNumber
      ? builds.find((b) => b["number"] === chain.buildNumber)
      : builds.find((b) => b["queueId"] === chain.queueId);
    if (!build) {
      if (queues.some((q) => q["id"] === chain.queueId && q["status"] === "CANCELLED")) {
        chain.status = "cancelled";
        chain.errorCode = "";
      } else
        chain.errorCode = queues.some((q) => q["id"] === chain.queueId && q["status"] === "UNKNOWN")
          ? "BUILD_QUEUE_UNKNOWN"
          : "";
      await this.save(chain);
      return;
    }
    if (
      build["queueId"] !== chain.queueId ||
      build["preset"] !== (chain.preset ?? "external") ||
      !Number.isSafeInteger(build["number"]) ||
      Number(build["number"]) <= 0
    )
      throw new Error("BUILD_IDENTITY_MISMATCH");
    chain.buildNumber = Number(build["number"]);
    chain.errorCode = "";
    if (build["status"] === "BUILDING") {
      await this.save(chain);
      return;
    }
    if (build["status"] !== "SUCCESS")
      throw new Error(
        build["errorCode"] === "BUILD_PROJECT_PATH_INVALID"
          ? "BUILD_PROJECT_PATH_INVALID"
          : "BUILD_FAILED",
      );
    if (chain.preset) {
      chain.status = "waiting_zip";
      await this.save(chain);
      const result = (await this.options.api.json(
        `/api/v1/packaging/build-result?build=${chain.buildNumber}&preset=${chain.preset}`,
      )) as BuildResult;
      const preset = quickBuildPreset(chain.preset)!;
      if (
        result.productId !== preset.productId ||
        result.channelId !== preset.channelId ||
        result.platform !== preset.platform ||
        result.configuration !== preset.configuration ||
        !/^\d+\.\d+\.\d+$/.test(result.version)
      )
        throw new Error("BUILD_ARTIFACT_MISMATCH");
      chain.source = await pinBuildSource(result, this.options.fetch);
      chain.buildVersion = result.version;
      chain.input = parseNewUploadInput({ ...chain.input, version: result.version });
      chain.status = "starting_upload";
      await this.save(chain);
      await this.advance(chain);
      return;
    }
    if (build["logError"] === true) throw new Error("BUILD_LOG_UNAVAILABLE");
    const stages = Array.isArray(build["stages"]) ? build["stages"].map(record) : [];
    if (
      build["includesZip"] !== true ||
      !stages.some((s) => s["id"] === "zip" && s["state"] === "complete")
    )
      throw new Error("BUILD_NO_ZIP");
    chain.status = "waiting_zip";
    await this.save(chain);
    const source = await this.source();
    if (!source) throw new Error("BUILD_ZIP_UNAVAILABLE");
    const started = Date.parse(String(build["startedAt"])),
      elapsed = Number(build["elapsedMs"]),
      modified = Date.parse(source.lastModified);
    if (!Number.isFinite(started) || !Number.isFinite(elapsed) || elapsed < 0)
      throw new Error("BUILD_ZIP_UNVERIFIABLE");
    // A shared latest ZIP is accepted only within this build's window, with no overlapping later writer.
    if (
      sameSource(chain.baseline, source) ||
      modified < started - 2000 ||
      modified > started + elapsed + 2000 ||
      builds.some(
        (b) =>
          b["number"] !== chain.buildNumber &&
          b["includesZip"] !== false &&
          (Date.parse(String(b["startedAt"])) >= started ||
            Date.parse(String(b["startedAt"])) + Number(b["elapsedMs"]) >= started),
      )
    )
      throw new Error("BUILD_ZIP_CHANGED");
    chain.source = source;
    chain.status = "starting_upload";
    await this.save(chain);
    await this.advance(chain);
  }
}
