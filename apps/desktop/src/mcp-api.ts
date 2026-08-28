import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { DesktopConfig } from "./config.js";
import { isAllowedNetworkUrl } from "./config.js";
import { DesktopBrowserSessionCookieStore, readBoundedBody } from "./network.js";

const QA_MEDIA_TYPE = "application/vnd.relay-qa-hub.v1.1+json";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TERMINAL_STATES = new Set(["closed", "deferred", "rejected", "duplicate"]);

export interface QaHubJsonRequest {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface QaHubBinaryResponse {
  readonly bytes: Uint8Array;
  readonly headers: Headers;
}

export interface QaHubApiTransport {
  readonly json: (pathname: string, request?: QaHubJsonRequest) => Promise<unknown>;
  readonly binary: (pathname: string) => Promise<QaHubBinaryResponse>;
}

export class QaHubMcpError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "QaHubMcpError";
    this.code = code;
    this.status = status;
  }
}

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function responseErrorCode(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const code = (value as Record<string, unknown>)["code"];
  return typeof code === "string" && code.length > 0 && code.length <= 200 ? code : fallback;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "QA Hub returned invalid JSON");
  }
}

export class DesktopQaHubApiClient implements QaHubApiTransport {
  private readonly fetchImpl: FetchImplementation;

  constructor(
    private readonly config: DesktopConfig,
    private readonly browserSession: DesktopBrowserSessionCookieStore,
    fetchImpl: FetchImplementation = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  private credentialHeaders(): Headers {
    const headers = new Headers({ Accept: QA_MEDIA_TYPE });
    if (this.config.accessToken !== null) {
      headers.set("Authorization", `Bearer ${this.config.accessToken}`);
      return headers;
    }
    const cookie = this.browserSession.cookieHeader(null);
    if (cookie === null) {
      throw new QaHubMcpError(
        "QA_HUB_LOGIN_REQUIRED",
        "Open Relay QA Hub EXE and sign in before using its MCP tools",
        401,
      );
    }
    headers.set("Cookie", cookie);
    return headers;
  }

  private endpoint(pathname: string): URL {
    if (!pathname.startsWith("/api/v1/") || pathname.includes("\\")) {
      throw new QaHubMcpError("QA_HUB_PATH_NOT_ALLOWED", "QA Hub API path is not allowed");
    }
    const endpoint = new URL(pathname, this.config.apiBaseUrl);
    if (!isAllowedNetworkUrl(endpoint, this.config)) {
      throw new QaHubMcpError("QA_HUB_ORIGIN_NOT_ALLOWED", "QA Hub API origin is not allowed");
    }
    return endpoint;
  }

  private async csrfToken(): Promise<string> {
    const principal = await this.requestJson("/api/v1/auth/me", { method: "GET" }, false);
    const record = requireRecord(principal, "principal");
    return requireString(record, "csrfToken", 1, 512);
  }

  private async request(
    pathname: string,
    request: QaHubJsonRequest,
    includeCsrf: boolean,
    maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly headers: Headers; readonly status: number }> {
    const method = request.method ?? "GET";
    const headers = this.credentialHeaders();
    for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
    if (method !== "GET") {
      headers.set("Origin", this.config.csrfOrigin);
      if (this.config.accessToken === null && includeCsrf) {
        headers.set("X-CSRF-Token", await this.csrfToken());
      }
    }
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
        throw new QaHubMcpError("QA_HUB_REQUEST_TOO_LARGE", "QA Hub MCP request is too large");
      }
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(pathname), {
        method,
        headers,
        redirect: "manual",
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new QaHubMcpError(
        "QA_HUB_UNAVAILABLE",
        "Relay QA Hub API is unavailable from the EXE",
        503,
      );
    }
    this.browserSession.captureSetCookie(response.headers.get("set-cookie"));
    if (response.status >= 300 && response.status < 400) {
      throw new QaHubMcpError("QA_HUB_REDIRECT_BLOCKED", "QA Hub API redirect was blocked", 502);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, maxBytes);
    } catch (error) {
      if (error instanceof Error && error.message === "RESPONSE_TOO_LARGE") {
        throw new QaHubMcpError(
          "QA_HUB_RESPONSE_TOO_LARGE",
          "QA Hub response exceeded the MCP safety limit",
          502,
        );
      }
      throw error;
    }
    if (!response.ok) {
      const parsed = parseJsonBytes(bytes);
      const code = responseErrorCode(parsed, `QA_HUB_HTTP_${response.status}`);
      throw new QaHubMcpError(code, `QA Hub rejected the MCP operation (${code})`, response.status);
    }
    return { bytes, headers: response.headers, status: response.status };
  }

  private async requestJson(
    pathname: string,
    request: QaHubJsonRequest,
    includeCsrf: boolean,
  ): Promise<unknown> {
    const response = await this.request(pathname, request, includeCsrf, MAX_JSON_BYTES);
    return parseJsonBytes(response.bytes);
  }

  async json(pathname: string, request: QaHubJsonRequest = {}): Promise<unknown> {
    return this.requestJson(pathname, request, true);
  }

  async binary(pathname: string): Promise<QaHubBinaryResponse> {
    const response = await this.request(
      pathname,
      { method: "GET", headers: { Accept: "application/octet-stream" } },
      false,
      MAX_ATTACHMENT_BYTES,
    );
    return { bytes: response.bytes, headers: response.headers };
  }
}

