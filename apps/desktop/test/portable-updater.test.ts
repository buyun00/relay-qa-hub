import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  INSTALL_HELPER,
  PortableUpdater,
  parseAndVerifyUpdateManifest,
} from "../src/portable-updater.js";

function signedManifest() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1 as const,
    releaseId: "20260827T130102345Z",
    version: "0.1.0-debug",
    publishedAt: "2026-08-27T13:01:02.345Z",
    archive: {
      url: "/downloads/Relay-QA-Hub-Windows-x64.zip",
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

test(
  "install helper accepts a renamed portable directory and preserves its runtime config",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "qa-hub-update-helper-"));
    const installDirectory = path.join(root, "QA Hub Custom Folder");
    const payloadDirectory = path.join(root, "payload", "RelayQaHub-win32-x64");
    const archive = path.join(root, "update.zip");
    const helper = path.join(root, "install-update.ps1");
    const log = path.join(root, "install-update.log");
    const result = path.join(root, "last-update-result.json");
    try {
      await fs.mkdir(installDirectory, { recursive: true });
      await fs.mkdir(payloadDirectory, { recursive: true });
      await fs.copyFile(
        "C:\\Windows\\System32\\where.exe",
        path.join(installDirectory, "RelayQaHub.exe"),
      );
      await fs.copyFile(
        "C:\\Windows\\System32\\where.exe",
        path.join(payloadDirectory, "RelayQaHub.exe"),
      );
      await fs.writeFile(path.join(installDirectory, "old-marker.txt"), "old\n");
      await fs.writeFile(path.join(installDirectory, "desktop-runtime.json"), '{"server":"old"}\n');
      await fs.writeFile(path.join(payloadDirectory, "new-marker.txt"), "new\n");
      await fs.writeFile(path.join(payloadDirectory, "desktop-runtime.json"), '{"server":"new"}\n');
      await fs.writeFile(helper, INSTALL_HELPER);
      const compression = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "& { param($source, $destination) Compress-Archive -LiteralPath $source -DestinationPath $destination -Force }",
          payloadDirectory,
          archive,
        ],
        { encoding: "utf8" },
      );
      assert.equal(compression.status, 0, compression.stderr);
      const installed = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helper,
          "-CurrentPid",
          "2147483647",
          "-PackageDirectory",
          installDirectory,
          "-ArchivePath",
          archive,
          "-ExecutableName",
          "RelayQaHub.exe",
          "-LogPath",
          log,
          "-ResultPath",
          result,
          "-ReleaseId",
          "20260827T130102345Z",
          "-Version",
          "0.1.1-debug",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
      await fs.access(path.join(installDirectory, "new-marker.txt"));
      assert.equal(
        await fs.readFile(path.join(installDirectory, "desktop-runtime.json"), "utf8"),
        '{"server":"old"}\n',
      );
      const updateResult = JSON.parse(await fs.readFile(result, "utf8")) as {
        status: string;
        releaseId: string;
      };
      assert.equal(updateResult.status, "installed");
      assert.equal(updateResult.releaseId, "20260827T130102345Z");
      const backups = (await fs.readdir(root)).filter((entry) =>
        entry.startsWith("QA Hub Custom Folder.backup-"),
      );
      assert.equal(backups.length, 1);
      await fs.access(path.join(root, backups[0]!, "old-marker.txt"));
    } finally {
      let cleanupError: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          cleanupError = undefined;
          break;
        } catch (cause) {
          cleanupError = cause;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
    }
  },
);
