import { readdir, readFile, realpath, stat } from "node:fs/promises";
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
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
const skippedDirectories = new Set(["dist", "coverage", "node_modules"]);
const forbiddenRuntimePatterns = [
  {
    pattern: /D:[\\/]Relay-Unity-Orchestrator/i,
    message: "imports or embeds the Relay source/runtime path",
  },
  {
    pattern: /project_management_/i,
    message: "reuses the legacy project-management/轻语 coupling",
  },
  {
    pattern: /轻语|qingyu/i,
    message: "introduces a 轻语 runtime/data/auth/state dependency",
  },
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

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(absolutePath);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      const body = await readFile(absolutePath, "utf8");
      for (const forbidden of forbiddenRuntimePatterns) {
        if (forbidden.pattern.test(body)) {
          failures.push(`${path.relative(repositoryRoot, absolutePath)}: ${forbidden.message}`);
        }
      }
    }
  }
}

for (const sourceRoot of ["apps", "packages"]) {
  const absoluteRoot = path.join(repositoryRoot, sourceRoot);
  try {
    if ((await stat(absoluteRoot)).isDirectory()) await scan(absoluteRoot);
  } catch {
    failures.push(`${sourceRoot}: source root is missing`);
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
    `Boundary check passed: ${expectedWorkspaces.length} independent workspaces; data root ${configuredDataRoot} is external; no Relay path or 轻语 coupling in runtime source.`,
  );
}
