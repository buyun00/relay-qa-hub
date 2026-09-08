import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";
import { createSqliteMobileAttachmentStore } from "../dist/sqlite-mobile-attachment-store.js";
import { createSqliteMobileCaptureStore } from "../dist/sqlite-mobile-capture-store.js";

test("actual MCP HTTP and SQLite: attachment upload, resource read, project isolation and API parity", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-preview-mcp-integration-"));
  const evidenceRoot = join(root, "evidence");
  const quarantineRoot = join(root, "quarantine");
  await mkdir(evidenceRoot);
  await mkdir(quarantineRoot);
  const worker = new SqliteStorageWorker({
    databaseFile: join(root, "test.sqlite"),
    backupRoot: join(root, "backups"),
    busyTimeoutMs: 1000,
    evidenceRoot,
    quarantineRoot,
  });
  const accountId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const bId = randomUUID();
  let app;
  try {
    const bootstrap = {
      accountId,
      actorId,
      projectId,
      projectKey: "MCPA",
      actorDisplayName: "测试GM",
      membershipId: projectMembershipId(projectId, actorId),
      createdAt: new Date().toISOString(),
    };
    await worker.ensureMobileScope(bootstrap);
    await worker.projectManagement({
      accountId,
      actorId,
      isGm: true,
      operation: "create",
      projectId: bId,
      key: "MCPB",
      name: "隔离B",
      now: new Date().toISOString(),
    });
    const management = new ProjectManagementService({ accountId, gmUserId: actorId, worker });
    const context = new ProjectRequestContext();
    const scope = context.scope(bootstrap);
    app = createApiApp({
      logger: false,
      isolateLegacyComponents: true,
      projectManagementService: management,
      projectRequestContext: context,
      automationPublicApiOrigin: "http://127.0.0.1:4419",
      mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
      mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({ worker, scope }),
      mobileAttachmentStore: createSqliteMobileAttachmentStore({ worker, scope }),
      mobileCaptureStore: createSqliteMobileCaptureStore({ worker, scope }),
      browserAuth: {
        store: createSqliteBrowserAuthStore({ worker }),
        accountId,
        userId: actorId,
        actorId,
        adminEmail: "test@example.invalid",
        passwordlessLogin: async () => {
          throw Error("unscoped login");
        },
        projectLogin: (name, selected, stamp) => management.login(name, selected, stamp),
        sessionSecret: "isolated-mcp-test-secret",
        cookieName: "qa-preview-mcp-test-session",
        webOrigins: [],
        gm: { userId: actorId, password: "test-gm-only" },
      },
    });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    let token;
    let rpcId = 0;
    const rpc = async (method, params, bearer = token) => {
      const response = await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      assert.equal(response.status, 200);
      return await response.json();
    };
    const call = async (name, args, expectedError, bearer = token) => {
      const result = (await rpc("tools/call", { name, arguments: args }, bearer)).result;
      const value = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.equal(result.isError, Boolean(expectedError), JSON.stringify(value));
      if (expectedError) assert.equal(value.code, expectedError);
      return value;
    };
    const catalog = (await rpc("tools/list", {})).result.tools;
    assert.ok(catalog.length >= 80);
    assert.equal(new Set(catalog.map((item) => item.name)).size, catalog.length);
    token = (await call("qa_login", { projectId, name: "附件测试员工" })).accessToken;
    const bToken = (await call("qa_login", { projectId: bId, name: "另一项目员工" })).accessToken;
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const clientSubmissionId = randomUUID();
    const clientAttachmentId = randomUUID();
    const common = {
      submissionContractVersion: "1.1.0",
      clientSubmissionId,
      clientAttachmentId,
      uploadAttempt: 1,
    };
    const key = (suffix) =>
      `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:${suffix}`;
    const init = await call("qa_init_upload", {
      projectId,
      request: {
        ...common,
        projectId,
        filename: "mcp-test.png",
        mediaType: "image/png",
        expectedSize: bytes.length,
        sha256,
      },
      idempotencyKey: key("init"),
    });
    const chunk = {
      projectId,
      sessionId: init.sessionId,
      chunkNumber: 0,
      expectedVersion: init.version,
      clientSubmissionId,
      clientAttachmentId,
      bytesBase64: bytes.toString("base64"),
      chunkSha256: sha256,
      idempotencyKey: key("chunk:0"),
    };
    await call("qa_put_upload_chunk", { ...chunk, chunkSha256: "0".repeat(64) }, "INVALID_CHUNK");
    const uploaded = await call("qa_put_upload_chunk", chunk);
    assert.equal((await call("qa_put_upload_chunk", chunk)).version, uploaded.version);
    const finalized = await call("qa_finalize_upload", {
      projectId,
      sessionId: init.sessionId,
      request: { ...common, expectedVersion: uploaded.version, expectedSize: bytes.length, sha256 },
      idempotencyKey: key("finalize"),
    });
    await call("qa_bind_attachment", {
      projectId,
      attachmentId: finalized.attachmentId,
      request: {
        submissionContractVersion: "1.1.0",
        projectId,
        clientSubmissionId,
        clientAttachmentId,
        leaseGeneration: 1,
        expectedVersion: finalized.version,
        intent: "bug_create",
      },
      idempotencyKey: `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:bind:1`,
    });
    const created = await call("qa_create_bug", {
      projectId,
      request: {
        submissionContractVersion: "1.1.0",
        clientSubmissionId,
        title: "MCP 附件真实上传",
        description: "校验绑定及资源",
        expectedBehavior: "跨项目不可读取",
        severity: "S3",
        priority: "P3",
        attachmentIds: [finalized.attachmentId],
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["真实上传"],
          actualBehavior: "读取",
        },
      },
    });
    const identifiers = { projectId, bugId: created.bug.id, attachmentId: finalized.attachmentId };
    const materialized = await call("qa_materialize_attachment", identifiers);
    assert.match(materialized.resource.uri, /^qa-hub:\/\/attachment\//u);
    const resource = await rpc("resources/read", { uri: materialized.resource.uri });
    assert.deepEqual(Buffer.from(resource.result.contents[0].blob, "base64"), bytes);
    const downloaded = await fetch(url + `/api/v1/attachments/${finalized.attachmentId}`, {
      headers: { authorization: `Bearer ${token}`, "x-qa-project-id": projectId },
    });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    await call("qa_read_attachment", { ...identifiers, projectId: bId }, "NOT_FOUND", bToken);
    assert.ok((await rpc("resources/read", { uri: materialized.resource.uri }, bToken)).error);
    assert.equal(
      (
        await rpc("resources/read", {
          uri: "file:///D:/Relay-QA-Hub-Data/production/db/qa-hub.sqlite",
        })
      ).error.code,
      -32602,
    );
    await call(
      "qa_update_project",
      { projectId, request: { expectedVersion: 1, active: false } },
      "FORBIDDEN",
    );
  } finally {
    await app?.close();
    await worker.close();
  }
});
