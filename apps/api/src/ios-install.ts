import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  quickBuildPreset,
  iosInstallFinished,
  type IosInstallJob,
  type IosInstallRequest,
  type IosInstallSelection,
  type IosInstallArtifact,
  type IosInstallSnapshot,
} from "@relay-qa-hub/upload-contract";
import { PackagingError } from "./jenkins-builds.js";
import { readArtifactJson, validateBuildResult } from "./build-artifacts.js";
import { writeCompatibilityState } from "./build-compatibility-store.js";
import type { IosInstallBackend } from "./jenkins-ios-install.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const errorCode = (e: unknown) =>
  e instanceof PackagingError ? e.code : "IOS_INSTALL_JOB_UNAVAILABLE";
type StoredJob = { request: IosInstallRequest; job: IosInstallJob };

export function parseIosSelection(input: unknown): IosInstallSelection {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new PackagingError("INVALID_REQUEST", 400);
  const b = input as IosInstallSelection;
  if (
    Object.keys(input).some(
      (k) => !["configuration", "version", "buildNumber", "filename", "deviceId"].includes(k),
    ) ||
    !["Debug", "Release"].includes(b.configuration) ||
    typeof b.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(b.version) ||
    b.version.length > 80 ||
    !Number.isSafeInteger(b.buildNumber) ||
    b.buildNumber < 1 ||
    typeof b.filename !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,230}\.ipa$/.test(b.filename) ||
    typeof b.deviceId !== "string" ||
    !uuid.test(b.deviceId)
  )
    throw new PackagingError("INVALID_REQUEST", 400);
  return {
    configuration: b.configuration,
    version: b.version,
    buildNumber: b.buildNumber,
    filename: b.filename,
    deviceId: b.deviceId,
  };
}

export async function resolveInstallArtifact(
  selection: IosInstallSelection,
  fetcher: typeof fetch = fetch,
): Promise<IosInstallArtifact> {
  const directory = `http://10.100.5.129:8000/ozdqp/iOS/${selection.configuration}/${selection.version}/${selection.buildNumber}/`;
  try {
    const preset = quickBuildPreset(
      selection.configuration === "Debug" ? "ios-debug-app" : "ios-release-app",
    );
    if (!preset) throw new Error("Invalid preset");
    const result = validateBuildResult(
      await readArtifactJson(directory + "build-info.json", fetcher),
      preset,
    );
    const artifact = result.packages.find((p) => p.name === selection.filename && p.kind === "ipa");
    if (result.directory !== directory || !artifact) throw new Error("IPA mismatch");
    return { url: artifact.url, sha256: artifact.sha256, size: artifact.size };
  } catch {
    throw new PackagingError("IOS_IPA_CHANGED", 409);
  }
}