export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const SAFE_WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const QA_HUB_MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: "qa_list_projects",
    title: "列出 QA Hub 项目",
    description: "读取当前 EXE 登录用户及其可见项目。开始读取 Bug 前先调用此工具。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "qa_list_bugs",
    title: "列出 QA Hub 单子",
    description:
      "读取当前可处理的 Bug 单子。默认排除已关闭、延期、驳回和重复项；可按项目、状态、严重级别、负责人或关键字筛选。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", format: "uuid" },
        q: { type: "string", minLength: 1, maxLength: 200 },
        state: {
          type: "string",
          enum: [
            "reported",
            "needs_info",
            "ready",
            "in_progress",
            "awaiting_build",
            "ready_for_verification",
            "closed",
            "deferred",
            "rejected",
            "duplicate",
          ],
        },
        severity: { type: "string", enum: ["S0", "S1", "S2", "S3", "S4"] },
        owner: { type: "string", enum: ["any", "me", "assigned", "unassigned"] },
        includeTerminal: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "qa_get_bug_context",
    title: "读取 Bug 完整上下文",
    description:
      "读取一个 Bug 的详情、当前修复/构建/关闭工作流、事件、附件、采集快照、项目成员与模块。修代码前必须调用。",
    inputSchema: {
      type: "object",
      properties: { bugId: { type: "string", format: "uuid" } },
      required: ["bugId"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "qa_materialize_attachment",
    title: "下载 Bug 附件到本机",
    description:
      "把已扫描且绑定到 Bug 的附件下载到 EXE 的只读 MCP 缓存，校验大小和 SHA-256，并返回本地绝对路径供 AI 编辑器读取。",
    inputSchema: {
      type: "object",
      properties: {
        bugId: { type: "string", format: "uuid" },
        attachmentId: { type: "string", format: "uuid" },
      },
      required: ["bugId", "attachmentId"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "qa_begin_fix",
    title: "领取并开始修复",
    description:
      "由当前 EXE 登录用户领取未分配 Bug（绝不抢占他人单子），按现有状态机转为可修复，创建并启动人工 RepairAttempt。",
    inputSchema: {
      type: "object",
      properties: {
        bugId: { type: "string", format: "uuid" },
        summary: { type: "string", minLength: 1, maxLength: 5000 },
      },
      required: ["bugId", "summary"],
      additionalProperties: false,
    },
    annotations: SAFE_WRITE,
  },
  {
    name: "qa_add_comment",
    title: "添加 Bug 处理记录",
    description: "向 Bug 时间线添加真实的调查进度、阻塞原因或验证记录；不得写入未执行的测试结果。",
    inputSchema: {
      type: "object",
      properties: {
        bugId: { type: "string", format: "uuid" },
        body: { type: "string", minLength: 1, maxLength: 10000 },
      },
      required: ["bugId", "body"],
      additionalProperties: false,
    },
    annotations: SAFE_WRITE,
  },
  {
    name: "qa_submit_fix",
    title: "提交已验证的代码修复",
    description:
      "提交当前 RepairAttempt 的分支、40 位提交 SHA、修复摘要和实际验证命令。代码交付进入等待精确构建/待关闭；指定关闭人可在详情直接关闭，无需提报人确认。",
    inputSchema: {
      type: "object",
      properties: {
        attemptId: { type: "string", format: "uuid" },
        summary: { type: "string", minLength: 1, maxLength: 7000 },
        validation: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        branch: { type: "string", minLength: 1, maxLength: 300 },
        commitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        mergeRequestUrl: { type: "string", format: "uri", maxLength: 4000 },
        patchUrl: { type: "string", format: "uri", maxLength: 4000 },
      },
      required: ["attemptId", "summary", "validation", "branch", "commitSha"],
      additionalProperties: false,
    },
    annotations: SAFE_WRITE,
  },
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QaHubMcpError("INVALID_ARGUMENTS", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new QaHubMcpError("INVALID_ARGUMENTS", `unexpected argument: ${key}`);
    }
  }
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} is invalid`);
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maximum) {
    throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} is invalid`);
  }
  return value.trim();
}

