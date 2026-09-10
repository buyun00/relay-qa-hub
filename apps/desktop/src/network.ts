import { Buffer } from "node:buffer";

import { API_PATH, NOTIFICATIONS_PATH, type DesktopConfig, isAllowedNetworkUrl } from "./config.js";
import {
  MAX_INBOX_BYTES,
  parseDurableInbox,
  type DurableNotification,
} from "./notification-transport.js";
import {
  isNotificationPrincipalIdentity,
  normalizeNotificationUuid,
} from "./notification-scope.js";

const MAX_PROXY_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROXY_BINARY_RESPONSE_BYTES = 32 * 1024 * 1024;
export const INBOX_PAGE_LIMIT = 100;
export const MAX_INBOX_PAGES = 100;
export const MAX_INBOX_TOTAL_ITEMS = 10_000;
export const MAX_INBOX_TOTAL_BYTES = 64 * 1024 * 1024;
export const API_REQUEST_TIMEOUT_MS = 20_000;
export const API_TRANSFER_TIMEOUT_MS = 60_000;
const BROWSER_SESSION_COOKIE_NAME = "qa_hub_browser_session";
const BROWSER_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ALLOWED_RENDERER_HEADERS = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "if-match",
  "x-client-submission-id",
  "x-client-attachment-id",
  "x-chunk-sha256",
  "x-csrf-token",
  "x-qa-project-id",
]);
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "cache-control",
  "retry-after",
  "set-cookie",
  "content-length",
  "x-content-sha256",
  "content-disposition",
  "x-upload-version",
] as const;

function browserSessionTokenFromCookieHeader(
  value: string | null,
  cookieName: string,
): string | null {
  if (value === null) return null;
  for (const item of value.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    if (item.slice(0, separator).trim() !== cookieName) continue;
    const token = item.slice(separator + 1).trim();
    return BROWSER_SESSION_TOKEN_PATTERN.test(token) ? token : null;
  }
  return null;
}

/**
 * Electron does not consistently persist Set-Cookie returned by a custom
 * protocol handler on every supported Windows build. Keep the HttpOnly
 * browser session in the trusted main process as a deterministic fallback.
 */
export class DesktopBrowserSessionCookieStore {
  private sessionToken: string | null = null;
  private loginName: string | null = null;
  private projectId: string | null = null;
  private userId: string | null = null;
  private identity: string | null = null;
  private projectRequestSequence = 0;
  private authEpoch = 0;
  private scopeVersion = 0;
  private pendingAuthEpoch: number | null = null;
  private requestedProjectId: string | null = null;
  private authoritativeCookie = false;

