import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalInstancePath,
  validateParallelInstanceConfig,
} from "../../apps/api/src/parallel-instance.ts";

const instanceId = "qa-hub-preview-7c86";
const argument = process.argv[2];
if (!argument)
  throw new Error(
    "Usage: node scripts/project-components/initialize-preview.mjs ABSOLUTE_RUNTIME_ROOT",
  );
const runtimeRoot = canonicalInstancePath(argument);
if (basename(runtimeRoot) !== instanceId)
  throw new Error(`Runtime directory must be named ${instanceId}`);
const sourceRoot = canonicalInstancePath(fileURLToPath(new URL("../../", import.meta.url)));
const configFile = join(runtimeRoot, "instance.json");
if (existsSync(runtimeRoot))
  throw new Error(
    "PREVIEW_ROOT_ALREADY_EXISTS: initialization never overwrites existing data or secrets",
  );
const config = {
  schemaVersion: 1,
  instanceId,
  sourceRoot,
  runtimeRoot,
  dataRoot: join(runtimeRoot, "data"),
  backupRoot: join(runtimeRoot, "backups"),
  downloadsRoot: join(runtimeRoot, "downloads"),
  logsRoot: join(runtimeRoot, "logs"),
  desktopRoot: join(runtimeRoot, "desktop"),
  apiHost: "127.0.0.1",
  apiPort: 4419,
  webHost: "127.0.0.1",
  webPort: 4274,
  mcpPort: 4421,
  desktopMcpPort: 4420,
  cookieName: `${instanceId}-session`,
  releaseChannel: instanceId,
  gmUserId: randomUUID(),
  secretsFile: join(runtimeRoot, "secrets.json"),
  peopleFile: join(runtimeRoot, "people.json"),
};
validateParallelInstanceConfig(config, configFile);
mkdirSync(runtimeRoot, { recursive: true });
for (const key of ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"])
  mkdirSync(config[key]);
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
save(config.secretsFile, {
  sessionSecret: randomBytes(48).toString("base64url"),
  debugToken: randomBytes(48).toString("base64url"),
  gmPassword: randomBytes(32).toString("base64url"),
});
save(config.peopleFile, { schemaVersion: 4, projectKey: "LOCAL", people: [] });
save(configFile, config);
console.log(
  JSON.stringify({
    instanceId,
    configFile: resolve(configFile),
    runtimeRoot,
    note: "GM password is stored only in the instance secrets file. Keep this file private.",
  }),
);
