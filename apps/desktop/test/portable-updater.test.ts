import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PortableUpdater, parseAndVerifyUpdateManifest } from "../src/portable-updater.js";

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
