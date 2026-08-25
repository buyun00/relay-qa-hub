import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopConfigError,
  EVENTS_PATH,
  isAllowedNetworkUrl,
  parseDesktopConfig,
} from "../src/config.js";

test("desktop config derives the authenticated notification WSS path", () => {
  const config = parseDesktopConfig(
    {
      QA_HUB_DESKTOP_API_BASE_URL: "https://qa.example.test",
      QA_HUB_DESKTOP_ACCESS_TOKEN: "main-process-only",
    },
    { webAssetsDirectory: "./web-dist" },
  );
  assert.equal(config.wssUrl.toString(), `wss://qa.example.test${EVENTS_PATH}`);
  assert.equal(config.accessToken, "main-process-only");
  assert.equal(isAllowedNetworkUrl(new URL("https://qa.example.test/api/v1/bugs"), config), true);
  assert.equal(isAllowedNetworkUrl(new URL("https://evil.example.test/api"), config), false);
});

test("HTTP and WS are rejected unless explicitly limited to loopback", () => {
  assert.throws(
    () =>
      parseDesktopConfig({
        QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4319",
        QA_HUB_DESKTOP_WSS_URL: "ws://127.0.0.1:4319/api/v1/notifications/stream",
      }),
    DesktopConfigError,
  );
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4319",
    QA_HUB_DESKTOP_WSS_URL: "ws://127.0.0.1:4319/api/v1/notifications/stream",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  assert.equal(config.apiBaseUrl.protocol, "http:");
  assert.equal(config.wssUrl.protocol, "ws:");
});

test("URLs with embedded credentials or query state are rejected", () => {
  assert.throws(
    () => parseDesktopConfig({ QA_HUB_DESKTOP_API_BASE_URL: "https://user:pass@example.test" }),
    DesktopConfigError,
  );
  assert.throws(
    () => parseDesktopConfig({ QA_HUB_DESKTOP_API_BASE_URL: "https://example.test/?token=secret" }),
    DesktopConfigError,
  );
});
