import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = path.join(root, "docs/evidence/project-components");
const matrixPath = path.join(evidenceRoot, "coverage-matrix.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const incomingResults = new Map(
  matrix.items.map((item) => [item.id, structuredClone(item.results)]),
);
const proofHashes = {};
const proofBytes = (relative) => {
  const body = fs.readFileSync(path.resolve(evidenceRoot, relative));
  proofHashes[relative] = createHash("sha256").update(body).digest("hex");
  return body;
};
const proofText = (relative) => proofBytes(relative).toString("utf8");
const correctedEvidence = new Map();
const read = (relative) =>
  JSON.parse(proofText(correctedEvidence.get(relative) ?? relative).replace(/^\uFEFF/u, ""));
const optionalRead = (relative) =>
  fs.existsSync(path.resolve(evidenceRoot, relative)) ? read(relative) : null;
// The reviewed public index binds old proofs to derivatives of verified originals.
// Never access its private-original paths or infer a version from old redacted text.
const correctionIndexPath = "redaction-corrections/index.json";
const correctionIndex = optionalRead(correctionIndexPath);
if (correctionIndex) {
  if (
    proofHashes[correctionIndexPath] !==
      "b7f7c147da5a718ef9a9312293b81b6acb716e16a0ba823127823a9969f15491" ||
    correctionIndex.businessRunsRepeated !== false ||
    correctionIndex.oldPublicProofsOverwritten !== false
  )
    throw new Error("Corrected evidence index changed; re-review required");
  const publicPrefix = "docs/evidence/project-components/";
  for (const entry of correctionIndex.items) {
    const relative = (file) => {
      if (!file.startsWith(publicPrefix) || file.includes(".."))
        throw new Error("Correction path must remain in public evidence");
      return file.slice(publicPrefix.length);
    };
    const old = relative(entry.oldPublicPath);
    const corrected = relative(entry.correctedPublicPath);
    proofBytes(old);
    proofBytes(corrected);
    if (
      proofHashes[old] !== entry.oldPublicSha256 ||
      proofHashes[corrected] !== entry.correctedPublicSha256
    )
      throw new Error(`Corrected evidence changed; re-review required: ${old}`);
    correctedEvidence.set(old, corrected);
  }
}
function mcpBody(check) {
  const envelope = check.result?.jsonrpc ? check.result.result : check.result;
  if (check.result?.error || envelope?.isError === true) return null;
  if (envelope?.structuredContent) return envelope.structuredContent;
  const text = envelope?.content?.find((entry) => entry.type === "text")?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return envelope;
}
const http = [],
  mcp = [];
for (const name of fs
  .readdirSync(path.join(evidenceRoot, "runs"))
  .filter((name) => /(?:http-core|management-|mcp-core).*\.json$/u.test(name))
  .sort()) {
  const report = read(`runs/${name}`);
  for (const [index, check] of (report.checks ?? []).entries()) {
    const evidence = `runs/${name}#checks[${index}]`;
    const at = check.at ?? check.recordedAt ?? report.runId ?? "";
    if (check.path && check.method && Number.isInteger(check.status))
      http.push({
        label: check.label,
        method: check.method,
        path: check.path.split("?")[0],
        passed:
          typeof check.passed === "boolean"
            ? check.passed
            : check.status === (check.expectedStatus ?? 200),
        status: check.status,
        expectedStatus: check.expectedStatus ?? 200,
        evidence,
        at,
      });
    if (report.passed === true && check.tool && check.httpStatus === 200 && mcpBody(check))
      mcp.push({
        tool: check.tool,
        surface: name.startsWith("desktop-") ? "local_mcp" : "server_mcp",
        evidence,
        at,
        action: mcpBody(check)?.action,
        bug: mcpBody(check)?.bug,
      });
  }
}
const automaticResultNote =
  "Status describes the explicitly recorded cases. Other guards and complete cross-surface baselines remain independently required.";
