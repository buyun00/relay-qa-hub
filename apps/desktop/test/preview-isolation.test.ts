import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { loadPreviewDesktopIdentity } from "../src/preview-config.js";
import { deriveToastActivatorClsid } from "../src/notification-activation.js";
import { DesktopBrowserSessionCookieStore, proxyRendererApiRequest } from "../src/network.js";
import { parseDesktopConfig } from "../src/config.js";
import { DesktopQaHubApiClient } from "../src/mcp-api.js";

test("real API principal flags preserve employee recovery and never passwordlessly recover GM", async () => {
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4419",
    QA_HUB_DESKTOP_ALLOW_LOOPBACK_HTTP: "1",
  });
  for (const isGm of [false, true]) {
    const session = new DesktopBrowserSessionCookieStore();
    session.rememberPrincipal({
      displayName: "预览测试身份",
      userId: "22222222-2222-4222-8222-222222222222",
      projectId: "11111111-1111-4111-8111-111111111111",
      isGm,
    });
    assert.equal(session.rememberedIdentity(), isGm ? "gm" : "employee");
    const calls: string[] = [];
    const client = new DesktopQaHubApiClient(config, session, async (url, init) => {
      calls.push(new URL(String(url)).pathname);
      assert.equal(isGm, false, "GM recovery must not call the passwordless endpoint");
      if (calls.length === 1) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.projectId, session.rememberedProjectId());
        return Response.json(
          { displayName: "预览测试身份", projectId: body.projectId, isGm: false },
          { headers: { "set-cookie": `qa_hub_browser_session=${"N".repeat(43)}; Path=/` } },
        );
      }
      return Response.json({ isGm: false, projectId: session.rememberedProjectId() });
    });
    if (isGm) {
      await assert.rejects(client.json("/api/v1/auth/me"), { code: "QA_HUB_LOGIN_REQUIRED" });
      assert.deepEqual(calls, []);
    } else {
      await client.json("/api/v1/auth/me");
      assert.deepEqual(calls, ["/api/v1/auth/login", "/api/v1/auth/me"]);
    }
  }
});

