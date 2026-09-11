import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const freshRoot = resolve(here, "fresh-api-mcp");
const pinnedSource = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const pinnedNodeSha256 = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237";
const pinnedHarnessSha256 = "cfa861db06de47a85d3072344931752d27448d4e376e74cbdfcd09f52c57dc5d";
const expectedRuns = new Map([
  ["management", 96],
  ["http-core", 15],
  ["server-mcp-core", 13],
]);
const expectedBuilds = new Map([
  ["storage", { sources: 53, outputs: 212 }],
  ["api", { sources: 70, outputs: 280 }],
]);

const checks = [];
const check = (label, operation) => {
  operation();
  checks.push(label);
};
const sha256Bytes = (value) => createHash("sha256").update(value).digest("hex");
const sha256 = (path) => sha256Bytes(readFileSync(path));
const git = (...args) =>
  execFileSync("git.exe", args, { cwd: root, encoding: "utf8" }).trim();

const proofCandidates = readdirSync(freshRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(freshRoot, entry.name, "proof.json"))
  .filter(existsSync);
check("exactly one passing proof exists", () => assert.equal(proofCandidates.length, 1));
const proofPath = proofCandidates[0];
const proofRaw = readFileSync(proofPath, "utf8");
const proof = JSON.parse(proofRaw);
const attemptsSummaryPath = resolve(freshRoot, "attempts-summary.json");
const attemptsSummary = JSON.parse(readFileSync(attemptsSummaryPath, "utf8"));

check("proof identity", () => {
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.kind, "fresh-built-current-source-isolated-api-server-mcp-revalidation");
  assert.equal(proof.runId, relative(freshRoot, dirname(proofPath)));
  assert.equal(proof.passed, true);
});
check("failed and passing attempt history is retained", () => {
  assert.equal(attemptsSummary.schemaVersion, 1);
  assert.equal(attemptsSummary.kind, "fresh-current-source-api-mcp-attempt-history");
  assert.equal(attemptsSummary.productSourceCommit, pinnedSource);
  assert.equal(attemptsSummary.attempts.length, 4);
  assert.equal(attemptsSummary.attempts.filter((item) => item.acceptedAsPassingEvidence).length, 1);
  assert.equal(
    attemptsSummary.attempts.find((item) => item.acceptedAsPassingEvidence).runId,
    proof.runId,
  );
  assert.equal(attemptsSummary.safety.noFailedAttemptWasDeleted, true);
  assert.equal(attemptsSummary.safety.failedRuntimeDataRetained, true);
  assert.deepEqual(attemptsSummary.finalReadOnlyObservation.lingeringOwnedProcesses, []);
  assert.deepEqual(attemptsSummary.finalReadOnlyObservation.lingeringOwnedListeners, []);
  assert.equal(attemptsSummary.finalReadOnlyObservation.matchesPassingProofPostState, true);
  assert.equal(attemptsSummary.scope.eligibleNeedsRevalidationClearCount, 0);
  assert.equal(attemptsSummary.scope.overallAcceptanceStatus, "not_complete");
  assert.equal(attemptsSummary.scope.completionAllowed, false);
});
check("abrupt failed attempt is not mislabeled graceful", () => {
  const failed = attemptsSummary.attempts.find(
    (item) => item.runId === "d3b792a6-7837-4c60-ba91-fe78b2d5dbd1",
  );
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.finalization, "abrupt_or_unknown");
  assert.equal(failed.acceptedAsPassingEvidence, false);
  const supplementPath = resolve(root, failed.postShellFinalization);
  const supplement = JSON.parse(readFileSync(supplementPath, "utf8"));
  assert.equal(supplement.kind, "fresh-current-source-failed-attempt-post-shell-finalization");
  assert.equal(supplement.runId, failed.runId);
  assert.equal(supplement.originalState.processPresentAfterHarnessCleanup, true);
  assert.equal(supplement.laterReadOnlyObservation.processPresent, false);
  assert.deepEqual(supplement.laterReadOnlyObservation.listenersPresent, []);
  assert.equal(supplement.laterReadOnlyObservation.gracefulShutdownLogPresent, false);
  assert.match(supplement.finalizationAssessment, /abrupt_or_unknown/u);
  assert.equal(supplement.completionAllowed, false);
  assert.equal(supplement.passed, false);
});
check("pinned product source", () => {
  assert.equal(proof.source.productSourceCommit, pinnedSource);
  assert.equal(proof.source.productPathsMatchPinnedCommit, true);
  assert.equal(proof.source.buildAndRuntimeInputsMatchPinnedCommit, true);
  assert.equal(proof.source.buildAndRuntimeInputsCleanBeforeAndAfter, true);
  assert.match(proof.source.evidenceHead, /^[0-9a-f]{40}$/u);
  assert.match(proof.source.remoteHead, /^[0-9a-f]{40}$/u);
});
check("proof commit remains in current history", () => {
  assert.doesNotThrow(() => git("merge-base", "--is-ancestor", proof.source.evidenceHead, "HEAD"));
  assert.doesNotThrow(() => git("merge-base", "--is-ancestor", pinnedSource, proof.source.evidenceHead));
});
check("current product and build inputs still match pinned source", () => {
  assert.equal(
    git(
      "diff",
      "--name-only",
      pinnedSource,
      "HEAD",
      "--",
      ...proof.source.buildBindingPaths,
      ...proof.source.runtimeScriptHashes.map((item) => item.file),
    ),
    "",
  );
  assert.equal(
    git(
      "status",
      "--porcelain=v1",
      "--",
      ...proof.source.buildBindingPaths,
      ...proof.source.runtimeScriptHashes.map((item) => item.file),
    ),
    "",
  );
  assert.equal(
    git(
      "status",
      "--porcelain=v1",
      "--ignored=matching",
      "--",
      ...proof.source.buildBindingPaths,
      ...proof.source.runtimeScriptHashes.map((item) => item.file),
    ),
    "",
  );
});
check("post-run harness receipt is externally pinned", () => {
  const harness = resolve(here, "run-fresh-current-source-api-mcp.mjs");
  assert.equal(sha256(harness), pinnedHarnessSha256);
  assert(new Date(statSync(harness).mtime) < new Date(proof.build.finishedAt));
});

