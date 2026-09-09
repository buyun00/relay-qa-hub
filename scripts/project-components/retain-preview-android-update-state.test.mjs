import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  adbRead,
  androidCommands,
  baseTables,
  copyTreeCreateOnly,
  databaseFacts,
  fileFact,
  hash,
  parseAndroidHashes,
  parseAndroidVersion,
  retainData,
  treeFacts,
  withoutApi,
} from "./retain-preview-android-update-state.mjs";

function folder(t, close = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "qa-retention-unit-"));
  t.after(() => {
    close();
    const suffix = relative(tmpdir(), root);
    assert(!isAbsolute(suffix) && !suffix.startsWith(".."));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function databaseFixture(t) {
  let db;
  const root = folder(t, () => db?.close()),
    dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "db"), { recursive: true });
  mkdirSync(join(dataRoot, "evidence"));
  mkdirSync(join(dataRoot, "quarantine", "uploads", "fixture-session", "1"), { recursive: true });
  const chunk = join(dataRoot, "quarantine", "uploads", "fixture-session", "1", "0.bin");
  writeFileSync(chunk, Buffer.from("partial-PNG!"));
  const bytes = Buffer.from("referenced-attachment-fixture");
  const digest = hash(bytes),
    storageKey = `sha256/${digest.slice(0, 2)}/${digest}`;
  mkdirSync(dirname(join(dataRoot, "evidence", storageKey)), { recursive: true });
  writeFileSync(join(dataRoot, "evidence", storageKey), bytes);
  const path = join(dataRoot, "db", "qa-hub.sqlite");
  db = new DatabaseSync(path);
  db.exec(`PRAGMA application_id=1363232834; PRAGMA user_version=14; PRAGMA journal_mode=WAL;
    CREATE TABLE blobs(account_id TEXT,id TEXT,storage_key TEXT,size_bytes INTEGER,sha256 TEXT,state TEXT,PRIMARY KEY(account_id,id));
    CREATE TABLE project_components(component_key TEXT,enabled INTEGER);
    CREATE TABLE attachments(account_id TEXT,blob_id TEXT,status TEXT,scan_state TEXT,FOREIGN KEY(account_id,blob_id) REFERENCES blobs(account_id,id));`);
  for (const name of [
    ...baseTables.filter((x) => x !== "attachments"),
    "upload_sessions",
    "upload_chunks",
    "attachment_bindings",
    "capture_bundles",
    "capture_artifacts",
    "capture_poco_methods",
    "extra_discovered_table",
  ]) {
    db.exec(`CREATE TABLE ${name}(id TEXT, payload BLOB)`);
    db.prepare(`INSERT INTO ${name} VALUES(?,?)`).run(
      "synthetic-private-row",
      Buffer.from([1, 2, 3]),
    );
  }
  db.prepare("INSERT INTO blobs VALUES(?,?,?,?,?,?)").run(
    "a",
    "b",
    storageKey,
    bytes.length,
    digest,
    "ready",
  );
  db.prepare("INSERT INTO attachments VALUES(?,?,?,?)").run("a", "b", "ready", "clean");
  return { root, dataRoot, path, db, bytes, storageKey, chunk };
}

test("default and malformed invocations are inert without reading a runtime or creating outputs", () => {
  const path = resolve("scripts/project-components/retain-preview-android-update-state.mjs");
  const inert = spawnSync(process.execPath, [path], { encoding: "utf8" });
  assert.equal(inert.status, 0);
  assert.deepEqual(JSON.parse(inert.stdout), {
    status: "not_run",
    usage: "--run before|after <explicit preview instance.json> <same run UUID>",
    reads: 0,
    writes: 0,
  });
  const refused = spawnSync(
    process.execPath,
    [path, "--run", "before", "Z:/not-real-instance.json", "bad-id"],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.trim(), "RETENTION_ARGUMENT_OR_SETUP_REFUSED");
});

test("actual WAL SQLite snapshot archives referenced bytes and quarantine without copying live sidecars", async (t) => {
  const f = databaseFixture(t);
  assert(existsSync(f.path + "-wal"));
  const outputRoot = join(f.root, "retained");
  const result = await retainData({ dataRoot: f.dataRoot, outputRoot });
  assert.equal(result.archive.entryCount, 1);
  assert.deepEqual(readFileSync(join(result.archive.attachmentRoot, f.storageKey)), f.bytes);
  assert.deepEqual(
    readFileSync(join(outputRoot, "quarantine", "uploads", "fixture-session", "1", "0.bin")),
    readFileSync(f.chunk),
  );
  assert.equal(result.source.database.schemaVersion, 14);
  assert(result.source.database.groups.uploadAndCapture.includes("capture_poco_methods"));
  assert.equal(result.source.database.tables.extra_discovered_table.count, 1);
  assert.equal(JSON.stringify(result).includes("synthetic-private-row"), false);
  assert.equal(
    result.retainedFiles.files.some((x) => /-(wal|shm)$/u.test(x.path)),
    false,
  );
  assert.deepEqual(databaseFacts(f.path), result.source.database);
  const oldHash = fileFact(result.backup.backupPath);
  await assert.rejects(retainData({ dataRoot: f.dataRoot, outputRoot }), /RETENTION_ROOT_INVALID/);
  assert.deepEqual(fileFact(result.backup.backupPath), oldHash);
  f.db.prepare("UPDATE capture_artifacts SET payload=?").run(Buffer.from([4]));
  assert.notDeepEqual(
    databaseFacts(f.path).tables.capture_artifacts,
    result.source.database.tables.capture_artifacts,
  );
});

