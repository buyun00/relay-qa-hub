import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DesktopQaHubApiClient,
  QaHubMcpError,
  QaHubMcpTools,
  type QaHubApiTransport,
  type QaHubBinaryResponse,
  type QaHubJsonRequest,
} from "../src/mcp-api.js";
import { parseDesktopConfig } from "../src/config.js";
import { DesktopBrowserSessionCookieStore } from "../src/network.js";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000003";
const BUG_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "50000000-0000-4000-8000-000000000001";
const PRIMARY_ATTACHMENT_ID = "50000000-0000-4000-8000-000000000002";
const CAPTURE_ID = "60000000-0000-4000-8000-000000000001";

interface RecordedCall {
  readonly pathname: string;
  readonly request: QaHubJsonRequest;
}

class ScriptedApi implements QaHubApiTransport {
  readonly calls: RecordedCall[] = [];
  readonly responses = new Map<string, unknown[]>();
  readonly binaryCalls: string[] = [];
  binaryResponse: QaHubBinaryResponse = { bytes: new Uint8Array(), headers: new Headers() };

  queue(method: string, pathname: string, ...responses: unknown[]): void {
    this.responses.set(`${method} ${pathname}`, [...responses]);
  }

  async json(pathname: string, request: QaHubJsonRequest = {}): Promise<unknown> {
    const method = request.method ?? "GET";
    this.calls.push({ pathname, request });
    const queue = this.responses.get(`${method} ${pathname}`);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`Unexpected API call: ${method} ${pathname}`);
    }
    const response = queue.shift();
    if (response instanceof Error) throw response;
    return response;
  }

  async binary(pathname: string): Promise<QaHubBinaryResponse> {
    this.binaryCalls.push(pathname);
    return this.binaryResponse;
  }
}

function principal(): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    email: "developer@example.test",
    displayName: "开发者",
    csrfToken: "csrf",
  };
}

function bug(state: string, version: number, ownerId: string | null): Record<string, unknown> {
  return {
    id: BUG_ID,
    projectId: PROJECT_ID,
    number: 1,
    key: "LOCAL-1",
    title: "MCP test bug",
    description: "broken",
    expectedBehavior: "fixed",
    state,
    version,
    ownerId,
  };
}

test("qa_list_bugs defaults to current non-terminal items and can scope owner to me", async () => {
  const api = new ScriptedApi();
  api.queue("GET", "/api/v1/auth/me", principal());
  api.queue("GET", `/api/v1/bugs?limit=500&ownerId=${USER_ID}`, {
    snapshotSequence: 8,
    items: [bug("reported", 1, USER_ID), bug("closed", 2, USER_ID)],
    nextCursor: null,
  });
  const tools = new QaHubMcpTools(api, path.join(tmpdir(), "unused-qa-hub-cache"));
  const result = (await tools.call("qa_list_bugs", { owner: "me" })) as {
    count: number;
    items: readonly Record<string, unknown>[];
  };
  assert.equal(result.count, 1);
  assert.equal(result.items[0]?.["state"], "reported");
});

test("qa_resolve_qingyu_bug finds a QA Hub number and resolves its persisted Qingyu link", async () => {
  const api = new ScriptedApi();
  const selectedBug = { ...bug("closed", 9, USER_ID), number: 83, key: "LOCAL-83" };
  const link = {
    bugId: BUG_ID,
    defectId: "6715",
    defectCode: "BUG-6715",
    defectTitle: "按钮无响应",
    defectUrl: "https://qingyu.example.test/tasks/6715",
    syncStatus: "succeeded",
    externalStatus: "已解决",
    syncedAt: "2026-08-28T02:00:00.000Z",
  };
  api.queue("GET", "/api/v1/bugs?limit=500&q=83", {
    snapshotSequence: 9,
    items: [selectedBug],
    nextCursor: null,
  });
  api.queue("POST", `/api/v1/bugs/${BUG_ID}/integrations/qingyu/resolve`, {
    bug: selectedBug,
    link,
    alreadyResolved: false,
  });
  const tools = new QaHubMcpTools(api, path.join(tmpdir(), "unused-qa-hub-cache"));

  const result = (await tools.call("qa_resolve_qingyu_bug", { bugNumber: 83 })) as {
    defectId: string;
    externalStatus: string;
    qaHubStateChanged: boolean;
    outcome: string;
  };

  assert.equal(result.defectId, "6715");
  assert.equal(result.externalStatus, "已解决");
  assert.equal(result.qaHubStateChanged, false);
  assert.match(result.outcome, /6715.*已解决/u);
  const definition = tools.definitions.find((item) => item.name === "qa_resolve_qingyu_bug");
  assert.equal(definition?.annotations.openWorldHint, true);
  assert.equal(definition?.annotations.destructiveHint, true);
  const mutation = api.calls.find((call) => call.request.method === "POST");
  assert.equal(mutation?.pathname, `/api/v1/bugs/${BUG_ID}/integrations/qingyu/resolve`);
  assert.equal(mutation?.request.headers?.["Idempotency-Key"], `mcp:resolveQingyu:bug:${BUG_ID}`);
});

