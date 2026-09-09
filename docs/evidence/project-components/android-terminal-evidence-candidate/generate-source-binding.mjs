import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(evidenceDirectory, "../../../..");
const git = (...args) => execFileSync("git", args, { cwd: root });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const records = git("status", "--porcelain=v1", "-z", "--", "apps/android")
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((record) => ({ status: record.slice(0, 2), path: record.slice(3) }));
if (records.some(({ status }) => status.includes("R") || status.includes("C"))) {
  throw new Error("renamed Android paths require explicit source-binding handling");
}

const files = records
  .sort((left, right) => left.path.localeCompare(right.path))
  .map(({ status, path }) => {
    const bytes = readFileSync(resolve(root, path));
    return {
      path: path.replaceAll("\\", "/"),
      status,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
const aggregate = Buffer.from(
  files
    .map(({ path, status, sizeBytes, sha256: hash }) => `${path}|${status}|${sizeBytes}|${hash}\n`)
    .join(""),
  "utf8",
);
const trackedDiff = git("diff", "--binary", "--", "apps/android");
const payload = {
  recordedAt: new Date().toISOString(),
  sourceHead: git("rev-parse", "HEAD").toString("ascii").trim(),
  trackedDiff: {
    command: "git diff --binary -- apps/android",
    sizeBytes: trackedDiff.length,
    sha256: sha256(trackedDiff),
  },
  changedSourceAggregate: {
    algorithm: "sha256 over sorted UTF-8 path|status|sizeBytes|sha256 lines",
    fileCount: files.length,
    sha256: sha256(aggregate),
  },
  untrackedFiles: files.filter(({ status }) => status === "??"),
  files,
};
writeFileSync(
  resolve(evidenceDirectory, "source-binding.json"),
  `${JSON.stringify(payload, null, 2)}\n`,
);
