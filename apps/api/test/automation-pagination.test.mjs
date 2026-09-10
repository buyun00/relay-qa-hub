import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tsImport } from "tsx/esm/api";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";
import { createSqliteMobileAttachmentStore } from "../dist/sqlite-mobile-attachment-store.js";
import { createSqliteMobileCommentStore } from "../dist/sqlite-mobile-comment-store.js";
import { createSqliteMobileHumanWorkflowStore } from "../dist/sqlite-mobile-human-workflow-store.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test(
  "actual HTTP and SQLite paginate 501 comments and 101 bound attachments without scope or content loss",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-mcp-pagination-"));
    const evidenceRoot = join(root, "evidence"),
      quarantineRoot = join(root, "quarantine");
    await mkdir(evidenceRoot);
    await mkdir(quarantineRoot);
    const worker = new SqliteStorageWorker({
      databaseFile: join(root, "test.sqlite"),
      backupRoot: join(root, "backups"),
      busyTimeoutMs: 1000,
      evidenceRoot,
      quarantineRoot,
    });
    const accountId = randomUUID(),
      gmId = randomUUID(),
      projectId = randomUUID(),
      otherProjectId = randomUUID();
    const fixedDate = new Date();
    const now = () => fixedDate; // Equal comment timestamps exercise the ID tie-breaker on every page.
    const stamp = fixedDate.toISOString();
    let app;
    try {
      const bootstrap = {
        accountId,
        actorId: gmId,
        projectId,
        membershipId: projectMembershipId(projectId, gmId),
        projectKey: "PAGEA",
        actorDisplayName: "Pagination GM",
        createdAt: stamp,
      };
      await worker.ensureMobileScope(bootstrap);
      await worker.projectManagement({
        accountId,
        actorId: gmId,
        isGm: true,
        operation: "create",
        projectId: otherProjectId,
        key: "PAGEB",
        name: "Pagination B",
        now: stamp,
      });
      const management = new ProjectManagementService({ accountId, gmUserId: gmId, worker });
      const context = new ProjectRequestContext(),
        scope = context.scope(bootstrap);
      app = createApiApp({
        logger: false,
        isolateLegacyComponents: true,
        projectManagementService: management,
        projectRequestContext: context,
        automationPublicApiOrigin: "https://pagination.fixture.invalid",
        mobileBugStore: createSqliteMobileBugStore({ worker, scope, now }),
        mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({ worker, scope }),
        // Upload leases are validated against SQLite's real server clock, even
        // when the complete test suite runs concurrently for more than 5 seconds.
        mobileAttachmentStore: createSqliteMobileAttachmentStore({ worker, scope }),
        mobileCommentStore: createSqliteMobileCommentStore({ worker, scope, now }),
        mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({ worker, scope }),
        browserAuth: {
          store: createSqliteBrowserAuthStore({ worker }),
          accountId,
          userId: gmId,
          actorId: gmId,
          adminEmail: "pagination@fixture.invalid",
          passwordlessLogin: async () => {
            throw Error("Explicit project required");
          },
          projectLogin: (name, selected, timestamp) => management.login(name, selected, timestamp),
          sessionSecret: "isolated-pagination-test-secret",
          cookieName: "qa-pagination-fixture-session",
          webOrigins: [],
          gm: { userId: gmId, password: "isolated-pagination-gm" },
        },
      });
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      let token;
      const rpc = async (method, params, bearer = token) => {
        const response = await fetch(url + "/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const call = async (name, args, errorCode, bearer = token) => {
        const envelope = await rpc("tools/call", { name, arguments: args }, bearer);
        assert.equal(envelope.error, undefined);
        const result = envelope.result;
        const value = result.structuredContent ?? JSON.parse(result.content[0].text);
        assert.equal(result.isError, !!errorCode, `${name}: ${JSON.stringify(value)}`);
        if (errorCode) assert.equal(value.code, errorCode);
        return value;
      };
      const principal = await call("qa_login", { projectId, name: "Pagination author" });
      token = principal.accessToken;
      const reader = await call("qa_login", { projectId, name: "Pagination reader" });
      const other = await call("qa_login", {
        projectId: otherProjectId,
        name: "Pagination B reader",
      });
      const httpGet = async (path, selected = projectId, bearer = token) => {
        const response = await fetch(url + path, {
          headers: { authorization: `Bearer ${bearer}`, "x-qa-project-id": selected },
        });
        return { status: response.status, body: await response.json() };
      };
      const creationInput = (selected, submission, attachmentIds = []) => ({
        projectId: selected,
        submissionContractVersion: "1.1.0",
        clientSubmissionId: submission,
        title: "Historical pagination fixture",
        description: "All pages retain scope",
        expectedBehavior: "Every authorized record remains accessible",
        severity: "S3",
        priority: "P3",
        attachmentIds,
        occurrence: {
          observedAt: stamp,
          platform: "web",
          steps: ["Read pages"],
          actualBehavior: "Paginated",
        },
      });
      const emptyBug = async (selected, bearer) =>
        (
          await call(
            "qa_create_bug",
            { projectId: selected, request: creationInput(selected, randomUUID()) },
            undefined,
            bearer,
          )
        ).bug.id;
      const otherBugId = await emptyBug(otherProjectId, other.accessToken);
      const sameProjectBugId = await emptyBug(projectId, token);
      const submission = randomUUID(),
        attachmentIds = [];
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      );
      const sha256 = digest(bytes);
      for (let index = 0; index < 101; index++) {
        const clientAttachmentId = randomUUID();
        const common = {
          submissionContractVersion: "1.1.0",
          clientSubmissionId: submission,
          clientAttachmentId,
          uploadAttempt: 1,
        };
        const key = (action) =>
          `submission:${submission}:attachment:${clientAttachmentId}:upload:1:${action}`;
        const init = await call("qa_init_upload", {
          projectId,
          request: {
            ...common,
            projectId,
            filename: `page-${index}.png`,
            mediaType: "image/png",
            expectedSize: bytes.length,
            sha256,
          },
          idempotencyKey: key("init"),
        });
        const uploaded = await call("qa_put_upload_chunk", {
          projectId,
          sessionId: init.sessionId,
          chunkNumber: 0,
          expectedVersion: init.version,
          clientSubmissionId: submission,
          clientAttachmentId,
          bytesBase64: bytes.toString("base64"),
          chunkSha256: sha256,
          idempotencyKey: key("chunk:0"),
        });
        const finalized = await call("qa_finalize_upload", {
          projectId,
          sessionId: init.sessionId,
          request: {
            ...common,
            expectedVersion: uploaded.version,
            expectedSize: bytes.length,
            sha256,
          },
          idempotencyKey: key("finalize"),
        });
        await call("qa_bind_attachment", {
          projectId,
          attachmentId: finalized.attachmentId,
          request: {
            submissionContractVersion: "1.1.0",
            projectId,
            clientSubmissionId: submission,
            clientAttachmentId,
            leaseGeneration: 1,
            expectedVersion: finalized.version,
            intent: "bug_create",
          },
          idempotencyKey: `submission:${submission}:attachment:${clientAttachmentId}:bind:1`,
        });
        attachmentIds.push(finalized.attachmentId);
      }
      // A historical storage fixture exceeds the HTTP create-form's per-submit cap of 20.
      // All 101 files above passed real HTTP upload/finalize/reservation; this ordinary storage
      // transaction validates and claims each binding without SQL seeding or bypassing guards.
      const seed = creationInput(projectId, submission, attachmentIds);
      const created = await worker.createMobileBug({
        ...seed,
        accountId,
        actorId: principal.userId,
        payloadDigest: digest(JSON.stringify(seed)),
        ownerId: null,
        verificationOwnerId: null,
        captureBundleId: null,
        createdAt: new Date().toISOString(),
      });
      const bugId = created.bug.id;
      fixedDate.setTime(Date.now() + 1);
      const ordering = new DatabaseSync(join(root, "test.sqlite"), { readOnly: true });
      let orderedAttachmentIds;
      try {
        orderedAttachmentIds = ordering
          .prepare(
            "SELECT a.id FROM attachments AS a JOIN bug_attachments AS link ON link.attachment_id=a.id WHERE link.bug_id=? ORDER BY a.created_at,a.id",
          )
          .all(bugId)
          .map((row) => row.id);
      } finally {
        ordering.close();
      }
      assert.deepEqual(new Set(orderedAttachmentIds), new Set(attachmentIds));
      const commentIds = [];
      for (let index = 0; index < 501; index++) {
        const value = await call("qa_add_comment", {
          projectId,
          bugId,
          request: {
            clientSubmissionId: randomUUID(),
            body: index === 0 ? "long comment ".repeat(1000) : `comment ${index}`,
          },
        });
        commentIds.push(value.comment.id);
      }
      const identifiers = { projectId, bugId };
      const firstComments = await call("qa_list_comments", identifiers);
      assert.equal(firstComments.items.length, 100);
      assert.ok(firstComments.nextCursor);
      assert.ok(firstComments.nextCursor.length <= 500);
      await call(
        "qa_list_comments",
        {
          ...identifiers,
          query: { limit: 500 },
        },
        "INVALID_REQUEST",
      );
      const oversizedHttpComments = await httpGet(
        `/api/v1/projects/${projectId}/bugs/${bugId}/comments?limit=500`,
      );
      assert.equal(oversizedHttpComments.status, 400);
      assert.deepEqual(oversizedHttpComments.body, { code: "INVALID_REQUEST" });
      const commentPages = [firstComments],
        seenCommentCursors = new Set([firstComments.nextCursor]);
      let commentCursor = firstComments.nextCursor;
      while (commentCursor) {
        const page = await call("qa_list_comments", {
          ...identifiers,
          query: { limit: 100, cursor: commentCursor },
        });
        commentPages.push(page);
        commentCursor = page.nextCursor;
        if (commentCursor) {
          assert.equal(seenCommentCursors.has(commentCursor), false);
          seenCommentCursors.add(commentCursor);
        }
      }
      assert.equal(commentPages.length, 6);
      assert.equal(commentPages.at(-1).items.length, 1);
      assert.equal(commentPages.at(-1).nextCursor, null);
      assert.deepEqual(
        commentPages.flatMap((page) => page.items.map((item) => item.id)),
        commentIds.sort(),
      );
      const firstHttpComments = await httpGet(
        `/api/v1/projects/${projectId}/bugs/${bugId}/comments?limit=100`,
      );
      assert.equal(firstHttpComments.status, 200, JSON.stringify(firstHttpComments.body));
      assert.equal(firstHttpComments.body.items.length, 100);
      assert.ok(firstHttpComments.body.nextCursor);
      const secondHttpComments = await httpGet(
        `/api/v1/projects/${projectId}/bugs/${bugId}/comments?limit=100&cursor=${encodeURIComponent(firstHttpComments.body.nextCursor)}`,
      );
      assert.equal(secondHttpComments.status, 200, JSON.stringify(secondHttpComments.body));
      assert.deepEqual(
        secondHttpComments.body.items.map((item) => item.id),
        commentPages[1].items.map((item) => item.id),
      );
      const contextPage = await call("qa_get_bug_context", identifiers);
      assert.equal(contextPage.comments.items.length, 50);
      assert.ok(contextPage.comments.nextCursor);
      assert.ok(contextPage.comments.nextCursor.length <= 500);

      const firstAttachments = await call("qa_list_attachments", identifiers);
      assert.equal(firstAttachments.items.length, 50);
      assert.ok(firstAttachments.nextCursor);
      const collected = [],
        cursors = new Set();
      let cursor;
      do {
        const page = await call("qa_list_attachments", {
          ...identifiers,
          query: { limit: 37, ...(cursor ? { cursor } : {}) },
        });
        collected.push(...page.items.map((item) => item.attachmentId));
        cursor = page.nextCursor;
        if (cursor) {
          assert.equal(cursors.has(cursor), false);
          cursors.add(cursor);
        }
      } while (cursor);
      assert.deepEqual(collected, orderedAttachmentIds);
      const first100 = await httpGet(`/api/v1/bugs/${bugId}/attachments?limit=100`);
      assert.equal(first100.status, 200);
      assert.equal(first100.body.items.length, 100);
      const beyond100 = await httpGet(
        `/api/v1/bugs/${bugId}/attachments?limit=100&cursor=${first100.body.nextCursor}`,
      );
      assert.equal(beyond100.status, 200);
      assert.equal(beyond100.body.items.length, 1);
      assert.equal(beyond100.body.nextCursor, null);
      const lastAttachmentId = orderedAttachmentIds.at(-1);
      const specific = { ...identifiers, attachmentId: lastAttachmentId };
      const materialized = await call(
        "qa_materialize_attachment",
        specific,
        undefined,
        reader.accessToken,
      );
      const content = await call("qa_read_attachment", specific, undefined, reader.accessToken);
      assert.deepEqual(Buffer.from(content.blob, "base64"), bytes);
      assert.equal(content.sha256, sha256);
      const resource = await rpc(
        "resources/read",
        { uri: materialized.resource.uri },
        reader.accessToken,
      );
      assert.deepEqual(Buffer.from(resource.result.contents[0].blob, "base64"), bytes);
      await call(
        "qa_materialize_attachment",
        { ...specific, attachmentId: randomUUID() },
        "ATTACHMENT_NOT_BOUND_TO_BUG",
      );
      await call(
        "qa_materialize_attachment",
        { ...specific, projectId: otherProjectId, bugId: otherBugId },
        "ATTACHMENT_NOT_BOUND_TO_BUG",
        other.accessToken,
      );

      await call("qa_list_comments", { ...identifiers, query: { cursor: "" } }, "INVALID_REQUEST");
      for (const value of ["bad-cursor", firstAttachments.nextCursor])
        await call(
          "qa_list_comments",
          { ...identifiers, query: { cursor: value } },
          "INVALID_REQUEST",
        );
      for (const value of ["", "bad-cursor", firstComments.nextCursor])
        await call(
          "qa_list_attachments",
          { ...identifiers, query: { cursor: value } },
          "INVALID_CURSOR",
        );
      for (const [tool, savedCursor] of [
        ["qa_list_comments", firstComments.nextCursor],
        ["qa_list_attachments", firstAttachments.nextCursor],
      ]) {
        const expectedCursorError =
          tool === "qa_list_comments" ? "INVALID_REQUEST" : "INVALID_CURSOR";
        await call(
          tool,
          { projectId, bugId: sameProjectBugId, query: { cursor: savedCursor } },
          expectedCursorError,
        );
        await call(
          tool,
          { projectId: otherProjectId, bugId: otherBugId, query: { cursor: savedCursor } },
          expectedCursorError,
          other.accessToken,
        );
      }
      await call("qa_list_comments", { ...identifiers, query: { limit: 501 } }, "INVALID_REQUEST");
      await call(
        "qa_list_attachments",
        { ...identifiers, query: { limit: 101 } },
        "INVALID_REQUEST",
      );
      const revokedPage = await httpGet(
        `/api/v1/bugs/${bugId}/attachments?limit=1`,
        projectId,
        reader.accessToken,
      );
      assert.equal(revokedPage.status, 200);
      await worker.projectManagement({
        accountId,
        actorId: gmId,
        isGm: true,
        operation: "membership",
        projectId,
        userId: reader.userId,
        active: false,
        expectedVersion: 1,
        now: new Date().toISOString(),
      });
      const denied = await httpGet(
        `/api/v1/bugs/${bugId}/attachments?cursor=${revokedPage.body.nextCursor}`,
        projectId,
        reader.accessToken,
      );
      assert.ok([401, 403, 404].includes(denied.status));
      assert.equal(denied.body.items, undefined);

      // The same default deletion key must be used by server MCP, raw HTTP,
      // and the desktop's shared-tools bridge. No installed desktop is involved.
      const { QaHubMcpTools } = await tsImport("../../desktop/src/mcp-api.ts", import.meta.url);
      const shared = new QaHubMcpTools(
        {
          json: async (path, request = {}) => {
            const response = await fetch(url + path, {
              method: request.method ?? "GET",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            });
            const value = await response.json();
            if (!response.ok) throw Object.assign(new Error(value.code), { code: value.code });
            return value;
          },
          binary: async () => {
            throw new Error("Deletion must not download data");
          },
        },
        join(root, "unused-desktop-cache"),
        { sharedApi: true },
      );
      await shared.refreshDefinitions();
      const current = (await httpGet(`/api/v1/bugs/${bugId}`)).body;
      const deletionInput = { projectId, bugId, expectedVersion: current.version };
      const deleted = await call("qa_delete_bug", deletionInput);
      assert.equal(deleted.replayed, false);
      const replay = await fetch(url + `/api/v1/bugs/${bugId}?expectedVersion=${current.version}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          "x-qa-project-id": projectId,
          "idempotency-key": `web:deleteBug:bug:${bugId}:v${current.version}`,
        },
      });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).replayed, true);
      assert.equal((await shared.call("qa_delete_bug", deletionInput)).replayed, true);
      assert.equal((await call("qa_delete_bug", deletionInput)).replayed, true);
      await call(
        "qa_delete_bug",
        { ...deletionInput, expectedVersion: current.version + 1 },
        "NOT_FOUND",
      );
      assert.equal(
        (
          await shared.call("qa_delete_bug", {
            projectId,
            bugId: sameProjectBugId,
            expectedVersion: 1,
          })
        ).replayed,
        false,
      );
      for (const path of [
        `/api/v1/bugs/${bugId}`,
        `/api/v1/bugs/${bugId}/comments`,
        `/api/v1/bugs/${bugId}/attachments`,
        `/api/v1/bugs/${bugId}/attachments?cursor=${firstAttachments.nextCursor}`,
        `/api/v1/attachments/${lastAttachmentId}`,
      ])
        assert.equal((await httpGet(path)).status, 404, path);
      for (const name of ["qa_list_attachments", "qa_materialize_attachment", "qa_read_attachment"])
        await call(name, specific, "NOT_FOUND");
      const unavailable = await rpc("resources/read", { uri: materialized.resource.uri });
      assert.equal(unavailable.error.message, "NOT_FOUND");
      assert.equal(unavailable.result, undefined);
      const retained = new DatabaseSync(join(root, "test.sqlite"), { readOnly: true });
      try {
        assert.equal(
          retained.prepare("SELECT COUNT(*) AS total FROM bugs WHERE id=?").get(bugId).total,
          1,
        );
        assert.equal(
          retained
            .prepare("SELECT COUNT(*) AS total FROM bug_attachments WHERE bug_id=?")
            .get(bugId).total,
          101,
        );
        assert.equal(
          retained.prepare("SELECT COUNT(*) AS total FROM comments WHERE bug_id=?").get(bugId)
            .total,
          501,
        );
        const audit = retained.prepare("SELECT * FROM bug_deletions WHERE bug_id=?").all(bugId);
        assert.equal(audit.length, 1);
        assert.equal(audit[0].deleted_by_actor_id, principal.userId);
        assert.equal(audit[0].bug_version, current.version);
        assert.equal(audit[0].idempotency_key, `web:deleteBug:bug:${bugId}:v${current.version}`);
      } finally {
        retained.close();
      }
      assert.equal(
        digest(await readFile(join(evidenceRoot, "sha256", sha256.slice(0, 2), sha256))),
        sha256,
      );
    } finally {
      await app?.close();
      await worker.close();
    }
  },
);
