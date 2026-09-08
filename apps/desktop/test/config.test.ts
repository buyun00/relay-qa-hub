import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopConfigError,
  EVENTS_PATH,
  isAllowedNetworkUrl,
  parseDesktopConfig,
} from "../src/config.js";

test("desktop refuses startup without an explicit API service", () => {
  assert.throws(() => parseDesktopConfig({}), /explicitly configured/);
});

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

test("RFC1918 LAN HTTP is accepted only with the dedicated explicit opt-in", () => {
  assert.throws(
    () =>
      parseDesktopConfig({
        QA_HUB_DESKTOP_API_BASE_URL: "http://10.100.5.157:4319",
        QA_HUB_DESKTOP_CSRF_ORIGIN: "http://10.100.5.157:4174",
      }),
    DesktopConfigError,
  );
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://10.100.5.157:4319",
    QA_HUB_DESKTOP_CSRF_ORIGIN: "http://10.100.5.157:4174",
    QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP: "1",
  });
  assert.equal(config.apiBaseUrl.toString(), "http://10.100.5.157:4319/");
  assert.equal(config.wssUrl.toString(), "ws://10.100.5.157:4319/api/v1/notifications/stream");
  assert.equal(config.csrfOrigin, "http://10.100.5.157:4174");
  assert.equal(config.allowPrivateLanHttp, true);
});

test("private-LAN opt-in never permits public HTTP, hostnames, or link-local addresses", () => {
  for (const url of [
    "http://8.8.8.8:4319",
    "http://qa-hub.example.test:4319",
    "http://169.254.10.20:4319",
  ]) {
    assert.throws(
      () =>
        parseDesktopConfig({
          QA_HUB_DESKTOP_API_BASE_URL: url,
          QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP: "1",
        }),
      DesktopConfigError,
    );
  }
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

test("MCP host is enabled on the fixed loopback port and validates overrides", () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "https://qa.example.test",
    QA_HUB_DESKTOP_MCP_ENABLED: "0",
    QA_HUB_DESKTOP_MCP_PORT: "54321",
  });
  assert.equal(config.mcpEnabled, false);
  assert.equal(config.mcpPort, 54_321);
  assert.throws(() => parseDesktopConfig({ QA_HUB_DESKTOP_MCP_PORT: "0" }), DesktopConfigError);
  assert.throws(
    () => parseDesktopConfig({ QA_HUB_DESKTOP_MCP_PORT: "4320.5" }),
    DesktopConfigError,
  );
});