function verifyManifest(manifest, label) {
  assert(Array.isArray(manifest.items) && manifest.items.length > 0, `${label} is empty`);
  for (const item of manifest.items) {
    const file = resolve(root, item.file);
    assert(existsSync(file), `${label} file missing: ${item.file}`);
    assert.equal(statSync(file).size, item.bytes, `${label} byte mismatch: ${item.file}`);
    assert.equal(sha256(file), item.sha256, `${label} hash mismatch: ${item.file}`);
  }
  assert.equal(
    sha256Bytes(JSON.stringify(manifest.items)),
    manifest.aggregateSha256,
    `${label} aggregate hash mismatch`,
  );
}

check("307 tracked source and build-input files retain exact bytes", () => {
  assert.equal(proof.source.trackedSourceManifest.items.length, 307);
  verifyManifest(proof.source.trackedSourceManifest, "source manifest");
});
check("runtime scripts retain exact bytes", () => {
  assert.equal(proof.source.runtimeScriptHashes.length, 6);
  for (const item of proof.source.runtimeScriptHashes) {
    const file = resolve(root, item.file);
    assert.equal(statSync(file).size, item.bytes);
    assert.equal(sha256(file), item.sha256);
  }
});
check("pinned Node runtime", () => {
  assert.equal(proof.build.node.version, "v24.19.0");
  assert.equal(proof.build.node.sha256, pinnedNodeSha256);
  assert.equal(statSync(proof.build.node.path).size, proof.build.node.bytes);
  assert.equal(sha256(proof.build.node.path), pinnedNodeSha256);
});
check("two exact TypeScript builds succeeded", () => {
  assert.equal(proof.build.receipts.length, 2);
  assert.equal(proof.build.distHashesStableThroughExecution, true);
  for (const receipt of proof.build.receipts) {
    const expected = expectedBuilds.get(receipt.id);
    assert(expected, `unexpected build receipt: ${receipt.id}`);
    assert.equal(receipt.compilerVersion, "Version 7.0.2");
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.sourceFileCount, expected.sources);
    assert.equal(receipt.expectedOutputFileCount, expected.outputs);
    assert.equal(receipt.beforeDistManifest.items.length, expected.outputs);
    assert.equal(receipt.distManifest.items.length, expected.outputs);
    assert.equal(receipt.emitted.length, expected.outputs);
    assert.equal(receipt.beforeDistManifest.aggregateSha256, receipt.distManifest.aggregateSha256);
    assert.equal(statSync(resolve(root, receipt.compiler.file)).size, receipt.compiler.bytes);
    assert.equal(sha256(resolve(root, receipt.compiler.file)), receipt.compiler.sha256);
    verifyManifest(receipt.distManifest, `${receipt.id} dist manifest`);
  }
});
check("storage workspace resolved to the built package", () => {
  const binding = proof.build.storageWorkspaceResolution;
  assert.equal(binding.exact, true);
  assert.equal(binding.resolved, "packages/storage");
  assert.equal(binding.apiResolvedEntry, binding.expectedEntry);
  assert.equal(binding.sqliteWorkerEntry, "packages/storage/dist/sqlite-worker-entry.js");
  assert.equal(sha256(resolve(root, binding.sqliteWorkerEntry)), binding.sqliteWorkerEntrySha256);
});
check("current API module resolution stays inside both workspaces", () => {
  const apiRequire = createRequire(resolve(root, "apps/api/dist/main.js"));
  assert.equal(
    realpathSync(apiRequire.resolve("@relay-qa-hub/storage")),
    realpathSync(resolve(root, "packages/storage/dist/index.js")),
  );
  assert.equal(
    realpathSync(apiRequire.resolve("@relay-qa-hub/upload-contract")),
    realpathSync(resolve(root, "packages/upload-contract/index.js")),
  );
});

