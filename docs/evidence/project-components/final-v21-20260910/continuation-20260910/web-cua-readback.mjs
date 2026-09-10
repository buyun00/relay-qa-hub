import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = realpathSync(resolve(evidenceRoot, "../../../../.."));
const configPath = resolve(process.argv[2] ?? "");
const projectId = process.argv[3];
const name = process.argv[4];
const expectedTitle = process.argv[5];
const expectedComment = process.argv[6];

if (!configPath || !/^[0-9a-f-]{36}$/iu.test(projectId ?? "") || !name) {
  throw new Error(
    "Usage: node web-cua-readback.mjs <instance.json> <project-id> <name> <title> <comment>",
  );
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
if (
  config.instanceId !== "qa-hub-preview-v21-e2e-fresh-0910" ||
  realpathSync(config.sourceRoot) !== sourceRoot ||
  config.apiHost !== "127.0.0.1" ||
  config.apiPort !== 4639
) {
  throw new Error("ISOLATED_PREVIEW_BOUNDARY_MISMATCH");
}

const apiOrigin = `http://${config.apiHost}:${config.apiPort}`;
const webOrigin = `http://${config.webHost}:${config.webPort}`;
let accessToken;
const ledger = [];

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/token|secret|password|cookie|authorization|csrf/iu.test(key))
      .map(([key, item]) => [key, scrub(item)]),
  );
}

async function request(label, method, path, { body, project = projectId, expected = 200 } = {}) {
  const response = await fetch(apiOrigin + path, {
    method,
    headers: {
      accept: "application/vnd.relay-qa-hub.v1.1+json",
      origin: webOrigin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(project ? { "x-qa-project-id": project } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json().catch(() => null);
  ledger.push({
    label,
    method,
    path,
    projectId: project,
    expectedStatus: expected,
    status: response.status,
    passed: response.status === expected,
    response: scrub(value),
  });
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
  }
  return value;
}

const session = await request("same-name API readback login", "POST", "/api/v1/auth/login", {
  body: { name, projectId, client: "android" },
  project: null,
});
accessToken = session.accessToken;
if (!accessToken || session.projectId !== projectId) throw new Error("READBACK_LOGIN_FAILED");

const projects = await request("project directory readback", "GET", "/api/v1/projects");
if (projects.items?.length !== 1 || projects.items[0]?.id !== projectId) {
  throw new Error("PROJECT_DIRECTORY_SCOPE_MISMATCH");
}

const bugs = await request(
  "UI-created Bug list readback",
  "GET",
  `/api/v1/bugs?projectId=${projectId}&limit=100`,
);
const bug = bugs.items?.find((item) => item.title === expectedTitle);
if (!bug) throw new Error("UI_CREATED_BUG_NOT_FOUND");

const detail = await request("UI-edited Bug detail readback", "GET", `/api/v1/bugs/${bug.id}`);
const comments = await request(
  "UI-created comment readback",
  "GET",
  `/api/v1/bugs/${bug.id}/comments`,
);
const events = await request("UI event history readback", "GET", `/api/v1/bugs/${bug.id}/events`);
const components = await request(
  "project component scope readback",
  "GET",
  `/api/v1/projects/${projectId}/components`,
);

if (detail.projectId !== projectId || detail.title !== expectedTitle || detail.version < 3) {
  throw new Error("BUG_DETAIL_READBACK_MISMATCH");
}
if (!comments.items?.some((comment) => comment.body === expectedComment)) {
  throw new Error("COMMENT_READBACK_MISMATCH");
}
if (!events.items?.some((event) => event.type === "bug.updated")) {
  throw new Error("BUG_UPDATE_EVENT_MISSING");
}
if (!events.items?.some((event) => event.type === "comment.created")) {
  throw new Error("COMMENT_EVENT_MISSING");
}
if (components.items?.length !== 5) throw new Error("COMPONENT_DIRECTORY_MISMATCH");

const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
const productSourceCommit = execFileSync(
  "git",
  [
    "log",
    "-1",
    "--format=%H",
    "--",
    "apps/api/src",
    "apps/web/src",
    "apps/desktop/src",
    "apps/android/app/src/main",
    "packages/domain/src",
    "packages/storage/src",
  ],
  { cwd: sourceRoot, encoding: "utf8" },
).trim();
const sourceDiff = execFileSync(
  "git",
  [
    "status",
    "--porcelain=v1",
    "--",
    "apps/api/src",
    "apps/web/src",
    "apps/desktop/src",
    "apps/android/app/src/main",
    "packages/domain/src",
    "packages/storage/src",
  ],
  { cwd: sourceRoot, encoding: "utf8" },
).trim();
if (sourceDiff) throw new Error("PRODUCT_SOURCE_DIRTY_DURING_READBACK");

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  passed: ledger.every((entry) => entry.passed),
  instance: {
    instanceId: config.instanceId,
    apiOrigin,
    webOrigin,
    loopbackOnly: config.apiHost === "127.0.0.1" && config.webHost === "127.0.0.1",
  },
  source: {
    head: currentHead,
    productSourceCommit,
    productSourceDirty: false,
  },
  browserObservation: {
    driver: "Codex in-app browser",
    projectId,
    actorName: name,
    actions: [
      "resolved the OZDQP project entry and completed simple-name login",
      "opened the real new-Bug dialog and submitted the unique marker",
      "assigned the Bug through the detail dialog",
      "edited the title and observed the success notification",
      "expanded the event history and submitted the unique comment marker",
    ],
    visibleReceipts: [
      "Bug 已创建并同步到统一后端",
      "分配已更新",
      "LOCAL-4 的 Bug 详情已更新",
      "处理记录已添加",
    ],
  },
  readback: {
    projectCount: projects.items.length,
    bug: {
      id: detail.id,
      key: detail.key,
      projectId: detail.projectId,
      title: detail.title,
      state: detail.state,
      version: detail.version,
      assigneeId: detail.assigneeId,
      closerId: detail.closerId,
    },
    matchingCommentCount: comments.items.filter((comment) => comment.body === expectedComment)
      .length,
    eventTypes: events.items.map((event) => event.type),
    componentCount: components.items.length,
  },
  credentialsPersisted: false,
  ledger,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (/accessToken|csrfToken|authorization|set-cookie/iu.test(serialized)) {
  throw new Error("PUBLIC_EVIDENCE_CREDENTIAL_FIELD_DETECTED");
}
report.sha256WithoutSelf = createHash("sha256").update(serialized).digest("hex");
const output = join(evidenceRoot, "web-cua-readback.json");
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({
    passed: report.passed,
    output,
    bugId: report.readback.bug.id,
    bugKey: report.readback.bug.key,
    version: report.readback.bug.version,
    comments: report.readback.matchingCommentCount,
  }),
);
