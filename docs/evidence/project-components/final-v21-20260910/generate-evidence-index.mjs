import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const outputName = "evidence-index.json";

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative === outputName) continue;
    const stat = await lstat(absolute);
    assert.equal(stat.isSymbolicLink(), false, `evidence link is not allowed: ${relative}`);
    if (stat.isDirectory()) files.push(...(await visit(absolute)));
    else if (stat.isFile()) files.push({ absolute, relative });
  }
  return files;
}

const files = (await visit(root)).sort((a, b) => a.relative.localeCompare(b.relative, "en"));
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
const index = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  root: "docs/evidence/project-components/final-v21-20260910",
  sourceCommit: "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b",
  files: entries.length,
  totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  aggregateSha256: aggregate.digest("hex"),
  entries,
};
await writeFile(path.join(root, outputName), `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      files: index.files,
      totalBytes: index.totalBytes,
      aggregateSha256: index.aggregateSha256,
    },
    null,
    2,
  ),
);