function retainReviewNote(item, surface) {
  const prior = item.results[surface];
  // Do not archive this mapper's own intermediate output again on every replay.
  // Existing history remains intact; human/legacy notes are retained before replacement.
  if (
    !prior?.note ||
    prior.note === automaticResultNote ||
    prior.note === "Real execution and read-back required." ||
    prior.note ===
      "This entry inventories a different surface; requirement-level coverage is tracked separately. Not an accepted scope exclusion."
  )
    return;
  const retained = structuredClone({
    surface,
    status: prior.status,
    note: prior.note,
    actual: prior.actual,
    evidence: prior.evidence,
    progress: item.manual.surfaceProgress?.[surface] ?? null,
  });
  item.manual.retainedReviewNotes ??= [];
  if (
    !item.manual.retainedReviewNotes.some(
      (entry) => JSON.stringify(entry) === JSON.stringify(retained),
    )
  )
    item.manual.retainedReviewNotes.push(retained);
}
function record(item, surface, status, evidence, actual) {
  if (!item?.results[surface]?.applicable || item.results[surface].status === "failed") return;
  // Title-based legacy observations cannot certify a new or changed UI node.
  // The generator retains exact node/file/old-source results for review. Existing
  // historical passes and their revalidation flags are not erased by this gate.
  if (
    status === "passed" &&
    /^(?:web_control|android_control|web_page_component|android_page_component|desktop_event|desktop_ipc_action|desktop_menu_action)$/u.test(
      item.kind,
    ) &&
    (item.needsRevalidation || item.manual.needsRevalidation)
  )
    return;
  const mappedEvidence = [
    ...new Set(
      evidence.flatMap((reference) => {
        const [file, fragment] = reference.split("#", 2);
        const corrected = correctedEvidence.get(file);
        return corrected
          ? [reference, corrected + (fragment === undefined ? "" : "#" + fragment)]
          : [reference];
      }),
    ),
  ];
  const prior = item.results[surface];
  if (
    prior.status === status &&
    prior.actual === actual &&
    JSON.stringify(prior.evidence) === JSON.stringify(mappedEvidence)
  )
    return;
  retainReviewNote(item, surface);
  if (status === "passed" && item.manual.surfaceProgress)
    delete item.manual.surfaceProgress[surface];
  Object.assign(item.results[surface], {
    status,
    evidence: mappedEvidence,
    actual,
    note: automaticResultNote,
  });
  const statuses = Object.values(item.results)
    .filter((result) => result.applicable)
    .map((result) => result.status);
  item.status = statuses.includes("failed")
    ? "failed"
    : statuses.every((value) => value === "passed")
      ? "passed"
      : "not_run";
  item.manual.evidenceMappedAt = new Date().toISOString();
}
function progress(item, surface, evidence, completed, remaining) {
  if (!item?.results[surface]?.applicable || item.results[surface].status === "failed") return;
  record(
    item,
    surface,
    "not_run",
    evidence,
    `已实测：${completed.join("；")}。仍缺：${remaining.join("；")}。`,
  );
  item.manual.surfaceProgress ??= {};
  item.manual.surfaceProgress[surface] = { completed, remaining, evidence, status: "partial" };
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
for (const item of matrix.items) {
  if (item.kind === "http_route") {
    const expression = new RegExp(
      "^" +
        item.path
          .split("/")
          .map((part) => (part.startsWith(":") ? "[^/]+" : escape(part)))
          .join("/") +
        "$",
    );
    const latest = new Map();
    for (const observation of http
      .filter((check) => check.method === item.method && expression.test(check.path))
      .sort((a, b) => a.at.localeCompare(b.at)))
      latest.set(observation.label, observation);
    const observations = [...latest.values()];
    if (observations.length)
      record(
        item,
        "http",
        observations.every((check) => check.passed) ? "passed" : "failed",
        observations.map((check) => check.evidence),
        observations
          .map((check) => `${check.label}: HTTP ${check.status} (expected ${check.expectedStatus})`)
          .join("; "),
      );
  }
  if (item.kind === "mcp_tool")
    for (const surface of ["server_mcp", "local_mcp"]) {
      const observations = mcp.filter(
        (check) => check.surface === surface && check.tool === item.toolName,
      );
      if (observations.length)
        record(
          item,
          surface,
          "passed",
          observations.map((check) => check.evidence),
          "Real MCP calls completed and their returned records were retained in the referenced successful run. This does not cover every action/negative input of a generic tool.",
        );
    }
}
const web = read("web-browser/results.json");
const dual = read("web-browser/dual-window-results.json");
const gmBrowser = read("web-browser/gm-results.json");
for (const item of matrix.items.filter((item) => item.kind === "web_control")) {
  if (
    gmBrowser.status === "passed" &&
    item.source?.file === "apps/web/src/ProjectManagementPage.tsx" &&
    !/进入此项目|修改名称/u.test(item.title)
  )
    record(
      item,
      "web",
      "passed",
      ["web-browser/gm-results.json", "web-browser/gm-http-readback.json"],
      "Actual GM UI operated this reusable control for project create/select, build toggle/configuration, member add/disable/restore or project disable/restore as named. Build form was exercised; other component field variants and version-conflict cases remain untested.",
    );
  if (
    item.source?.file === "apps/web/src/App.tsx" &&
    /openCreateBug|setNewContent|completeWork\(\)|acceptBug\(\)|onProjectChange\?/u.test(item.title)
  ) {
    record(
      item,
      "web",
      "passed",
      ["web-browser/results.json", "web-browser/dual-window-results.json"],
      "Referenced real browser run operated this control: project selection, Bug draft creation, manual completion or human acceptance as named by this row. EXE operation and unlisted edge cases are not implied.",
    );
  }
  if (item.source?.file === "apps/web/src/LocalDraftRecovery.tsx" && dual.status === "passed") {
    record(
      item,
      "web",
      "passed",
      ["web-browser/dual-window-results.json", "web-browser/dual-04-exported-draft.json"],
      "A access revocation exposed the recovery controls; actual text and JPEG export produced local files with verified contents and matching image hash.",
    );
  }
}
for (const item of matrix.items.filter((item) => item.kind === "web_control"))
  if (
    gmBrowser.status === "passed" &&
    item.source?.file === "apps/web/src/App.tsx" &&
    /组件历史/u.test(item.title)
  )
    record(
      item,
      "web",
      "passed",
      ["web-browser/gm-results.json", "web-browser/gm-09-disabled-history.json"],
      "All five components disabled; actual navigation rendered local empty history for build/upload/chain/Relay/Qingyu. Populated external task actions remain not_run.",
    );
const attachmentProof = read("web-browser/http-readback.json");
if (attachmentProof.results.some((result) => result.binary?.matchesLocal)) {
  for (const item of matrix.items.filter(
    (item) =>
      item.kind === "http_route" &&
      item.method === "GET" &&
      [
        "/api/v1/attachments/:attachmentId",
        "/api/v1/bugs/:bugId/attachments",
        "/api/v1/bugs/:bugId/comments",
      ].includes(item.path),
  )) {
    record(
      item,
      "http",
      "passed",
      ["web-browser/http-readback.json", "web-browser/results.json"],
      "UI 创建的项目内附件与评论经独立 HTTP 读回；JPEG 下载 43311 字节，SHA-256 与本地原文件相同。这里没有将未测跨项目拒绝场景记作通过。",
    );
  }
}
function baseline(number, surface, status, evidence, actual) {
  const item = matrix.items.find(
    (item) => item.kind === "baseline" && item.baselineIds[0] === number,
  );
  record(item, surface, status, evidence, actual);
}
for (const [number, id] of [
  [1, "project_entry"],
  [2, "multi_project"],
  [9, "base_lifecycle"],
]) {
  const check = web.checks.find((check) => check.id === id);
  if (check?.status === "passed")
    baseline(
      number,
      "web",
      "passed",
      ["web-browser/results.json", `web-browser/${check.evidence}`],
      check.detail,
    );
}
if (dual.status === "passed")
  baseline(
    8,
    "web",
    "passed",
    ["web-browser/dual-window-results.json", "web-browser/dual-window-fixture.json"],
    "同一真实浏览器两个标签分别保持 A/B；A 撤权后 A 草稿可导出并在恢复后重新载入，B 仍创建正确项目 Bug。独立浏览器 profile 和跨设备并发未在此条结果中声称。",
  );
baseline(
  7,
  "web",
  "not_run",
  ["web-browser/results.json", "web-browser/dual-window-results.json"],
  "真实切换、File 草稿持久化与双标签已通过；刻意延迟网络响应仍只有单元回归，尚未完成该基线全部场景。",
);
const latestManagement = fs
  .readdirSync(path.join(evidenceRoot, "runs"))
  .filter((name) => /^management-.*\.json$/u.test(name))
  .sort()
  .at(-1);
if (latestManagement) {
  const report = read(`runs/${latestManagement}`);
  const all = (fragment) =>
    report.checks.filter((check) => fragment.test(check.label)).every((check) => check.passed);
  for (const [number, pattern, actual] of [
    [
      4,
      /disable.*A|disabled.*login|reviv|resurrect|shared employee|restore.*member|other project|only.*A/iu,
      "HTTP 实际验证项目 A 成员停用与版本恢复；B 保持可用，同名登录不能恢复显式停用成员。",
    ],
    [
      10,
      /link|unlink|alias|membership|member|personnel|users/iu,
      "HTTP 实际列出项目人员、关联与解除身份、成员停用恢复；GM 非成员目录由最新完整管理运行独立核对。",
    ],
  ])
    if (report.passed && all(pattern))
      baseline(number, "http", "passed", [`runs/${latestManagement}`], actual);
  if (report.passed)
    baseline(
      3,
      "http",
      "passed",
      [`runs/${latestManagement}`],
      "独立 GM 口令、唯一 UUID、普通姓名 gm 无特权、管理多个项目，以及没有普通 membership 的 GM 创建编辑和完整人工闭环均已实际通过。",
    );
}
// Calibrated real evidence. Each observation belongs only to the surface that
// actually performed it; shared implementation does not imply another UI pass.
const baselineItem = (number) =>
  matrix.items.find((item) => item.kind === "baseline" && item.baselineIds[0] === number);
const partialBaseline = (number, surface, evidence, completed, remaining) =>
  progress(baselineItem(number), surface, evidence, completed, remaining);
const androidRoot = "../../../apps/android/app/build/evidence/project-components/";
const androidProof = (name) => androidRoot + name;
const closedAndroid = optionalRead(androidProof("bug-closed-readback.json"));
const androidCapture = optionalRead(androidProof("preview-code17-capture-bug-readback.json"));
const androidDownload = optionalRead(
  androidProof("preview-code17-capture-isolation-readback.json"),
);
const androidPeople = optionalRead(androidProof("preview-code19-personnel-final-readback.json"));
const androidLinked = optionalRead(androidProof("preview-code19-linked-readback.json"));
const androidCoexist = optionalRead(androidProof("coexistence-code20-final.json"));
const android21 = optionalRead(androidProof("coexistence-code21-final.json"));
const android21Before = optionalRead(androidProof("preview-code21-upgrade-before.json"));
const androidEvidence = ["android-implementation.md", androidProof("bug-closed-readback.json")];
const androidClosed =
  closedAndroid?.bug?.state === "closed" &&
  closedAndroid.bug.version === 11 &&
  closedAndroid.comments?.items?.length === 1 &&
  closedAndroid.events?.items?.some((event) => event.toState === "closed") &&
  closedAndroid.events?.items?.some(
    (event) => event.fromState === "ready_for_verification" && event.toState === "ready",
  );
function controls(ids, surface, evidence, actual) {
  for (const id of ids) {
    const item = matrix.items.find((row) => row.id === id);
    if (item) record(item, surface, "passed", evidence, actual);
  }
}
if (androidClosed) {
  baseline(
    9,
    "apk",
    "passed",
    androidEvidence,
    "真实 MuMu 原生界面提交、评论、人工完成、验收失败退回、再次人工完成、验收关闭；Bug e81a7e88-0f51-45ec-bdcb-187b6989aebc closed/v11，16事件、2轮人工修复、1评论，五组件全关。仅此基础流程；物理设备及其余操作另列未测。",
  );
  controls(
    [
      "android_control-f245715f5bce13",
      "android_control-1cd07b980530f5",
      "android_control-566e867254438e",
      "android_control-c74ab742733321",
      "android_control-f95af8f236e1e1",
      "android_control-91bbcb812458c5",
      "android_control-44808d673345f3",
      "android_control-eea6a336c81800",
      "android_control-9543924f2eacef",
      "android_control-3eacdab8beec11",
    ],
    "apk",
    androidEvidence,
    "此原生控件在实际模拟器姓名登录/新建内容与提交/Bug详情/评论/人工完成/验收退回或关闭过程中操作；HTTP读回 closed/v11 与事件。未把旁边未操作的开始修复、代码交付、编辑、删除或其它入口记通过。",
  );
  for (const item of matrix.items.filter((row) => row.kind === "state_transition_pair")) {
    const events = closedAndroid.events.items.filter(
      (event) =>
        event.fromState && event.toState && item.title === event.fromState + " → " + event.toState,
    );
    if (events.length)
      progress(
        item,
        "apk",
        androidEvidence,
        [
          "实际原生流程事件出现 " +
            item.title +
            "，事件类型 " +
            [...new Set(events.map((event) => event.type))].join(", "),
        ],
        ["该状态对的其余合法动作、错误输入及全部 guard 尚未逐项覆盖"],
      );
  }
}
const peopleEvidence = [
  "android-implementation.md",
  androidProof("preview-code19-linked-readback.json"),
  androidProof("preview-code19-personnel-final-readback.json"),
];
if (
  androidPeople?.people?.some(
    (person) => person.membershipVersion === 5 && person.membershipStatus === "active",
  ) &&
  androidLinked
) {
  baseline(
    10,
    "apk",
    "passed",
    peopleEvidence,
    "MuMu code19 实际查看当前项目人员、关联/解除姓名、停用/恢复；读回 Managed active/v5、Alias active/v1、无剩余关联；禁用登录403，恢复200且人员ID不变。仅这些原生人员操作，物理设备另列。",
  );
  controls(
    [
      "android_control-b59c61834138b5",
      "android_control-fe522d49d6f527",
      "android_control-f61cb33189fbb0",
      "android_control-43fecc575c56b9",
      "android_control-cad4fd5917bd51",
      "android_control-331c1002d7728f",
    ],
    "apk",
    peopleEvidence,
    "原生项目人员页面真实打开、选择关联对象、确认关联、解除、停用/恢复，随后服务端读回；只覆盖所列控件的实际正常场景。",
  );
  partialBaseline(
    4,
    "apk",
    peopleEvidence,
    ["A 内原生停用/恢复及HTTP同名登录403/200已核对"],
    ["未在这次原生人员操作中验证同一人的 B 项目继续可用", "物理设备未测"],
  );
}
if (androidCoexist) {
  partialBaseline(
    22,
    "apk",
    [
      "android-implementation.md",
      androidProof("coexistence-code20-final.json"),
      androidProof("preview-code16-a-draft-restored-ui.xml"),
      androidProof("preview-code17-b-draft-restored-ui.xml"),
      androidProof("preview-code20-launched-ui.xml"),
    ],
    [
      "MuMu 新旧 applicationId 共存",
      "预览15→20实际ADB升级，文字草稿/身份及已有截图证据保留",
      "日常code14/PID5051/安装时点不变",
    ],
    ["物理Android设备必测仍缺", "应用内更新源/自安装链路未测"],
  );
  for (const number of [1, 2])
    partialBaseline(
      number,
      "apk",
      ["android-implementation.md", androidProof("preview-code20-launched-ui.xml")],
      ["实际项目A姓名登录、进入B、回A，code20恢复同一身份与A列表"],
      ["尚未逐一核对该基线完整首登/原历史姓名/有效成员目录组合", "物理Android设备未测"],
    );
  partialBaseline(
    7,
    "apk",
    [
      "android-implementation.md",
      androidProof("preview-code16-b-empty-draft-ui.xml"),
      androidProof("preview-code16-return-a-draft-confirmed-ui.xml"),
    ],
    ["A/B文字与截图草稿实际分离，返回原项目恢复"],
    ["未刻意制造迟到网络响应", "未覆盖全部编辑/组件/文件草稿与人员选择"],
  );
  controls(
    ["android_control-d535103c14e2f7", "android_control-053937cef0ed1d"],
    "apk",
    ["android-implementation.md", androidProof("preview-code16-return-a-draft-confirmed-ui.xml")],
    "原生项目菜单实际从B返回A，恢复A草稿；不把网络延迟和跨设备并发算作通过。",
  );
}

if (
  android21?.previewCode === 21 &&
  android21.physicalDevice === "not_run" &&
  [
    android21Before?.draftSha256,
    android21Before?.captureSidecarSha256,
    android21Before?.capturePngSha256,
  ].every((hash) => hash && android21.retainedFiles?.some((line) => line.startsWith(hash + " ")))
) {
  const evidence = [
    "android-implementation.md",
    androidProof("preview-code21-upgrade-before.json"),
    androidProof("coexistence-code21-final.json"),
    androidProof("preview-code21-draft-restored-ui.xml"),
  ];
  partialBaseline(
    22,
    "apk",
    evidence,
    [
      "MuMu预览15→21实际共存/ADB升级；20→21的文字/未提交PNG/sidecar三hash逐一相同",
      "日常code14/PID5051/安装时点/dataDir保留",
    ],
    ["物理Android设备必测仍缺", "应用内更新源/自安装链路未测"],
  );
  partialBaseline(
    7,
    "apk",
    [...evidence, androidProof("preview-code16-return-a-draft-confirmed-ui.xml")],
    ["A/B文字与图片草稿实际分离", "20→21升级恢复原项目/身份/文字/未提交PNG且三个本地hash一致"],
    ["未刻意制造迟到网络响应", "未覆盖全部编辑/组件/文件草稿与人员选择"],
  );
  const historyEvidence = [
    "android-implementation.md",
    androidProof("coexistence-code21-final.json"),
    androidProof("preview-code21-relay-local-ui.xml"),
    androidProof("preview-code21-relay-outbox-ui.xml"),
    androidProof("preview-code21-relay-disabled-remote-ui.xml"),
  ];
  for (const number of [18, 19])
    partialBaseline(
      number,
      "apk",
      historyEvidence,
      ["code21原生本地批次/交接/禁用远端三个tab可达；全关时本地空列表读回，远端无执行按钮"],
      ["有数据的暂停恢复/批次重试/merge原生点击未测", "真实独立Relay任务及回调/外部执行未测"],
    );
  const tabControl = matrix.items.find((item) => item.id === "android_control-70701562363164");
  progress(
    tabControl,
    "apk",
    historyEvidence,
    ["三个tab真实切换并读到禁用状态下本地空列表"],
    ["非空历史及组件ready时远端列表/动作尚未操作"],
  );
}
const serverResourcePath = "runs/server-mcp-real-resource-20260909.json";
const serverResource = optionalRead(serverResourcePath);
const localResourcePath = "runs/desktop-mcp-resource-preview4.json";
const localResource = optionalRead(localResourcePath);
const androidAttachment = androidCapture?.attachments?.items?.[0];
const resourceHash = serverResource?.checks?.find(
  (check) => check.check === "real-android-screenshot-resource",
);
const sameAttachment =
  serverResource?.passed === true &&
  localResource?.passed === true &&
  androidDownload?.projectADownloadStatus === 200 &&
  androidDownload.projectBStatus === 404 &&
  androidAttachment?.sha256 &&
  androidAttachment.sha256 === androidDownload.downloadSha256 &&
  androidAttachment.sha256 === resourceHash?.sha256 &&
  androidAttachment.sha256 === localResource.materialized?.sha256 &&
  androidAttachment.sha256 === localResource.resource?.sha256 &&
  localResource.materialized?.attachmentId === androidAttachment.attachmentId &&
  localResource.materialized?.bugId === androidCapture.bug.id &&
  androidAttachment.size === resourceHash.size &&
  androidAttachment.size === localResource.materialized.size;
const threeReadEvidence = [
  androidProof("preview-code17-capture-bug-readback.json"),
  androidProof("preview-code17-capture-isolation-readback.json"),
  serverResourcePath,
  localResourcePath,
];
if (serverResource?.passed === true) {
  for (const [index, check] of serverResource.checks.entries()) {
    const name = check.check === "materialize" ? "qa_materialize_attachment" : check.check;
    if (!name?.startsWith("qa_") || !("result" in check)) continue;
    for (const item of matrix.items.filter(
      (row) => row.kind === "mcp_tool" && row.toolName === name,
    ))
      record(
        item,
        "server_mcp",
        "passed",
        [serverResourcePath + "#checks[" + index + "]"],
        "真实服务端MCP调用 " +
          name +
          " 已返回所存本地/资源结果。配置全关时的空历史可读，不代表执行外部任务或具备全部历史动作。",
      );
  }
}
if (sameAttachment) {
  const actual =
    "同一原生PNG：project " +
    androidCapture.bug.projectId +
    " / Bug " +
    androidCapture.bug.id +
    " / attachment " +
    androidAttachment.attachmentId +
    "，" +
    androidAttachment.size +
    "字节，HTTP下载、服务端resources/read与EXE本地materialize/resources/read SHA-256均为 " +
    androidAttachment.sha256 +
    "。HTTP错误项目404；不推定其它MCP负向场景已过。";
  for (const surface of ["http", "server_mcp", "local_mcp"])
    baseline(15, surface, "passed", threeReadEvidence, actual);
  for (const item of matrix.items.filter(
    (row) => row.kind === "mcp_tool" && row.toolName === "qa_materialize_attachment",
  ))
    for (const surface of ["server_mcp", "local_mcp"])
      record(item, surface, "passed", threeReadEvidence, actual);
  for (const item of matrix.items.filter(
    (row) => row.kind === "required_mcp_parity" && row.title === "qa_materialize_attachment",
  ))
    for (const surface of ["server_mcp", "local_mcp"])
      record(
        item,
        surface,
        "passed",
        threeReadEvidence,
        actual + " 两端分别返回远端资源与本地文件，所对应HTTP字节已独立核对。",
      );
  for (const item of matrix.items.filter(
    (row) =>
      row.kind === "http_route" &&
      row.method === "GET" &&
      ["/api/v1/attachments/:attachmentId", "/api/v1/bugs/:bugId/attachments"].includes(row.path),
  ))
    record(item, "http", "passed", threeReadEvidence, actual);
  partialBaseline(
    15,
    "apk",
    threeReadEvidence,
    ["真实MediaProjection PNG在APK提交绑定", "同一图片三个读取入口hash一致"],
    ["APK物理设备和更多文件/游戏截图场景未测；MCP调用属于各自MCP入口，未记作APK调用"],
  );
  controls(
    ["android_control-96d3277020ee9e"],
    "apk",
    ["android-implementation.md", androidProof("preview-code18-direct-projection-dialog-ui.xml")],
    "code18 新建Bug截图入口实际打开系统MediaProjection授权；后续取消了该次权限请求，没有假称又完成截图。",
  );
}

const coreReports = fs
  .readdirSync(path.join(evidenceRoot, "runs"))
  .filter((name) => /^(?:server-|desktop-)?mcp-core-.*\.json$/u.test(name))
  .sort();
for (const surface of ["server_mcp", "local_mcp"]) {
  const eligible = coreReports
    .filter((name) => (surface === "local_mcp") === name.startsWith("desktop-"))
    .map((name) => ({ name, report: read("runs/" + name) }))
    .filter(({ report }) => report.passed === true);
  const candidate = eligible
    .filter(({ report }) => {
      const bodies = report.checks.map(mcpBody).filter(Boolean);
      return (
        report.checks.some(
          (check) => check.tool === "qa_create_bug" && mcpBody(check)?.bug?.state === "reported",
        ) &&
        bodies.some((body) => body.action === "manual_complete") &&
        bodies.some((body) => body.action === "close" && body.bug?.state === "closed") &&
        mcpBody(report.checks.at(-1))?.bug?.state === "closed"
      );
    })
    .at(-1);
  if (!candidate) continue;
  const evidence = "runs/" + candidate.name;
  const final = mcpBody(candidate.report.checks.at(-1));
  baseline(
    9,
    surface,
    "passed",
    [evidence, serverResourcePath],
    "此MCP入口真实姓名登录、创建、评论/读回、人工完成、创建/开始验收、关闭并取回 " +
      final.bug.key +
      " closed/v" +
      final.bug.version +
      "；项目五组件关闭。未映射到EXE/Web/Android UI，编辑/删除/退回等未在该核心脚本覆盖。",
  );
  partialBaseline(
    1,
    surface,
    [evidence],
    ["实际项目姓名登录与项目目录、后续操作人读回"],
    ["完整首次成员登记/已有姓名稳定ID/多项目组合未逐项覆盖"],
  );
  partialBaseline(
    2,
    surface,
    [evidence],
    ["实际列出当前员工所属项目"],
    ["单项目/多项目/撤销关系的完整目录组合未在该MCP入口覆盖"],
  );
  for (const item of matrix.items.filter((row) => row.kind === "required_mcp_parity")) {
    const calls = candidate.report.checks.filter((check) => check.tool === item.title);
    if (calls.length && item.title !== "qa_materialize_attachment")
      progress(
        item,
        surface,
        [evidence],
        ["该实际MCP工具已有调用与项目/人员/状态读回"],
        ["同输入的HTTP/MCP版本、操作人、幂等及错误对等比较尚未完整执行"],
      );
  }
}
if (latestManagement) {
  const report = read("runs/" + latestManagement);
  const evidence = ["runs/" + latestManagement];
  if (report.passed) {
    baseline(
      1,
      "http",
      "passed",
      evidence,
      "实际首登仅A，原姓名跨A/B保持相同稳定userId；短码解析稳定项目，撤销关系不会被同名登录复活。",
    );
    baseline(
      2,
      "http",
      "passed",
      evidence,
      "实际单项目员工只见A；同人A/B登记及撤销/恢复后目录和跨项目权限读回，非所属B列表/人员拒绝。",
    );
    if (
      report.checks.some(
        (check) => check.label === "GM non-member complete manual loop closes" && check.passed,
      )
    )
      baseline(
        9,
        "http",
        "passed",
        evidence,
        "实际GM非成员以HTTP创建/修改/评论/人工完成/退回/再次完成/验收关闭MA1788890000532-1，closed/v12；五组件关闭，外部见证器0请求。",
      );
    partialBaseline(
      16,
      "http",
      evidence,
      ["A配置开关不影响B", "依赖级联关闭", "普通员工禁止组件配置"],
      ["旧HTTP/MCP和后台创建任务的全组合禁止仍只部分fixture覆盖，没有真实外部任务验证"],
    );
    partialBaseline(
      17,
      "http",
      evidence,
      ["缺配置为needs_configuration", "single依赖检查和级联关闭", "基础人工闭环可用"],
      ["所有客户端可见配置引导及实际独立外部资源尚未全面验证"],
    );
  }
}
const fault = optionalRead("runs/exe-fault-independent-api-mcp.json");
if (
  fault?.previewExeStopped &&
  fault.localMcpStopped &&
  fault.httpCorePassed &&
  fault.serverMcpCorePassed
) {
  partialBaseline(
    11,
    "http",
    ["runs/exe-fault-independent-api-mcp.json", "runs/http-core-2026-09-08T18-19-04-805Z.json"],
    ["预览EXE和4420退出时，独立HTTP实际15项含登录/创建/查询/跨项目拒绝继续成功"],
    ["该早期HTTP窗口未包含评论和状态变更；后续独立性证据另行校准，不能用MCP调用替代HTTP入口"],
  );
  partialBaseline(
    12,
    "server_mcp",
    [
      "runs/exe-fault-independent-api-mcp.json",
      "runs/server-mcp-core-2026-09-08T18-19-05-946Z.json",
    ],
    ["预览EXE/本地MCP退出时服务MCP13项仍完成真实创建、评论、人工完成和验收关闭"],
    ["该早期proof的逐请求进程边界较弱；后续独立性证据另行校准，§17完整功能与负向场景仍独立验收"],
  );
}
const beforeUpgrade = optionalRead("runs/exe-before-preview4-upgrade.json");
const afterUpgrade = optionalRead("runs/exe-after-preview4-upgrade.json");
const upgradeEvidence = [
  "runs/exe-before-preview4-upgrade.json",
  "runs/exe-after-preview4-upgrade.json",
  "runs/exe-preview4-restored-draft.txt",
  localResourcePath,
  "runs/exe-fault-independent-api-mcp.json",
  "runs/exe-preview4-after-fault-draft.txt",
];
if (
  afterUpgrade?.previewVersion === "0.2.0-preview.4" &&
  afterUpgrade.loginRestoredWithoutUserInput &&
  beforeUpgrade?.configSha256?.toLowerCase() === afterUpgrade.configSha256?.toLowerCase() &&
  afterUpgrade.backups?.length >= 3 &&
  localResource?.passed
) {
  baseline(
    23,
    "exe",
    "passed",
    upgradeEvidence,
    "真实独立EXE .4升级与日常17160共存，配置hash不变、员工/项目/文字草稿自动恢复，旧截图历史通过.4本地MCP文件/hash读回；独立安装/更新目录和旧版备份保留。另一次异常退出重启恢复文字+1图。本条依据.4成功proof，后续版本需独立证明。",
  );
  for (const item of matrix.items.filter(
    (row) =>
      row.kind === "web_control" &&
      row.source?.file === "apps/web/src/App.tsx" &&
      /openCreateBug|setNewContent/u.test(row.title),
  ))
    record(
      item,
      "exe",
      "passed",
      upgradeEvidence,
      "真实原生EXE内打开新建Bug并填写未提交文字、添加1张实际PNG，.4升级/异常退出恢复草稿。没有由Web共享实现推定EXE提交或关闭通过。",
    );
  partialBaseline(
    7,
    "exe",
    upgradeEvidence,
    [".4升级及异常退出后的项目/姓名/文字/图片草稿恢复"],
    ["EXE内A/B快速切换和刻意延迟响应未完成"],
  );
  partialBaseline(
    24,
    "exe",
    upgradeEvidence,
    ["预览EXE异常停止与恢复，草稿保留且生产健康", "旧安装备份保留"],
    ["未执行独立客户端手工版本回退及回退前新增全部数据/任务核对"],
  );
}
const afterUpgrade5 = optionalRead("runs/exe-after-preview5-upgrade.json");
if (
  afterUpgrade5?.passed &&
  afterUpgrade5.version === "0.2.0-preview.5" &&
  afterUpgrade5.result?.status === "installed" &&
  afterUpgrade5.draft?.imageCount === 1 &&
  afterUpgrade5.configSha256?.toLowerCase() === beforeUpgrade?.configSha256?.toLowerCase() &&
  baselineItem(23).results.exe.status === "passed"
) {
  baseline(
    23,
    "exe",
    "passed",
    [
      ...upgradeEvidence,
      "runs/exe-after-preview5-upgrade.json",
      "runs/exe-preview5-restored-draft.txt",
    ],
    "真实独立EXE .4→.5升级成功（installed receipt），与日常17160共存，配置hash不变、同一员工/项目/文字+1图草稿恢复；历史截图通过.4本地MCP文件/hash读回，更新目录隔离且四份旧版备份保留。.4异常退出恢复亦已实际验证；后续版本需独立证明。",
  );
}
const exeClosed = optionalRead("runs/exe-ui-bug-closed-readback.json");
const afterUpgrade6 = optionalRead("runs/exe-after-preview6-upgrade.json");
if (
  afterUpgrade6?.passed &&
  afterUpgrade6.version === "0.2.0-preview.6" &&
  afterUpgrade6.result?.status === "installed" &&
  afterUpgrade6.draft?.imageCount === 1 &&
  afterUpgrade6.configSha256?.toLowerCase() === afterUpgrade5?.configSha256?.toLowerCase() &&
  afterUpgrade6.identity?.userId === afterUpgrade5.identity?.userId &&
  afterUpgrade6.identity?.projectId === afterUpgrade5.identity?.projectId &&
  afterUpgrade6.backups?.length === 5 &&
  afterUpgrade6.retained?.length > 0
) {
  baseline(
    23,
    "exe",
    "passed",
    [
      ...baselineItem(23).results.exe.evidence,
      "runs/exe-after-preview6-upgrade.json",
      "runs/exe-preview6-restored-draft.txt",
    ],
    "真实独立EXE .4/.5/.6升级成功；.6原生恢复同一项目/人员/配置hash及文字+1图，五份旧安装backup保留，.5更新回执按原hash归档。此前历史截图本地读取和日常共存已实测。旧helper时间字段仍误将本地标为Z，使用proof.observedAt；.6新helper后续调用尚未据此证明。手工回退另列24部分实测及剩余缺口。",
  );
}
if (
  exeClosed?.passed &&
  exeClosed.context?.bug?.state === "closed" &&
  exeClosed.context.bug.version === 13 &&
  exeClosed.components?.items?.length === 5 &&
  exeClosed.components.items.every((component) => component.enabled === false)
) {
  const evidence = ["runs/exe-ui-bug-closed-readback.json", "runs/exe-preview5-restored-draft.txt"];
  baseline(
    9,
    "exe",
    "passed",
    evidence,
    "已安装 .5 原生UI实际创建含升级保留PNG和文字的Bug，选择当前员工修复/验收、开始处理、人工完成、填原因验收失败退回、再次人工完成、验收通过关闭。" +
      exeClosed.context.bug.key +
      " closed/v13，五组件全关；PNG184872字节hash保持一致。此原生闭环没有评论，编辑/评论/删除尚未因此标通过。",
  );
  for (const item of matrix.items.filter(
    (row) =>
      row.kind === "web_control" &&
      row.source?.file === "apps/web/src/App.tsx" &&
      /openCreateBug|setNewContent|completeWork\(\)|acceptBug\(\)|setNewOwnerId/u.test(row.title),
  ))
    record(
      item,
      "exe",
      "passed",
      evidence,
      "此控件在已安装 .5 原生UI的创建/人员选择/人工完成/验收关闭中实际操作；closed/v13及两轮验收读回。仅此行对应操作，未由共享Web实现推定。",
    );
}
const exeEdited = optionalRead("runs/exe-ui-edit-comment-readback.json");
if (
  exeEdited?.passed &&
  exeEdited.context?.bug?.state === "closed" &&
  exeEdited.context.bug.version === 14 &&
  exeEdited.context.comments?.items?.length === 1
) {
  controls(
    [
      "web_control-5e264eba3cbe52",
      "web_control-751aa347a99109",
      "web_control-06a335571c0d38",
      "web_control-d7e0b3ee49da01",
      "web_control-eab68cabb5cf51",
      "web_control-ab03d134d7b16c",
    ],
    "exe",
    ["runs/exe-ui-edit-comment-readback.json", "runs/exe-ui-comment.txt"],
    "已安装.5原生UI实际编辑已关闭Bug描述并保存，closed/v14，原附件保留；实际填写/提交1条评论并读回。未操作其它编辑字段或删除，未推定Web入口已测。",
  );
}
const exeDeleted = optionalRead("runs/exe-ui-delete-readback.json");
const exeDeletionAudit = optionalRead("runs/exe-ui-delete-retained-storage.json");
if (
  exeDeleted?.passed &&
  exeDeletionAudit?.passed &&
  exeDeleted.listed === false &&
  exeDeleted.context?.value?.code === "NOT_FOUND" &&
  exeDeleted.attachment?.value?.code === "NOT_FOUND" &&
  exeDeletionAudit.deletion?.bug_id === exeDeleted.deletedBugId &&
  exeDeletionAudit.bugRetained?.id === exeDeleted.deletedBugId
) {
  controls(
    ["web_control-cf9a3d4de3be9a"],
    "exe",
    [
      "runs/exe-ui-before-delete.json",
      "runs/exe-ui-delete-readback.json",
      "runs/exe-ui-delete-retained-storage.json",
      "runs/exe-ui-deleted.txt",
    ],
    ".5原生UI对独立测试Bug TA1788885078625-14确认软删除；列表消失、上下文和附件返回NOT_FOUND。只读SQLite保留Bug、actor/version/幂等删除审计，原闭环Bug13仍closed/v14。并未删除生产记录。",
  );
}
for (const surface of ["apk", "exe", "web", "http", "server_mcp", "local_mcp"]) {
  partialBaseline(
    21,
    surface,
    ["migration-rehearsal.md"],
    ["离线schema12→14及独立schema12回退副本，878附件/58业务表指纹匹配，两副本paused"],
    ["本入口未在迁移副本执行完整业务读回", "独立组件目录/未完成外部任务迁移不在该恢复集"],
  );
  partialBaseline(
    20,
    surface,
    ["component-runtime.md", "backend-components.md"],
    ["本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测"],
    ["真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行"],
  );
}

const exeRollback = optionalRead("runs/exe-preview6-to5-rollback.json");
const rollbackBusiness = optionalRead("runs/exe-rollback5-business-readback.json");
const rollbackProduction = optionalRead("runs/production-after-preview6-rollback.json");
if (
  exeRollback?.passed &&
  exeRollback.profileUntouched &&
  exeRollback.draftRestored &&
  rollbackBusiness?.passed &&
  rollbackBusiness.context?.bug?.state === "closed" &&
  rollbackBusiness.context.bug.version === 14 &&
  rollbackProduction?.files?.every((file) => file.matchesBaseline)
) {
  partialBaseline(
    24,
    "exe",
    [
      "runs/exe-preview6-to5-rollback.json",
      "runs/exe-rollback5-restored-draft.txt",
      "runs/exe-rollback5-business-readback.json",
      "runs/production-after-preview6-rollback.json",
    ],
    [
      "实际手工.6→.5回退保留旧backup与整个.6安装，原生同员工/项目/文字+图恢复",
      "原业务closed/v14、评论和附件hash读回保留；生产六文件hash/三进程及ready保持",
    ],
    [
      "重新升级/重复安装唯一备份与卸载恢复仍待独立proof",
      "完整数据服务回退与APK回退并未因EXE演练通过",
    ],
  );
}
const exeRepeat = optionalRead("runs/exe-preview6-repeat-upgrade.json");
const exeUninstall = optionalRead("runs/exe-preview6-uninstall-readback.json");
const exeReinstall = optionalRead("runs/exe-preview6-after-uninstall-reinstall.json");
if (
  exeRollback?.passed &&
  exeRepeat?.passed &&
  exeRepeat.draftPreserved &&
  exeRepeat.backups?.some((name) => name.endsWith("-1")) &&
  exeUninstall?.passed &&
  exeUninstall.profileFiles === 102 &&
  exeUninstall.profileBytes === 663514299 &&
  exeUninstall.allProfileBytesUnchanged &&
  exeUninstall.installedDirectoryAbsent &&
  exeReinstall?.passed &&
  exeReinstall.exitCode === 0 &&
  exeReinstall.draftRestored &&
  exeReinstall.installedVersion === "0.2.0-preview.6" &&
  exeReinstall.configSha256?.toLowerCase() === afterUpgrade6?.configSha256?.toLowerCase() &&
  exeReinstall.context?.bug?.state === "closed" &&
  exeReinstall.context.bug.version === 14 &&
  exeReinstall.context.comments?.items?.length === 1 &&
  exeReinstall.context.attachments?.items?.some((item) => item.sha256 === androidAttachment?.sha256)
) {
  baseline(
    24,
    "exe",
    "passed",
    [
      ...baselineItem(24).results.exe.evidence,
      "runs/exe-preview6-repeat-upgrade.json",
      "runs/exe-preview6-repeat-restored-draft.txt",
      "runs/exe-preview6-uninstall-readback.json",
      "runs/exe-preview6-after-uninstall-reinstall.json",
      "runs/exe-preview6-reinstall-restored-draft.txt",
    ],
    "EXE入口实际.6→.5手工回退、重复升级.6、卸载后精确同包重装并原生恢复员工/项目/配置/文字+1图；102个profile文件663514299字节在卸载前后hash完全一致。旧backup与-1新backup、回退/卸载保留目录仍在；原closed/v14、评论与184872字节附件hash读回，生产边界核对正常。仅客户端恢复范围passed；基线24的服务恢复由独立HTTP证据判定，其它客户端恢复功能不因此通过。",
  );
}
// The installed preview uses sharedApi=true and the server's 90-tool catalog.
// A same-name call must not validate the retained 18-tool fallback catalog.
for (const item of matrix.items.filter(
  (row) =>
    row.kind === "mcp_tool" &&
    row.source?.file === "apps/desktop/src/mcp-api.ts" &&
    row.results.local_mcp.status === "passed",
)) {
  progress(
    item,
    "local_mcp",
    item.results.local_mcp.evidence,
    ["已安装预览的90工具共享目录中同名工具有真实调用，结果映射在对应API目录行"],
    ["该源码行属于保留的18工具fallback目录；未以sharedApi=false实测，不计重复通过"],
  );
}
const validationEvidence = [
  ["workflow-concurrency-live/api-regression.txt", "人工流程幂等修复API MJS206/206", "pass 206"],
  [
    "workflow-concurrency-live/api-regression.txt",
    "人工流程幂等修复API TS33/33（合计239/239）",
    "pass 33",
  ],
  [
    "workflow-concurrency-live/storage-regression.txt",
    "人工流程幂等修复Storage117/117",
    "pass 117",
  ],
  ["runs/contracts-remediation-api-final.txt", "响应修复最终API MJS205/205", "pass 205"],
  ["runs/contracts-remediation-api-final.txt", "响应修复最终API TS33/33（合计238/238）", "pass 33"],
  ["runs/contracts-remediation-storage.txt", "响应修复Storage109/109", "pass 109"],
  ["runs/contracts-remediation-web-configured.txt", "响应修复相关Web19/19", "19 passed"],
  [
    "runs/contracts-remediation-strict.txt",
    "严格合同五步恢复通过（原baseline/checker保留）",
    "13 versioned files match contract 1.1.0",
  ],
  ["runs/desktop-final-pagination-protocol.txt", "Desktop 104/104", "pass 104"],
  ["runs/storage-final.txt", "Storage 109/109", "pass 109"],
  ["runs/storage-final-complete-source.txt", "冻结源码最终Storage109/109", "pass 109"],
  ["runs/api-final-complete-source.txt", "冻结源码最终API MJS142/142", "pass 142"],
  ["runs/api-final-complete-source.txt", "冻结源码最终API TS33/33（两组共175/175）", "pass 33"],
  [
    "runs/api-pagination-final.txt",
    "真实临时HTTP/SQLite与MCP分页/协议15/15，501评论/101附件",
    "pass 15",
  ],
  ["runs/root-unit-final-retry.txt", "root unit 4/4", "pass 4"],
  ["runs/skeleton-e2e-final-retry.txt", "skeleton 1/1", "pass 1"],
  [
    "runs/api-production-scope-final.txt",
    "精确Relay授权及组件scope16/16，含第101项目/成员",
    "pass 16",
  ],
  ["runs/api-delete-guard-final.txt", "MCP删除合同及已删除Bug附件读取保护17/17", "pass 17"],
  ["runs/contracts-app-first.txt", "独立app-first合同检查通过", "App-first contract check passed"],
  ["runs/contracts-additive.txt", "独立additive检查通过", "Additive compatibility passed"],
  [
    "runs/contracts-breaking-app-first.txt",
    "独立app-first breaking检查通过",
    "Breaking-change check passed",
  ],
]
  .filter(([file]) => fs.existsSync(path.join(evidenceRoot, file)))
  .map(([file, summary, expected]) => ({
    file,
    summary,
    matched: proofText(file).includes(expected),
    scope: "local verification; does not mark unexecuted native UI/external baseline passed",
  }));
const webVerification = optionalRead("runs/web-outbox-verification.json");
verifyPinnedProofs(
  {
    "web-pending-submission-source.json":
      "8b92d024d2622ceb0142a903482fea726d746c1adcf7fc3f42535c09e9b0e6a4",
    "runs/web-pending-submission-source.txt":
      "57c2b61bb942575e36df9b3de038fb62c616588e6a484763df9477689b6154c1",
    "runs/web-pending-submission-build.txt":
      "69cffe48d4425c7c601c1c0593dc5c273ca830b301c1a233fc8d986823b78f64",
    "runs/web-pending-submission-publication.json":
      "cd0118ed85b9fffd8ca4eaa4067bfa48050e25ec3fe8b79b479c29a811a31c08",
  },
  "Web pending submission source/publication",
);
const pendingSource = read("web-pending-submission-source.json");
const pendingPublication = read("runs/web-pending-submission-publication.json");
if (
  pendingSource.passed !== true ||
  pendingSource.web?.passed !== 99 ||
  pendingSource.web?.failed !== 0 ||
  !pendingSource.checks.every((check) => check.exitCode === 0) ||
  pendingPublication.passed !== true ||
  pendingPublication.sourceCommit !== "7904e2c2d7285003884a5788a83300fbf521dbf1" ||
  pendingPublication.serviceRestarted !== false ||
  pendingPublication.installedExeUpdated !== false ||
  pendingPublication.oldAssetBytesPreserved !== true ||
  pendingPublication.oldIndexRetained !== true ||
  pendingPublication.httpReadback.length !== 3 ||
  pendingPublication.httpReadback.some(
    (entry) => entry.status !== 200 || entry.instance !== "qa-hub-preview-7c86",
  ) ||
  pendingSource.sourceFiles.length !== 6 ||
  !pendingSource.sourceFiles.every((file) =>
    pendingPublication.webSourceFiles.some(
      (other) => other.path === file.path && other.sha256 === file.sha256,
    ),
  )
)
  throw new Error("Web pending submission validation differs from the reviewed source/publication");
validationEvidence.push(
  {
    file: "web-pending-submission-source.json",
    summary: "冻结共享Web源码99/99、双noEmit/lint/format；严格持久提交与明确拒绝恢复的本地回归",
    matched: true,
    scope:
      "fetch替身、受控IndexedDB事件与串行存储适配器；不证明真实浏览器/EXE重启或基线14客户端恢复",
  },
  {
    file: "runs/web-pending-submission-publication.json",
    summary: "7904e2c Web独立构建发布、3个实际HTTP下载SHA匹配、旧dist及全部旧assets保留",
    matched: true,
    scope:
      "该发布记录仅证明构建和静态下载，无服务重启/安装版EXE更新；后续浏览器故障注入单独映射，不由发布提升客户端通过项",
  },
);
const androidPendingFile = "android-offline-create-recovery.json";
verifyPinnedProofs(
  {
    [androidPendingFile]: "8ccfd05cb1a302c6627c80e6204519b416032617498f5e5297365b8c92c7c5ab",
    "runs/android-offline-create-protocol-source.txt":
      "6f40bd82c90066c73beb3ec38f100c9062921cc8e53d6a1f5299dc35405204d5",
    "runs/android-offline-create-protocol-source-retry.txt":
      "53a7683f1399cbf873d6b39ae6f1db97954c5d9d13ea8125a661172274df126a",
  },
  "Android pending submission source verification",
);
const androidPending = read(androidPendingFile);
const androidNormalization = androidPending.preCommitLineEndingNormalization;
if (
  androidPending.sourceFrozen !== true ||
  androidPending.sourceFiles.length !== 10 ||
  new Set(androidPending.sourceFiles.map((file) => file.path)).size !== 10 ||
  androidPending.unit.tests !== 115 ||
  androidPending.unit.failures !== 0 ||
  androidPending.unit.errors !== 0 ||
  androidPending.lint.errors !== 0 ||
  androidPending.limits.baseline14ClientPassClaim !== false ||
  androidNormalization.testedRawSha256 !==
    "0d13a3724d2866368d381338728179c4ba3e51308aaf9cedd2a7a45e1b694ca8" ||
  androidNormalization.committedCanonicalSha256 !==
    "710a77ed0afa5ec680bac1de4f689c264783a2dc5aaee2e873b88c19f7164bf5" ||
  androidNormalization.removedCarriageReturns !== 1 ||
  androidNormalization.onlyCRLFToLF !== true ||
  androidNormalization.testsRerun !== false ||
  !androidPending.sourceFiles.every(
    (file) =>
      file.path.startsWith("apps/android/app/src/") &&
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, file.path)))
        .digest("hex") === file.sha256,
  )
)
  throw new Error("Android pending submission proof/current source differs from reviewed hashes");
