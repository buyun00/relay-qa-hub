import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  artifact,
  assertPreimage,
  installImmutableFile,
  manifestBytes,
  preimage,
  readDistribution,
  replaceManifestExact,
  pinnedSourceFacts,
  validateDeploymentProofs,
} from "./publish-preview-android-code23.mjs";
import { fileFact, hash } from "./retain-preview-android-update-state.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qa-code23-publish-unit-"));
  const feed = join(root, "feed"),
    retained = join(root, "retained");
  mkdirSync(feed);
  mkdirSync(retained);
  t.after(() => {
    const path = relative(tmpdir(), root);
    assert(!isAbsolute(path) && !path.startsWith(".."));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, feed, retained };
}

test("default and invalid explicit modes have no runtime/HTTP action", () => {
  const path = resolve("scripts/project-components/publish-preview-android-code23.mjs");
  const inert = spawnSync(process.execPath, [path], { encoding: "utf8" });
  assert.equal(inert.status, 0);
  assert.deepEqual(JSON.parse(inert.stdout), {
    status: "not_run",
    runtimeReads: 0,
    writes: 0,
    httpRequests: 0,
  });
  const invalid = spawnSync(
    process.execPath,
    [path, "--prepare", "Z:/not-instance.json", "bad-id", "absent"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr.trim(), "CODE23_ARGUMENT_OR_SETUP_REFUSED");
});

test("manifest fixes original package, numeric version, origin commit and exact original APK bytes", () => {
  const manifest = JSON.parse(manifestBytes().toString());
  assert.deepEqual(manifest, { schemaVersion: 1, channel: "preview", ...artifact });
  assert.equal(manifest.packageName, "com.relayqahub.android.preview.debug");
  assert.equal(manifest.versionCode, 23);
  assert.equal(manifest.versionName, "0.2.0-preview.9");
  assert.equal(manifest.size, 35536941);
  assert.equal(manifest.sha256, "9cfa87eb36b5be80f218e104fb4c6338fda3e96e5dcc694d897c5907df768548");
});

test("frozen API source and retention dependency pins match the reviewed repository files", () => {
  const facts = pinnedSourceFacts();
  assert.equal(facts.length, 9);
  assert.equal(facts.filter((x) => x.path.startsWith("apps/api/")).length, 8);
});

test("deployment proof validation rejects missing checks, failed before, cross-run, changed binding and enabled components", () => {
  const beforePath = resolve("synthetic-before-proof.json");
  const base = {
    runId: "7a94eb90-63a2-4841-afa5-318612eb06ce",
    status: "passed",
    runnerSha256: "669042c8c82307d02bd291e9de99b1ddc5af86694a83425158bd55ee35c000f3",
    checks: [
      { label: "DATABASE_AND_FILES_UNCHANGED", passed: true },
      { label: "FIVE_OTHER_ENTRIES_PRODUCTION_CONFIG_FEED_UNCHANGED", passed: true },
    ],
  };
  const input = {
    beforePath,
    beforeSha256: "a".repeat(64),
    before: { ...structuredClone(base), phase: "before" },
    after: {
      ...structuredClone(base),
      phase: "after",
      beforeProof: { path: beforePath, sha256: "a".repeat(64) },
      currentData: { database: { schemaVersion: 14, componentGate: { enabledRows: 0 } } },
    },
  };
  assert.doesNotThrow(() => validateDeploymentProofs(input));
  for (const mutate of [
    (x) => {
      x.before.status = "failed";
    },
    (x) => {
      x.after.runId = "another-run";
    },
    (x) => {
      x.after.checks = [];
    },
    (x) => {
      x.after.checks[0].passed = false;
    },
    (x) => {
      x.after.checks = [{ label: "unrelated", passed: true }];
    },
    (x) => {
      x.after.beforeProof.sha256 = "b".repeat(64);
    },
    (x) => {
      x.after.beforeProof.path = resolve("another-before.json");
    },
    (x) => {
      x.after.runnerSha256 = "b".repeat(64);
    },
    (x) => {
      x.after.currentData.database.componentGate.enabledRows = 1;
    },
  ]) {
    const negative = structuredClone(input);
    mutate(negative);
    assert.throws(() => validateDeploymentProofs(negative));
  }
});

test("verified APK temp is create-only linked, retained and identical-existing is never overwritten", (t) => {
  const f = fixture(t),
    input = join(f.root, "synthetic-source.apk");
  writeFileSync(input, "synthetic-apk-transport-only");
  const expected = fileFact(input);
  const result = installImmutableFile(input, f.feed, "fixture.apk", expected);
  assert.equal(result.disposition, "created");
  assert.deepEqual(fileFact(result.path), expected);
  assert.deepEqual(fileFact(result.temp), expected);
  assert.equal(
    installImmutableFile(input, f.feed, "fixture.apk", expected).disposition,
    "existing-identical",
  );
  writeFileSync(join(f.feed, "different.apk"), "retain-different");
  assert.throws(
    () => installImmutableFile(input, f.feed, "different.apk", expected),
    /EXISTING_ARTIFACT_DIFFERENT/,
  );
  assert.equal(readFileSync(join(f.feed, "different.apk"), "utf8"), "retain-different");
  assert.throws(
    () => installImmutableFile(input, f.feed, "../escaped.apk", expected),
    /ARTIFACT_FILENAME_REFUSED/,
  );
});

test("first latest publication atomically links complete bytes and leaves temp available", (t) => {
  const f = fixture(t);
  const bytes = manifestBytes();
  const result = replaceManifestExact({
    root: f.feed,
    retainedRoot: f.retained,
    bytes,
    expected: { exists: false },
  });
  assert.equal(result.tempRetained, true);
  assert.deepEqual(readFileSync(result.path), bytes);
  assert.deepEqual(readFileSync(result.temp), bytes);
  assert.throws(
    () =>
      replaceManifestExact({
        root: f.feed,
        retainedRoot: f.retained,
        bytes,
        expected: { exists: false },
      }),
    /LATEST_PREIMAGE_CHANGED/,
  );
});

test("reviewed existing latest is fully retained before atomic replacement; stale preimage refuses", (t) => {
  const f = fixture(t),
    latest = join(f.feed, "latest.json");
  const old = Buffer.from('{"schemaVersion":1,"fixture":"old-full-bytes"}\n');
  writeFileSync(latest, old);
  const expected = preimage(latest);
  const result = replaceManifestExact({
    root: f.feed,
    retainedRoot: f.retained,
    bytes: manifestBytes(),
    expected,
  });
  assert.deepEqual(readFileSync(result.retainedOld), old);
  assert.equal(result.tempRetained, false);
  assert.equal(existsSync(result.temp), false);
  assert.deepEqual(readFileSync(latest), manifestBytes());
  assert.throws(() => assertPreimage(latest, expected), /LATEST_PREIMAGE_CHANGED/);
  assert.deepEqual(readFileSync(result.retainedOld), old);
});

test("distribution reader records only safe headers and exact bytes using in-memory HTTP responses", async () => {
  const ledger = [];
  const value = Buffer.from([1, 2, 3]);
  const fakeFetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:4419/api/v1/android-updates/preview/" + artifact.fileName);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    return new Response(value, {
      headers: {
        "content-type": "application/vnd.android.package-archive",
        "set-cookie": "synthetic-must-not-record",
        authorization: "synthetic-must-not-record",
      },
    });
  };
  const result = await readDistribution(
    "http://127.0.0.1:4419/api/v1/android-updates/preview/" + artifact.fileName,
    {},
    ledger,
    fakeFetch,
  );
  assert.deepEqual(result.body, value);
  assert.equal(ledger[0].sha256, hash(value));
  assert.equal(ledger[0].bytes, 3);
  assert.equal(JSON.stringify(ledger).includes("synthetic-must-not-record"), false);
  assert.equal(ledger[0].headers["content-type"], "application/vnd.android.package-archive");
});

test("unsupported host, route, mutation or range never invokes transport; oversize response fails", async () => {
  const never = () => assert.fail("unexpected transport");
  await assert.rejects(
    readDistribution(
      "http://127.0.0.1:4319/api/v1/android-updates/stable/latest.json",
      {},
      [],
      never,
    ),
    /HTTP_DISTRIBUTION_READ_REFUSED/,
  );
  await assert.rejects(
    readDistribution("http://127.0.0.1:4419/api/v1/bugs", {}, [], never),
    /HTTP_DISTRIBUTION_READ_REFUSED/,
  );
  const allowed = "http://127.0.0.1:4419/api/v1/android-updates/preview/latest.json";
  await assert.rejects(
    readDistribution(allowed, { method: "POST" }, [], never),
    /HTTP_DISTRIBUTION_READ_REFUSED/,
  );
  await assert.rejects(
    readDistribution(allowed, { range: "bytes=1-2" }, [], never),
    /HTTP_DISTRIBUTION_READ_REFUSED/,
  );
  await assert.rejects(
    readDistribution(allowed, { maxBytes: 1 }, [], async () => new Response("oversize")),
    /HTTP_RESPONSE_TOO_LARGE/,
  );
});
