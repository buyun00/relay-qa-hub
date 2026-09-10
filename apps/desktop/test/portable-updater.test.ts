import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { PortableUpdater, parseAndVerifyUpdateManifest } from "../src/portable-updater.js";

async function updateFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "qa-hub-latest-update-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  function release(day: string, version: string) {
    const archive = Buffer.from(`Full installer for QA Hub ${version}`);
    const payload = {
      schemaVersion: 1 as const,
      releaseId: `202609${day}T000000000Z`,
      version,
      publishedAt: `2026-09-${day}T00:00:00.000Z`,
      archive: {
        url: "/downloads/Relay-QA-Hub-Setup-x64.exe",
        size: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
    };
    return {
      archive,
      manifest: {
        ...payload,
        signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64"),
      },
    };
  }
  const intermediate = release("06", "2.0.2");
  const latest = release("08", "2.0.10");
  const server = {
    release: intermediate,
    manifestStatus: 200,
    corruptSignature: false,
    corruptArchive: false,
    afterArchiveRequest: () => undefined as void,
  };
  const manifestRequests: string[] = [];
  const archiveRequests: string[] = [];
  const quit = t.mock.fn();
  await fs.writeFile(
    path.join(root, "release.json"),
    JSON.stringify({ schemaVersion: 1, releaseId: "20260905T000000000Z", version: "1.3.2" }),
  );
  const updater = new PortableUpdater({
    currentReleaseFile: path.join(root, "release.json"),
    updatesDirectory: path.join(root, "updates"),
    installDirectory: root,
    executableName: "RelayQaHub.exe",
    manifestUrl: new URL("https://updates.example.test/latest.json"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    requestQuit: quit,
    fetchImpl: async (input, options) => {
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.redirect, "error");
      const current = server.release;
      if (String(input).endsWith("latest.json")) {
        manifestRequests.push(current.manifest.version);
        return Response.json(
          server.corruptSignature ? { ...current.manifest, version: "99.0.0" } : current.manifest,
          { status: server.manifestStatus },
        );
      }
      archiveRequests.push(current.manifest.version);
      server.afterArchiveRequest();
      const body = Buffer.from(current.archive);
      if (server.corruptArchive) body[0] = 0;
      return new Response(body, { headers: { "content-length": String(body.length) } });
    },
  });
  await updater.initialize();
  return { root, updater, server, intermediate, latest, manifestRequests, archiveRequests, quit };
}

test("a downloaded update is superseded by the latest full release without an intermediate install", async (t) => {
  const f = await updateFixture(t);
  await f.updater.check();
  assert.equal(f.updater.state.status, "ready");
  f.server.release = f.latest;
  await f.updater.check();
  assert.deepEqual(f.updater.state, {
    status: "ready",
    releaseId: f.latest.manifest.releaseId,
    version: "2.0.10",
    publishedAt: f.latest.manifest.publishedAt,
  });
  assert.deepEqual(f.archiveRequests, ["2.0.2", "2.0.10"]);
  assert.equal(f.quit.mock.callCount(), 0);
});

test("unchanged signed packages are checked again without downloading them again", async (t) => {
  const f = await updateFixture(t);
  await f.updater.check();
  const previousChecks = f.manifestRequests.length;
  await Promise.all([f.updater.check(), f.updater.check()]);
  assert.equal(f.manifestRequests.length, previousChecks + 1);
  assert.deepEqual(f.archiveRequests, ["2.0.2"]);
  assert.equal(f.updater.state.status, "ready");
});

test("installation rechecks latest and coalesces double clicks before the native handoff", async (t) => {
  const f = await updateFixture(t);
  await f.updater.check();
  f.server.release = f.latest;
  const install = f.updater.install();
  assert.equal(f.updater.install(), install);
  const check = f.updater.check();
  assert.equal(await install, false); // No native helper in this unit fixture.
  await check;
  assert.deepEqual(f.archiveRequests, ["2.0.2", "2.0.10"]);
  assert.deepEqual(f.updater.state, { status: "error", message: "UPDATE_UPDATER_MISSING" });
  assert.equal(f.quit.mock.callCount(), 0);
});

