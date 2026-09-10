import assert from "node:assert/strict";
import test from "node:test";

import { parseDesktopConfig } from "../src/config.js";
import {
  DesktopBrowserSessionCookieStore,
  MAX_INBOX_PAGES,
  fetchDurableInbox,
  proxyRendererApiRequest,
} from "../src/network.js";

const TEST_BROWSER_SESSION_TOKEN = "A".repeat(43);
const TEST_INBOX_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TEST_INBOX_USER_ID = "22222222-2222-4222-8222-222222222222";

function inboxNotification(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    projectId: TEST_INBOX_PROJECT_ID,
    userId: TEST_INBOX_USER_ID,
    type: "bug.created",
    title: `Bug ${sequence}`,
    body: `Body ${sequence}`,
    bugId: `33333333-3333-4333-8333-${sequence.toString(16).padStart(12, "0")}`,
    createdAt: new Date(Date.UTC(2026, 8, 11, 0, 0, sequence)).toISOString(),
    readAt: null,
    version: 1,
    ...overrides,
  };
}

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
  let accept: string | null = null;
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    const headers = new Headers(init?.headers);
    authorization = headers.get("authorization");
    cookie = headers.get("cookie");
    accept = headers.get("accept");
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
    assert.equal(accept, "application/json");
    const query = new URL(requestedUrl);
    assert.equal(query.pathname, "/api/v1/notifications");
    assert.equal(query.searchParams.get("unreadOnly"), "true");
    assert.equal(query.searchParams.get("limit"), "100");
    assert.equal(query.searchParams.has("cursor"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop Inbox follows every frozen cursor page before returning older notifications", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const requests: URL[] = [];
  const pages = [
    {
      items: [inboxNotification(2)],
      nextCursor: "frozen-page-2",
      unreadCount: 2,
    },
    {
      items: [inboxNotification(1)],
      nextCursor: null,
      unreadCount: 2,
    },
  ];
  const items = await fetchDurableInbox(
    config,
    `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`,
    TEST_INBOX_PROJECT_ID,
    TEST_INBOX_USER_ID,
    {
      fetchImpl: async (input) => {
        requests.push(new URL(String(input)));
        const page = pages.shift();
        assert.ok(page);
        return new Response(JSON.stringify(page), { status: 200 });
      },
    },
  );
  assert.deepEqual(
    items.map((item) => item.id),
    [inboxNotification(2).id, inboxNotification(1).id],
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.searchParams.get("projectId"), TEST_INBOX_PROJECT_ID);
  assert.equal(requests[0]?.searchParams.get("unreadOnly"), "true");
  assert.equal(requests[0]?.searchParams.get("limit"), "100");
  assert.equal(requests[0]?.searchParams.has("cursor"), false);
  assert.equal(requests[1]?.searchParams.get("cursor"), "frozen-page-2");
});

test("desktop Inbox rejects repeated cursors, notification IDs, and incomplete snapshots", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const fetchPages = (pages: unknown[]) => async () => {
    const page = pages.shift();
    assert.ok(page);
    return new Response(JSON.stringify(page), { status: 200 });
  };
  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: fetchPages([
          { items: [], nextCursor: "same-cursor", unreadCount: 0 },
          { items: [], nextCursor: "same-cursor", unreadCount: 0 },
        ]),
      },
    ),
    /INBOX_CURSOR_REPEATED/u,
  );
  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: fetchPages([
          { items: [inboxNotification(1)], nextCursor: "next", unreadCount: 2 },
          { items: [inboxNotification(1)], nextCursor: null, unreadCount: 2 },
        ]),
      },
    ),
    /INBOX_NOTIFICATION_REPEATED/u,
  );
  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: fetchPages([
          { items: [inboxNotification(1)], nextCursor: null, unreadCount: 2 },
        ]),
      },
    ),
    /INBOX_UNREAD_COUNT_MISMATCH/u,
  );
});

test("desktop Inbox rejects oversized counts and cross-page user or count drift", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const fetchPages = (pages: unknown[]) => async () => {
    const page = pages.shift();
    assert.ok(page);
    return new Response(JSON.stringify(page), { status: 200 });
  };

  let oversizedCalls = 0;
  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: async () => {
          oversizedCalls += 1;
          return new Response(
            JSON.stringify({ items: [], nextCursor: "must-not-follow", unreadCount: 10_001 }),
            { status: 200 },
          );
        },
      },
    ),
    /INBOX_TOTAL_ITEMS_EXCEEDED/u,
  );
  assert.equal(oversizedCalls, 1, "an oversized first-page count must fail immediately");

  await assert.rejects(
    fetchDurableInbox(config, TEST_BROWSER_SESSION_TOKEN, TEST_INBOX_PROJECT_ID, null, {
      fetchImpl: fetchPages([{ items: [inboxNotification(1)], nextCursor: null, unreadCount: 1 }]),
    }),
    /INBOX_USER_SCOPE_MISMATCH/u,
  );

  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: fetchPages([
          { items: [inboxNotification(2)], nextCursor: "user-page-2", unreadCount: 2 },
          {
            items: [inboxNotification(1, { userId: "99999999-9999-4999-8999-999999999999" })],
            nextCursor: null,
            unreadCount: 2,
          },
        ]),
      },
    ),
    /INBOX_USER_SCOPE_MISMATCH/u,
  );

  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: fetchPages([
          { items: [inboxNotification(2)], nextCursor: "count-page-2", unreadCount: 2 },
          { items: [inboxNotification(1)], nextCursor: null, unreadCount: 3 },
        ]),
      },
    ),
    /INBOX_UNREAD_COUNT_CHANGED/u,
  );
});

