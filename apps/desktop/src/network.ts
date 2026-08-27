import { Buffer } from "node:buffer";

import { API_PATH, NOTIFICATIONS_PATH, type DesktopConfig, isAllowedNetworkUrl } from "./config.js";
import {
  MAX_INBOX_BYTES,
  parseDurableInbox,
  type DurableNotification,
} from "./notification-transport.js";

const MAX_PROXY_BYTES = 4 * 1024 * 1024;
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
] as const;

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
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
): Promise<readonly DurableNotification[]> {
  if (config.accessToken === null) throw new Error("ACCESS_TOKEN_MISSING");
  const endpoint = new URL(NOTIFICATIONS_PATH, config.apiBaseUrl);
  if (!isAllowedNetworkUrl(endpoint, config)) throw new Error("INBOX_ORIGIN_NOT_ALLOWED");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: "application/vnd.relay-qa-hub.v1.1+json",
        Authorization: `Bearer ${config.accessToken}`,
      },
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
  const browserSessionCookie = request.headers.get("cookie");
  if (browserSessionCookie !== null) headers.set("cookie", browserSessionCookie);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    headers.set("origin", config.csrfOrigin);
  }
  if (config.accessToken !== null) headers.set("Authorization", `Bearer ${config.accessToken}`);
  let body: Uint8Array | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const requestBody = new Uint8Array(await request.arrayBuffer());
    if (requestBody.byteLength > MAX_PROXY_BYTES) {
      return new Response(JSON.stringify({ code: "REQUEST_TOO_LARGE" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
    body = requestBody;
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
  if (response.status >= 300 && response.status < 400) {
    return new Response(JSON.stringify({ code: "API_REDIRECT_BLOCKED" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  const responseBody = await readBoundedBody(response, MAX_PROXY_BYTES);
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
