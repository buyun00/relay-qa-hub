import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const productSourceCommit = "c4e2eb7d9341a16d2430df9073a93f44f381dd2b";
const outputName = "evidence-index.json";
const excludedPaths = [outputName, "final-validation.json"];

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `${name} requires a value`);
  return value;
}

const dryRun = process.argv.includes("--dry-run");
const root = path.resolve(
  option("--root") ?? fileURLToPath(new URL("./", import.meta.url)),
);
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const rootRelativeFromRepo = path.relative(repoRoot, root);
assert.ok(
  rootRelativeFromRepo &&
    rootRelativeFromRepo !== ".." &&
    !rootRelativeFromRepo.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rootRelativeFromRepo),
  "evidence root must be inside the repository",
);
const rootFromRepo = rootRelativeFromRepo.split(path.sep).join("/");

async function repoRegularFile(relative, label) {
  assert.equal(typeof relative, "string", `${label}: path must be a string`);
  assert.ok(relative.length > 0 && !path.isAbsolute(relative), `${label}: relative path required`);
  assert.ok(!relative.includes("\\"), `${label}: forward-slash path required`);
  const absolute = path.resolve(root, ...relative.split("/"));
  assert.equal(
    path.relative(root, absolute).split(path.sep).join("/"),
    relative,
    `${label}: non-canonical path`,
  );
  const fromRepo = path.relative(repoRoot, absolute);
  assert.ok(
    fromRepo &&
      fromRepo !== ".." &&
      !fromRepo.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(fromRepo),
    `${label}: path escaped the repository`,
  );
  let cursor = repoRoot;
  let stat;
  for (const part of fromRepo.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    stat = await lstat(cursor);
    assert.equal(stat.isSymbolicLink(), false, `${label}: path contains a symbolic link`);
  }
  assert.equal(stat?.isFile(), true, `${label}: tracked evidence must be a regular file`);
  return absolute;
}

function trackedAllowlist() {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", rootFromRepo], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const prefix = `${rootFromRepo}/`;
  const relativePaths = stdout
    .split("\0")
    .filter(Boolean)
    .map((repoRelative) => {
      assert.ok(repoRelative.startsWith(prefix), `tracked path escaped evidence root: ${repoRelative}`);
      return repoRelative.slice(prefix.length);
    })
    .filter((relative) => !excludedPaths.includes(relative))
    .sort((a, b) => a.localeCompare(b, "en"));
  assert.equal(new Set(relativePaths).size, relativePaths.length, "tracked allowlist contains duplicates");
  return relativePaths;
}

const allowlist = trackedAllowlist();
const entries = [];
for (const relative of allowlist) {
  const absolute = await repoRegularFile(relative, `evidence ${relative}`);
  const bytes = await readFile(absolute);
  entries.push({
    path: relative,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
assert.deepEqual(
  entries.map((entry) => entry.path),
  allowlist,
  "index entries must cover the complete tracked allowlist exactly once",
);

const aggregate = createHash("sha256");
for (const entry of entries) {
  aggregate.update(entry.path, "utf8");
  aggregate.update("\0", "utf8");
  aggregate.update(String(entry.bytes), "utf8");
  aggregate.update("\0", "utf8");
  aggregate.update(entry.sha256, "utf8");
  aggregate.update("\n", "utf8");
}
const index = {
  schemaVersion: 2,
  recordedAt: new Date().toISOString(),
  root: rootFromRepo,
  sourceCommit: productSourceCommit,
  productSourceCommit,
  selection: {
    method: "git ls-files",
    trackedOnly: true,
    excludedPaths,
    completeTrackedSetVerified: true,
  },
  files: entries.length,
  totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  aggregateSha256: aggregate.digest("hex"),
  entries,
};
if (!dryRun) {
  const outputPath = await repoRegularFile(outputName, "evidence index output");
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}
console.log(
  JSON.stringify(
    {
      dryRun,
      sourceCommit: index.productSourceCommit,
      selection: index.selection,
      files: index.files,
      totalBytes: index.totalBytes,
      aggregateSha256: index.aggregateSha256,
    },
    null,
    2,
  ),
);
