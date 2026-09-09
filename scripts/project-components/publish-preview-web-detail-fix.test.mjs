import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fileFact, treeFacts, copyTreeCreateOnly } from "./retain-preview-android-update-state.mjs";
import {
  installAssets,
  mergedInventory,
  safeFile,
  switchIndex,
  validateInventory,
} from "./publish-preview-web-detail-fix.mjs";

const script = fileURLToPath(new URL("./publish-preview-web-detail-fix.mjs", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qa-web-publication-fixture-"));
  const served = join(root, "served"),
    candidate = join(root, "candidate"),
    pending = join(root, "pending");
  for (const path of [served, candidate, pending]) mkdirSync(path);
  for (const path of [served, candidate]) {
    mkdirSync(join(path, "assets"));
    writeFileSync(join(path, "assets/shared.css"), "body{color:#000}");
  }
  writeFileSync(join(served, "index.html"), '<script src="/assets/old.js"></script>');
  writeFileSync(join(served, "assets/old.js"), "window.old=true;");
  writeFileSync(join(candidate, "index.html"), '<script src="/assets/new.js"></script>');
  writeFileSync(join(candidate, "assets/new.js"), "window.fixed=true;");
  return {
    root,
    served,
    candidate,
    pending,
    oldFiles: treeFacts(served).files,
    newFiles: treeFacts(candidate).files,
  };
}
function entry(files, path) {
  const row = files.find((value) => value.path === path);
  return { bytes: row.bytes, sha256: row.sha256 };
}

test("default CLI is inert, including when invoked from an empty unrelated directory", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-web-publication-inert-"));
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.status, "not_run");
  assert.deepEqual(
    [proof.reads, proof.writes, proof.http, proof.builds, proof.serviceOperations],
    [0, 0, 0, 0, 0],
  );
  assert.deepEqual(readdirSync(root), []);
});

test("traversal, encoded paths, Windows aliases and duplicate case inventory are rejected", () => {
  for (const path of [
    "../x",
    "/x",
    "x\\y",
    "C:/x",
    "x//y",
    "x/./y",
    "x/../y",
    "x%2fy",
    "x:stream",
  ]) {
    assert.throws(() => safeFile(tmpdir(), path), /FILE_PATH/u);
  }
  const f = fixture();
  assert.throws(
    () =>
      validateInventory(
        [...f.oldFiles, { ...f.oldFiles[0], path: f.oldFiles[0].path.toUpperCase() }],
        4,
      ),
    /INVENTORY_DUPLICATE/u,
  );
  assert.throws(() => validateInventory(f.oldFiles, 8), /INVENTORY_COUNT/u);
});

test("whole old tree and candidate are retained create-only and independently verified", () => {
  const f = fixture(),
    destination = join(f.root, "cold-restore");
  copyTreeCreateOnly(f.served, destination);
  assert.deepEqual(treeFacts(destination).files, f.oldFiles);
  assert.throws(() => copyTreeCreateOnly(f.served, destination), /COPY_TARGET_EXISTS/u);
  assert.deepEqual(treeFacts(f.served).files, f.oldFiles);
});

test("assets install first without changing HTML, then one index switch selects new bytes", () => {
  const f = fixture();
  installAssets(f.candidate, f.served, f.pending, f.newFiles);
  assert.deepEqual(treeFacts(f.served).files, mergedInventory(f.oldFiles, f.newFiles, true));
  switchIndex(
    join(f.candidate, "index.html"),
    f.served,
    f.pending,
    entry(f.oldFiles, "index.html"),
    entry(f.newFiles, "index.html"),
  );
  assert.deepEqual(treeFacts(f.served).files, mergedInventory(f.oldFiles, f.newFiles));
  assert.equal(readFileSync(join(f.served, "assets/old.js"), "utf8"), "window.old=true;");
  assert.ok(readdirSync(f.pending).some((path) => path.endsWith(".pending")));
});

