import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { packager } from "@electron/packager";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const config = readParallelInstanceConfig(process.argv[2]);
const makensis = process.argv[3];
const buildNumber = Number(process.argv[4] ?? 1);
if (!makensis || !existsSync(makensis) || !Number.isSafeInteger(buildNumber) || buildNumber < 1)
  throw new Error("Explicit NSIS executable and positive build number required");
const releaseId = new Date().toISOString().replace(/[-:.]/gu, "");
const version = `0.2.0-preview.${buildNumber}`;
const root = join(config.runtimeRoot, "packages", releaseId);
if (existsSync(root)) throw new Error("PACKAGE_RELEASE_ALREADY_EXISTS");
mkdirSync(root, { recursive: true });
const stage = join(root, "stage");
mkdirSync(stage);
for (const [source, destination] of [
  ["apps/desktop/dist", "dist"],
  ["apps/web/dist", "web"],
]) {
  cpSync(join(config.sourceRoot, source), join(stage, destination), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: config.sourceRoot,
  encoding: "utf8",
}).trim();
const sourceDirty = !!execFileSync("git", ["status", "--porcelain"], {
  cwd: config.sourceRoot,
  encoding: "utf8",
}).trim();
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
save(join(stage, "package.json"), {
  name: "qa-hub-project-preview",
  version,
  type: "module",
  main: "dist/main.js",
  productName: "QA Hub Preview",
  private: true,
});
save(join(stage, "release.json"), {
  schemaVersion: 1,
  releaseId,
  version,
  sourceCommit,
  sourceDirty,
  instanceId: config.instanceId,
});
const assets = join(stage, "assets");
mkdirSync(assets);
const icon = join(assets, "RelayQaHub.ico");
execFileSync(
  process.execPath,
  [join(config.sourceRoot, "apps/desktop/scripts/generate-windows-icon.mjs"), icon],
  { stdio: "pipe" },
);
const keyRoot = join(config.runtimeRoot, "desktop-signing");
mkdirSync(keyRoot, { recursive: true });
const privateKeyFile = join(keyRoot, "private.pem");
const publicKeyFile = join(keyRoot, "public.pem");
if (!existsSync(privateKeyFile) && !existsSync(publicKeyFile)) {
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(publicKeyFile, pair.publicKey.export({ type: "spki", format: "pem" }), {
    flag: "wx",
  });
}
const updatePublicKeyPem = readFileSync(publicKeyFile, "utf8");
const electronZipName = "electron-v43.4.1-win32-x64.zip";
const electronCache = join(config.runtimeRoot, "cache", "electron-zips");
mkdirSync(electronCache, { recursive: true });
const checksum = JSON.parse(
  readFileSync(join(config.sourceRoot, "node_modules/electron/checksums.json"), "utf8"),
)[electronZipName];
const zipTarget = join(electronCache, electronZipName);
if (!existsSync(zipTarget)) {
  const publicToolCache = join(process.env.LOCALAPPDATA, "electron", "Cache");
  const candidate = readdirSync(publicToolCache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(publicToolCache, entry.name, electronZipName))
    .find(existsSync);
  if (!candidate || createHash("sha256").update(readFileSync(candidate)).digest("hex") !== checksum)
    throw new Error("VERIFIED_ELECTRON_CACHE_MISSING");
  copyFileSync(candidate, zipTarget);
}
if (createHash("sha256").update(readFileSync(zipTarget)).digest("hex") !== checksum)
  throw new Error("ELECTRON_ZIP_HASH_MISMATCH");
const packaged = await packager({
  dir: stage,
  name: "RelayQaHubPreview",
  platform: "win32",
  arch: "x64",
  out: join(root, "portable"),
  overwrite: false,
  prune: false,
  asar: true,
  icon,
  appVersion: version,
  buildVersion: `0.2.0.${buildNumber}`,
  electronVersion: "43.4.1",
  electronZipDir: electronCache,
  win32metadata: {
    CompanyName: "QA Hub Preview",
    FileDescription: "QA Hub Project Preview",
    ProductName: "QA Hub Project Preview",
  },
});
const packageDirectory = packaged[0];
if (!packageDirectory || !resolve(packageDirectory).startsWith(resolve(root)))
  throw new Error("PACKAGE_PATH_INVALID");