test("qa_begin_fix claims an unassigned Bug and follows the existing ready/attempt/start chain", async () => {
  const api = new ScriptedApi();
  api.queue("GET", "/api/v1/auth/me", principal());
  api.queue(
    "GET",
    `/api/v1/bugs/${BUG_ID}`,
    bug("reported", 1, null),
    bug("in_progress", 4, USER_ID),
  );
  api.queue(
    "GET",
    `/api/v1/bugs/${BUG_ID}/human-workflow`,
    { repairAttempt: null },
    {
      repairAttempt: {
        id: ATTEMPT_ID,
        bugId: BUG_ID,
        assigneeId: USER_ID,
        status: "running",
        version: 2,
      },
    },
  );
  api.queue("PATCH", `/api/v1/bugs/${BUG_ID}`, bug("reported", 2, USER_ID));
  api.queue("POST", `/api/v1/bugs/${BUG_ID}/transitions`, bug("ready", 3, USER_ID));
  api.queue("POST", `/api/v1/bugs/${BUG_ID}/repair-attempts`, {
    id: ATTEMPT_ID,
    bugId: BUG_ID,
    assigneeId: USER_ID,
    status: "planned",
    version: 1,
  });
  api.queue("POST", `/api/v1/repair-attempts/${ATTEMPT_ID}/start`, {
    id: ATTEMPT_ID,
    bugId: BUG_ID,
    assigneeId: USER_ID,
    status: "running",
    version: 2,
  });
  const tools = new QaHubMcpTools(api, path.join(tmpdir(), "unused-qa-hub-cache"));
  const result = (await tools.call("qa_begin_fix", { bugId: BUG_ID, summary: "修复空指针" })) as {
    bug: Record<string, unknown>;
    repairAttempt: Record<string, unknown>;
  };
  assert.equal(result.bug["state"], "in_progress");
  assert.equal(result.repairAttempt["status"], "running");
  const assign = api.calls.find((call) => call.request.method === "PATCH");
  assert.deepEqual(assign?.request.body, { expectedVersion: 1, ownerId: USER_ID });
});

test("qa_submit_fix records real validation evidence without requiring reporter confirmation", async () => {
  const api = new ScriptedApi();
  api.queue("GET", "/api/v1/auth/me", principal());
  api.queue("GET", `/api/v1/repair-attempts/${ATTEMPT_ID}`, {
    id: ATTEMPT_ID,
    bugId: BUG_ID,
    assigneeId: USER_ID,
    status: "running",
    version: 2,
  });
  api.queue("POST", `/api/v1/repair-attempts/${ATTEMPT_ID}/deliver`, {
    id: ATTEMPT_ID,
    bugId: BUG_ID,
    assigneeId: USER_ID,
    status: "delivered",
    version: 3,
    commitSha: "a".repeat(40),
  });
  api.queue("GET", `/api/v1/bugs/${BUG_ID}`, bug("awaiting_build", 5, USER_ID));
  api.queue("GET", `/api/v1/bugs/${BUG_ID}/human-workflow`, {
    repairAttempt: { id: ATTEMPT_ID, status: "delivered" },
    buildRequirement: { requirement: "required" },
  });
  const tools = new QaHubMcpTools(api, path.join(tmpdir(), "unused-qa-hub-cache"));
  const result = (await tools.call("qa_submit_fix", {
    attemptId: ATTEMPT_ID,
    summary: "修复空指针并补回归",
    validation: ["npm test -- --runInBand：通过"],
    branch: "codex/fix-local-1",
    commitSha: "a".repeat(40),
  })) as { bug: Record<string, unknown>; reporterConfirmationRequired: boolean };
  assert.equal(result.bug["state"], "awaiting_build");
  assert.equal(result.reporterConfirmationRequired, false);
  const delivery = api.calls.find((call) => call.pathname.endsWith("/deliver"));
  const deliveryBody = delivery?.request.body as { summary: string; deliveryKind: string };
  assert.equal(deliveryBody.deliveryKind, "code");
  assert.match(deliveryBody.summary, /QA Hub 未独立复验/u);
  assert.match(deliveryBody.summary, /npm test/u);
});

