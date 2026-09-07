import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { parseAndVerifyUpdateManifest } from "../dist/portable-updater.js";

// Disposable loopback channel for the packaged stale-download regression test.
const config = JSON.parse(readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/u, ""));
const releases = [];
for (const entry of config.releases) {
  const manifest = parseAndVerifyUpdateManifest(
    JSON.parse(readFileSync(entry.manifestFile, "utf8")),
  );
  assert.ok(manifest, "Test channel requires a real signed release");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(entry.installerFile)) {
    hash.update(chunk);
    size += chunk.length;
  }
  assert.equal(size, manifest.archive.size);
  assert.equal(hash.digest("hex"), manifest.archive.sha256);
  releases.push({ ...entry, manifest });
}
assert.equal(releases.length, 2);
assert.ok(releases[0].manifest.releaseId < releases[1].manifest.releaseId);
const requests = [];
const server = createServer((request, response) => {
  const release = releases[existsSync(config.advanceFile) ? 1 : 0];
  const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
  const manifestPath = "/downloads/Relay-QA-Hub-Windows-x64-latest.json";
  const archivePath = new URL(release.manifest.archive.url, "http://127.0.0.1").pathname;
  if (request.method !== "GET" || ![manifestPath, archivePath].includes(requestPath)) {
    response.writeHead(404).end();
    return;
  }
  requests.push({
    kind: requestPath === manifestPath ? "manifest" : "installer",
    releaseId: release.manifest.releaseId,
  });
  writeFileSync(config.receiptFile, JSON.stringify(requests, null, 2));
  response.setHeader("Cache-Control", "no-store");
  if (requestPath === manifestPath) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(release.manifest));
    return;
  }
  response.setHeader("Content-Length", release.manifest.archive.size);
  response.setHeader("Content-Type", "application/octet-stream");
  void pipeline(createReadStream(release.installerFile), response).catch(() => response.destroy());
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(
    config.readyFile,
    JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}` }),
  );
});