  constructor(private readonly cookieName = BROWSER_SESSION_COOKIE_NAME) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(cookieName)) throw new Error("BROWSER_COOKIE_NAME_INVALID");
  }

  rememberedProjectId(): string | null {
    return this.projectId;
  }
  rememberedUserId(): string | null {
    return this.userId;
  }
  rememberedIdentity(): string | null {
    return this.identity;
  }
  authenticationEpoch(): number {
    return this.authEpoch;
  }
  scopeEpoch(): number {
    return this.scopeVersion;
  }
  isCurrentAuthentication(epoch: number): boolean {
    return epoch === this.authEpoch;
  }
  canRecoverAuthentication(epoch: number): boolean {
    return this.isCurrentAuthentication(epoch) && this.pendingAuthEpoch === null;
  }
  beginAuthenticationChange(): number {
    this.authEpoch += 1;
    this.scopeVersion += 1;
    this.projectRequestSequence += 1;
    this.pendingAuthEpoch = this.authEpoch;
    return this.authEpoch;
  }
  finishAuthenticationChange(epoch: number): void {
    if (this.isCurrentAuthentication(epoch)) this.pendingAuthEpoch = null;
  }
  rememberProjectId(value: unknown): void {
    if (typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value)) {
      if (this.projectId !== value) this.scopeVersion += 1;
      this.projectId = value;
      this.requestedProjectId = value;
    }
  }
  rememberPrincipal(value: unknown): void {
    const previous = this.snapshot();
    const record =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    this.loginName = normalizeLoginName(
      typeof record?.["displayName"] === "string" ? record["displayName"] : null,
    );
    this.projectId = null;
    this.userId = null;
    this.identity = null;
    this.requestedProjectId = null;
    this.projectRequestSequence += 1;
    if (record !== null) {
      const userId = normalizeNotificationUuid(record["userId"]);
      const rawProjectId = record["projectId"];
      const projectId = normalizeNotificationUuid(rawProjectId);
      const projectIsValid =
        rawProjectId === undefined || rawProjectId === null || projectId !== null;
      const identityFromBoolean =
        typeof record["isGm"] === "boolean" ? (record["isGm"] ? "gm" : "employee") : null;
      const identityFromString = isNotificationPrincipalIdentity(record["identity"])
        ? record["identity"]
        : null;
      const hasBooleanIdentity = Object.hasOwn(record, "isGm");
      const identity = hasBooleanIdentity ? identityFromBoolean : identityFromString;
      const identityIsConsistent =
        identity !== null &&
        (record["identity"] === undefined || identityFromString === identity) &&
        (!hasBooleanIdentity || typeof record["isGm"] === "boolean");
      if (
        this.loginName !== null &&
        userId !== null &&
        projectIsValid &&
        identityIsConsistent &&
        (identity === "gm" || projectId !== null)
      ) {
        this.userId = userId;
        this.projectId = projectId;
        this.identity = identity;
        this.requestedProjectId = projectId;
      }
    }
    if (previous !== this.snapshot()) this.scopeVersion += 1;
  }
  snapshot(): string {
    return JSON.stringify([this.loginName, this.projectId, this.userId, this.identity]);
  }
  beginProjectRequest(projectId: string | null): number {
    if (projectId !== null && projectId !== this.requestedProjectId) {
      this.requestedProjectId = projectId;
      this.scopeVersion += 1;
    }
    return projectId === null ? 0 : ++this.projectRequestSequence;
  }
  completeProjectRequest(projectId: string | null, sequence: number): void {
    if (sequence > 0 && sequence === this.projectRequestSequence) this.rememberProjectId(projectId);
  }

  cookieHeader(rendererCookieHeader: string | null): string | null {
    const rendererToken = browserSessionTokenFromCookieHeader(
      rendererCookieHeader,
      this.cookieName,
    );
    // A renderer cookie jar can lag behind a main-process MCP login or logout.
    // It may bootstrap a session, but cannot replace a server-observed result.
    if (rendererToken !== null && !this.authoritativeCookie) this.sessionToken = rendererToken;
    return this.sessionToken === null ? null : `${this.cookieName}=${this.sessionToken}`;
  }

  captureSetCookie(value: string | null): void {
    if (value === null) return;
    const firstSeparator = value.indexOf(";");
    const cookiePair = (firstSeparator < 0 ? value : value.slice(0, firstSeparator)).trim();
    const separator = cookiePair.indexOf("=");
    if (separator < 1 || cookiePair.slice(0, separator).trim() !== this.cookieName) {
      return;
    }
    this.authoritativeCookie = true;
    const token = cookiePair.slice(separator + 1).trim();
    if (token.length === 0 || /(?:^|;)\s*Max-Age=0(?:;|$)/iu.test(value)) {
      this.sessionToken = null;
      return;
    }
    this.sessionToken = BROWSER_SESSION_TOKEN_PATTERN.test(token) ? token : null;
  }

  rememberedLoginName(): string | null {
    return this.loginName;
  }

  restoreLoginName(value: string | null): void {
    this.loginName = normalizeLoginName(value);
  }

  rememberLoginName(value: string): void {
    this.loginName = normalizeLoginName(value);
  }

  clearLoginName(): void {
    this.authoritativeCookie = true;
    this.authEpoch += 1;
    this.scopeVersion += 1;
    this.projectRequestSequence += 1;
    this.pendingAuthEpoch = null;
    this.requestedProjectId = null;
    this.loginName = null;
    this.projectId = null;
    this.userId = null;
    this.identity = null;
    this.sessionToken = null;
  }
}

