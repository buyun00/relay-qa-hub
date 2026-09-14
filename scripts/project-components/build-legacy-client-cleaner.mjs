import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
import { publishFileExclusiveDurable } from "./release-content-binding.mjs";
import { assertCleanPreviewPackageSource } from "./preview-package-identity.mjs";
import { verifyPinnedPackageToolchain } from "./package-toolchain-provenance.mjs";
import { publishVersionedJson } from "./versioned-json-publication.mjs";

const [configFile, requestedMakensis] = process.argv.slice(2);
if (!configFile || !requestedMakensis || !existsSync(requestedMakensis)) {
  throw new Error("Usage: node build-legacy-client-cleaner.mjs CONFIG_FILE MAKENSIS_EXE");
}
const config = readParallelInstanceConfig(configFile);
if (config.deploymentMode !== "lan") throw new Error("LAN_CONFIGURATION_REQUIRED");
const { sourceCommit } = assertCleanPreviewPackageSource(config.sourceRoot);
const toolchain = verifyPinnedPackageToolchain({
  sourceRoot: config.sourceRoot,
  makensisPath: requestedMakensis,
});
const releaseId = new Date().toISOString().replace(/[-:.]/gu, "");
const versionCode = Number(releaseId.slice(0, 14));
const root = join(config.runtimeRoot, "packages", "legacy-cleaner", releaseId);
mkdirSync(root, { recursive: true });
const icon = join(root, "RelayQaHub.ico");
execFileSync(
  process.execPath,
  [join(config.sourceRoot, "apps/desktop/scripts/generate-team-windows-icon.mjs"), icon],
  { stdio: "pipe" },
);
const fileName = `Relay-QA-Hub-旧版本清理工具-${releaseId}.exe`;
const staged = join(root, fileName);
const buildOutput = execFileSync(
  toolchain.makensisPath,
  [
    "/V2",
    `/DOUTPUT_FILE=${staged}`,
    `/DICON_FILE=${icon}`,
    "/DFILE_VERSION=1.0.0.1",
    join(config.sourceRoot, "scripts/project-components/legacy-client-cleaner.nsi"),
  ],
  { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
);
writeFileSync(join(root, "build.log"), buildOutput, { flag: "wx" });
assertCleanPreviewPackageSource(config.sourceRoot, sourceCommit);
const bytes = readFileSync(staged);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const destination = join(config.downloadsRoot, fileName);
const publication = publishFileExclusiveDurable(staged, destination, bytes, () => {}, {
  powershellExecutable: toolchain.windowsPowerShellPath,
  helperPath: toolchain.moveFileWriteThroughPath,
});
const manifest = {
  schemaVersion: 1,
  versionCode,
  version: "1.0.0",
  releaseId,
  sourceCommit,
  archive: {
    url: `/downloads/${fileName}`,
    fileName,
    size: bytes.length,
    sha256,
  },
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
publishVersionedJson({
  target: join(config.downloadsRoot, "qa-hub-legacy-cleaner-latest.json"),
  bytes: manifestBytes,
  versionCode,
});
const response = await fetch(`${config.publicWebBaseUrl}${manifest.archive.url}`, {
  cache: "no-store",
});
if (!response.ok) throw new Error("LEGACY_CLEANER_HTTP_FAILED");
const downloaded = Buffer.from(await response.arrayBuffer());
if (!downloaded.equals(bytes)) throw new Error("LEGACY_CLEANER_HTTP_MISMATCH");
const receipt = {
  ...manifest,
  kind: "relay-qa-hub-legacy-cleaner-publication",
  installer: destination,
  publication,
  httpValidation: "exact-bytes",
};
writeFileSync(join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: "wx",
});
console.log(
  JSON.stringify({
    ...receipt,
    fileName: basename(destination),
    url: `${config.publicWebBaseUrl}${manifest.archive.url}`,
  }),
);
