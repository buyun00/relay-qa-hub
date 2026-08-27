import assert from "node:assert/strict";
import test from "node:test";

import { parseDesktopConfig } from "../src/config.js";
import { proxyRendererApiRequest } from "../src/network.js";

test("desktop API proxy carries the browser session cookie in both directions", async () => {
  const config = parseDesktopConfig({});
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
        "set-cookie":
          "qa_hub_browser_session=opaque; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
      },
    });
  };

  try {
    const response = await proxyRendererApiRequest(
      new Request("qa-hub://app/api/v1/auth/logout", {
        method: "POST",
        headers: {
          cookie: "qa_hub_browser_session=opaque",
          "x-csrf-token": "csrf-token",
        },
      }),
      config,
    );
    assert.equal(forwardedCookie, "qa_hub_browser_session=opaque");
    assert.equal(forwardedOrigin, "http://127.0.0.1:4174");
    assert.equal(forwardedCsrf, "csrf-token");
    assert.equal(
      response.headers.get("set-cookie"),
      "qa_hub_browser_session=opaque; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
