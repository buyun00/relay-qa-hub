import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const matrixUrl = new URL("./acceptance-matrix.json", import.meta.url);
const markdownUrl = new URL("./acceptance-matrix.md", import.meta.url);
const coverageMatrixUrl = new URL("../coverage-matrix.json", import.meta.url);
const artifactSourceEquivalenceUrl = new URL(
  "./continuation-20260910/artifact-source-equivalence.json",
  import.meta.url,
);
const webCuaReadbackPath = "continuation-20260910/web-cua-readback.json";
const webCuaReadbackUrl = new URL(`./${webCuaReadbackPath}`, import.meta.url);
const currentRunPaths = {
  management: "../runs/management-2026-09-10T08-40-27-258Z.json",
  http: "../runs/http-core-2026-09-10T08-41-40-684Z.json",
  serverMcp: "../runs/server-mcp-core-2026-09-10T08-40-47-204Z.json",
  localMcp: "../runs/desktop-mcp-core-2026-09-10T08-41-32-807Z.json",
};
const matrix = JSON.parse(await readFile(matrixUrl, "utf8"));
const coverageMatrix = JSON.parse(await readFile(coverageMatrixUrl, "utf8"));
const artifactSourceEquivalence = JSON.parse(await readFile(artifactSourceEquivalenceUrl, "utf8"));
const webCuaReadback = JSON.parse(await readFile(webCuaReadbackUrl, "utf8"));
const currentRuns = Object.fromEntries(
  await Promise.all(
    Object.entries(currentRunPaths).map(async ([name, relative]) => [
      name,
      JSON.parse(await readFile(new URL(`./${relative}`, import.meta.url), "utf8")),
    ]),
  ),
);
const sourceCommit = "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b";
const artifactCommit = "867387fe69714ae0c3aafa6182946ffd80495768";
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
const coverageCounts = {
  items: coverageMatrix.items.length,
  retiredItems: coverageMatrix.retiredItems.length,
  needsRevalidation: coverageMatrix.items.filter((item) => item.needsRevalidation === true).length,
  unavailableReviewedEvidence:
    coverageMatrix.evidenceMapping?.unavailableReviewedEvidence?.length ?? 0,
};
assert.equal(
  coverageMatrix.summary.itemCount,
  coverageCounts.items,
  "coverage summary item count must match the current matrix",
);
assert.equal(artifactSourceEquivalence.passed, true);
assert.equal(artifactSourceEquivalence.artifactCommit, artifactCommit);
assert.equal(artifactSourceEquivalence.productCommit, sourceCommit);
assert.equal(artifactSourceEquivalence.currentRelevantSourceDirty, false);
assert.deepEqual(
  artifactSourceEquivalence.comparisons.map((item) => item.path),
  ["apps/web", "apps/desktop", "packages/upload-contract"],
);
assert.ok(
  artifactSourceEquivalence.comparisons.every(
    (item) =>
      item.treeEqual === true &&
      item.artifactTree === item.productTree &&
      item.changedFiles.length === 0,
  ),
  "retained client source trees must be exactly equal",
);
assert.equal(webCuaReadback.passed, true);
assert.equal(webCuaReadback.source.productSourceCommit, sourceCommit);
assert.equal(webCuaReadback.source.productSourceDirty, false);
assert.equal(webCuaReadback.credentialsPersisted, false);
assert.equal(webCuaReadback.readback.matchingCommentCount, 1);
for (const [name, report] of Object.entries(currentRuns)) {
  assert.equal(report.passed, true, `${name} current isolated run must pass`);
  assert.equal(
    report.instanceId,
    "qa-hub-preview-v21-e2e-fresh-0910",
    `${name} must use the isolated v2.1 instance`,
  );
}

