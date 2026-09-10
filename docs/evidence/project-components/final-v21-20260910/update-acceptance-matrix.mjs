import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const matrixUrl = new URL("./acceptance-matrix.json", import.meta.url);
const matrix = JSON.parse(await readFile(matrixUrl, "utf8"));
const sourceCommit = "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b";
const userLabel = "用户自测／已移交，代理未执行";
const byId = new Map(matrix.cases.map((item) => [item.id, item]));
const requireCase = (id) => {
  const item = byId.get(id);
  assert.ok(item, `missing acceptance case ${id}`);
  return item;
};
const addEvidence = (item, ...paths) => {
  item.evidence = [...new Set([...(item.evidence ?? []), ...paths])];
};

matrix.recordedAt = new Date().toISOString();
matrix.overallStatus = "not_complete";
matrix.completionAllowed = false;
matrix.agentScopeStatus = "candidate_validated_with_known_coverage_gaps";
matrix.userAcceptanceStatus = "delegated_pending";
matrix.productSourceCommit = sourceCommit;
matrix.statusVocabulary.user_handoff = userLabel;
matrix.sourceProvenance = {
  api: sourceCommit,
  android: sourceCommit,
  windows: "867387fe69714ae0c3aafa6182946ffd80495768",
  web: "867387fe69714ae0c3aafa6182946ffd80495768",
  note: "Windows and Web trial artifacts were retained unchanged; API and Android were rebuilt from the final source commit.",
};
matrix.artifacts.android = {
  packageName: "com.relayqahub.android.preview.debug",
  versionCode: 28,
  versionName: "0.2.0-preview.15",
  bytes: 35_913_773,
  sha256: "61a885f22b9a62383d923bf36ca0f9ade9f987c22bb30c7323bd8acbd7536e7a",
  signatureV2: true,
  certificateSha256: "9bbf6d2a68c27871c00abc3203fb319629aabacdcac03674483262bcf09e2a83",
  sourceCommit,
};

const bugCore = requireCase("bug-core-crud-comments-attachments");
addEvidence(bugCore, "live-http-e2e.json");

const http = requireCase("http-api-schema20-business");
http.status = "pass";
http.detail =
  "The restarted commit-88a6d0f API completed upload lost-ack reconciliation, metadata unbound/reserved/claimed transitions, exact notification replay, authorization/CAS negatives, and retained the read receipt in SQLite.";
addEvidence(
  http,
  "api-runtime-restart/restart-verification.json",
  "live-http-e2e.json",
  "live-http-db-receipt.json",
);

const serverMcp = requireCase("server-mcp-96-tools-business");
serverMcp.status = "pass";
addEvidence(serverMcp, "post-restart-mcp-check.json");

const windowsMcp = requireCase("windows-built-in-update-and-local-mcp");
addEvidence(windowsMcp, "post-restart-mcp-check.json");

const androidBuild = requireCase("android-build-feed-install");
androidBuild.status = "pass";
androidBuild.detail =
  "Code 28 was built from the final source, signed, atomically published only to the isolated feed, served byte-exactly by API and Web, and pulled back byte-exactly after the native update.";
androidBuild.evidence = [
  "android/acceptance/android-code28-self-update/artifact-verification.json",
  "android/acceptance/android-code28-self-update/publication.json",
  "android/acceptance/android-code28-self-update/feed-http-verification.json",
  "android/acceptance/android-code28-self-update/luna-e2e/058-verdict.md",
];

const androidUpdate = requireCase("android-native-self-update");
androidUpdate.status = "pass";
androidUpdate.detail =
  "MuMu completed code 26 to 27 and code 27 to 28 through the app update UI plus Android system installer; project, identity, closed Bug, screenshot draft, reverse mappings, and the daily package were preserved.";
androidUpdate.evidence = [
  "android/acceptance/android-code27-self-update/luna-e2e/189-verdict.md",
  "android/acceptance/android-code28-self-update/luna-e2e/058-verdict.md",
];

const mediaProjection = requireCase("android-mediaprojection-draft");
mediaProjection.status = "pass";
mediaProjection.detail =
  "A fresh MuMu capture kept the QA Hub process alive, retained the visible screenshot draft, preserved reverse mappings, and produced no product fatal marker; later native updates preserved that draft.";
mediaProjection.evidence = [
  "android/acceptance/android-mediaprojection-revalidation/36-revalidation-verdict.md",
  "android/acceptance/android-code28-self-update/luna-e2e/058-verdict.md",
];