save(join(packageDirectory, "preview-instance.json"), {
  schemaVersion: 1,
  instanceId: config.instanceId,
  profileDirectory: join(config.desktopRoot, "profile"),
  apiBaseUrl: `http://${config.apiHost}:${config.apiPort}`,
  csrfOrigin: `http://${config.webHost}:${config.webPort}`,
  cookieName: config.cookieName,
  mcpPort: config.desktopMcpPort,
  updateManifestUrl: `http://${config.webHost}:${config.webPort}/downloads/${config.instanceId}-windows-latest.json`,
  updatePublicKeyPem,
});
writeFileSync(join(packageDirectory, ".preview-instance-id"), config.instanceId, { flag: "wx" });
// The helper only waits on this EXE's parent PID. It never terminates processes.
let updater = readFileSync(join(config.sourceRoot, "apps/desktop/scripts/updater.nsi"), "utf8");
updater = updater
  .replaceAll("Relay QA Hub Updater", "QA Hub Preview Updater")
  .replaceAll("Relay QA Hub native updater", "QA Hub Preview native updater");
updater = updater.replace(
  "app_exists:",
  'app_exists:\n  StrCmp $AppPath "$LOCALAPPDATA\\Programs\\RelayQaHubPreview\\RelayQaHubPreview.exe" +2\n  Goto invalid_config',
);
const updaterScript = join(root, "preview-updater.nsi");
writeFileSync(updaterScript, updater, { flag: "wx" });
const compile = (args) =>
  execFileSync(makensis, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
writeFileSync(
  join(root, "updater-build.log"),
  compile([
    "/V2",
    "/DPRODUCT_VERSION=0.2.0",
    `/DICON_FILE=${icon}`,
    `/DOUTPUT_FILE=${join(packageDirectory, "RelayQaHubUpdater.exe")}`,
    updaterScript,
  ]),
);
const installerName = `${config.instanceId}-windows-${version}-${releaseId}.exe`;
const installer = join(config.downloadsRoot, installerName);
writeFileSync(
  join(root, "installer-build.log"),
  compile([
    "/V2",
    `/DOUTPUT_FILE=${installer}`,
    `/DPACKAGE_DIR=${packageDirectory}`,
    `/DICON_FILE=${icon}`,
    `/DBUILD_NUMBER=${buildNumber}`,
    `/DAPP_VERSION=${version}`,
    `/DRELEASE_ID=${releaseId}`,
    `/DINSTANCE_ID=${config.instanceId}`,
    join(config.sourceRoot, "scripts/project-components/preview-installer.nsi"),
  ]),
);
const archive = readFileSync(installer);
const payload = {
  schemaVersion: 1,
  releaseId,
  version,
  publishedAt: new Date().toISOString(),
  archive: {
    url: `/downloads/${installerName}`,
    size: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  },
};
const signature = sign(
  null,
  Buffer.from(JSON.stringify(payload)),
  readFileSync(privateKeyFile),
).toString("base64");
save(join(root, "signed-manifest.json"), { ...payload, signature });
const manifestPath = join(config.downloadsRoot, `${config.instanceId}-windows-latest.json`);
const temporary = `${manifestPath}.${releaseId}.tmp`;
save(temporary, { ...payload, signature });
renameSync(temporary, manifestPath);
const receipt = {
  releaseId,
  version,
  sourceCommit,
  sourceDirty,
  installer,
  packageDirectory,
  manifestPath,
  sha256: payload.archive.sha256,
  bytes: archive.length,
};
save(join(root, "receipt.json"), receipt);
console.log(JSON.stringify(receipt));
