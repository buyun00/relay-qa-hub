import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readParallelInstanceConfig,
  applyParallelInstanceEnvironment,
} from "../src/parallel-instance.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qa-preview-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const runtimeRoot = join(root, "runtime");
  mkdirSync(sourceRoot);
  mkdirSync(runtimeRoot);
  const config = {
    schemaVersion: 1,
    instanceId: "qa-hub-preview-test",
    sourceRoot,
    runtimeRoot,
    dataRoot: join(runtimeRoot, "data"),
    backupRoot: join(runtimeRoot, "backups"),
    downloadsRoot: join(runtimeRoot, "downloads"),
    logsRoot: join(runtimeRoot, "logs"),
    desktopRoot: join(runtimeRoot, "desktop"),
    apiHost: "127.0.0.1",
    apiPort: 4419,
    webHost: "127.0.0.1",
    webPort: 4274,
    mcpPort: 4421,
    desktopMcpPort: 4420,
    cookieName: "qa-hub-preview-test-session",
    gmUserId: "40000000-0000-4000-8000-000000000003",
    secretsFile: join(runtimeRoot, "secrets.json"),
    peopleFile: join(runtimeRoot, "people.json"),
    releaseChannel: "qa-hub-preview-test",
  };
  const configFile = join(runtimeRoot, "instance.json");
  const save = () => writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(
    config.secretsFile,
    JSON.stringify({
      sessionSecret: "s".repeat(48),
      debugToken: "d".repeat(48),
      gmPassword: "g".repeat(48),
    }),
  );
  save();
  return { root, config, configFile, save };
}

test("missing explicit config fails before startup", () => {
  assert.throws(() => readParallelInstanceConfig(undefined), /required/);
});
test("preview overrides discard inherited production connections and secrets", (t) => {
  const f = fixture(t);
  const env = {
    QA_HUB_INSTANCE_CONFIG_FILE: f.configFile,
    QA_HUB_DATA_ROOT: "D:\\Relay-QA-Hub-Data\\production",
    QA_HUB_RELAY_M2M_URL: "http://production.invalid",
    QA_HUB_BACKUP_ENABLED: "true",
    QA_HUB_UPLOADER_SECRET: "production",
    PATH: "preserved",
  };
  applyParallelInstanceEnvironment(env);
  assert.equal(env.QA_HUB_DATA_ROOT, f.config.dataRoot);
  assert.equal(env.QA_HUB_BACKUP_ENABLED, "false");
  assert.equal(env.QA_HUB_RELAY_M2M_URL, undefined);
  assert.equal(env.QA_HUB_UPLOADER_SECRET, undefined);
  assert.equal(env.QA_HUB_WEB_SESSION_COOKIE_NAME, "qa-hub-preview-test-session");
  assert.equal(env.PATH, "preserved");
});
test("production ports, shared cookie, shared update channel and escaping roots fail", (t) => {
  const f = fixture(t);
  for (const [field, value] of [
    ["apiPort", 4319],
    ["webPort", 4174],
    ["cookieName", "qa_hub_session"],
    ["releaseChannel", "stable"],
    ["backupRoot", join(f.root, "outside")],
  ]) {
    const original = f.config[field];
    f.config[field] = value;
    f.save();
    assert.throws(() => readParallelInstanceConfig(f.configFile), /INSTANCE_/);
    f.config[field] = original;
  }
});
test("nested junction cannot redirect database or evidence to another directory", (t) => {
  const f = fixture(t);
  mkdirSync(f.config.dataRoot);
  const external = join(f.root, "external");
  mkdirSync(external);
  symlinkSync(
    external,
    join(f.config.dataRoot, "db"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => readParallelInstanceConfig(f.configFile), /INSTANCE_RUNTIME_LINK_REFUSED/);
});
test("overlapping data and backup paths are rejected", (t) => {
  const f = fixture(t);
  f.config.backupRoot = join(f.config.dataRoot, "backup");
  f.save();
  assert.throws(() => readParallelInstanceConfig(f.configFile), /PATHS_OVERLAP/);
});
