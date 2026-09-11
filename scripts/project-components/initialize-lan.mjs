import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalInstancePath,
  validateLanNetwork,
  validateParallelInstanceConfig,
} from "../../apps/api/src/parallel-instance.ts";

const instanceId = "qa-hub-lan-v22-0911";
const [runtimeArgument, address, lanCidr, archiveArgument] = process.argv.slice(2);
if (!runtimeArgument || !address || !lanCidr || !archiveArgument) {
  throw new Error(
    "Usage: node scripts/project-components/initialize-lan.mjs ABSOLUTE_RUNTIME_ROOT IPV4 LAN_CIDR ABSOLUTE_ARCHIVE_ROOT",
  );
}
const network = validateLanNetwork(address, lanCidr);
const publicAddress = network.address;
const runtimeRoot = canonicalInstancePath(runtimeArgument);
const backupArchiveRoot = canonicalInstancePath(archiveArgument);
if (basename(runtimeRoot) !== instanceId) {
  throw new Error(`Runtime directory must be named ${instanceId}`);
}
if (basename(backupArchiveRoot) !== instanceId) {
  throw new Error(`Archive directory must be named ${instanceId}`);
}
if (existsSync(runtimeRoot) || existsSync(backupArchiveRoot)) {
  throw new Error(
    "LAN_ROOT_ALREADY_EXISTS: initialization never overwrites data, backups, or secrets",
  );
}
const sourceRoot = canonicalInstancePath(fileURLToPath(new URL("../../", import.meta.url)));
const configFile = join(runtimeRoot, "instance.json");
const config = {
  schemaVersion: 2,
  deploymentMode: "lan",
  instanceId,
  sourceRoot,
  runtimeRoot,
  dataRoot: join(runtimeRoot, "data"),
  backupRoot: join(runtimeRoot, "backups"),
  backupArchiveRoot,
  backupIntervalMinutes: 60,
  backupRetentionEnabled: true,
  downloadsRoot: join(runtimeRoot, "downloads"),
  logsRoot: join(runtimeRoot, "logs"),
  desktopRoot: join(runtimeRoot, "desktop"),
  apiHost: "127.0.0.1",
  apiPort: 4739,
  webHost: "0.0.0.0",
  webPort: 4740,
  mcpHost: "0.0.0.0",
  mcpPort: 4741,
  desktopMcpPort: 4742,
  cookieName: `${instanceId}-session`,
  releaseChannel: instanceId,
  publicWebBaseUrl: `http://${publicAddress}:4740`,
  backupEnabled: true,
  lanCidr: network.cidr,
  gmUserId: randomUUID(),
  secretsFile: join(runtimeRoot, "secrets.json"),
  peopleFile: join(runtimeRoot, "people.json"),
};
validateParallelInstanceConfig(config, configFile);
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(backupArchiveRoot, { recursive: true });
for (const key of ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"])
  mkdirSync(config[key]);
const save = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
save(config.secretsFile, {
  sessionSecret: randomBytes(48).toString("base64url"),
  debugToken: randomBytes(48).toString("base64url"),
  gmPassword: randomBytes(32).toString("base64url"),
  onboardingSecret: randomBytes(48).toString("base64url"),
});
save(config.peopleFile, { schemaVersion: 4, projectKey: "LOCAL", people: [] });
save(join(config.downloadsRoot, "distribution.json"), {
  schemaVersion: 1,
  instanceId,
  generatedAt: null,
  webBaseUrl: config.publicWebBaseUrl,
  windows: null,
  android: null,
});
save(configFile, config);
console.log(
  JSON.stringify({
    instanceId,
    configFile: resolve(configFile),
    runtimeRoot,
    backupArchiveRoot,
    publicWebBaseUrl: config.publicWebBaseUrl,
    lanCidr,
    note: "GM password and onboarding keys exist only in the restricted secrets file.",
  }),
);
