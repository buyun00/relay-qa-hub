import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { pathsOverlap } from "./path-boundaries.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedWorkspaces = [
  "apps/api",
  "apps/web",
  "apps/worker",
  "packages/contracts",
  "packages/domain",
  "packages/storage",
];
const failures = [];

for (const workspace of expectedWorkspaces) {
  const packagePath = path.join(repositoryRoot, workspace, "package.json");
  try {
    const parsed = JSON.parse(await readFile(packagePath, "utf8"));
    if (!parsed.name || !parsed.version) {
      failures.push(`${workspace}: package.json needs name and version`);
    }
  } catch (error) {
    failures.push(`${workspace}: package.json missing or invalid: ${error.message}`);
  }
}

const resolvedRepository = await realpath(repositoryRoot);
const configuredDataRoot = path.resolve(process.env.QA_HUB_DATA_ROOT ?? "D:\\Relay-QA-Hub-Data");
if (pathsOverlap(resolvedRepository, configuredDataRoot)) {
  failures.push("QA_HUB_DATA_ROOT and the source repository must not contain one another");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Boundary check passed: ${expectedWorkspaces.length} workspace manifests are valid and data root ${configuredDataRoot} is external. Source text and user content are not inspected.`,
  );
}
