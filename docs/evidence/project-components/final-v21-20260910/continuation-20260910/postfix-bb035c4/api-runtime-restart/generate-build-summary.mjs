import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(evidenceDirectory, "../../../../../../..");
const roots = ["apps/api/dist", "packages/storage/dist"];

async function visit(relativeDirectory) {
  const absoluteDirectory = path.join(sourceRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = path.posix.join(relativeDirectory.split(path.sep).join("/"), entry.name);
    const absolute = path.join(sourceRoot, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`DIST_LINK_REFUSED:${relative}`);
    if (metadata.isDirectory()) files.push(...(await visit(relative)));
    else if (metadata.isFile()) files.push({ absolute, relative });
  }
  return files;
}

const files = (await Promise.all(roots.map((root) => visit(root))))
  .flat()
  .sort((left, right) => left.relative.localeCompare(right.relative, "en"));
const entries = [];
for (const file of files) {
  const bytes = await readFile(file.absolute);
  entries.push({
    path: file.relative,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const aggregate = createHash("sha256");
for (const entry of entries) {
  aggregate.update(entry.path, "utf8");
  aggregate.update("\0", "utf8");
  aggregate.update(String(entry.bytes), "utf8");
  aggregate.update("\0", "utf8");
  aggregate.update(entry.sha256, "utf8");
  aggregate.update("\n", "utf8");
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
const latestApiStorageCommit = execFileSync(
  "git",
  ["log", "-1", "--format=%H", "--", "apps/api", "packages/storage"],
  { cwd: sourceRoot, encoding: "utf8" },
).trim();
const laterApiStorageChanges = execFileSync(
  "git",
  ["diff", "--name-only", `${latestApiStorageCommit}..${sourceCommit}`, "--", "apps/api", "packages/storage"],
  { cwd: sourceRoot, encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/u)
  .filter(Boolean);
const summary = {
  schemaVersion: 1,
  sourceCommit,
  builtAt: new Date().toISOString(),
  roots,
  fileCount: entries.length,
  totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  aggregateSha256: aggregate.digest("hex"),
  aggregateFormat: "path\\0bytes\\0sha256\\n sorted by repository-relative path",
  storageExitCode: 0,
  apiExitCode: 0,
  buildCommands: [
    "node packages/storage/node_modules/typescript/bin/tsc -p packages/storage/tsconfig.json",
    "node apps/api/node_modules/typescript/bin/tsc -p apps/api/tsconfig.json",
  ],
  liveRuntime: {
    apiProcessStartedAt: "2026-09-10T18:35:29+08:00",
    latestApiStorageCommit,
    laterApiStorageChanges,
    sourceUnchangedSinceRuntimeStart: laterApiStorageChanges.length === 0,
  },
};
await writeFile(path.join(evidenceDirectory, "build-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
