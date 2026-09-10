import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import asar from "@electron/asar";

const [, , configFile, releaseId, expectedCommit, outputFile] = process.argv;
assert.ok(path.isAbsolute(configFile ?? ""), "ABSOLUTE_CONFIG_REQUIRED");
assert.match(releaseId ?? "", /^\d{8}T\d{9}Z$/u);
assert.match(expectedCommit ?? "", /^[0-9a-f]{40}$/u);
assert.ok(path.isAbsolute(outputFile ?? ""), "ABSOLUTE_OUTPUT_REQUIRED");
assert.equal(existsSync(outputFile), false, "OUTPUT_OVERWRITE_REFUSED");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
const configPath = realpathSync.native(configFile);
const config = readJson(configPath);
assert.equal(config.instanceId, "qa-hub-preview-v21-e2e-fresh-0910");
assert.equal(config.apiPort, 4639);
assert.equal(config.webPort, 4640);
assert.equal(config.mcpPort, 4641);
assert.equal(realpathSync.native(config.sourceRoot), process.cwd());

function fileSnapshot(file) {
  const bytes = readFileSync(file);
  return { path: file, bytes: bytes.length, sha256: hash(bytes) };
}

function directoryFiles(root, prefix = "") {
  const rows = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) rows.push(...directoryFiles(root, relative));
    else if (entry.isFile()) {
      const bytes = readFileSync(path.join(root, relative));
      rows.push({
        path: relative.replaceAll("\\", "/"),
        bytes: bytes.length,
        sha256: hash(bytes),
      });
    } else throw new Error("NON_FILE_PACKAGE_INPUT_REFUSED");
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function asarDirectoryFiles(archive, prefix) {
  return asar
    .listPackage(archive)
    .map((original) => ({
      statPath: original.replace(/^[/\\]/u, ""),
      item: original.replace(/^[/\\]/u, "").replaceAll("\\", "/"),
    }))
    .filter(({ item }) => item.startsWith(`${prefix}/`))
    .filter(({ statPath }) => !Object.hasOwn(asar.statFile(archive, statPath), "files"))
    .map(({ item, statPath }) => {
      const bytes = asar.extractFile(archive, statPath);
      return {
        path: item.slice(prefix.length + 1),
        bytes: bytes.length,
        sha256: hash(bytes),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function responseSnapshot(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  const digest = createHash("sha256");
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      digest.update(chunk);
    }
  }
  return {
    url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes,
    sha256: digest.digest("hex"),
  };
}

function listeners() {
  const script = String.raw`
$ports = @(4174,4319,4320,4639,4640,4641,9333)
@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains [int]$_.LocalPort } |
  Sort-Object LocalPort, OwningProcess |
  ForEach-Object { [ordered]@{ address=[string]$_.LocalAddress; port=[int]$_.LocalPort; pid=[int]$_.OwningProcess } }) |
  ConvertTo-Json -Depth 4 -Compress
`;
  const value = JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true },
    ) || "[]",
  );
  return Array.isArray(value) ? value : [value];
}

