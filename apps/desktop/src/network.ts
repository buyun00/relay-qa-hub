import { Buffer } from "node:buffer";

import { API_PATH, NOTIFICATIONS_PATH, type DesktopConfig, isAllowedNetworkUrl } from "./config.js";
import {
  MAX_INBOX_BYTES,
  parseDurableInbox,
  type DurableNotification,
} from "./notification-transport.js";

const MAX_PROXY_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROXY_BINARY_RESPONSE_BYTES = 32 * 1024 * 1024;
const BROWSER_SESSION_COOKIE_NAME = "qa_hub_browser_session";
const BROWSER_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ALLOWED_RENDERER_HEADERS = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "if-match",
  "x-client-submission-id",
  "x-client-attachment-id",
  "x-upload-version",
  "x-csrf-token",
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
] as const;

function browserSessionTokenFromCookieHeader(value: string | null): string | null {
  if (value === null) return null;
  for (const item of value.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    if (item.slice(0, separator).trim() !== BROWSER_SESSION_COOKIE_NAME) continue;
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

  cookieHeader(rendererCookieHeader: string | null): string | null {
    const rendererToken = browserSessionTokenFromCookieHeader(rendererCookieHeader);
    if (rendererToken !== null) this.sessionToken = rendererToken;
    return this.sessionToken === null
      ? null
      : `${BROWSER_SESSION_COOKIE_NAME}=${this.sessionToken}`;
  }

  captureSetCookie(value: string | null): void {
    if (value === null) return;
    const firstSeparator = value.indexOf(";");
    const cookiePair = (firstSeparator < 0 ? value : value.slice(0, firstSeparator)).trim();
    const separator = cookiePair.indexOf("=");
    if (separator < 1 || cookiePair.slice(0, separator).trim() !== BROWSER_SESSION_COOKIE_NAME) {
      return;
    }
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
    this.loginName = null;
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

function responseDisplayName(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const displayName = (value as { readonly displayName?: unknown }).displayName;
    return typeof displayName === "string" ? normalizeLoginName(displayName) : null;
  } catch {
    return null;
  }
}

function responseByteLimit(pathname: string): number {
  const isAttachment = /^\/api\/v1\/attachments\/[^/]+$/.test(pathname);
  const isCaptureArtifact =
    /^\/api\/v1\/bugs\/[^/]+\/capture-bundles\/[^/]+\/artifacts\/[^/]+$/.test(pathname);
  return isAttachment || isCaptureArtifact
    ? MAX_PROXY_BINARY_RESPONSE_BYTES
    : MAX_PROXY_RESPONSE_BYTES;
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

async function responseJson(response: Response, maxBytes: number): Promise<unknown> {
  const body = await readBoundedBody(response, maxBytes);
  if (body.byteLength === 0) return null;
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    throw new Error("INVALID_JSON_RESPONSE");
  }
}

export async function fetchDurableInbox(
  config: DesktopConfig,
  browserSessionCookie: string | null = null,
): Promise<readonly DurableNotification[]> {
  if (config.accessToken === null && browserSessionCookie === null) {
    throw new Error("ACCESS_TOKEN_MISSING");
  }
  const endpoint = new URL(NOTIFICATIONS_PATH, config.apiBaseUrl);
  if (!isAllowedNetworkUrl(endpoint, config)) throw new Error("INBOX_ORIGIN_NOT_ALLOWED");
  let response: Response;
  try {
    const headers = new Headers({ Accept: "application/vnd.relay-qa-hub.v1.1+json" });
    if (config.accessToken !== null) headers.set("Authorization", `Bearer ${config.accessToken}`);
    else if (browserSessionCookie !== null) headers.set("Cookie", browserSessionCookie);
    response = await fetch(endpoint, {
      headers,
      redirect: "manual",
    });
  } catch {
    throw new Error("INBOX_NETWORK_ERROR");
  }
  const body = await responseJson(response, MAX_INBOX_BYTES);
  if (!response.ok) throw new Error(`INBOX_HTTP_${response.status}`);
  return parseDurableInbox(body);
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
): Promise<Response> {
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
  const browserSessionCookie = browserSession.cookieHeader(request.headers.get("cookie"));
  if (browserSessionCookie !== null) headers.set("cookie", browserSessionCookie);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    headers.set("origin", config.csrfOrigin);
  }
  let body: Uint8Array | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await readBoundedBody(request, MAX_PROXY_REQUEST_BYTES);
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
  try {
    response = await fetch(target, requestInit);
  } catch {
    return new Response(JSON.stringify({ code: "NETWORK_ERROR" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  browserSession.captureSetCookie(response.headers.get("set-cookie"));
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
    if (cause instanceof Error && cause.message === "RESPONSE_TOO_LARGE") {
      return new Response(JSON.stringify({ code: "RESPONSE_TOO_LARGE" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
    throw cause;
  }
  if (response.ok && requestUrl.pathname === "/api/v1/auth/login") {
    const displayName = responseDisplayName(responseBody);
    if (displayName !== null) browserSession.rememberLoginName(displayName);
  } else if (response.ok && requestUrl.pathname === "/api/v1/auth/logout") {
    browserSession.clearLoginName();
  }
  const responseHeaders = new Headers();
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null) responseHeaders.set(header, value);
  }
  return new Response(Buffer.from(responseBody), {
    status: response.status,
    headers: responseHeaders,
  });
}

export { readBoundedBody };