test("notification activation installs only the exact clicked release after latest revalidation", async (t) => {
  const f = await updateFixture(t);
  await f.updater.check();
  const clickedReleaseId = f.intermediate.manifest.releaseId;
  f.server.release = f.latest;
  assert.equal(await f.updater.installRelease(clickedReleaseId), false);
  assert.deepEqual(f.updater.state, {
    status: "ready",
    releaseId: f.latest.manifest.releaseId,
    version: f.latest.manifest.version,
    publishedAt: f.latest.manifest.publishedAt,
  });
  assert.deepEqual(f.archiveRequests, ["2.0.2", "2.0.10"]);
  assert.equal(f.quit.mock.callCount(), 0);
  assert.equal(await f.updater.installRelease("not-a-release"), false);
});

test("a release published during download is selected before reporting ready", async (t) => {
  const f = await updateFixture(t);
  f.server.afterArchiveRequest = () => {
    f.server.release = f.latest;
  };
  await f.updater.check();
  assert.deepEqual(f.archiveRequests, ["2.0.2", "2.0.10"]);
  assert.equal(f.updater.state.status, "ready");
  assert.ok("version" in f.updater.state && f.updater.state.version === "2.0.10");
});

test("installation waits for an active check and then confirms latest again", async (t) => {
  const f = await updateFixture(t);
  f.server.release = f.latest;
  const check = f.updater.check();
  const install = f.updater.install();
  await check;
  assert.equal(await install, false);
  assert.deepEqual(f.archiveRequests, ["2.0.10"]);
  assert.deepEqual(f.manifestRequests, ["2.0.10", "2.0.10", "2.0.10"]);
  assert.equal(f.quit.mock.callCount(), 0);
});

test("a continually changing channel stops safely instead of installing an obsolete download", async (t) => {
  const f = await updateFixture(t);
  f.server.afterArchiveRequest = () => {
    f.server.release = f.server.release === f.intermediate ? f.latest : f.intermediate;
  };
  assert.equal(await f.updater.install(), false);
  assert.deepEqual(f.updater.state, { status: "error", message: "UPDATE_RELEASE_CHANGED_RETRY" });
  assert.equal(f.archiveRequests.length, 3);
  assert.equal(f.quit.mock.callCount(), 0);
});

for (const failure of ["network", "signature", "hash"] as const) {
  test(`failed latest ${failure} validation never installs the stale cached release`, async (t) => {
    const f = await updateFixture(t);
    await f.updater.check();
    f.server.release = f.latest;
    f.server.manifestStatus = failure === "network" ? 503 : 200;
    f.server.corruptSignature = failure === "signature";
    f.server.corruptArchive = failure === "hash";
    assert.equal(await f.updater.install(), false);
    assert.deepEqual(f.updater.state, {
      status: "error",
      message: {
        network: "UPDATE_MANIFEST_HTTP_503",
        signature: "UPDATE_MANIFEST_SIGNATURE_INVALID",
        hash: "UPDATE_ARCHIVE_HASH_MISMATCH",
      }[failure],
    });
    assert.equal(f.quit.mock.callCount(), 0);
    f.server.manifestStatus = 200;
    f.server.corruptSignature = false;
    f.server.corruptArchive = false;
    await f.updater.check();
    assert.ok("version" in f.updater.state && f.updater.state.version === "2.0.10");
  });
}

test("a missing or modified cached installer is downloaded and verified again", async (t) => {
  const f = await updateFixture(t);
  await f.updater.check();
  const archive = path.join(f.root, "updates", `${f.intermediate.manifest.releaseId}.exe`);
  await fs.writeFile(archive, Buffer.alloc(f.intermediate.archive.length));
  await f.updater.check();
  assert.deepEqual(await fs.readFile(archive), f.intermediate.archive);
  await fs.rm(archive);
  await f.updater.check();
  assert.deepEqual(f.archiveRequests, ["2.0.2", "2.0.2", "2.0.2"]);
  assert.equal(f.updater.state.status, "ready");
});