check("fresh runtime began without databases", () => {
  assert.equal(proof.instance.initialRuntimeState.mainDatabaseExists, false);
  assert.equal(proof.instance.initialRuntimeState.componentDatabaseExists, false);
  assert.deepEqual(proof.instance.initialRuntimeState.dataFiles, []);
});
check("fresh runtime paths and ports are isolated", () => {
  assert.match(proof.instance.instanceId, /^qa-hub-preview-fd0f0f8-[0-9a-f]{8}$/u);
  assert(proof.instance.runtimeRoot.startsWith("C:\\Users\\lin0\\.codex\\parallel-runtimes\\"));
  assert(!proof.instance.runtimeRoot.startsWith(root));
  const ports = Object.values(proof.instance.ports);
  assert.equal(new Set(ports).size, ports.length);
  assert(ports.every((port) => Number.isInteger(port) && !proof.coexistence.protectedPorts.includes(port)));
  assert.equal(sha256(proof.instance.configPath), proof.instance.configSha256);
  assert.equal(proof.instance.configValidatedByCurrentSource, true);
  assert.equal(proof.instance.dataRetained, true);
});
check("runtime secrets remain outside the repository and absent from evidence", () => {
  assert.equal(proof.instance.secretsPersistedOutsideRepository, true);
  assert.equal(proof.instance.secretsRecordedInEvidence, false);
  assert(!proof.instance.secretsFile.path.startsWith(root));
  assert.equal(statSync(proof.instance.secretsFile.path).size, proof.instance.secretsFile.bytes);
  assert.equal(sha256(proof.instance.secretsFile.path), proof.instance.secretsFile.sha256);
  assert.equal(statSync(proof.instance.peopleFile.path).size, proof.instance.peopleFile.bytes);
  assert.equal(sha256(proof.instance.peopleFile.path), proof.instance.peopleFile.sha256);
  const secretDocument = JSON.parse(readFileSync(proof.instance.secretsFile.path, "utf8"));
  assert.deepEqual(Object.keys(secretDocument).sort(), [...proof.instance.secretsFile.keys].sort());
  const secretScanDocuments = [proofRaw];
  for (const run of proof.runs)
    secretScanDocuments.push(readFileSync(resolve(root, run.evidence), "utf8"));
  for (const process of proof.processes) {
    secretScanDocuments.push(readFileSync(process.stdout.path, "utf8"));
    secretScanDocuments.push(readFileSync(process.stderr.path, "utf8"));
  }
  for (const value of Object.values(secretDocument)) {
    assert.equal(typeof value, "string");
    assert(value.length >= 16);
    assert(
      secretScanDocuments.every((document) => !document.includes(value)),
      "a secret value was recorded in proof, smoke, or process logs",
    );
  }
});

