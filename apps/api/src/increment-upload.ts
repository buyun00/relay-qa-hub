import { randomUUID } from "node:crypto";
import { mkdirSync, copyFileSync, existsSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { BuildUploadHost } from "./build-upload-host.js";
import { JenkinsBuildService } from "./jenkins-builds.js";
import {
  UploaderHost,
  parseNewUploadInput,
  readJson,
  record,
  UPLOADER_SHA256,
  type UploadProjectConfiguration,
} from "./uploader-host.js";
import type {
  BuildUploadChain,
  UploadInput,
  UploadJob,
  UploaderSnapshot,
  UploadSourceIdentity,
} from "./uploader-types.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("INVALID_INPUT");
  return value;
}
function errorCode(error: unknown): string {
  const code = record(error)["code"] ?? (error instanceof Error ? error.message : "");
  return typeof code === "string" && /^[A-Z_]{3,80}$/.test(code)
    ? code
    : "UPLOAD_SERVICE_UNAVAILABLE";
}
type WorkerHost = Pick<
  UploaderHost,
  | "snapshot"
  | "login"
  | "logout"
  | "checkAuth"
  | "accountIdentity"
  | "hasBuildJob"
  | "startWithId"
  | "startForBuild"
  | "resume"
  | "confirmPublish"
  | "folder"
>;
interface Options {
  root: string;
  executable?: string;
  jenkins: JenkinsBuildService;
  fetch?: typeof fetch;
  hostFactory?: (owner: string) => WorkerHost;
  project?: UploadProjectConfiguration;
  buildPreset?: string;
  canStart?: (kind: "upload" | "build") => Promise<boolean>;
  /** Explicit shared-machine lock root; never split one physical workspace lock by project. */
  sharedLockRoot?: string;
  authFileForOwner?: (owner: string) => string;
}
type Kind = "upload" | "build" | "resume" | "confirm";
interface Payload {
  input: UploadInput;
  accountIdentity: string;
  source?: UploadSourceIdentity;
  previousRunId?: string;
}
interface Command {
  id: string;
  owner: string;
  jobId: string;
  kind: Kind;
  payload: string;
  state: "queued" | "paused" | "dispatching" | "started" | "failed" | "cancelled";
  error: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  componentVersion: number;
}
const lane = (p: Payload) => `${p.input.productId}/${p.input.channelId}`;

/** One server owns scheduling. SQLite persists submission intents and the process lease;
 * detached server supervisors retain worker receipts across API restarts. */
