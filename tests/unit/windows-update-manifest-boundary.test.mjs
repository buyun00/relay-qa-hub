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
