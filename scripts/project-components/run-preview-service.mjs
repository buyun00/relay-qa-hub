import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  applyParallelInstanceEnvironment,
  canonicalInstancePath,
} from "../../apps/api/src/parallel-instance.ts";

const configFile = process.argv[2];
const service = process.argv[3];
process.env.QA_HUB_INSTANCE_CONFIG_FILE = configFile;
const config = applyParallelInstanceEnvironment(process.env);
const sourceRoot = canonicalInstancePath(fileURLToPath(new URL("../../", import.meta.url)));
if (sourceRoot !== config.sourceRoot) throw new Error("INSTANCE_SOURCE_ROOT_MISMATCH");
if (service === "api") await import(pathToFileURL(join(sourceRoot, "apps/api/dist/main.js")).href);
else if (service === "web") {
  const { startPreviewWeb } = await import("./preview-web.mjs");
  await startPreviewWeb(config);
} else if (service === "mcp") {
  const { startPreviewMcp } = await import("./preview-mcp.mjs");
  await startPreviewMcp(config);
} else throw new Error("Unsupported preview service");