function requireUuid(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key, 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(value)) throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} is invalid`);
  return value;
}

function requirePrincipal(value: unknown): Record<string, unknown> {
  const principal = requireRecord(value, "principal");
  requireUuid(principal, "userId");
  requireUuid(principal, "accountId");
  requireString(principal, "displayName", 1, 300);
  return principal;
}

function principalSummary(principal: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    accountId: principal["accountId"],
    userId: principal["userId"],
    displayName: principal["displayName"],
  });
}

function bugRecord(value: unknown): Record<string, unknown> {
  const bug = requireRecord(value, "bug");
  requireUuid(bug, "id");
  requireUuid(bug, "projectId");
  requireString(bug, "key", 1, 100);
  requireString(bug, "title", 1, 300);
  if (!Number.isSafeInteger(bug["version"]) || (bug["version"] as number) < 1) {
    throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "bug.version is invalid");
  }
  return bug;
}

function integerArgument(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} is invalid`);
  }
  return value as number;
}

function booleanArgument(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} is invalid`);
  return value;
}

function safeFilename(value: string): string {
  const base = path
    .basename(value)
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .trim();
  const bounded = base.slice(0, 120);
  return bounded.length === 0 || bounded === "." || bounded === ".." ? "attachment.bin" : bounded;
}

function requireUrl(record: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(record, key, 4_000);
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} must be an absolute HTTP(S) URL`);
  }
  return value;
}

export class QaHubMcpTools {
  readonly definitions = QA_HUB_MCP_TOOLS;

  constructor(
    private readonly api: QaHubApiTransport,
    private readonly attachmentCacheRoot: string,
  ) {}

  private async principal(): Promise<Record<string, unknown>> {
    return requirePrincipal(await this.api.json("/api/v1/auth/me"));
  }

