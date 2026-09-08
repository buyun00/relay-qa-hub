import { basename, extname } from "node:path";

const LOGIN_STATUS = new Map([
  ["0", "pending"],
  ["1", "scanned"],
  ["2", "confirmed"],
  ["3", "expired"],
  ["4", "cancelled"],
]);
const TERMINAL_STATUS_KEYS = new Set([
  "ABORTED",
  "ARCHIVED",
  "CANCELED",
  "CANCELLED",
  "CLOSED",
  "COMPLETED",
  "DONE",
  "DUPLICATE",
  "FINISHED",
  "INVALID",
  "REJECTED",
  "RESOLVED",
  "TERMINATED",
  "TRANSFERRED",
  "VERIFIED",
  "VOID",
  "WONTFIX",
]);
const TERMINAL_STATUS_NAMES = new Set([
  "不予解决",
  "关闭",
  "取消",
  "完成",
  "已作废",
  "已关闭",
  "已取消",
  "已处理",
  "已完成",
  "已废弃",
  "已归档",
  "已拒绝",
  "已撤销",
  "已结束",
  "已解决",
  "已验证",
  "已终止",
  "拒绝",
  "结束",
  "终止",
  "转需求",
  "重复",
  "无需处理",
]);
const SUPPORTED_IMPORT_IMAGES = new Map([
  ["image/jpeg", { extension: ".jpg", extensions: new Set([".jpg", ".jpeg"]) }],
  ["image/png", { extension: ".png", extensions: new Set([".png"]) }],
  ["image/webp", { extension: ".webp", extensions: new Set([".webp"]) }],
]);
const MAX_IMAGE_REDIRECTS = 5;

export class QingyuError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "QingyuError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface QingyuUser {
  readonly id: string;
  readonly name: string;
  readonly avatar: string | null;
}

export interface QingyuCredentials {
  readonly token: string;
  readonly user: QingyuUser;
}

export interface QingyuLoginChallenge {
  readonly qrId: string;
  readonly pollToken: string | null;
  readonly qrContent: string;
  readonly status: "pending" | "scanned" | "expired" | "cancelled" | "error";
  readonly expiresAt: string;
}

export interface QingyuProject {
  readonly id: string;
  readonly name: string;
}

export interface QingyuDefect {
  readonly id: string;
  readonly code: string | null;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  readonly actualBehavior: string;
  readonly expectedBehavior: string;
  readonly status: string | null;
  readonly statusKey: string | null;
  readonly priority: string | null;
  readonly severity: string | null;
  readonly assignee: string | null;
  readonly updatedAt: string | null;
  readonly images: readonly string[];
  readonly url: string;
}

export interface QingyuDownloadedImage {
  readonly filename: string;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly bytes: Buffer;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nested(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    const item = record(current);
    if (item === null) return null;
    current = item[key];
  }
  return current;
}

function first(value: unknown, paths: readonly (string | readonly string[])[]): unknown {
  const item = record(value);
  if (item === null) return null;
  for (const path of paths) {
    const result = Array.isArray(path) ? nested(item, path) : item[path as string];
    if (result !== null && result !== undefined && result !== "") return result;
  }
  return null;
}

function asId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim();
  return normalized.length === 0 ? null : normalized;
}

function richText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value))
    return value
      .map((item) => richText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  const item = record(value);
  if (item === null) return "";
  if (typeof item["text"] === "string") return item["text"];
  for (const key of ["content", "children", "blocks", "value"]) {
    if (item[key] !== null && item[key] !== undefined) return richText(item[key], depth + 1);
  }
  return "";
}

