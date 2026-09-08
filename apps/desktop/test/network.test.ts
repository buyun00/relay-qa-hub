import assert from "node:assert/strict";
import test from "node:test";

import { parseDesktopConfig } from "../src/config.js";
import {
  DesktopBrowserSessionCookieStore,
  fetchDurableInbox,
  proxyRendererApiRequest,
} from "../src/network.js";

const TEST_BROWSER_SESSION_TOKEN = "A".repeat(43);

test("desktop API proxy carries the browser session cookie in both directions", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const browserSession = new DesktopBrowserSessionCookieStore();
  const originalFetch = globalThis.fetch;
  let forwardedCookie: string | null = null;
  let forwardedOrigin: string | null = null;
  let forwardedCsrf: string | null = null;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    forwardedCookie = headers.get("cookie");
    forwardedOrigin = headers.get("origin");
    forwardedCsrf = headers.get("x-csrf-token");
    return new Response(JSON.stringify({ accountId: "account-1" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
      },
    });
  };

  try {
    const response = await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/auth/logout", {
        method: "POST",
        headers: {
          cookie: `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`,
          "x-csrf-token": "csrf-token",
        },
      }),
      config,
      browserSession,
    );
    assert.equal(forwardedCookie, `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`);
    assert.equal(forwardedOrigin, "http://127.0.0.1:4274");
    assert.equal(forwardedCsrf, "csrf-token");
    assert.equal(
      response.headers.get("set-cookie"),
      `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop API proxy retains the browser session when the custom protocol drops its cookie", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
    QA_HUB_DESKTOP_ACCESS_TOKEN: "stale-background-token",
  });
  const browserSession = new DesktopBrowserSessionCookieStore();
  const originalFetch = globalThis.fetch;
  const forwardedCookies: Array<string | null> = [];
  const forwardedAuthorizations: Array<string | null> = [];
  let requestCount = 0;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    forwardedCookies.push(headers.get("cookie"));
    forwardedAuthorizations.push(headers.get("authorization"));
    requestCount += 1;
    return requestCount === 1
      ? new Response(JSON.stringify({ displayName: "林步云" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
          },
        })
      : new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  };

  try {
    await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "林步云", client: "web" }),
      }),
      config,
      browserSession,
    );
    await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/projects?limit=50"),
      config,
      browserSession,
    );

    assert.deepEqual(forwardedCookies, [
      null,
      `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`,
    ]);
    assert.deepEqual(forwardedAuthorizations, [null, null]);
    assert.equal(browserSession.rememberedLoginName(), "林步云");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit desktop logout clears the remembered permanent identity", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const browserSession = new DesktopBrowserSessionCookieStore();
  browserSession.restoreLoginName("林步云");
  browserSession.captureSetCookie(
    `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}; Path=/; HttpOnly`,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "qa_hub_browser_session=; Path=/; Max-Age=0",
      },
    });

  try {
    const response = await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/auth/logout", { method: "POST" }),
      config,
      browserSession,
    );
    assert.equal(response.status, 200);
    assert.equal(browserSession.rememberedLoginName(), null);
    assert.equal(browserSession.cookieHeader(null), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tokenless portable LAN login targets the configured host without Authorization", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
    QA_HUB_DESKTOP_API_BASE_URL: "http://10.100.5.157:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://10.100.5.157:4274",
    QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP: "1",
  });
  const originalFetch = globalThis.fetch;
  let target = "";
  let forwardedAuthorization: string | null = "not-observed";
  let forwardedOrigin: string | null = null;
  globalThis.fetch = async (input, init) => {
    target = input.toString();
    const headers = new Headers(init?.headers);
    forwardedAuthorization = headers.get("authorization");
    forwardedOrigin = headers.get("origin");
    return new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "林步云", client: "web" }),
      }),
      config,
    );
    assert.equal(target, "http://10.100.5.157:4419/api/v1/auth/login");
    assert.equal(forwardedAuthorization, null);
    assert.equal(forwardedOrigin, "http://10.100.5.157:4274");
    assert.equal(response.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tokenless desktop Inbox uses the remembered browser session", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const originalFetch = globalThis.fetch;
  let authorization: string | null = "not-observed";
  let cookie: string | null = null;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    authorization = headers.get("authorization");
    cookie = headers.get("cookie");
    return new Response(JSON.stringify({ items: [], nextCursor: null, unreadCount: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const items = await fetchDurableInbox(
      config,
      `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`,
    );
    assert.deepEqual(items, []);
    assert.equal(authorization, null);
    assert.equal(cookie, `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop API proxy preserves upload chunk integrity and version metadata", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const chunkSha256 = "a".repeat(64);
  let forwardedChunkSha256: string | null = null;
  let forwardedIfMatch: string | null = null;
  let forwardedBody = new Uint8Array();
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    forwardedChunkSha256 = headers.get("x-chunk-sha256");
    forwardedIfMatch = headers.get("if-match");
    forwardedBody = new Uint8Array(init?.body as Uint8Array);
    return new Response(null, {
      status: 204,
      headers: { etag: '"2"', "x-upload-version": "2" },
    });
  };

  try {
    const response = await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/uploads/session-1/chunks/0", {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "if-match": '"1"',
          "x-chunk-sha256": chunkSha256,
        },
        body: bytes,
      }),
      config,
    );
    assert.equal(forwardedChunkSha256, chunkSha256);
    assert.equal(forwardedIfMatch, '"1"');
    assert.deepEqual(forwardedBody, bytes);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("etag"), '"2"');
    assert.equal(response.headers.get("x-upload-version"), "2");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop API proxy preserves large attachment bytes and integrity headers", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const originalFetch = globalThis.fetch;
  const image = new Uint8Array(4_471_962);
  image[0] = 137;
  image[1] = 80;
  image[2] = 78;
  image[3] = 71;
  const sha256 = "a".repeat(64);
  globalThis.fetch = async () =>
    new Response(image, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(image.byteLength),
        "x-content-sha256": sha256,
        "content-disposition": 'inline; filename="capture.png"',
      },
    });

  try {
    const response = await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/attachments/attachment-1"),
      config,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(image.byteLength));
    assert.equal(response.headers.get("x-content-sha256"), sha256);
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="capture.png"');
    assert.equal((await response.arrayBuffer()).byteLength, image.byteLength);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop API proxy maps an oversized binary response to a bounded error", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 9; index += 1) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "image/png" } },
    );
  };

  try {
    const response = await proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/attachments/attachment-2"),
      config,
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code: "RESPONSE_TOO_LARGE" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop API proxy bounds a request whose upstream never responds", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  let forwardedSignal: AbortSignal | null | undefined;

  const response = await proxyRendererApiRequest(
    new Request("qa-hub-preview://app/api/v1/bugs?limit=1"),
    config,
    new DesktopBrowserSessionCookieStore(),
    {
      timeoutMs: 20,
      fetchImpl: async (_input, init) => {
        forwardedSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted === true) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
  );

  assert.equal(forwardedSignal?.aborted, true);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { code: "REQUEST_TIMEOUT" });
});
