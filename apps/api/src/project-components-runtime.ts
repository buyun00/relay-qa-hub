import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ProjectComponentKey,
  ProjectComponentList,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";
import type { BrowserAuthPrincipal } from "./browser-auth.js";
import { ProjectManagementService } from "./project-management.js";
import {
  JenkinsBuildService,
  type JenkinsProjectConfiguration,
  type PackagingStatus,
} from "./jenkins-builds.js";
import { BuildCompatibilityService, type CompatibilityBatch } from "./build-compatibility.js";
import { IncrementUploadService } from "./increment-upload.js";
import { parseNewUploadInput, type UploadProjectConfiguration } from "./uploader-host.js";
import type { UploadInput, UploaderSnapshot, BuildUploadChain } from "./uploader-types.js";
import { ProductionTasks } from "./production-tasks.js";
import {
  createQingyuIntegration,
  type QingyuIntegration,
  type QingyuLinkPersistence,
} from "./qingyu-integration.js";
import { QingyuClient, type QingyuCredentials } from "./qingyu-client.js";
import type { MobileBugStore } from "./mobile-bugs.js";
import type { MobileRelayStore } from "./mobile-relay.js";
import type { MobileAttachmentStore } from "./mobile-attachments.js";
import type { MobileProjectDirectoryStore } from "./mobile-project-directory.js";
import {
  startMobileRelayOutboxPump,
  REAL_RELAY_HANDOFF_PATH,
  type MobileRelayOutboxPump,
} from "./mobile-relay-outbox.js";