function plainText(value: unknown): string {
  return richText(value)
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\r/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function dataFromPayload(payload: unknown): unknown {
  const root = record(payload);
  const data = root?.["data"] ?? payload;
  const item = record(data);
  return item?.["item"] ?? item?.["task"] ?? data;
}

function listFromPayload(payload: unknown): readonly unknown[] {
  const root = record(payload);
  const data = root?.["data"] ?? payload;
  if (Array.isArray(data)) return data;
  const item = record(data);
  for (const candidate of [item?.["list"], item?.["items"], item?.["records"], item?.["data"]]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function totalFromPayload(payload: unknown, fallback: number): number {
  const root = record(payload);
  const data = record(root?.["data"] ?? payload);
  const total = first(root, [
    ["meta", "total"],
    ["data", "meta", "total"],
    ["data", "total"],
    "total",
  ]);
  const parsed = Number(total ?? data?.["total"] ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUrl(value: unknown, baseUrl: string | null): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = baseUrl === null ? new URL(value.trim()) : new URL(value.trim(), baseUrl);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function collectImages(value: unknown, baseUrl: string): readonly string[] {
  const output = new Map<string, string>();
  const visit = (current: unknown, key = "", depth = 0): void => {
    if (depth > 7 || current === null || current === undefined || output.size >= 8) return;
    if (typeof current === "string") {
      const trustedField =
        /description|content|detail|attachment|file|image|img|screenshot|photo|picture/iu.test(key);
      if (!trustedField) return;
      for (const match of current.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/giu)) {
        const url = normalizeUrl(match[1], baseUrl);
        if (url !== null) output.set(new URL(url).pathname.toLowerCase(), url);
      }
      for (const match of current.matchAll(/https?:\/\/[^\s"'<>]+/giu)) {
        const url = normalizeUrl(match[0], baseUrl);
        if (
          url !== null &&
          (/image|attachment|upload|asset/iu.test(url) ||
            /\.(png|jpe?g|webp)(?:$|[?#])/iu.test(url))
        ) {
          output.set(new URL(url).pathname.toLowerCase(), url);
        }
      }
      if (/image|img|screenshot|photo|picture|url|src/iu.test(key)) {
        const url = normalizeUrl(current, baseUrl);
        if (url !== null) output.set(new URL(url).pathname.toLowerCase(), url);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child, key, depth + 1);
      return;
    }
    const item = record(current);
    if (item === null) return;
    for (const [childKey, child] of Object.entries(item)) {
      if (/avatar|cover|icon|logo|portrait|profile/iu.test(childKey)) continue;
      visit(child, childKey, depth + 1);
    }
  };
  visit(value);
  return [...output.values()].slice(0, 8);
}

function statusIdentity(value: unknown): { readonly key: string; readonly name: string } {
  if (typeof value === "string" || typeof value === "number") {
    const text = plainText(value);
    return { key: text.toUpperCase(), name: text };
  }
  return {
    key: String(first(value, ["status_key", "key", "code", "status"]) ?? "").toUpperCase(),
    name: plainText(first(value, ["name", "status_name", "label"])),
  };
}

function canonicalStatus(value: string): string {
  return value
    .trim()
    .replace(/[\s_-]+/gu, "")
    .toUpperCase();
}

export function isActionableQingyuDefect(
  defect: Pick<QingyuDefect, "status" | "statusKey">,
): boolean {
  const status = statusIdentity(
    defect.statusKey === null
      ? defect.status
      : { status_key: defect.statusKey, name: defect.status },
  );
  const key = canonicalStatus(status.key);
  const name = (status.name || defect.status || "").replace(/\s+/gu, "");
  return !TERMINAL_STATUS_KEYS.has(key) && !TERMINAL_STATUS_NAMES.has(name);
}

function isResolved(value: unknown): boolean {
  const status = statusIdentity(value);
  return (
    ["RESOLVED", "CLOSED", "VERIFIED", "COMPLETED", "DONE"].includes(canonicalStatus(status.key)) ||
    ["已解决", "已关闭", "已验证", "已完成"].includes(status.name)
  );
}

function normalizeUser(value: unknown): QingyuUser | null {
  const id = asId(first(value, ["ID", "id", "user_id", "UserID"]));
  if (id === null) return null;
  const name = plainText(
    first(value, ["nickname", "name", "username", "display_name", "phone", "email"]),
  );
  return {
    id,
    name: name || `用户 ${id}`,
    avatar: normalizeUrl(first(value, ["avatar", "avatar_url"]), null),
  };
}

function normalizeProject(value: unknown): QingyuProject | null {
  const id = asId(first(value, ["ID", "id", "project_id"]));
  if (id === null) return null;
  return { id, name: plainText(first(value, ["name", "project_name", "title"])) || `项目 ${id}` };
}

function splitSteps(value: unknown): readonly string[] {
  const text = plainText(value);
  if (text.length === 0) return [];
  return text
    .split(/\n+/gu)
    .map((line) => line.replace(/^\s*(?:\d+[.)、]|[-*])\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 50);
}

function normalizeDefect(value: unknown, baseUrl: string): QingyuDefect | null {
  const id = asId(first(value, ["ID", "id", "task_id", "TaskID", "bug_id"]));
  if (id === null) return null;
  const code = asId(first(value, ["bug_no", "task_no", "serial_no", "code", "number", "key"]));
  const description = plainText(first(value, ["description", "content", "detail", "details"]));
  const steps = splitSteps(first(value, ["reproduce_steps", "reproduction_steps", "steps"]));
  const actual = plainText(first(value, ["actual_result", "actual_behavior"]));
  const expected = plainText(
    first(value, ["expected_result", "acceptance_criteria", "expected_behavior"]),
  );
  const statusValue = first(value, [
    "bug_status_name",
    "status_name",
    ["bug_status", "name"],
    ["status", "name"],
    "status",
  ]);
  const statusKeyValue = first(value, [
    "bug_status_key",
    "status_key",
    ["bug_status", "status_key"],
    ["status", "status_key"],
    ["bug_status", "key"],
    ["status", "key"],
  ]);
  const title = plainText(first(value, ["title", "name", "subject", "summary"]));
  const normalizedTitle = title || `未命名缺陷 ${code ?? id}`;
  const normalizedDescription = description || actual;
  return {
    id,
    code,
    title: normalizedTitle,
    description: normalizedDescription,
    steps: steps.length === 0 ? [normalizedDescription || normalizedTitle] : steps,
    actualBehavior: actual || description || normalizedTitle,
    expectedBehavior: expected || "问题修复后不再复现",
    status: statusValue === null ? null : plainText(statusValue),
    statusKey: statusKeyValue === null ? null : String(statusKeyValue).trim().toUpperCase() || null,
    priority: (() => {
      const item = first(value, ["priority_name", ["priority", "name"], "priority"]);
      return item === null ? null : plainText(item);
    })(),
    severity: (() => {
      const item = first(value, ["severity_name", ["severity", "name"], "severity"]);
      return item === null ? null : plainText(item);
    })(),
    assignee: (() => {
      const item = first(value, [
        "assignee_name",
        ["assignee", "nickname"],
        ["assignee", "name"],
        ["assignee_user", "nickname"],
        ["assignee_user", "name"],
      ]);
      return item === null ? null : plainText(item);
    })(),
    updatedAt: (() => {
      const item = first(value, ["updated_at", "update_time", "UpdatedAt", "modified_at"]);
      return item === null ? null : String(item);
    })(),
    images: collectImages(value, baseUrl),
    url: new URL(`/tasks/${encodeURIComponent(id)}`, baseUrl).toString(),
  };
}

function mergeDefects(summary: QingyuDefect, detail: QingyuDefect): QingyuDefect {
  return {
    ...summary,
    ...detail,
    id: summary.id,
    code: detail.code ?? summary.code,
    images: detail.images.length > 0 ? detail.images : summary.images,
  };
}

function numericId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .trim()
    .slice(0, 180);
  return cleaned || "qingyu-image";
}

function sniffImage(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

async function readBoundedBody(response: Response, limitBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limitBytes)
    throw new QingyuError(413, "QINGYU_IMAGE_TOO_LARGE", `轻语图片超过单张 ${limitBytes} 字节限制`);
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    size += chunk.length;
    if (size > limitBytes) {
      await reader.cancel();
      throw new QingyuError(
        413,
        "QINGYU_IMAGE_TOO_LARGE",
        `轻语图片超过单张 ${limitBytes} 字节限制`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export class QingyuClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;

  constructor(
    options: {
      readonly baseUrl?: string;
      readonly timeoutMs?: number;
      readonly fetchImpl?: typeof fetch;
    } = {},
  ) {
    if (!options.baseUrl)
      throw new QingyuError(409, "COMPONENT_NOT_CONFIGURED", "轻语服务地址必须由项目配置提供");
    const configured = new URL(options.baseUrl);
    if (
      !["https:", "http:"].includes(configured.protocol) ||
      configured.username ||
      configured.password
    )
      throw new QingyuError(409, "COMPONENT_NOT_CONFIGURED", "轻语服务地址无效");
    this.baseUrl = configured.origin;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    pathname: string,
    options: {
      readonly method?: string;
      readonly query?: Readonly<Record<string, unknown>>;
      readonly body?: unknown;
      readonly token?: string;
    } = {},
  ): Promise<unknown> {
    const url = new URL(`/api${pathname}`, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== null && value !== undefined && value !== "")
        url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text.length === 0 ? null : JSON.parse(text);
      } catch {
        payload = null;
      }
      const root = record(payload);
      const upstreamCode = root?.["code"];
      if (
        !response.ok ||
        (upstreamCode !== undefined && upstreamCode !== null && Number(upstreamCode) !== 0)
      ) {
        const unauthorized = response.status === 401 || Number(upstreamCode) === 401;
        const message =
          plainText(first(root, ["message", ["error", "message"]])) ||
          response.statusText ||
          "轻语请求失败";
        throw new QingyuError(
          unauthorized ? 401 : 502,
          unauthorized ? "QINGYU_AUTH_REQUIRED" : "QINGYU_UPSTREAM_FAILED",
          unauthorized ? "轻语登录已过期，请重新扫码" : message.slice(0, 600),
          { upstreamStatus: response.status, upstreamCode: upstreamCode ?? null },
        );
      }
      return payload;
    } catch (error: unknown) {
      if (error instanceof QingyuError) throw error;
      if (controller.signal.aborted)
        throw new QingyuError(504, "QINGYU_TIMEOUT", "轻语响应超时，请稍后重试");
      throw new QingyuError(
        502,
        "QINGYU_UNAVAILABLE",
        `无法连接轻语：${error instanceof Error ? error.message.slice(0, 240) : "未知错误"}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private authenticated(
    credentials: QingyuCredentials,
    pathname: string,
    options: Omit<Parameters<QingyuClient["request"]>[1], "token"> = {},
  ): Promise<unknown> {
    return this.request(pathname, { ...options, token: credentials.token });
  }

  async startLogin(): Promise<QingyuLoginChallenge> {
    const payload = await this.request("/auth/qr/home-generate", {
      method: "POST",
      body: { app_type: "project", secure: true },
    });
    const data = dataFromPayload(payload);
    const qrId = asId(first(data, ["qr_id"]));
    const qrContent = plainText(first(data, ["qr_content"]));
    if (qrId === null || qrContent.length === 0)
      throw new QingyuError(502, "QINGYU_QR_INVALID", "轻语没有返回有效二维码");
    return {
      qrId,
      pollToken: asId(first(data, ["poll_token"])),
      qrContent,
      status: "pending",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  async pollLogin(challenge: QingyuLoginChallenge): Promise<{
    readonly challenge: QingyuLoginChallenge | null;
    readonly credentials: QingyuCredentials | null;
  }> {
    const payload = await this.request("/auth/qr/home-status", {
      query: { qr_id: challenge.qrId, poll_token: challenge.pollToken },
    });
    const data = dataFromPayload(payload);
    const normalized =
      LOGIN_STATUS.get(String(first(data, ["status"]) ?? "").toLowerCase()) ?? "error";
    if (normalized !== "confirmed")
      return {
        challenge: { ...challenge, status: normalized as QingyuLoginChallenge["status"] },
        credentials: null,
      };
    const ticket = plainText(first(data, ["ticket"]));
    const phone = plainText(first(data, ["phone"]));
    if (ticket.length === 0 || phone.length === 0)
      throw new QingyuError(
        502,
        "QINGYU_QR_CONFIRMATION_INVALID",
        "扫码确认信息不完整，请重新生成二维码",
      );
    const exchange = dataFromPayload(
      await this.request("/auth/qr/exchange", { method: "POST", body: { ticket, phone } }),
    );
    const token = plainText(first(exchange, ["token"]));
    const user = normalizeUser(first(exchange, ["user"]));
    if (token.length === 0 || user === null)
      throw new QingyuError(502, "QINGYU_LOGIN_INVALID", "轻语扫码成功，但用户信息不完整");
    return { challenge: null, credentials: { token, user } };
  }

  async listProjects(credentials: QingyuCredentials): Promise<readonly QingyuProject[]> {
    const payload = await this.authenticated(credentials, "/projects", {
      query: { page: 1, page_size: 200 },
    });
    return listFromPayload(payload)
      .map(normalizeProject)
      .filter((item): item is QingyuProject => item !== null);
  }

  async currentUser(credentials: QingyuCredentials): Promise<QingyuUser> {
    // The QR exchange already returns and validates the authenticated user.
    // Reusing that identity matches Qingyu's browser flow and avoids depending
    // on the deployment-specific response envelope of /users/me.
    return credentials.user;
  }

  async getDefect(credentials: QingyuCredentials, defectId: string): Promise<QingyuDefect> {
    const payload = await this.authenticated(credentials, `/tasks/${encodeURIComponent(defectId)}`);
    const defect = normalizeDefect(dataFromPayload(payload), this.baseUrl);
    if (defect === null)
      throw new QingyuError(502, "QINGYU_DEFECT_INVALID", "轻语返回的 Bug 详情不完整");
    return defect;
  }

  async listOwnDefects(
    credentials: QingyuCredentials,
    externalProjectId: string,
    options: { readonly page?: number; readonly pageSize?: number; readonly search?: string } = {},
  ): Promise<{
    readonly defects: readonly QingyuDefect[];
    readonly total: number;
    readonly user: QingyuUser;
  }> {
    const user = await this.currentUser(credentials);
    const payload = await this.authenticated(credentials, "/tasks", {
      query: {
        project_id: externalProjectId,
        type: "bug",
        assignee_id: user.id,
        page: options.page ?? 1,
        page_size: options.pageSize ?? 100,
        include_stats: 1,
        search: options.search?.trim() || null,
      },
    });
    const summaries = listFromPayload(payload)
      .map((item) => normalizeDefect(item, this.baseUrl))
      .filter((item): item is QingyuDefect => item !== null);
    const defects: QingyuDefect[] = [];
    for (let offset = 0; offset < summaries.length; offset += 6) {
      defects.push(
        ...(await Promise.all(
          summaries.slice(offset, offset + 6).map(async (summary) => {
            try {
              return mergeDefects(summary, await this.getDefect(credentials, summary.id));
            } catch (error: unknown) {
              if (error instanceof QingyuError && error.status === 401) throw error;
              return summary;
            }
          }),
        )),
      );
    }
    return { defects, total: totalFromPayload(payload, summaries.length), user };
  }

  async downloadImage(
    credentials: QingyuCredentials,
    imageUrl: string,
    index: number,
    limitBytes = 25 * 1024 * 1024,
  ): Promise<QingyuDownloadedImage | null> {
    let url = normalizeUrl(imageUrl, null);
    if (url === null)
      throw new QingyuError(502, "QINGYU_IMAGE_URL_INVALID", `轻语第 ${index + 1} 张图片地址无效`);
    for (let redirects = 0; redirects <= MAX_IMAGE_REDIRECTS; redirects += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const parsed = new URL(url);
        const sameOrigin = parsed.origin === this.baseUrl;
        const response = await this.fetchImpl(parsed, {
          method: "GET",
          headers: {
            Accept: "image/webp,image/png,image/jpeg,*/*;q=0.1",
            ...(sameOrigin ? { Authorization: `Bearer ${credentials.token}` } : {}),
          },
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null || redirects === MAX_IMAGE_REDIRECTS)
            throw new QingyuError(
              502,
              "QINGYU_IMAGE_REDIRECT_INVALID",
              `轻语第 ${index + 1} 张图片重定向无效`,
            );
          url = normalizeUrl(location, url);
          if (url === null)
            throw new QingyuError(
              502,
              "QINGYU_IMAGE_URL_INVALID",
              `轻语第 ${index + 1} 张图片重定向地址无效`,
            );
          continue;
        }
        if (!response.ok) {
          if (sameOrigin && response.status === 401)
            throw new QingyuError(401, "QINGYU_AUTH_REQUIRED", "轻语登录已过期，请重新扫码");
          throw new QingyuError(
            502,
            "QINGYU_IMAGE_DOWNLOAD_FAILED",
            `轻语第 ${index + 1} 张图片下载失败（HTTP ${response.status}）`,
          );
        }
        const bytes = await readBoundedBody(response, limitBytes);
        const mediaType = sniffImage(bytes);
        if (mediaType === null) return null;
        const imageType = SUPPORTED_IMPORT_IMAGES.get(mediaType);
        if (imageType === undefined) return null;
        let filename = safeFilename(
          basename(parsed.pathname) || `qingyu-${index + 1}${imageType.extension}`,
        );
        const extension = extname(filename).toLowerCase();
        if (!imageType.extensions.has(extension))
          filename = `${extension.length > 0 ? filename.slice(0, -extension.length) : filename}${imageType.extension}`;
        return { filename, mediaType, bytes };
      } catch (error: unknown) {
        if (error instanceof QingyuError) throw error;
        if (controller.signal.aborted)
          throw new QingyuError(504, "QINGYU_IMAGE_TIMEOUT", `轻语第 ${index + 1} 张图片下载超时`);
        throw new QingyuError(
          502,
          "QINGYU_IMAGE_DOWNLOAD_FAILED",
          `轻语第 ${index + 1} 张图片下载失败`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  async downloadImages(
    credentials: QingyuCredentials,
    defect: QingyuDefect,
  ): Promise<{ readonly images: readonly QingyuDownloadedImage[]; readonly skipped: number }> {
    const images: QingyuDownloadedImage[] = [];
    let skipped = 0;
    let total = 0;
    for (const [index, url] of defect.images.slice(0, 8).entries()) {
      const image = await this.downloadImage(credentials, url, index);
      if (image === null) {
        skipped += 1;
        continue;
      }
      total += image.bytes.length;
      if (total > 100 * 1024 * 1024)
        throw new QingyuError(
          413,
          "QINGYU_IMAGES_TOO_LARGE",
          "轻语 Bug 图片总计超过 100MB，已停止导入",
        );
      images.push(image);
    }
    return { images, skipped };
  }

  private async resolveVersion(
    credentials: QingyuCredentials,
    externalProjectId: string,
    task: JsonRecord,
  ): Promise<number> {
    const existing = numericId(
      first(task, [
        "resolve_version_id",
        "actual_version_id",
        "planned_version_id",
        "version_id",
        ["resolve_version", "ID"],
        ["actual_version", "ID"],
        ["planned_version", "ID"],
      ]),
    );
    if (existing !== null) return existing;
    const versions = listFromPayload(
      await this.authenticated(credentials, "/versions", {
        query: { project_id: externalProjectId },
      }),
    )
      .map((value, index) => ({
        id: numericId(first(value, ["ID", "id", "version_id"])),
        status: String(first(value, ["status", "status_key", "state"]) ?? "").toLowerCase(),
        index,
      }))
      .filter((item): item is { id: number; status: string; index: number } => item.id !== null)
      .sort((left, right) => {
        const rank = (status: string) =>
          ["in_progress", "active", "current", "进行中"].includes(status)
            ? 0
            : ["pending", "planned", "open", "未开始"].includes(status)
              ? 1
              : ["completed", "closed", "archived", "已完成"].includes(status)
                ? 3
                : 2;
        return rank(left.status) - rank(right.status) || left.index - right.index;
      });
    if (versions[0] === undefined)
      throw new QingyuError(
        409,
        "QINGYU_RESOLVE_VERSION_REQUIRED",
        "轻语工作流要求解决版本，但项目没有可用版本",
      );
    return versions[0].id;
  }

  async resolveDefect(
    credentials: QingyuCredentials,
    input: {
      readonly defectId: string;
      readonly externalProjectId: string;
      readonly expectedUserId: string;
      readonly expectedUserName: string;
    },
  ): Promise<{
    readonly defectId: string;
    readonly status: string;
    readonly alreadyResolved: boolean;
  }> {
    if (credentials.user.id !== input.expectedUserId)
      throw new QingyuError(
        409,
        "QINGYU_ACCOUNT_MISMATCH",
        `该 Bug 由轻语账号“${input.expectedUserName}”导入，当前连接的是“${credentials.user.name}”`,
      );
    const encoded = encodeURIComponent(input.defectId);
    const task = record(
      dataFromPayload(await this.authenticated(credentials, `/tasks/${encoded}`)),
    );
    if (task === null)
      throw new QingyuError(502, "QINGYU_DEFECT_INVALID", "轻语返回的 Bug 详情不完整");
    const taskStatus = task["bug_status"] ?? task["status"];
    if (isResolved(taskStatus)) {
      const status = statusIdentity(taskStatus);
      return { defectId: input.defectId, status: status.name || status.key, alreadyResolved: true };
    }
    const transitionsPayload = await this.authenticated(
      credentials,
      `/tasks/${encoded}/bug-transitions`,
    );
    const transitionsRoot = record(transitionsPayload);
    const currentStatus =
      transitionsRoot?.["current_status"] ??
      record(transitionsRoot?.["data"])?.["current_status"] ??
      task["bug_status"] ??
      task["status"];
    if (isResolved(currentStatus)) {
      const status = statusIdentity(currentStatus);
      return { defectId: input.defectId, status: status.name || status.key, alreadyResolved: true };
    }
    const transition = listFromPayload(transitionsPayload).find((value) => {
      const item = record(value);
      return item !== null && isResolved(item["to_status"] ?? item["toStatus"] ?? item["status"]);
    });
    const transitionRecord = record(transition);
    if (transitionRecord === null)
      throw new QingyuError(
        409,
        "QINGYU_RESOLVE_TRANSITION_UNAVAILABLE",
        "轻语当前状态没有可用的“已解决”流转，或绑定账号无权执行",
      );
    const transitionId = numericId(first(transitionRecord, ["ID", "id", "transition_id"]));
    const version = numericId(first(task, ["version", "Version"]));
    if (transitionId === null || version === null)
      throw new QingyuError(
        409,
        "QINGYU_TRANSITION_INVALID",
        "轻语 Bug 缺少流转编号或并发版本号，已停止更新",
      );
    const body: Record<string, unknown> = { transition_id: transitionId, version };
    const requiredFields = String(transitionRecord["required_fields"] ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
    for (const field of requiredFields) {
      if (field === "resolve_version_id") {
        body[field] = await this.resolveVersion(credentials, input.externalProjectId, task);
        continue;
      }
      const value = task[field];
      if (value === null || value === undefined || value === "")
        throw new QingyuError(
          409,
          "QINGYU_TRANSITION_FIELD_REQUIRED",
          `轻语“已解决”流转还要求字段 ${field}，当前 Bug 没有可复用值`,
          { field },
        );
      body[field] = value;
    }
    await this.authenticated(credentials, `/tasks/${encoded}/bug-transition`, {
      method: "POST",
      body,
    });
    const verified = record(
      await this.authenticated(credentials, `/tasks/${encoded}/bug-transitions`),
    );
    const verifiedStatus =
      verified?.["current_status"] ?? record(verified?.["data"])?.["current_status"];
    if (!isResolved(verifiedStatus))
      throw new QingyuError(
        409,
        "QINGYU_RESOLUTION_NOT_VERIFIED",
        "轻语没有确认 Bug 已进入“已解决”状态",
      );
    const status = statusIdentity(verifiedStatus);
    return {
      defectId: input.defectId,
      status: status.name || status.key || "已解决",
      alreadyResolved: false,
    };
  }
}
