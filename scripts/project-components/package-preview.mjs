import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  lstatSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
import {
  assertCleanPreviewPackageSource,
  derivePreviewPackageIdentity,
} from "./preview-package-identity.mjs";
import {
  assertPinnedElectronArchive,
  verifyPinnedPackageToolchain,
} from "./package-toolchain-provenance.mjs";

const config = readParallelInstanceConfig(process.argv[2]);
const requestedMakensis = process.argv[3];
const buildNumber = Number(process.argv[4] ?? 1);
if (
  !requestedMakensis ||
  !existsSync(requestedMakensis) ||
  !Number.isSafeInteger(buildNumber) ||
  buildNumber < 1
)
  throw new Error("Explicit NSIS executable and positive build number required");
const packageIdentity = derivePreviewPackageIdentity(config.instanceId);
const teamEdition = config.deploymentMode === "lan";
// This gate precedes every runtime/package mutation. Recheck before publication below.
const { sourceCommit, sourceDirty } = assertCleanPreviewPackageSource(config.sourceRoot);
// No dependency package is imported before the complete ignored tool tree, Node
// runtime, Electron checksum anchor, and NSIS bundle match the source-controlled pin.
const verifiedToolchain = verifyPinnedPackageToolchain({
  sourceRoot: config.sourceRoot,
  makensisPath: requestedMakensis,
});
const packageToolchain = verifiedToolchain.provenance;
const makensis = verifiedToolchain.makensisPath;
const publicationMoveOptions = Object.freeze({
  powershellExecutable: verifiedToolchain.windowsPowerShellPath,
  helperPath: verifiedToolchain.moveFileWriteThroughPath,
});
const [asarModule, packagerModule, sandboxPreload, releaseContent] = await Promise.all([
  import("@electron/asar"),
  import("@electron/packager"),
  import("./sandbox-preload-require-gate.mjs"),
  import("./release-content-binding.mjs"),
]);
const asar = asarModule.default;
const { packager } = packagerModule;
const { assertSandboxPreloadBinding, inspectSandboxPreload } = sandboxPreload;
const {
  assertReleaseContentBinding,
  assertSignedUpdateManifest,
  assertUpdateManifestSuccessor,
  canonicalDirectChildDirectory,
  commitPreparedPublication,
  fetchReleaseBytes,
  publishFileExclusiveDurable,
  serializeReleaseAttestation,
  serializeUpdateManifestPayload,
  snapshotReleaseAsarDirectory,
  snapshotReleaseDirectory,
  snapshotReleasePackageAsar,
  snapshotReleasePackageDirectory,
  validatePreparedPreviewPublicationReceipt,
  verifyCommittedPublication,
  verifyPreviewInstallerPayload,
  writeFileExclusiveDurable,
} = releaseContent;
const releaseId = new Date().toISOString().replace(/[-:.]/gu, "");
const version = teamEdition ? "1.0.0" : `0.2.0-${config.deploymentMode}.${buildNumber}`;
const executableFileVersion = teamEdition ? `1.0.0.${buildNumber}` : `0.2.0.${buildNumber}`;
const packagesRoot = join(config.runtimeRoot, "packages");
mkdirSync(packagesRoot, { recursive: true });
const root = join(packagesRoot, releaseId);
mkdirSync(root);
const stage = join(root, "stage");
mkdirSync(stage);
const runBuild = (label, args, cwd) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(
    join(root, `${label}-build.log`),
    [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n"),
    { flag: "wx" },
  );
  if (result.error || result.status !== 0 || result.signal !== null) {
    const error = new Error(`${label.toUpperCase()}_BUILD_FAILED`, { cause: result.error });
    error.code = `${label.toUpperCase()}_BUILD_FAILED`;
    throw error;
  }
};
runBuild(
  "desktop",
  [
    join(config.sourceRoot, "node_modules/typescript/bin/tsc"),
    "-p",
    join(config.sourceRoot, "apps/desktop/tsconfig.json"),
    "--outDir",
    join(stage, "dist"),
    "--sourceMap",
    "false",
    "--declaration",
    "false",
    "--declarationMap",
    "false",
  ],
  config.sourceRoot,
);
runBuild(
  "web",
  [
    join(config.sourceRoot, "node_modules/vite/bin/vite.js"),
    "build",
    "--outDir",
    join(stage, "web"),
    "--emptyOutDir",
    "--sourcemap=false",
  ],
  join(config.sourceRoot, "apps/web"),
);
verifyPinnedPackageToolchain({
  sourceRoot: config.sourceRoot,
  makensisPath: makensis,
  windowsPowerShellExecutable: publicationMoveOptions.powershellExecutable,
  moveFileWriteThroughPath: publicationMoveOptions.helperPath,
});
assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit);
const stagedPreloadPath = join(stage, "dist", "preload.cjs");
const sourcePreloadBytes = Buffer.from(readFileSync(stagedPreloadPath));
const sourcePreloadSnapshot = inspectSandboxPreload(sourcePreloadBytes, stagedPreloadPath);
const stagedPreloadSnapshot = assertSandboxPreloadBinding(
  sourcePreloadBytes,
  sourcePreloadBytes,
  sourcePreloadSnapshot,
  stagedPreloadPath,
);
const buildArtifacts = {
  desktop: snapshotReleaseDirectory(join(stage, "dist")),
  web: snapshotReleaseDirectory(join(stage, "web")),
};
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
save(join(stage, "package.json"), {
  name: packageIdentity.executableBaseName.toLowerCase(),
  version,
  type: "module",
  main: "dist/main.js",
  productName: packageIdentity.displayName,
  private: true,
  dependencies: { "@relay-qa-hub/upload-contract": "0.1.0" },
});
const runtimeContractSource = join(config.sourceRoot, "packages", "upload-contract");
const runtimeContractTarget = join(stage, "node_modules", "@relay-qa-hub", "upload-contract");
mkdirSync(runtimeContractTarget, { recursive: true });
for (const file of [
  "package.json",
  "index.js",
  "index.d.ts",
  "quick-build.js",
  "quick-build.d.ts",
]) {
  const source = join(runtimeContractSource, file);
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("RUNTIME_UPLOAD_CONTRACT_SOURCE_INVALID");
  }
  copyFileSync(source, join(runtimeContractTarget, file), constants.COPYFILE_EXCL);
}
const assets = join(stage, "assets");
mkdirSync(assets);
const icon = join(assets, "RelayQaHub.ico");
execFileSync(
  process.execPath,
  [
    join(
      config.sourceRoot,
      teamEdition
        ? "apps/desktop/scripts/generate-team-windows-icon.mjs"
        : "apps/desktop/scripts/generate-windows-icon.mjs",
    ),
    icon,
  ],
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
const updatePrivateKeyPem = readFileSync(privateKeyFile);
const updatePublicKeyPem = readFileSync(publicKeyFile, "utf8");
const releasePackageContent = snapshotReleasePackageDirectory(stage);
const stageReleasePayload = {
  schemaVersion: 1,
  releaseId,
  version,
  sourceCommit,
  sourceDirty,
  instanceId: config.instanceId,
  packageIdentity,
  preload: sourcePreloadSnapshot,
  build: {
    producer: "package-preview.mjs",
    artifacts: buildArtifacts,
    toolchain: packageToolchain,
  },
  packageContent: releasePackageContent,
};
const releaseAttestationSignature = sign(
  null,
  serializeReleaseAttestation(stageReleasePayload),
  updatePrivateKeyPem,
).toString("base64");
const stageRelease = {
  ...stageReleasePayload,
  attestationSignature: releaseAttestationSignature,
};
if (
  !verify(
    null,
    serializeReleaseAttestation(stageRelease),
    createPublicKey(updatePublicKeyPem),
    Buffer.from(releaseAttestationSignature, "base64"),
  )
)
  throw new Error("RELEASE_ATTESTATION_SELF_CHECK_FAILED");
const stageReleaseBytes = Buffer.from(`${JSON.stringify(stageRelease, null, 2)}\n`);
writeFileSync(join(stage, "release.json"), stageReleaseBytes, { flag: "wx" });
const electronZipName = packageToolchain.electron.zipName;
const electronCache = join(config.runtimeRoot, "cache", "electron-zips");
mkdirSync(electronCache, { recursive: true });
const checksum = packageToolchain.electron.zipSha256;
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
assertPinnedElectronArchive(packageToolchain, zipTarget);
const portableRoot = join(root, "portable");
const packaged = await packager({
  dir: stage,
  name: packageIdentity.executableBaseName,
  platform: "win32",
  arch: "x64",
  out: portableRoot,
  overwrite: false,
  prune: false,
  asar: true,
  icon,
  appVersion: version,
  buildVersion: executableFileVersion,
  electronVersion: "43.4.1",
  electronZipDir: electronCache,
  win32metadata: {
    CompanyName: teamEdition ? "Relay QA Hub" : "QA Hub Preview",
    FileDescription: packageIdentity.displayName,
    ProductName: packageIdentity.displayName,
  },
});
const packageDirectory = canonicalDirectChildDirectory(portableRoot, packaged[0], "PACKAGE_PATH");
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
const packagedArtifacts = {
  desktop: assertReleaseContentBinding(
    buildArtifacts.desktop,
    snapshotReleaseAsarDirectory(packagedAsarPath, "dist"),
    "PACKAGED_DESKTOP_CONTENT",
  ),
  web: assertReleaseContentBinding(
    buildArtifacts.web,
    snapshotReleaseAsarDirectory(packagedAsarPath, "web"),
    "PACKAGED_WEB_CONTENT",
  ),
};
const packagedPackageContent = assertReleaseContentBinding(
  releasePackageContent,
  snapshotReleasePackageAsar(packagedAsarPath),
  "PACKAGED_PACKAGE_CONTENT",
);
const packagedExecutable = join(packageDirectory, `${packageIdentity.executableBaseName}.exe`);
const runtimeProbeModule = pathToFileURL(
  join(packageDirectory, "resources", "app.asar", "dist", "package-downloads.js"),
).href;
const runtimeProbe = spawnSync(
  packagedExecutable,
  ["--input-type=module", "--eval", `await import(${JSON.stringify(runtimeProbeModule)})`],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
writeFileSync(
  join(root, "runtime-module-probe.log"),
  [runtimeProbe.stdout ?? "", runtimeProbe.stderr ?? ""].filter(Boolean).join("\n"),
  { flag: "wx" },
);
if (runtimeProbe.error || runtimeProbe.status !== 0 || runtimeProbe.signal !== null) {
  const error = new Error("PACKAGED_RUNTIME_MODULE_RESOLUTION_FAILED", {
    cause: runtimeProbe.error,
  });
  error.code = "PACKAGED_RUNTIME_MODULE_RESOLUTION_FAILED";
  throw error;
}
const packagedReleaseBytes = asar.extractFile(packagedAsarPath, "release.json");
if (!packagedReleaseBytes.equals(stageReleaseBytes))
  throw new Error("PACKAGED_RELEASE_BINDING_MISMATCH");
const packagedPreviewConfig = {
  schemaVersion: config.deploymentMode === "lan" ? 2 : 1,
  instanceId: config.instanceId,
  ...(config.deploymentMode === "lan"
    ? { profileDirectoryName: config.instanceId }
    : { profileDirectory: join(config.desktopRoot, "profile") }),
  apiBaseUrl:
    config.deploymentMode === "lan"
      ? config.publicWebBaseUrl
      : `http://${config.apiHost}:${config.apiPort}`,
  csrfOrigin: config.publicWebBaseUrl,
  cookieName: config.cookieName,
  appScheme: packageIdentity.protocolScheme,
  appUserModelId: packageIdentity.appUserModelId,
  toastActivatorClsid: packageIdentity.toastActivatorClsid,
  mcpPort: config.desktopMcpPort,
  updateManifestUrl: `${config.publicWebBaseUrl}/downloads/${config.instanceId}-windows-latest.json`,
  updatePublicKeyPem,
};
const packagedPreviewConfigBytes = Buffer.from(
  `${JSON.stringify(packagedPreviewConfig, null, 2)}\n`,
);
writeFileSync(join(packageDirectory, "preview-instance.json"), packagedPreviewConfigBytes, {
  flag: "wx",
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
    `/DPRODUCT_VERSION=${teamEdition ? "1.0.0" : "0.2.0"}`,
    `/DICON_FILE=${icon}`,
    `/DOUTPUT_FILE=${join(packageDirectory, "RelayQaHubUpdater.exe")}`,
    "/DFAIL_CLOSED_INSTALLER_FAILURES=1",
    updaterScript,
  ]),
);
const installerPayloadContent = snapshotReleaseDirectory(packageDirectory);
const installerName = teamEdition
  ? `Relay-QA-Hub-团队版-${version}-${releaseId}.exe`
  : `${config.instanceId}-windows-${version}-${releaseId}.exe`;
const stagedInstaller = join(root, installerName);
writeFileSync(
  join(root, "installer-build.log"),
  compile([
    "/V2",
    `/DOUTPUT_FILE=${stagedInstaller}`,
    `/DPACKAGE_DIR=${packageDirectory}`,
    `/DICON_FILE=${icon}`,
    `/DBUILD_NUMBER=${buildNumber}`,
    `/DFILE_VERSION=${executableFileVersion}`,
    `/DAPP_VERSION=${version}`,
    `/DRELEASE_ID=${releaseId}`,
    `/DINSTANCE_ID=${config.instanceId}`,
    `/DINSTALL_DIRECTORY_NAME=${packageIdentity.installDirectoryName}`,
    `/DEXECUTABLE_BASENAME=${packageIdentity.executableBaseName}`,
    `/DUNINSTALL_REGISTRY_KEY=${packageIdentity.uninstallRegistryKey}`,
    `/DSHORTCUT_NAME=${packageIdentity.shortcutName}`,
    `/DPROTOCOL_SCHEME=${packageIdentity.protocolScheme}`,
    `/DAPP_USER_MODEL_ID=${packageIdentity.appUserModelId}`,
    `/DTOAST_ACTIVATOR_CLSID=${packageIdentity.toastActivatorClsid}`,
    `/DDISPLAY_NAME=${packageIdentity.displayName}`,
    join(config.sourceRoot, "scripts/project-components/preview-installer.nsi"),
  ]),
);
const archive = readFileSync(stagedInstaller);
const finalInstallerSourceContent = assertReleaseContentBinding(
  installerPayloadContent,
  snapshotReleaseDirectory(packageDirectory),
  "FINAL_INSTALLER_SOURCE_CONTENT",
);
const extractedInstallerContent = verifyPreviewInstallerPayload(
  archive,
  installerPayloadContent,
  root,
  "EXTRACTED_INSTALLER_CONTENT",
);
assertPinnedElectronArchive(packageToolchain, zipTarget);
verifyPinnedPackageToolchain({
  sourceRoot: config.sourceRoot,
  makensisPath: makensis,
  windowsPowerShellExecutable: publicationMoveOptions.powershellExecutable,
  moveFileWriteThroughPath: publicationMoveOptions.helperPath,
});
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
const finalPackagedArtifacts = {
  desktop: assertReleaseContentBinding(
    buildArtifacts.desktop,
    snapshotReleaseAsarDirectory(packagedAsarPath, "dist"),
    "FINAL_PACKAGED_DESKTOP_CONTENT",
  ),
  web: assertReleaseContentBinding(
    buildArtifacts.web,
    snapshotReleaseAsarDirectory(packagedAsarPath, "web"),
    "FINAL_PACKAGED_WEB_CONTENT",
  ),
};
const finalPackagedPackageContent = assertReleaseContentBinding(
  releasePackageContent,
  snapshotReleasePackageAsar(packagedAsarPath),
  "FINAL_PACKAGED_PACKAGE_CONTENT",
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
const signature = sign(null, serializeUpdateManifestPayload(payload), updatePrivateKeyPem).toString(
  "base64",
);
const signedManifest = { ...payload, signature };
assertSignedUpdateManifest(signedManifest, updatePublicKeyPem, "STAGED_UPDATE_MANIFEST");
const signedManifestBytes = Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, "utf8");
writeFileSync(join(root, "signed-manifest.json"), signedManifestBytes, { flag: "wx" });
const manifestPath = join(config.downloadsRoot, `${config.instanceId}-windows-latest.json`);
const candidateManifestName = `${config.instanceId}-windows-${version}-${releaseId}.json`;
const candidateManifestPath = join(config.downloadsRoot, candidateManifestName);
const temporary = `${manifestPath}.${releaseId}.tmp`;
const previousManifestBytes = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
if (previousManifestBytes !== null) {
  const previousManifest = assertSignedUpdateManifest(
    JSON.parse(previousManifestBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    updatePublicKeyPem,
    "PREVIOUS_UPDATE_MANIFEST",
  );
  assertUpdateManifestSuccessor(previousManifest, signedManifest);
}
const finalSourcePreloadSnapshot = assertSandboxPreloadBinding(
  readFileSync(stagedPreloadPath),
  sourcePreloadBytes,
  sourcePreloadSnapshot,
  `${stagedPreloadPath}:publication`,
);
const finalStagedArtifacts = {
  desktop: assertReleaseContentBinding(
    buildArtifacts.desktop,
    snapshotReleaseDirectory(join(stage, "dist")),
    "FINAL_STAGED_DESKTOP_CONTENT",
  ),
  web: assertReleaseContentBinding(
    buildArtifacts.web,
    snapshotReleaseDirectory(join(stage, "web")),
    "FINAL_STAGED_WEB_CONTENT",
  ),
};
const finalStagedPackageContent = assertReleaseContentBinding(
  releasePackageContent,
  snapshotReleasePackageDirectory(stage),
  "FINAL_STAGED_PACKAGE_CONTENT",
);
const finalPackagedReleaseBytes = asar.extractFile(packagedAsarPath, "release.json");
if (!finalPackagedReleaseBytes.equals(stageReleaseBytes))
  throw new Error("FINAL_PACKAGED_RELEASE_BINDING_MISMATCH");
if (!readFileSync(join(stage, "release.json")).equals(stageReleaseBytes))
  throw new Error("FINAL_STAGED_RELEASE_BINDING_MISMATCH");
if (
  !readFileSync(join(packageDirectory, "preview-instance.json")).equals(packagedPreviewConfigBytes)
)
  throw new Error("FINAL_PACKAGED_PREVIEW_CONFIG_BINDING_MISMATCH");
// This is the final source read before the create-only installer publication.
assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit);
const installer = join(config.downloadsRoot, installerName);
const manifestUrl = new URL(
  `/downloads/${config.instanceId}-windows-latest.json`,
  config.publicWebBaseUrl,
);
const candidateManifestUrl = new URL(`/downloads/${candidateManifestName}`, manifestUrl);
const createReceipt = ({
  servedManifestBytes,
  servedManifest,
  servedInstallerUrl,
  servedInstallerBytes,
  previousManifestBytes,
  installerPublication,
  candidateManifestPublication,
}) => ({
  schemaVersion: 2,
  kind: "relay-qa-hub-preview-publication-receipt",
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
  releaseAttestation: {
    signature: releaseAttestationSignature,
    releaseJsonSha256: createHash("sha256").update(stageReleaseBytes).digest("hex"),
    publicKeySha256: createHash("sha256")
      .update(createPublicKey(updatePublicKeyPem).export({ type: "spki", format: "der" }))
      .digest("hex"),
  },
  packageContent: {
    expected: releasePackageContent,
    packaged: packagedPackageContent,
    finalPackaged: finalPackagedPackageContent,
    finalStaged: finalStagedPackageContent,
  },
  installerContent: {
    source: installerPayloadContent,
    finalSource: finalInstallerSourceContent,
    extracted: extractedInstallerContent,
  },
  publication: {
    commitProtocol: "prepared-receipt-active-claim-create-only-latest-v2",
    stateRule:
      "canonical-manifest-hash-is-content-commit-point; completion-requires-artifact-validation-and-active-history",
    availabilityDuringCommit: "latest-may-be-absent-between-claim-and-create",
    manifestUrl: manifestUrl.href,
    validatedManifestUrl: candidateManifestUrl.href,
    manifestBytes: servedManifestBytes.length,
    manifestSha256: createHash("sha256").update(servedManifestBytes).digest("hex"),
    installerUrl: servedInstallerUrl.href,
    installerName,
    installerBytes: servedInstallerBytes.length,
    installerSha256: createHash("sha256").update(servedInstallerBytes).digest("hex"),
    installerMoveRecovered: installerPublication.recovered,
    candidateManifestMoveRecovered: candidateManifestPublication.recovered,
    releaseId: servedManifest.releaseId,
    version: servedManifest.version,
    sourceCommit,
    packageContentDigest: releasePackageContent.digest,
    previousManifestExisted: previousManifestBytes !== null,
    previousManifestSha256:
      previousManifestBytes === null
        ? null
        : createHash("sha256").update(previousManifestBytes).digest("hex"),
  },
  build: {
    artifacts: buildArtifacts,
    packagedArtifacts,
    finalPackagedArtifacts,
    finalStagedArtifacts,
  },
  preload: {
    source: sourcePreloadSnapshot,
    staged: stagedPreloadSnapshot,
    packaged: packagedPreloadSnapshot,
    finalPackaged: finalPackagedPreloadSnapshot,
    finalSource: finalSourcePreloadSnapshot,
  },
});
const verifyCanonicalPublicationFiles = () => {
  for (const [file, expectedBytes, label] of [
    [manifestPath, signedManifestBytes, "COMMITTED_MANIFEST"],
    [installer, archive, "COMMITTED_INSTALLER"],
  ]) {
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      throw new Error(`${label}_PATH_INVALID`);
    if (before.size !== BigInt(expectedBytes.length)) throw new Error(`${label}_SIZE_MISMATCH`);
    const actualBytes = readFileSync(file);
    const after = lstatSync(file, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1n ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    )
      throw new Error(`${label}_PATH_CHANGED`);
    if (!actualBytes.equals(expectedBytes)) throw new Error(`${label}_BYTES_MISMATCH`);
  }
};
let publicationCommit;
let receipt;
let publicationResult;
let publicationResultSha256;
let publicationResultPath;
let publicationResultDurable = false;
let installerPublication;
let candidateManifestPublication;
let publicationResultPublication;
let committedStateValidation;
let publicationStage = "installer-publication";
const summarizePublicationCommit = (commit) =>
  commit
    ? {
        committed: commit.committed,
        recovered: commit.recovered,
        transactionId: commit.transactionId,
        receiptSha256: commit.receiptSha256,
        claimName: basename(commit.claimPath),
        historyName: basename(commit.historyPath),
      }
    : null;
const summarizePublicationState = (state) =>
  state
    ? {
        contentCommitted: state.contentCommitted,
        completed: state.completed,
        recovered: state.recovered,
        transactionId: state.transactionId,
        receiptSha256: state.receiptSha256,
        replacementSha256: state.replacementSha256,
        previousSha256: state.previousSha256,
        markerSha256: state.markerSha256,
        claimSha256: state.claimSha256,
        claimName: state.claimName,
        historyName: state.historyName,
      }
    : null;
const summarizeFailureCause = (cause) =>
  cause
    ? {
        message: cause.message ?? String(cause),
        code: cause.code ?? null,
        nativeError: cause.nativeError ?? null,
        helperCode: cause.helperCode ?? null,
      }
    : null;
try {
  installerPublication = publishFileExclusiveDurable(
    stagedInstaller,
    installer,
    archive,
    () => {},
    publicationMoveOptions,
  );
  publicationStage = "installer-readback";
  if (existsSync(stagedInstaller)) throw new Error("STAGED_INSTALLER_ALIAS_REMOVE_FAILED");
  const publishedInstallerStat = statSync(installer, { bigint: true });
  if (
    publishedInstallerStat.dev.toString() !== installerPublication.dev ||
    publishedInstallerStat.ino.toString() !== installerPublication.ino ||
    publishedInstallerStat.nlink !== 1n
  ) {
    throw new Error("PUBLISHED_INSTALLER_IDENTITY_MISMATCH");
  }
  if (!readFileSync(installer).equals(archive))
    throw new Error("PUBLISHED_INSTALLER_READBACK_MISMATCH");
  publicationStage = "candidate-manifest-publication";
  candidateManifestPublication = writeFileExclusiveDurable(
    candidateManifestPath,
    signedManifestBytes,
    () => {},
    publicationMoveOptions,
  );
  if (!readFileSync(candidateManifestPath).equals(signedManifestBytes))
    throw new Error("CANDIDATE_MANIFEST_READBACK_MISMATCH");
  publicationStage = "candidate-http-validation";
  const servedManifestBytes = await fetchReleaseBytes(
    candidateManifestUrl,
    64 * 1024,
    "SERVED_UPDATE_MANIFEST",
  );
  if (!servedManifestBytes.equals(signedManifestBytes))
    throw new Error("SERVED_MANIFEST_BYTES_MISMATCH");
  const servedManifest = assertSignedUpdateManifest(
    JSON.parse(servedManifestBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    updatePublicKeyPem,
    "SERVED_UPDATE_MANIFEST",
  );
  if (servedManifest.releaseId !== releaseId) throw new Error("SERVED_RELEASE_ID_MISMATCH");
  if (servedManifest.version !== version) throw new Error("SERVED_VERSION_MISMATCH");
  if (servedManifest.archive.url !== `/downloads/${installerName}`)
    throw new Error("SERVED_INSTALLER_URL_MISMATCH");
  const servedInstallerUrl = new URL(servedManifest.archive.url, candidateManifestUrl);
  if (servedInstallerUrl.origin !== manifestUrl.origin)
    throw new Error("SERVED_INSTALLER_ORIGIN_MISMATCH");
  const servedInstallerBytes = await fetchReleaseBytes(
    servedInstallerUrl,
    servedManifest.archive.size,
    "SERVED_INSTALLER",
  );
  if (!servedInstallerBytes.equals(archive)) throw new Error("SERVED_INSTALLER_BYTES_MISMATCH");
  if (createHash("sha256").update(servedInstallerBytes).digest("hex") !== payload.archive.sha256)
    throw new Error("SERVED_INSTALLER_SHA256_MISMATCH");
  publicationStage = "final-toolchain-validation";
  assertPinnedElectronArchive(packageToolchain, zipTarget);
  verifyPinnedPackageToolchain({
    sourceRoot: config.sourceRoot,
    makensisPath: makensis,
    windowsPowerShellExecutable: publicationMoveOptions.powershellExecutable,
    moveFileWriteThroughPath: publicationMoveOptions.helperPath,
  });
  assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit);
  publicationStage = "prepared-receipt";
  receipt = createReceipt({
    servedManifestBytes,
    servedManifest,
    servedInstallerUrl,
    servedInstallerBytes,
    previousManifestBytes,
    installerPublication,
    candidateManifestPublication,
  });
  const receiptPath = join(root, "receipt.json");
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  publicationStage = "latest-commit";
  publicationCommit = commitPreparedPublication({
    destination: manifestPath,
    temporary,
    replacementBytes: signedManifestBytes,
    expectedPreviousBytes: previousManifestBytes,
    receiptPath,
    receiptBytes,
    lockDatabasePath: join(config.runtimeRoot, `${config.instanceId}-windows-publication.sqlite`),
    moveOptions: publicationMoveOptions,
    validatePreparedReceipt: (evidence) =>
      validatePreparedPreviewPublicationReceipt(evidence, updatePublicKeyPem),
  });
  publicationStage = "committed-files-validation";
  verifyCanonicalPublicationFiles();

  publicationStage = "committed-manifest-http-validation";
  const canonicalManifestBytes = await fetchReleaseBytes(
    manifestUrl,
    64 * 1024,
    "COMMITTED_UPDATE_MANIFEST",
  );
  if (!canonicalManifestBytes.equals(signedManifestBytes))
    throw new Error("COMMITTED_MANIFEST_BYTES_MISMATCH");
  const canonicalManifest = assertSignedUpdateManifest(
    JSON.parse(canonicalManifestBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    updatePublicKeyPem,
    "COMMITTED_UPDATE_MANIFEST",
  );
  if (canonicalManifest.archive.url !== `/downloads/${installerName}`)
    throw new Error("COMMITTED_INSTALLER_URL_MISMATCH");
  const canonicalInstallerUrl = new URL(canonicalManifest.archive.url, manifestUrl);
  publicationStage = "committed-installer-http-validation";
  const canonicalInstallerBytes = await fetchReleaseBytes(
    canonicalInstallerUrl,
    canonicalManifest.archive.size,
    "COMMITTED_INSTALLER",
  );
  if (!canonicalInstallerBytes.equals(archive))
    throw new Error("COMMITTED_INSTALLER_BYTES_MISMATCH");
  if (
    createHash("sha256").update(canonicalInstallerBytes).digest("hex") !==
    canonicalManifest.archive.sha256
  )
    throw new Error("COMMITTED_INSTALLER_SHA256_MISMATCH");
  publicationStage = "committed-files-revalidation";
  verifyCanonicalPublicationFiles();
  committedStateValidation = verifyCommittedPublication(publicationCommit, (evidence) =>
    validatePreparedPreviewPublicationReceipt(evidence, updatePublicKeyPem),
  );
  const completedAt = new Date().toISOString();
  publicationResult = {
    schemaVersion: 1,
    kind: "relay-qa-hub-preview-publication-result",
    completedAt,
    receiptSha256: publicationCommit.receiptSha256,
    transactionId: publicationCommit.transactionId,
    recovered: publicationCommit.recovered,
    recoveryReason: publicationCommit.recovered
      ? "resumed-or-poststate-proved-unknown-syscall-outcome"
      : "direct-create-only-publication",
    latest: {
      name: basename(manifestPath),
      url: manifestUrl.href,
      bytes: canonicalManifestBytes.length,
      sha256: createHash("sha256").update(canonicalManifestBytes).digest("hex"),
      httpValidation: "exact-signed-bytes",
    },
    installer: {
      name: installerName,
      url: canonicalInstallerUrl.href,
      bytes: canonicalInstallerBytes.length,
      sha256: createHash("sha256").update(canonicalInstallerBytes).digest("hex"),
      httpValidation: "exact-bytes",
      moveRecovered: installerPublication.recovered,
    },
    candidateManifestMoveRecovered: candidateManifestPublication.recovered,
    stateValidation: committedStateValidation,
    claimName: basename(publicationCommit.claimPath),
    historyName: basename(publicationCommit.historyPath),
  };
  const publicationResultBytes = Buffer.from(
    `${JSON.stringify(publicationResult, null, 2)}\n`,
    "utf8",
  );
  publicationResultSha256 = createHash("sha256").update(publicationResultBytes).digest("hex");
  publicationResultPath = join(root, "publication-result.json");
  publicationStage = "publication-result-durable";
  publicationResultPublication = writeFileExclusiveDurable(
    publicationResultPath,
    publicationResultBytes,
    () => {},
    publicationMoveOptions,
  );
  if (!readFileSync(publicationResultPath).equals(publicationResultBytes))
    throw new Error("PUBLICATION_RESULT_READBACK_MISMATCH");
  publicationResultDurable = true;
  publicationStage = "final-publication-validation";
  verifyCanonicalPublicationFiles();
  const stdoutStateValidation = verifyCommittedPublication(publicationCommit, (evidence) =>
    validatePreparedPreviewPublicationReceipt(evidence, updatePublicKeyPem),
  );
  if (JSON.stringify(stdoutStateValidation) !== JSON.stringify(committedStateValidation))
    throw new Error("COMMITTED_PUBLICATION_STATE_CHANGED");
  committedStateValidation = stdoutStateValidation;
  publicationStage = "complete";
} catch (error) {
  const errorPublicationState = summarizePublicationState(error?.publicationState);
  const failureStage = errorPublicationState?.contentCommitted
    ? errorPublicationState.completed
      ? `committed-${error?.publicationPhase ?? "validation"}`
      : `content-committed-${error?.publicationPhase ?? "incomplete"}`
    : publicationStage;
  save(join(root, "publication-failure.json"), {
    schemaVersion: 1,
    failedAt: new Date().toISOString(),
    stage: failureStage,
    releaseId,
    version,
    sourceCommit,
    manifestPath,
    installer,
    publicationCommit:
      summarizePublicationCommit(publicationCommit) ??
      (errorPublicationState
        ? {
            committed: errorPublicationState.contentCommitted,
            completed: errorPublicationState.completed,
            recovered: errorPublicationState.recovered,
            transactionId: errorPublicationState.transactionId,
            receiptSha256: errorPublicationState.receiptSha256,
            claimName: errorPublicationState.claimName,
            historyName: errorPublicationState.historyName,
          }
        : null),
    publicationState: errorPublicationState,
    publicationResultEvidence: publicationResult
      ? {
          name: publicationResultPath ? basename(publicationResultPath) : null,
          sha256: publicationResultSha256 ?? null,
          durable: publicationResultDurable,
          moveRecovered: publicationResultPublication?.recovered ?? null,
        }
      : null,
    installerMoveRecovered: installerPublication?.recovered ?? null,
    candidateManifestMoveRecovered: candidateManifestPublication?.recovered ?? null,
    error: {
      message: error?.message ?? String(error),
      validationCause: error?.cause?.message ?? null,
      proofCause: error?.proofCause?.message ?? null,
      restoreCause: error?.restoreCause?.message ?? null,
      restored: error?.restored ?? null,
      restoreRecovered: error?.restoreRecovered ?? null,
      restoreNativeError: error?.restoreCause?.nativeError ?? null,
      restoreHelperCode: error?.restoreCause?.helperCode ?? null,
      expectedIdentityMatched: error?.expectedIdentityMatched ?? null,
      actualClaimSha256: error?.actualClaimSha256 ?? null,
      lockCommitCause: summarizeFailureCause(error?.lockCommitCause),
      lockRollbackCause: summarizeFailureCause(error?.lockRollbackCause),
      lockCloseCause: summarizeFailureCause(error?.lockCloseCause),
      nativeError: error?.nativeError ?? null,
      helperCode: error?.helperCode ?? null,
      orphanPath: error?.orphanPath ?? null,
      orphanSha256: error?.orphanSha256 ?? null,
      orphanIdentityMatched: error?.orphanIdentityMatched ?? null,
    },
  });
  throw error;
}
if (!publicationCommit?.committed || !receipt || !publicationResult || !publicationResultSha256)
  throw new Error("PUBLICATION_COMMIT_MISSING");
const publicationOutput = {
  schemaVersion: 1,
  kind: "relay-qa-hub-preview-publication-output",
  releaseId,
  version,
  sourceCommit,
  instanceId: config.instanceId,
  publicationCommit: summarizePublicationCommit(publicationCommit),
  publicationResult,
  publicationResultSha256,
  publicationResultMoveRecovered: publicationResultPublication.recovered,
  stateValidation: committedStateValidation,
};
console.log(JSON.stringify(publicationOutput));