test("desktop Inbox rejects the entire snapshot when its second page fails", async (context) => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const firstPage = {
    items: [inboxNotification(2)],
    nextCursor: "failure-page-2",
    unreadCount: 2,
  };
  const cases: readonly {
    readonly name: string;
    readonly expected: RegExp;
    readonly second: (signal: AbortSignal | null) => Promise<Response>;
    readonly timeoutMs?: number;
  }[] = [
    {
      name: "HTTP error",
      expected: /INBOX_HTTP_503/u,
      second: async () => new Response(JSON.stringify({ code: "UNAVAILABLE" }), { status: 503 }),
    },
    {
      name: "network error",
      expected: /INBOX_NETWORK_ERROR/u,
      second: async () => {
        throw new Error("connection reset");
      },
    },
    {
      name: "invalid JSON",
      expected: /INVALID_JSON_RESPONSE/u,
      second: async () => new Response("{", { status: 200 }),
    },
    {
      name: "timeout",
      expected: /INBOX_REQUEST_TIMEOUT/u,
      timeoutMs: 20,
      second: async (signal) =>
        await new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted === true) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
  ];

  for (const failure of cases) {
    await context.test(failure.name, async () => {
      let calls = 0;
      const request = fetchDurableInbox(
        config,
        TEST_BROWSER_SESSION_TOKEN,
        TEST_INBOX_PROJECT_ID,
        TEST_INBOX_USER_ID,
        {
          ...(failure.timeoutMs === undefined ? {} : { timeoutMs: failure.timeoutMs }),
          fetchImpl: async (_input, init) => {
            calls += 1;
            if (calls === 1) {
              return new Response(JSON.stringify(firstPage), { status: 200 });
            }
            return failure.second((init?.signal as AbortSignal | null | undefined) ?? null);
          },
        },
      );
      await assert.rejects(request, failure.expected);
      assert.equal(calls, 2, "the failed second page must reject instead of returning page one");
    });
  }
});

test("desktop Inbox fails closed on cross-scope/read rows and a non-terminating page chain", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              items: [inboxNotification(1, { projectId: "44444444-4444-4444-8444-444444444444" })],
              nextCursor: null,
              unreadCount: 1,
            }),
          ),
      },
    ),
    /INBOX_PROJECT_SCOPE_MISMATCH/u,
  );
  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              items: [inboxNotification(1, { readAt: "2026-09-11T00:00:00.000Z" })],
              nextCursor: null,
              unreadCount: 1,
            }),
          ),
      },
    ),
    /INBOX_READ_ITEM_RETURNED/u,
  );
  let calls = 0;
  await assert.rejects(
    fetchDurableInbox(
      config,
      TEST_BROWSER_SESSION_TOKEN,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({ items: [], nextCursor: `cursor-${calls}`, unreadCount: 0 }),
          );
        },
      },
    ),
    /INBOX_PAGE_LIMIT_EXCEEDED/u,
  );
  assert.equal(calls, MAX_INBOX_PAGES);
});

test("desktop Inbox fetch is aborted at its explicit request deadline", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  let forwardedSignal: AbortSignal | null | undefined;
  await assert.rejects(
    fetchDurableInbox(
      config,
      `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`,
      null,
      TEST_INBOX_USER_ID,
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
    ),
    /INBOX_REQUEST_TIMEOUT/u,
  );
  assert.equal(forwardedSignal?.aborted, true);
});

test("desktop Inbox shares one total deadline across cursor pages", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://127.0.0.1:4274",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  const signals: AbortSignal[] = [];
  let calls = 0;
  const startedAt = Date.now();
  await assert.rejects(
    fetchDurableInbox(
      config,
      `qa_hub_browser_session=${TEST_BROWSER_SESSION_TOKEN}`,
      TEST_INBOX_PROJECT_ID,
      TEST_INBOX_USER_ID,
      {
        timeoutMs: 60,
        fetchImpl: async (_input, init) => {
          calls += 1;
          const signal = init?.signal as AbortSignal | null | undefined;
          assert.ok(signal);
          signals.push(signal);
          if (calls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return new Response(
              JSON.stringify({
                items: [inboxNotification(2)],
                nextCursor: "deadline-page-2",
                unreadCount: 2,
              }),
              { status: 200 },
            );
          }
          return await new Promise<Response>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    ),
    /INBOX_REQUEST_TIMEOUT/u,
  );
  assert.equal(calls, 2);
  assert.equal(signals[1], signals[0], "every cursor page must reuse the same deadline signal");
  assert.equal(signals[0]?.aborted, true);
  assert.ok(Date.now() - startedAt < 250, "the complete cursor walk must remain time-bounded");
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