validationEvidence.push({
  file: androidPendingFile,
  summary: "Android 115/115、lint 0 error；严格核对提交fb2eca7的10份当前源码SHA",
  matched: true,
  sourceFiles: androidPending.sourceFiles,
  normalization: androidNormalization,
  preservedFailedVerification: androidPending.preservedFailedVerification,
  scope:
    "BugDraftPreferences测试原始SHA与提交canonical SHA分别保留，仅1个CRLF→LF、未重跑测试。OkHttp回环/受控DAO及偏好存储夹具，不是已安装APK、Compose/物理设备故障注入；不提升任何客户端结果。",
});
const nativeGuards = optionalRead("runs/native-installer-guards.json");
if (
  nativeGuards?.summary?.passed === 6 &&
  nativeGuards.summary.failed === 0 &&
  nativeGuards.actualUserProgramsTouched === false &&
  nativeGuards.installationOrUninstallationBodiesIncluded === false
)
  validationEvidence.push({
    file: "runs/native-installer-guards.json",
    summary: "原始NSIS .onInit隔离native guard6/6",
    matched: true,
    scope: "仅首建Programs、marker、junction与越界目录守卫；未执行真实用户完整首装或卸载",
  });
const nativeUtc = optionalRead("runs/native-updater-utc.json");
if (
  nativeUtc?.passed &&
  nativeUtc.exitCode === 1 &&
  nativeUtc.result?.status === "failed" &&
  nativeUtc.installerInvoked === false
)
  validationEvidence.push({
    file: "runs/native-updater-utc.json",
    summary: ".6 native helper以故意无效空配置实际返回failed并验证UTC序列化",
    matched: true,
    scope: "预期失败仅验证UTC；没有调用installer，不计更新成功",
  });
