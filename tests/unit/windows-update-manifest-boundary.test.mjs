import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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
  assert.match(
    webConfig,
    /\.\.\/desktop\/release\/installer\/Relay-QA-Hub-Windows-x64-latest\.json/u,
  );
});
