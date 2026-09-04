import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MobileBugStore } from "./mobile-bugs.js";
import type { MobileRelayStore } from "./mobile-relay.js";
import type { MobileAttachmentStore } from "./mobile-attachments.js";
import type { MobileProjectDirectoryStore } from "./mobile-project-directory.js";

type RecordValue = Record<string, unknown>;
export class ProductionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string, status = 400): never => {
  throw new ProductionError(code, message, status);
};
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID_REQUEST", "请求格式不正确");
  return value as RecordValue;
};
const str = (value: unknown, max = 200): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return fail("INVALID_REQUEST", "必填内容为空或过长");
  return value.trim();
};
const identifier = (value: unknown): string => {
  const text = str(value, 100);
  if (!/^[a-zA-Z0-9._:-]+$/u.test(text)) return fail("INVALID_REQUEST", "标识不正确");
  return text;
};
const ids = (value: unknown, max = 8): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max)
    return fail("INVALID_REQUEST", `最多选择 ${max} 项`);
  const result = value.map(identifier);
  if (new Set(result).size !== result.length) return fail("INVALID_REQUEST", "不能重复选择");
  return result;
};
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const hash = (v: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const now = (): string => new Date().toISOString();
const MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "application/json",
  "application/zip",
]);
const BASE = "/api/v1/production";

export interface ProductionConfig {
  endpoint: string;
  bearerToken: string;
  qaInstanceId: string;
  stateRoot: string;
}
interface TaskItem extends RecordValue {
  id: string;
  updatedAt: string;
  bugId: string | null;
  attemptId: string | null;
  handoffId: string | null;
  status: string;
}
interface ProductionProject {
  project: RecordValue;
  models: Record<string, string[]>;
}
interface Step {
  input: unknown;
  result?: unknown;
}
interface BatchItem {
  input: RecordValue;
  status: "queued" | "running" | "accepted" | "existing" | "failed";
  steps: Record<string, Step>;
  result?: RecordValue;
  error?: { code: string; message: string };
}
interface Batch {
  id: string;
  actorId: string;
  projectId: string;
  requestHash: string;
  kind: "create" | "bugs" | "action";
  execution: RecordValue;
  items: BatchItem[];
  createdAt: string;
  updatedAt: string;
}
interface Upload {
  id: string;
  actorId: string;
  projectId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
}