matrix.recordedAt = new Date().toISOString();
matrix.overallStatus = "not_complete";
matrix.completionAllowed = false;
matrix.agentScopeStatus = "complete_user_acceptance_pending";
matrix.userAcceptanceStatus = "delegated_pending";
matrix.productSourceCommit = sourceCommit;
matrix.statusVocabulary.user_handoff = userLabel;
matrix.sourceProvenance = {
  api: sourceCommit,
  android: sourceCommit,
  windows: artifactCommit,
  web: artifactCommit,
  equivalentGitTrees: artifactSourceEquivalence.comparisons.map((item) => ({
    path: item.path,
    artifactTree: item.artifactTree,
    productTree: item.productTree,
    treeEqual: item.treeEqual,
  })),
  note: `Windows and Web trial artifacts retain artifact commit ${artifactCommit}; the apps/web, apps/desktop, and packages/upload-contract Git trees are exactly equal at final product source commit ${sourceCommit}. This proves source equivalence only and does not replace install, signature, browser, update, or user-delegated real packaging acceptance.`,
  evidence: ["continuation-20260910/artifact-source-equivalence.json"],
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

const projectAndUniqueGm = requireCase("project-and-unique-gm");
addEvidence(projectAndUniqueGm, webCuaReadbackPath, currentRunPaths.management);

const simpleNameLogin = requireCase("simple-name-login");
addEvidence(simpleNameLogin, webCuaReadbackPath, currentRunPaths.management);

const employeeManagement = requireCase("employee-membership-and-internal-management");
addEvidence(employeeManagement, currentRunPaths.management);

const bugCore = requireCase("bug-core-crud-comments-attachments");
addEvidence(
  bugCore,
  "live-http-e2e.json",
  webCuaReadbackPath,
  currentRunPaths.http,
  currentRunPaths.serverMcp,
);

const http = requireCase("http-api-schema20-business");
http.status = "pass";
http.detail =
  "The restarted commit-88a6d0f API completed upload lost-ack reconciliation, metadata unbound/reserved/claimed transitions, exact notification replay, authorization/CAS negatives, and retained the read receipt in SQLite.";
addEvidence(
  http,
  "api-runtime-restart/restart-verification.json",
  "live-http-e2e.json",
  "live-http-db-receipt.json",
  currentRunPaths.management,
  currentRunPaths.http,
);

const serverMcp = requireCase("server-mcp-96-tools-business");
serverMcp.status = "pass";
addEvidence(serverMcp, "post-restart-mcp-check.json", currentRunPaths.serverMcp);

const windowsMcp = requireCase("windows-built-in-update-and-local-mcp");
addEvidence(windowsMcp, "post-restart-mcp-check.json", currentRunPaths.localMcp);

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
    currentRunPaths.http,
    currentRunPaths.serverMcp,
    currentRunPaths.localMcp,
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

matrix.agentBlocking = [];
matrix.coverageAudit = {
  status: "retained_open_inventory",
  detail: `The generated ${coverageCounts.items.toLocaleString("en-US")}-item audit inventory retains ${coverageCounts.needsRevalidation.toLocaleString("en-US")} source-revalidation flags. They are not rewritten as PASS and do not by themselves represent ${coverageCounts.needsRevalidation.toLocaleString("en-US")} distinct user-feature failures. A concrete applicable failure remains blocking when found.`,
  evidence: ["../coverage-matrix.json", "../coverage-matrix.md"],
};
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
  ...coverageCounts,
  note: "Fine-grained not_run and needsRevalidation rows remain retained and are not counted as PASS. The scalar revalidation count includes generated and historical source-drift inventory; it is not treated as a list of distinct failed user features.",
};

