import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  QaHubMcpTools,
  type QaHubApiTransport,
  type QaHubBinaryResponse,
  type QaHubJsonRequest,
} from "../src/mcp-api.js";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000003";
const BUG_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "50000000-0000-4000-8000-000000000001";

interface RecordedCall {
  readonly pathname: string;
  readonly request: QaHubJsonRequest;
}

class ScriptedApi implements QaHubApiTransport {
  readonly calls: RecordedCall[] = [];
  readonly responses = new Map<string, unknown[]>();
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
    return queue.shift();
  }

  async binary(): Promise<QaHubBinaryResponse> {
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

test("qa_submit_fix records real validation evidence and leaves human acceptance required", async () => {
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
  })) as { bug: Record<string, unknown>; humanAcceptanceRequired: boolean };
  assert.equal(result.bug["state"], "awaiting_build");
  assert.equal(result.humanAcceptanceRequired, true);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