check("API and server MCP readiness are bound to this instance", () => {
  assert.equal(proof.readiness.api.httpStatus, 200);
  assert.equal(proof.readiness.api.body.status, "ready");
  assert.equal(proof.readiness.serverMcp.httpStatus, 200);
  assert.equal(proof.readiness.serverMcp.body.status, "ready");
  assert.equal(proof.readiness.serverMcp.instanceHeader, proof.instance.instanceId);
  assert.equal(proof.readiness.serverMcpInstanceHeaderExact, true);
});
check("two owned processes started after the build and exited gracefully", () => {
  assert.deepEqual(proof.processes.map((item) => item.id), ["api", "mcp"]);
  for (const process of proof.processes) {
    assert.equal(process.startedAfterBuild, true);
    assert(new Date(process.startedAt) > new Date(proof.build.finishedAt));
    assert.equal(process.identity.pid, process.pid);
    assert.equal(process.identity.startedAt, process.startedAt);
    assert.equal(process.executable, proof.build.node.path);
    assert.equal(process.nodeVersion, "24.19.0");
    assert.equal(process.cleanup.method, "inspector process.emit(SIGTERM)");
    assert.equal(process.cleanup.pid, process.pid);
    assert(process.cleanup.signalListeners > 0);
    assert.equal(process.cleanup.exitCode, 0);
    assert(new Date(process.cleanup.exitedAt) >= new Date(process.cleanup.requestedAt));
    for (const stream of [process.stdout, process.stderr]) {
      assert.equal(statSync(stream.path).size, stream.bytes);
      assert.equal(sha256(stream.path), stream.sha256);
    }
  }
});
check("owned API and MCP lifecycle events are present", () => {
  const api = proof.processes.find((item) => item.id === "api");
  const mcp = proof.processes.find((item) => item.id === "mcp");
  assert(
    api.selectedLogEvents.some(
      (event) =>
        event.event === "parallel-instance.validated" &&
        event.instanceId === proof.instance.instanceId &&
        event.apiPort === proof.instance.ports.apiPort,
    ),
  );
  assert(api.selectedLogEvents.some((event) => event.msg === "Relay QA Hub API started"));
  assert(
    api.selectedLogEvents.some(
      (event) => event.msg === "stopping Relay QA Hub API" && event.signal === "SIGTERM",
    ),
  );
  assert(
    mcp.selectedLogEvents.some(
      (event) =>
        event.event === "preview-mcp.started" &&
        event.instanceId === proof.instance.instanceId &&
        event.address === `http://127.0.0.1:${proof.instance.ports.mcpPort}/mcp`,
    ),
  );
});
check("process logs contain no product error event", () => {
  for (const process of proof.processes) {
    const stdoutLines = readFileSync(process.stdout.path, "utf8").split(/\r?\n/u).filter(Boolean);
    assert(stdoutLines.length > 0);
    for (const line of stdoutLines) {
      const event = JSON.parse(line);
      assert(!(Number.isFinite(event.level) && event.level >= 40));
      assert.notEqual(event.failed, true);
    }
    const stderr = readFileSync(process.stderr.path, "utf8");
    assert.match(stderr, /^Debugger listening on ws:\/\/127\.0\.0\.1:/u);
    assert(stderr.includes("Debugger attached."));
    assert(stderr.includes("Waiting for the debugger to disconnect...") || stderr.includes("Debugger ending"));
  }
});