  private async getBug(bugId: string): Promise<Record<string, unknown>> {
    return bugRecord(await this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}`));
  }

  private async workflow(bugId: string): Promise<Record<string, unknown>> {
    return requireRecord(
      await this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/human-workflow`),
      "workflow",
    );
  }

  private async listProjects(): Promise<unknown> {
    return this.api.json("/api/v1/projects?limit=50");
  }

  private async listBugs(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, ["projectId", "q", "state", "severity", "owner", "includeTerminal", "limit"]);
    const projectId =
      input["projectId"] === undefined ? undefined : requireUuid(input, "projectId");
    const q = optionalString(input, "q", 200);
    const state = optionalString(input, "state", 100);
    const severity = optionalString(input, "severity", 2);
    const owner = optionalString(input, "owner", 20) ?? "any";
    if (!["any", "me", "assigned", "unassigned"].includes(owner)) {
      throw new QaHubMcpError("INVALID_ARGUMENTS", "owner is invalid");
    }
    const includeTerminal = booleanArgument(input, "includeTerminal", false);
    const limit = integerArgument(input, "limit", 50, 200);
    const query = new URLSearchParams({
      limit: includeTerminal || state !== undefined ? String(limit) : "500",
    });
    if (projectId !== undefined) query.set("projectId", projectId);
    if (q !== undefined) query.set("q", q);
    if (state !== undefined) query.set("state", state);
    if (severity !== undefined) query.set("severity", severity);
    let principal: Record<string, unknown> | null = null;
    if (owner === "me") {
      principal = await this.principal();
      query.set("ownerId", String(principal["userId"]));
    } else if (owner === "assigned" || owner === "unassigned") {
      query.set("ownerState", owner);
    }
    const response = requireRecord(await this.api.json(`/api/v1/bugs?${query.toString()}`), "bugs");
    const items = response["items"];
    if (!Array.isArray(items)) {
      throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "Bug list items are invalid");
    }
    const filtered =
      includeTerminal || state !== undefined
        ? items.slice(0, limit)
        : items
            .filter((item) => {
              if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
              return !TERMINAL_STATES.has(String((item as Record<string, unknown>)["state"]));
            })
            .slice(0, limit);
    return {
      ...(principal === null ? {} : { principal: principalSummary(principal) }),
      snapshotSequence: response["snapshotSequence"],
      items: filtered,
      count: filtered.length,
      terminalItemsExcluded: !(includeTerminal || state !== undefined),
    };
  }

  private async bugContext(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, ["bugId"]);
    const bugId = requireUuid(input, "bugId");
    const principal = await this.principal();
    const bug = await this.getBug(bugId);
    const projectId = String(bug["projectId"]);
    const [workflow, events, attachments, members, modules] = await Promise.all([
      this.workflow(bugId),
      this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/events?limit=100`),
      this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/attachments?limit=50`),
      this.api.json(`/api/v1/projects/${encodeURIComponent(projectId)}/members?limit=100`),
      this.api.json(`/api/v1/projects/${encodeURIComponent(projectId)}/modules`),
    ]);
    const attachmentRecord = requireRecord(attachments, "attachments");
    const attachmentItems = attachmentRecord["items"];
    if (!Array.isArray(attachmentItems)) {
      throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "attachment list is invalid");
    }
    const captureIds = [
      ...new Set(
        attachmentItems.flatMap((item) => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
          const captureId = (item as Record<string, unknown>)["captureId"];
          return typeof captureId === "string" && UUID_PATTERN.test(captureId) ? [captureId] : [];
        }),
      ),
    ];
    const captures = await Promise.all(
      captureIds.map(async (captureId) => {
        try {
          return await this.api.json(`/api/v1/capture-bundles/${encodeURIComponent(captureId)}`);
        } catch (error) {
          return {
            captureId,
            unavailable: true,
            code: error instanceof QaHubMcpError ? error.code : "CAPTURE_READ_FAILED",
          };
        }
      }),
    );
    return {
      principal: principalSummary(principal),
      bug,
      workflow,
      events,
      attachments,
      captures,
      members,
      modules,
      lifecycleConstraint:
        "Local AI may deliver code and validation evidence, but only a human reporter or assigned verifier may accept and close the Bug.",
    };
  }

  private async materializeAttachment(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, ["bugId", "attachmentId"]);
    const bugId = requireUuid(input, "bugId");
    const attachmentId = requireUuid(input, "attachmentId");
    await this.getBug(bugId);
    const list = requireRecord(
      await this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/attachments?limit=50`),
      "attachments",
    );
    const items = list["items"];
    if (!Array.isArray(items)) {
      throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "attachment list is invalid");
    }
    const metadataValue = items.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>)["attachmentId"] === attachmentId,
    );
    if (metadataValue === undefined) {
      throw new QaHubMcpError(
        "ATTACHMENT_NOT_BOUND_TO_BUG",
        "Attachment is not bound to the requested Bug",
        404,
      );
    }
    const metadata = requireRecord(metadataValue, "attachment");
    const filename = requireString(metadata, "filename", 1, 500);
    const expectedSha = requireString(metadata, "sha256", 64, 64).toLowerCase();
    const expectedSize = metadata["size"];
    if (
      !SHA256_PATTERN.test(expectedSha) ||
      !Number.isSafeInteger(expectedSize) ||
      (expectedSize as number) < 1
    ) {
      throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "attachment metadata is invalid");
    }
    const response = await this.api.binary(
      `/api/v1/attachments/${encodeURIComponent(attachmentId)}`,
    );
    const actualSha = createHash("sha256").update(response.bytes).digest("hex");
    if (response.bytes.byteLength !== expectedSize || actualSha !== expectedSha) {
      throw new QaHubMcpError(
        "ATTACHMENT_INTEGRITY_MISMATCH",
        "Downloaded attachment did not match its QA Hub size and SHA-256",
      );
    }
    const directory = path.resolve(this.attachmentCacheRoot, bugId);
    const target = path.resolve(
      directory,
      `${attachmentId}-${expectedSha.slice(0, 12)}-${safeFilename(filename)}`,
    );
    if (!target.startsWith(`${directory}${path.sep}`)) {
      throw new QaHubMcpError(
        "ATTACHMENT_PATH_NOT_ALLOWED",
        "Attachment cache path is not allowed",
      );
    }
    await fs.mkdir(directory, { recursive: true });
    let cached = false;
    try {
      const existing = await fs.readFile(target);
      const existingSha = createHash("sha256").update(existing).digest("hex");
      if (existing.length !== expectedSize || existingSha !== expectedSha) {
        throw new QaHubMcpError(
          "ATTACHMENT_CACHE_INTEGRITY_MISMATCH",
          "Existing MCP attachment cache entry failed integrity validation",
        );
      }
      cached = true;
    } catch (error) {
      if (error instanceof QaHubMcpError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await fs.writeFile(target, response.bytes, { flag: "wx", mode: 0o600 });
    }
    return {
      bugId,
      attachmentId,
      filename,
      mediaType: metadata["mediaType"],
      size: expectedSize,
      sha256: expectedSha,
      localPath: target,
      cached,
    };
  }

  private async beginFix(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, ["bugId", "summary"]);
    const bugId = requireUuid(input, "bugId");
    const summary = requireString(input, "summary", 1, 5_000);
    const principal = await this.principal();
    const userId = String(principal["userId"]);
    let bug = await this.getBug(bugId);
    let workflow = await this.workflow(bugId);
    const existingAttemptValue = workflow["repairAttempt"];
    if (
      typeof existingAttemptValue === "object" &&
      existingAttemptValue !== null &&
      !Array.isArray(existingAttemptValue)
    ) {
      const existingAttempt = existingAttemptValue as Record<string, unknown>;
      if (existingAttempt["assigneeId"] !== userId) {
        throw new QaHubMcpError(
          "BUG_ASSIGNED_TO_OTHER_USER",
          "The active RepairAttempt belongs to another user and MCP will not take it over",
          409,
        );
      }
      if (existingAttempt["status"] === "running") {
        return {
          principal: principalSummary(principal),
          bug,
          repairAttempt: existingAttempt,
          resumed: true,
        };
      }
      if (existingAttempt["status"] === "planned") {
        const attemptId = requireUuid(existingAttempt, "id");
        const attemptVersion = integerArgument(
          existingAttempt,
          "version",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const started = await this.api.json(
          `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/start`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `workflow:startRepairAttempt:attempt:${attemptId}:v${attemptVersion}`,
            },
            body: { expectedVersion: attemptVersion, reason: `[MCP] ${summary}` },
          },
        );
        bug = await this.getBug(bugId);
        return {
          principal: principalSummary(principal),
          bug,
          repairAttempt: started,
          resumed: true,
        };
      }
    }
    const state = String(bug["state"]);
    if (!["reported", "needs_info", "ready"].includes(state)) {
      throw new QaHubMcpError(
        "BUG_NOT_AVAILABLE_FOR_FIX",
        `Bug state ${state} cannot start a new MCP repair`,
        409,
      );
    }
    const ownerId = bug["ownerId"];
    if (ownerId !== null && ownerId !== userId) {
      throw new QaHubMcpError(
        "BUG_ASSIGNED_TO_OTHER_USER",
        "Bug is assigned to another user and MCP will not take it over",
        409,
      );
    }
    if (ownerId === null) {
      const version = integerArgument(bug, "version", 0, Number.MAX_SAFE_INTEGER);
      bug = bugRecord(
        await this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `mcp:assignBug:bug:${bugId}:v${version}:owner:${userId}`,
          },
          body: { expectedVersion: version, ownerId: userId },
        }),
      );
    }
    if (bug["state"] !== "ready") {
      const version = integerArgument(bug, "version", 0, Number.MAX_SAFE_INTEGER);
      bug = bugRecord(
        await this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/transitions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `workflow:transitionBug:bug:${bugId}:v${version}:ready`,
          },
          body: { expectedVersion: version, toState: "ready" },
        }),
      );
    }
    const bugVersion = integerArgument(bug, "version", 0, Number.MAX_SAFE_INTEGER);
    const attempt = requireRecord(
      await this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/repair-attempts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `workflow:createRepairAttempt:bug:${bugId}:v${bugVersion}`,
        },
        body: {
          expectedVersion: bugVersion,
          mode: "human",
          assigneeId: userId,
          summary: `[MCP] ${summary}`,
        },
      }),
      "repairAttempt",
    );
    const attemptId = requireUuid(attempt, "id");
    const attemptVersion = integerArgument(attempt, "version", 0, Number.MAX_SAFE_INTEGER);
    const started = await this.api.json(
      `/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `workflow:startRepairAttempt:attempt:${attemptId}:v${attemptVersion}`,
        },
        body: { expectedVersion: attemptVersion, reason: `[MCP] ${summary}` },
      },
    );
    bug = await this.getBug(bugId);
    workflow = await this.workflow(bugId);
    return {
      principal: principalSummary(principal),
      bug,
      repairAttempt: started,
      workflow,
      resumed: false,
      nextAction:
        "Inspect the repository, make the narrow fix, run real validation, commit, then call qa_submit_fix.",
    };
  }

  private async addComment(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, ["bugId", "body"]);
    const bugId = requireUuid(input, "bugId");
    const body = requireString(input, "body", 1, 10_000);
    const clientSubmissionId = randomUUID();
    return this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": QA_MEDIA_TYPE,
        "Idempotency-Key": `comment:${bugId}:${clientSubmissionId}`,
        "X-Correlation-ID": clientSubmissionId,
      },
      body: { clientSubmissionId, body },
    });
  }

  private async submitFix(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, [
      "attemptId",
      "summary",
      "validation",
      "branch",
      "commitSha",
      "mergeRequestUrl",
      "patchUrl",
    ]);
    const attemptId = requireUuid(input, "attemptId");
    const summary = requireString(input, "summary", 1, 7_000);
    const branch = requireString(input, "branch", 1, 300);
    const commitSha = requireString(input, "commitSha", 40, 40);
    if (!COMMIT_PATTERN.test(commitSha)) {
      throw new QaHubMcpError(
        "INVALID_ARGUMENTS",
        "commitSha must be a lowercase 40-character Git SHA",
      );
    }
    const validationValue = input["validation"];
    if (
      !Array.isArray(validationValue) ||
      validationValue.length < 1 ||
      validationValue.length > 20
    ) {
      throw new QaHubMcpError(
        "INVALID_ARGUMENTS",
        "validation must contain from 1 through 20 commands/results",
      );
    }
    const validation = validationValue.map((item, index) => {
      if (typeof item !== "string" || item.trim().length < 1 || item.length > 500) {
        throw new QaHubMcpError("INVALID_ARGUMENTS", `validation[${index}] is invalid`);
      }
      return item.trim();
    });
    const mergeRequestUrl = requireUrl(input, "mergeRequestUrl");
    const patchUrl = requireUrl(input, "patchUrl");
    const principal = await this.principal();
    const attempt = requireRecord(
      await this.api.json(`/api/v1/repair-attempts/${encodeURIComponent(attemptId)}`),
      "repairAttempt",
    );
    if (attempt["assigneeId"] !== principal["userId"]) {
      throw new QaHubMcpError(
        "REPAIR_ASSIGNED_TO_OTHER_USER",
        "RepairAttempt belongs to another user and MCP will not deliver it",
        403,
      );
    }
    if (attempt["status"] === "delivered") {
      if (attempt["commitSha"] !== commitSha) {
        throw new QaHubMcpError(
          "REPAIR_ALREADY_DELIVERED",
          "RepairAttempt was already delivered with a different commit",
          409,
        );
      }
      const bugId = requireUuid(attempt, "bugId");
      return {
        principal: principalSummary(principal),
        repairAttempt: attempt,
        bug: await this.getBug(bugId),
        workflow: await this.workflow(bugId),
        replayed: true,
        reporterConfirmationRequired: false,
      };
    }
    if (attempt["status"] !== "running") {
      throw new QaHubMcpError(
        "REPAIR_NOT_RUNNING",
        "RepairAttempt must be running before code can be delivered",
        409,
      );
    }
    const attemptVersion = integerArgument(attempt, "version", 0, Number.MAX_SAFE_INTEGER);
    const deliverySummary = [
      summary,
      "",
      "验证（由本地 AI 编辑器报告，QA Hub 未独立复验）：",
      ...validation.map((item) => `- ${item}`),
    ].join("\n");
    if (deliverySummary.length > 10_000) {
      throw new QaHubMcpError(
        "INVALID_ARGUMENTS",
        "summary and validation exceed 10000 characters",
      );
    }
    const delivered = requireRecord(
      await this.api.json(`/api/v1/repair-attempts/${encodeURIComponent(attemptId)}/deliver`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `workflow:deliverRepairAttempt:attempt:${attemptId}:v${attemptVersion}`,
        },
        body: {
          expectedVersion: attemptVersion,
          summary: deliverySummary,
          deliveryKind: "code",
          branch,
          commitSha,
          ...(mergeRequestUrl === undefined ? {} : { mergeRequestUrl }),
          ...(patchUrl === undefined ? {} : { patchUrl }),
        },
      }),
      "repairAttempt",
    );
    const bugId = requireUuid(delivered, "bugId");
    return {
      principal: principalSummary(principal),
      repairAttempt: delivered,
      bug: await this.getBug(bugId),
      workflow: await this.workflow(bugId),
      replayed: false,
      reporterConfirmationRequired: false,
      nextAction:
        "The code delivery now waits for an exact-commit Build. After it reaches ready_for_verification, the assigned closer can close it directly without reporter confirmation.",
    };
  }

  async call(name: string, argumentsValue: unknown): Promise<unknown> {
    switch (name) {
      case "qa_list_projects": {
        const input = requireRecord(argumentsValue, "arguments");
        onlyKeys(input, []);
        const principal = await this.principal();
        return { principal: principalSummary(principal), projects: await this.listProjects() };
      }
      case "qa_list_bugs":
        return this.listBugs(argumentsValue);
      case "qa_get_bug_context":
        return this.bugContext(argumentsValue);
      case "qa_materialize_attachment":
        return this.materializeAttachment(argumentsValue);
      case "qa_begin_fix":
        return this.beginFix(argumentsValue);
      case "qa_add_comment":
        return this.addComment(argumentsValue);
      case "qa_submit_fix":
        return this.submitFix(argumentsValue);
      default:
        throw new QaHubMcpError("TOOL_NOT_FOUND", `Unknown QA Hub MCP tool: ${name}`, 404);
    }
  }
}