if (webVerification?.passed && webVerification.web?.passed === 61) {
  validationEvidence.push({
    file: "runs/web-outbox-verification.json",
    summary: "Web61/61+typecheck/lint/build；outbox真实临时API/SQLite、外部请求0",
    matched: true,
    scope: "React静态渲染及隔离API实测；浏览器暂停条目点击未测",
  });
  partialBaseline(
    18,
    "web",
    ["runs/web-outbox-verification.json"],
    ["真实临时SQLite/API交接关闭暂停、启用不重放、hold拒绝、明确恢复、重复拒绝及单审计；外部请求0"],
    ["浏览器有数据的暂停条目确认/恢复未测", "真实外部执行/运行中停用全组合未测"],
  );
}
for (const surface of ["http", "server_mcp"]) {
  if (
    validationEvidence.some(
      (entry) => entry.file === "runs/api-pagination-final.txt" && entry.matched,
    )
  )
    partialBaseline(
      13,
      surface,
      ["runs/api-pagination-final.txt"],
      ["真实临时HTTP/SQLite与MCP资源、分页501评论/101附件、协议/项目权限及部分API对等用例通过"],
      ["全部业务工具/动作的等价输入、版本/操作人/幂等/错误组合未完成；不是跨所有客户端的全量证明"],
    );
}
// Reviewed, proof-bound corrections survive reruns of older automatic mappings.
// These are public evidence records, never authority to skip an untested feature.
for (const item of matrix.items) {
  const reviewed = item.manual.reviewedEvidence;
  if (!reviewed) continue;
  const hashes = Object.entries(reviewed.proofHashes ?? {});
  if (!hashes.length) throw new Error(`Reviewed evidence has no proof hashes: ${item.id}`);
  for (const [file, expected] of hashes) {
    proofBytes(file);
    if (proofHashes[file] !== expected)
      throw new Error(`Reviewed evidence changed; re-review required: ${item.id} / ${file}`);
  }
  for (const [surface, result] of Object.entries(reviewed.results ?? {})) {
    const prior = item.results[surface];
    if (prior?.status === "failed" && result.status !== "failed") continue;
    retainReviewNote(item, surface);
    record(item, surface, result.status, result.evidence, result.actual);
  }
  for (const [surface, entry] of Object.entries(reviewed.surfaceProgress ?? {}))
    if (item.results[surface]?.status !== "failed")
      progress(
        item,
        surface,
        entry.evidence,
        [].concat(entry.completed ?? []),
        [].concat(entry.remaining ?? []),
      );
}
for (const [file, expected] of Object.entries(
  matrix.evidenceMapping?.finalSourceSupplement?.proofHashes ?? {},
)) {
  proofBytes(file);
  if (proofHashes[file] !== expected)
    throw new Error(`Final supplement evidence changed; re-review required: ${file}`);
}