check("three scoped smoke suites have exact evidence", () => {
  assert.equal(proof.runs.length, expectedRuns.size);
  for (const run of proof.runs) {
    assert.equal(run.checks, expectedRuns.get(run.id));
    const evidencePath = resolve(root, run.evidence);
    assert.equal(statSync(evidencePath).size, run.evidenceBytes);
    assert.equal(sha256(evidencePath), run.evidenceSha256);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.runId, run.runId);
    assert.equal(evidence.instanceId, proof.instance.instanceId);
    assert.equal(evidence.passed, true);
    assert.equal(evidence.checks.length, run.checks);
    assert(new Date(run.startedAt) >= new Date(proof.processes.at(-1).startedAt));
    assert(new Date(run.finishedAt) <= new Date(proof.processes.at(-1).cleanup.requestedAt));
    if (run.id === "management") {
      assert.deepEqual(evidence.outbound, []);
      assert(evidence.checks.every((item) => item.passed === true));
    } else if (run.id === "http-core") {
      assert(evidence.checks.every((item) => item.status === item.expectedStatus));
    } else {
      assert(evidence.checks.every((item) => item.httpStatus === 200));
      assert(evidence.checks.every((item) => item.result?.error === undefined));
    }
  }
});

function verifyDatabase(database, label) {
  assert(database.path.startsWith(proof.instance.runtimeRoot), `${label} escaped runtime root`);
  assert.equal(statSync(database.path).size, database.bytes);
  assert.equal(sha256(database.path), database.sha256);
  assert.deepEqual(database.integrity, ["ok"]);
  assert.deepEqual(database.foreignKeyViolations, []);
  for (const companion of database.companions) {
    const path = `${database.path}${companion.suffix}`;
    assert.equal(existsSync(path), companion.exists);
    assert.equal(statSync(path).size, companion.bytes);
    assert.equal(sha256(path), companion.sha256);
  }
  const handle = new DatabaseSync(database.path, { readOnly: true });
  try {
    assert.deepEqual(
      handle.prepare("PRAGMA integrity_check").all().map((item) => item.integrity_check),
      ["ok"],
    );
    assert.deepEqual(handle.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(handle.prepare("PRAGMA application_id").get().application_id, database.applicationId);
    assert.equal(handle.prepare("PRAGMA user_version").get().user_version, database.userVersion);
  } finally {
    handle.close();
  }
}

check("retained SQLite databases are byte-exact and internally valid", () => {
  verifyDatabase(proof.databases.main, "main database");
  verifyDatabase(proof.databases.components, "component database");
});
check("external component task tables remain empty", () => {
  assert.equal(proof.databases.main.tableCounts.relay_receipts, 0);
  assert.equal(proof.databases.main.tableCounts.qingyu_bug_links, 0);
  assert.equal(proof.databases.main.tableCounts.integration_links, 0);
  assert.equal(proof.databases.main.tableCounts.builds, 0);
  assert.equal(proof.databases.components.tableCounts.build_tasks, 0);
  assert.equal(proof.databases.components.tableCounts.sync_tasks, 0);
  assert(
    proof.databases.main.outboxByDestination.every(
      (item) =>
        item.destination === "qa-hub.notifications" && item.status === "pending" && item.attempts === 0,
    ),
  );
  assert.deepEqual(proof.databases.components.outboxByDestination, []);
  const main = new DatabaseSync(proof.databases.main.path, { readOnly: true });
  const components = new DatabaseSync(proof.databases.components.path, { readOnly: true });
  try {
    for (const table of [
      "build_lineage_entries",
      "build_lineages",
      "build_manifest_commits",
      "build_repair_links",
      "builds",
      "integration_links",
      "occurrence_build_lineage_facts",
      "qingyu_bug_links",
      "relay_receipts",
      "relay_rework_requests",
      "upload_chunks",
      "upload_sessions",
    ])
      assert.equal(main.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
    const requirements = main
      .prepare("SELECT requirement, decision_basis, delivered_commit_sha, linked_build_id FROM build_requirements")
      .all();
    assert.equal(requirements.length, 3);
    assert(
      requirements.every(
        (item) =>
          item.requirement === "not_required" &&
          item.decision_basis === "no_code_delivery" &&
          item.delivered_commit_sha === null &&
          item.linked_build_id === null,
      ),
    );
    const outbound = main
      .prepare(
        "SELECT destination, status, count(*) AS count, sum(attempt_count) AS attempts FROM outbox GROUP BY destination, status",
      )
      .all()
      .map((item) => ({ ...item }));
    assert.deepEqual(outbound, proof.databases.main.outboxByDestination);
    assert(outbound.every((item) => item.destination === "qa-hub.notifications"));
    assert.equal(components.prepare("SELECT count(*) AS count FROM build_tasks").get().count, 0);
    assert.equal(components.prepare("SELECT count(*) AS count FROM sync_tasks").get().count, 0);
  } finally {
    main.close();
    components.close();
  }
});

check("protected listeners and health stayed byte-for-byte stable", () => {
  assert.deepEqual(proof.coexistence.after, proof.coexistence.before);
  assert.deepEqual(proof.coexistence.existingHealthAfter, proof.coexistence.existingHealthBefore);
  assert.equal(proof.coexistence.protectedListenersUnchanged, true);
  assert.equal(proof.coexistence.existingHealthUnchanged, true);
  assert.equal(proof.coexistence.ownedPortsReleased, true);
});
check("owned ports remain released", () => {
  const ports = Object.values(proof.instance.ports);
  const command = `$ports=@(${ports.join(",")}); @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$ports -contains [int]$_.LocalPort}).Count`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(Number(result.stdout.trim()), 0);
});
check("safety declarations remain fail-closed", () => {
  for (const key of [
    "productionBusinessRequestsSent",
    "productionProcessesSignaled",
    "existingPreviewProcessesSignaled",
    "externalComponentsExecuted",
    "userOnlyGatesExecuted",
    "forceKillUsed",
  ])
    assert.equal(proof.safety[key], false, `${key} must be false`);
  assert.equal(proof.safety.exactOwnedGracefulShutdownOnly, true);
  assert.deepEqual(proof.safety.integrationEnvironmentVariableNames, []);
  assert.deepEqual(proof.safety.managementWitnessOutboundRequests, []);
  assert.equal(proof.safety.externalStateTablesRemainEmpty, true);
});
check("coverage remains uncleared", () => {
  assert.equal(proof.coverage.exactFlaggedItemsTouchedByTheseHarnesses, 30);
  assert.equal(proof.coverage.httpFlaggedItemsTouched, 23);
  assert.equal(proof.coverage.serverMcpFlaggedItemsTouched, 7);
  assert.deepEqual(proof.coverage.eligibleNeedsRevalidationClears, []);
  assert.equal(proof.coverage.eligibleNeedsRevalidationClearCount, 0);
  assert.equal(proof.coverage.clearsWholeCoverageMatrix, false);
});
check("overall acceptance remains not complete", () => {
  assert.equal(proof.scope.currentSourceRuntimeBinding, "pass");
  assert.equal(proof.scope.isolatedBehaviorBatchStatus, "pass");
  assert.equal(proof.scope.overallAcceptanceStatus, "not_complete");
  assert.equal(proof.scope.completionAllowed, false);
});

console.log(
  JSON.stringify({
    passed: true,
    checks: checks.length,
    runId: proof.runId,
    productSourceCommit: proof.source.productSourceCommit,
    builds: proof.build.receipts.map((item) => ({
      id: item.id,
      sourceFiles: item.sourceFileCount,
      outputFiles: item.expectedOutputFileCount,
      exitCode: item.exitCode,
    })),
    runs: proof.runs.map((item) => ({ id: item.id, checks: item.checks, sha256: item.evidenceSha256 })),
    eligibleNeedsRevalidationClearCount: proof.coverage.eligibleNeedsRevalidationClearCount,
    overallAcceptanceStatus: proof.scope.overallAcceptanceStatus,
    limitations: {
      orchestratorSelfHashRecordedInProof: false,
      orchestratorPostRunHashPinnedByValidator: true,
      buildOutputDirectoryWasEmptyBeforeBuild: false,
      fullExpectedOutputsWereEmittedAndByteStable: true,
      safeForUnattendedRerun: false,
    },
  }),
);