test("missing referenced bytes fails with recovery DB retained and source untouched", async (t) => {
  const f = databaseFixture(t);
  const actualFile = join(f.dataRoot, "evidence", f.storageKey);
  writeFileSync(actualFile, "deliberate-corrupt-fixture");
  const before = databaseFacts(f.path),
    sourceBytes = fileFact(actualFile);
  const target = join(f.root, "failed-retention");
  await assert.rejects(retainData({ dataRoot: f.dataRoot, outputRoot: target }));
  assert(existsSync(join(target, "online", "qa-hub.sqlite")));
  assert.deepEqual(databaseFacts(f.path), before);
  assert.deepEqual(fileFact(actualFile), sourceBytes);
});

test("an enabled project component blocks the proposed restart baseline before backup", async (t) => {
  const f = databaseFixture(t);
  f.db.prepare("INSERT INTO project_components VALUES(?,?)").run("build", 1);
  const target = join(f.root, "component-refused");
  await assert.rejects(
    retainData({ dataRoot: f.dataRoot, outputRoot: target }),
    /SCHEMA14_AND_COMPONENTS_OFF_REQUIRED/,
  );
  assert.equal(existsSync(join(target, "online", "qa-hub.sqlite")), false);
  assert.equal(databaseFacts(f.path).componentGate.enabledRows, 1);
});

test("create-only copy rejects stale facts, live WAL names and junctions without overwriting", (t) => {
  const root = folder(t),
    input = join(root, "input");
  mkdirSync(input);
  writeFileSync(join(input, "file"), "one");
  const facts = treeFacts(input);
  writeFileSync(join(input, "file"), "two");
  assert.throws(
    () => copyTreeCreateOnly(input, join(root, "stale"), facts),
    /COPIED_FILE_MISMATCH/,
  );
  assert.equal(readFileSync(join(input, "file"), "utf8"), "two");
  writeFileSync(join(input, "queue.sqlite-wal"), "never-copy");
  assert.throws(
    () => copyTreeCreateOnly(input, join(root, "wal")),
    /LIVE_SQLITE_SIDECAR_COPY_REFUSED/,
  );
  const outside = join(root, "outside"),
    links = join(root, "links");
  mkdirSync(outside);
  mkdirSync(links);
  symlinkSync(outside, join(links, "junction"), "junction");
  assert.throws(() => treeFacts(links), /TREE_LINK_REFUSED/);
});

test("Android readers preserve version strings, accept hashes only and never expose preference values", () => {
  assert.deepEqual(
    parseAndroidVersion("  versionCode=23 minSdk=26\n  versionName=0.2.0-preview.9\n"),
    { versionCode: 23, versionName: "0.2.0-preview.9" },
  );
  assert.deepEqual(parseAndroidHashes("a".repeat(64) + "  shared_prefs/test.xml\n"), [
    { path: "shared_prefs/test.xml", sha256: "a".repeat(64) },
  ]);
  assert.throws(() => parseAndroidHashes("permission denied"), /ANDROID_HASH_READ_FAILED/);
  assert.throws(() => parseAndroidVersion("no package"), /ANDROID_VERSION_UNAVAILABLE/);
  assert(androidCommands()[5].includes(String.raw`{} \;'`));
  assert(
    !androidCommands().some((x) =>
      /force-stop|install|start-server|logcat|\bcat\b|\brm\b/u.test(x),
    ),
  );
});

test("raw ADB transport uses fixed existing server and handles fragmented replies in memory only", async () => {
  const writes = [];
  const socketFactory = (options) => {
    assert.deepEqual(options, { host: "127.0.0.1", port: 5037 });
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    socket.write = (value) => {
      const text = value.toString(),
        body = text.slice(4);
      assert.equal(parseInt(text.slice(0, 4), 16), Buffer.byteLength(body));
      writes.push(body);
      queueMicrotask(() => {
        socket.emit("data", Buffer.from("O"));
        socket.emit("data", Buffer.from("KAY"));
        if (body.startsWith("shell:")) {
          socket.emit("data", Buffer.from("1234\r\n"));
          socket.emit("end");
        }
      });
    };
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
  assert.equal(await adbRead(androidCommands()[0], { socketFactory }), "1234");
  assert.deepEqual(writes, ["host:transport:127.0.0.1:16384", "shell:" + androidCommands()[0]]);
  await assert.rejects(
    adbRead("install anything", { socketFactory: () => assert.fail("must not connect") }),
    /ADB_COMMAND_REFUSED/,
  );
});

test("post-comparison excludes only the old API identity, retaining every other process and socket", () => {
  const original = {
    services: [
      { service: "api", pid: 1 },
      { service: "web", pid: 2 },
    ],
    processes: [{ pid: 1 }, { pid: 2 }, { pid: 3 }],
    listeners: [
      { LocalPort: 4419, OwningProcess: 1 },
      { LocalPort: 4420, OwningProcess: 3 },
    ],
    installed: { productVersion: "0.2.0-preview.8" },
  };
  assert.deepEqual(withoutApi(original), {
    services: [{ service: "web", pid: 2 }],
    processes: [{ pid: 2 }, { pid: 3 }],
    listeners: [{ LocalPort: 4420, OwningProcess: 3 }],
    installed: { productVersion: "0.2.0-preview.8" },
  });
  assert.equal(original.processes.length, 3);
});