type Json = Record<string, unknown>;
const COMPONENTS = [
  "build",
  "build_upload.single",
  "upload.incremental",
  "relay.production",
  "qingyu.sync",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", "组件配置不完整", 409);
  return value as Json;
};
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000)
    throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", `${label} 未配置`, 409);
  return value.trim();
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ComponentRuntimeError("INVALID_REQUEST", "项目或任务标识不正确", 400);
  return value.toLowerCase();
}
function url(value: unknown, label: string): string {
  const parsed = new URL(string(value, label));
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new ComponentRuntimeError(
      "COMPONENT_NOT_CONFIGURED",
      `${label} 必须是不含凭据的 HTTP 地址`,
      409,
    );
  return parsed.toString().replace(/\/$/u, "");
}
function origin(value: unknown, label: string): string {
  const parsed = new URL(url(value, label));
  if (parsed.pathname !== "/" || parsed.search)
    throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", `${label} 必须是服务根地址`, 409);
  return parsed.origin;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = () => new Date().toISOString();
export class ComponentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
interface VersionSnapshot {
  projectId: string;
  key: ProjectComponentKey;
  version: number;
  config: Json;
  credentialDigest: string;
  createdAt: string;
}
interface BuildTask {
  id: string;
  projectId: string;
  actorId: string;
  componentVersion: number;
  preset: string;
  requestKey: string;
  requestDigest: string;
  state:
    | "queued"
    | "paused"
    | "dispatching"
    | "running"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "cancelled";
  queueId: number | null;
  buildNumber: number | null;
  errorCode: string;
  resultJson: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectComponentsRuntimeOptions {
  readonly root: string;
  readonly credentialRoot: string;
  readonly instanceId: string;
  readonly management: ProjectManagementService;
  readonly worker: SqliteStorageWorker;
  readonly fetch?: typeof fetch;
  readonly uploaderExecutable?: string;
  readonly evidenceRoot?: string;
  readonly executionHeld?: () => boolean;
  readonly storesForProject?: (
    projectId: string,
    componentVersion: number,
    relayBinding?: {
      relayInstanceId: string;
      qaInstanceId: string;
      componentRoute: {
        componentVersion: number;
        snapshotDigest: string;
        externalProjectKey: string;
      };
    },
  ) => {
    bugs: MobileBugStore;
    relay: MobileRelayStore;
    attachments: MobileAttachmentStore;
    projects: MobileProjectDirectoryStore;
    qingyuLinks: QingyuLinkPersistence;
  };
}
/** Per-project services are reconstructed from immutable version snapshots. No
 * current browser context or production default is used by a background task. */
export class ProjectComponentsRuntime {
  private readonly db: DatabaseSync;
  private readonly builds = new Map<string, JenkinsBuildService>();
  private readonly compatibilities = new Map<string, BuildCompatibilityService>();
  private readonly uploaders = new Map<string, IncrementUploadService>();
  private readonly snapshots = new Map<string, VersionSnapshot>();
  private readonly productions = new Map<string, ProductionTasks>();
  private readonly relayPumps = new Map<string, MobileRelayOutboxPump>();
  private readonly qingyus = new Map<string, Promise<QingyuIntegration>>();
  private readonly removeListener: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | undefined;
  private stopped = true;
  private busy = false;
  constructor(readonly options: ProjectComponentsRuntimeOptions) {
    if (!isAbsolute(options.root) || !isAbsolute(options.credentialRoot))
      throw new Error("COMPONENT_RUNTIME_PATH_REQUIRED");
    mkdirSync(options.root, { recursive: true });
    mkdirSync(options.credentialRoot, { recursive: true });
    this.db = new DatabaseSync(this.path("runtime.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS build_tasks(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, actorId TEXT NOT NULL, componentVersion INTEGER NOT NULL, preset TEXT NOT NULL, requestKey TEXT NOT NULL, requestDigest TEXT NOT NULL, state TEXT NOT NULL, queueId INTEGER, buildNumber INTEGER, errorCode TEXT NOT NULL, resultJson TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(projectId,requestKey));
      CREATE TABLE IF NOT EXISTS component_audit(sequence INTEGER PRIMARY KEY, projectId TEXT NOT NULL, componentKey TEXT NOT NULL, taskId TEXT NOT NULL, actorId TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_tasks(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,componentVersion INTEGER NOT NULL,actorId TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,resultJson TEXT NOT NULL,errorCode TEXT NOT NULL);
      UPDATE sync_tasks SET state='uncertain',errorCode='SYNC_INTERRUPTED_REVIEW_REQUIRED' WHERE state='running';
      UPDATE build_tasks SET state='uncertain',errorCode='JENKINS_SUBMISSION_UNKNOWN' WHERE state='dispatching';`);
    this.loadSnapshots();
    this.removeListener = options.management.onComponentChanged(async (projectId) => {
      await this.pauseDisabled(projectId);
    });
  }
  private path(...parts: string[]): string {
    const root = realpathSync(this.options.root);
    const target = resolve(root, ...parts);
    const check = relative(root, target);
    if (check.startsWith(`..${sep}`) || check === ".." || isAbsolute(check))
      throw new Error("COMPONENT_PATH_ESCAPE");
    let existing = target;
    while (!existsSync(existing)) existing = dirname(existing);
    const real = realpathSync(existing);
    if (real !== root && !real.startsWith(root + sep)) throw new Error("COMPONENT_PATH_ESCAPE");
    return target;
  }
  private key(projectId: string, key: string, version: number): string {
    return `${uuid(projectId)}:${key}:${version}`;
  }
  private folder(projectId: string, key: ProjectComponentKey, version: number): string {
    return this.path("projects", uuid(projectId), "components", key, "versions", String(version));
  }
  private credential(config: Json): { value: Json; digest: string } {
    const reference = string(config["credentialRef"], "credentialRef");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(reference))
      throw new ComponentRuntimeError(
        "CREDENTIAL_REFERENCE_INVALID",
        "凭据引用只允许独立凭据目录中的名称",
      );
    const root = realpathSync(this.options.credentialRoot);
    const file = join(root, `${reference}.json`);
    if (!existsSync(file))
      throw new ComponentRuntimeError("CREDENTIAL_NOT_CONFIGURED", "独立测试凭据尚未配置");
    const actual = realpathSync(file);
    if (!actual.startsWith(root + sep))
      throw new ComponentRuntimeError("CREDENTIAL_REFERENCE_INVALID", "凭据不能指向目录外部");
    const raw = readFileSync(actual, "utf8");
    if (raw.length > 65536)
      throw new ComponentRuntimeError("CREDENTIAL_REFERENCE_INVALID", "凭据内容过大");
    return {
      value: object(JSON.parse(raw)),
      digest: createHash("sha256").update(raw).digest("hex"),
    };
  }
  private loadSnapshots(): void {
    const projects = this.path("projects");
    if (!existsSync(projects)) return;
    for (const projectId of readdirSync(projects).filter((entry) => UUID.test(entry)))
      for (const key of COMPONENTS) {
        const root = this.path("projects", projectId, "components", key, "versions");
        if (!existsSync(root)) continue;
        for (const version of readdirSync(root).filter((entry) => /^[1-9][0-9]*$/u.test(entry))) {
          const file = this.path(
            "projects",
            projectId,
            "components",
            key,
            "versions",
            version,
            "configuration.json",
          );
          if (!existsSync(file)) continue;
          const snapshot = JSON.parse(readFileSync(file, "utf8")) as VersionSnapshot;
          if (
            snapshot.projectId !== projectId ||
            snapshot.key !== key ||
            snapshot.version !== Number(version)
          )
            throw new Error("COMPONENT_SNAPSHOT_SCOPE_MISMATCH");
          this.snapshots.set(this.key(projectId, key, Number(version)), snapshot);
        }
      }
  }
  private async settings(projectId: string): Promise<ProjectComponentList> {
    return this.options.worker.projectManagement({
      operation: "components",
      accountId: this.options.management.options.accountId,
      actorId: this.options.management.options.gmUserId,
      isGm: true,
      projectId,
      includePrivateConfig: true,
    });
  }
  private async enabled(projectId: string, key: ProjectComponentKey): Promise<boolean> {
    if (this.options.executionHeld?.()) return false;
    try {
      return (await this.settings(projectId)).items.some(
        (item) => item.key === key && item.enabled,
      );
    } catch {
      return false;
    }
  }
  private async latest(
    projectId: string,
    key: ProjectComponentKey,
    execution = true,
  ): Promise<VersionSnapshot> {
    if (execution) this.requireExecution();
    const item = (await this.settings(projectId)).items.find((component) => component.key === key)!;
    if (execution && !item.enabled)
      throw new ComponentRuntimeError("COMPONENT_DISABLED", "该项目未启用此组件");
    if (!item.version) throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", "该组件待配置");
    const mapKey = this.key(projectId, key, item.version);
    const previous = this.snapshots.get(mapKey);
    if (previous) return previous;
    let config = object(item.config);
    if (key === "build_upload.single") {
      const [build, upload] = await Promise.all([
        this.latest(projectId, "build"),
        this.latest(projectId, "upload.incremental"),
      ]);
      config = {
        ...upload.config,
        ...config,
        buildVersion: build.version,
        uploadVersion: upload.version,
      };
    }
    const credential = this.credential(config);
    // Passwords are never persisted inside version snapshots; references are
    // resolved only inside the configured independent credential directory.
    if (Object.keys(config).some((name) => /password|token|authorization|secret/iu.test(name)))
      throw new ComponentRuntimeError(
        "CREDENTIAL_REFERENCE_REQUIRED",
        "请使用 credentialRef 保存服务端凭据",
      );
    const snapshot = {
      projectId,
      key,
      version: item.version,
      config,
      credentialDigest: credential.digest,
      createdAt: stamp(),
    };
    // Validate before committing a version file: an incomplete saved snapshot
    // must never make older local history unreadable.
    if (key === "build") this.jenkins(snapshot);
    if (key === "upload.incremental" || key === "build_upload.single") {
      origin(config["apiBase"], "apiBase");
      origin(config["loginBase"], "loginBase");
      url(config["sourceUrl"], "sourceUrl");
      for (const field of ["targetPrefix", "testDirectoryPrefix", "releaseDirectoryPrefix"]) {
        const value = string(config[field], field);
        if (
          value.startsWith("/") ||
          !value.endsWith("/") ||
          value.includes("..") ||
          value.includes("\\") ||
          value.includes(":")
        )
          throw new ComponentRuntimeError(
            "COMPONENT_NOT_CONFIGURED",
            `${field} 必须是明确的目录前缀`,
          );
      }
      parseNewUploadInput(
        { mode: "prepare_publish" },
        object(config["defaults"]) as Partial<UploadInput>,
      );
    }
    if (key === "relay.production" || key === "qingyu.sync") {
      origin(config["baseUrl"], "baseUrl");
      string(config["externalProjectId"], "externalProjectId");
    }
    if (key === "relay.production") {
      string(config["relayInstanceId"], "relayInstanceId");
      string(credential.value["bearerToken"], "Relay bearerToken");
    }
    if (
      key === "qingyu.sync" &&
      string(credential.value["stateSecret"], "Qingyu stateSecret").length < 16
    )
      throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", "Qingyu stateSecret 长度不足");
    const concurrent = this.snapshots.get(mapKey);
    if (concurrent) return concurrent;
    const folder = this.folder(projectId, key, item.version);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "configuration.json"), JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    this.snapshots.set(mapKey, snapshot);
    return snapshot;
  }
  private credentials(snapshot: VersionSnapshot): Json {
    const credential = this.credential(snapshot.config);
    if (credential.digest !== snapshot.credentialDigest)
      throw new ComponentRuntimeError(
        "CREDENTIAL_VERSION_CHANGED",
        "运行任务的凭据引用内容已改变，请恢复原引用并为新配置使用新名称",
      );
    return credential.value;
  }
  private jenkins(snapshot: VersionSnapshot): JenkinsBuildService {
    const mapKey = this.key(snapshot.projectId, snapshot.key, snapshot.version);
    const previous = this.builds.get(mapKey);
    if (previous) return previous;
    const config = snapshot.config;
    const credential = this.credentials(snapshot);
    const artifactTemplate = string(config["artifactUrlTemplate"], "artifactUrlTemplate");
    if (
      !artifactTemplate.includes("{buildNumber}") ||
      new URL(url(artifactTemplate.replaceAll("{buildNumber}", "1"), "artifactUrlTemplate"))
        .origin !== origin(config["downloadOrigin"], "downloadOrigin")
    )
      throw new ComponentRuntimeError(
        "BUILD_ARTIFACT_NOT_BOUND",
        "产物地址必须绑定构建号和配置的下载服务",
      );
    const presets = object(config["presets"]);
    const normalized: Record<string, Record<string, string>> = {};
    for (const [name, value] of Object.entries(presets)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(name))
        throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", "打包预设名称无效");
      normalized[name] = {};
      for (const [parameter, parameterValue] of Object.entries(object(value)))
        normalized[name]![parameter] = string(parameterValue, parameter);
    }
    if (!Object.keys(normalized).length)
      throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", "需要至少一个打包预设");
    const job = string(config["job"] ?? config["jobName"], "job");
    const jobPath = `${job
      .split("/")
      .filter(Boolean)
      .map((segment) => `/job/${encodeURIComponent(segment)}`)
      .join("")}/`;
    const relativePath = (value: unknown, label: string) => {
      const path = string(value, label);
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("..") ||
        path.includes("\\")
      )
        throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", `${label} 路径无效`);
      return path;
    };
    const configuration: JenkinsProjectConfiguration = {
      projectId: snapshot.projectId,
      version: snapshot.version,
      origin: origin(config["baseUrl"], "baseUrl"),
      downloadOrigin: origin(config["downloadOrigin"], "downloadOrigin"),
      jobPath,
      authorization: `Basic ${Buffer.from(`${string(credential["username"], "Jenkins username")}:${string(credential["apiToken"], "Jenkins apiToken")}`).toString("base64")}`,
      zipPath: relativePath(config["zipPath"], "zipPath"),
      presets: normalized,
      ...(config["apkPath"] ? { apkPath: relativePath(config["apkPath"], "apkPath") } : {}),
      ...(config["ipaPath"] ? { ipaPath: relativePath(config["ipaPath"], "ipaPath") } : {}),
    };
    const service = new JenkinsBuildService(this.options.fetch ?? fetch, configuration);
    this.builds.set(mapKey, service);
    return service;
  }
  private compatibility(snapshot: VersionSnapshot): BuildCompatibilityService {
    const mapKey = this.key(snapshot.projectId, snapshot.key, snapshot.version);
    const previous = this.compatibilities.get(mapKey);
    if (previous) return previous;
    const service = new BuildCompatibilityService(
      this.jenkins(snapshot),
      join(
        this.folder(snapshot.projectId, snapshot.key, snapshot.version),
        "legacy-build-compatibility",
      ),
    );
    this.compatibilities.set(mapKey, service);
    return service;
  }
  private tasks(projectId?: string): BuildTask[] {
    return this.db
      .prepare("SELECT * FROM build_tasks WHERE (? IS NULL OR projectId=?) ORDER BY createdAt,id")
      .all(projectId ?? null, projectId ?? null) as unknown as BuildTask[];
  }
  private save(task: BuildTask): void {
    task.updatedAt = stamp();
    this.db
      .prepare(
        "UPDATE build_tasks SET state=?,queueId=?,buildNumber=?,errorCode=?,resultJson=?,updatedAt=? WHERE id=? AND projectId=?",
      )
      .run(
        task.state,
        task.queueId,
        task.buildNumber,
        task.errorCode,
        task.resultJson,
        task.updatedAt,
        task.id,
        task.projectId,
      );
  }
  private audit(
    projectId: string,
    key: string,
    taskId: string,
    actorId: string,
    action: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO component_audit(projectId,componentKey,taskId,actorId,action,at) VALUES(?,?,?,?,?,?)",
      )
      .run(projectId, key, taskId, actorId, action, stamp());
  }
  private publicTask(task: BuildTask): Json {
    return {
      id: task.id,
      taskId: task.id,
      projectId: task.projectId,
      actorId: task.actorId,
      componentVersion: task.componentVersion,
      preset: task.preset,
      state: task.state,
      queueId: task.queueId,
      buildNumber: task.buildNumber,
      errorCode: task.errorCode,
      result: JSON.parse(task.resultJson),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }
  async listBuildTasks(projectId: string): Promise<Json> {
    return { projectId, items: this.tasks(projectId).map((task) => this.publicTask(task)) };
  }
  async buildTask(projectId: string, taskId: string): Promise<Json> {
    const task = this.tasks(projectId).find((item) => item.id === uuid(taskId));
    if (!task) throw new ComponentRuntimeError("NOT_FOUND", "任务不存在", 404);
    return this.publicTask(task);
  }
  async savedBuildProgress(projectId: string): Promise<Json> {
    const tasks = this.tasks(projectId);
    return {
      projectId,
      checkedAt: stamp(),
      builds: tasks.map((task) => object(JSON.parse(task.resultJson))["progress"]).filter(Boolean),
      queues: tasks
        .filter((task) => task.queueId && !task.buildNumber)
        .map((task) => ({
          id: task.queueId,
          status: task.state === "cancelled" ? "CANCELLED" : "QUEUED",
          reason: task.errorCode || "等待已登记任务的后台状态更新",
        })),
    };
  }
  async startBuildCompatibility(
    projectId: string,
    requestId: unknown,
  ): Promise<CompatibilityBatch> {
    const snapshot = await this.latest(projectId, "build");
    return this.compatibility(snapshot).start(uuid(requestId));
  }
  async buildCompatibility(projectId: string, requestId: unknown): Promise<CompatibilityBatch> {
    const snapshot = await this.latest(projectId, "build", false);
    return this.compatibility(snapshot).status(uuid(requestId));
  }
  async enqueueBuild(
    projectId: string,
    actorId: string,
    requestKey: unknown,
    value: unknown,
  ): Promise<Json> {
    this.requireExecution();
    if (typeof requestKey !== "string" || !/^[A-Za-z0-9:_.-]{16,160}$/u.test(requestKey))
      throw new ComponentRuntimeError("INVALID_REQUEST", "需要幂等键", 400);
    const preset = string(object(value)["preset"], "preset");
    const digest = hash({ preset });
    const previous = this.tasks(projectId).find((task) => task.requestKey === requestKey);
    if (previous) {
      if (previous.requestDigest !== digest)
        throw new ComponentRuntimeError("IDEMPOTENCY_CONFLICT", "幂等键参数不同");
      return this.publicTask(previous);
    }
    const snapshot = await this.latest(projectId, "build");
    this.jenkins(snapshot);
    if (!object(snapshot.config["presets"])[preset])
      throw new ComponentRuntimeError("BUILD_PRESET_NOT_CONFIGURED", "该项目没有此打包预设", 400);
    const task: BuildTask = {
      id: randomUUID(),
      projectId,
      actorId,
      componentVersion: snapshot.version,
      preset,
      requestKey,
      requestDigest: digest,
      state: "queued",
      queueId: null,
      buildNumber: null,
      errorCode: "",
      resultJson: "{}",
      createdAt: stamp(),
      updatedAt: stamp(),
    };
    this.db
      .prepare("INSERT INTO build_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        task.id,
        task.projectId,
        task.actorId,
        task.componentVersion,
        task.preset,
        task.requestKey,
        task.requestDigest,
        task.state,
        task.queueId,
        task.buildNumber,
        task.errorCode,
        task.resultJson,
        task.createdAt,
        task.updatedAt,
      );
    this.audit(projectId, "build", task.id, actorId, "queued");
    return this.publicTask(task);
  }
  async buildAction(
    projectId: string,
    actorId: string,
    taskId: string,
    action: "resume" | "cancel",
  ): Promise<Json> {
    if (action === "resume") this.requireExecution();
    const task = this.tasks(projectId).find((item) => item.id === uuid(taskId));
    if (!task) throw new ComponentRuntimeError("NOT_FOUND", "任务不存在", 404);
    if (action === "cancel") {
      if (!["queued", "paused", "cancelled"].includes(task.state))
        throw new ComponentRuntimeError(
          "TASK_ALREADY_STARTED",
          "运行任务保留执行，请使用其服务的明确取消操作",
        );
      task.state = "cancelled";
    } else {
      if (task.state !== "paused")
        throw new ComponentRuntimeError("TASK_NOT_PAUSED", "只有已暂停任务可以恢复");
      if (!(await this.enabled(projectId, "build")))
        throw new ComponentRuntimeError("COMPONENT_DISABLED", "组件未启用");
      task.state = "queued";
    }
    task.errorCode = "";
    this.save(task);
    this.audit(projectId, "build", task.id, actorId, action);
    return this.publicTask(task);
  }
  async packaging(projectId: string): Promise<Json> {
    const tasks = this.tasks(projectId);
    let status: PackagingStatus | null = null;
    if (await this.enabled(projectId, "build")) {
      const snapshot = await this.latest(projectId, "build");
      status = await this.jenkins(snapshot).status();
      // A shared Jenkins job may contain unrelated builds. Only recorded QA Hub
      // task IDs appear in this project's task/history projection.
      if (status.jenkins)
        status = {
          ...status,
          jenkins: {
            ...status.jenkins,
            builds: status.jenkins.builds.filter((build) =>
              tasks.some(
                (task) =>
                  task.componentVersion === snapshot.version && task.buildNumber === build.number,
              ),
            ),
            queue: status.jenkins.queue.filter((queue) =>
              tasks.some(
                (task) => task.componentVersion === snapshot.version && task.queueId === queue.id,
              ),
            ),
          },
        };
    }
    return {
      projectId,
      ...(status ?? {
        checkedAt: stamp(),
        jenkins: null,
        jenkinsError: null,
        apks: [],
        apkError: null,
        ipas: [],
        ipaError: null,
        zip: null,
        zipError: null,
      }),
      tasks: tasks.map((task) => this.publicTask(task)),
    };
  }
  private async uploader(snapshot: VersionSnapshot): Promise<IncrementUploadService> {
    const mapKey = this.key(snapshot.projectId, snapshot.key, snapshot.version);
    const previous = this.uploaders.get(mapKey);
    if (previous) return previous;
    const config = snapshot.config;
    const folder = this.folder(snapshot.projectId, snapshot.key, snapshot.version);
    const defaults = object(config["defaults"]) as Partial<UploadInput>;
    const project: UploadProjectConfiguration = {
      projectId: snapshot.projectId,
      componentVersion: snapshot.version,
      apiBase: origin(config["apiBase"], "apiBase"),
      loginBase: origin(config["loginBase"], "loginBase"),
      sourceUrl:
        url(config["sourceUrl"], "sourceUrl") +
        (config["sourceKind"] === "ios_directory" ? "/" : ""),
      targetPrefix: string(config["targetPrefix"], "targetPrefix"),
      testDirectoryPrefix: string(config["testDirectoryPrefix"], "testDirectoryPrefix"),
      releaseDirectoryPrefix: string(config["releaseDirectoryPrefix"], "releaseDirectoryPrefix"),
      credentialRef: string(config["credentialRef"], "credentialRef"),
      defaults,
      ...(config["sourceKind"] === "ios_directory"
        ? { sourceKind: "ios_directory" }
        : { sourceKind: "file" }),
    };
    // Missing build configuration does not prevent independent increment upload.
    let jenkins = new JenkinsBuildService(this.options.fetch ?? fetch);
    const buildVersion = config["buildVersion"];
    if (typeof buildVersion === "number") {
      const build = this.snapshots.get(this.key(snapshot.projectId, "build", buildVersion));
      if (build) {
        try {
          jenkins = this.jenkins(build);
        } catch {
          /* Preserve local history when an old credential is unavailable. */
        }
      }
    }
    const service = new IncrementUploadService({
      root: folder,
      jenkins,
      project,
      sharedLockRoot: this.path("shared-resource-locks"),
      ...(typeof config["buildPreset"] === "string" ? { buildPreset: config["buildPreset"] } : {}),
      ...(this.options.uploaderExecutable ? { executable: this.options.uploaderExecutable } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      authFileForOwner: (owner) =>
        this.path(
          "projects",
          snapshot.projectId,
          "components",
          snapshot.key,
          "versions",
          String(snapshot.version),
          "owners",
          uuid(owner),
          "auth.json",
        ),
      canStart: async (kind) =>
        await this.enabled(
          snapshot.projectId,
          kind === "build" ? "build_upload.single" : "upload.incremental",
        ),
    });
    this.uploaders.set(mapKey, service);
    return service;
  }
  private prepareUploadCredential(snapshot: VersionSnapshot, owner: string): void {
    const file = this.path(
      "projects",
      snapshot.projectId,
      "components",
      snapshot.key,
      "versions",
      String(snapshot.version),
      "owners",
      uuid(owner),
      "auth.json",
    );
    if (!existsSync(file)) {
      const credential = this.credentials(snapshot);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          ...credential,
          apiBase: origin(snapshot.config["apiBase"], "apiBase"),
          loginBase: origin(snapshot.config["loginBase"], "loginBase"),
        }),
        { flag: "wx", mode: 0o600 },
      );
    }
  }
  private async uploadVersions(projectId: string): Promise<IncrementUploadService[]> {
    const versions = [...this.snapshots.values()].filter(
      (item) =>
        item.projectId === projectId &&
        (item.key === "upload.incremental" || item.key === "build_upload.single"),
    );
    return Promise.all(versions.map((snapshot) => this.uploader(snapshot)));
  }
  async uploadSnapshot(projectId: string, actorId: string): Promise<UploaderSnapshot> {
    if (await this.enabled(projectId, "upload.incremental")) {
      try {
        await this.uploader(await this.latest(projectId, "upload.incremental"));
      } catch {
        /* A new incomplete config must not hide already persisted history. */
      }
    }
    const results = await Promise.all(
      (await this.uploadVersions(projectId)).map((service) => service.snapshot(actorId)),
    );
    return {
      ...(results.at(-1) ?? {
        available: false,
        configured: false,
        toolVersion: "",
        sourceUrl: "",
        account: "",
        kind: "email",
        authError: false,
        jobs: [],
        unreadableJobs: 0,
      }),
      projectId,
      execution: "server",
      jobs: results.flatMap((item) => item.jobs),
      unreadableJobs: results.reduce((sum, item) => sum + item.unreadableJobs, 0),
    };
  }
  async uploadChains(projectId: string, actorId: string): Promise<BuildUploadChain[]> {
    return (
      await Promise.all(
        (await this.uploadVersions(projectId)).map((service) => service.buildChains(actorId)),
      )
    ).flat();
  }
  async uploadOperation(
    projectId: string,
    actorId: string,
    operation: string,
    input: unknown,
    requestKey?: unknown,
    taskId?: string,
  ): Promise<unknown> {
    if (!["logs", "cancel", "cancel-build"].includes(operation)) this.requireExecution();
    if (operation === "enqueue" || operation === "build") {
      const component = operation === "build" ? "build_upload.single" : "upload.incremental";
      const snapshot = await this.latest(projectId, component);
      if (operation === "build") {
        await this.latest(projectId, "build");
        await this.latest(projectId, "upload.incremental");
      }
      this.prepareUploadCredential(snapshot, actorId);
      const service = await this.uploader(snapshot);
      const jobId = await service.enqueue(
        actorId,
        requestKey,
        input,
        operation === "build" ? "build" : "upload",
      );
      if (operation === "build") {
        const chain = (await service.buildChains(actorId)).find((item) => item.id === jobId);
        if (!chain)
          throw new ComponentRuntimeError("COMPONENT_HISTORY_MISSING", "排队记录未能读回");
        return chain;
      }
      return jobId;
    }
    if (["login", "logout", "check-auth"].includes(operation)) {
      const snapshot = await this.latest(projectId, "upload.incremental");
      this.prepareUploadCredential(snapshot, actorId);
      const service = await this.uploader(snapshot);
      return service.account(actorId, operation as "login" | "logout" | "check-auth", input);
    }
    const service = (await this.uploadVersions(projectId)).find((item) =>
      item.hasJob(uuid(taskId)),
    );
    if (!service) throw new ComponentRuntimeError("NOT_FOUND", "该项目中不存在此上传任务", 404);
    if (operation === "logs") return service.logs(actorId, taskId);
    if (operation === "cancel") return service.cancel(actorId, taskId);
    if (operation === "cancel-build") return service.cancel(actorId, taskId, true);
    if (operation === "resume-queued") return service.resumeQueued(actorId, taskId);
    if (operation === "resume" || operation === "confirm")
      return service.continue(actorId, taskId, requestKey, operation, input);
    throw new ComponentRuntimeError("INVALID_REQUEST", "不支持此任务动作", 400);
  }
  private stores(projectId: string, componentVersion: number, snapshot?: VersionSnapshot) {
    const binding =
      snapshot?.key === "relay.production"
        ? {
            relayInstanceId: string(snapshot.config["relayInstanceId"], "relayInstanceId"),
            qaInstanceId: this.options.instanceId,
            componentRoute: {
              componentVersion: snapshot.version,
              snapshotDigest: hash(snapshot),
              externalProjectKey: string(snapshot.config["externalProjectId"], "externalProjectId"),
            },
          }
        : undefined;
    const stores = this.options.storesForProject?.(projectId, componentVersion, binding);
    if (!stores)
      throw new ComponentRuntimeError("COMPONENT_NOT_CONFIGURED", "项目执行存储尚未配置");
    return stores;
  }
  private production(snapshot: VersionSnapshot): ProductionTasks {
    const key = this.key(snapshot.projectId, snapshot.key, snapshot.version);
    const previous = this.productions.get(key);
    if (previous) return previous;
    const credentials = this.credentials(snapshot);
    const stores = this.stores(snapshot.projectId, snapshot.version, snapshot);
    const service = new ProductionTasks(
      {
        projectId: snapshot.projectId,
        componentVersion: snapshot.version,
        gmUserId: this.options.management.options.gmUserId,
        endpoint: origin(snapshot.config["baseUrl"], "baseUrl"),
        externalProjectKey: string(snapshot.config["externalProjectId"], "externalProjectId"),
        bearerToken: string(credentials["bearerToken"], "Relay bearerToken"),
        qaInstanceId: this.options.instanceId,
        stateRoot: join(
          this.folder(snapshot.projectId, snapshot.key, snapshot.version),
          "production",
        ),
        canStart: () => this.enabled(snapshot.projectId, "relay.production"),
      },
      stores,
      this.options.fetch ?? fetch,
    );
    this.productions.set(key, service);
    if (!this.relayPumps.has(key))
      this.relayPumps.set(
        key,
        startMobileRelayOutboxPump({
          worker: this.options.worker,
          endpoint: new URL(REAL_RELAY_HANDOFF_PATH, origin(snapshot.config["baseUrl"], "baseUrl")),
          bearerToken: string(credentials["bearerToken"], "Relay bearerToken"),
          qaInstanceId: this.options.instanceId,
          scope: {
            accountId: this.options.management.options.accountId,
            projectId: snapshot.projectId,
            componentVersion: snapshot.version,
            snapshotDigest: hash(snapshot),
            relayInstanceId: string(snapshot.config["relayInstanceId"], "relayInstanceId"),
          },
          canStart: () => this.enabled(snapshot.projectId, "relay.production"),
          ...(this.options.executionHeld ? { executionHeld: this.options.executionHeld } : {}),
          ...(this.options.evidenceRoot ? { evidenceRoot: this.options.evidenceRoot } : {}),
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        }),
      );
    return service;
  }
  async relayQueue(
    projectId: string,
    actorId: string,
    operation: "list" | "resume",
    outboxMessageId?: string,
  ): Promise<unknown> {
    if (operation === "resume") this.requireExecution();
    return this.options.worker.projectRelayQueue({
      operation,
      accountId: this.options.management.options.accountId,
      projectId,
      actorId,
      isGm: actorId === this.options.management.options.gmUserId,
      ...(outboxMessageId ? { outboxMessageId } : {}),
      now: stamp(),
    });
  }
  async productionHistory(projectId: string, actorId?: string): Promise<Json> {
    const items: Json[] = [];
    for (const snapshot of this.snapshots.values())
      if (snapshot.projectId === projectId && snapshot.key === "relay.production") {
        const folder = this.path(
          "projects",
          projectId,
          "components",
          snapshot.key,
          "versions",
          String(snapshot.version),
          "production",
          "batches",
        );
        if (!existsSync(folder)) continue;
        for (const file of readdirSync(folder).filter((entry) =>
          /^[a-f0-9]{64}\.json$/u.test(entry),
        )) {
          const batch = object(JSON.parse(readFileSync(join(folder, file), "utf8")));
          if (batch["projectId"] !== projectId || batch["componentVersion"] !== snapshot.version)
            throw new ComponentRuntimeError("COMPONENT_HISTORY_SCOPE_MISMATCH", "历史归属校验失败");
          if (actorId !== undefined && batch["actorId"] !== actorId) continue;
          const entries = Array.isArray(batch["items"]) ? batch["items"].map(object) : [];
          const state = entries.some((item) => item["status"] === "running")
            ? "running"
            : entries.some((item) => item["status"] === "paused")
              ? "paused"
              : entries.some((item) => item["status"] === "queued")
                ? "queued"
                : entries.some((item) => item["status"] === "failed")
                  ? "failed"
                  : "completed";
          items.push({
            id: batch["id"],
            projectId,
            componentVersion: snapshot.version,
            state,
            status: state,
            createdAt: batch["createdAt"],
            updatedAt: batch["updatedAt"],
            result: {
              kind: batch["kind"],
              items: entries.map((item) => ({
                input: item["input"],
                status: item["status"],
                result: item["result"],
                error: item["error"],
              })),
            },
          });
        }
      }
    return {
      projectId,
      items: items.sort((a, b) => String(b["createdAt"]).localeCompare(String(a["createdAt"]))),
    };
  }
  async productionBatches(
    projectId: string,
    actorId: string,
    limit: number | null = 8,
  ): Promise<Json> {
    const history = await this.productionHistory(projectId, actorId);
    const entries = history["items"] as Json[];
    return {
      items: (limit === null ? entries : entries.slice(0, limit)).map((entry) => {
        const result = object(entry["result"]);
        return {
          id: entry["id"],
          projectId: entry["projectId"],
          componentVersion: entry["componentVersion"],
          kind: result["kind"],
          status: entry["status"],
          createdAt: entry["createdAt"],
          updatedAt: entry["updatedAt"],
          items: Array.isArray(result["items"]) ? result["items"] : [],
        };
      }),
    };
  }
  async productionOperation(
    projectId: string,
    actorId: string,
    operation: string,
    input?: unknown,
    taskId?: string,
  ): Promise<unknown> {
    if (!["batches", "batch"].includes(operation)) this.requireExecution();
    if (operation === "batches") return this.productionBatches(projectId, actorId);
    if (operation === "batch" || operation === "retry") {
      if (!/^[a-f0-9]{64}$/u.test(taskId ?? ""))
        throw new ComponentRuntimeError("NOT_FOUND", "批次不存在", 404);
      const snapshot = [...this.snapshots.values()].find(
        (item) =>
          item.projectId === projectId &&
          item.key === "relay.production" &&
          existsSync(
            join(
              this.folder(projectId, item.key, item.version),
              "production",
              "batches",
              `${string(taskId, "batchId")}.json`,
            ),
          ),
      );
      if (!snapshot || !/^[a-f0-9]{64}$/u.test(taskId ?? ""))
        throw new ComponentRuntimeError("NOT_FOUND", "批次不存在", 404);
      if (operation === "batch") {
        const batch = (
          (await this.productionBatches(projectId, actorId, null))["items"] as Json[]
        ).find((item) => item["id"] === taskId);
        if (!batch) throw new ComponentRuntimeError("NOT_FOUND", "批次不存在", 404);
        return batch;
      }
      return this.production(snapshot).batch(actorId, projectId, taskId!, true);
    }
    const actions =
      operation === "submit" && object(input)["kind"] === "action"
        ? Array.isArray(object(input)["items"])
          ? (object(input)["items"] as unknown[]).map((item) =>
              string(object(item)["taskId"], "taskId"),
            )
          : []
        : operation === "task"
          ? [string(taskId, "taskId")]
          : [];
    let snapshot = await this.latest(projectId, "relay.production");
    if (actions.length) {
      const known = new Map<string, number>();
      const history = await this.productionHistory(projectId);
      for (const batch of history["items"] as Json[]) {
        for (const item of object(batch["result"])["items"] as Json[]) {
          const result = item["result"];
          if (
            result &&
            typeof result === "object" &&
            typeof (result as Json)["taskId"] === "string"
          )
            known.set(String((result as Json)["taskId"]), Number(batch["componentVersion"]));
        }
      }
      const queue = (await this.relayQueue(projectId, actorId, "list")) as { items: Json[] };
      for (const item of queue.items)
        if (typeof item["relayTaskId"] === "string")
          known.set(item["relayTaskId"], Number(item["componentVersion"]));
      const versions = new Set(actions.map((id) => known.get(id) ?? snapshot.version));
      if (versions.size !== 1)
        throw new ComponentRuntimeError(
          "COMPONENT_VERSION_CONFLICT",
          "不同配置版本的任务请分别提交操作",
        );
      const version = [...versions][0]!;
      snapshot =
        this.snapshots.get(this.key(projectId, "relay.production", version)) ??
        (() => {
          throw new ComponentRuntimeError("COMPONENT_SNAPSHOT_MISSING", "任务原制作配置缺失");
        })();
    }
    const service = this.production(snapshot);
    if (operation === "project") return service.project(actorId, projectId);
    if (operation === "tasks") return service.tasks(actorId, projectId);
    if (operation === "task") return service.task(actorId, projectId, string(taskId, "taskId"));
    if (operation === "attachment")
      return service.attachment(actorId, projectId, string(taskId, "attachmentId"));
    if (operation === "submit") return service.submit(actorId, { ...object(input), projectId });
    if (operation === "upload") return service.upload(actorId, { ...object(input), projectId });
    throw new ComponentRuntimeError("INVALID_REQUEST", "不支持此制作动作", 400);
  }
  private qingyu(snapshot: VersionSnapshot): Promise<QingyuIntegration> {
    const key = this.key(snapshot.projectId, snapshot.key, snapshot.version);
    const previous = this.qingyus.get(key);
    if (previous) return previous;
    const credentials = this.credentials(snapshot);
    const stores = this.stores(snapshot.projectId, snapshot.version);
    let initialCredentials: QingyuCredentials | undefined;
    if (credentials["token"]) {
      const user = object(credentials["user"]);
      initialCredentials = {
        token: string(credentials["token"], "Qingyu token"),
        user: {
          id: string(user["id"], "Qingyu user id"),
          name: string(user["name"], "Qingyu user name"),
          avatar: typeof user["avatar"] === "string" ? user["avatar"] : null,
        },
      };
    }
    const service = createQingyuIntegration({
      statePath: join(
        this.folder(snapshot.projectId, snapshot.key, snapshot.version),
        "qingyu.encrypted.json",
      ),
      secret: string(credentials["stateSecret"], "Qingyu stateSecret"),
      qaProjectId: snapshot.projectId,
      externalProjectId: string(snapshot.config["externalProjectId"], "externalProjectId"),
      mobileBugStore: stores.bugs,
      mobileAttachmentStore: stores.attachments,
      linkStore: stores.qingyuLinks,
      client: new QingyuClient({
        baseUrl: origin(snapshot.config["baseUrl"], "baseUrl"),
        fetchImpl: this.options.fetch ?? fetch,
      }),
      canStart: () => this.enabled(snapshot.projectId, "qingyu.sync"),
      ...(initialCredentials ? { initialCredentials } : {}),
    });
    this.qingyus.set(key, service);
    void service.catch(() => this.qingyus.delete(key));
    return service;
  }
  async qingyuHistory(projectId: string): Promise<Json> {
    const rows = this.db
      .prepare("SELECT * FROM sync_tasks WHERE projectId=? ORDER BY createdAt DESC,id DESC")
      .all(projectId) as unknown as Json[];
    return {
      projectId,
      items: rows.map((row) => {
        const { resultJson, ...item } = row;
        return { ...item, result: JSON.parse(String(resultJson)) };
      }),
    };
  }
  async qingyuOperation(
    projectId: string,
    actorId: string,
    operation: string,
    input?: unknown,
    bugId?: string,
  ): Promise<unknown> {
    if (operation === "link") return this.stores(projectId, 0).qingyuLinks.getBugLink(uuid(bugId));
    this.requireExecution();
    const snapshot = await this.latest(projectId, "qingyu.sync");
    const service = await this.qingyu(snapshot);
    const externalProjectId = string(snapshot.config["externalProjectId"], "externalProjectId");
    const requested =
      input && typeof input === "object" ? (input as Json)["externalProjectId"] : undefined;
    if (requested !== undefined && requested !== externalProjectId)
      throw new ComponentRuntimeError("EXTERNAL_PROJECT_MISMATCH", "第三方项目与配置不一致", 403);
    if (operation === "session") return service.session(actorId);
    if (operation === "start") return service.startLogin(actorId);
    if (operation === "poll") return service.pollLogin(actorId);
    if (operation === "logout") return service.logout(actorId);
    if (operation === "projects") return { projects: await service.listProjects(actorId) };
    if (operation === "defects") return service.listOwnDefects(actorId, externalProjectId);
    const taskId = randomUUID();
    const created = stamp();
    this.db
      .prepare("INSERT INTO sync_tasks VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        taskId,
        projectId,
        snapshot.version,
        actorId,
        operation,
        "running",
        created,
        created,
        "{}",
        "",
      );
    try {
      const result =
        operation === "import"
          ? await service.importOwnDefects(
              actorId,
              externalProjectId,
              Array.isArray(object(input)["defectIds"])
                ? (object(input)["defectIds"] as unknown[]).map((value) =>
                    string(value, "defectId"),
                  )
                : undefined,
            )
          : operation === "resolve"
            ? await service.syncHumanClosure(actorId, uuid(bugId))
            : (() => {
                throw new ComponentRuntimeError("INVALID_REQUEST", "不支持此同步动作", 400);
              })();
      this.db
        .prepare(
          "UPDATE sync_tasks SET state=?,updatedAt=?,resultJson=? WHERE id=? AND projectId=?",
        )
        .run(
          result && "items" in result && result.items.some((item) => item.status === "failed")
            ? result.items.every((item) => item.status === "failed")
              ? "failed"
              : "partial_failure"
            : "completed",
          stamp(),
          JSON.stringify(result),
          taskId,
          projectId,
        );
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "QINGYU_UNAVAILABLE";
      this.db
        .prepare("UPDATE sync_tasks SET state=?,updatedAt=?,errorCode=? WHERE id=? AND projectId=?")
        .run(code === "COMPONENT_DISABLED" ? "paused" : "failed", stamp(), code, taskId, projectId);
      throw error;
    }
  }
  private async pauseDisabled(projectId: string): Promise<void> {
    await this.options.worker.projectRelayQueue({
      operation: "pause",
      accountId: this.options.management.options.accountId,
      projectId,
      now: stamp(),
    });
    if (!(await this.enabled(projectId, "build")))
      for (const task of this.tasks(projectId).filter((item) => item.state === "queued")) {
        task.state = "paused";
        task.errorCode = "COMPONENT_DISABLED";
        this.save(task);
        this.audit(projectId, "build", task.id, task.actorId, "paused_component_disabled");
      }
    await Promise.allSettled(
      [...this.uploaders.entries()]
        .filter(([key]) => key.startsWith(projectId + ":"))
        .map(([, service]) => service.pausePending()),
    );
    await Promise.allSettled(
      [...this.productions.entries()]
        .filter(([key]) => key.startsWith(projectId + ":"))
        .map(([, service]) => service.pausePending()),
    );
  }
  private async advanceBuild(task: BuildTask): Promise<void> {
    const snapshot = this.snapshots.get(this.key(task.projectId, "build", task.componentVersion));
    if (!snapshot) throw new ComponentRuntimeError("COMPONENT_SNAPSHOT_MISSING", "任务原配置缺失");
    const service = this.jenkins(snapshot);
    if (task.state === "queued") {
      if (!(await this.enabled(task.projectId, "build"))) {
        task.state = "paused";
        task.errorCode = "COMPONENT_DISABLED";
        this.save(task);
        return;
      }
      task.state = "dispatching";
      this.save(task);
      try {
        const receipt = await service.trigger(task.preset, task.id);
        task.queueId = receipt.queueId;
        task.state = "running";
        task.errorCode = "";
        this.save(task);
      } catch (error) {
        task.state = "uncertain";
        task.errorCode = (error as { code?: string }).code ?? "JENKINS_SUBMISSION_UNKNOWN";
        this.save(task);
      }
      return;
    }
    if (task.state !== "running" || !task.queueId) return;
    const progress = await service.progress(
      [task.queueId],
      task.buildNumber ? [task.buildNumber] : [],
    );
    const build = progress.builds.find(
      (item) =>
        item.queueId === task.queueId && (!task.buildNumber || item.number === task.buildNumber),
    );
    if (!build) {
      if (
        progress.queues.some((queue) => queue.id === task.queueId && queue.status === "CANCELLED")
      )
        task.state = "cancelled";
      this.save(task);
      return;
    }
    task.buildNumber = build.number;
    task.resultJson = JSON.stringify({ progress: build });
    if (build.status === "SUCCESS") {
      // Jenkins SUCCESS alone is not artifact acceptance. The final produced
      // object must be available at a build-specific URL and have actual bytes.
      const template = string(snapshot.config["artifactUrlTemplate"], "artifactUrlTemplate");
      if (!template.includes("{buildNumber}"))
        throw new ComponentRuntimeError("BUILD_ARTIFACT_NOT_BOUND", "产物地址必须绑定具体构建号");
      const artifactUrl = url(
        template.replaceAll("{buildNumber}", String(build.number)),
        "artifactUrl",
      );
      if (
        new URL(artifactUrl).origin !== origin(snapshot.config["downloadOrigin"], "downloadOrigin")
      )
        throw new ComponentRuntimeError(
          "BUILD_ARTIFACT_ORIGIN_MISMATCH",
          "产物不属于配置的下载服务",
        );
      const response = await (this.options.fetch ?? fetch)(artifactUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok || !response.body)
        throw new ComponentRuntimeError("BUILD_ARTIFACT_UNAVAILABLE", "最终产物尚不可读取");
      const digest = createHash("sha256");
      let size = 0;
      for await (const chunk of response.body) {
        digest.update(chunk);
        size += chunk.byteLength;
        if (size > 8 * 1024 * 1024 * 1024)
          throw new ComponentRuntimeError("BUILD_ARTIFACT_TOO_LARGE", "产物超过独立测试上限");
      }
      if (!size) throw new ComponentRuntimeError("BUILD_ARTIFACT_EMPTY", "产物为空");
      task.resultJson = JSON.stringify({
        progress: build,
        artifact: { url: artifactUrl, size, sha256: digest.digest("hex"), verifiedAt: stamp() },
      });
      task.state = "succeeded";
      task.errorCode = "";
    } else if (build.status !== "BUILDING") {
      task.state = "failed";
      task.errorCode = "BUILD_FAILED";
    }
    this.save(task);
  }
  async tick(): Promise<void> {
    if (this.busy || this.options.executionHeld?.()) return;
    this.busy = true;
    try {
      const tasks = this.tasks();
      for (const snapshot of this.snapshots.values()) {
        if (snapshot.key === "upload.incremental" || snapshot.key === "build_upload.single")
          await this.uploader(snapshot).catch(() => undefined);
        if (snapshot.key === "relay.production") {
          try {
            this.production(snapshot);
          } catch {
            /* Missing old credentials prevent execution; history remains local. */
          }
        }
      }
      for (const task of tasks.filter((item) => item.state === "running")) {
        try {
          await this.advanceBuild(task);
        } catch (error) {
          task.errorCode = (error as { code?: string }).code ?? "BUILD_POLL_FAILED";
          this.save(task);
        }
      }
      for (const projectId of new Set(
        tasks.filter((item) => item.state === "queued").map((item) => item.projectId),
      ))
        await this.pauseDisabled(projectId);
      const resources = async () =>
        Promise.all(
          [...this.uploaders.values()].map(async (service) => ({
            service,
            active: await service.hasActiveResources().catch(() => true),
          })),
        );
      if (
        !this.tasks().some((task) => task.state === "running" || task.state === "dispatching") &&
        !(await resources()).some((entry) => entry.active)
      ) {
        const queued = this.tasks().find((task) => task.state === "queued");
        if (queued) {
          try {
            await this.advanceBuild(queued);
          } catch (error) {
            queued.state = "failed";
            queued.errorCode = (error as { code?: string }).code ?? "BUILD_CONFIGURATION_FAILED";
            this.save(queued);
          }
        }
      }
      for (const service of this.uploaders.values()) {
        const ownBuildRunning = this.tasks().some(
          (task) => task.state === "running" || task.state === "dispatching",
        );
        const otherServiceActive = (await resources()).some(
          (entry) => entry.service !== service && entry.active,
        );
        await service.tick(!ownBuildRunning && !otherServiceActive).catch(() => undefined);
      }
    } finally {
      this.busy = false;
    }
  }
  private requireExecution(): void {
    if (this.options.executionHeld?.())
      throw new ComponentRuntimeError(
        "IMPORT_EXECUTION_HELD",
        "导入恢复处于暂停状态，请完成核验并显式解除执行暂停",
      );
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      this.current = this.tick()
        .catch(() => undefined)
        .finally(() => {
          this.current = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(loop, 2000);
            this.timer.unref();
          }
        });
    };
    loop();
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
    this.removeListener();
    await Promise.allSettled([...this.relayPumps.values()].map((pump) => pump.stop()));
    await Promise.allSettled(
      [
        ...this.compatibilities.values(),
        ...this.uploaders.values(),
        ...this.productions.values(),
      ].map((service) => service.close()),
    );
    this.db.close();
  }
}

export function registerProjectComponentRoutes(
  app: FastifyInstance,
  options: {
    runtime: ProjectComponentsRuntime;
    projectId: (request: FastifyRequest) => string;
    actor: (request: FastifyRequest) => BrowserAuthPrincipal | undefined;
  },
): void {
  const route = (
    method: "GET" | "POST",
    path: string,
    operation: (projectId: string, actorId: string, request: FastifyRequest) => Promise<unknown>,
  ) => {
    for (const url of [path, path.replace("/api/v1/", "/api/v1/projects/:projectId/")])
      app.route({
        method,
        url,
        ...(path === "/api/v1/production/uploads" ? { bodyLimit: 36 * 1024 * 1024 } : {}),
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          const actor = options.actor(request);
          if (!actor) return reply.code(401).send({ code: "UNAUTHENTICATED" });
          try {
            const projectId = options.projectId(request);
            await options.runtime.options.management.execute(actor, {
              operation: "authorize",
              projectId,
            });
            return reply
              .header("cache-control", "no-store")
              .type("application/json")
              .send(JSON.stringify(await operation(projectId, actor.userId, request)));
          } catch (error) {
            const candidate = error as { code?: string; message?: string; status?: number };
            const code =
              candidate.code ??
              (candidate.message && /^[A-Z_]+$/u.test(candidate.message)
                ? candidate.message
                : "COMPONENT_UNAVAILABLE");
            return reply
              .code(candidate.status ?? (code === "NOT_FOUND" ? 404 : 409))
              .send({ code, message: candidate.status ? candidate.message : "组件操作未完成" });
          }
        },
      });
  };
  const id = (request: FastifyRequest) => uuid((request.params as Json)["id"]);
  const key = (request: FastifyRequest) => request.headers["idempotency-key"];
  route("GET", "/api/v1/packaging", (projectId) => options.runtime.packaging(projectId));
  route("GET", "/api/v1/packaging/tasks", (projectId) => options.runtime.listBuildTasks(projectId));
  route("GET", "/api/v1/packaging/tasks/:id", (projectId, _actorId, request) =>
    options.runtime.buildTask(projectId, id(request)),
  );
  route("GET", "/api/v1/packaging/progress", (projectId) =>
    options.runtime.savedBuildProgress(projectId),
  );
  route("POST", "/api/v1/packaging/compatibility", (projectId, _actorId, request) =>
    options.runtime.startBuildCompatibility(projectId, key(request)),
  );
  route("GET", "/api/v1/packaging/compatibility", (projectId, _actorId, request) =>
    options.runtime.buildCompatibility(projectId, object(request.query)["id"]),
  );
  route("POST", "/api/v1/packaging/builds", (projectId, actorId, request) =>
    options.runtime.enqueueBuild(projectId, actorId, key(request), request.body),
  );
  for (const action of ["resume", "cancel"] as const)
    route("POST", `/api/v1/packaging/tasks/:id/${action}`, (projectId, actorId, request) =>
      options.runtime.buildAction(projectId, actorId, id(request), action),
    );
  route("GET", "/api/v1/increment-upload", (projectId, actorId) =>
    options.runtime.uploadSnapshot(projectId, actorId),
  );
  route("GET", "/api/v1/increment-upload/build-chains", (projectId, actorId) =>
    options.runtime.uploadChains(projectId, actorId),
  );
  route("POST", "/api/v1/increment-upload/jobs", (projectId, actorId, request) =>
    options.runtime.uploadOperation(projectId, actorId, "enqueue", request.body, key(request)),
  );
  route("POST", "/api/v1/increment-upload/build-chains", (projectId, actorId, request) =>
    options.runtime.uploadOperation(
      projectId,
      actorId,
      "build",
      object(request.body)["upload"],
      key(request),
    ),
  );
  for (const action of ["login", "logout", "check-auth"] as const)
    route("POST", `/api/v1/increment-upload/${action}`, (projectId, actorId, request) =>
      options.runtime.uploadOperation(projectId, actorId, action, request.body),
    );
  for (const [action, operation] of [
    ["resume", "resume"],
    ["resume-queued", "resume-queued"],
    ["confirm-publish", "confirm"],
    ["cancel", "cancel"],
  ])
    route("POST", `/api/v1/increment-upload/jobs/:id/${action}`, (projectId, actorId, request) =>
      options.runtime.uploadOperation(
        projectId,
        actorId,
        operation!,
        request.body,
        key(request),
        id(request),
      ),
    );
  route("GET", "/api/v1/increment-upload/jobs/:id/logs", (projectId, actorId, request) =>
    options.runtime.uploadOperation(projectId, actorId, "logs", undefined, undefined, id(request)),
  );
  route("POST", "/api/v1/increment-upload/build-chains/:id/cancel", (projectId, actorId, request) =>
    options.runtime.uploadOperation(
      projectId,
      actorId,
      "cancel-build",
      undefined,
      undefined,
      id(request),
    ),
  );
  route("POST", "/api/v1/increment-upload/build-chains/:id/resume", (projectId, actorId, request) =>
    options.runtime.uploadOperation(
      projectId,
      actorId,
      "resume-queued",
      undefined,
      undefined,
      id(request),
    ),
  );
  route("GET", "/api/v1/production/tasks/history", (projectId) =>
    options.runtime.productionHistory(projectId),
  );
  const externalId = (request: FastifyRequest) => {
    const value = string((request.params as Json)["id"], "id");
    if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(value))
      throw new ComponentRuntimeError("INVALID_REQUEST", "标识不正确", 400);
    return value;
  };
  for (const [path, operation] of [
    ["project", "project"],
    ["tasks", "tasks"],
    ["batches", "batches"],
  ])
    route("GET", `/api/v1/production/${path}`, (projectId, actorId) =>
      options.runtime.productionOperation(projectId, actorId, operation!),
    );
  for (const [path, operation] of [
    ["tasks", "task"],
    ["attachments", "attachment"],
    ["batches", "batch"],
  ])
    route("GET", `/api/v1/production/${path}/:id`, (projectId, actorId, request) =>
      options.runtime.productionOperation(
        projectId,
        actorId,
        operation!,
        undefined,
        externalId(request),
      ),
    );
  route("POST", "/api/v1/production/batches", (projectId, actorId, request) =>
    options.runtime.productionOperation(projectId, actorId, "submit", request.body),
  );
  route("POST", "/api/v1/production/uploads", (projectId, actorId, request) =>
    options.runtime.productionOperation(projectId, actorId, "upload", request.body),
  );
  route("POST", "/api/v1/production/batches/:id/retry", (projectId, actorId, request) =>
    options.runtime.productionOperation(
      projectId,
      actorId,
      "retry",
      undefined,
      externalId(request),
    ),
  );
  route("GET", "/api/v1/production/outbox", (projectId, actorId) =>
    options.runtime.relayQueue(projectId, actorId, "list"),
  );
  route("POST", "/api/v1/production/outbox/:id/resume", (projectId, actorId, request) =>
    options.runtime.relayQueue(projectId, actorId, "resume", externalId(request)),
  );
  route("GET", "/api/v1/qingyu/history", (projectId) => options.runtime.qingyuHistory(projectId));
  for (const [path, operation] of [
    ["session", "session"],
    ["login/status", "poll"],
    ["projects", "projects"],
    ["defects", "defects"],
  ])
    route("GET", `/api/v1/integrations/qingyu/${path}`, (projectId, actorId, request) =>
      options.runtime.qingyuOperation(projectId, actorId, operation!, request.query),
    );
  for (const [path, operation] of [
    ["login/start", "start"],
    ["logout", "logout"],
    ["import", "import"],
  ])
    route("POST", `/api/v1/integrations/qingyu/${path}`, (projectId, actorId, request) =>
      options.runtime.qingyuOperation(projectId, actorId, operation!, request.body),
    );
  route("GET", "/api/v1/bugs/:id/integrations/qingyu", (projectId, actorId, request) =>
    options.runtime.qingyuOperation(projectId, actorId, "link", undefined, id(request)),
  );
  route("POST", "/api/v1/bugs/:id/integrations/qingyu/resolve", (projectId, actorId, request) =>
    options.runtime.qingyuOperation(projectId, actorId, "resolve", request.body, id(request)),
  );
}
