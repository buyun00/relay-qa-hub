import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteOnlineBackup } from "@relay-qa-hub/storage";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

// Read-only inspection plus a create-only consistent SQLite backup; no service control.
const [, , mode, configPath, runId, ...extra] = process.argv;
if (!["--before", "--after"].includes(mode)) {
  console.log(
    "Usage: node scripts/project-components/retain-preview-api-state.mjs <--before|--after> <preview-instance.json> <run UUID>",
  );
  process.exit(0);
}
assert.equal(extra.length, 0);
assert.match(runId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const config = readParallelInstanceConfig(configPath);
assert.equal(config.instanceId, "qa-hub-preview-7c86");
assert.equal(config.apiHost, "127.0.0.1");
assert.equal(config.apiPort, 4419);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proofRoot = join(
  config.sourceRoot,
  "docs/evidence/project-components/workflow-concurrency-live",
);
const beforeFile = join(proofRoot, `before-restart-${runId}.json`);
const output = mode === "--before" ? beforeFile : join(proofRoot, `after-restart-${runId}.json`);
assert.ok(!existsSync(output), "Prior retention proof must not be overwritten");
const backupPath = join(config.backupRoot, `api-workflow-${runId}`, "qa-hub.sqlite");
const sourcePath = join(config.dataRoot, "db", "qa-hub.sqlite");
const tables = [
  "projects",
  "users",
  "memberships",
  "membership_roles",
  "modules",
  "bugs",
  "repair_attempts",
  "verifications",
  "events",
  "comments",
  "attachments",
  "bug_attachments",
  "bug_deletions",
  "submissions",
  "idempotency_records",
  "manual_completion_requests",
  "user_identity_links",
];
function fingerprints(db) {
  db.exec("BEGIN");
  try {
    return Object.fromEntries(
      tables.map((table) => {
        const rows = db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
        return [table, { count: rows.length, sha256: hash(JSON.stringify(rows)) }];
      }),
    );
  } finally {
    db.exec("ROLLBACK");
  }
}
function evidenceFiles(root) {
  assert.ok(existsSync(root), "Existing evidence root required");
  const pending = [root];
  const rows = [];
  while (pending.length) {
    const folder = pending.pop();
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      assert.ok(!item.isSymbolicLink(), "Evidence links refused");
      const file = join(folder, item.name);
      if (item.isDirectory()) pending.push(file);
      else if (item.isFile()) {
        const bytes = readFileSync(file);
        rows.push({
          path: relative(root, file).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: hash(bytes),
        });
      }
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    count: rows.length,
    bytes: rows.reduce((sum, item) => sum + item.bytes, 0),
    sha256: hash(JSON.stringify(rows)),
  };
}
let backup;
if (mode === "--before") {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    backup = (await createSqliteOnlineBackup({ source, targetPath: backupPath })).manifest;
  } finally {
    source.close();
  }
} else {
  const prior = JSON.parse(readFileSync(beforeFile, "utf8"));
  assert.equal(prior.runId, runId);
  assert.equal(hash(readFileSync(backupPath)), prior.backup.backup.sha256);
  backup = prior.backup;
}
const db = new DatabaseSync(mode === "--before" ? backupPath : sourcePath, { readOnly: true });
let domain;
try {
  domain = fingerprints(db);
} finally {
  db.close();
}
const proof = {
  runId,
  observedAt: new Date().toISOString(),
  instanceId: config.instanceId,
  phase: mode,
  backupRelativePath: relative(config.runtimeRoot, backupPath).replaceAll("\\", "/"),
  backup,
  domain,
  evidence: evidenceFiles(join(config.dataRoot, "evidence")),
  configurationHashes: Object.fromEntries(
    [configPath, config.peopleFile, config.secretsFile].map((file) => [
      relative(config.runtimeRoot, file).replaceAll("\\", "/"),
      hash(readFileSync(file)),
    ]),
  ),
};
if (mode === "--after") {
  const before = JSON.parse(readFileSync(beforeFile, "utf8"));
  proof.checks = {
    domainUnchanged: JSON.stringify(before.domain) === JSON.stringify(proof.domain),
    evidenceUnchanged: JSON.stringify(before.evidence) === JSON.stringify(proof.evidence),
    configurationUnchanged:
      JSON.stringify(before.configurationHashes) === JSON.stringify(proof.configurationHashes),
    consistentBackupRetained: true,
  };
  proof.passed = Object.values(proof.checks).every(Boolean);
}
mkdirSync(proofRoot, { recursive: true });
writeFileSync(output, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    phase: mode,
    passed: proof.passed,
    tables: tables.length,
    evidence: proof.evidence,
    proof: output,
  }),
);
if (proof.passed === false) process.exitCode = 1;
