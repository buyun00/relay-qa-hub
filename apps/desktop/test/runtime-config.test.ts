import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DesktopRuntimeConfigError,
  loadDesktopRuntimeEnvironment,
  resolveDesktopRuntimePaths,
} from "../src/runtime-config.js";

function withRuntime(work: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-desktop-runtime-"));
  try {
    work(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("double-click runtime reads a per-user token file without embedding it in config", () => {
  withRuntime((root) => {
    const runtimeDirectory = path.join(root, "Relay QA Hub Preview");
    const tokenFile = path.join(runtimeDirectory, "desktop-access.token");
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(tokenFile, "main-process-only-token\n", "utf8");
    writeFileSync(
      path.join(runtimeDirectory, "desktop-runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiBaseUrl: "http://127.0.0.1:4419",
        allowLoopbackHttp: true,
        accessTokenFile: tokenFile,
        mcpEnabled: true,
        mcpPort: 54320,
      }),
      "utf8",
    );
    const env = loadDesktopRuntimeEnvironment({ LOCALAPPDATA: root });
    assert.equal(env["QA_HUB_DESKTOP_API_BASE_URL"], "http://127.0.0.1:4419");
    assert.equal(env["QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP"], "1");
    assert.equal(env["QA_HUB_DESKTOP_ACCESS_TOKEN"], "main-process-only-token");
    assert.equal(env["QA_HUB_DESKTOP_MCP_ENABLED"], "1");
    assert.equal(env["QA_HUB_DESKTOP_MCP_PORT"], "54320");
    assert.equal(resolveDesktopRuntimePaths(env).directory, runtimeDirectory);
  });
});

test("a fresh Windows profile falls back to the tokenless config next to the portable EXE", () => {
  withRuntime((root) => {
    const packageDirectory = path.join(root, "RelayQaHub-win32-x64");
    const localAppData = path.join(root, "fresh-local-app-data");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, "desktop-runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiBaseUrl: "http://10.100.5.157:4419",
        csrfOrigin: "http://10.100.5.157:4274",
        allowPrivateLanHttp: true,
      }),
      "utf8",
    );
    const env = loadDesktopRuntimeEnvironment(
      { LOCALAPPDATA: localAppData },
      { executablePath: path.join(packageDirectory, "RelayQaHub.exe") },
    );
    assert.equal(env["QA_HUB_DESKTOP_API_BASE_URL"], "http://10.100.5.157:4419");
    assert.equal(env["QA_HUB_DESKTOP_CSRF_ORIGIN"], "http://10.100.5.157:4274");
    assert.equal(env["QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP"], "1");
    assert.equal(env["QA_HUB_DESKTOP_ACCESS_TOKEN"], undefined);
    assert.equal(
      resolveDesktopRuntimePaths(
        { LOCALAPPDATA: localAppData },
        { executablePath: path.join(packageDirectory, "RelayQaHub.exe") },
      ).portableConfigFile,
      path.join(packageDirectory, "desktop-runtime.json"),
    );
  });
});

test("per-user runtime config overrides the packaged LAN default", () => {
  withRuntime((root) => {
    const packageDirectory = path.join(root, "RelayQaHub-win32-x64");
    const localAppData = path.join(root, "local-app-data");
    const userRuntimeDirectory = path.join(localAppData, "Relay QA Hub Preview");
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(userRuntimeDirectory, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, "desktop-runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiBaseUrl: "http://10.100.5.157:4419",
        allowPrivateLanHttp: true,
      }),
      "utf8",
    );
    writeFileSync(
      path.join(userRuntimeDirectory, "desktop-runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiBaseUrl: "https://qa-hub.internal.example",
      }),
      "utf8",
    );
    const env = loadDesktopRuntimeEnvironment(
      { LOCALAPPDATA: localAppData },
      { executablePath: path.join(packageDirectory, "RelayQaHub.exe") },
    );
    assert.equal(env["QA_HUB_DESKTOP_API_BASE_URL"], "https://qa-hub.internal.example");
    assert.equal(env["QA_HUB_DESKTOP_ALLOW_PRIVATE_LAN_HTTP"], undefined);
  });
});

test("environment overrides runtime defaults and config rejects secret-shaped fields", () => {
  withRuntime((root) => {
    const configFile = path.join(root, "desktop-runtime.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        apiBaseUrl: "https://file.example.test",
        accessToken: "must-not-be-accepted",
      }),
      "utf8",
    );
    assert.throws(
      () => loadDesktopRuntimeEnvironment({ QA_HUB_DESKTOP_CONFIG_FILE: configFile }),
      DesktopRuntimeConfigError,
    );
    writeFileSync(
      configFile,
      JSON.stringify({ schemaVersion: 1, apiBaseUrl: "https://file.example.test" }),
      "utf8",
    );
    const env = loadDesktopRuntimeEnvironment({
      QA_HUB_DESKTOP_CONFIG_FILE: configFile,
      QA_HUB_DESKTOP_API_BASE_URL: "https://environment.example.test",
      QA_HUB_DESKTOP_ACCESS_TOKEN: "environment-token",
    });
    assert.equal(env["QA_HUB_DESKTOP_API_BASE_URL"], "https://environment.example.test");
    assert.equal(env["QA_HUB_DESKTOP_ACCESS_TOKEN"], "environment-token");
  });
});

test("an explicitly configured missing token file fails closed", () => {
  assert.throws(
    () =>
      loadDesktopRuntimeEnvironment({
        QA_HUB_DESKTOP_ACCESS_TOKEN_FILE: path.resolve("missing-desktop-access.token"),
      }),
    DesktopRuntimeConfigError,
  );
});