test("retries retain interrupted downloads and rejected installer bytes", async (t) => {
  const f = await updateFixture(t);
  const directory = path.join(f.root, "updates");
  const archiveName = `${f.intermediate.manifest.releaseId}.exe`;
  await fs.mkdir(directory, { recursive: true });
  const interruptedName = `${archiveName}.previous.partial`;
  const interrupted = Buffer.from("previous interrupted download");
  await fs.writeFile(path.join(directory, interruptedName), interrupted);
  f.server.corruptArchive = true;
  await f.updater.check();
  assert.deepEqual(f.updater.state, { status: "error", message: "UPDATE_ARCHIVE_HASH_MISMATCH" });
  const failedName = (await fs.readdir(directory)).find((name) => name.endsWith(".partial.failed"));
  assert.ok(failedName);
  const rejected = await fs.readFile(path.join(directory, failedName));
  assert.equal(rejected.length, f.intermediate.archive.length);
  assert.notDeepEqual(rejected, f.intermediate.archive);
  f.server.corruptArchive = false;
  await f.updater.check();
  assert.equal(f.updater.state.status, "ready");
  const modified = Buffer.alloc(f.intermediate.archive.length, 7);
  await fs.writeFile(path.join(directory, archiveName), modified);
  await f.updater.check();
  const retainedName = (await fs.readdir(directory)).find((name) =>
    name.startsWith(`${archiveName}.retained-`),
  );
  assert.ok(retainedName);
  assert.deepEqual(await fs.readFile(path.join(directory, retainedName)), modified);
  assert.deepEqual(await fs.readFile(path.join(directory, interruptedName)), interrupted);
  assert.deepEqual(await fs.readFile(path.join(directory, failedName)), rejected);
  assert.deepEqual(await fs.readFile(path.join(directory, archiveName)), f.intermediate.archive);
});

function signedManifest() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1 as const,
    releaseId: "20260827T130102345Z",
    version: "0.1.0-debug",
    publishedAt: "2026-08-27T13:01:02.345Z",
    archive: {
      url: "/downloads/Relay-QA-Hub-Setup-x64.exe",
      size: 123_456,
      sha256: "a".repeat(64),
    },
  };
  return {
    manifest: {
      ...payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64"),
    },
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("portable updater accepts a valid Ed25519 signed manifest", () => {
  const fixture = signedManifest();
  assert.deepEqual(
    parseAndVerifyUpdateManifest(fixture.manifest, fixture.publicKeyPem),
    fixture.manifest,
  );
});

test("portable updater rejects a manifest whose archive hash was replaced", () => {
  const fixture = signedManifest();
  assert.equal(
    parseAndVerifyUpdateManifest(
      {
        ...fixture.manifest,
        archive: { ...fixture.manifest.archive, sha256: "b".repeat(64) },
      },
      fixture.publicKeyPem,
    ),
    null,
  );
});

test("portable updater surfaces a failed newer install after the old release restarts", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "qa-hub-update-result-"));
  const updatesDirectory = path.join(root, "updates");
  try {
    await fs.mkdir(updatesDirectory, { recursive: true });
    await fs.writeFile(
      path.join(root, "release.json"),
      JSON.stringify({
        schemaVersion: 1,
        releaseId: "20260827T120000000Z",
        version: "0.1.0-debug",
      }),
    );
    await fs.writeFile(
      path.join(updatesDirectory, "last-update-result.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "failed",
        releaseId: "20260827T130000000Z",
        version: "0.1.1-debug",
        recordedAt: "2026-08-27T13:00:00.000Z",
        message: "simulated failure",
      }),
    );
    const updater = new PortableUpdater({
      currentReleaseFile: path.join(root, "release.json"),
      updatesDirectory,
      installDirectory: root,
      executableName: "RelayQaHub.exe",
      manifestUrl: new URL("https://updates.example.test/latest.json"),
      requestQuit: () => undefined,
    });
    await updater.initialize();
    assert.deepEqual(updater.state, { status: "error", message: "UPDATE_INSTALL_FAILED" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