// These runs are immutable observations, not a route-discovery heuristic. Only
// the enumerated HTTP/server-MCP capabilities below receive this evidence.
const isolationFirst = "project-isolation-live/789bd648-e5df-43d7-b5b1-283327f83b07";
const isolationFinal = "project-isolation-live/006a3b46-258e-4be8-a184-b605b26293e9";
const isolationProofHashes = {
  [`${isolationFirst}/summary.json`]:
    "2a02f9293d354ba5358d6328a77fb9863b9f1b05da779a576fbea2414d76120a",
  [`${isolationFirst}/requests.jsonl`]:
    "a8a98862776062149ac7698f823caa3bf0b4ea12013974a824f97bbec733667f",
  [`${isolationFirst}/assertions.jsonl`]:
    "6128110fe4f1f4869f381724a2e8681b7f4baec0c88db1530157ddb4924f3cb0",
  "project-isolation-live/first-run.raw.log":
    "2f61c5c10a83a1ba3a9f1f9cadc37c805e8fe4e9b27d2de1fc03d55011677af3",
  [`${isolationFinal}/summary.json`]:
    "d90f329c16461792e4f56bb10340c9d44cd6f86c617c25b8bee4953a2d9be53b",
  [`${isolationFinal}/requests.jsonl`]:
    "bc936b7c142a089db4827a526a69e95b517318c466806dd724cd1ff83be7b90f",
  [`${isolationFinal}/assertions.jsonl`]:
    "4b5c39a46172a8c1c9716db7cc0cf022a2a650a149aa86e0ee5b89993ed5aab4",
  "project-isolation-live/second-run.raw.log":
    "e1e431ceb4019391790774ec8bc0832ace755233a2ca085bc4673b210436826a",
  "project-isolation-live/post-run-audit.json":
    "87df7e62e51a6e52789d0e7e60ef775828a21fb4d2450e77d304dd88c976451c",
};
function verifyPinnedProofs(hashes, label) {
  for (const [file, expected] of Object.entries(hashes)) {
    proofBytes(file);
    if (proofHashes[file] !== expected)
      throw new Error(`${label} proof changed; re-review required: ${file}`);
  }
}
verifyPinnedProofs(isolationProofHashes, "Project isolation");
const isolationFailedRun = read(`${isolationFirst}/summary.json`);
const isolationPassedRun = read(`${isolationFinal}/summary.json`);
const isolationRequests = proofText(`${isolationFinal}/requests.jsonl`)
  .trim()
  .split("\n")
  .map(JSON.parse);
const isolationAssertions = proofText(`${isolationFinal}/assertions.jsonl`)
  .trim()
  .split("\n")
  .map(JSON.parse);
