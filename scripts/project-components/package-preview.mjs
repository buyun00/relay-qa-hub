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
import asar from "@electron/asar";
import { packager } from "@electron/packager";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
import {
  assertCleanPreviewPackageSource,
  derivePreviewPackageIdentity,
} from "./preview-package-identity.mjs";
import {
  assertSandboxPreloadBinding,
  inspectSandboxPreload,
} from "./sandbox-preload-require-gate.mjs";

const config = readParallelInstanceConfig(process.argv[2]);
const makensis = process.argv[3];
const buildNumber = Number(process.argv[4] ?? 1);
if (!makensis || !existsSync(makensis) || !Number.isSafeInteger(buildNumber) || buildNumber < 1)
  throw new Error("Explicit NSIS executable and positive build number required");
const packageIdentity = derivePreviewPackageIdentity(config.instanceId);
// This gate precedes every runtime/package mutation. Recheck before publication below.
const { sourceCommit, sourceDirty } = assertCleanPreviewPackageSource(config.sourceRoot);
const preloadPath = join(config.sourceRoot, "apps/desktop/dist/preload.cjs");
const sourcePreloadBytes = Buffer.from(readFileSync(preloadPath));
const sourcePreloadSnapshot = inspectSandboxPreload(sourcePreloadBytes, preloadPath);
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
const stagedPreloadPath = join(stage, "dist", "preload.cjs");
const stagedPreloadSnapshot = assertSandboxPreloadBinding(
  readFileSync(stagedPreloadPath),
  sourcePreloadBytes,
  sourcePreloadSnapshot,
  stagedPreloadPath,
);
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
save(join(stage, "package.json"), {
  name: `qa-hub-project-preview-${config.instanceId.slice("qa-hub-preview-".length)}`,
  version,
  type: "module",
  main: "dist/main.js",
  productName: packageIdentity.displayName,
  private: true,
});
save(join(stage, "release.json"), {
  schemaVersion: 1,
  releaseId,
  version,
  sourceCommit,
  sourceDirty,
  instanceId: config.instanceId,
  packageIdentity,
  preload: sourcePreloadSnapshot,
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
  name: packageIdentity.executableBaseName,
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
    FileDescription: packageIdentity.displayName,
    ProductName: packageIdentity.displayName,
  },
});
const packageDirectory = packaged[0];
if (!packageDirectory || !resolve(packageDirectory).startsWith(resolve(root)))
  throw new Error("PACKAGE_PATH_INVALID");
const packagedAsarPath = join(packageDirectory, "resources", "app.asar");
let packagedPreloadBytes;
try {
  packagedPreloadBytes = asar.extractFile(packagedAsarPath, "dist/preload.cjs");
} catch (cause) {
  const error = new Error("PREVIEW_SANDBOX_PRELOAD_ASAR_ENTRY_MISSING", { cause });
  error.code = "PREVIEW_SANDBOX_PRELOAD_ASAR_ENTRY_MISSING";
  throw error;
}
const packagedPreloadSnapshot = assertSandboxPreloadBinding(
  packagedPreloadBytes,
  sourcePreloadBytes,
  sourcePreloadSnapshot,
  `${packagedAsarPath}:dist/preload.cjs`,
);
save(join(packageDirectory, "preview-instance.json"), {
  schemaVersion: 1,
  instanceId: config.instanceId,
  profileDirectory: join(config.desktopRoot, "profile"),
  apiBaseUrl: `http://${config.apiHost}:${config.apiPort}`,
  csrfOrigin: `http://${config.webHost}:${config.webPort}`,
  cookieName: config.cookieName,
  appScheme: packageIdentity.protocolScheme,
  appUserModelId: packageIdentity.appUserModelId,
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
  `app_exists:\n  StrCmp $AppPath "$LOCALAPPDATA\\Programs\\${packageIdentity.installDirectoryName}\\${packageIdentity.executableBaseName}.exe" +2\n  Goto invalid_config`,
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
    "/DFAIL_CLOSED_INSTALLER_FAILURES=1",
    updaterScript,
  ]),
);
const installerName = `${config.instanceId}-windows-${version}-${releaseId}.exe`;
const stagedInstaller = join(root, installerName);
writeFileSync(
  join(root, "installer-build.log"),
  compile([
    "/V2",
    `/DOUTPUT_FILE=${stagedInstaller}`,
    `/DPACKAGE_DIR=${packageDirectory}`,
    `/DICON_FILE=${icon}`,
    `/DBUILD_NUMBER=${buildNumber}`,
    `/DAPP_VERSION=${version}`,
    `/DRELEASE_ID=${releaseId}`,
    `/DINSTANCE_ID=${config.instanceId}`,
    `/DINSTALL_DIRECTORY_NAME=${packageIdentity.installDirectoryName}`,
    `/DEXECUTABLE_BASENAME=${packageIdentity.executableBaseName}`,
    `/DUNINSTALL_REGISTRY_KEY=${packageIdentity.uninstallRegistryKey}`,
    `/DSHORTCUT_NAME=${packageIdentity.shortcutName}`,
    `/DPROTOCOL_SCHEME=${packageIdentity.protocolScheme}`,
    `/DDISPLAY_NAME=${packageIdentity.displayName}`,
    join(config.sourceRoot, "scripts/project-components/preview-installer.nsi"),
  ]),
);
const archive = readFileSync(stagedInstaller);
let finalPackagedPreloadBytes;
try {
  finalPackagedPreloadBytes = asar.extractFile(packagedAsarPath, "dist/preload.cjs");
} catch (cause) {
  const error = new Error("PREVIEW_SANDBOX_PRELOAD_ASAR_ENTRY_MISSING", { cause });
  error.code = "PREVIEW_SANDBOX_PRELOAD_ASAR_ENTRY_MISSING";
  throw error;
}
const finalPackagedPreloadSnapshot = assertSandboxPreloadBinding(
  finalPackagedPreloadBytes,
  sourcePreloadBytes,
  sourcePreloadSnapshot,
  `${packagedAsarPath}:dist/preload.cjs:post-installer`,
);
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
assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit);
const finalSourcePreloadSnapshot = assertSandboxPreloadBinding(
  readFileSync(preloadPath),
  sourcePreloadBytes,
  sourcePreloadSnapshot,
  `${preloadPath}:publication`,
);
const installer = join(config.downloadsRoot, installerName);
writeFileSync(installer, archive, { flag: "wx" });
save(temporary, { ...payload, signature });
renameSync(temporary, manifestPath);
const receipt = {
  releaseId,
  version,
  sourceCommit,
  sourceDirty,
  packageIdentity,
  installer,
  packageDirectory,
  manifestPath,
  sha256: payload.archive.sha256,
  bytes: archive.length,
  preload: {
    source: sourcePreloadSnapshot,
    staged: stagedPreloadSnapshot,
    packaged: packagedPreloadSnapshot,
    finalPackaged: finalPackagedPreloadSnapshot,
    finalSource: finalSourcePreloadSnapshot,
  },
};
save(join(root, "receipt.json"), receipt);
console.log(JSON.stringify(receipt));
