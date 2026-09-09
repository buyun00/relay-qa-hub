import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { startPreviewWeb } from "../../scripts/project-components/preview-web.mjs";

const repositoryRoot = process.cwd();

function source(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

test("portable packaging cannot overwrite the installer update manifest", () => {
  const portablePackaging = source("apps/desktop/scripts/package-windows.ps1");
  const windowsPublishing = source("scripts/Publish-QAHubWindows.ps1");
  const webConfig = source("apps/web/vite.config.ts");

  assert.match(portablePackaging, /RelayQaHub-win32-x64-portable-latest\.json/u);
  assert.doesNotMatch(
    portablePackaging,
    /Join-Path \$outputRoot "RelayQaHub-win32-x64-latest\.json"/u,
  );
  assert.match(windowsPublishing, /release\\installer\\Relay-QA-Hub-Windows-x64-latest\.json/u);
  assert.match(windowsPublishing, /--url "\/downloads\/Relay-QA-Hub-Setup-x64\.exe"/u);
  assert.doesNotMatch(
    webConfig,
    /\.\.\/desktop\/release\/installer\/Relay-QA-Hub-Windows-x64-latest\.json/u,
  );
});

test("preview downloads serve only the configured channel and never the legacy installer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-hub-preview-download-boundary-"));
  const webRoot = join(root, "apps", "web", "dist");
  const downloadsRoot = join(root, "preview-downloads");
  await mkdir(webRoot, { recursive: true });
  await mkdir(downloadsRoot);
  await writeFile(join(webRoot, "index.html"), "preview UI");
  const name = "qa-hub-preview-test-windows-latest.json";
  const manifest = { instanceId: "qa-hub-preview-test", version: "0.2.0-preview.1" };
  await writeFile(join(downloadsRoot, name), JSON.stringify(manifest));
  await writeFile(join(root, "private.txt"), "outside download root");
  const server = await startPreviewWeb({
    sourceRoot: root,
    downloadsRoot,
    instanceId: "qa-hub-preview-test",
    webHost: "127.0.0.1",
    webPort: 0,
  });
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${address}/downloads/${name}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-qa-hub-instance"), "qa-hub-preview-test");
  assert.deepEqual(await response.json(), manifest);
  assert.equal((await fetch(`${address}/downloads/Relay-QA-Hub-Setup-x64.exe`)).status, 404);
  assert.equal((await fetch(`${address}/downloads/%2e%2e%2fprivate.txt`)).status, 403);
  assert.equal((await fetch(`${address}/downloads/${name}`, { method: "POST" })).status, 405);
  assert.equal(await (await fetch(address)).text(), "preview UI");
});

test("preview downloads implement strict single byte ranges without changing Web assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-hub-preview-range-boundary-"));
  const webRoot = join(root, "apps", "web", "dist");
  const downloadsRoot = join(root, "preview-downloads");
  await mkdir(webRoot, { recursive: true });
  await mkdir(downloadsRoot);
  await writeFile(join(webRoot, "index.html"), "preview UI");
  await writeFile(join(webRoot, "asset.js"), "web-asset");
  await writeFile(join(downloadsRoot, "installer.exe"), "0123456789");
  const server = await startPreviewWeb({
    sourceRoot: root,
    downloadsRoot,
    instanceId: "qa-hub-preview-test",
    webHost: "127.0.0.1",
    webPort: 0,
  });
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = `http://127.0.0.1:${server.address().port}`;
  const installer = `${address}/downloads/installer.exe`;

  const range = await fetch(installer, { headers: { range: "bytes=2-5" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("accept-ranges"), "bytes");
  assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(range.headers.get("content-length"), "4");
  assert.equal(range.headers.get("cache-control"), "no-store");
  assert.equal(await range.text(), "2345");

  const openEnded = await fetch(installer, { headers: { range: "bytes=7-" } });
  assert.equal(openEnded.status, 206);
  assert.equal(openEnded.headers.get("content-range"), "bytes 7-9/10");
  assert.equal(await openEnded.text(), "789");

  const suffix = await fetch(installer, { headers: { range: "bytes=-3" } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 7-9/10");
  assert.equal(await suffix.text(), "789");

  for (const invalid of ["bytes=99-100", "bytes=4-2", "bytes=0-1,3-4", "items=0-1", "bytes=-0"]) {
    const response = await fetch(installer, { headers: { range: invalid } });
    assert.equal(response.status, 416, invalid);
    assert.equal(response.headers.get("accept-ranges"), "bytes", invalid);
    assert.equal(response.headers.get("content-range"), "bytes */10", invalid);
    assert.equal(response.headers.get("content-length"), "0", invalid);
    assert.equal(await response.text(), "", invalid);
  }

  const head = await fetch(installer, { method: "HEAD", headers: { range: "bytes=2-5" } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(head.headers.get("content-length"), "4");
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const headInvalid = await fetch(installer, {
    method: "HEAD",
    headers: { range: "bytes=0-1,3-4" },
  });
  assert.equal(headInvalid.status, 416);
  assert.equal(headInvalid.headers.get("content-range"), "bytes */10");
  assert.equal(headInvalid.headers.get("content-length"), "0");
  assert.equal((await headInvalid.arrayBuffer()).byteLength, 0);

  const normalDownload = await fetch(installer);
  assert.equal(normalDownload.status, 200);
  assert.equal(normalDownload.headers.get("accept-ranges"), "bytes");
  assert.equal(await normalDownload.text(), "0123456789");

  const webAsset = await fetch(`${address}/asset.js`, { headers: { range: "bytes=0-2" } });
  assert.equal(webAsset.status, 200);
  assert.equal(webAsset.headers.get("accept-ranges"), null);
  assert.equal(webAsset.headers.get("content-range"), null);
  assert.equal(await webAsset.text(), "web-asset");
});