const isolationDenials = isolationAssertions.filter((entry) =>
  entry.label.endsWith("authorization rejection"),
);
const isolationUnchanged = isolationAssertions.filter((entry) =>
  entry.label.endsWith("statistics unchanged"),
);
if (
  isolationFailedRun.passed !== false ||
  isolationFailedRun.failure?.name !== "ReferenceError" ||
  isolationFailedRun.requestCount !== 363 ||
  isolationFailedRun.assertionCount !== 45 ||
  isolationPassedRun.passed !== true ||
  isolationPassedRun.requestCount !== 1997 ||
  isolationRequests.length !== 1997 ||
  isolationAssertions.length !== 262 ||
  isolationAssertions.some((entry) => entry.passed !== true) ||
  JSON.stringify(isolationAssertions) !== JSON.stringify(isolationPassedRun.assertions) ||
  isolationDenials.length !== 100 ||
  isolationDenials.filter((entry) => entry.label.endsWith("write authorization rejection"))
    .length !== 40 ||
  isolationUnchanged.length !== 100 ||
  isolationUnchanged.some((entry) => entry.beforeSha256 !== entry.afterSha256) ||
  isolationPassedRun.boundaries?.componentsOff !== true ||
  isolationPassedRun.fixtures.length !== 4 ||
  isolationPassedRun.fixtures.some(
    (entry) => !entry.deletedAt || entry.reservation?.status !== "reserved",
  ) ||
  isolationRequests.some(
    (entry, index) =>
      entry.index !== index ||
      entry.failure ||
      !["http://127.0.0.1:4419", "http://127.0.0.1:4421"].includes(entry.origin) ||
      /production|increment-upload|packaging|qingyu/u.test(entry.path),
  )
)
  throw new Error("Project isolation evidence does not match the reviewed scope");
const isolationEvidence = Object.keys(isolationProofHashes);
const isolationRunHistory = [
  {
    runId: isolationFailedRun.runId,
    status: "failed",
    category: "harness",
    evidence: `${isolationFirst}/summary.json`,
    actual:
      "363 requests/45 completed assertions; 17 authorization denials and unchanged snapshots passed before ReferenceError in the reservation replay check. All first-run fixtures retained; no product failure inferred.",
  },
  {
    runId: isolationPassedRun.runId,
    status: "passed",
    category: "selected_live_cases",
    evidence: `${isolationFinal}/summary.json`,
    actual:
      "1997 requests/262 assertions; 60 read and 40 write denials with 100 unchanged owner snapshots. Fresh C/D fixtures; initial PNGs claimed, extra attachments reserved, four Bugs soft-deleted after valid human completion. Component logs not exercised.",
  },
];
function appendIsolationObservation(item, surface, references, actual) {
  if (!item?.results[surface]?.applicable) return;
  const prior = item.results[surface];
  const marker = "项目隔离006a3b46";
  const previousText = prior.actual.split(marker)[0].trim();
  record(
    item,
    surface,
    prior.status === "failed" ? "failed" : "passed",
    [...new Set([...prior.evidence, ...references])],
    `${previousText}${previousText ? " " : ""}${marker}：${actual}`,
  );
  item.manual.projectIsolationRuns = isolationRunHistory;
}
for (const surface of ["http", "server_mcp"]) {
  const note =
    "HTTP4419及服务JSON-RPC4421各自双向C/D测试：非成员403、双成员显式错记录项目404；每次拒绝后Bug/列表/评论/事件/附件字节/统计/分类相同，合法读取及写入对照成功。";
  if (baselineItem(5).results[surface].status !== "failed")
    partialBaseline(
      5,
      surface,
      isolationEvidence,
      [note, "实际PNG下载和MCP资源字节一致；仅当前HTTP/server MCP入口"],
      [
        "组件任务日志未执行，Bug事件/附件不替代日志",
        "其它客户端、本地MCP和§17完整异常组合独立验收",
      ],
    );
  const writeNote =
    "设计13/06列出的修改、评论、上传绑定、状态四类均有真实项目隔离拒绝及合法成功对照，额外测试软删除；两项目双向、无成员和shared错scope共40次写拒绝。绑定负向为bug_create预留，成功后同键读取同bindingId/replayed:true；初始PNG已由Bug创建事务认领。仅该入口最低基线，不扩展verification-result跨Bug意图或全部状态动作。";
  if (baselineItem(6).results[surface].status !== "failed")
    baseline(6, surface, "passed", isolationEvidence, writeNote);
  for (const number of [5, 6])
    baselineItem(number).manual.projectIsolationRuns = isolationRunHistory;
}
const isolationHttpRoutes = [
  ["GET", "/api/v1/bugs"],
  ["GET", "/api/v1/bugs/:bugId"],
  ["GET", "/api/v1/bugs/:bugId/comments"],
  ["GET", "/api/v1/bugs/:bugId/events"],
  ["GET", "/api/v1/bugs/:bugId/attachments"],
  ["GET", "/api/v1/attachments/:attachmentId"],
  ["GET", "/api/v1/projects/:projectId/metrics/overview"],
  ["GET", "/api/v1/projects/:projectId/modules"],
  ["PATCH", "/api/v1/bugs/:bugId"],
  ["POST", "/api/v1/bugs/:bugId/comments"],
  ["POST", "/api/v1/attachments/:attachmentId/bind"],
  ["POST", "/api/v1/bugs/:bugId/manual-complete"],
  ["DELETE", "/api/v1/bugs/:bugId"],
];
for (const [method, route] of isolationHttpRoutes) {
  const expression = new RegExp(
    "^" +
      route
        .split("/")
        .map((part) => (part.startsWith(":") ? "[^/]+" : escape(part)))
        .join("/") +
      "$",
  );
  const observed = isolationRequests.filter(
    (entry) =>
      entry.origin === "http://127.0.0.1:4419" &&
      entry.method === method &&
      expression.test(entry.path.split("?")[0]),
  );
  if (
    !observed.some((entry) => entry.status >= 200 && entry.status < 300) ||
    !observed.some((entry) => entry.status === 403 || entry.status === 404)
  )
    throw new Error(
      `Reviewed isolation HTTP route lacks a real positive/negative pair: ${method} ${route}`,
    );
  const references = [
    ...isolationEvidence.slice(0, 3),
    `${isolationFinal}/summary.json`,
    `${isolationFinal}/assertions.jsonl`,
    ...observed.map((entry) => `${isolationFinal}/requests.jsonl#line=${entry.index + 1}`),
  ];
  for (const item of matrix.items.filter(
    (entry) => entry.kind === "http_route" && entry.method === method && entry.path === route,
  ))
    appendIsolationObservation(
      item,
      "http",
      references,
      "此准确路由有C/D授权成功及错项目拒绝与原项目不变读回；不推导该路由的全部请求分支、附件意图或状态动作通过。",
    );
}
const isolationTools = [
  "qa_list_bugs",
  "qa_get_bug_context",
  "qa_list_comments",
  "qa_list_events",
  "qa_list_attachments",
  "qa_read_attachment",
  "qa_get_metrics",
  "qa_list_modules",
  "qa_materialize_attachment",
  "qa_update_bug",
  "qa_add_comment",
  "qa_bind_attachment",
  "qa_bug_action",
  "qa_delete_bug",
];
for (const toolName of isolationTools) {
  const observed = isolationRequests.filter(
    (entry) =>
      entry.origin === "http://127.0.0.1:4421" &&
      entry.request?.method === "tools/call" &&
      entry.request.params.name === toolName,
  );
  if (
    !observed.some((entry) => entry.response?.result?.isError === false) ||
    !observed.some((entry) => entry.response?.result?.isError === true)
  )
    throw new Error(`Reviewed isolation MCP tool lacks a real positive/negative pair: ${toolName}`);
  const references = [
    ...isolationEvidence.slice(0, 3),
    `${isolationFinal}/summary.json`,
    `${isolationFinal}/assertions.jsonl`,
    ...observed.map((entry) => `${isolationFinal}/requests.jsonl#line=${entry.index + 1}`),
  ];
  for (const item of matrix.items.filter(
    (entry) =>
      entry.kind === "mcp_tool" &&
      entry.toolName === toolName &&
      ["apps/api/src/automation.ts", "apps/api/src/automation-routes.ts"].includes(
        entry.source?.file,
      ),
  ))
    appendIsolationObservation(
      item,
      "server_mcp",
      references,
      "此服务端工具经实际JSON-RPC有合法成功及项目拒绝、HTTP持久读回；qa_bug_action仅manual_complete，qa_bind_attachment额外部分为预留。没有运行本地MCP或旧fallback工具。",
    );
}
matrix.evidenceMapping.projectIsolationLive = {
  proofHashes: isolationProofHashes,
  runs: isolationRunHistory,
  surfaces: ["http", "server_mcp"],
  baseline05: "partial; task logs unexecuted",
  baseline06: "criterion passed per tested surface; other surfaces remain independent",
};

// First concurrency run is a real product failure, unlike the isolation harness
// exception. Retain it separately; a later corrected runtime proof must explicitly
// compare the same cases before this history can be described as resolved.
const concurrencyFirstFile = "workflow-concurrency-live/e94223b3-82c5-469d-b7ca-eea306ba0aab.json";
verifyPinnedProofs(
  { [concurrencyFirstFile]: "999efd88f54db67331b68c7d5aad9031f9f2048e94d625c23a5864433cc6370f" },
  "Workflow concurrency first failure",
);
const concurrencyFirst = read(concurrencyFirstFile);
if (
  concurrencyFirst.passed !== false ||
  concurrencyFirst.exchanges.length !== 98 ||
  concurrencyFirst.checks.length !== 86 ||
  concurrencyFirst.checks.filter((entry) => entry.passed === false).length !== 19
)
  throw new Error("Workflow concurrency first failure no longer matches its reviewed history");
matrix.evidenceMapping.workflowConcurrencyFirstFailure = {
  evidence: concurrencyFirstFile,
  status: "failed",
  category: "product",
  requests: 98,
  passedChecks: 67,
  failedChecks: 19,
  actual:
    "Six same-key workflow receipt replay gaps (18 checks) plus reused-create payload mismatch HTTP500 instead of frozen409. Twelve real HTTP/server-MCP races; first fixtures and source hashes retained. Resolution requires the later deployed-runtime proof.",
};

const concurrencyFinalFile = "workflow-concurrency-live/badce916-8b25-463b-9ee2-ddad3727350f.json";
const concurrencyProofHashes = {
  [concurrencyFirstFile]: "999efd88f54db67331b68c7d5aad9031f9f2048e94d625c23a5864433cc6370f",
  [concurrencyFinalFile]: "88d332019f95d11bdd1d294749016cc431b2f7995cb053640c58c3c2fa478579",
  "workflow-concurrency-live/before-restart-33c28537-73ad-4037-b1c4-bff011da9a53.json":
    "625a031685b61785c22fb0409e404dd7adf713ce687ffd33ce6f3d2f8eb74aff",
  "workflow-concurrency-live/after-restart-33c28537-73ad-4037-b1c4-bff011da9a53.json":
    "61f7670da33b0b274017f0d3e7ff7b03f537d39deb0f7cf24f3d943e9445ff0d",
  "workflow-concurrency-live/api-regression.txt":
    "469b7eef387328c4495c539188762b311cd6c308b8e629ab9e930ff787db05be",
  "workflow-concurrency-live/storage-regression.txt":
    "89f61434e7873f97e2e75b9e09827b9cd4bfddd5e58e0bdb9dac0dd3eed7f7d8",
  "workflow-concurrency-live/contracts-regression.txt":
    "69f352f09c0cedef451604f7557e4362b4a0e25868604a197bd2d770e64dffca",
};
verifyPinnedProofs(concurrencyProofHashes, "Workflow concurrency repair");
const concurrencyFinal = read(concurrencyFinalFile);
const repairedChecks = new Map(concurrencyFinal.checks.map((entry) => [entry.label, entry]));
if (
  concurrencyFinal.passed !== true ||
  concurrencyFinal.exchanges.length !== 98 ||
  concurrencyFinal.checks.length !== 105 ||
  concurrencyFinal.checks.some((entry) => entry.passed !== true) ||
  concurrencyFinal.races.length !== 12 ||
  JSON.stringify(concurrencyFirst.races.map((entry) => entry.label)) !==
    JSON.stringify(concurrencyFinal.races.map((entry) => entry.label)) ||
  concurrencyFirst.checks.some((entry) => repairedChecks.get(entry.label)?.passed !== true) ||
  repairedChecks.get("create changed payload HTTP status")?.actual !== 409 ||
  repairedChecks.get("create changed payload code")?.actual !== "IDEMPOTENCY_PAYLOAD_MISMATCH" ||
  concurrencyFinal.exchanges.some(
    (entry) => !["http://127.0.0.1:4419", "http://127.0.0.1:4421"].includes(entry.origin),
  )
)
  throw new Error("Workflow repair must preserve and re-run every first-run check and race");
