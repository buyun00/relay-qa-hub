import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { DesktopConfig } from "./config.js";
import { isAllowedNetworkUrl } from "./config.js";
import { DesktopBrowserSessionCookieStore, readBoundedBody } from "./network.js";
import { commitRememberedIdentity, RememberedIdentityCommitError } from "./remembered-identity.js";
import { callProductionTool, PRODUCTION_MCP_TOOLS } from "./mcp-production.js";

const QA_MEDIA_TYPE = "application/vnd.relay-qa-hub.v1.1+json";
const MAX_JSON_BYTES = 48 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TERMINAL_STATES = new Set(["closed", "deferred", "rejected", "duplicate"]);
const RECOVERABLE_SESSION_CODES = new Set(["UNAUTHENTICATED", "NATIVE_SESSION_INVALID"]);
const CAPTURE_ARTIFACT_MEDIA_TYPES: Readonly<Record<string, readonly string[]>> = {
  system_screenshot: ["image/png", "image/jpeg", "image/webp"],
  system_recording: ["video/mp4", "video/webm"],
  poco_screenshot: ["image/png", "image/jpeg", "image/webp"],
  poco_hierarchy: ["application/json"],
  poco_profiling: ["application/json"],
  poco_snapshot: ["application/json"],
};
const CAPTURE_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/json": "json",
};

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
  readonly scopeEpoch?: () => number;
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
  private sessionRecovery: { readonly epoch: number; readonly promise: Promise<void> } | null =
    null;

  constructor(
    private readonly config: DesktopConfig,
    private readonly browserSession: DesktopBrowserSessionCookieStore,
    fetchImpl: FetchImplementation = fetch,
    private readonly onSessionRenewed: () => void | Promise<void> = () => undefined,
  ) {
    this.fetchImpl = fetchImpl;
  }

  scopeEpoch(): number {
    return this.browserSession.scopeEpoch();
  }

  private assertAuthentication(epoch: number): void {
    if (!this.browserSession.isCurrentAuthentication(epoch))
      throw new QaHubMcpError("QA_HUB_SESSION_CHANGED", "The active QA Hub identity changed", 409);
  }

  private async commitSessionIdentity(): Promise<void> {
    try {
      await commitRememberedIdentity(this.browserSession, this.onSessionRenewed);
    } catch (error) {
      if (!(error instanceof RememberedIdentityCommitError)) throw error;
      throw new QaHubMcpError(error.code, error.message, error.status);
    }
  }

  private async credentialHeaders(epoch: number): Promise<Headers> {
    this.assertAuthentication(epoch);
    const headers = new Headers({ Accept: QA_MEDIA_TYPE });
    if (this.config.accessToken !== null) {
      headers.set("Authorization", `Bearer ${this.config.accessToken}`);
      return headers;
    }
    let cookie = this.browserSession.cookieHeader(null);
    if (cookie === null) {
      await this.recoverPermanentSession(epoch);
      this.assertAuthentication(epoch);
      cookie = this.browserSession.cookieHeader(null);
    }
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

  private async createPermanentSession(epoch: number): Promise<void> {
    this.assertAuthentication(epoch);
    const name = this.browserSession.rememberedLoginName();
    const projectId = this.browserSession.rememberedProjectId();
    if (
      name === null ||
      projectId === null ||
      this.browserSession.rememberedIdentity() !== "employee" ||
      !this.browserSession.canRecoverAuthentication(epoch)
    ) {
      throw new QaHubMcpError(
        "QA_HUB_LOGIN_REQUIRED",
        "Open Relay QA Hub EXE and sign in once before using its MCP tools",
        401,
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint("/api/v1/auth/login"), {
        method: "POST",
        headers: {
          Accept: QA_MEDIA_TYPE,
          "Content-Type": "application/json",
          Origin: this.config.csrfOrigin,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ name, projectId, client: "web" }),
      });
    } catch {
      this.assertAuthentication(epoch);
      throw new QaHubMcpError(
        "QA_HUB_UNAVAILABLE",
        "Relay QA Hub API is unavailable from the EXE",
        503,
      );
    }
    this.assertAuthentication(epoch);
    if (response.status >= 300 && response.status < 400) {
      throw new QaHubMcpError("QA_HUB_REDIRECT_BLOCKED", "QA Hub API redirect was blocked", 502);
    }
    const bytes = await readBoundedBody(response, MAX_JSON_BYTES);
    this.assertAuthentication(epoch);
    const parsed = parseJsonBytes(bytes);
    if (!response.ok) {
      const code = responseErrorCode(parsed, `QA_HUB_HTTP_${response.status}`);
      throw new QaHubMcpError(
        code,
        `QA Hub rejected permanent identity recovery (${code})`,
        response.status,
      );
    }
    const principal = requireRecord(parsed, "principal");
    this.browserSession.captureSetCookie(response.headers.get("set-cookie"));
    this.browserSession.rememberPrincipal(principal);
    if (this.browserSession.cookieHeader(null) === null) {
      throw new QaHubMcpError(
        "QA_HUB_INVALID_RESPONSE",
        "QA Hub did not return a permanent browser session",
        502,
      );
    }
    await this.commitSessionIdentity();
  }

  private async recoverPermanentSession(epoch: number): Promise<void> {
    this.assertAuthentication(epoch);
    if (this.sessionRecovery?.epoch !== epoch) {
      const promise = this.createPermanentSession(epoch).finally(() => {
        if (this.sessionRecovery?.promise === promise) this.sessionRecovery = null;
      });
      this.sessionRecovery = { epoch, promise };
    }
    return this.sessionRecovery.promise;
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

  private async csrfToken(epoch: number): Promise<string> {
    const principal = await this.requestJson("/api/v1/auth/me", { method: "GET" }, false, epoch);
    const record = requireRecord(principal, "principal");
    return requireString(record, "csrfToken", 1, 512);
  }

  private async requestOnce(
    pathname: string,
    request: QaHubJsonRequest,
    includeCsrf: boolean,
    maxBytes: number,
    epoch: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly headers: Headers; readonly status: number }> {
    const method = request.method ?? "GET";
    const publicRequest = [
      "/api/v1/auth/login",
      "/api/v1/auth/gm/login",
      "/api/v1/mcp/tools",
    ].includes(pathname);
    const csrfToken =
      !publicRequest && method !== "GET" && this.config.accessToken === null && includeCsrf
        ? await this.csrfToken(epoch)
        : null;
    const headers = publicRequest
      ? new Headers({ Accept: QA_MEDIA_TYPE })
      : await this.credentialHeaders(epoch);
    for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
    if (method !== "GET") {
      headers.set("Origin", this.config.csrfOrigin);
      if (csrfToken !== null) headers.set("X-CSRF-Token", csrfToken);
    }
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      if (
        Buffer.byteLength(body, "utf8") >
        (["/api/v1/production/uploads", "/api/v1/mcp/call"].includes(pathname)
          ? 36 * 1024 * 1024
          : 1024 * 1024)
      ) {
        throw new QaHubMcpError("QA_HUB_REQUEST_TOO_LARGE", "QA Hub MCP request is too large");
      }
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
    let response: Response;
    this.assertAuthentication(epoch);
    try {
      response = await this.fetchImpl(this.endpoint(pathname), {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(pathname === "/api/v1/production/uploads" ? 60_000 : 20_000),
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new QaHubMcpError(
        "QA_HUB_UNAVAILABLE",
        "Relay QA Hub API is unavailable from the EXE",
        503,
      );
    }
    this.assertAuthentication(epoch);
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
    this.assertAuthentication(epoch);
    this.browserSession.captureSetCookie(response.headers.get("set-cookie"));
    if (!response.ok) {
      const parsed = parseJsonBytes(bytes);
      const code = responseErrorCode(parsed, `QA_HUB_HTTP_${response.status}`);
      throw new QaHubMcpError(code, `QA Hub rejected the MCP operation (${code})`, response.status);
    }
    return { bytes, headers: response.headers, status: response.status };
  }

  private async request(
    pathname: string,
    request: QaHubJsonRequest,
    includeCsrf: boolean,
    maxBytes: number,
    epoch: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly headers: Headers; readonly status: number }> {
    try {
      return await this.requestOnce(pathname, request, includeCsrf, maxBytes, epoch);
    } catch (error) {
      this.assertAuthentication(epoch);
      if (
        this.config.accessToken !== null ||
        ["/api/v1/auth/login", "/api/v1/auth/gm/login", "/api/v1/auth/logout"].includes(pathname) ||
        !(error instanceof QaHubMcpError) ||
        error.status !== 401 ||
        !RECOVERABLE_SESSION_CODES.has(error.code)
      ) {
        throw error;
      }
      await this.recoverPermanentSession(epoch);
      this.assertAuthentication(epoch);
      return this.requestOnce(pathname, request, includeCsrf, maxBytes, epoch);
    }
  }

  private async requestJson(
    pathname: string,
    request: QaHubJsonRequest,
    includeCsrf: boolean,
    epoch: number,
  ): Promise<unknown> {
    const response = await this.request(
      pathname,
      request,
      includeCsrf,
      pathname.startsWith("/api/v1/production/attachments/") ? 36 * 1024 * 1024 : MAX_JSON_BYTES,
      epoch,
    );
    this.assertAuthentication(epoch);
    const value = parseJsonBytes(response.bytes);
    if (["/api/v1/auth/login", "/api/v1/auth/gm/login"].includes(pathname)) {
      this.browserSession.rememberPrincipal(value);
      await this.commitSessionIdentity();
    } else if (pathname === "/api/v1/auth/logout") {
      this.browserSession.clearLoginName();
      await this.commitSessionIdentity();
    }
    return value;
  }

  async json(pathname: string, request: QaHubJsonRequest = {}): Promise<unknown> {
    const authenticationChange =
      request.method === "POST" &&
      ["/api/v1/auth/login", "/api/v1/auth/gm/login", "/api/v1/auth/logout"].includes(pathname);
    const epoch = authenticationChange
      ? this.browserSession.beginAuthenticationChange()
      : this.browserSession.authenticationEpoch();
    try {
      return await this.requestJson(pathname, request, true, epoch);
    } finally {
      if (authenticationChange) this.browserSession.finishAuthenticationChange(epoch);
    }
  }

  async binary(pathname: string): Promise<QaHubBinaryResponse> {
    const response = await this.request(
      pathname,
      { method: "GET", headers: { Accept: "application/octet-stream" } },
      false,
      MAX_ATTACHMENT_BYTES,
      this.browserSession.authenticationEpoch(),
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
const EXTERNAL_STATE_WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});

export const QA_HUB_MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  ...PRODUCTION_MCP_TOOLS,
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
      "把 Bug 的普通附件或关联采集包中的 Poco 快照、UI 树等附件下载到 EXE 的只读 MCP 缓存，校验大小和 SHA-256，并返回本地绝对路径供 AI 编辑器读取。",
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
      "提交当前 RepairAttempt 的分支、40 位提交 SHA、修复摘要和实际验证命令。代码交付后任务显示为已完成待验收，精确构建匹配仍作为内部验收证据；项目内任意成员均可在详情直接关闭，无需人员身份确认。",
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
  {
    name: "qa_resolve_qingyu_bug",
    title: "按 QA Hub 单号解决关联轻语单",
    description:
      "输入 QA Hub 单号（例如 LOCAL-83 或 83），定位唯一单子和它关联的轻语 Bug，并把轻语状态改为“已解决”后回读确认。此工具只补做轻语同步，不会跳过或改写 QA Hub 的人工验收状态。",
    inputSchema: {
      type: "object",
      properties: {
        bugNumber: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: 100 },
            { type: "integer", minimum: 1 },
          ],
        },
        projectId: { type: "string", format: "uuid" },
      },
      required: ["bugNumber"],
      additionalProperties: false,
    },
    annotations: EXTERNAL_STATE_WRITE,
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

function requireBugNumber(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (Number.isSafeInteger(value) && (value as number) > 0) return String(value);
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 100) {
    throw new QaHubMcpError("INVALID_ARGUMENTS", `${key} is invalid`);
  }
  return value.trim();
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

function attachmentCaptureIds(items: readonly unknown[]): string[] {
  return [
    ...new Set(
      items.flatMap((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const captureId = (item as Record<string, unknown>)["captureId"];
        return typeof captureId === "string" && UUID_PATTERN.test(captureId) ? [captureId] : [];
      }),
    ),
  ];
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
  private sharedDefinitions: readonly McpToolDefinition[] = [];
  get definitions(): readonly McpToolDefinition[] {
    return this.options.sharedApi ? this.sharedDefinitions : QA_HUB_MCP_TOOLS;
  }

  constructor(
    private readonly api: QaHubApiTransport,
    private readonly attachmentCacheRoot: string,
    private readonly options: {
      readonly sharedApi?: boolean;
      readonly serviceOrigin?: string;
    } = {},
  ) {}

  async refreshDefinitions(): Promise<void> {
    if (!this.options.sharedApi) return;
    const catalog = requireRecord(await this.api.json("/api/v1/mcp/tools"), "catalog");
    if (!Array.isArray(catalog["tools"]))
      throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "Invalid server tool catalog");
    this.sharedDefinitions = catalog["tools"].map((value) => {
      const tool = requireRecord(value, "tool");
      requireString(tool, "name", 1, 128);
      return tool as unknown as McpToolDefinition;
    });
  }

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

  private async bugByNumber(
    reference: string,
    projectId?: string,
  ): Promise<Record<string, unknown>> {
    if (UUID_PATTERN.test(reference)) {
      const bug = await this.getBug(reference.toLowerCase());
      if (projectId !== undefined && bug["projectId"] !== projectId) {
        throw new QaHubMcpError(
          "BUG_NOT_FOUND",
          "The QA Hub Bug does not belong to the requested project",
          404,
        );
      }
      return bug;
    }
    const query = new URLSearchParams({ limit: "500", q: reference });
    if (projectId !== undefined) query.set("projectId", projectId);
    const response = requireRecord(await this.api.json(`/api/v1/bugs?${query.toString()}`), "bugs");
    const items = response["items"];
    if (!Array.isArray(items)) {
      throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "Bug list items are invalid");
    }
    const normalized = reference.toUpperCase();
    const numeric = /^\d+$/u.test(reference) ? Number(reference) : null;
    const matches = items
      .map((item) => bugRecord(item))
      .filter(
        (item) =>
          String(item["key"]).toUpperCase() === normalized ||
          (numeric !== null && Number.isSafeInteger(numeric) && item["number"] === numeric),
      );
    if (matches.length === 0) {
      throw new QaHubMcpError(
        "BUG_NOT_FOUND",
        `No visible QA Hub Bug exactly matches ${reference}`,
        404,
      );
    }
    if (matches.length > 1) {
      throw new QaHubMcpError(
        "BUG_NUMBER_AMBIGUOUS",
        `More than one visible QA Hub Bug matches ${reference}; provide its full key and projectId`,
        409,
      );
    }
    return matches[0]!;
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
    const captureIds = attachmentCaptureIds(attachmentItems);
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
        "Local AI may deliver code and validation evidence. Any signed-in project member may accept, close, or delete the Bug from its details view.",
    };
  }

  private async downloadCaptureAttachment(
    bug: Record<string, unknown>,
    items: readonly unknown[],
    attachmentId: string,
  ): Promise<{
    readonly metadata: Record<string, unknown>;
    readonly response: QaHubBinaryResponse;
  } | null> {
    // Capture artifacts inherit the Bug binding through the primary screenshot.
    // They are intentionally absent from the ordinary Bug attachment list.
    for (const captureId of attachmentCaptureIds(items)) {
      let value: unknown;
      try {
        value = await this.api.json(`/api/v1/capture-bundles/${encodeURIComponent(captureId)}`);
      } catch (error) {
        if (error instanceof QaHubMcpError && error.status === 404) continue;
        throw error;
      }
      const capture = requireRecord(value, "capture");
      if (
        capture["captureId"] !== captureId ||
        capture["projectId"] !== bug["projectId"] ||
        !items.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            (item as Record<string, unknown>)["captureId"] === captureId &&
            (item as Record<string, unknown>)["attachmentId"] ===
              capture["primaryEvidenceAttachmentId"],
        )
      ) {
        throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "capture binding is invalid");
      }
      const artifacts = capture["artifacts"];
      if (!Array.isArray(artifacts)) {
        throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "capture artifacts are invalid");
      }
      const artifactValue = artifacts.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>)["attachmentId"] === attachmentId &&
          (item as Record<string, unknown>)["status"] === "succeeded",
      );
      if (artifactValue === undefined) continue;
      const artifact = requireRecord(artifactValue, "capture artifact");
      const kind = requireString(artifact, "kind", 1, 100);
      const mediaTypes = Object.hasOwn(CAPTURE_ARTIFACT_MEDIA_TYPES, kind)
        ? CAPTURE_ARTIFACT_MEDIA_TYPES[kind]
        : undefined;
      if (artifact["captureId"] !== captureId || mediaTypes === undefined) {
        throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "capture artifact identity is invalid");
      }
      const response = await this.api.binary(
        `/api/v1/bugs/${encodeURIComponent(String(bug["id"]))}/capture-bundles/${encodeURIComponent(captureId)}/artifacts/${encodeURIComponent(kind)}`,
      );
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      if (!mediaTypes.includes(mediaType)) {
        throw new QaHubMcpError(
          "QA_HUB_INVALID_RESPONSE",
          "capture artifact media type is invalid",
        );
      }
      return {
        metadata: {
          filename: `capture-${captureId}-${kind}.${CAPTURE_MEDIA_EXTENSIONS[mediaType]}`,
          mediaType,
          size: Number(response.headers.get("content-length")),
          sha256: response.headers.get("x-content-sha256"),
        },
        response,
      };
    }
    return null;
  }

  private async materializeAttachment(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, ["projectId", "bugId", "attachmentId"]);
    const bugId = requireUuid(input, "bugId");
    const attachmentId = requireUuid(input, "attachmentId");
    const scopeEpoch = this.api.scopeEpoch?.();
    const assertScope = () => {
      if (scopeEpoch !== undefined && this.api.scopeEpoch?.() !== scopeEpoch)
        throw new QaHubMcpError(
          "QA_HUB_SESSION_CHANGED",
          "The attachment request belongs to a previous identity or project",
          409,
        );
    };
    const principal = this.options.sharedApi ? await this.principal() : null;
    assertScope();
    const bug = await this.getBug(bugId);
    assertScope();
    if (this.options.sharedApi && bug["projectId"] !== requireUuid(input, "projectId")) {
      throw new QaHubMcpError(
        "PROJECT_MISMATCH",
        "Attachment project does not match the requested Bug",
        404,
      );
    }
    const items: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const list = requireRecord(
        await this.api.json(
          `/api/v1/bugs/${encodeURIComponent(bugId)}/attachments?limit=50${suffix}`,
        ),
        "attachments",
      );
      assertScope();
      if (!Array.isArray(list["items"]))
        throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "attachment list is invalid");
      items.push(...list["items"]);
      const next = list["nextCursor"];
      if (next === null || next === undefined) cursor = null;
      else if (typeof next !== "string" || !next || next.length > 8192 || seenCursors.has(next))
        throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "attachment cursor is invalid");
      else {
        cursor = next;
        seenCursors.add(next);
      }
      if (
        items.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            (item as Record<string, unknown>)["attachmentId"] === attachmentId,
        )
      )
        break;
    } while (cursor !== null);
    let metadataValue = items.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>)["attachmentId"] === attachmentId,
    );
    let captureResponse: QaHubBinaryResponse | undefined;
    if (metadataValue === undefined) {
      const capture = await this.downloadCaptureAttachment(bug, items, attachmentId);
      metadataValue = capture?.metadata;
      captureResponse = capture?.response;
    }
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
      (expectedSize as number) < 1 ||
      (expectedSize as number) > MAX_ATTACHMENT_BYTES
    ) {
      throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "attachment metadata is invalid");
    }
    const response =
      captureResponse ??
      (await this.api.binary(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`));
    assertScope();
    const actualSha = createHash("sha256").update(response.bytes).digest("hex");
    if (response.bytes.byteLength !== expectedSize || actualSha !== expectedSha) {
      throw new QaHubMcpError(
        "ATTACHMENT_INTEGRITY_MISMATCH",
        "Downloaded attachment did not match its QA Hub size and SHA-256",
      );
    }
    const cacheScope =
      principal === null
        ? "legacy"
        : createHash("sha256")
            .update(
              JSON.stringify([this.options.serviceOrigin, input["projectId"], principal["userId"]]),
            )
            .digest("hex");
    const directory = path.resolve(this.attachmentCacheRoot, cacheScope, bugId);
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
    assertScope();
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
      assertScope();
      await fs.writeFile(target, response.bytes, { flag: "wx", mode: 0o600 });
    }
    assertScope();
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
        "The code delivery now waits for an exact-commit Build. After it reaches ready_for_verification, any signed-in project member can close it directly without identity checks.",
    };
  }

  private async resolveQingyuBug(argumentsValue: unknown): Promise<unknown> {
    const input = requireRecord(argumentsValue, "arguments");
    onlyKeys(input, ["bugNumber", "projectId"]);
    const reference = requireBugNumber(input, "bugNumber");
    const projectId =
      input["projectId"] === undefined ? undefined : requireUuid(input, "projectId");
    const selectedBug = await this.bugByNumber(reference, projectId);
    const bugId = requireUuid(selectedBug, "id");
    const resolution = requireRecord(
      await this.api.json(`/api/v1/bugs/${encodeURIComponent(bugId)}/integrations/qingyu/resolve`, {
        method: "POST",
        headers: {
          "Idempotency-Key": `mcp:resolveQingyu:bug:${bugId}`,
        },
      }),
      "qingyuResolution",
    );
    const resolvedBug = bugRecord(resolution["bug"]);
    if (resolvedBug["id"] !== bugId) {
      throw new QaHubMcpError(
        "QA_HUB_INVALID_RESPONSE",
        "Qingyu resolution returned a different QA Hub Bug",
      );
    }
    const link = requireRecord(resolution["link"], "qingyuLink");
    const defectId = requireString(link, "defectId", 1, 200);
    const externalStatus = requireString(link, "externalStatus", 1, 200);
    if (link["syncStatus"] !== "succeeded") {
      throw new QaHubMcpError(
        "QINGYU_RESOLUTION_NOT_VERIFIED",
        "QA Hub did not persist a verified Qingyu resolution",
        409,
      );
    }
    if (typeof resolution["alreadyResolved"] !== "boolean") {
      throw new QaHubMcpError(
        "QA_HUB_INVALID_RESPONSE",
        "Qingyu resolution replay status is invalid",
      );
    }
    return {
      bug: resolvedBug,
      qingyuLink: link,
      defectId,
      externalStatus,
      alreadyResolved: resolution["alreadyResolved"],
      qaHubStateChanged: false,
      outcome: `轻语单 ${defectId} 已确认状态为“${externalStatus}”`,
    };
  }

  async call(name: string, argumentsValue: unknown): Promise<unknown> {
    if (this.options.sharedApi) {
      if (!this.sharedDefinitions.some((tool) => tool.name === name))
        throw new QaHubMcpError("TOOL_NOT_FOUND", `Unknown QA Hub MCP tool: ${name}`, 404);
      if (name === "qa_materialize_attachment") return this.materializeAttachment(argumentsValue);
      if (name === "qa_logout")
        return this.api.json("/api/v1/auth/logout", { method: "POST", body: {} });
      if (name === "qa_login_gm") {
        const args = requireRecord(argumentsValue, "arguments");
        onlyKeys(args, ["request", "projectId"]);
        const request = requireRecord(args["request"], "request");
        if (
          args["projectId"] !== undefined &&
          request["projectId"] !== undefined &&
          args["projectId"] !== request["projectId"]
        )
          throw new QaHubMcpError("PROJECT_MISMATCH", "Project identifiers must match", 400);
        return this.api.json("/api/v1/auth/gm/login", {
          method: "POST",
          body: {
            ...request,
            ...(args["projectId"] ? { projectId: args["projectId"] } : {}),
            client: "web",
          },
        });
      }
      if (name === "qa_login") {
        const args = requireRecord(argumentsValue, "arguments");
        onlyKeys(args, ["name", "projectId", "projectName", "code"]);
        const projectCodeLogin = args["projectName"] !== undefined || args["code"] !== undefined;
        return this.api.json("/api/v1/auth/login", {
          method: "POST",
          body: {
            name: requireString(args, "name", 1, 128),
            ...(projectCodeLogin
              ? {
                  projectName: requireString(args, "projectName", 1, 200),
                  code: requireString(args, "code", 4, 4),
                }
              : { projectId: requireUuid(args, "projectId") }),
            client: "web",
          },
        });
      }
      return this.api.json("/api/v1/mcp/call", {
        method: "POST",
        body: { name, arguments: argumentsValue },
      });
    }
    if (PRODUCTION_MCP_TOOLS.some((tool) => tool.name === name))
      return callProductionTool(name, argumentsValue, this.api, this.attachmentCacheRoot);
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
      case "qa_resolve_qingyu_bug":
        return this.resolveQingyuBug(argumentsValue);
      default:
        throw new QaHubMcpError("TOOL_NOT_FOUND", `Unknown QA Hub MCP tool: ${name}`, 404);
    }
  }
}
