import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = path.join(root, "docs/evidence/project-components");
const matrixPath = path.join(evidenceRoot, "coverage-matrix.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
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
function record(item, surface, status, evidence, actual) {
  if (!item?.results[surface]?.applicable) return;
  if (status === "passed" && item.manual.surfaceProgress)
    delete item.manual.surfaceProgress[surface];
  Object.assign(item.results[surface], {
    status,
    evidence: [
      ...new Set(
        evidence.flatMap((reference) => {
          const [file, fragment] = reference.split("#", 2);
          const corrected = correctedEvidence.get(file);
          return corrected
            ? [reference, corrected + (fragment === undefined ? "" : "#" + fragment)]
            : [reference];
        }),
      ),
    ],
    actual,
    note: "Status describes the explicitly recorded cases. Other guards and complete cross-surface baselines remain independently required.",
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
  if (!item?.results[surface]?.applicable) return;
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
    if (prior?.note || item.manual.surfaceProgress?.[surface]) {
      const retained = {
        surface,
        status: prior?.status,
        note: prior?.note,
        actual: prior?.actual,
        evidence: prior?.evidence,
        progress: item.manual.surfaceProgress?.[surface] ?? null,
      };
      item.manual.retainedReviewNotes ??= [];
      if (
        !item.manual.retainedReviewNotes.some(
          (entry) => JSON.stringify(entry) === JSON.stringify(retained),
        )
      )
        item.manual.retainedReviewNotes.push(retained);
    }
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
