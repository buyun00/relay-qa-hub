import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { AUTOMATION_HTTP_ROUTES } from "./automation-routes.js";
import { BUG_ACTIONS } from "./bug-actions.js";
import {
  VERIFICATION_RESULT_AUTOMATION_TOOL,
  verificationResultAutomationRequest,
} from "./automation-verification-result.js";

type Values = Record<string, unknown>;
interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Values;
  readonly annotations: Values;
}
const VENDOR_MEDIA_TYPE = "application/vnd.relay-qa-hub.v1.1+json";
const UUID_PATTERN = "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$";
const uuidSchema = { type: "string", pattern: UUID_PATTERN };
const textSchema = { type: "string", minLength: 1 };
const properties = {
  projectId: textSchema,
  bugId: textSchema,
  userId: textSchema,
  attachmentId: textSchema,
  name: textSchema,
  idempotencyKey: textSchema,
  expectedVersion: { type: "integer", minimum: 1 },
  request: { type: "object" },
  filters: { type: "object" },
  action: { type: "string", enum: BUG_ACTIONS },
  note: { type: "string" },
  attemptId: textSchema,
  verificationId: textSchema,
  componentKey: textSchema,
  sessionId: textSchema,
  id: textSchema,
  buildId: textSchema,
  captureId: textSchema,
  artifactKind: textSchema,
  uri: textSchema,
  query: { type: "object" },
  chunkNumber: { type: "integer", minimum: 0 },
  clientSubmissionId: textSchema,
  clientAttachmentId: textSchema,
  chunkSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  bytesBase64: { type: "string", maxLength: 11184812 },
};
function definition(
  name: string,
  title: string,
  required: string[],
  write = false,
): ToolDefinition {
  return {
    name,
    title,
    description: `${title}。使用明确项目；写入返回同一 HTTP 业务服务的真实结果。`,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint: !write,
      destructiveHint: write,
      idempotentHint: !write,
      openWorldHint: false,
    },
  };
}
const terminalAttemptProperties = {
  projectId: uuidSchema,
  attemptId: uuidSchema,
  expectedVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  reason: { type: "string", minLength: 1, maxLength: 5_000 },
  idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
};
const terminalWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
const TERMINAL_REPAIR_ATTEMPT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "qa_fail_repair_attempt",
    title: "将当前修复轮次标记为失败",
    description:
      "调用冻结的1.1修复轮次终止入口，将当前执行中的RepairAttempt标记为failed并释放Bug。必须提供RepairAttempt expectedVersion和真实失败原因；幂等键可省略以派生canonical键，显式值必须一致。返回HTTP业务服务保存的冻结结果。",
    inputSchema: {
      type: "object",
      properties: terminalAttemptProperties,
      required: ["projectId", "attemptId", "expectedVersion", "reason"],
      additionalProperties: false,
    },
    annotations: terminalWriteAnnotations,
  },
  {
    name: "qa_supersede_repair_attempt",
    title: "原子替换当前修复轮次",
    description:
      "调用冻结的1.1修复轮次终止入口，在同一事务内将当前RepairAttempt标记为superseded并建立显式successor。必须提供旧轮次expectedVersion、替换原因和完整successor；幂等键可省略以派生canonical键，显式值必须一致。返回HTTP业务服务保存的冻结结果。",
    inputSchema: {
      type: "object",
      properties: {
        ...terminalAttemptProperties,
        successor: {
          type: "object",
          properties: {
            id: uuidSchema,
            mode: { type: "string", enum: ["human", "relay", "external"] },
            assigneeId: uuidSchema,
            summary: { type: "string", minLength: 1, maxLength: 10_000 },
          },
          required: ["id", "mode", "assigneeId"],
          additionalProperties: false,
        },
      },
      required: ["projectId", "attemptId", "expectedVersion", "reason", "successor"],
      additionalProperties: false,
    },
    annotations: terminalWriteAnnotations,
  },
];
const repairCompatibilityProperties = {
  projectId: uuidSchema,
  bugId: uuidSchema,
  attemptId: uuidSchema,
  summary: { type: "string", minLength: 1, maxLength: 7_000 },
  validation: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: { type: "string", minLength: 1, maxLength: 500 },
  },
  branch: { type: "string", minLength: 1, maxLength: 300 },
  commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
  mergeRequestUrl: { type: "string", minLength: 1, maxLength: 4_000, format: "uri" },
  patchUrl: { type: "string", minLength: 1, maxLength: 4_000, format: "uri" },
  idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
};
const REPAIR_COMPATIBILITY_TOOLS: readonly ToolDefinition[] = [
  {
    name: "qa_begin_fix",
    title: "领取并开始人工修复",
    description:
      "兼容本地MCP人工修复入口。使用当前登录身份领取未分配Bug，推进ready，建立并启动唯一人工RepairAttempt；已有同一身份的planned或running轮次时从持久状态安全续接。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: repairCompatibilityProperties.projectId,
        bugId: repairCompatibilityProperties.bugId,
        summary: { type: "string", minLength: 1, maxLength: 5_000 },
        idempotencyKey: repairCompatibilityProperties.idempotencyKey,
      },
      required: ["projectId", "bugId", "summary", "idempotencyKey"],
      additionalProperties: false,
    },
    annotations: terminalWriteAnnotations,
  },
  {
    name: "qa_submit_fix",
    title: "提交人工修复交付",
    description:
      "兼容本地MCP修复交付入口。仅当前登录的RepairAttempt assignee可提交分支、完整Git SHA、修复摘要及真实验证记录，并调用正式Bug动作业务。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: repairCompatibilityProperties.projectId,
        attemptId: repairCompatibilityProperties.attemptId,
        summary: repairCompatibilityProperties.summary,
        validation: repairCompatibilityProperties.validation,
        branch: repairCompatibilityProperties.branch,
        commitSha: repairCompatibilityProperties.commitSha,
        mergeRequestUrl: repairCompatibilityProperties.mergeRequestUrl,
        patchUrl: repairCompatibilityProperties.patchUrl,
        idempotencyKey: repairCompatibilityProperties.idempotencyKey,
      },
      required: [
        "projectId",
        "attemptId",
        "summary",
        "validation",
        "branch",
        "commitSha",
        "idempotencyKey",
      ],
      additionalProperties: false,
    },
    annotations: terminalWriteAnnotations,
  },
];
export const AUTOMATION_TOOLS: readonly ToolDefinition[] = [
  VERIFICATION_RESULT_AUTOMATION_TOOL,
  ...AUTOMATION_HTTP_ROUTES.map(([name, title, method, path]) => {
    const terminal = TERMINAL_REPAIR_ATTEMPT_TOOLS.find((tool) => tool.name === name);
    return (
      terminal ??
      definition(
        name,
        title,
        [
          ...new Set([
            ...(name === "qa_get_session" ||
            name === "qa_logout" ||
            name === "qa_list_managed_projects"
              ? []
              : ["projectId"]),
            ...Array.from(path.matchAll(/:([A-Za-z]+)/gu), (match) => match[1]!),
          ]),
        ],
        method !== "GET",
      )
    );
  }),
  ...REPAIR_COMPATIBILITY_TOOLS,
  definition(
    "qa_put_upload_chunk",
    "上传一个附件分块并校验SHA256",
    [
      "projectId",
      "sessionId",
      "chunkNumber",
      "expectedVersion",
      "clientSubmissionId",
      "clientAttachmentId",
      "chunkSha256",
      "bytesBase64",
      "idempotencyKey",
    ],
    true,
  ),
  definition("qa_read_attachment", "读取已绑定附件的远端资源内容", [
    "projectId",
    "bugId",
    "attachmentId",
  ]),
  definition("qa_login_gm", "使用独立 GM 密码建立管理会话", ["request"], true),
  definition("qa_login", "项目姓名登录并取得会话令牌", ["projectId", "name"], true),
  definition("qa_list_projects", "查询自己的项目", []),
  definition("qa_list_bugs", "查询项目 Bug 列表", ["projectId"]),
  definition("qa_get_bug_context", "读取 Bug、评论、附件及人工流程", ["projectId", "bugId"]),
  definition("qa_create_bug", "创建 Bug", ["projectId", "request"], true),
  definition(
    "qa_update_bug",
    "编辑 Bug",
    ["projectId", "bugId", "request", "idempotencyKey"],
    true,
  ),
  definition("qa_delete_bug", "保留审计删除 Bug", ["projectId", "bugId", "expectedVersion"], true),
  definition(
    "qa_bug_action",
    "人工修复、验收通过、退回与关闭",
    ["projectId", "bugId", "action", "expectedVersion", "idempotencyKey"],
    true,
  ),
  definition("qa_add_comment", "添加评论", ["projectId", "bugId", "request"], true),
  definition("qa_list_comments", "读取评论正文", ["projectId", "bugId"]),
  definition("qa_list_events", "读取 Bug 操作历史", ["projectId", "bugId"]),
  definition("qa_list_members", "读取项目员工", ["projectId"]),
  definition("qa_list_users", "读取项目人员管理列表", ["projectId"]),
  definition("qa_list_modules", "读取 Bug 分类", ["projectId"]),
  definition("qa_get_components", "读取项目组件开关和可用状态", ["projectId"]),
  definition("qa_set_component", "GM 配置项目组件", ["projectId", "componentKey", "request"], true),
  definition("qa_set_membership", "停用或恢复项目员工", ["projectId", "userId", "request"], true),
  definition("qa_create_project", "GM 创建纯 Bug 项目", ["request"], true),
  definition("qa_update_project", "GM 更新项目", ["projectId", "request"], true),
  definition("qa_list_attachments", "读取 Bug 附件元数据", ["projectId", "bugId"]),
  definition("qa_materialize_attachment", "取得可下载的远端附件资源", [
    "projectId",
    "bugId",
    "attachmentId",
  ]),
];

class AutomationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(code);
  }
}
function object(value: unknown): Values {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AutomationError("INVALID_REQUEST", 400);
  return value as Values;
}
function field(input: Values, key: string): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    !value ||
    value.length > (key === "bytesBase64" ? 11184812 : 4000)
  )
    throw new AutomationError("INVALID_REQUEST", 400);
  return value;
}
function encoded(input: Values, key: string): string {
  return encodeURIComponent(field(input, key));
}

function boundedText(input: Values, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || [...value].length > maximum)
    throw new AutomationError("INVALID_REQUEST", 400);
  return value;
}

function uuidField(input: Values, key: string): string {
  const value = boundedText(input, key, 36);
  if (!new RegExp(UUID_PATTERN, "u").test(value)) throw new AutomationError("INVALID_REQUEST", 400);
  return value;
}

function positiveVersion(input: Values, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new AutomationError("INVALID_RESPONSE", 502);
  return Number(value);
}

function responseObject(value: unknown): Values {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AutomationError("INVALID_RESPONSE", 502);
  return value as Values;
}

function responseUuid(input: Values, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !new RegExp(UUID_PATTERN, "u").test(value))
    throw new AutomationError("INVALID_RESPONSE", 502);
  return value;
}

function optionalHttpUrl(input: Values, key: string): string | undefined {
  if (input[key] === undefined) return undefined;
  const value = boundedText(input, key, 4_000);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AutomationError("INVALID_REQUEST", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new AutomationError("INVALID_REQUEST", 400);
  return value;
}

function repairCompatibilityStageKey(
  name: "qa_begin_fix" | "qa_submit_fix",
  callerKey: string,
  stage: "claim" | "ready" | "plan" | "start" | "deliver",
): string {
  const digest = createHash("sha256").update(`${name}\0${callerKey}`, "utf8").digest("hex");
  return `mcp:${name}:${stage}:${digest}`;
}

function repairCompatibilityRequest(
  input: Values,
  name: "qa_begin_fix" | "qa_submit_fix",
):
  | {
      readonly name: "qa_begin_fix";
      readonly projectId: string;
      readonly bugId: string;
      readonly summary: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly name: "qa_submit_fix";
      readonly projectId: string;
      readonly attemptId: string;
      readonly summary: string;
      readonly validation: readonly string[];
      readonly branch: string;
      readonly commitSha: string;
      readonly mergeRequestUrl?: string;
      readonly patchUrl?: string;
      readonly idempotencyKey: string;
      readonly deliverySummary: string;
    } {
  const projectId = uuidField(input, "projectId");
  const idempotencyKey = boundedText(input, "idempotencyKey", 200);
  if (name === "qa_begin_fix") {
    return {
      name,
      projectId,
      bugId: uuidField(input, "bugId"),
      summary: boundedText(input, "summary", 5_000),
      idempotencyKey,
    };
  }
  const summary = boundedText(input, "summary", 7_000);
  const validationValue = input["validation"];
  if (!Array.isArray(validationValue) || validationValue.length < 1 || validationValue.length > 20)
    throw new AutomationError("INVALID_REQUEST", 400);
  const validation = validationValue.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 500)
      throw new AutomationError("INVALID_REQUEST", 400);
    return value.trim();
  });
  const commitSha = boundedText(input, "commitSha", 40);
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new AutomationError("INVALID_REQUEST", 400);
  const mergeRequestUrl = optionalHttpUrl(input, "mergeRequestUrl");
  const patchUrl = optionalHttpUrl(input, "patchUrl");
  const deliverySummary = [
    summary,
    "",
    "验证（由本地 AI 编辑器报告，QA Hub 未独立复验）：",
    ...validation.map((value) => `- ${value}`),
  ].join("\n");
  if (deliverySummary.length > 10_000) throw new AutomationError("INVALID_REQUEST", 400);
  return {
    name,
    projectId,
    attemptId: uuidField(input, "attemptId"),
    summary,
    validation,
    branch: boundedText(input, "branch", 300),
    commitSha,
    ...(mergeRequestUrl === undefined ? {} : { mergeRequestUrl }),
    ...(patchUrl === undefined ? {} : { patchUrl }),
    idempotencyKey,
    deliverySummary,
  };
}