export class IncrementUploadService {
  private readonly db: DatabaseSync;
  private readonly holder = randomUUID();
  private readonly hosts = new Map<string, WorkerHost>();
  private readonly chains = new Map<string, BuildUploadHost>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = true;
  private current: Promise<void> | undefined;
  private readonly executable: string;
  constructor(private readonly options: Options) {
    mkdirSync(options.root, { recursive: true });
    this.executable =
      options.executable ?? path.join(options.root, "bin", UPLOADER_SHA256, "ozdqp-uploader.exe");
    if (!options.executable && !options.hostFactory && !existsSync(this.executable)) {
      mkdirSync(path.dirname(this.executable), { recursive: true });
      const bundled = fileURLToPath(
        new URL("../../desktop/vendor/ozdqp-uploader/ozdqp-uploader.exe", import.meta.url),
      );
      if (existsSync(bundled)) copyFileSync(bundled, this.executable, fsConstants.COPYFILE_EXCL);
    }
    this.db = new DatabaseSync(path.join(options.root, "queue.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS upload_commands(id TEXT PRIMARY KEY, owner TEXT NOT NULL, jobId TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS upload_owner ON upload_commands(owner,jobId);
      CREATE TABLE IF NOT EXISTS upload_scheduler(id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS upload_audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, jobId TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);`);
    const columns = this.db.prepare("PRAGMA table_info(upload_commands)").all();
    if (!columns.some((column) => column["name"] === "projectId")) {
      this.db.exec(
        "ALTER TABLE upload_commands ADD COLUMN projectId TEXT NOT NULL DEFAULT ''; ALTER TABLE upload_commands ADD COLUMN componentVersion INTEGER NOT NULL DEFAULT 0;",
      );
      // Old unscoped queued work is retained for review, never replayed on import.
      this.db.exec(
        "UPDATE upload_commands SET state='paused', error='PROJECT_MIGRATION_REVIEW_REQUIRED' WHERE state IN ('queued','dispatching')",
      );
    }
    if (
      options.project &&
      this.db
        .prepare("SELECT 1 FROM upload_commands WHERE projectId <> '' AND projectId <> ? LIMIT 1")
        .get(options.project.projectId)
    )
      throw new Error("UPLOAD_PROJECT_ROOT_MISMATCH");
  }
  private leader(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT holder,pid FROM upload_scheduler WHERE id=1").get();
      if (previous && previous["holder"] !== this.holder) {
        let alive = true;
        try {
          process.kill(Number(previous["pid"]), 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (alive) throw new Error("UPLOAD_SERVER_STANDBY");
      }
      this.db
        .prepare("INSERT OR REPLACE INTO upload_scheduler VALUES(1,?,?)")
        .run(this.holder, process.pid);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.leader();
    if (this.busy) throw new Error("UPLOAD_QUEUE_BUSY");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  private rows(): Command[] {
    return this.db
      .prepare("SELECT * FROM upload_commands WHERE projectId = ? ORDER BY createdAt,rowid")
      .all(this.options.project?.projectId ?? "") as unknown as Command[];
  }
  private save(c: Command): void {
    c.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO upload_commands(id,owner,jobId,kind,payload,state,error,createdAt,updatedAt,projectId,componentVersion) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,error=excluded.error,updatedAt=excluded.updatedAt",
      )
      .run(
        c.id,
        c.owner,
        c.jobId,
        c.kind,
        c.payload,
        c.state,
        c.error,
        c.createdAt,
        c.updatedAt,
        c.projectId,
        c.componentVersion,
      );
  }
  private audit(actor: string, jobId: string, action: string): void {
    this.db
      .prepare("INSERT INTO upload_audit(actor,jobId,action,at) VALUES(?,?,?,?)")
      .run(actor, jobId, action, new Date().toISOString());
  }
  private host(owner: string): WorkerHost {
    uuid(owner);
    let host = this.hosts.get(owner);
    if (host) return host;
    const ownerRoot = path.join(this.options.root, "owners", owner);
    host =
      this.options.hostFactory?.(owner) ??
      new UploaderHost({
        root: path.join(ownerRoot, "jobs"),
        authFile: this.options.authFileForOwner?.(owner) ?? path.join(ownerRoot, "auth.json"),
        executable: this.executable,
        runner: fileURLToPath(new URL("./uploader-runner.js", import.meta.url)),
        nodeExecutable: process.execPath,
        environment: {
          OZDQP_AUTH_FILE:
            this.options.authFileForOwner?.(owner) ?? path.join(ownerRoot, "auth.json"),
          OZDQP_LOCK_ROOT:
            this.options.sharedLockRoot ?? path.join(this.options.root, "channel-locks"),
        },
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.project ? { project: this.options.project } : {}),
      });
    this.hosts.set(owner, host);
    return host;
  }
  private chain(owner: string): BuildUploadHost {
    let chain = this.chains.get(owner);
    if (chain) return chain;
    const host = this.host(owner);
    chain = new BuildUploadHost({
      root: path.join(this.options.root, "owners", owner, "build-chains"),
      ...(this.options.project
        ? {
            sourceUrl: this.options.project.sourceUrl,
            projectId: this.options.project.projectId,
            componentVersion: this.options.project.componentVersion,
            defaults: this.options.project.defaults,
          }
        : {}),
      ...(this.options.buildPreset ? { preset: this.options.buildPreset } : {}),
      api: {
        json: async (url, request) => {
          if (url === "/api/v1/auth/me") return { userId: owner };
          if (url === "/api/v1/packaging/builds" && request?.method === "POST")
            return this.options.jenkins.trigger(
              this.options.buildPreset ?? "",
              `${owner}:${request.headers?.["idempotency-key"]}`,
            );
          if (url.startsWith("/api/v1/packaging/progress?")) {
            const params = new URL(url, "http://localhost").searchParams;
            return this.options.jenkins.progress(
              [Number(params.get("queues"))],
              params.has("builds") ? [Number(params.get("builds"))] : [],
            );
          }
          throw new Error("INVALID_INPUT");
        },
      },
      uploader: {
        checkAuth: () => host.checkAuth(),
        accountIdentity: () => host.accountIdentity(),
        hasBuildJob: async (id) => this.rows().some((c) => c.jobId === id && c.kind === "upload"),
        startForBuild: async (input, id, source, accountIdentity) => {
          this.insert(owner, `auto-${id}`, id, "upload", { input, source, accountIdentity });
          return id;
        },
      },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    this.chains.set(owner, chain);
    return chain;
  }
  private insert(owner: string, id: string, jobId: string, kind: Kind, payload: Payload): Command {
    const prior = this.rows().find((c) => c.id === id);
    if (prior) {
      const old = JSON.parse(prior.payload) as Payload;
      if (
        prior.owner !== owner ||
        prior.jobId !== jobId ||
        prior.kind !== kind ||
        JSON.stringify(old.input) !== JSON.stringify(payload.input) ||
        JSON.stringify(old.source) !== JSON.stringify(payload.source)
      )
        throw new Error("UPLOAD_REQUEST_CONFLICT");
      return prior;
    }
    const now = new Date().toISOString();
    const command: Command = {
      id,
      owner,
      jobId,
      kind,
      payload: JSON.stringify(payload),
      state: "queued",
      error: "",
      createdAt: now,
      updatedAt: now,
      projectId: this.options.project?.projectId ?? "",
      componentVersion: this.options.project?.componentVersion ?? 0,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.save(command);
      this.audit(owner, jobId, `enqueue_${kind}`);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return command;
  }
  async enqueue(
    owner: string,
    id: unknown,
    value: unknown,
    kind: "upload" | "build" = "upload",
  ): Promise<string> {
    // Enqueue does not wait for Jenkins polling or a platform request. Only the
    // scheduler dispatches; the SQLite insertion itself is atomic and idempotent.
    this.leader();
    if (this.options.canStart && !(await this.options.canStart(kind)))
      throw new Error("COMPONENT_DISABLED");
    const key = uuid(id),
      input = parseNewUploadInput(value, this.options.project?.defaults),
      prior = this.rows().find((c) => c.id === key);
    if (kind === "build" && this.options.project?.sourceKind === "ios_directory")
      throw new Error("BUILD_PLATFORM_UNSUPPORTED");
    if (prior) {
      this.insert(owner, key, key, kind, { input, accountIdentity: "" });
      return key;
    }
    const host = this.host(owner),
      snapshot = await host.snapshot();
    if (!snapshot.configured) throw new Error("AUTH_REQUIRED");
    if (!snapshot.available) throw new Error("UPLOADER_MISSING");
    if (snapshot.unreadableJobs) throw new Error("LOCAL_STATE_INVALID");
    const accountIdentity = await host.accountIdentity();
    this.insert(owner, key, key, kind, { input, accountIdentity });
    return key;
  }
  async account(
    owner: string,
    action: "login" | "logout" | "check-auth",
    value: unknown,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const host = this.host(owner),
        snapshot = await host.snapshot();
      const pendingBuild = (await this.chain(owner).list()).some(
        (c) => !["failed", "cancelled", "upload_started"].includes(c.status),
      );
      const reserved =
        pendingBuild ||
        snapshot.jobs.some((j) => j.status !== "succeeded") ||
        this.rows().some(
          (c) =>
            c.owner === owner &&
            !["failed", "cancelled"].includes(c.state) &&
            (c.state !== "started" ||
              (c.kind !== "build" &&
                snapshot.jobs.find((j) => j.id === c.jobId)?.status !== "succeeded")),
        );
      if (
        reserved &&
        (action === "logout" ||
          (action === "login" &&
            (record(value)["account"] !== snapshot.account ||
              record(value)["kind"] !== snapshot.kind)))
      )
        throw new Error("UPLOAD_ACCOUNT_IN_USE");
      const result =
        action === "login"
          ? await host.login(value)
          : action === "logout"
            ? await host.logout()
            : await host.checkAuth();
      this.audit(owner, "", action);
      return result;
    });
  }
  private async ownedJob(owner: string, id: unknown): Promise<UploadJob> {
    const key = uuid(id);
    if (!this.rows().some((c) => c.owner === owner && c.jobId === key && c.kind !== "build"))
      throw new Error("JOB_NOT_FOUND");
    const job = (await this.host(owner).snapshot()).jobs.find((j) => j.id === key);
    if (!job) throw new Error("JOB_NOT_FOUND");
    return job;
  }
  async continue(
    owner: string,
    id: unknown,
    key: unknown,
    kind: "resume" | "confirm",
    value: unknown,
  ): Promise<string> {
    if (this.options.canStart && !(await this.options.canStart("upload")))
      throw new Error("COMPONENT_DISABLED");
    return this.exclusive(async () => {
      const jobId = uuid(id),
        requestId = uuid(key),
        prior = this.rows().find((c) => c.id === requestId);
      if (prior) {
        if (
          prior.owner !== owner ||
          prior.jobId !== jobId ||
          (prior.kind !== kind && !(kind === "resume" && prior.kind === "upload"))
        )
          throw new Error("UPLOAD_REQUEST_CONFLICT");
        return jobId;
      }
      let job: UploadJob;
      try {
        job = await this.ownedJob(owner, jobId);
      } catch (e) {
        const original = this.rows().find(
          (c) => c.owner === owner && c.jobId === jobId && c.kind === "upload",
        );
        if (
          kind !== "resume" ||
          !original ||
          original.state !== "failed" ||
          (await this.host(owner).hasBuildJob(jobId))
        )
          throw e;
        const retry = this.insert(
          owner,
          requestId,
          jobId,
          "upload",
          JSON.parse(original.payload) as Payload,
        );
        this.audit(owner, jobId, "retry_preflight");
        return retry.jobId;
      }
      if (job.active) throw new Error("UPLOADER_BUSY");
      if (job.status === "succeeded") throw new Error("JOB_COMPLETED");
      if (kind === "confirm" && job.status !== "awaiting_publish")
        throw new Error("PUBLISH_NOT_READY");
      if (kind === "resume" && job.status === "awaiting_publish")
        throw new Error("PUBLISH_NOT_READY");
      const input = job.input;
      if (
        record(value)["testerId"] !== undefined &&
        (record(value)["testerId"] !== input.testerId ||
          record(value)["testResultReference"] !== input.testResultReference)
      )
        throw new Error("TEST_RESULT_LOCKED");
      const pending = this.rows().find(
        (c) =>
          c.jobId === jobId && ["queued", "dispatching"].includes(c.state) && c.kind !== "build",
      );
      if (pending) return jobId;
      const original = this.rows().find((c) => c.jobId === jobId && c.kind === "upload");
      const identity = (JSON.parse(original!.payload) as Payload).accountIdentity;
      this.insert(owner, requestId, jobId, kind, { input, accountIdentity: identity });
      return jobId;
    });
  }
  async cancel(owner: string, id: unknown, build = false): Promise<boolean> {
    return this.exclusive(async () => {
      const jobId = uuid(id),
        commands = this.rows().filter(
          (c) =>
            c.jobId === jobId &&
            c.owner === owner &&
            (build ? c.kind === "build" : c.kind !== "build"),
        );
      const latest = commands.at(-1);
      if (!latest) throw new Error("JOB_NOT_FOUND");
      if (build && latest.state === "started") {
        await this.chain(owner).cancel(jobId);
      } else {
        if (latest.state !== "queued" && latest.state !== "paused" && latest.state !== "cancelled")
          throw new Error("UPLOAD_ALREADY_STARTED");
        latest.state = "cancelled";
        this.save(latest);
      }
      this.audit(owner, jobId, "cancel_queue");
      return true;
    });
  }
  private queuedJob(c: Command): UploadJob {
    const p = JSON.parse(c.payload) as Payload;
    return {
      id: c.jobId,
      projectId: c.projectId,
      componentVersion: c.componentVersion,
      createdAt: c.createdAt,
      input: p.input,
      active: false,
      stage: c.state === "paused" ? "PAUSED" : "QUEUED",
      status:
        c.state === "paused"
          ? "paused"
          : c.state === "cancelled"
            ? "cancelled"
            : c.state === "failed"
              ? "failed"
              : "queued",
      errorCode: c.error,
      version: p.input.version,
      versionId: 0,
      sha256: "",
      size: 0,
      done: [],
      testResultLocked: false,
      pendingAction: "",
      published: false,
      publishTime: "",
      remoteStatus: 0,
      events: [],
      recordedWorkflow: true,
    };
  }
  async snapshot(owner: string): Promise<UploaderSnapshot> {
    const snapshot = await this.host(owner).snapshot(),
      rows = this.rows(),
      uploads = rows.filter((c) => c.kind !== "build");
    const jobs = new Map<string, UploadJob>();
    let unreadableJobs = snapshot.unreadableJobs;
    for (const uploader of new Set(uploads.map((c) => c.owner))) {
      const current = uploader === owner ? snapshot : await this.host(uploader).snapshot();
      if (uploader !== owner) unreadableJobs += current.unreadableJobs;
      const ids = new Set(uploads.filter((c) => c.owner === uploader).map((c) => c.jobId));
      for (const job of current.jobs) {
        if (ids.has(job.id)) jobs.set(job.id, { ...job, canManage: uploader === owner });
      }
    }
    const latest = new Map(uploads.map((c) => [c.jobId, c]));
    for (const c of latest.values()) {
      if (!jobs.has(c.jobId))
        jobs.set(c.jobId, { ...this.queuedJob(c), canManage: c.owner === owner });
      const job = jobs.get(c.jobId)!;
      if (["queued", "dispatching"].includes(c.state)) {
        job.status = "queued";
        job.active = false;
        job.stage = "QUEUED";
        job.errorCode = c.error;
        job.queuePosition =
          rows
            .filter((r) => r.kind !== "build" && ["queued", "dispatching"].includes(r.state))
            .findIndex((r) => r.id === c.id) + 1;
      } else if (c.state === "paused" && !job.active) {
        job.status = "paused";
        job.stage = "PAUSED";
        job.errorCode = c.error;
      } else if (c.state === "failed" && !job.active) job.errorCode = c.error || job.errorCode;
    }
    return {
      ...snapshot,
      ...(this.options.project
        ? {
            projectId: this.options.project.projectId,
            componentVersion: this.options.project.componentVersion,
          }
        : {}),
      execution: "server",
      unreadableJobs,
      jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
  async buildChains(owner: string): Promise<BuildUploadChain[]> {
    const commands = this.rows().filter((c) => c.kind === "build");
    const chains = (
      await Promise.all(
        [...new Set(commands.map((c) => c.owner))].map((id) => this.chain(id).list()),
      )
    ).flat();
    for (const c of commands.filter((c) => !chains.some((b) => b.id === c.jobId))) {
      const p = JSON.parse(c.payload) as Payload;
      chains.push({
        id: c.jobId,
        projectId: c.projectId,
        componentVersion: c.componentVersion,
        ownerId: c.owner,
        accountIdentity: p.accountIdentity,
        input: p.input,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        queueId: null,
        buildNumber: null,
        status:
          c.state === "paused"
            ? "paused"
            : c.state === "cancelled"
              ? "cancelled"
              : c.state === "failed"
                ? "failed"
                : "queued",
        errorCode: c.error,
        uploadJobId: null,
        baseline: null,
        source: null,
      });
    }
    return chains
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((chain) => ({
        ...chain,
        canManage: chain.ownerId === owner,
        // Account binding stays in persisted execution records, not shared diagnostics.
        accountIdentity: "",
      }));
  }
  async logs(owner: string, id: unknown): Promise<unknown> {
    const job = (await this.snapshot(owner)).jobs.find((j) => j.id === uuid(id));
    if (!job) throw new Error("JOB_NOT_FOUND");
    return {
      execution: "server",
      job,
      audit: this.db
        .prepare("SELECT actor,jobId,action,at FROM upload_audit WHERE jobId=? ORDER BY id")
        .all(job.id),
    };
  }
  hasJob(id: string): boolean {
    return this.rows().some((row) => row.jobId === id);
  }
  async hasActiveResources(): Promise<boolean> {
    for (const owner of new Set(this.rows().map((row) => row.owner))) {
      const snapshot = await this.host(owner).snapshot();
      if (snapshot.unreadableJobs) return true;
      if (snapshot.jobs.some((job) => job.active)) return true;
      if (
        (await this.chain(owner).list()).some(
          (chain) => !["paused", "failed", "cancelled", "upload_started"].includes(chain.status),
        )
      )
        return true;
    }
    return false;
  }
  async pausePending(): Promise<void> {
    for (const command of this.rows().filter((row) => row.state === "queued")) {
      if (command.kind === "upload" && Boolean((JSON.parse(command.payload) as Payload).source))
        continue;
      if (
        this.options.canStart &&
        (await this.options.canStart(command.kind === "build" ? "build" : "upload"))
      )
        continue;
      command.state = "paused";
      command.error = "COMPONENT_DISABLED";
      this.save(command);
      this.audit(command.owner, command.jobId, "paused_component_disabled");
    }
  }
  async resumeQueued(owner: string, id: unknown): Promise<string> {
    return this.exclusive(async () => {
      const command = this.rows().find(
        (row) => row.jobId === uuid(id) && row.owner === owner && row.state === "paused",
      );
      if (!command) throw new Error("JOB_NOT_FOUND");
      if (
        this.options.canStart &&
        !(await this.options.canStart(command.kind === "build" ? "build" : "upload"))
      )
        throw new Error("COMPONENT_DISABLED");
      command.state = "queued";
      command.error = "";
      this.save(command);
      this.audit(owner, command.jobId, "resumed_explicitly");
      return command.jobId;
    });
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const poll = () => {
      this.current = this.tick()
        .catch(() => {})
        .finally(() => {
          this.current = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(poll, 2000);
            this.timer.unref();
          }
        });
    };
    poll();
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
    this.db.prepare("DELETE FROM upload_scheduler WHERE holder=?").run(this.holder);
    this.db.close();
  }
  async tick(allowLaunch = true): Promise<void> {
    if (this.busy) return;
    return this.exclusive(async () => {
      let rows = this.rows();
      const owners = [...new Set(rows.map((c) => c.owner))];
      const snapshots = new Map<string, UploaderSnapshot>();
      for (const owner of owners) {
        const s = await this.host(owner).snapshot();
        if (s.unreadableJobs) throw new Error("LOCAL_STATE_INVALID");
        snapshots.set(owner, s);
      }
      const active = [...snapshots.values()].some((s) => s.jobs.some((j) => j.active));
      // Poll submitted builds even while a different upload is running.
      for (const owner of owners) await this.chain(owner).tick();
      rows = this.rows();
      if (this.options.canStart) {
        for (const command of rows.filter((item) => item.state === "queued")) {
          // A registered build-upload chain owns its follow-on upload already;
          // disabling a component must allow that existing chain to finish.
          const continuation =
            command.kind === "upload" && Boolean((JSON.parse(command.payload) as Payload).source);
          if (
            !continuation &&
            !(await this.options.canStart(command.kind === "build" ? "build" : "upload"))
          ) {
            command.state = "paused";
            command.error = "COMPONENT_DISABLED";
            this.save(command);
            this.audit(command.owner, command.jobId, "paused_component_disabled");
          }
        }
      }
      for (const c of rows.filter((c) => c.state === "dispatching")) {
        if (c.kind === "build") {
          if ((await this.chain(c.owner).list()).some((b) => b.id === c.jobId)) {
            c.state = "started";
            this.save(c);
          }
        } else {
          const meta = await readJson(
            path.join(this.host(c.owner).folder(c.jobId), "desktop.json"),
          );
          if (meta && meta["runId"] !== (JSON.parse(c.payload) as Payload).previousRunId) {
            c.state = "started";
            this.save(c);
          }
        }
      }
      if (active) return;
      if (!allowLaunch) return;
      const held = new Set<string>();
      for (const c of rows.filter((c) => c.kind !== "build")) {
        const job = snapshots.get(c.owner)?.jobs.find((j) => j.id === c.jobId);
        if ((job && job.status !== "succeeded") || (!job && c.state === "started"))
          held.add(lane(JSON.parse(c.payload) as Payload));
      }
      // Capture a completed build's pinned ZIP before starting another build which
      // could overwrite the shared download URL.
      const pending = rows
        .filter((c) => ["queued", "dispatching"].includes(c.state))
        .sort(
          (a, b) =>
            Number(Boolean((JSON.parse(b.payload) as Payload).source)) -
            Number(Boolean((JSON.parse(a.payload) as Payload).source)),
        );
      for (const c of pending) {
        const p = JSON.parse(c.payload) as Payload,
          host = this.host(c.owner);
        if ((c.kind === "upload" || c.kind === "build") && held.has(lane(p))) {
          c.error = "UPLOAD_CHANNEL_HELD";
          this.save(c);
          continue;
        }
        if (c.kind === "build") {
          const chains = (await Promise.all(owners.map((o) => this.chain(o).list()))).flat();
          if (chains.some((b) => !["failed", "cancelled", "upload_started"].includes(b.status)))
            continue;
        }
        try {
          if ((await host.accountIdentity()) !== p.accountIdentity)
            throw new Error("UPLOAD_ACCOUNT_CHANGED");
          if (c.state === "queued") {
            if (c.kind !== "build")
              p.previousRunId = String(
                (await readJson(path.join(host.folder(c.jobId), "desktop.json")))?.["runId"] ?? "",
              );
            c.payload = JSON.stringify(p);
            c.state = "dispatching";
            c.error = "";
            this.save(c);
          }
          if (c.kind === "build")
            await this.chain(c.owner).start({ requestId: c.jobId, upload: p.input });
          else if (c.kind === "upload") {
            if (p.source) await host.startForBuild(p.input, c.jobId, p.source, p.accountIdentity);
            else await host.startWithId(p.input, c.jobId);
          } else if (c.kind === "resume")
            await host.resume({
              id: c.jobId,
              testerId: p.input.testerId,
              testResultReference: p.input.testResultReference,
            });
          else await host.confirmPublish(c.jobId);
          c.state = "started";
          c.error = "";
          this.save(c);
          this.audit(c.owner, c.jobId, `dispatch_${c.kind}`);
        } catch (e) {
          c.state = "failed";
          c.error = errorCode(e);
          this.save(c);
          this.audit(c.owner, c.jobId, `dispatch_failed_${c.error}`);
        }
        return; // At most one launch per scheduler turn, across all users and devices.
      }
    });
  }
}

export function registerIncrementUploadRoutes(
  app: FastifyInstance,
  service: IncrementUploadService | undefined,
  actor: (request: FastifyRequest) => string | null,
): void {
  const route = (
    method: "GET" | "POST",
    url: string,
    operation: (owner: string, request: FastifyRequest) => Promise<unknown>,
  ) =>
    app.route({
      method,
      url,
      bodyLimit: 32 * 1024,
      handler: async (request, reply) => {
        const owner = actor(request);
        if (!owner) return reply.code(401).send({ code: "UNAUTHENTICATED" });
        if (!service) return reply.code(503).send({ code: "UPLOAD_SERVICE_UNAVAILABLE" });
        try {
          return reply
            .header("cache-control", "no-store")
            .type("application/json")
            .send(JSON.stringify(await operation(owner, request)));
        } catch (e) {
          const code = errorCode(e);
          return reply
            .code(code === "JOB_NOT_FOUND" ? 404 : code === "INVALID_INPUT" ? 400 : 409)
            .send({ code });
        }
      },
    });
  const base = "/api/v1/increment-upload",
    key = (r: FastifyRequest) => r.headers["idempotency-key"],
    id = (r: FastifyRequest) => record(r.params)["id"];
  route("GET", base, (owner) => service!.snapshot(owner));
  route("POST", `${base}/jobs`, (owner, r) => service!.enqueue(owner, key(r), r.body));
  for (const action of ["login", "logout", "check-auth"] as const)
    route("POST", `${base}/${action}`, (owner, r) => service!.account(owner, action, r.body));
  route("POST", `${base}/jobs/:id/resume`, (owner, r) =>
    service!.continue(owner, id(r), key(r), "resume", r.body),
  );
  route("POST", `${base}/jobs/:id/confirm-publish`, (owner, r) =>
    service!.continue(owner, id(r), key(r), "confirm", r.body),
  );
  route("POST", `${base}/jobs/:id/cancel`, (owner, r) => service!.cancel(owner, id(r)));
  route("GET", `${base}/jobs/:id/logs`, (owner, r) => service!.logs(owner, id(r)));
  route("GET", `${base}/build-chains`, (owner) => service!.buildChains(owner));
  route("POST", `${base}/build-chains`, async (owner, r) => {
    const jobId = await service!.enqueue(owner, key(r), record(r.body)["upload"], "build");
    return (await service!.buildChains(owner)).find((c) => c.id === jobId);
  });
  route("POST", `${base}/build-chains/:id/cancel`, (owner, r) =>
    service!.cancel(owner, id(r), true),
  );
  if (service) {
    app.addHook("onReady", async () => {
      service.start();
    });
    app.addHook("onClose", async () => {
      await service.close();
    });
  }
}