const markdownLines = (await readFile(markdownUrl, "utf8"))
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("保留客户端源码等价："));
const replaceMarkdownLine = (prefix, value) => {
  const indexes = markdownLines
    .map((line, index) => (line.startsWith(prefix) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(indexes.length, 1, `expected one Markdown line for ${prefix}`);
  markdownLines[indexes[0]] = value;
  return indexes[0];
};
const provenanceLine = replaceMarkdownLine(
  "最终 API/Android 源码：",
  `最终 API/Android 源码：\`${sourceCommit}\`；保留的 Windows/Web 试用物仍来自 \`${artifactCommit}\`  `,
);
replaceMarkdownLine(
  "结论：",
  `结论：**代理负责的开发、隔离发布与验收已经完成；整体仍为 NOT COMPLETE。** 六项真实外部/物理设备验收已按用户指令移交，代理未执行、未记作 PASS；等待用户自测结果，不再因自动展开的覆盖标记无限续转。`,
);
markdownLines.splice(
  provenanceLine + 1,
  0,
  `保留客户端源码等价：\`apps/web\`、\`apps/desktop\`、\`packages/upload-contract\` 在 artifact commit \`${artifactCommit}\` 与最终产品源码 commit \`${sourceCommit}\` 的 Git tree ID 分别完全相同；这项证据只证明源码等价。见 [\`continuation-20260910/artifact-source-equivalence.json\`](continuation-20260910/artifact-source-equivalence.json)。  `,
);
replaceMarkdownLine(
  "| 项目一级与唯一 GM |",
  `| 项目一级与唯一 GM | Web + HTTP | PASS | GM 创建隔离项目；普通姓名登录只见所属项目；GM 项目管理与普通项目会话隔离。当前隔离 Web 又由非 GM 用户从项目入口进入 \`${webCuaReadback.browserObservation.projectId}\`，API 项目目录只回读该项目。见 [\`web/core-e2e-report.md\`](web/core-e2e-report.md) 与 [\`${webCuaReadbackPath}\`](${webCuaReadbackPath})。 |`,
);
replaceMarkdownLine(
  "| 简单姓名登录 |",
  `| 简单姓名登录 | Web + HTTP | PASS | \`Luna UI User\` 首次登录成功；成员停用后立即拒绝，再恢复后可登录并看到原 Bug。当前隔离 Web 又以 \`${webCuaReadback.browserObservation.actorName}\` 通过可见入口完成姓名登录并由 API 回读同一项目身份。见 [\`web/core-e2e-report.md\`](web/core-e2e-report.md) 与 [\`${webCuaReadbackPath}\`](${webCuaReadbackPath})。 |`,
);
replaceMarkdownLine(
  "| Bug 基础模块 |",
  `| Bug 基础模块 | Web + HTTP + server MCP | PASS | 新建、列表、详情、编辑、评论、附件 init/chunk/finalize/bind/download、错误项目拒绝均通过；68 字节附件下载逐字节一致。当前隔离 Web 可见入口另完成 Bug 新建、指派、编辑和评论，API 回读 \`${webCuaReadback.readback.bug.key}\` version \`${webCuaReadback.readback.bug.version}\` 及唯一评论。见 [\`web/attachment-e2e.json\`](web/attachment-e2e.json)、[\`web/comment-readback.json\`](web/comment-readback.json) 与 [\`${webCuaReadbackPath}\`](${webCuaReadbackPath})。 |`,
);
replaceMarkdownLine(
  "代理侧的细粒度覆盖矩阵已按最终源码重新生成：",
  `代理侧的细粒度覆盖矩阵已按最终源码重新生成：${coverageCounts.items.toLocaleString("en-US")} 项、${coverageCounts.retiredItems.toLocaleString("en-US")} 个退休项、${coverageCounts.needsRevalidation.toLocaleString("en-US")} 项带源码复验标记，详见 [\`../coverage-matrix.md\`](../coverage-matrix.md)。这些行继续保留且未被改成 PASS；该单一计数包含自动展开节点和历史源码漂移，不等于 ${coverageCounts.needsRevalidation.toLocaleString("en-US")} 个独立用户功能失败，也不替代上表的真实功能验收结论。`,
);
await writeFile(matrixUrl, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
await writeFile(markdownUrl, `${markdownLines.join("\n").trimEnd()}\n`, "utf8");

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
