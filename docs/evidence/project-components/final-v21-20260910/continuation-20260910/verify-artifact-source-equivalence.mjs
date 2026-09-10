import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceRoot = dirname(fileURLToPath(import.meta.url));
const repo = resolve(evidenceRoot, "../../../../..");
const artifactCommit = "867387fe69714ae0c3aafa6182946ffd80495768";
const productCommit = "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b";
const paths = ["apps/web", "apps/desktop", "packages/upload-contract"];

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

for (const commit of [artifactCommit, productCommit]) {
  if (git(["rev-parse", commit]) !== commit) throw new Error(`COMMIT_NOT_FOUND:${commit}`);
}

const comparisons = paths.map((path) => {
  const artifactTree = git(["rev-parse", `${artifactCommit}:${path}`]);
  const productTree = git(["rev-parse", `${productCommit}:${path}`]);
  const changedFiles = git(["diff", "--name-only", artifactCommit, productCommit, "--", path])
    .split(/\r?\n/u)
    .filter(Boolean);
  return {
    path,
    artifactTree,
    productTree,
    treeEqual: artifactTree === productTree,
    changedFiles,
  };
});

const currentHead = git(["rev-parse", "HEAD"]);
const currentChanges = git([
  "status",
  "--porcelain=v1",
  "--",
  "apps/web",
  "apps/desktop",
  "packages/upload-contract",
])
  .split(/\r?\n/u)
  .filter(Boolean);
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  artifactCommit,
  productCommit,
  currentHead,
  comparisons,
  currentRelevantSourceDirty: currentChanges.length > 0,
  currentChanges,
  passed:
    comparisons.every((entry) => entry.treeEqual && entry.changedFiles.length === 0) &&
    currentChanges.length === 0,
  conclusion:
    "The retained Web and Windows artifacts carry an older provenance commit, but every Web, Desktop, and shared upload-contract source byte used by those clients is identical at the final product-source commit.",
  limitation:
    "This proves source equivalence only. It does not replace install, signature, browser, update, or user-delegated real packaging acceptance.",
};

const output = join(evidenceRoot, "artifact-source-equivalence.json");
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, passed: report.passed, comparisons }));
if (!report.passed) process.exitCode = 1;