const runtimeRestart = {
  id: "final-api-runtime-restart-and-durable-readback",
  surfaces: ["http", "server_mcp", "local_mcp"],
  status: "pass",
  detail:
    "Only the isolated API process was restarted after the final build; its exact receipt/listener/readiness and schema-20 DB were verified while Web and both MCP PIDs stayed unchanged. Live HTTP and both MCP read paths passed afterward.",
  evidence: [
    "api-runtime-restart/build-summary.json",
    "api-runtime-restart/restart-verification.json",
    "api-runtime-restart/database-post-restart.json",
    "live-http-e2e.json",
    "live-http-db-receipt.json",
    "post-restart-mcp-check.json",
  ],
};
if (!byId.has(runtimeRestart.id)) matrix.cases.push(runtimeRestart);
else Object.assign(byId.get(runtimeRestart.id), runtimeRestart);

const sourceGate = requireCase("final-source-gate");
sourceGate.status = "pass";
addEvidence(sourceGate, "source-verification-88a6d0f/summary.json");

const coexistence = requireCase("production-and-preview-coexistence");
coexistence.status = "pass";
addEvidence(coexistence, "coexistence-post-restart.json");

const delegatedIds = [
  "android-physical-device",
  "external-build-terminal",
  "external-single-build-upload-terminal",
  "external-incremental-publication-terminal",
  "external-relay-delivery-terminal",
  "external-qingyu-order-terminal",
];
for (const id of delegatedIds) {
  const item = requireCase(id);
  item.status = "not_run";
  item.owner = "user";
  item.handoffStatus = "delegated_to_user";
  item.agentExecuted = false;
  item.resultLabel = userLabel;
  addEvidence(item, "user-self-test-handoff.md");
}

matrix.agentBlocking = [
  {
    id: "fine-grained-coverage-open",
    status: "not_run",
    detail:
      "The regenerated 1,030-item matrix still has broad not_run coverage and 637 rows requiring revalidation; those rows remain authoritative.",
    evidence: ["../coverage-matrix.json", "../coverage-matrix.md"],
  },
];
matrix.userAcceptancePending = delegatedIds.map((id) => ({
  id,
  status: "not_run",
  owner: "user",
  handoffStatus: "delegated_to_user",
  agentExecuted: false,
  resultLabel: userLabel,
}));
matrix.blocking = [...matrix.agentBlocking, ...matrix.userAcceptancePending];

const previousSourceGate = matrix.sourceGate.previousGate ?? {
  commit: matrix.coverageFixCommit,
  effectiveStages: matrix.sourceGate.effectiveStages,
  tests: matrix.sourceGate.tests,
  androidLint: matrix.sourceGate.androidLint,
  evidence: "source-gate/final-summary.json",
};
matrix.sourceGate = {
  previousGate: previousSourceGate,
  currentCommit: {
  commit: sourceCommit,
  typescriptBuilds: "passed",
  storage: { tests: 167, passed: 166, failed: 0, skipped: 1 },
  apiJavaScript: { tests: 274, passed: 274, failed: 0, skipped: 0 },
  apiTypeScript: { tests: 47, passed: 47, failed: 0, skipped: 0 },
  contracts: { status: "passed", checks: 5 },
  androidCleanUnitLintAssemble: { status: "passed", tasks: 59 },
  androidTargetedUpdateUi: { status: "passed", tasks: 32 },
  evidence: "source-verification-88a6d0f/summary.json",
  },
  retainedTransientFailure: {
    status: "retained",
    isolatedRerunPassed: true,
    evidence: "source-verification-88a6d0f/api-js-tests.concurrent-first-failure.tap.txt",
  },
};
matrix.fineGrainedCoverage = {
  items: 1030,
  retiredItems: 47,
  needsRevalidation: 637,
  unavailableReviewedEvidence: 1,
  note: "Fine-grained not_run and needsRevalidation rows remain authoritative; this release must not be marked complete.",
};

await writeFile(matrixUrl, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      overallStatus: matrix.overallStatus,
      completionAllowed: matrix.completionAllowed,
      sourceCommit: matrix.productSourceCommit,
      cases: matrix.cases.length,
      userAcceptancePending: matrix.userAcceptancePending.length,
      fineGrainedCoverage: matrix.fineGrainedCoverage,
    },
    null,
    2,
  ),
);