const concurrencyRunHistory = [
  {
    runId: concurrencyFirst.runId,
    evidence: concurrencyFirstFile,
    status: "failed",
    category: "product",
    requests: 98,
    checks: 86,
    failedChecks: 19,
    resolvedBy: concurrencyFinal.runId,
  },
  {
    runId: concurrencyFinal.runId,
    evidence: concurrencyFinalFile,
    status: "passed",
    category: "same_cases_after_deployed_repair",
    requests: 98,
    checks: 105,
    failedChecks: 0,
    additionalChecks:
      "18 resource comparisons reached after successful replay, plus HTTP409 status",
  },
];
matrix.evidenceMapping.workflowConcurrencyFirstFailure.resolvedBy = concurrencyFinal.runId;
matrix.evidenceMapping.workflowConcurrencyLive = {
  proofHashes: concurrencyProofHashes,
  runs: concurrencyRunHistory,
  fixCommit: "8f7330a559fc9611e93f2ef62df0e63639f07afc",
  recordedRuntimeHashes: concurrencyFinal.sourceHashes,
  baseline14: "partial HTTP/server MCP; all client timeout recovery and other actions independent",
  sourceChange:
    "packages/storage/src/workflow-idempotency.ts adds durable transaction receipts for six human workflow operations; app.ts maps reused-create payload mismatch to frozen409. Storage source is outside the UI/API discovery roots; the fix commit, local regression logs and live dist hashes are recorded separately.",
};
for (const surface of ["http", "server_mcp"]) {
  const previousProgress = baselineItem(14).manual.surfaceProgress?.[surface];
  if (baselineItem(14).results[surface].status !== "failed")
    partialBaseline(
      14,
      surface,
      [
        ...new Set([
          ...baselineItem(14).results[surface].evidence,
          ...Object.keys(concurrencyProofHashes),
        ]),
      ],
      [
        ...new Set([
          ...[].concat(previousProgress?.completed ?? []),
          "真实两客户端12并发组、98请求/105检查通过；六人工流程动作同键并发及后续重放返回同一已提交资源，事件/操作者和重放后Bug不变，旧版本不同编辑键一胜一VERSION_CONFLICT。",
          "创建同键不同payload实际HTTP409/IDEMPOTENCY_PAYLOAD_MISMATCH；创建、编辑、评论、验收通过和软删除同键无重复效果。首次19项产品失败原样留存并由同场景新proof对照修复。",
        ]),
      ],
      [
        ...new Set([
          ...[].concat(previousProgress?.remaining ?? []),
          "APK/EXE/Web真实超时恢复及local MCP未由本轮测试",
          "更多状态动作、全部附件阶段、组件外部任务及§17完整异常组合尚未测试",
        ]),
      ],
    );
  baselineItem(14).manual.workflowConcurrencyRuns = concurrencyRunHistory;
}
const repairedWorkflowRoutes = [
  ["ready", "ready", "/api/v1/bugs/:bugId/transitions"],
  ["plan human fix", "plan_fix", "/api/v1/bugs/:bugId/repair-attempts"],
  ["begin human fix", "begin_fix", "/api/v1/repair-attempts/:attemptId/start"],
  ["submit no-code fix", "submit_fix", "/api/v1/repair-attempts/:attemptId/deliver"],
  ["create verification", "create_verification", "/api/v1/bugs/:bugId/verifications"],
  ["start verification", "start_verification", "/api/v1/verifications/:verificationId/start"],
];
function appendConcurrencyObservation(item, surface, references, actual) {
  if (!item?.results[surface]?.applicable) return;
  const prior = item.results[surface];
  const marker = "并发修复badce916";
  const previousText = prior.actual.split(marker)[0].trim();
  record(
    item,
    surface,
    prior.status === "failed" ? "failed" : "passed",
    [...new Set([...prior.evidence, concurrencyFirstFile, concurrencyFinalFile, ...references])],
    `${previousText}${previousText ? " " : ""}${marker}：${actual}`,
  );
  item.manual.workflowConcurrencyRuns = concurrencyRunHistory;
}
for (const [label, action, route] of repairedWorkflowRoutes) {
  const race = concurrencyFinal.races.find((entry) => entry.label === label);
  const exchanges = race.exchangeIds.map((id) =>
    concurrencyFinal.exchanges.find((entry) => entry.id === id),
  );
  if (
    exchanges.length !== 2 ||
    !exchanges.some(
      (entry) => entry.origin.endsWith(":4419") && entry.status >= 200 && entry.status < 300,
    ) ||
    !exchanges.some(
      (entry) =>
        entry.request?.params?.arguments?.action === action &&
        entry.response?.result?.isError === false,
    )
  )
    throw new Error(`Workflow repair lacks real paired success: ${label}`);
  const references = race.exchangeIds.map((id) => `${concurrencyFinalFile}#exchangeId=${id}`);
  for (const item of matrix.items.filter(
    (entry) => entry.kind === "http_route" && entry.method === "POST" && entry.path === route,
  ))
    appendConcurrencyObservation(
      item,
      "http",
      references,
      `${label}经实际HTTP和server MCP同键并发/后续重放成功，原始失败留存；仅human/no_code及当前输入，未验证该路由所有分支。`,
    );
}
for (const item of matrix.items.filter(
  (entry) =>
    entry.kind === "mcp_tool" &&
    entry.toolName === "qa_bug_action" &&
    entry.source?.file === "apps/api/src/automation.ts",
))
  appendConcurrencyObservation(
    item,
    "server_mcp",
    [],
    "ready/plan_fix/begin_fix/submit_fix(no_code)/create_verification/start_verification六动作真实并发及回执重放修复；只比较共同资源DTO，MCP envelope的fresh Bug读取不声称整包字节相同。未扩展local MCP或其它动作。",
  );
for (const item of matrix.items.filter(
  (entry) =>
    entry.kind === "http_route" && entry.method === "POST" && entry.path === "/api/v1/bugs",
))
  appendConcurrencyObservation(
    item,
    "http",
    [],
    "同键创建一次，同clientSubmissionId变更payload实际409/IDEMPOTENCY_PAYLOAD_MISMATCH且原Bug/事件不变；首次错误500保留。",
  );

const verdictProofFile =
  "workflow-verdict-concurrency-live/f8e2c6da-65c0-4cf6-9631-886bb777df2e.json";
verifyPinnedProofs(
  { [verdictProofFile]: "9c0ccfd292e8ff2f679b0e36961ad83fdf1979b58012127eec3b2e5e29fb1478" },
  "Opposite verification verdict concurrency",
);
const verdictProof = read(verdictProofFile);
if (
  verdictProof.passed !== true ||
  verdictProof.exchanges.length !== 66 ||
  verdictProof.checks.length !== 56 ||
  verdictProof.checks.some((entry) => entry.passed !== true) ||
  verdictProof.races.length !== 4 ||
  verdictProof.fixtures.length !== 2 ||
  verdictProof.fixtures.some((entry) => entry.winner.lane !== "HTTP") ||
  verdictProof.exchanges.some(
    (entry) =>
      entry.failure || !["http://127.0.0.1:4419", "http://127.0.0.1:4421"].includes(entry.origin),
  )
)
  throw new Error("Opposite verdict proof differs from the reviewed cases");
for (const race of verdictProof.races) {
  const pair = race.exchangeIds.map((id) =>
    verdictProof.exchanges.find((entry) => entry.id === id),
  );
  if (
    pair.length !== 2 ||
    pair.some((entry) => !entry) ||
    Math.max(...pair.map((entry) => Date.parse(entry.startedAt))) >
      Math.min(...pair.map((entry) => Date.parse(entry.finishedAt)))
  )
    throw new Error("Opposite verdict proof lacks bounded overlapping dispatch");
}
matrix.evidenceMapping.workflowVerdictConcurrencyLive = {
  evidence: verdictProofFile,
  runId: verdictProof.runId,
  requests: 66,
  checks: 56,
  races: 4,
  scope:
    "HTTP/server MCP only: same manual completion intent and two opposite verdict races; pass won both. All fresh fixtures retained, five components disabled. Successful failure-side effects, UI and other entries remain untested here.",
};
for (const surface of ["http", "server_mcp"]) {
  const item = baselineItem(14);
  const prior = item.manual.surfaceProgress?.[surface];
  if (item.results[surface].status === "failed") continue;
  partialBaseline(
    14,
    surface,
    [...new Set([...item.results[surface].evidence, verdictProofFile])],
    [
      ...new Set([
        ...[].concat(prior?.completed ?? []),
        "f8e2c6da：66真实请求/56检查，两组同manual_complete意图和verify_pass/verify_fail、close/reject相反结论竞争；验收结果各仅一个版本和事件效果。胜方跨HTTP/server MCP重放同回执，败方旧版本及胜方变更payload均拒绝，原记录保留。",
      ]),
    ],
    [
      ...new Set([
        ...[].concat(prior?.remaining ?? []),
        "f8e2c6da中两次均由HTTP通过方胜出，不据此声称退回成功效果、客户端恢复或所有动作组合通过",
      ]),
    ],
  );
}

const webRecoveryFirstFile =
  "web-submission-recovery-live/4f6387f6-244b-4115-916b-6fffe3db1efd/proof.json";
const webRecoveryFinalFile =
  "web-submission-recovery-live/bf3a4621-6c48-459e-b776-5c9011d7d327/proof.json";
verifyPinnedProofs(
  {
    [webRecoveryFirstFile]: "e895f1114d9b86ac2272783e101a360617c1e28fc16537104a116a880446eef7",
    [webRecoveryFinalFile]: "3bd91b313315c54c457307facaaff52d900848dfc6da4fc8c096c8e70d1c4c84",
    "web-submission-recovery-live/audit.json":
      "8bf531f9baf759365339d5e32d5abfe0162ea04cdf6628adfc4b42ceeb27db29",
    "web-submission-recovery-live/README.md":
      "f233ff30db0ee6a80c84be78a57ab85067f8444ff92a86d1e0b3e95fffb74f25",
  },
  "Web unknown submission recovery real browser runs",
);
const webRecoveryFirst = read(webRecoveryFirstFile);
const webRecoveryFinal = read(webRecoveryFinalFile);
const webRecoveryAudit = read("web-submission-recovery-live/audit.json");
if (
  webRecoveryAudit.status !== "passed_with_preserved_first_run_harness_failure" ||
  webRecoveryAudit.runs.length !== 2 ||
  webRecoveryAudit.runs[0].recomputedEqualAndPassed !== 38 ||
  webRecoveryAudit.runs[1].recomputedEqualAndPassed !== 101 ||
  webRecoveryFirst.status !== "failed" ||
  webRecoveryFirst.checks.length !== 38 ||
  webRecoveryFirst.checks.some((check) => check.passed !== true) ||
  webRecoveryFirst.failure !== "Error: Timed out: post comment once" ||
  webRecoveryFinal.status !== "passed" ||
  webRecoveryFinal.checks.length !== 101 ||
  webRecoveryFinal.checks.some((check) => check.passed !== true) ||
  webRecoveryFinal.faults.length !== 2 ||
  webRecoveryFinal.boundaries.existingBrowserOrExeAttached !== false ||
  webRecoveryFinal.boundaries.componentTasksCalled !== false ||
  webRecoveryFinal.publishedSourceCommit !== pendingPublication.sourceCommit ||
  Object.entries(webRecoveryFinal.sourceHashes).some(
    ([file, sha256]) =>
      !pendingSource.sourceFiles.some((entry) => entry.path === file && entry.sha256 === sha256),
  ) ||
  webRecoveryFinal.processes.filter((entry) => entry.phase === "launched").length !== 4 ||
  webRecoveryFinal.processes.filter((entry) => entry.phase === "normal_close" && entry.exited)
    .length !== 4 ||
  webRecoveryFinal.bundles.length !== 4 ||
  webRecoveryFinal.bundles.some(
    (entry) => entry.status !== 200 || entry.sha256 !== webRecoveryFinal.expectedBundle.sha256,
  )
)
  throw new Error("Web browser recovery proof differs from the reviewed two runs");
