import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readParallelInstanceConfig,
  applyParallelInstanceEnvironment,
  validateLanNetwork,
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
    QA_HUB_ANDROID_UPDATE_CHANNEL: "stable",
    PATH: "preserved",
  };
  applyParallelInstanceEnvironment(env);
  assert.equal(env.QA_HUB_DATA_ROOT, f.config.dataRoot);
  assert.equal(env.QA_HUB_BACKUP_ENABLED, "false");
  assert.equal(env.QA_HUB_RELAY_M2M_URL, undefined);
  assert.equal(env.QA_HUB_UPLOADER_SECRET, undefined);
  assert.equal(env.QA_HUB_WEB_SESSION_COOKIE_NAME, "qa-hub-preview-test-session");
  assert.equal(env.QA_HUB_ANDROID_UPDATE_CHANNEL, "preview");
  assert.equal(
    env.QA_HUB_ANDROID_UPDATE_ROOT,
    join(f.config.downloadsRoot, "android", "qa-hub-preview-test"),
  );
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
test("sealed history junction below backup root does not block status validation", (t) => {
  const f = fixture(t);
  mkdirSync(f.config.backupRoot);
  const sealedHistory = join(f.root, "sealed-history");
  mkdirSync(sealedHistory);
  symlinkSync(
    sealedHistory,
    join(f.config.backupRoot, "schema19-runnable-sealed"),
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.equal(readParallelInstanceConfig(f.configFile).instanceId, f.config.instanceId);
});
test("configured runtime resource roots cannot themselves be junctions", (t) => {
  for (const field of ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"]) {
    const f = fixture(t);
    const target = join(f.config.runtimeRoot, `plain-${field}`);
    mkdirSync(target);
    symlinkSync(target, f.config[field], process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => readParallelInstanceConfig(f.configFile),
      /INSTANCE_CONFIGURED_PATH_LINK_REFUSED/,
      field,
    );
  }
});
test("configured secret and people files cannot themselves be links", (t) => {
  for (const field of ["secretsFile", "peopleFile"]) {
    const f = fixture(t);
    const target = join(f.config.runtimeRoot, `plain-${field}`);
    mkdirSync(target);
    rmSync(f.config[field], { force: true });
    symlinkSync(target, f.config[field], process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => readParallelInstanceConfig(f.configFile),
      /INSTANCE_CONFIGURED_PATH_LINK_REFUSED/,
      field,
    );
  }
});
test("the runtime and config path cannot traverse a junction", (t) => {
  const f = fixture(t);
  const realRuntime = join(f.root, "runtime-real");
  renameSync(f.config.runtimeRoot, realRuntime);
  symlinkSync(realRuntime, f.config.runtimeRoot, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => readParallelInstanceConfig(f.configFile),
    /INSTANCE_CONFIGURED_PATH_LINK_REFUSED/,
  );
});
test("links outside retained backup descendants remain rejected", (t) => {
  const f = fixture(t);
  const acceptanceRoot = join(f.config.runtimeRoot, "acceptance");
  const external = join(f.root, "external-acceptance");
  mkdirSync(acceptanceRoot);
  mkdirSync(external);
  symlinkSync(
    external,
    join(acceptanceRoot, "unexpected-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => readParallelInstanceConfig(f.configFile), /INSTANCE_RUNTIME_LINK_REFUSED/);
});
test("dangling configured paths remain rejected", (t) => {
  const f = fixture(t);
  rmSync(f.config.secretsFile);
  symlinkSync(
    join(f.root, "missing-secret"),
    f.config.secretsFile,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => readParallelInstanceConfig(f.configFile), /INSTANCE_DANGLING_LINK/);
});
test("overlapping data and backup paths are rejected", (t) => {
  const f = fixture(t);
  f.config.backupRoot = join(f.config.dataRoot, "backup");
  f.save();
  assert.throws(() => readParallelInstanceConfig(f.configFile), /PATHS_OVERLAP/);
});

test("LAN config binds only public web and server MCP while enabling isolated backup archive", (t) => {
  const f = fixture(t);
  const backupArchiveRoot = join(f.root, "archive");
  Object.assign(f.config, {
    schemaVersion: 2,
    deploymentMode: "lan",
    instanceId: "qa-hub-lan-unit",
    webHost: "0.0.0.0",
    webPort: 4740,
    apiPort: 4739,
    mcpHost: "0.0.0.0",
    mcpPort: 4741,
    desktopMcpPort: 4742,
    cookieName: "qa-hub-lan-unit-session",
    releaseChannel: "qa-hub-lan-unit",
    publicWebBaseUrl: "http://10.100.5.157:4740",
    backupEnabled: true,
    backupArchiveRoot,
    backupIntervalMinutes: 60,
    backupRetentionEnabled: true,
    lanCidr: "10.100.0.0/21",
  });
  f.save();

  const config = readParallelInstanceConfig(f.configFile);
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.webHost, "0.0.0.0");
  assert.equal(config.mcpHost, "0.0.0.0");
  const env = { QA_HUB_INSTANCE_CONFIG_FILE: f.configFile };
  applyParallelInstanceEnvironment(env);
  assert.equal(env.QA_HUB_BACKUP_ON_START, "true");
  assert.equal(env.QA_HUB_BACKUP_INTERVAL_MINUTES, "60");
  assert.equal(env.QA_HUB_BACKUP_ARCHIVE_ROOT, backupArchiveRoot);
  assert.equal(env.QA_HUB_BACKUP_RETENTION_ENABLED, "true");
  assert.equal(env.QA_HUB_PUBLIC_WEB_BASE_URL, "http://10.100.5.157:4740");
});

test("LAN network validation refuses public, broad, noncanonical and mismatched ranges", () => {
  assert.deepEqual(validateLanNetwork("10.100.5.157", "10.100.0.0/21"), {
    address: "10.100.5.157",
    cidr: "10.100.0.0/21",
  });
  for (const [address, cidr] of [
    ["8.8.8.8", "8.0.0.0/8"],
    ["10.100.5.157", "0.0.0.0/8"],
    ["10.100.5.157", "10.100.0.0/0"],
    ["10.100.5.157", "10.101.0.0/21"],
    ["10.100.5.157", "10.100.1.1/21"],
    ["10.100.0.0", "10.100.0.0/21"],
  ]) {
    assert.throws(() => validateLanNetwork(address, cidr), /INSTANCE_LAN_/u);
  }
});