function normalizeLoginName(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 &&
    normalized.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function responseByteLimit(pathname: string): number {
  if (/^\/api\/v1\/production\/attachments\/[^/]+$/u.test(pathname)) return 36 * 1024 * 1024;
  const isAttachment = /^\/api\/v1\/attachments\/[^/]+$/.test(pathname);
  const isCaptureArtifact =
    /^\/api\/v1\/bugs\/[^/]+\/capture-bundles\/[^/]+\/artifacts\/[^/]+$/.test(pathname);
  return isAttachment || isCaptureArtifact
    ? MAX_PROXY_BINARY_RESPONSE_BYTES
    : MAX_PROXY_RESPONSE_BYTES;
}

function proxyRequestTimeoutMs(pathname: string): number {
  return pathname === "/api/v1/production/uploads" ||
    /^\/api\/v1\/uploads\//u.test(pathname) ||
    responseByteLimit(pathname) > MAX_PROXY_RESPONSE_BYTES
    ? API_TRANSFER_TIMEOUT_MS
    : API_REQUEST_TIMEOUT_MS;
}

function proxyError(code: "NETWORK_ERROR" | "REQUEST_TIMEOUT", status: 503 | 504): Response {
  return new Response(JSON.stringify({ code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBoundedBody(
  source: Pick<Response, "body">,
  maxBytes: number,
): Promise<Uint8Array> {
  if (source.body === null) return new Uint8Array();
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function responseJson(
  response: Response,
  maxBytes: number,
): Promise<Readonly<{ value: unknown; bytes: number }>> {
  const body = await readBoundedBody(response, maxBytes);
  if (body.byteLength === 0) return { value: null, bytes: 0 };
  try {
    return {
      value: JSON.parse(Buffer.from(body).toString("utf8")) as unknown,
      bytes: body.byteLength,
    };
  } catch {
    throw new Error("INVALID_JSON_RESPONSE");
  }
}

function parseInboxPage(value: unknown): Readonly<{
  items: readonly DurableNotification[];
  nextCursor: string | null;
  unreadCount: number;
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_INBOX_RESPONSE");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "items" || key === "nextCursor" || key === "unreadCount")
  ) {
    throw new Error("INVALID_INBOX_RESPONSE");
  }
  const nextCursor = record["nextCursor"];
  const unreadCount = record["unreadCount"];
  if (
    (nextCursor !== null &&
      (typeof nextCursor !== "string" || nextCursor.length < 1 || nextCursor.length > 500)) ||
    !Number.isSafeInteger(unreadCount) ||
    (unreadCount as number) < 0
  ) {
    throw new Error("INVALID_INBOX_RESPONSE");
  }
  return {
    items: parseDurableInbox(record),
    nextCursor: nextCursor as string | null,
    unreadCount: unreadCount as number,
  };
}

export async function fetchDurableInbox(
  config: DesktopConfig,
  browserSessionCookie: string | null = null,
  projectId: string | null = null,
  expectedUserId: string | null = null,
  options: Readonly<{ fetchImpl?: typeof fetch; timeoutMs?: number }> = {},
): Promise<readonly DurableNotification[]> {
  if (config.accessToken === null && browserSessionCookie === null) {
    throw new Error("ACCESS_TOKEN_MISSING");
  }
  const baseEndpoint = new URL(NOTIFICATIONS_PATH, config.apiBaseUrl);
  if (!isAllowedNetworkUrl(baseEndpoint, config)) throw new Error("INBOX_ORIGIN_NOT_ALLOWED");
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? API_REQUEST_TIMEOUT_MS);
  const headers = new Headers({ Accept: "application/json" });
  if (config.accessToken !== null) headers.set("Authorization", `Bearer ${config.accessToken}`);
  else if (browserSessionCookie !== null) headers.set("Cookie", browserSessionCookie);
  const items: DurableNotification[] = [];
  const seenCursors = new Set<string>();
  const seenNotificationIds = new Set<string>();
  const normalizedExpectedUserId = expectedUserId?.toLowerCase() ?? null;
  let cursor: string | null = null;
  let expectedUnreadCount: number | null = null;
  let totalBytes = 0;
  for (let pageNumber = 1; pageNumber <= MAX_INBOX_PAGES; pageNumber += 1) {
    const endpoint = new URL(baseEndpoint);
    if (projectId !== null) endpoint.searchParams.set("projectId", projectId);
    endpoint.searchParams.set("unreadOnly", "true");
    endpoint.searchParams.set("limit", String(INBOX_PAGE_LIMIT));
    if (cursor !== null) endpoint.searchParams.set("cursor", cursor);
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(endpoint, {
        headers,
        redirect: "manual",
        signal: timeoutSignal,
      });
    } catch {
      throw new Error(timeoutSignal.aborted ? "INBOX_REQUEST_TIMEOUT" : "INBOX_NETWORK_ERROR");
    }
    let parsedResponse: Readonly<{ value: unknown; bytes: number }>;
    try {
      parsedResponse = await responseJson(response, MAX_INBOX_BYTES);
    } catch (cause) {
      if (timeoutSignal.aborted) throw new Error("INBOX_REQUEST_TIMEOUT");
      throw cause;
    }
    if (!response.ok) throw new Error(`INBOX_HTTP_${response.status}`);
    totalBytes += parsedResponse.bytes;
    if (totalBytes > MAX_INBOX_TOTAL_BYTES) throw new Error("INBOX_TOTAL_BYTES_EXCEEDED");
    const page = parseInboxPage(parsedResponse.value);
    if (expectedUnreadCount === null) {
      if (page.unreadCount > MAX_INBOX_TOTAL_ITEMS) {
        throw new Error("INBOX_TOTAL_ITEMS_EXCEEDED");
      }
      expectedUnreadCount = page.unreadCount;
    } else if (page.unreadCount !== expectedUnreadCount) {
      throw new Error("INBOX_UNREAD_COUNT_CHANGED");
    }
    for (const item of page.items) {
      if (item.readAt !== null) throw new Error("INBOX_READ_ITEM_RETURNED");
      if (projectId !== null && item.projectId !== projectId.toLowerCase()) {
        throw new Error("INBOX_PROJECT_SCOPE_MISMATCH");
      }
      if (normalizedExpectedUserId === null || item.userId !== normalizedExpectedUserId) {
        throw new Error("INBOX_USER_SCOPE_MISMATCH");
      }
      if (seenNotificationIds.has(item.id)) throw new Error("INBOX_NOTIFICATION_REPEATED");
      seenNotificationIds.add(item.id);
      items.push(item);
      if (items.length > MAX_INBOX_TOTAL_ITEMS) throw new Error("INBOX_TOTAL_ITEMS_EXCEEDED");
    }
    if (page.nextCursor === null) {
      if (items.length !== expectedUnreadCount) throw new Error("INBOX_UNREAD_COUNT_MISMATCH");
      return items;
    }
    if (seenCursors.has(page.nextCursor)) throw new Error("INBOX_CURSOR_REPEATED");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("INBOX_PAGE_LIMIT_EXCEEDED");
}

function copyRendererHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (ALLOWED_RENDERER_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }
  return headers;
}

export async function proxyRendererApiRequest(
  request: Request,
  config: DesktopConfig,
  browserSession: DesktopBrowserSessionCookieStore = new DesktopBrowserSessionCookieStore(),
  options: Readonly<{ fetchImpl?: typeof fetch; timeoutMs?: number }> = {},
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const authenticationChange =
    request.method === "POST" &&
    ["/api/v1/auth/login", "/api/v1/auth/gm/login", "/api/v1/auth/logout"].includes(pathname);
  const epoch = authenticationChange
    ? browserSession.beginAuthenticationChange()
    : browserSession.authenticationEpoch();
  try {
    return await proxyRendererApiRequestAtEpoch(request, config, browserSession, options, epoch);
  } finally {
    if (authenticationChange) browserSession.finishAuthenticationChange(epoch);
  }
}

async function proxyRendererApiRequestAtEpoch(
  request: Request,
  config: DesktopConfig,
  browserSession: DesktopBrowserSessionCookieStore,
  options: Readonly<{ fetchImpl?: typeof fetch; timeoutMs?: number }>,
  epoch: number,
): Promise<Response> {
  const sessionChanged = () =>
    new Response(JSON.stringify({ code: "QA_HUB_SESSION_CHANGED" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  const requestUrl = new URL(request.url);
  if (!requestUrl.pathname.startsWith(API_PATH)) {
    return new Response(JSON.stringify({ code: "API_PATH_NOT_ALLOWED" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, config.apiBaseUrl);
  if (!isAllowedNetworkUrl(target, config)) {
    return new Response(JSON.stringify({ code: "API_ORIGIN_NOT_ALLOWED" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const headers = copyRendererHeaders(request);
  const requestProjectId = request.headers.get("x-qa-project-id");
  const projectRequestSequence = browserSession.beginProjectRequest(requestProjectId);
  const browserSessionCookie = browserSession.cookieHeader(request.headers.get("cookie"));
  if (browserSessionCookie !== null) headers.set("cookie", browserSessionCookie);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    headers.set("origin", config.csrfOrigin);
  }
  let body: Uint8Array | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await readBoundedBody(
        request,
        requestUrl.pathname === "/api/v1/production/uploads"
          ? 36 * 1024 * 1024
          : MAX_PROXY_REQUEST_BYTES,
      );
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== "RESPONSE_TOO_LARGE") throw cause;
      return new Response(JSON.stringify({ code: "REQUEST_TOO_LARGE" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
  }
  let response: Response;
  const requestInit: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (body !== undefined) requestInit.body = Buffer.from(body);
  const timeoutSignal = AbortSignal.timeout(
    options.timeoutMs ?? proxyRequestTimeoutMs(requestUrl.pathname),
  );
  requestInit.signal = AbortSignal.any([request.signal, timeoutSignal]);
  if (!browserSession.isCurrentAuthentication(epoch)) return sessionChanged();
  try {
    response = await (options.fetchImpl ?? fetch)(target, requestInit);
  } catch {
    return timeoutSignal.aborted
      ? proxyError("REQUEST_TIMEOUT", 504)
      : proxyError("NETWORK_ERROR", 503);
  }
  if (!browserSession.isCurrentAuthentication(epoch)) return sessionChanged();
  if (response.status >= 300 && response.status < 400) {
    return new Response(JSON.stringify({ code: "API_REDIRECT_BLOCKED" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  let responseBody: Uint8Array;
  try {
    responseBody = await readBoundedBody(response, responseByteLimit(requestUrl.pathname));
  } catch (cause) {
    if (timeoutSignal.aborted) return proxyError("REQUEST_TIMEOUT", 504);
    if (cause instanceof Error && cause.message === "RESPONSE_TOO_LARGE") {
      return new Response(JSON.stringify({ code: "RESPONSE_TOO_LARGE" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
    throw cause;
  }
  if (!browserSession.isCurrentAuthentication(epoch)) return sessionChanged();
  browserSession.captureSetCookie(response.headers.get("set-cookie"));
  if (
    response.ok &&
    ["/api/v1/auth/login", "/api/v1/auth/gm/login"].includes(requestUrl.pathname)
  ) {
    try {
      browserSession.rememberPrincipal(JSON.parse(Buffer.from(responseBody).toString("utf8")));
    } catch {
      /* HTTP result remains visible. */
    }
  } else if (response.ok && requestUrl.pathname === "/api/v1/auth/logout") {
    browserSession.clearLoginName();
  }
  if (response.ok) browserSession.completeProjectRequest(requestProjectId, projectRequestSequence);
  const responseHeaders = new Headers();
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null) responseHeaders.set(header, value);
  }
  const responseHasNoBody =
    request.method === "HEAD" || response.status === 204 || response.status === 205;
  return new Response(responseHasNoBody ? null : Buffer.from(responseBody), {
    status: response.status,
    headers: responseHeaders,
  });
}

export { readBoundedBody };