for (const kind of ["bug", "comment"]) {
  const fault = webRecoveryFinal.faults.find((entry) => entry.kind === kind);
  const requests = webRecoveryFinal.requests.filter(
    (entry) =>
      entry.kind === "page_request" && entry.method === "POST" && entry.path === fault?.path,
  );
  const responses = webRecoveryFinal.requests.filter(
    (entry) => entry.kind === "page_commit_response" && entry.path === fault?.path,
  );
  if (
    fault?.phase !== "server_response_201_before_browser_delivery" ||
    fault.action !== "Fetch.failRequest/Failed" ||
    requests.length !== 2 ||
    responses.length !== 2 ||
    responses.some((entry) => entry.status !== 201) ||
    JSON.stringify(requests[0].body) !== JSON.stringify(requests[1].body) ||
    requests[0].headers["idempotency-key"] !== requests[1].headers["idempotency-key"]
  )
    throw new Error(`Web ${kind} recovery lacks the original request/key and real 201 pair`);
}
const webRecoveryItem = baselineItem(14);
webRecoveryItem.manual.webSubmissionRecoveryRuns = [
  {
    evidence: webRecoveryFirstFile,
    status: "failed",
    completedChecks: 38,
    failure: webRecoveryFirst.failure,
    scope: "首轮harness未展开评论区，未发评论POST；原始失败及已创建fixture保留，不计完整恢复通过",
  },
  {
    evidence: webRecoveryFinalFile,
    status: "passed",
    completedChecks: 101,
    scope: "独立Edge实际页面与持久profile；只覆盖Bug/comment未知回执重放和正常浏览器重启",
  },
];
if (webRecoveryItem.results.web.status !== "failed") {
  const prior = webRecoveryItem.manual.surfaceProgress?.web;
  partialBaseline(
    14,
    "web",
    [
      ...new Set([
        ...webRecoveryItem.results.web.evidence,
        webRecoveryFirstFile,
        webRecoveryFinalFile,
        "web-submission-recovery-live/audit.json",
        "web-submission-recovery-live/README.md",
      ]),
    ],
    [
      ...new Set([
        ...[].concat(prior?.completed ?? []),
        "bf3a4621：实际Edge页面101/101；Bug及评论各在服务201后丢弃一次回执，修改草稿后正常关闭/重启同profile，再通过原结果确认按钮以原key/冻结payload重放；仅1个Bug/occurrence/评论及1份68B PNG同SHA，后改两份草稿保留并再次重启读回。",
      ]),
    ],
    [
      ...new Set([
        ...[].concat(prior?.remaining ?? []),
        "该Web实测未覆盖其它写动作、同时多窗口、附件上传中断、撤权/跨项目故障、进程强杀或所有幂等竞争组合；APK/EXE/HTTP/server MCP/local MCP结果不由此迁移。首轮38检查后harness失败保留。",
      ]),
    ],
  );
}

// Several reviewed passes may temporarily revisit the same result. If its
// actual observation is unchanged, retain the incoming note rather than an
// incidental automatic note from one of those intermediate passes.
for (const item of matrix.items) {
  for (const [surface, result] of Object.entries(item.results)) {
    const incoming = incomingResults.get(item.id)?.[surface];
    if (
      incoming &&
      incoming.status === result.status &&
      incoming.actual === result.actual &&
      JSON.stringify(incoming.evidence) === JSON.stringify(result.evidence)
    )
      result.note = incoming.note;
  }
}
matrix.evidenceMapping = {
  ...matrix.evidenceMapping,
  at: new Date().toISOString(),
  scope:
    "Only explicit real HTTP/MCP/browser observations. Unit/build results never mark external E2E or broad untested baselines passed.",
  sourceReports: Object.keys(proofHashes),
  proofHashes,
  validationEvidence,
  review: "coverage-mapping-review.md",
};
const surfaces = Object.keys(matrix.surfaces);
matrix.summary.resultsBySurface = Object.fromEntries(
  surfaces.map((surface) => {
    const counts = {};
    for (const item of matrix.items)
      if (item.results[surface].applicable)
        counts[item.results[surface].status] = (counts[item.results[surface].status] ?? 0) + 1;
    return [surface, counts];
  }),
);
fs.writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + "\n");
const review = [
  "# 实测证据映射审查",
  "",
  `生成时点：${matrix.evidenceMapping.at}。只读已有证据，没有操作 UI、API 或生产。`,
  "",
  "`passed` 只代表该行明确注明的实际入口与输入。细目控件/路由通过不代表全部负向分支或上层基线通过；HTTP 15项、MCP 13项不称全部动作。未使用源码存在、共享实现、编译、单元或外部合同 fixture 代替真实外部执行。",
  "",
  "## 24 项基线校准",
  "",
  `| 场景 | ${surfaces.map((surface) => matrix.surfaces[surface]).join(" | ")} |`,
  `| --- | ${surfaces.map(() => "---").join(" | ")} |`,
  ...matrix.items
    .filter((item) => item.kind === "baseline")
    .map(
      (item) =>
        `| ${item.title} | ${surfaces.map((surface) => (!item.results[surface].applicable ? "—" : item.results[surface].status + (item.manual.surfaceProgress?.[surface] ? "（部分实测）" : ""))).join(" | ")} |`,
    ),
  "",
  "09按六个实际入口分别闭环；10原文的两端指APK与EXE，分别有原生人员查看、关联和停用证据，既有HTTP证据保留但不把六入口附加为此基线条件。11/12按设计独立性判据，由EXE停止窗口内的实际HTTP及服务端JSON-RPC分别登录、查询、评论和改状态判断；全部动作/负向场景继续由§17及13/14验收。15按HTTP下载、远端MCP资源、本地MCP落盘及同一PNG归属/hash判定。23有实际EXE升级恢复proof。24按设计13/24与10.3服务恢复要求，由独立HTTP回退/保留/恢复证据判定。其它客户端/HTTP/MCP功能控件独立保留，22和§17.3物理Android未豁免。",
  "",
  "## 部分实测及剩余缺口",
  "",
  ...matrix.items
    .filter((item) => item.kind === "baseline")
    .flatMap((item) =>
      surfaces
        .filter((surface) => item.manual.surfaceProgress?.[surface])
        .map((surface) => {
          const entry = item.manual.surfaceProgress[surface];
          return `- ${item.title} / ${matrix.surfaces[surface]}：已测 ${[].concat(entry.completed ?? []).join("；")}。仍缺 ${[].concat(entry.remaining ?? []).join("；")}。`;
        }),
    ),
  "",
  "独立 Jenkins、上传平台/对象存储、Relay 目的实例和轻语测试租户/凭据仍缺；所有 `external_full_chain` 保持 not_run。离线迁移的数据库/附件指纹证明没有替代各入口执行。异常停止预览 EXE 证明进程独立和草稿恢复，不能自动记为完整版本回退。",
  "已安装EXE的90工具共享目录与源码保留的18工具fallback目录分别统计；同名工具调用只通过共享目录对应行，fallback行保留未测，避免重复计数。",
  "",
  ...(matrix.evidenceMapping.reviewedSupplementSections ?? []),
  "",
  "## C/D HTTP与服务端MCP项目隔离",
  "",
  "[两轮完整证据](project-isolation-live/README.md)：首次363请求/45已完成断言因harness变量初始化顺序失败，项目/人员/4Bug/额外预留原样保留；修正后新fixture第二轮1997请求/262断言通过，100授权拒绝各有原项目快照不变。05仅部分实测，组件任务日志仍未执行；事件/附件不替代日志。06的修改、评论、上传绑定、状态最低类别在HTTP/serverMCP两个实际入口criterion passed，绑定额外测试是bug_create预留及持久重放，不声称已claim到既有Bug或全部意图通过。其它客户端不迁移状态，06整行仍未完成。映射仅13条明确HTTP路由和14个服务端工具，不向本地MCP/fallback/所有状态组合传播。",
  "",
  "[首次并发实际失败](workflow-concurrency-live/e94223b3-82c5-469d-b7ca-eea306ba0aab.json)为98请求/86检查、19失败：六动作同键回执重放及创建payload不匹配错误边界。部署修复8f7330a后，[相同12并发组新proof](workflow-concurrency-live/badce916-8b25-463b-9ee2-ddad3727350f.json)98请求/105检查全过，原86检查逐label均重新通过，增加18个成功后才能执行的资源比较和1个HTTP409断言；首次失败及fixture原样留存。映射精确六条人工流程HTTP路由、POST Bugs错误码和server qa_bug_action六动作，保留needsRevalidation；其它状态与local MCP不传播。14仅HTTP/server MCP partial，客户端timeout恢复、更多动作/附件阶段与外部任务去重仍未测试。",
  "",
  "## 可重放与审计",
  "",
  ...validationEvidence.map(
    (entry) =>
      `- ${entry.summary}：${entry.matched ? "已有成功输出" : "输出需复核"}，见[${entry.file}](${entry.file})。${entry.scope}。`,
  ),
  "",
  "严格旧合同冻结失败保留为历史，后续六条响应边界修复已有独立五步门禁成功日志与实际HTTP读回。旧1.0请求/blocked写入、未注册的fail/supersede POST和workflow GET仍缺，静态合同通过不代表全部运行能力。EXE各版本升级/回退/原生操作按对应proof记录，不能传递为所有控件通过。NSIS6项仅guard，不证明干净用户完整首装。完整迁移和服务回退仍按各自缺口与实际证据判定，不能从客户端恢复或表指纹推定完成。",
  "",
  "依次执行 `node scripts/project-components/generate-coverage-matrix.mjs`、`node scripts/project-components/map-coverage-evidence.mjs`、`node scripts/project-components/generate-coverage-matrix.mjs`。生成器保留 matching ID 的人工结果和 `manual.surfaceProgress`；源码变更仍保留 `needsRevalidation`，不会自动清除未复核标记。此映射器只对明确识别的证据行赋值；其它人工结果保留。",
  "",
  "所有proof的SHA-256均按原始文件字节计算，见coverage-matrix.json的evidenceMapping.proofHashes。仅JSON解析或日志/正文文本断言使用UTF-8解码；JPG等二进制hash检查不解码。旧/修正公开proof与原生tree/截图均保留各自hash；缺少optional proof时不新增通过。所有凭据均不参与读取和输出。",
  "",
  `当前细目计数：${matrix.items.length}。设计明确的必要入口均满足而整行 passed 的基线：${
    matrix.items
      .filter((item) => item.kind === "baseline" && item.status === "passed")
      .map((item) => item.title)
      .join("、") || "无"
  }。其余基线不能称整体完成。`,
  "",
];
fs.writeFileSync(path.join(evidenceRoot, "coverage-mapping-review.md"), review.join("\n"));
console.log(
  JSON.stringify({
    mapped: matrix.items.filter((item) =>
      Object.values(item.results).some((result) => result.status !== "not_run"),
    ).length,
    failed: matrix.items
      .filter((item) => item.status === "failed")
      .map((item) => ({ id: item.id, title: item.title })),
  }),
);