test("qa_materialize_attachment verifies SHA-256 before returning a local path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-mcp-test-"));
  try {
    const bytes = Buffer.from("verified attachment", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const api = new ScriptedApi();
    api.queue("GET", `/api/v1/bugs/${BUG_ID}`, bug("reported", 1, null));
    api.queue("GET", `/api/v1/bugs/${BUG_ID}/attachments?limit=50`, {
      items: [
        {
          attachmentId: ATTACHMENT_ID,
          filename: "evidence.txt",
          mediaType: "text/plain",
          size: bytes.length,
          sha256,
        },
      ],
    });
    api.binaryResponse = { bytes, headers: new Headers({ "content-type": "text/plain" }) };
    const tools = new QaHubMcpTools(api, root);
    const result = (await tools.call("qa_materialize_attachment", {
      bugId: BUG_ID,
      attachmentId: ATTACHMENT_ID,
    })) as { localPath: string; sha256: string };
    assert.equal(result.sha256, sha256);
    assert.equal(readFileSync(result.localPath, "utf8"), "verified attachment");
    assert.deepEqual(api.binaryCalls, [`/api/v1/attachments/${ATTACHMENT_ID}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function captureDownloadFixture(kind = "poco_snapshot", mediaType = "application/json") {
  const bytes = Buffer.from('{"data":{"recentLogs":[{"message":"captured error"}]}}');
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const api = new ScriptedApi();
  api.queue("GET", `/api/v1/bugs/${BUG_ID}`, bug("reported", 1, null));
  api.queue("GET", `/api/v1/bugs/${BUG_ID}/attachments?limit=50`, {
    items: [{ attachmentId: PRIMARY_ATTACHMENT_ID, captureId: CAPTURE_ID }],
  });
  const artifact = {
    attachmentId: ATTACHMENT_ID,
    captureId: CAPTURE_ID,
    kind,
    status: "succeeded",
  };
  const capture = {
    captureId: CAPTURE_ID,
    projectId: PROJECT_ID,
    primaryEvidenceAttachmentId: PRIMARY_ATTACHMENT_ID,
    artifacts: [artifact],
  };
  api.queue("GET", `/api/v1/capture-bundles/${CAPTURE_ID}`, capture);
  api.binaryResponse = {
    bytes,
    headers: new Headers({
      "content-type": mediaType,
      "content-length": String(bytes.length),
      "x-content-sha256": sha256,
    }),
  };
  return { api, capture, artifact, bytes, sha256 };
}

test("qa_materialize_attachment downloads capture-only evidence and reuses verified cache", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-mcp-capture-"));
  try {
    for (const [kind, mediaType, extension] of [
      ["poco_snapshot", "application/json", "json"],
      ["poco_hierarchy", "application/json", "json"],
      ["poco_profiling", "application/json", "json"],
      ["poco_screenshot", "image/jpeg", "jpg"],
    ]) {
      for (const cached of [false, true]) {
        const { api, bytes, sha256 } = captureDownloadFixture(kind, mediaType);
        const tools = new QaHubMcpTools(api, root);
        const result = (await tools.call("qa_materialize_attachment", {
          bugId: BUG_ID,
          attachmentId: ATTACHMENT_ID,
        })) as { localPath: string; filename: string; sha256: string; cached: boolean };
        assert.equal(result.cached, cached);
        assert.equal(result.filename, `capture-${CAPTURE_ID}-${kind}.${extension}`);
        assert.equal(result.sha256, sha256);
        assert.deepEqual(readFileSync(result.localPath), bytes);
        assert.deepEqual(api.binaryCalls, [
          `/api/v1/bugs/${BUG_ID}/capture-bundles/${CAPTURE_ID}/artifacts/${kind}`,
        ]);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture downloads reject unrelated, failed and inconsistent evidence before reading bytes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-mcp-capture-"));
  try {
    for (const scenario of ["unrelated", "failed", "project", "primary", "capture", "kind"]) {
      const { api, capture, artifact } = captureDownloadFixture();
      if (scenario === "unrelated") artifact.attachmentId = PRIMARY_ATTACHMENT_ID;
      if (scenario === "failed") artifact.status = "failed";
      if (scenario === "project") capture.projectId = BUG_ID;
      if (scenario === "primary") capture.primaryEvidenceAttachmentId = ATTACHMENT_ID;
      if (scenario === "capture") artifact.captureId = BUG_ID;
      if (scenario === "kind") artifact.kind = "../poco_snapshot";
      await assert.rejects(
        new QaHubMcpTools(api, root).call("qa_materialize_attachment", {
          bugId: BUG_ID,
          attachmentId: ATTACHMENT_ID,
        }),
        {
          code: ["unrelated", "failed"].includes(scenario)
            ? "ATTACHMENT_NOT_BOUND_TO_BUG"
            : "QA_HUB_INVALID_RESPONSE",
        },
        scenario,
      );
      assert.deepEqual(api.binaryCalls, []);
    }
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture downloads verify response size, SHA-256 and media type before caching", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-mcp-capture-"));
  try {
    for (const [header, value, code] of [
      ["content-length", "1", "ATTACHMENT_INTEGRITY_MISMATCH"],
      ["x-content-sha256", "0".repeat(64), "ATTACHMENT_INTEGRITY_MISMATCH"],
      ["content-type", "text/html", "QA_HUB_INVALID_RESPONSE"],
      ["content-length", "", "QA_HUB_INVALID_RESPONSE"],
    ]) {
      const { api } = captureDownloadFixture();
      api.binaryResponse.headers.set(header!, value!);
      await assert.rejects(
        new QaHubMcpTools(api, root).call("qa_materialize_attachment", {
          bugId: BUG_ID,
          attachmentId: ATTACHMENT_ID,
        }),
        { code },
      );
    }
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture lookup skips unavailable bundles but preserves authentication failures", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-mcp-capture-"));
  try {
    const missingCaptureId = "60000000-0000-4000-8000-000000000002";
    for (const status of [404, 401]) {
      const { api } = captureDownloadFixture();
      api.queue("GET", `/api/v1/bugs/${BUG_ID}/attachments?limit=50`, {
        items: [
          { attachmentId: PRIMARY_ATTACHMENT_ID, captureId: missingCaptureId },
          { attachmentId: PRIMARY_ATTACHMENT_ID, captureId: CAPTURE_ID },
        ],
      });
      api.queue(
        "GET",
        `/api/v1/capture-bundles/${missingCaptureId}`,
        new QaHubMcpError("READ_FAILED", "read failed", status),
      );
      const operation = new QaHubMcpTools(api, root).call("qa_materialize_attachment", {
        bugId: BUG_ID,
        attachmentId: ATTACHMENT_ID,
      });
      if (status === 404) {
        await operation;
        assert.equal(api.binaryCalls.length, 1);
      } else {
        await assert.rejects(operation, { code: "READ_FAILED", status: 401 });
        assert.equal(api.binaryCalls.length, 0);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop MCP silently replaces a rejected browser session from the permanent identity", async () => {
  const config = parseDesktopConfig({});
  const browserSession = new DesktopBrowserSessionCookieStore();
  const staleToken = "A".repeat(43);
  const permanentToken = "B".repeat(43);
  browserSession.restoreLoginName("开发者");
  browserSession.captureSetCookie(`qa_hub_browser_session=${staleToken}; Path=/; HttpOnly`);
  const calls: Array<{ readonly pathname: string; readonly cookie: string | null }> = [];
  let renewed = 0;
  let bugRequestCount = 0;
  const client = new DesktopQaHubApiClient(
    config,
    browserSession,
    async (input, init) => {
      const pathname = new URL(input.toString()).pathname;
      const cookie = new Headers(init?.headers).get("cookie");
      calls.push({ pathname, cookie });
      if (pathname === "/api/v1/auth/login") {
        return new Response(JSON.stringify(principal()), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `qa_hub_browser_session=${permanentToken}; Path=/; HttpOnly; Max-Age=2147483647`,
          },
        });
      }
      bugRequestCount += 1;
      return bugRequestCount === 1
        ? new Response(JSON.stringify({ code: "NATIVE_SESSION_INVALID" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ snapshotSequence: 1, items: [], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    },
    () => {
      renewed += 1;
    },
  );

  assert.deepEqual(await client.json("/api/v1/bugs?limit=1"), {
    snapshotSequence: 1,
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(calls, [
    {
      pathname: "/api/v1/bugs",
      cookie: `qa_hub_browser_session=${staleToken}`,
    },
    { pathname: "/api/v1/auth/login", cookie: null },
    {
      pathname: "/api/v1/bugs",
      cookie: `qa_hub_browser_session=${permanentToken}`,
    },
  ]);
  assert.equal(renewed, 1);
});