test("preview requires its own identity and rejects production endpoints without inheriting tokens", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-preview-test-"));
  try {
    const configFile = path.join(root, "preview.json");
    const instanceId = "qa-hub-preview-unit";
    const profileDirectory = path.join(root, instanceId, "profile");
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    const value = {
      schemaVersion: 1,
      instanceId,
      profileDirectory,
      apiBaseUrl: "http://127.0.0.1:4419",
      csrfOrigin: "http://127.0.0.1:4274",
      cookieName: `${instanceId}-session`,
      appScheme: instanceId,
      appUserModelId: "com.relayqahub.desktop.preview.unit",
      toastActivatorClsid: "{CF811D77-1C3F-5A20-B2DA-30AA57C3EB86}",
      mcpPort: 4420,
      updateManifestUrl: `http://127.0.0.1:4274/downloads/${instanceId}-windows-latest.json`,
      updatePublicKeyPem: publicKey,
    };
    const source = {
      QA_HUB_PREVIEW_DESKTOP_CONFIG: configFile,
      QA_HUB_DESKTOP_ACCESS_TOKEN: "must-not-survive",
      QA_HUB_DESKTOP_API_BASE_URL: "http://127.0.0.1:4319",
      LOCALAPPDATA: path.join(root, "local"),
      APPDATA: path.join(root, "roaming"),
    };
    mkdirSync(source.LOCALAPPDATA);
    mkdirSync(source.APPDATA);
    const save = (changes = {}) =>
      writeFileSync(configFile, JSON.stringify({ ...value, ...changes }));
    save();
    const identity = loadPreviewDesktopIdentity(source);
    assert.equal(identity.appScheme, instanceId);
    assert.equal(identity.appUserModelId, "com.relayqahub.desktop.preview.unit");
    assert.equal(identity.toastActivatorClsid, value.toastActivatorClsid);
    assert.equal(identity.environment["QA_HUB_DESKTOP_ACCESS_TOKEN"], undefined);
    assert.equal(identity.environment["QA_HUB_DESKTOP_API_BASE_URL"], "http://127.0.0.1:4419/");
    assert.equal(identity.environment["QA_HUB_DESKTOP_APP_SCHEME"], instanceId);
    save({ toastActivatorClsid: undefined });
    assert.equal(
      loadPreviewDesktopIdentity(source).toastActivatorClsid,
      deriveToastActivatorClsid(value.appUserModelId),
    );
    save({ toastActivatorClsid: "{00000000-0000-5000-8000-000000000000}" });
    assert.throws(() => loadPreviewDesktopIdentity(source), /TOAST_ACTIVATOR_CLSID_MISMATCH/);
    save({ apiBaseUrl: "http://127.0.0.1:4319" });
    assert.throws(() => loadPreviewDesktopIdentity(source), /ENDPOINT_INVALID/);
    save({ cookieName: "qa_hub_browser_session" });
    assert.throws(() => loadPreviewDesktopIdentity(source), /COOKIE_ID_MISMATCH/);
    save({ profileDirectory: path.join(root, "daily") });
    assert.throws(() => loadPreviewDesktopIdentity(source), /PROFILE_ID_MISMATCH/);
    save({ updateManifestUrl: "http://127.0.0.1:4274/downloads/production.json" });
    assert.throws(() => loadPreviewDesktopIdentity(source), /UPDATE_CHANNEL_MISMATCH/);
    save({ appScheme: "qa-hub-preview-another" });
    assert.throws(() => loadPreviewDesktopIdentity(source), /APP_SCHEME_MISMATCH/);
    save({ appUserModelId: "com.relayqahub.desktop.preview.another" });
    assert.throws(() => loadPreviewDesktopIdentity(source), /APP_USER_MODEL_ID_MISMATCH/);
    save({ appScheme: undefined });
    assert.throws(() => loadPreviewDesktopIdentity(source), /PREVIEW_CONFIG_appScheme_INVALID/);

    const legacyInstanceId = "qa-hub-preview-7c86";
    save({
      instanceId: legacyInstanceId,
      profileDirectory: path.join(root, legacyInstanceId, "profile"),
      cookieName: `${legacyInstanceId}-session`,
      appScheme: undefined,
      appUserModelId: undefined,
      toastActivatorClsid: undefined,
      updateManifestUrl: `http://127.0.0.1:4274/downloads/${legacyInstanceId}-windows-latest.json`,
    });
    const legacyIdentity = loadPreviewDesktopIdentity(source);
    assert.equal(legacyIdentity.appScheme, "qa-hub-preview");
    assert.equal(legacyIdentity.appUserModelId, "com.relayqahub.desktop.preview");
    assert.equal(
      legacyIdentity.toastActivatorClsid,
      deriveToastActivatorClsid("com.relayqahub.desktop.preview"),
    );
    assert.equal(legacyIdentity.environment["QA_HUB_DESKTOP_APP_SCHEME"], "qa-hub-preview");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview cookie and completed request scope remain isolated across a late project response", async () => {
  const session = new DesktopBrowserSessionCookieStore("qa-hub-preview-unit-session");
  session.captureSetCookie(`qa_hub_browser_session=${"P".repeat(43)}; Path=/`);
  assert.equal(session.cookieHeader(null), null);
  session.captureSetCookie(`qa-hub-preview-unit-session=${"N".repeat(43)}; Path=/`);
  assert.equal(session.cookieHeader(null), `qa-hub-preview-unit-session=${"N".repeat(43)}`);
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const config = parseDesktopConfig({
    QA_HUB_DESKTOP_API_BASE_URL: "https://preview.example.test",
  });
  const pending: Array<() => void> = [];
  const fetchImpl = (async (_url, init) => {
    assert.ok([a, b].includes(new Headers(init?.headers).get("x-qa-project-id") ?? ""));
    await new Promise<void>((resolve) => pending.push(resolve));
    return Response.json({ items: [] });
  }) as typeof fetch;
  const request = (projectId: string) =>
    proxyRendererApiRequest(
      new Request("qa-hub-preview://app/api/v1/bugs", {
        headers: { "x-qa-project-id": projectId },
      }),
      config,
      session,
      { fetchImpl },
    );
  const first = request(a);
  const second = request(b);
  pending[1]?.();
  await second;
  assert.equal(session.rememberedProjectId(), b);
  pending[0]?.();
  await first;
  assert.equal(session.rememberedProjectId(), b);
});
