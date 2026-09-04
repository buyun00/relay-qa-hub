import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { QaHubMcpError, type McpToolDefinition, type QaHubApiTransport } from "./mcp-api.js";

const string = { type: "string", minLength: 1 };
const id = { type: "string", pattern: "^[a-zA-Z0-9._:-]+$", maxLength: 100 };
const ids = { type: "array", items: id, maxItems: 8, uniqueItems: true };
const files = {
  type: "array",
  items: string,
  maxItems: 8,
  uniqueItems: true,
  description: "已获授权的本机附件绝对路径；每个最多 25 MB",
};
const execution = {
  type: "object",
  additionalProperties: false,
  properties: {
    codexModel: string,
    codexReasoningEffort: string,
    codexFastMode: { type: "boolean" },
    executionProfile: { enum: ["auto", "code_only", "unity_asset"] },
    priority: { type: "integer", minimum: -100, maximum: 100 },
    autoRelease: { type: "boolean" },
    extraPrompt: { type: "string", maxLength: 10000 },
  },
};
const tool = (
  name: string,
  title: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  write = false,
  destructive = false,
): McpToolDefinition => ({
  name,
  title,
  description,
  inputSchema: { type: "object", additionalProperties: false, properties, required },
  annotations: {
    readOnlyHint: !write,
    destructiveHint: destructive,
    idempotentHint: true,
    openWorldHint: write,
  },
});
export const PRODUCTION_MCP_TOOLS: readonly McpToolDefinition[] = [
  tool(
    "qa_list_relay_projects",
    "读取制作仓库",
    "读取 QA 项目映射的制作仓库、默认分支和支持的模型。仓库由服务端配置，不能传入任意仓库路径。",
    { projectId: id },
    ["projectId"],
  ),
  tool(
    "qa_list_relay_tasks",
    "列出制作任务",
    "读取当前项目的制作任务与进展；不包含工位或主机信息。关联 Bug 的四种状态仍由 QA Hub 管理。",
    {
      projectId: id,
      includeClosed: { type: "boolean" },
      q: { type: "string" },
      status: { type: "string" },
    },
    ["projectId"],
  ),
  tool(
    "qa_get_relay_task",
    "读取制作详情",
    "读取任务完整需求、历次修改、附件、分支、交付与验证记录。执行操作前读取 updatedAt，用于防止覆盖其他人的操作。",
    { projectId: id, taskId: id },
    ["projectId", "taskId"],
  ),
  tool(
    "qa_create_relay_task",
    "创建制作需求",
    "创建独立制作任务并开始执行。必须复用 requestId 核对超时请求；返回持久化批次，使用 qa_get_relay_batch 查看最终结果。",
    {
      projectId: id,
      requestId: id,
      title: { ...string, maxLength: 200 },
      message: { ...string, maxLength: 20000 },
      execution,
      uploadIds: ids,
      filePaths: files,
    },
    ["projectId", "requestId", "title", "message"],
    true,
  ),
  tool(
    "qa_start_relay_batch",
    "批量启动 Bug 制作",
    "一次启动 1 至 50 张已有 QA Bug（例如 8 张）。每张单独排队，自动携带完整 Bug 内容和附件；已有制作任务会复用。不会将提交成功当成修复或验收完成。重试同一请求必须复用 requestId。",
    {
      projectId: id,
      requestId: id,
      bugs: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            bugId: id,
            selectedAttachmentIds: ids,
            extraPrompt: { type: "string", maxLength: 10000 },
          },
          required: ["bugId"],
        },
      },
      execution,
    },
    ["projectId", "requestId", "bugs"],
    true,
  ),
  tool(
    "qa_continue_relay_task",
    "继续原制作任务",
    "沿用原任务、分支和对话追加修改。先读取任务的 updatedAt。关联 QA Bug 的新附件先添加到 Bug，使用 selectedAttachmentIds 选择；独立任务可使用 filePaths。",
    {
      projectId: id,
      requestId: id,
      taskId: id,
      expectedUpdatedAt: string,
      message: { ...string, maxLength: 20000 },
      selectedAttachmentIds: ids,
      uploadIds: ids,
      filePaths: files,
    },
    ["projectId", "requestId", "taskId", "expectedUpdatedAt", "message"],
    true,
  ),
  tool(
    "qa_relay_task_action",
    "管理制作任务",
    "停止、重试、重新打开、结束制作或合并完成。finish 只结束制作；merge 会合并仓库 MR 并处理 Relay 关联轻语单，必须有用户明确授权且 confirmMerge=true。QA Hub 人工验收需走既有流程。",
    {
      projectId: id,
      requestId: id,
      action: { enum: ["cancel", "retry", "reopen", "finish", "merge"] },
      targets: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { taskId: id, expectedUpdatedAt: string },
          required: ["taskId", "expectedUpdatedAt"],
        },
      },
      confirmMerge: { type: "boolean" },
    },
    ["projectId", "requestId", "action", "targets"],
    true,
    true,
  ),
  tool(
    "qa_get_relay_batch",
    "读取制作批次",
    "查询批次每张单的独立结果；省略 batchId 时列出当前登录用户最近批次。accepted 表示已提交，不代表修复完成。",
    { projectId: id, batchId: id },
    ["projectId"],
  ),
  tool(
    "qa_retry_relay_batch",
    "重试失败提交",
    "仅重试指定批次中的失败项，保留已经成功的结果和幂等请求。版本冲突等需先读取任务并重新提交新操作。",
    { projectId: id, batchId: id },
    ["projectId", "batchId"],
    true,
  ),
  tool(
    "qa_materialize_relay_attachment",
    "读取制作附件",
    "下载任务附件至当前 EXE 的 MCP 缓存并返回本机路径。",
    { projectId: id, attachmentId: id },
    ["projectId", "attachmentId"],
  ),
];
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new QaHubMcpError("INVALID_ARGUMENTS", "Arguments must be an object");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim())
    throw new QaHubMcpError("INVALID_ARGUMENTS", "A nonempty string is required");
  return value;
};
function contentType(filename: string): string {
  const type: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".json": "application/json",
    ".zip": "application/zip",
  };
  const selected = type[path.extname(filename).toLowerCase()];
  if (!selected)
    throw new QaHubMcpError(
      "INVALID_ATTACHMENT",
      "Supported attachments: PNG, JPEG, WebP, text, JSON, ZIP",
    );
  return selected;
}
export async function callProductionTool(
  name: string,
  inputValue: unknown,
  api: QaHubApiTransport,
  cacheDirectory: string,
): Promise<unknown> {
  const input = obj(inputValue),
    projectId = text(input["projectId"]);
  const definition = PRODUCTION_MCP_TOOLS.find((tool) => tool.name === name);
  if (!definition) throw new QaHubMcpError("TOOL_NOT_FOUND", name);
  const properties = obj(definition.inputSchema["properties"]);
  if (Object.keys(input).some((key) => !Object.hasOwn(properties, key)))
    throw new QaHubMcpError("INVALID_ARGUMENTS", "Unexpected argument");
  const query = new URLSearchParams({ projectId }).toString();
  const base = "/api/v1/production";
  const uploadFiles = async (): Promise<string[]> => {
    const selected = input["uploadIds"] ?? [],
      paths = input["filePaths"] ?? [];
    if (!Array.isArray(selected) || !Array.isArray(paths) || selected.length + paths.length > 8)
      throw new QaHubMcpError("INVALID_ATTACHMENTS", "At most 8 attachments per task");
    const uploaded = selected.map(text);
    let total = 0;
    for (const value of paths) {
      const filepath = text(value);
      if (!path.isAbsolute(filepath))
        throw new QaHubMcpError("INVALID_ATTACHMENT", "Attachment path must be absolute");
      const metadata = await fs.stat(filepath);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > 25 * 1024 * 1024)
        throw new QaHubMcpError(
          "INVALID_ATTACHMENT",
          "Attachment must be a regular file up to 25 MB",
        );
      total += metadata.size;
      if (total > 100 * 1024 * 1024)
        throw new QaHubMcpError("INVALID_ATTACHMENTS", "Attachments exceed 100 MB");
      const filename = path.basename(filepath),
        mediaType = contentType(filename),
        bytes = await fs.readFile(filepath);
      const result = obj(
        await api.json(`${base}/uploads`, {
          method: "POST",
          body: {
            projectId,
            filename,
            mediaType,
            contentBase64: bytes.toString("base64"),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        }),
      );
      uploaded.push(text(result["id"]));
    }
    return uploaded;
  };
  if (name === "qa_list_relay_projects") return api.json(`${base}/project?${query}`);
  if (name === "qa_get_relay_task")
    return api.json(`${base}/tasks/${encodeURIComponent(text(input["taskId"]))}?${query}`);
  if (name === "qa_get_relay_batch")
    return api.json(
      `${base}/batches${input["batchId"] ? `/${encodeURIComponent(text(input["batchId"]))}` : ""}?${query}`,
    );
  if (name === "qa_retry_relay_batch")
    return api.json(`${base}/batches/${encodeURIComponent(text(input["batchId"]))}/retry`, {
      method: "POST",
      body: { projectId },
    });
  if (name === "qa_list_relay_tasks") {
    const result = obj(await api.json(`${base}/tasks?${query}`));
    const tasks = result["items"];
    if (!Array.isArray(tasks)) throw new QaHubMcpError("INVALID_RESPONSE", "Task list is invalid");
    return {
      items: tasks
        .map(obj)
        .filter(
          (task) =>
            (input["includeClosed"] === true || task["status"] !== "closed") &&
            (!input["status"] || input["status"] === task["status"]) &&
            (!input["q"] ||
              `${task["number"]} ${task["title"]}`
                .toLowerCase()
                .includes(String(input["q"]).toLowerCase())),
        ),
    };
  }
  if (name === "qa_materialize_relay_attachment") {
    const attachment = obj(
      await api.json(
        `${base}/attachments/${encodeURIComponent(text(input["attachmentId"]))}?${query}`,
      ),
    );
    const bytes = Buffer.from(text(attachment["contentBase64"]), "base64"),
      filename = path.basename(text(attachment["filename"]));
    if (bytes.length !== attachment["size"] || bytes.length > 25 * 1024 * 1024)
      throw new QaHubMcpError("INVALID_ATTACHMENT", "Attachment size mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (attachment["sha256"] && digest !== attachment["sha256"])
      throw new QaHubMcpError("INVALID_ATTACHMENT", "Attachment hash mismatch");
    const directory = path.join(cacheDirectory, "production", digest);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(
      directory,
      filename.replace(/[<>:"/\\|?*\x00-\x1f]/gu, "_") || "attachment",
    );
    await fs.writeFile(file, bytes);
    return { path: file, filename, size: bytes.length, sha256: digest };
  }
  const requestId = text(input["requestId"]);
  let kind: string, items: unknown[];
  if (name === "qa_create_relay_task") {
    kind = "create";
    items = [
      {
        title: text(input["title"]),
        message: text(input["message"]),
        uploadIds: await uploadFiles(),
      },
    ];
  } else if (name === "qa_start_relay_batch") {
    kind = "bugs";
    if (!Array.isArray(input["bugs"]))
      throw new QaHubMcpError("INVALID_ARGUMENTS", "bugs must be an array");
    items = input["bugs"];
  } else if (name === "qa_continue_relay_task") {
    kind = "action";
    items = [
      {
        taskId: text(input["taskId"]),
        expectedUpdatedAt: text(input["expectedUpdatedAt"]),
        action: "continue",
        message: text(input["message"]),
        selectedAttachmentIds: input["selectedAttachmentIds"] ?? [],
        uploadIds: await uploadFiles(),
      },
    ];
  } else {
    kind = "action";
    if (!Array.isArray(input["targets"]))
      throw new QaHubMcpError("INVALID_ARGUMENTS", "targets must be an array");
    items = input["targets"].map((value) => ({
      ...obj(value),
      action: text(input["action"]),
      confirmMerge: input["confirmMerge"] === true,
    }));
  }
  return api.json(`${base}/batches`, {
    method: "POST",
    body: {
      projectId,
      requestId,
      kind,
      items,
      ...(input["execution"] ? { execution: input["execution"] } : {}),
    },
  });
}