function terminalRepairAttemptAutomationRequest(
  input: Values,
  operation: "failRepairAttempt" | "supersedeRepairAttempt",
): {
  readonly path: string;
  readonly body: Values;
  readonly idempotencyKey: string;
} {
  const allowed = new Set([
    "projectId",
    "attemptId",
    "expectedVersion",
    "reason",
    "idempotencyKey",
    ...(operation === "supersedeRepairAttempt" ? ["successor"] : []),
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new AutomationError("INVALID_REQUEST", 400);
  uuidField(input, "projectId");
  const attemptId = uuidField(input, "attemptId");
  if (!Number.isSafeInteger(input["expectedVersion"]) || Number(input["expectedVersion"]) < 1)
    throw new AutomationError("INVALID_REQUEST", 400);
  const expectedVersion = Number(input["expectedVersion"]);
  const reason = boundedText(input, "reason", 5_000);
  let successor: Values | undefined;
  if (operation === "supersedeRepairAttempt") {
    const value = object(input["successor"]);
    const successorKeys = new Set(["id", "mode", "assigneeId", "summary"]);
    if (Object.keys(value).some((key) => !successorKeys.has(key)))
      throw new AutomationError("INVALID_REQUEST", 400);
    const mode = value["mode"];
    if (!["human", "relay", "external"].includes(String(mode)))
      throw new AutomationError("INVALID_REQUEST", 400);
    successor = {
      id: uuidField(value, "id"),
      mode,
      assigneeId: uuidField(value, "assigneeId"),
      ...(value["summary"] === undefined ? {} : { summary: boundedText(value, "summary", 10_000) }),
    };
  }
  const idempotencyKey = `workflow:${operation}:attempt:${attemptId}:v${expectedVersion}`;
  if (input["idempotencyKey"] !== undefined && input["idempotencyKey"] !== idempotencyKey)
    throw new AutomationError("INVALID_REQUEST", 400);
  return {
    path: `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/${
      operation === "failRepairAttempt" ? "fail" : "supersede"
    }`,
    body: { expectedVersion, reason, ...(successor ? { successor } : {}) },
    idempotencyKey,
  };
}

const LATEST_PROTOCOL_VERSION = "2025-06-18";
// Earlier 2025-03-26 requires batches; this endpoint supports the single-message transport.
const SUPPORTED_PROTOCOL_VERSIONS = new Set([LATEST_PROTOCOL_VERSION]);

function isObject(value: unknown): value is Values {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function rpcError(id: string | number | null, code: number, message: string): Values {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Protocol adaptation only: all operations enter the authenticated HTTP business handlers. */
export function registerAutomationRoutes(
  app: FastifyInstance,
  publicApiOrigin: string,
  allowedOrigins: readonly string[] = [],
): void {
  const credentials = new WeakMap<FastifyRequest, Record<string, string>>();
  app.addHook("onRequest", (request, _reply, done) => {
    const headers: Record<string, string> = {};
    for (const key of ["authorization", "cookie", "origin", "x-csrf-token"]) {
      const value = request.headers[key];
      if (typeof value === "string") headers[key] = value;
    }
    credentials.set(request, headers);
    done();
  });

  async function dispatch(request: FastifyRequest, name: string, raw: unknown): Promise<unknown> {
    const tool = AUTOMATION_TOOLS.find((item) => item.name === name);
    if (!tool) throw new AutomationError("TOOL_NOT_FOUND", 404);
    const input = object(raw);
    for (const required of tool.inputSchema["required"] as string[])
      if (input[required] === undefined) throw new AutomationError("INVALID_REQUEST", 400);
    const allowedProperties =
      name === "qa_fail_repair_attempt" ||
      name === "qa_supersede_repair_attempt" ||
      name === "qa_begin_fix" ||
      name === "qa_submit_fix"
        ? object(tool.inputSchema["properties"])
        : properties;
    for (const key of Object.keys(input))
      if (!(key in allowedProperties)) throw new AutomationError("INVALID_REQUEST", 400);
    const projectId = (tool.inputSchema["required"] as string[]).includes("projectId")
      ? field(input, "projectId")
      : typeof input["projectId"] === "string"
        ? input["projectId"]
        : undefined;
    const send = async (
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: Values,
      key?: string,
      contentType = "application/json",
    ) => {
      const response = await app.inject({
        method,
        url: path,
        headers: {
          ...credentials.get(request),
          accept: VENDOR_MEDIA_TYPE,
          ...(projectId ? { "x-qa-project-id": projectId } : {}),
          ...(body ? { "content-type": contentType } : {}),
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body ? { payload: body } : {}),
      });
      let result: unknown;
      try {
        result = response.json();
      } catch {
        result = { code: "INVALID_RESPONSE" };
      }
      if (response.statusCode >= 400)
        throw new AutomationError(
          typeof object(result)["code"] === "string"
            ? String(object(result)["code"])
            : "HTTP_ERROR",
          response.statusCode,
          result,
        );
      return result;
    };
    if (name === "qa_fail_repair_attempt" || name === "qa_supersede_repair_attempt") {
      const command = terminalRepairAttemptAutomationRequest(
        input,
        name === "qa_fail_repair_attempt" ? "failRepairAttempt" : "supersedeRepairAttempt",
      );
      return send("POST", command.path, command.body, command.idempotencyKey, VENDOR_MEDIA_TYPE);
    }
    const adapter = AUTOMATION_HTTP_ROUTES.find(([toolName]) => toolName === name);
    if (adapter) {
      const [, , method, template] = adapter;
      let route = template.replace(/:([A-Za-z]+)/gu, (_, key: string) => encoded(input, key));
      if (input["query"] !== undefined) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(object(input["query"]))) {
          if (!["string", "number", "boolean"].includes(typeof value))
            throw new AutomationError("INVALID_REQUEST", 400);
          query.set(key, String(value));
        }
        route += "?" + query;
      }
      return send(
        method,
        route,
        method === "GET" || method === "DELETE"
          ? undefined
          : input["request"] === undefined
            ? {}
            : object(input["request"]),
        typeof input["idempotencyKey"] === "string" ? input["idempotencyKey"] : undefined,
      );
    }
    const bugPath = () => `/api/v1/bugs/${encoded(input, "bugId")}`;
    const projectPath = () => `/api/v1/projects/${encoded(input, "projectId")}`;
    const payload = () => object(input["request"]);
    const listPath = (path: string, defaultLimit?: number): string => {
      const values = input["query"] === undefined ? {} : object(input["query"]);
      const query = new URLSearchParams(
        defaultLimit === undefined ? {} : { limit: String(defaultLimit) },
      );
      for (const [key, value] of Object.entries(values)) {
        if (
          !["limit", "cursor"].includes(key) ||
          (key === "cursor"
            ? typeof value !== "string"
            : !["number", "string"].includes(typeof value))
        )
          throw new AutomationError("INVALID_REQUEST", 400);
        query.set(key, String(value));
      }
      return query.size ? `${path}?${query}` : path;
    };
    const currentPrincipal = async (expectedProjectId: string): Promise<Values> => {
      const principal = responseObject(await send("GET", "/api/v1/auth/me"));
      responseUuid(principal, "accountId");
      responseUuid(principal, "userId");
      if (typeof principal["displayName"] !== "string" || !principal["displayName"])
        throw new AutomationError("INVALID_RESPONSE", 502);
      const projectId = responseUuid(principal, "projectId");
      if (projectId !== expectedProjectId) throw new AutomationError("PROJECT_MISMATCH", 403);
      return principal;
    };
    const principalSummary = (principal: Values): Values => ({
      accountId: principal["accountId"],
      userId: principal["userId"],
      displayName: principal["displayName"],
    });
    const scopedBug = (
      value: unknown,
      expectedProjectId: string,
      expectedBugId: string,
    ): Values => {
      const bug = responseObject(value);
      if (bug["projectId"] !== expectedProjectId || bug["id"] !== expectedBugId)
        throw new AutomationError("PROJECT_MISMATCH", 403);
      positiveVersion(bug, "version");
      return bug;
    };
    const bugAction = async (
      expectedProjectId: string,
      expectedBugId: string,
      body: Values,
      idempotencyKey: string,
    ): Promise<{ readonly result: Values; readonly bug: Values }> => {
      const result = responseObject(
        await send(
          "POST",
          `/api/v1/projects/${encodeURIComponent(expectedProjectId)}/bugs/${encodeURIComponent(expectedBugId)}/actions`,
          body,
          idempotencyKey,
        ),
      );
      if (result["projectId"] !== expectedProjectId || result["bugId"] !== expectedBugId)
        throw new AutomationError("INVALID_RESPONSE", 502);
      return {
        result: responseObject(result["result"]),
        bug: scopedBug(result["bug"], expectedProjectId, expectedBugId),
      };
    };
    switch (name) {
      case "qa_record_verification_result": {
        let command: ReturnType<typeof verificationResultAutomationRequest>;
        try {
          command = verificationResultAutomationRequest(input);
        } catch (error) {
          if (error instanceof TypeError) throw new AutomationError("INVALID_REQUEST", 400);
          throw error;
        }
        return send("POST", command.path, command.body, command.idempotencyKey);
      }
      case "qa_put_upload_chunk": {
        const base64 = field(input, "bytesBase64");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64))
          throw new AutomationError("INVALID_REQUEST", 400);
        const bytes = Buffer.from(base64, "base64");
        if (
          bytes.length === 0 ||
          bytes.length > 8 * 1024 * 1024 ||
          createHash("sha256").update(bytes).digest("hex") !== field(input, "chunkSha256")
        )
          throw new AutomationError("INVALID_CHUNK", 400);
        if (
          !Number.isSafeInteger(input["chunkNumber"]) ||
          Number(input["chunkNumber"]) < 0 ||
          !Number.isSafeInteger(input["expectedVersion"]) ||
          Number(input["expectedVersion"]) < 1
        )
          throw new AutomationError("INVALID_REQUEST", 400);
        const response = await app.inject({
          method: "PUT",
          url: "/api/v1/uploads/" + encoded(input, "sessionId") + "/chunks/" + input["chunkNumber"],
          headers: {
            ...credentials.get(request),
            "x-qa-project-id": field(input, "projectId"),
            "content-type": "application/octet-stream",
            "content-length": String(bytes.length),
            "x-chunk-sha256": field(input, "chunkSha256"),
            "if-match": '"' + input["expectedVersion"] + '"',
            "x-client-submission-id": field(input, "clientSubmissionId"),
            "x-client-attachment-id": field(input, "clientAttachmentId"),
            "idempotency-key": field(input, "idempotencyKey"),
          },
          payload: bytes,
        });
        if (response.statusCode !== 204) {
          const error = response.json() as Values;
          throw new AutomationError(
            typeof error["code"] === "string" ? error["code"] : "UPLOAD_CHUNK_REJECTED",
            response.statusCode,
            error,
          );
        }
        return {
          version: Number(response.headers["x-upload-version"]),
          etag: response.headers["etag"],
        };
      }
      case "qa_begin_fix": {
        const command = repairCompatibilityRequest(input, "qa_begin_fix");
        if (command.name !== "qa_begin_fix") throw new AutomationError("INVALID_REQUEST", 400);
        const principal = await currentPrincipal(command.projectId);
        const userId = responseUuid(principal, "userId");
        const expectedSummary = `[MCP] ${command.summary}`;
        let bug = scopedBug(
          await send("GET", `/api/v1/bugs/${encodeURIComponent(command.bugId)}`),
          command.projectId,
          command.bugId,
        );
        let workflow = responseObject(
          await send("GET", `/api/v1/bugs/${encodeURIComponent(command.bugId)}/human-workflow`),
        );
        const activeValue = workflow["repairAttempt"];
        if (activeValue !== null && activeValue !== undefined) {
          const active = responseObject(activeValue);
          if (bug["ownerId"] !== null && bug["ownerId"] !== userId)
            throw new AutomationError("BUG_ASSIGNED_TO_OTHER_USER", 409);
          if (active["mode"] !== "human" || active["assigneeId"] !== userId)
            throw new AutomationError("BUG_ASSIGNED_TO_OTHER_USER", 409);
          if (active["summary"] !== expectedSummary)
            throw new AutomationError("IDEMPOTENCY_PAYLOAD_MISMATCH", 409);
          if (active["status"] === "running") {
            return {
              principal: principalSummary(principal),
              bug,
              repairAttempt: active,
              workflow,
              resumed: true,
            };
          }
          if (active["status"] === "planned") {
            const activeId = responseUuid(active, "id");
            const started = await bugAction(
              command.projectId,
              command.bugId,
              {
                action: "begin_fix",
                expectedVersion: positiveVersion(active, "version"),
                attemptId: activeId,
                request: { reason: expectedSummary },
              },
              repairCompatibilityStageKey(command.name, command.idempotencyKey, "start"),
            );
            bug = started.bug;
            workflow = responseObject(
              await send("GET", `/api/v1/bugs/${encodeURIComponent(command.bugId)}/human-workflow`),
            );
            return {
              principal: principalSummary(principal),
              bug,
              repairAttempt: started.result,
              workflow,
              resumed: true,
            };
          }
          throw new AutomationError("BUG_NOT_AVAILABLE_FOR_FIX", 409);
        }
        const state = bug["state"];
        if (typeof state !== "string" || !["reported", "needs_info", "ready"].includes(state))
          throw new AutomationError("BUG_NOT_AVAILABLE_FOR_FIX", 409);
        if (bug["ownerId"] !== null && bug["ownerId"] !== userId)
          throw new AutomationError("BUG_ASSIGNED_TO_OTHER_USER", 409);
        if (bug["ownerId"] === null) {
          bug = scopedBug(
            await send(
              "PATCH",
              `/api/v1/bugs/${encodeURIComponent(command.bugId)}`,
              { expectedVersion: positiveVersion(bug, "version"), ownerId: userId },
              repairCompatibilityStageKey(command.name, command.idempotencyKey, "claim"),
            ),
            command.projectId,
            command.bugId,
          );
        }
        if (bug["state"] !== "ready") {
          bug = (
            await bugAction(
              command.projectId,
              command.bugId,
              { action: "ready", expectedVersion: positiveVersion(bug, "version") },
              repairCompatibilityStageKey(command.name, command.idempotencyKey, "ready"),
            )
          ).bug;
        }
        const planned = await bugAction(
          command.projectId,
          command.bugId,
          {
            action: "plan_fix",
            expectedVersion: positiveVersion(bug, "version"),
            request: { assigneeId: userId, summary: expectedSummary },
          },
          repairCompatibilityStageKey(command.name, command.idempotencyKey, "plan"),
        );
        const attemptId = responseUuid(planned.result, "id");
        const started = await bugAction(
          command.projectId,
          command.bugId,
          {
            action: "begin_fix",
            expectedVersion: positiveVersion(planned.result, "version"),
            attemptId,
            request: { reason: expectedSummary },
          },
          repairCompatibilityStageKey(command.name, command.idempotencyKey, "start"),
        );
        workflow = responseObject(
          await send("GET", `/api/v1/bugs/${encodeURIComponent(command.bugId)}/human-workflow`),
        );
        return {
          principal: principalSummary(principal),
          bug: started.bug,
          repairAttempt: started.result,
          workflow,
          resumed: false,
          nextAction:
            "Inspect the repository, make the narrow fix, run real validation, commit, then call qa_submit_fix.",
        };
      }
      case "qa_submit_fix": {
        const command = repairCompatibilityRequest(input, "qa_submit_fix");
        if (command.name !== "qa_submit_fix") throw new AutomationError("INVALID_REQUEST", 400);
        const principal = await currentPrincipal(command.projectId);
        const userId = responseUuid(principal, "userId");
        let attempt = responseObject(
          await send("GET", `/api/v1/repair-attempts/${encodeURIComponent(command.attemptId)}`),
        );
        if (responseUuid(attempt, "id") !== command.attemptId)
          throw new AutomationError("INVALID_RESPONSE", 502);
        const bugId = responseUuid(attempt, "bugId");
        let bug = scopedBug(
          await send("GET", `/api/v1/bugs/${encodeURIComponent(bugId)}`),
          command.projectId,
          bugId,
        );
        if (attempt["mode"] !== "human" || attempt["assigneeId"] !== userId)
          throw new AutomationError("REPAIR_ASSIGNED_TO_OTHER_USER", 403);
        if (attempt["status"] === "delivered") {
          if (attempt["commitSha"] !== command.commitSha)
            throw new AutomationError("REPAIR_ALREADY_DELIVERED", 409);
          if (
            attempt["summary"] !== command.deliverySummary ||
            attempt["branch"] !== command.branch ||
            (attempt["mergeRequestUrl"] ?? null) !== (command.mergeRequestUrl ?? null) ||
            (attempt["patchUrl"] ?? null) !== (command.patchUrl ?? null)
          )
            throw new AutomationError("IDEMPOTENCY_PAYLOAD_MISMATCH", 409);
          const workflow = responseObject(
            await send("GET", `/api/v1/bugs/${encodeURIComponent(bugId)}/human-workflow`),
          );
          return {
            principal: principalSummary(principal),
            repairAttempt: attempt,
            bug,
            workflow,
            replayed: true,
            reporterConfirmationRequired: false,
          };
        }
        if (attempt["status"] !== "running") throw new AutomationError("REPAIR_NOT_RUNNING", 409);
        const submitted = await bugAction(
          command.projectId,
          bugId,
          {
            action: "submit_fix",
            expectedVersion: positiveVersion(attempt, "version"),
            attemptId: command.attemptId,
            request: {
              summary: command.deliverySummary,
              deliveryKind: "code",
              branch: command.branch,
              commitSha: command.commitSha,
              ...(command.mergeRequestUrl === undefined
                ? {}
                : { mergeRequestUrl: command.mergeRequestUrl }),
              ...(command.patchUrl === undefined ? {} : { patchUrl: command.patchUrl }),
            },
          },
          repairCompatibilityStageKey(command.name, command.idempotencyKey, "deliver"),
        );
        attempt = submitted.result;
        bug = submitted.bug;
        const workflow = responseObject(
          await send("GET", `/api/v1/bugs/${encodeURIComponent(bugId)}/human-workflow`),
        );
        return {
          principal: principalSummary(principal),
          repairAttempt: attempt,
          bug,
          workflow,
          replayed: false,
          reporterConfirmationRequired: false,
          nextAction:
            "The code delivery now waits for an exact-commit Build. After it reaches ready_for_verification, an active member of the same project must complete the formal Verification workflow; the recorded verification owner remains attribution, not an authorization role.",
        };
      }
      case "qa_login_gm": {
        const body = payload();
        const selected = input["projectId"] === undefined ? undefined : field(input, "projectId");
        if (
          selected !== undefined &&
          body["projectId"] !== undefined &&
          body["projectId"] !== selected
        )
          throw new AutomationError("PROJECT_MISMATCH", 400);
        return send("POST", "/api/v1/auth/gm/login", {
          ...body,
          ...(selected === undefined ? {} : { projectId: selected }),
          client: "android",
        });
      }
      case "qa_login":
        return send("POST", "/api/v1/auth/login", {
          projectId: field(input, "projectId"),
          name: field(input, "name"),
          client: "android",
        });
      case "qa_list_projects":
        return send("GET", listPath("/api/v1/projects"));
      case "qa_list_bugs": {
        const query = new URLSearchParams({ projectId: field(input, "projectId") });
        for (const [key, value] of Object.entries(
          input["filters"] === undefined ? {} : object(input["filters"]),
        )) {
          if (
            ![
              "q",
              "state",
              "severity",
              "ownerId",
              "verificationOwnerId",
              "ownerState",
              "cursor",
              "limit",
            ].includes(key) ||
            !["string", "number"].includes(typeof value)
          )
            throw new AutomationError("INVALID_REQUEST", 400);
          query.set(key, String(value));
        }
        return send("GET", `/api/v1/bugs?${query}`);
      }
      case "qa_get_bug_context": {
        const [bug, comments, events, attachments, humanWorkflow] = await Promise.all([
          send("GET", bugPath()),
          send("GET", `${bugPath()}/comments`),
          send("GET", `${bugPath()}/events?limit=100`),
          send("GET", `${bugPath()}/attachments`),
          send("GET", `${bugPath()}/human-workflow`),
        ]);
        return { bug, comments, events, attachments, humanWorkflow };
      }
      case "qa_create_bug": {
        const body = payload();
        if (body["projectId"] !== undefined && body["projectId"] !== projectId)
          throw new AutomationError("PROJECT_MISMATCH", 400);
        return send(
          "POST",
          "/api/v1/bugs",
          { ...body, projectId },
          `submission:${field(body, "clientSubmissionId")}:commit`,
        );
      }
      case "qa_update_bug":
        return send("PATCH", bugPath(), payload(), field(input, "idempotencyKey"));
      case "qa_delete_bug":
        return send(
          "DELETE",
          `${bugPath()}?expectedVersion=${encodeURIComponent(String(input["expectedVersion"]))}`,
          undefined,
          `web:deleteBug:bug:${field(input, "bugId")}:v${input["expectedVersion"]}`,
        );
      case "qa_bug_action": {
        const action: Values = {
          action: field(input, "action"),
          expectedVersion: input["expectedVersion"],
        };
        for (const key of ["request", "note", "attemptId", "verificationId"])
          if (input[key] !== undefined) action[key] = input[key];
        return send(
          "POST",
          `${projectPath()}/bugs/${encoded(input, "bugId")}/actions`,
          action,
          field(input, "idempotencyKey"),
        );
      }
      case "qa_add_comment":
        return send(
          "POST",
          `${bugPath()}/comments`,
          payload(),
          `comment:${field(input, "bugId")}:${field(payload(), "clientSubmissionId")}`,
        );
      case "qa_list_comments":
        return send("GET", listPath(`${bugPath()}/comments`, 100));
      case "qa_list_events":
        return send("GET", `${bugPath()}/events?limit=100`);
      case "qa_list_members":
        return send("GET", listPath(`${projectPath()}/members`));
      case "qa_list_users":
        return send("GET", listPath(`${projectPath()}/users`));
      case "qa_list_modules":
        return send("GET", `${projectPath()}/modules`);
      case "qa_get_components":
        return send("GET", `${projectPath()}/components`);
      case "qa_set_component":
        return send(
          "PUT",
          `${projectPath()}/components/${encoded(input, "componentKey")}`,
          payload(),
        );
      case "qa_set_membership":
        return send("PATCH", `${projectPath()}/members/${encoded(input, "userId")}`, payload());
      case "qa_create_project":
        return send("POST", "/api/v1/gm/projects", payload());
      case "qa_update_project":
        return send("PATCH", `/api/v1/gm/projects/${encoded(input, "projectId")}`, payload());
      case "qa_list_attachments":
        return send("GET", listPath(`${bugPath()}/attachments`));
      case "qa_read_attachment":
      case "qa_materialize_attachment": {
        const list: unknown[] = [];
        const visited = new Set<string>();
        let cursor: string | undefined;
        while (true) {
          const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
          const page = object(await send("GET", `${bugPath()}/attachments?${query}`));
          if (!Array.isArray(page["items"])) throw new AutomationError("INVALID_RESPONSE", 502);
          list.push(...page["items"]);
          if (page["nextCursor"] === undefined || page["nextCursor"] === null) break;
          const next = page["nextCursor"];
          if (typeof next !== "string" || !next || visited.has(next))
            throw new AutomationError("INVALID_RESPONSE", 502);
          visited.add(next);
          cursor = next;
        }
        let attachment: unknown = list.find(
          (entry) => object(entry)["attachmentId"] === input["attachmentId"],
        );
        let downloadPath = `/api/v1/attachments/${encoded(input, "attachmentId")}`;
        if (!attachment) {
          const captureIds = [
            ...new Set(
              list
                .map((entry) => object(entry)["captureId"])
                .filter((value): value is string => typeof value === "string"),
            ),
          ];
          for (const captureId of captureIds) {
            const capture = object(
              await send("GET", `/api/v1/capture-bundles/${encodeURIComponent(captureId)}`),
            );
            if (
              capture["projectId"] !== projectId ||
              capture["captureId"] !== captureId ||
              !list.some(
                (entry) => object(entry)["attachmentId"] === capture["primaryEvidenceAttachmentId"],
              )
            )
              throw new AutomationError("CAPTURE_BINDING_INVALID", 502);
            const artifacts = capture["artifacts"];
            const artifact = Array.isArray(artifacts)
              ? artifacts.find(
                  (entry) =>
                    object(entry)["attachmentId"] === input["attachmentId"] &&
                    object(entry)["status"] === "succeeded",
                )
              : undefined;
            if (!artifact) continue;
            const kind = field(object(artifact), "kind");
            if (
              ![
                "system_screenshot",
                "system_recording",
                "poco_screenshot",
                "poco_hierarchy",
                "poco_profiling",
                "poco_snapshot",
              ].includes(kind)
            )
              throw new AutomationError("CAPTURE_ARTIFACT_INVALID", 502);
            attachment = artifact;
            downloadPath = `${bugPath()}/capture-bundles/${encodeURIComponent(captureId)}/artifacts/${encodeURIComponent(kind)}`;
            break;
          }
        }
        if (!attachment) throw new AutomationError("NOT_FOUND", 404);
        const uri = `qa-hub://attachment/${encoded(input, "projectId")}/${encoded(input, "bugId")}/${encoded(input, "attachmentId")}`;
        if (name === "qa_materialize_attachment")
          return {
            projectId,
            bugId: input["bugId"],
            attachment,
            downloadUrl: `${publicApiOrigin}${downloadPath}`,
            resource: {
              type: "resource_link",
              name: String(object(attachment)["filename"] ?? input["attachmentId"]),
              uri,
              description:
                "Authenticated project attachment. Read with resources/read or qa_read_attachment.",
            },
          };
        const response = await app.inject({
          method: "GET",
          url: downloadPath,
          headers: { ...credentials.get(request), "x-qa-project-id": field(input, "projectId") },
        });
        if (response.statusCode !== 200)
          throw new AutomationError("ATTACHMENT_READ_FAILED", response.statusCode);
        const bytes = response.rawPayload;
        if (bytes.length > 32 * 1024 * 1024) throw new AutomationError("RESOURCE_TOO_LARGE", 413);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const declared = response.headers["x-content-sha256"] ?? object(attachment)["sha256"];
        if (declared !== sha256) throw new AutomationError("ATTACHMENT_INTEGRITY_FAILED", 502);
        return {
          uri,
          projectId,
          bugId: input["bugId"],
          attachmentId: input["attachmentId"],
          size: bytes.length,
          sha256,
          mimeType: String(response.headers["content-type"]).split(";")[0],
          blob: bytes.toString("base64"),
        };
      }
      default:
        throw new AutomationError("TOOL_NOT_FOUND", 404);
    }
  }

  app.get("/api/v1/mcp/tools", async () => ({ tools: AUTOMATION_TOOLS }));
  app.post("/api/v1/mcp/call", { bodyLimit: 36 * 1024 * 1024 }, async (request, reply) => {
    try {
      const body = object(request.body);
      return await dispatch(request, field(body, "name"), body["arguments"] ?? {});
    } catch (error) {
      const failure =
        error instanceof AutomationError ? error : new AutomationError("INTERNAL_ERROR", 500);
      return reply.code(failure.status).send({ code: failure.code, details: failure.details });
    }
  });
  const origins = new Set([new URL(publicApiOrigin).origin, ...allowedOrigins]);
  const checkTransport = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
    const origin = request.headers.origin;
    if (origin !== undefined && (typeof origin !== "string" || !origins.has(origin)))
      return reply.code(403).send({ code: "MCP_ORIGIN_INVALID" });
    const version = request.headers["mcp-protocol-version"];
    if (
      version !== undefined &&
      (typeof version !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.has(version))
    )
      return reply.code(400).send({ code: "MCP_PROTOCOL_VERSION_UNSUPPORTED" });
  };
  // Stateless JSON responses: no server SSE channel or transport session to terminate.
  app.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    exposeHeadRoute: false,
    onRequest: checkTransport,
    handler: async (_request, reply) => reply.header("allow", "POST").code(405).send(),
  });
  app.post(
    "/mcp",
    {
      bodyLimit: 36 * 1024 * 1024,
      onRequest: checkTransport,
      errorHandler(error, _request, reply) {
        const parseError = [
          "FST_ERR_CTP_INVALID_JSON_BODY",
          "FST_ERR_CTP_EMPTY_JSON_BODY",
        ].includes(error.code);
        const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
        reply
          .code(parseError ? 400 : status)
          .send(
            rpcError(
              null,
              parseError ? -32700 : status >= 500 ? -32603 : -32600,
              parseError ? "Parse error" : status >= 500 ? "Internal error" : "Invalid Request",
            ),
          );
      },
    },
    async (request, reply) => {
      let rpc: Values;
      try {
        rpc = object(request.body);
      } catch {
        return reply.code(400).send(rpcError(null, -32600, "Invalid Request"));
      }
      const id = rpc["id"];
      if (rpc["jsonrpc"] !== "2.0" || (id !== undefined && !isRpcId(id)))
        return reply.code(400).send(rpcError(null, -32600, "Invalid Request"));
      if (rpc["method"] === undefined && isRpcId(id)) {
        const error = rpc["error"];
        const validResult = isObject(rpc["result"]) && error === undefined;
        const validError =
          rpc["result"] === undefined &&
          isObject(error) &&
          Number.isSafeInteger(error["code"]) &&
          typeof error["message"] === "string";
        if (validResult || validError) return reply.code(202).send();
      }
      if (typeof rpc["method"] !== "string" || "result" in rpc || "error" in rpc)
        return reply.code(400).send(rpcError(null, -32600, "Invalid Request"));
      const params = rpc["params"];
      if (id === undefined) {
        // Notifications never trigger tools or receive a JSON-RPC response, even on rejection.
        return reply.code(params === undefined || isObject(params) ? 202 : 400).send();
      }
      if (params !== undefined && !isObject(params)) return rpcError(id, -32602, "Invalid params");
      const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
      if (rpc["method"] === "initialize") {
        if (
          !isObject(params) ||
          typeof params["protocolVersion"] !== "string" ||
          !params["protocolVersion"] ||
          !isObject(params["capabilities"]) ||
          !isObject(params["clientInfo"]) ||
          typeof params["clientInfo"]["name"] !== "string" ||
          !params["clientInfo"]["name"] ||
          typeof params["clientInfo"]["version"] !== "string" ||
          !params["clientInfo"]["version"]
        )
          return rpcError(id, -32602, "Invalid initialize params");
        return result({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(params["protocolVersion"])
            ? params["protocolVersion"]
            : LATEST_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: { name: "qa-hub-project-preview", version: "2.1" },
          instructions:
            "Use explicit project IDs and project name sessions. Bug human acceptance is independent from optional integrations. Never report unexecuted checks as passed.",
        });
      }
      if (
        ["tools/list", "resources/list", "resources/templates/list"].includes(rpc["method"]) &&
        params?.["cursor"] !== undefined
      )
        return rpcError(id, -32602, "Invalid cursor");
      if (rpc["method"] === "ping") return result({});
      if (rpc["method"] === "resources/list") return result({ resources: [] });
      if (rpc["method"] === "resources/templates/list")
        return result({
          resourceTemplates: [
            {
              uriTemplate: "qa-hub://attachment/{projectId}/{bugId}/{attachmentId}",
              name: "Project Bug attachment",
              description:
                "Read only attachments bound to a Bug visible in the authenticated project.",
            },
          ],
        });
      if (rpc["method"] === "resources/read") {
        if (!params || typeof params["uri"] !== "string" || !params["uri"])
          return rpcError(id, -32602, "Invalid resource URI");
        try {
          const uri = field(params, "uri");
          const match =
            /^qa-hub:\/\/attachment\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/iu.exec(
              uri,
            );
          if (!match)
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid resource URI" } };
          const value = object(
            await dispatch(request, "qa_read_attachment", {
              projectId: match[1],
              bugId: match[2],
              attachmentId: match[3],
            }),
          );
          return result({ contents: [{ uri, mimeType: value["mimeType"], blob: value["blob"] }] });
        } catch (error) {
          const failure =
            error instanceof AutomationError ? error : new AutomationError("INTERNAL_ERROR", 500);
          return { jsonrpc: "2.0", id, error: { code: -32002, message: failure.code } };
        }
      }
      if (rpc["method"] === "tools/list") return result({ tools: AUTOMATION_TOOLS });
      if (rpc["method"] !== "tools/call") return rpcError(id, -32601, "Method not found");
      if (
        !params ||
        typeof params["name"] !== "string" ||
        !params["name"] ||
        (params["arguments"] !== undefined && !isObject(params["arguments"]))
      )
        return rpcError(id, -32602, "Invalid tools/call params");
      if (!AUTOMATION_TOOLS.some((tool) => tool.name === params["name"]))
        return rpcError(id, -32602, "Unknown tool");
      try {
        const value = await dispatch(request, field(params, "name"), params["arguments"] ?? {});
        return result({
          content: [
            { type: "text", text: JSON.stringify(value) },
            ...(value && typeof value === "object" && "resource" in value
              ? [(value as Values)["resource"]]
              : []),
          ],
          ...(value && typeof value === "object" && !Array.isArray(value)
            ? { structuredContent: value }
            : {}),
          isError: false,
        });
      } catch (error) {
        const failure =
          error instanceof AutomationError ? error : new AutomationError("INTERNAL_ERROR", 500);
        return result({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: failure.code,
                status: failure.status,
                details: failure.details,
              }),
            },
          ],
          isError: true,
        });
      }
    },
  );
}