test("explicit old-index restoration keeps both generations of immutable assets", () => {
  const f = fixture(),
    backup = join(f.root, "cold-restore");
  copyTreeCreateOnly(f.served, backup);
  installAssets(f.candidate, f.served, f.pending, f.newFiles);
  switchIndex(
    join(f.candidate, "index.html"),
    f.served,
    f.pending,
    entry(f.oldFiles, "index.html"),
    entry(f.newFiles, "index.html"),
  );
  switchIndex(
    join(backup, "index.html"),
    f.served,
    f.pending,
    entry(f.newFiles, "index.html"),
    entry(f.oldFiles, "index.html"),
  );
  assert.deepEqual(treeFacts(f.served).files, mergedInventory(f.oldFiles, f.newFiles, true));
  assert.deepEqual(treeFacts(backup).files, f.oldFiles);
});

test("same-path changed non-index asset is refused before publication", () => {
  const f = fixture();
  writeFileSync(join(f.candidate, "assets/shared.css"), "changed");
  const changed = treeFacts(f.candidate).files;
  assert.throws(() => mergedInventory(f.oldFiles, changed), /MUTABLE_ASSET_COLLISION/u);
  assert.deepEqual(treeFacts(f.served).files, f.oldFiles);
});

test("candidate tampering rejects asset installation and leaves original HTML", () => {
  const f = fixture();
  writeFileSync(join(f.candidate, "assets/new.js"), "tampered");
  assert.throws(
    () => installAssets(f.candidate, f.served, f.pending, f.newFiles),
    /CANDIDATE_FILE_CHANGED/u,
  );
  assert.deepEqual(treeFacts(f.served).files, f.oldFiles);
});

test("an existing different new asset cannot be overwritten; failure retains all files", () => {
  const f = fixture();
  writeFileSync(join(f.served, "assets/new.js"), "other-writer");
  assert.throws(
    () => installAssets(f.candidate, f.served, f.pending, f.newFiles),
    /EXISTING_ASSET_DIFFERENT/u,
  );
  assert.equal(readFileSync(join(f.served, "assets/new.js"), "utf8"), "other-writer");
  assert.deepEqual(fileFact(join(f.served, "index.html")), entry(f.oldFiles, "index.html"));
});

test("changed HTML preimage fails closed after assets with no auto-revert or deletion", () => {
  const f = fixture();
  installAssets(f.candidate, f.served, f.pending, f.newFiles);
  writeFileSync(join(f.served, "index.html"), "other-index");
  assert.throws(
    () =>
      switchIndex(
        join(f.candidate, "index.html"),
        f.served,
        f.pending,
        entry(f.oldFiles, "index.html"),
        entry(f.newFiles, "index.html"),
      ),
    /INDEX_PREIMAGE_CHANGED/u,
  );
  assert.equal(readFileSync(join(f.served, "index.html"), "utf8"), "other-index");
  assert.equal(readFileSync(join(f.served, "assets/new.js"), "utf8"), "window.fixed=true;");
});

test("junction candidate tree and served parent are refused, no outside file is changed", () => {
  const f = fixture(),
    outside = join(f.root, "outside"),
    junction = join(f.root, "junction");
  mkdirSync(outside);
  symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => treeFacts(junction), /CANONICAL_PATH_REQUIRED|ORDINARY_PATH_REQUIRED/u);
  assert.throws(
    () => installAssets(f.candidate, junction, f.pending, f.newFiles),
    /DIRECTORY_LINK_REFUSED/u,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("unknown mode and production-shaped arguments do not access config or mutate temp directory", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-web-publication-refused-"));
  for (const args of [
    ["--run"],
    ["--prepare", "D:/Relay-QA-Hub/instance.json", "11111111-1111-1111-1111-111111111111"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr.trim()).status, "failed_retained");
  }
  assert.deepEqual(readdirSync(root), []);
  assert.equal(dirname(script).endsWith("project-components"), true);
});