/** Durable, per-item jobs. Steps are saved before issuing an idempotent mutation. */
export class ProductionTasks {
  private readonly batches = new Map<string, Batch>();
  private readonly running = new Map<string, Promise<void>>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private stopped = false;
  constructor(
    readonly config: ProductionConfig,
    private readonly stores: {
      bugs: MobileBugStore;
      relay: MobileRelayStore;
      attachments: MobileAttachmentStore;
      projects: MobileProjectDirectoryStore;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.ready = this.load();
    void this.ready
      .then(() => {
        for (const job of this.batches.values()) this.start(job);
      })
      .catch(() => undefined);
  }
  private async load(): Promise<void> {
    await fs.mkdir(join(this.config.stateRoot, "batches"), { recursive: true });
    await fs.mkdir(join(this.config.stateRoot, "uploads"), { recursive: true });
    for (const file of await fs.readdir(join(this.config.stateRoot, "batches"))) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      const batch = JSON.parse(
        await fs.readFile(join(this.config.stateRoot, "batches", file), "utf8"),
      ) as Batch;
      this.batches.set(batch.id, batch);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.running.values());
  }
  private async save(batch: Batch): Promise<void> {
    batch.updatedAt = now();
    const path = join(this.config.stateRoot, "batches", `${batch.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(batch), { flag: "wx" });
    await fs.rename(temporary, path);
  }
  private async scope(actorId: string, projectId: string, write = false, merge = false) {
    const project = (await this.stores.projects.listProjects({ actorId, limit: 100 })).items.find(
      (p) => p.id === projectId,
    );
    if (!project) return fail("PROJECT_FORBIDDEN", "无权访问此项目", 403);
    const roles = merge
      ? ["developer", "release_manager", "project_admin"]
      : ["reporter", "developer", "triager", "project_admin", "release_manager"];
    if (write && !project.roles.some((role) => roles.includes(role)))
      return fail("PROJECT_FORBIDDEN", "当前身份无权执行此操作", 403);
    const members = await this.stores.projects.listMembers({ actorId, projectId, limit: 100 });
    const actor = members.items.find((member) => member.userId === actorId);
    if (!actor) return fail("PROJECT_FORBIDDEN", "当前身份未加入此项目", 403);
    return { key: project.key, actorName: actor.displayName };
  }
  private async relay<T>(path: string, projectKey: string, body?: RecordValue): Promise<T> {
    const url = new URL(`/api/integrations/qa/v1/workbench${path}`, this.config.endpoint);
    const context = { qaInstanceId: this.config.qaInstanceId, projectKey };
    if (!body) for (const [key, value] of Object.entries(context)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.config.bearerToken}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify({ ...context, ...body }) } : {}),
        signal: AbortSignal.timeout(body ? 60_000 : 20_000),
      });
    } catch {
      return fail("RELAY_UNAVAILABLE", "制作服务暂时未响应；可用同一批次重试核对结果", 503);
    }
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = record(value);
      return fail(
        typeof error["code"] === "string" ? error["code"] : "RELAY_UNAVAILABLE",
        typeof error["message"] === "string" ? error["message"] : "制作服务暂不可用",
        response.status,
      );
    }
    return value as T;
  }
  async project(actorId: string, projectId: string): Promise<ProductionProject> {
    const scope = await this.scope(actorId, projectId);
    return this.relay("/project", scope.key);
  }
  async tasks(actorId: string, projectId: string): Promise<{ items: TaskItem[] }> {
    const scope = await this.scope(actorId, projectId);
    return this.relay("/tasks", scope.key);
  }
  async task(actorId: string, projectId: string, taskId: string): Promise<unknown> {
    const scope = await this.scope(actorId, projectId);
    return this.relay(`/tasks/${identifier(taskId)}`, scope.key);
  }
  async attachment(actorId: string, projectId: string, attachmentId: string): Promise<RecordValue> {
    const scope = await this.scope(actorId, projectId);
    return this.relay(`/attachments/${identifier(attachmentId)}`, scope.key);
  }
  async upload(actorId: string, input: unknown): Promise<Upload> {
    await this.ready;
    const body = record(input),
      projectId = identifier(body["projectId"]);
    await this.scope(actorId, projectId, true);
    const filename = str(body["filename"], 240),
      mediaType = str(body["mediaType"], 100);
    if (/[\\/\x00-\x1f]/u.test(filename) || !MEDIA.has(mediaType))
      return fail("INVALID_ATTACHMENT", "附件名称或类型不支持");
    if (
      typeof body["contentBase64"] !== "string" ||
      body["contentBase64"].length > 35_000_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(body["contentBase64"])
    )
      return fail("INVALID_ATTACHMENT", "附件内容不正确");
    const bytes = Buffer.from(body["contentBase64"], "base64");
    if (
      !bytes.length ||
      bytes.length > 25 * 1024 * 1024 ||
      bytes.toString("base64") !== body["contentBase64"]
    )
      return fail("INVALID_ATTACHMENT", "每个附件需在 1 字节至 25 MB 之间");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== body["sha256"]) return fail("ATTACHMENT_HASH_MISMATCH", "附件校验失败");
    const upload: Upload = {
      id: hash([actorId, projectId, filename, mediaType, sha256]),
      actorId,
      projectId,
      filename,
      mediaType,
      size: bytes.length,
      sha256,
      createdAt: now(),
    };
    for (const [extension, contents] of [
      ["bin", bytes],
      ["json", JSON.stringify(upload)],
    ] as const) {
      try {
        await fs.writeFile(
          join(this.config.stateRoot, "uploads", `${upload.id}.${extension}`),
          contents,
          { flag: "wx" },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return upload;
  }
  private async uploaded(
    actorId: string,
    projectId: string,
    uploadIds: string[],
  ): Promise<RecordValue[]> {
    return Promise.all(
      uploadIds.map(async (id) => {
        let upload: Upload;
        try {
          upload = JSON.parse(
            await fs.readFile(
              join(this.config.stateRoot, "uploads", `${identifier(id)}.json`),
              "utf8",
            ),
          ) as Upload;
        } catch {
          return fail("ATTACHMENT_NOT_FOUND", "上传的附件不存在", 404);
        }
        if (upload.actorId !== actorId || upload.projectId !== projectId)
          return fail("ATTACHMENT_FORBIDDEN", "无权使用该附件", 403);
        const bytes = await fs.readFile(join(this.config.stateRoot, "uploads", `${id}.bin`));
        if (
          bytes.length !== upload.size ||
          createHash("sha256").update(bytes).digest("hex") !== upload.sha256
        )
          return fail("ATTACHMENT_HASH_MISMATCH", "附件校验失败");
        return {
          attachmentId: id,
          filename: upload.filename,
          mediaType: upload.mediaType,
          size: upload.size,
          sha256: upload.sha256,
          contentBase64: bytes.toString("base64"),
        };
      }),
    );
  }
  private normalize(input: unknown): {
    projectId: string;
    requestId: string;
    kind: Batch["kind"];
    execution: RecordValue;
    items: RecordValue[];
  } {
    const body = record(input),
      projectId = identifier(body["projectId"]),
      requestId = identifier(body["requestId"]);
    if (
      Object.keys(body).some(
        (key) => !["projectId", "requestId", "kind", "execution", "items"].includes(key),
      )
    )
      return fail("INVALID_REQUEST", "请求包含不支持的字段");
    if (!["create", "bugs", "action"].includes(String(body["kind"])))
      return fail("INVALID_REQUEST", "批次类型不正确");
    const kind = body["kind"] as Batch["kind"];
    if (
      !Array.isArray(body["items"]) ||
      body["items"].length < 1 ||
      body["items"].length > 50 ||
      (kind === "create" && body["items"].length > 1)
    )
      return fail("INVALID_REQUEST", "批次需包含 1 至 50 张单");
    const items: RecordValue[] = body["items"].map((raw): RecordValue => {
      const item = record(raw);
      const allowed =
        kind === "create"
          ? ["title", "message", "uploadIds"]
          : kind === "bugs"
            ? ["bugId", "selectedAttachmentIds", "extraPrompt"]
            : [
                "taskId",
                "expectedUpdatedAt",
                "action",
                "confirmMerge",
                "message",
                "uploadIds",
                "selectedAttachmentIds",
              ];
      if (Object.keys(item).some((key) => !allowed.includes(key)))
        return fail("INVALID_REQUEST", "单子包含不支持的字段");
      if (
        item["extraPrompt"] !== undefined &&
        (typeof item["extraPrompt"] !== "string" || item["extraPrompt"].length > 20000)
      )
        return fail("INVALID_REQUEST", "补充说明最多 20000 字符");
      if (kind === "create")
        return {
          title: str(item["title"], 200),
          message: str(item["message"], 20000),
          uploadIds: ids(item["uploadIds"]),
        };
      if (kind === "bugs")
        return {
          bugId: identifier(item["bugId"]),
          selectedAttachmentIds:
            item["selectedAttachmentIds"] === undefined ? null : ids(item["selectedAttachmentIds"]),
          extraPrompt: typeof item["extraPrompt"] === "string" ? item["extraPrompt"] : "",
        };
      const action = str(item["action"]);
      if (!["continue", "cancel", "retry", "reopen", "finish", "merge"].includes(action))
        return fail("INVALID_REQUEST", "操作不正确");
      if (action === "merge" && item["confirmMerge"] !== true)
        return fail("MERGE_CONFIRMATION_REQUIRED", "请明确确认合并仓库并处理关联缺陷");
      return {
        taskId: identifier(item["taskId"]),
        expectedUpdatedAt: str(item["expectedUpdatedAt"], 40),
        action,
        confirmMerge: item["confirmMerge"] === true,
        ...(action === "continue"
          ? {
              message: str(item["message"], 20000),
              uploadIds: ids(item["uploadIds"]),
              selectedAttachmentIds: ids(item["selectedAttachmentIds"]),
            }
          : {}),
      };
    });
    const targets = items.map((item) => item["bugId"] ?? item["taskId"]);
    if (kind !== "create" && new Set(targets).size !== targets.length)
      return fail("INVALID_REQUEST", "同一批次不能重复选择单子");
    return {
      projectId,
      requestId,
      kind,
      execution: body["execution"] === undefined ? {} : record(body["execution"]),
      items,
    };
  }
  async submit(actorId: string, input: unknown): Promise<unknown> {
    await this.ready;
    const normalized = this.normalize(input);
    await this.scope(
      actorId,
      normalized.projectId,
      true,
      normalized.items.some((i) => i["action"] === "merge"),
    );
    // Serialize creation only; executing a long operation never holds the submission queue.
    const operation = this.writes.then(async () => {
      const id = hash([actorId, normalized.projectId, normalized.requestId]),
        requestHash = hash(normalized);
      const previous = this.batches.get(id);
      if (previous) {
        if (previous.requestHash !== requestHash)
          return fail("IDEMPOTENCY_PAYLOAD_MISMATCH", "此请求标识已用于其他内容", 409);
        this.start(previous);
        return this.view(previous);
      }
      const batch: Batch = {
        id,
        actorId,
        projectId: normalized.projectId,
        requestHash,
        kind: normalized.kind,
        execution: normalized.execution,
        items: normalized.items.map((item) => ({ input: item, status: "queued", steps: {} })),
        createdAt: now(),
        updatedAt: now(),
      };
      await this.save(batch);
      this.batches.set(id, batch);
      this.start(batch);
      return this.view(batch);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  private view(batch: Batch) {
    const pending = batch.items.some((i) => i.status === "queued" || i.status === "running");
    return {
      id: batch.id,
      projectId: batch.projectId,
      kind: batch.kind,
      status: pending
        ? "running"
        : batch.items.some((i) => i.status === "failed")
          ? "partial_failure"
          : "completed",
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      items: batch.items.map((item) => ({
        input: item.input,
        status: item.status,
        ...(item.result ? { result: item.result } : {}),
        ...(item.error ? { error: item.error } : {}),
      })),
    };
  }
  private async readView(batch: Batch): Promise<unknown> {
    const view = this.view(batch);
    return {
      ...view,
      items: await Promise.all(
        view.items.map(async (item) => {
          const attemptId = item.result?.["repairAttemptId"];
          if (typeof attemptId !== "string") return item;
          try {
            const receipt = await this.stores.relay.getRelayReceipt({
              actorId: batch.actorId,
              attemptId,
            });
            if (!receipt) return item;
            return {
              ...item,
              result: {
                ...item.result,
                ...(receipt.relayTaskId ? { taskId: receipt.relayTaskId } : {}),
              },
              delivery: { status: receipt.handoffStatus, failureSummary: receipt.failureSummary },
            };
          } catch {
            return { ...item, delivery: { status: "unknown", failureSummary: "回执暂时无法读取" } };
          }
        }),
      ),
    };
  }
  async listBatches(actorId: string, projectId: string): Promise<unknown> {
    await this.ready;
    await this.scope(actorId, projectId);
    return {
      items: await Promise.all(
        [...this.batches.values()]
          .filter((b) => b.actorId === actorId && b.projectId === projectId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 8)
          .map((b) => this.readView(b)),
      ),
    };
  }
  async batch(actorId: string, projectId: string, id: string, retry = false): Promise<unknown> {
    await this.ready;
    await this.scope(actorId, projectId, retry);
    const batch = this.batches.get(identifier(id));
    if (!batch || batch.actorId !== actorId || batch.projectId !== projectId)
      return fail("BATCH_NOT_FOUND", "批次不存在", 404);
    if (retry && !this.running.has(batch.id)) {
      for (const item of batch.items)
        if (item.status === "failed") {
          item.status = "queued";
          delete item.error;
        }
      await this.save(batch);
      this.start(batch);
    }
    return this.readView(batch);
  }
  private start(batch: Batch): void {
    if (
      this.stopped ||
      this.running.has(batch.id) ||
      !batch.items.some((i) => i.status === "queued" || i.status === "running")
    )
      return;
    const running = this.run(batch).finally(() => {
      this.running.delete(batch.id);
    });
    this.running.set(batch.id, running);
    void running.catch(() => undefined); // Durable unfinished steps are resumed on service restart.
  }
  private async step<T>(
    batch: Batch,
    item: BatchItem,
    name: string,
    buildInput: () => Promise<unknown>,
    operation: (input: unknown, key: string) => Promise<T>,
  ): Promise<T> {
    let step = item.steps[name];
    if (!step) {
      step = { input: await buildInput() };
      item.steps[name] = step;
      await this.save(batch);
    }
    if (Object.hasOwn(step, "result")) return step.result as T;
    const key = `prod-${batch.id.slice(0, 32)}-${batch.items.indexOf(item)}-${name}`;
    step.result = await operation(step.input, key);
    await this.save(batch);
    return step.result as T;
  }
  private async run(batch: Batch): Promise<void> {
    for (const item of batch.items) {
      if (this.stopped) return;
      if (item.status !== "queued" && item.status !== "running") continue;
      item.status = "running";
      await this.save(batch);
      try {
        const scope = await this.scope(
          batch.actorId,
          batch.projectId,
          true,
          item.input["action"] === "merge",
        );
        const project = await this.relay<ProductionProject>("/project", scope.key);
        const execution = normalizeExecution(batch.execution, project.models);
        if (batch.kind === "bugs") await this.startBug(batch, item, scope.key, execution);
        else {
          const result = await this.step<RecordValue>(
            batch,
            item,
            "relay",
            async () => {
              if (batch.kind === "action") {
                const current = await this.relay<{ task: TaskItem }>(
                  `/tasks/${String(item.input["taskId"])}`,
                  scope.key,
                );
                if (current.task.updatedAt !== item.input["expectedUpdatedAt"])
                  return fail("TASK_CHANGED", "任务已更新，请刷新后操作", 409);
                if (current.task.bugId && item.input["action"] === "continue")
                  return {
                    linked: current.task,
                    message: item.input["message"],
                    selectedAttachmentIds: item.input["selectedAttachmentIds"],
                  };
              }
              return { ...item.input, execution, actorName: scope.actorName };
            },
            async (saved, key) => {
              const value = record(saved);
              if (value["linked"]) {
                if (ids(item.input["uploadIds"]).length)
                  return fail(
                    "LINKED_ATTACHMENT_REQUIRED",
                    "请先将新附件添加到关联 Bug，再选择附件续改",
                  );
                const task = value["linked"] as TaskItem;
                if (!task.attemptId || !task.handoffId)
                  return fail("HANDOFF_NOT_FOUND", "关联任务缺少移交记录");
                const result = await this.stores.relay.continueRelay({
                  actorId: batch.actorId,
                  attemptId: task.attemptId,
                  idempotencyKey: key,
                  request: {
                    handoffId: task.handoffId,
                    actionId: key,
                    prompt: String(value["message"]),
                    selectedAttachmentIds: ids(value["selectedAttachmentIds"]),
                  },
                });
                return {
                  taskId: task.id,
                  repairAttemptId: task.attemptId,
                  handoffId: task.handoffId,
                  status: result.status,
                };
              }
              const selectedAttachments = await this.uploaded(
                batch.actorId,
                batch.projectId,
                ids(value["uploadIds"]),
              );
              if (
                selectedAttachments.reduce((sum, file) => sum + Number(file["size"]), 0) >
                100 * 1024 * 1024
              )
                return fail("ATTACHMENTS_TOO_LARGE", "单张任务的附件总计不能超过 100 MB");
              const taskId = value["taskId"],
                command = { ...value };
              delete command["uploadIds"];
              delete command["taskId"];
              delete command["selectedAttachmentIds"];
              return this.relay<RecordValue>(
                batch.kind === "create" ? "/tasks" : `/tasks/${String(taskId)}`,
                scope.key,
                {
                  ...command,
                  selectedAttachments,
                  requestId: key,
                  actorId: batch.actorId,
                  actorName: value["actorName"] ?? scope.actorName,
                },
              );
            },
          );
          item.result = result;
          item.status = "accepted";
        }
      } catch (error) {
        const value = error as { code?: string; message?: string };
        item.status = "failed";
        item.error = {
          code: value.code ?? "PRODUCTION_FAILED",
          message: value.message ?? "提交失败，请刷新后重试",
        };
      }
      await this.save(batch);
    }
  }
  private async startBug(
    batch: Batch,
    item: BatchItem,
    projectKey: string,
    execution: RecordValue,
  ): Promise<void> {
    const actorId = batch.actorId,
      bugId = String(item.input["bugId"]);
    const extraPrompt = [execution["extraPrompt"], item.input["extraPrompt"]]
      .filter(Boolean)
      .join("\n\n");
    if (extraPrompt.length > 20000)
      return fail("INVALID_EXECUTION_OPTIONS", "统一与单张补充说明合计最多 20000 字符");
    const bug = await this.stores.bugs.getBug({ actorId, bugId });
    if (!bug || bug.projectId !== batch.projectId)
      return fail("BUG_NOT_FOUND", "Bug 不存在于当前项目", 404);
    if (!item.steps["dispatch"]) {
      const existing = (await this.relay<{ items: TaskItem[] }>("/tasks", projectKey)).items.find(
        (t) => t.bugId === bugId,
      );
      if (existing) {
        item.status = "existing";
        item.result = { taskId: existing.id, bugId, message: "已有制作任务；请在详情中继续修改" };
        return;
      }
      if (!["reported", "needs_info", "ready"].includes(bug.state) && !item.steps["attempt"])
        return fail("BUG_NOT_READY", "请在关联任务中继续处理；不会新建重复任务", 409);
    }
    const selected = await this.step<string[]>(
      batch,
      item,
      "attachments",
      async () => {
        const available = await this.stores.attachments.listBugAttachments({
          actorId,
          bugId,
          limit: 100,
        });
        const chosen =
          item.input["selectedAttachmentIds"] === null
            ? (available?.items ?? []).map((file) => file.attachmentId)
            : ids(item.input["selectedAttachmentIds"]);
        if (
          chosen.length > 8 ||
          chosen.some((id) => !available?.items.some((file) => file.attachmentId === id))
        )
          return fail("INVALID_ATTACHMENTS", "请选择当前 Bug 的附件，每次最多 8 个");
        return chosen;
      },
      async (input) => input as string[],
    );
    if (!bug.ownerId || item.steps["owner"])
      await this.step(
        batch,
        item,
        "owner",
        async () => ({
          expectedVersion: (await this.stores.bugs.getBug({ actorId, bugId }))!.version,
          ownerId: actorId,
        }),
        async (input, key) =>
          this.stores.bugs.updateBug({
            actorId,
            bugId,
            idempotencyKey: key,
            request: input as { expectedVersion: number; ownerId: string },
          }),
      );
    if (bug.state !== "ready" && !item.steps["attempt"])
      await this.step(
        batch,
        item,
        "ready",
        async () => ({
          expectedVersion: (await this.stores.bugs.getBug({ actorId, bugId }))!.version,
          toState: "ready" as const,
        }),
        async (input, key) =>
          this.stores.relay.transitionBugReady({
            actorId,
            bugId,
            idempotencyKey: key,
            request: input as { expectedVersion: number; toState: "ready" },
          }),
      );
    const attempt = await this.step<{ id: string; version: number }>(
      batch,
      item,
      "attempt",
      async () => {
        const current = (await this.stores.bugs.getBug({ actorId, bugId }))!;
        return {
          expectedVersion: current.version,
          mode: "relay",
          assigneeId: current.ownerId ?? actorId,
        };
      },
      async (input, key) =>
        this.stores.relay.createRelayAttempt({
          actorId,
          bugId,
          idempotencyKey: key,
          request: input as { expectedVersion: number; mode: "relay"; assigneeId: string },
        }),
    );
    const dispatched = await this.step(
      batch,
      item,
      "dispatch",
      async () => ({
        expectedVersion: attempt.version,
        handoffId: randomUUID(),
        selectedAttachmentIds: selected,
        execution: {
          ...execution,
          extraPrompt,
        },
      }),
      async (input, key) =>
        this.stores.relay.dispatchRelay({
          actorId,
          attemptId: attempt.id,
          idempotencyKey: key,
          request: input as {
            expectedVersion: number;
            handoffId: string;
            selectedAttachmentIds: string[];
            execution: RecordValue;
          },
        }),
    );
    item.result = { bugId, ...dispatched };
    item.status = "accepted";
  }
}

export function normalizeExecution(
  value: RecordValue,
  models: Record<string, string[]>,
): RecordValue {
  const allowed = new Set([
    "codexModel",
    "codexReasoningEffort",
    "codexFastMode",
    "priority",
    "autoRelease",
    "executionProfile",
    "extraPrompt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    return fail("INVALID_EXECUTION_OPTIONS", "执行参数不正确");
  const model = value["codexModel"] ?? "gpt-5.6-sol",
    effort = value["codexReasoningEffort"] ?? "xhigh";
  const priority = value["priority"] ?? 0,
    profile = value["executionProfile"] ?? "auto",
    fast = value["codexFastMode"] ?? false,
    release = value["autoRelease"] ?? true,
    extra = value["extraPrompt"] ?? "";
  if (
    typeof model !== "string" ||
    !models[model]?.includes(String(effort)) ||
    typeof fast !== "boolean" ||
    typeof release !== "boolean" ||
    !Number.isInteger(priority) ||
    Number(priority) < -100 ||
    Number(priority) > 100 ||
    !["auto", "code_only", "unity_asset"].includes(String(profile)) ||
    typeof extra !== "string" ||
    extra.length > 20000
  )
    return fail("INVALID_EXECUTION_OPTIONS", "模型、强度或执行参数不正确");
  return {
    codexModel: model,
    codexReasoningEffort: effort,
    codexFastMode: fast,
    executionProfile: profile,
    priority,
    autoRelease: release,
    extraPrompt: extra,
  };
}

export function registerProductionRoutes(
  app: FastifyInstance,
  service: ProductionTasks | undefined,
  actor: (request: FastifyRequest) => string | null,
): void {
  const respond = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (service: ProductionTasks, actorId: string) => Promise<unknown>,
  ) => {
    const actorId = actor(request);
    if (!actorId) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    if (!service)
      return reply.code(503).send({ code: "PRODUCTION_UNCONFIGURED", message: "尚未配置制作服务" });
    try {
      return reply.header("cache-control", "no-store").send(await operation(service, actorId));
    } catch (error) {
      return reply.code(error instanceof ProductionError ? error.status : 503).send({
        code: error instanceof ProductionError ? error.code : "PRODUCTION_UNAVAILABLE",
        message: error instanceof ProductionError ? error.message : "制作服务暂不可用",
      });
    }
  };
  const project = (request: FastifyRequest) => identifier(record(request.query)["projectId"]);
  const param = (request: FastifyRequest, key: string) => identifier(record(request.params)[key]);
  app.get(`${BASE}/project`, (req, reply) =>
    respond(req, reply, (s, a) => s.project(a, project(req))),
  );
  app.get(`${BASE}/tasks`, (req, reply) => respond(req, reply, (s, a) => s.tasks(a, project(req))));
  app.get(`${BASE}/tasks/:id`, (req, reply) =>
    respond(req, reply, (s, a) => s.task(a, project(req), param(req, "id"))),
  );
  app.get(`${BASE}/attachments/:id`, (req, reply) =>
    respond(req, reply, (s, a) => s.attachment(a, project(req), param(req, "id"))),
  );
  app.get(`${BASE}/batches`, (req, reply) =>
    respond(req, reply, (s, a) => s.listBatches(a, project(req))),
  );
  app.get(`${BASE}/batches/:id`, (req, reply) =>
    respond(req, reply, (s, a) => s.batch(a, project(req), param(req, "id"))),
  );
  app.post(`${BASE}/batches/:id/retry`, (req, reply) =>
    respond(req, reply, (s, a) =>
      s.batch(a, identifier(record(req.body)["projectId"]), param(req, "id"), true),
    ),
  );
  app.post(`${BASE}/batches`, (req, reply) => {
    reply.code(202);
    return respond(req, reply, (s, a) => s.submit(a, req.body));
  });
  app.post(`${BASE}/uploads`, { bodyLimit: 36 * 1024 * 1024 }, (req, reply) =>
    respond(req, reply, (s, a) => s.upload(a, req.body)),
  );
  if (service) app.addHook("onClose", () => service.close());
}