export class IosInstallService {
  private records = new Map<string, StoredJob>();
  private ready: Promise<void>;
  private gate: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(
    private readonly backend: IosInstallBackend,
    private readonly root?: string,
    private readonly resolveArtifact = resolveInstallArtifact,
  ) {
    this.ready = this.restore();
    void this.ready.then(
      () => this.schedule(),
      () => undefined,
    );
  }
  private async restore() {
    if (!this.root) return;
    try {
      const records = JSON.parse(
        await fs.readFile(path.join(this.root, "jobs.json"), "utf8"),
      ) as StoredJob[];
      if (!Array.isArray(records)) throw new Error("Invalid state");
      for (const record of records) {
        if (
          !record ||
          !uuid.test(record.request?.id) ||
          record.job?.id !== record.request.id ||
          !["devices", "install"].includes(record.request.action) ||
          !Number.isFinite(Date.parse(record.job.createdAt))
        )
          throw new Error("Invalid job");
        if (record.request.action === "install") parseIosSelection(record.request.selection);
        if (record.job.state === "submitting") {
          record.job.state = "submission_unknown";
          record.job.errorCode = "JENKINS_SUBMISSION_UNKNOWN";
        }
        this.records.set(record.job.id, record);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new PackagingError("IOS_INSTALL_STATE_UNAVAILABLE");
    }
  }
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.gate.then(async () => {
      await this.ready;
      return work();
    });
    this.gate = result.catch(() => undefined);
    return result;
  }
  private async persist() {
    if (!this.root) return;
    await fs.mkdir(this.root, { recursive: true });
    await writeCompatibilityState(path.join(this.root, "jobs.json"), [...this.records.values()]);
  }
  private schedule() {
    if (
      this.closed ||
      this.timer ||
      ![...this.records.values()].some((r) => !iosInstallFinished(r.job.state))
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, 3000);
    this.timer.unref();
  }
  async start(id: string, action: "devices" | "install", input?: unknown): Promise<IosInstallJob> {
    if (!uuid.test(id)) throw new PackagingError("INVALID_REQUEST", 400);
    return this.locked(async () => {
      const selection = action === "install" ? parseIosSelection(input) : undefined;
      const existing = this.records.get(id);
      if (existing) {
        if (
          existing.request.action !== action ||
          JSON.stringify(existing.request.selection) !== JSON.stringify(selection)
        )
          throw new PackagingError("IOS_INSTALL_REQUEST_CONFLICT", 409);
        return clone(existing.job);
      }
      const active = [...this.records.values()].find(
        (r) =>
          !iosInstallFinished(r.job.state) &&
          r.request.action === action &&
          (action === "devices" || r.request.selection?.deviceId === selection?.deviceId),
      );
      if (active) {
        if (action === "devices") return clone(active.job);
        throw new PackagingError("IOS_INSTALL_BUSY", 409);
      }
      const artifact = selection ? await this.resolveArtifact(selection) : undefined;
      const request: IosInstallRequest = {
        id,
        action,
        ...(selection && artifact ? { selection, artifact } : {}),
      };
      const job: IosInstallJob = {
        id,
        action,
        createdAt: now(),
        updatedAt: now(),
        state: "submitting",
        queueId: null,
        buildNumber: null,
        errorCode: null,
        ...(selection ? { selection } : {}),
      };
      this.records.set(id, { request, job });
      await this.persist();
      try {
        job.queueId = await this.backend.submit(request);
        job.state = "queued";
      } catch (e) {
        job.errorCode = errorCode(e);
        job.state =
          job.errorCode === "JENKINS_SUBMISSION_UNKNOWN" ? "submission_unknown" : "failed";
      }
      job.updatedAt = now();
      await this.persist();
      this.schedule();
      return clone(job);
    });
  }
  async refresh() {
    return this.locked(async () => {
      for (const r of this.records.values()) {
        if (iosInstallFinished(r.job.state)) continue;
        try {
          Object.assign(r.job, await this.backend.poll(r.request, clone(r.job)), {
            updatedAt: now(),
          });
          if (
            r.job.state === "submission_unknown" &&
            Date.now() - Date.parse(r.job.createdAt) > 30 * 60_000
          ) {
            r.job.state = "unconfirmed";
            r.job.errorCode = "IOS_INSTALL_UNCONFIRMED";
          }
        } catch (e) {
          r.job.errorCode = errorCode(e);
          if (r.job.errorCode === "IOS_INSTALL_RESULT_MISMATCH") r.job.state = "unconfirmed";
        }
      }
      await this.persist();
    });
  }
  async snapshot(): Promise<IosInstallSnapshot> {
    await this.ready;
    const records = [...this.records.values()]
      .map((r) => r.job)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const report = records
      .filter((r) => r.report && (r.report.status === "complete" || r.report.devices.length > 0))
      .sort((a, b) =>
        (b.report?.checkedAt ?? "").localeCompare(a.report?.checkedAt ?? ""),
      )[0]?.report;
    return clone({
      devices: report?.devices ?? [],
      checkedAt: report?.checkedAt ?? null,
      scan: records.find((r) => r.action === "devices") ?? null,
      installs: records.filter((r) => r.action === "install").slice(0, 30),
    });
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.gate;
  }
}

export function registerIosInstallRoutes(
  app: FastifyInstance,
  service: IosInstallService | undefined,
  actor: (request: FastifyRequest) => string | null,
) {
  app.addHook("onClose", async () => {
    await service?.close();
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/v1/packaging/ios-installs",
    handler: async (request, reply) => {
      if (!actor(request)) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      if (!service) return reply.code(503).send({ code: "IOS_INSTALL_JOB_UNAVAILABLE" });
      try {
        if (request.method === "GET")
          return reply.header("cache-control", "no-store").send(await service.snapshot());
        const body = request.body as { action?: unknown; selection?: unknown } | null;
        const id = request.headers["idempotency-key"];
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((k) => !["action", "selection"].includes(k)) ||
          !["devices", "install"].includes(String(body.action)) ||
          typeof id !== "string" ||
          (body.action === "devices" && body.selection !== undefined)
        )
          throw new PackagingError("INVALID_REQUEST", 400);
        return reply
          .code(202)
          .header("cache-control", "no-store")
          .send(await service.start(id, body.action as "devices" | "install", body.selection));
      } catch (e) {
        return reply
          .code(e instanceof PackagingError ? e.status : 503)
          .send({ code: errorCode(e) });
      }
    },
  });
}
