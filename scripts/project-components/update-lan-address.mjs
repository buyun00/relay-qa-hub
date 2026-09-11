import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import {
  canonicalInstancePath,
  validateLanNetwork,
  validateParallelInstanceConfig,
} from "../../apps/api/src/parallel-instance.ts";

const [configArgument, address, lanCidr] = process.argv.slice(2);
if (!configArgument || !address || !lanCidr)
  throw new Error("Usage: node update-lan-address.mjs CONFIG_FILE IPV4 LAN_CIDR");
const configFile = canonicalInstancePath(configArgument);
const raw = JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
if (raw.deploymentMode !== "lan") throw new Error("LAN_CONFIGURATION_REQUIRED");
const network = validateLanNetwork(address, lanCidr);
const updated = {
  ...raw,
  publicWebBaseUrl: `http://${network.address}:${raw.webPort}`,
  lanCidr: network.cidr,
};
validateParallelInstanceConfig(updated, configFile);
const temporary = `${configFile}.${process.pid}.tmp`;
if (existsSync(temporary)) throw new Error("LAN_ADDRESS_TEMPORARY_EXISTS");
writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const previous = `${configFile}.${new Date().toISOString().replaceAll(":", "-")}.previous`;
renameSync(configFile, previous);
try {
  renameSync(temporary, configFile);
} catch (error) {
  renameSync(previous, configFile);
  throw error;
}
console.log(
  JSON.stringify({ publicWebBaseUrl: updated.publicWebBaseUrl, lanCidr: network.cidr, previous }),
);