const releaseRoot = path.join(config.runtimeRoot, "packages", releaseId);
const packageDirectory = path.join(
  releaseRoot,
  "portable",
  "RelayQaHubPreview-v21-e2e-fresh-0910-win32-x64",
);
const archive = path.join(packageDirectory, "resources", "app.asar");
const stageRelease = readJson(path.join(releaseRoot, "stage", "release.json"));
const packagedRelease = JSON.parse(asar.extractFile(archive, "release.json").toString("utf8"));
const manifestFile = path.join(
  config.downloadsRoot,
  `${config.instanceId}-windows-latest.json`,
);
const manifestBytes = readFileSync(manifestFile);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const installerFile = path.join(config.downloadsRoot, path.basename(manifest.archive.url));
const installer = fileSnapshot(installerFile);
const payload = { ...manifest };
delete payload.signature;
const publicKey = readFileSync(path.join(config.runtimeRoot, "desktop-signing", "public.pem"));
const signatureValid = verify(
  null,
  Buffer.from(JSON.stringify(payload)),
  publicKey,
  Buffer.from(manifest.signature, "base64"),
);
const sourceDesktop = directoryFiles(path.join(config.sourceRoot, "apps", "desktop", "dist"));
const packagedDesktop = asarDirectoryFiles(archive, "dist");
const sourceWeb = directoryFiles(path.join(config.sourceRoot, "apps", "web", "dist"));
const packagedWeb = asarDirectoryFiles(archive, "web");
const manifestHttp = await responseSnapshot(
  `http://127.0.0.1:${config.webPort}/downloads/${path.basename(manifestFile)}`,
);
const installerHttp = await responseSnapshot(
  `http://127.0.0.1:${config.webPort}${manifest.archive.url}`,
);
const productionReadyResponse = await fetch("http://127.0.0.1:4319/api/v1/health/ready", {
  signal: AbortSignal.timeout(5_000),
});
const productionReady = {
  status: productionReadyResponse.status,
  body: await productionReadyResponse.json(),
};
const currentListeners = listeners();
const prepackageFile = path.join(
  config.runtimeRoot,
  "acceptance",
  "windows-build17-package",
  "prepackage.json",
);
const prepackage = readJson(prepackageFile);

const proof = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  instanceId: config.instanceId,
  releaseId,
  version: manifest.version,
  sourceCommit: stageRelease.sourceCommit,
  installer,
  manifest: fileSnapshot(manifestFile),
  manifestHttp,
  installerHttp,
  appAsar: fileSnapshot(archive),
  sourceDesktop,
  packagedDesktop,
  sourceWeb,
  packagedWeb,
  stageRelease,
  packagedRelease,
  prepackage,
  productionReady,
  listeners: currentListeners,
  productionObservation: { action: "read_only", touched: false },
};
proof.checks = {
  receiptVersionExact: manifest.version === "0.2.0-preview.17",
  receiptSourceExact:
    stageRelease.sourceCommit === expectedCommit &&
    stageRelease.sourceDirty === false &&
    packagedRelease.sourceCommit === expectedCommit &&
    packagedRelease.sourceDirty === false,
  sourceWasClean: prepackage.sourceClean === true && prepackage.head === expectedCommit,
  signedManifestMatchesReceipt:
    manifest.releaseId === releaseId &&
    manifest.archive.size === installer.bytes &&
    manifest.archive.sha256 === installer.sha256,
  signatureValid,
  localInstallerExact:
    installer.bytes === manifest.archive.size && installer.sha256 === manifest.archive.sha256,
  httpManifestExact:
    manifestHttp.status === 200 &&
    manifestHttp.bytes === manifestBytes.length &&
    manifestHttp.sha256 === hash(manifestBytes),
  httpInstallerExact:
    installerHttp.status === 200 &&
    installerHttp.bytes === installer.bytes &&
    installerHttp.sha256 === installer.sha256,
  desktopDistByteExact: JSON.stringify(sourceDesktop) === JSON.stringify(packagedDesktop),
  webDistByteExact: JSON.stringify(sourceWeb) === JSON.stringify(packagedWeb),
  productionReadyObserved:
    productionReady.status === 200 && productionReady.body?.status === "ready",
  productionListenersPreserved: [4174, 4319, 4320, 9333].every((port) =>
    currentListeners.some((item) => item.port === port),
  ),
  previewServicesPreserved: [4639, 4640, 4641].every((port) =>
    currentListeners.some((item) => item.port === port && item.address === "127.0.0.1"),
  ),
};
proof.passed = Object.values(proof.checks).every(Boolean);
mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ passed: proof.passed, outputFile, checks: proof.checks })}\n`,
);
if (!proof.passed) process.exitCode = 1;
