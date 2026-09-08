import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  MOBILE_CAPTURE_ALLOWED_METHODS,
  SqliteStorageWorker,
  projectMembershipId,
} from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";
import { createSqliteMobileAttachmentStore } from "../dist/sqlite-mobile-attachment-store.js";
import { createSqliteMobileCaptureStore } from "../dist/sqlite-mobile-capture-store.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("MCP capture artifacts use real HTTP, SQLite bindings, content validation and project isolation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-preview-mcp-capture-"));
  const evidenceRoot = join(root, "evidence");
  const quarantineRoot = join(root, "quarantine");
  const databaseFile = join(root, "test.sqlite");
  await mkdir(evidenceRoot);
  await mkdir(quarantineRoot);
  const worker = new SqliteStorageWorker({
    databaseFile,
    backupRoot: join(root, "backups"),
    busyTimeoutMs: 1000,
    evidenceRoot,
    quarantineRoot,
  });
  const accountId = randomUUID(),
    actorId = randomUUID(),
    projectId = randomUUID(),
    otherProjectId = randomUUID();
  let app;
  try {
    const bootstrap = {
      accountId,
      actorId,
      projectId,
      projectKey: "CAPA",
      actorDisplayName: "Capture fixture GM",
      membershipId: projectMembershipId(projectId, actorId),
      createdAt: new Date().toISOString(),
    };
    await worker.ensureMobileScope(bootstrap);
    await worker.projectManagement({
      accountId,
      actorId,
      isGm: true,
      operation: "create",
      projectId: otherProjectId,
      key: "CAPB",
      name: "Isolated capture B",
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
      automationPublicApiOrigin: "https://mcp-capture.fixture.invalid",
      mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
      mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({ worker, scope }),
      mobileAttachmentStore: createSqliteMobileAttachmentStore({ worker, scope }),
      mobileCaptureStore: createSqliteMobileCaptureStore({ worker, scope }),
      browserAuth: {
        store: createSqliteBrowserAuthStore({ worker }),
        accountId,
        userId: actorId,
        actorId,
        adminEmail: "capture@example.invalid",
        passwordlessLogin: async () => {
          throw Error("unscoped login");
        },
        projectLogin: (name, selected, stamp) => management.login(name, selected, stamp),
        sessionSecret: "isolated-capture-test-secret",
        cookieName: "qa-preview-capture-test-session",
        webOrigins: [],
        gm: { userId: actorId, password: "capture-test-gm-only" },
      },
    });
    let corruptTransport = false;
    // Keep the actual storage lookup and HTTP handler; inject transport corruption
    // only after their authorized read to independently test MCP's checksum guard.
    app.addHook("onSend", async (request, reply, payload) => {
      if (
        corruptTransport &&
        request.url.endsWith("/artifacts/poco_hierarchy") &&
        reply.statusCode === 200 &&
        Buffer.isBuffer(payload)
      ) {
        const changed = Buffer.from(payload);
        changed[changed.length - 1] ^= 1;
        return changed;
      }
      return payload;
    });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    let token,
      rpcId = 0;
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
      return response.json();
    };
    const call = async (name, args, expectedError, bearer = token) => {
      const result = (await rpc("tools/call", { name, arguments: args }, bearer)).result;
      const value = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.equal(result.isError, Boolean(expectedError), `${name}: ${JSON.stringify(value)}`);
      if (expectedError) assert.equal(value.code, expectedError);
      return value;
    };
    token = (await call("qa_login", { projectId, name: "Capture author" })).accessToken;
    const readerToken = (await call("qa_login", { projectId, name: "Capture reader" })).accessToken;
    const otherToken = (
      await call("qa_login", { projectId: otherProjectId, name: "Other project reader" })
    ).accessToken;
    const captureId = randomUUID(),
      clientSubmissionId = randomUUID();
    const upload = async (bytes, filename, mediaType, options = {}) => {
      const clientAttachmentId = randomUUID();
      const common = {
        submissionContractVersion: "1.1.0",
        clientSubmissionId,
        clientAttachmentId,
        uploadAttempt: 1,
      };
      const key = (suffix) =>
        `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:${suffix}`;
      const sha256 = digest(bytes);
      const session = await call("qa_init_upload", {
        projectId,
        request: {
          ...common,
          projectId,
          filename,
          mediaType,
          captureId,
          expectedSize: bytes.length,
          sha256,
        },
        idempotencyKey: key("init"),
      });
      const chunk = {
        projectId,
        sessionId: session.sessionId,
        chunkNumber: 0,
        expectedVersion: session.version,
        clientSubmissionId,
        clientAttachmentId,
        bytesBase64: bytes.toString("base64"),
        chunkSha256: sha256,
        idempotencyKey: key("chunk:0"),
      };
      if (options.rejectWrongHash)
        await call(
          "qa_put_upload_chunk",
          { ...chunk, chunkSha256: "0".repeat(64) },
          "INVALID_CHUNK",
        );
      const uploaded = await call("qa_put_upload_chunk", chunk);
      const result = await call(
        "qa_finalize_upload",
        {
          projectId,
          sessionId: session.sessionId,
          request: {
            ...common,
            expectedVersion: uploaded.version,
            expectedSize: bytes.length,
            sha256,
          },
          idempotencyKey: key("finalize"),
        },
        options.finalizeError,
      );
      return { ...common, ...result, sha256, bytes };
    };
    const primary = await upload(png, "capture-primary.png", "image/png", {
      rejectWrongHash: true,
    });
    const secondaryBytes = Buffer.from(
      JSON.stringify({ name: "CaptureRoot", children: [{ name: "Scoped button" }] }),
    );
    const secondary = await upload(secondaryBytes, "capture-hierarchy.json", "application/json");
    const capturedAt = new Date().toISOString();
    const captureRequest = {
      submissionContractVersion: "1.1.0",
      projectId,
      clientSubmissionId,
      capture: {
        captureId,
        clientSubmissionId,
        projectId,
        capturedAt,
        source: "overlay_single_tap",
        primaryEvidenceClientAttachmentId: primary.clientAttachmentId,
        primaryEvidenceAttachmentId: primary.attachmentId,
        artifacts: [
          [primary, "system_screenshot"],
          [secondary, "poco_hierarchy"],
        ].map(([attachment, kind]) => ({
          captureId,
          clientAttachmentId: attachment.clientAttachmentId,
          attachmentId: attachment.attachmentId,
          kind,
          status: "succeeded",
          startedAt: capturedAt,
          endedAt: capturedAt,
          skewMs: 0,
          truncated: false,
          failureReason: null,
        })),
        poco: {
          attempted: true,
          connectedPort: 5001,
          sdkVersion: "6",
          snapshotCapability: "standard_only",
          screenSize: null,
          allowedReadOnlyMethods: MOBILE_CAPTURE_ALLOWED_METHODS,
          negotiatedMethods: ["GetSDKVersion", "Dump"],
          succeededMethods: ["GetSDKVersion", "Dump"],
          failureReason: null,
        },
        deviceMetadata: {
          manufacturer: "Fixture",
          model: "No physical device",
          androidApi: 35,
          androidRelease: "15",
          qaAppVersion: "capture-test",
          networkType: "offline",
        },
      },
    };
    await call("qa_create_capture", {
      projectId,
      request: captureRequest,
      idempotencyKey: `submission:${clientSubmissionId}:capture:${captureId}`,
    });
    await call("qa_get_capture", { projectId, captureId }, "NOT_FOUND", readerToken);
    await call("qa_bind_attachment", {
      projectId,
      attachmentId: primary.attachmentId,
      request: {
        submissionContractVersion: "1.1.0",
        projectId,
        clientSubmissionId,
        clientAttachmentId: primary.clientAttachmentId,
        leaseGeneration: 1,
        expectedVersion: primary.version,
        intent: "bug_create",
      },
      idempotencyKey: `submission:${clientSubmissionId}:attachment:${primary.clientAttachmentId}:bind:1`,
    });
    const bugRequest = (submissionId) => ({
      submissionContractVersion: "1.1.0",
      clientSubmissionId: submissionId,
      title: "Capture MCP binding",
      description: "Secondary hierarchy is capture-only evidence",
      expectedBehavior: "Only readers of this Bug can read its capture",
      severity: "S3",
      priority: "P3",
      occurrence: {
        observedAt: capturedAt,
        platform: "android",
        steps: ["Synthetic test capture"],
        actualBehavior: "Read capture context",
      },
    });
    const created = await call("qa_create_bug", {
      projectId,
      request: {
        ...bugRequest(clientSubmissionId),
        attachmentIds: [primary.attachmentId],
        captureBundleId: captureId,
      },
    });
    const unrelated = await call("qa_create_bug", { projectId, request: bugRequest(randomUUID()) });
    const identifiers = { projectId, bugId: created.bug.id, attachmentId: secondary.attachmentId };
    const artifactPath = `/api/v1/bugs/${created.bug.id}/capture-bundles/${captureId}/artifacts/poco_hierarchy`;
    const headers = { authorization: `Bearer ${readerToken}`, "x-qa-project-id": projectId };

    await t.test(
      "secondary artifact fallback preserves exact bytes for another reader of the bound Bug",
      async () => {
        const capture = await call(
          "qa_get_capture",
          { projectId, captureId },
          undefined,
          readerToken,
        );
        assert.equal(capture.projectId, projectId);
        assert.equal(capture.primaryEvidenceAttachmentId, primary.attachmentId);
        const ordinary = await call(
          "qa_list_attachments",
          { projectId, bugId: created.bug.id },
          undefined,
          readerToken,
        );
        assert.equal(ordinary.items.length, 1);
        assert.equal(ordinary.items[0].attachmentId, primary.attachmentId);
        assert.equal(ordinary.items[0].captureId, captureId);
        assert.equal(ordinary.items[0].scanStatus, "clean");
        assert.equal(
          ordinary.items.some((item) => item.attachmentId === secondary.attachmentId),
          false,
        );
        const materialized = await call(
          "qa_materialize_attachment",
          identifiers,
          undefined,
          readerToken,
        );
        assert.equal(
          materialized.downloadUrl,
          "https://mcp-capture.fixture.invalid" + artifactPath,
        );
        const read = await call("qa_read_attachment", identifiers, undefined, readerToken);
        assert.equal(read.sha256, secondary.sha256);
        assert.equal(read.size, secondaryBytes.length);
        assert.equal(read.mimeType, "application/json");
        assert.deepEqual(Buffer.from(read.blob, "base64"), secondaryBytes);
        const resource = await rpc(
          "resources/read",
          { uri: materialized.resource.uri },
          readerToken,
        );
        assert.deepEqual(Buffer.from(resource.result.contents[0].blob, "base64"), secondaryBytes);
        const direct = await fetch(url + artifactPath, { headers });
        const ordinaryDownload = await fetch(
          url + `/api/v1/attachments/${secondary.attachmentId}`,
          { headers },
        );
        assert.equal(
          ordinaryDownload.status,
          404,
          "capture-only secondary artifacts require the Bug capture route",
        );
        assert.equal(direct.status, 200);
        assert.equal(direct.headers.get("x-content-sha256"), secondary.sha256);
        assert.deepEqual(Buffer.from(await direct.arrayBuffer()), secondaryBytes);
      },
    );

    await t.test(
      "wrong Bug, project, membership, resource URI and nested capture project cannot expose evidence",
      async () => {
        for (const name of ["qa_read_attachment", "qa_materialize_attachment"]) {
          await call(name, { ...identifiers, bugId: unrelated.bug.id }, "NOT_FOUND", readerToken);
          await call(name, { ...identifiers, projectId: otherProjectId }, "NOT_FOUND", otherToken);
        }
        await call(
          "qa_get_capture",
          { projectId: otherProjectId, captureId },
          "NOT_FOUND",
          otherToken,
        );
        await call(
          "qa_create_capture",
          {
            projectId,
            request: {
              ...captureRequest,
              capture: { ...captureRequest.capture, projectId: otherProjectId },
            },
            idempotencyKey: randomUUID(),
          },
          "CAPTURE_BUNDLE_INVALID",
        );
        const materialized = await call("qa_materialize_attachment", identifiers);
        const denied = await rpc("resources/read", { uri: materialized.resource.uri }, otherToken);
        assert.ok(denied.error);
        assert.equal(denied.result, undefined);
        assert.equal(
          (
            await rpc("resources/read", {
              uri: materialized.resource.uri.replace(projectId, "not-a-project"),
            })
          ).error.code,
          -32602,
        );
        const wrongBug = await fetch(url + artifactPath.replace(created.bug.id, unrelated.bug.id), {
          headers,
        });
        assert.equal(wrongBug.status, 404);
        const wrongProject = await fetch(url + artifactPath, {
          headers: { authorization: `Bearer ${otherToken}`, "x-qa-project-id": otherProjectId },
        });
        assert.equal(wrongProject.status, 404);
      },
    );

    await t.test(
      "only validated clean content is exposed; disk and transport checksum failures are rejected",
      async () => {
        const database = new DatabaseSync(databaseFile, { readOnly: true });
        try {
          assert.deepEqual(
            {
              ...database
                .prepare("SELECT status, scan_state FROM attachments WHERE id = ?")
                .get(secondary.attachmentId),
            },
            { status: "ready", scan_state: "clean" },
          );
        } finally {
          database.close();
        }
        await upload(Buffer.from("not a PNG image"), "invalid.png", "image/png", {
          finalizeError: "UPLOAD_CONTENT_INVALID",
        });
        const artifactFile = join(
          evidenceRoot,
          "sha256",
          secondary.sha256.slice(0, 2),
          secondary.sha256,
        );
        const saved = await readFile(artifactFile);
        try {
          const changed = Buffer.from(saved);
          changed[changed.length - 1] ^= 1;
          await writeFile(artifactFile, changed);
          await call("qa_read_attachment", identifiers, "ATTACHMENT_READ_FAILED", readerToken);
          assert.equal((await fetch(url + artifactPath, { headers })).status, 404);
        } finally {
          await writeFile(artifactFile, saved);
        }
        corruptTransport = true;
        try {
          await call("qa_read_attachment", identifiers, "ATTACHMENT_INTEGRITY_FAILED", readerToken);
          const failedResource = await rpc(
            "resources/read",
            { uri: `qa-hub://attachment/${projectId}/${created.bug.id}/${secondary.attachmentId}` },
            readerToken,
          );
          assert.equal(failedResource.error.message, "ATTACHMENT_INTEGRITY_FAILED");
          assert.equal(failedResource.result, undefined);
        } finally {
          corruptTransport = false;
        }
        assert.equal(
          (await call("qa_read_attachment", identifiers, undefined, readerToken)).sha256,
          secondary.sha256,
        );
      },
    );
    await t.test(
      "soft deletion denies capture metadata and raw artifacts while preserving stored evidence",
      async () => {
        const result = await call("qa_delete_bug", {
          projectId,
          bugId: created.bug.id,
          expectedVersion: created.bug.version,
        });
        assert.equal(result.replayed, false);
        await call("qa_get_capture", { projectId, captureId }, "NOT_FOUND", readerToken);
        await call("qa_materialize_attachment", identifiers, "NOT_FOUND", readerToken);
        await call("qa_read_attachment", identifiers, "NOT_FOUND", readerToken);
        assert.equal((await fetch(url + artifactPath, { headers })).status, 404);
        const database = new DatabaseSync(databaseFile, { readOnly: true });
        try {
          assert.equal(
            database
              .prepare("SELECT COUNT(*) AS total FROM capture_bundles WHERE id=?")
              .get(captureId).total,
            1,
          );
          assert.equal(
            database
              .prepare("SELECT COUNT(*) AS total FROM capture_artifacts WHERE capture_bundle_id=?")
              .get(captureId).total,
            2,
          );
          assert.equal(
            database
              .prepare("SELECT COUNT(*) AS total FROM bug_deletions WHERE bug_id=?")
              .get(created.bug.id).total,
            1,
          );
        } finally {
          database.close();
        }
        assert.equal(
          digest(
            await readFile(
              join(evidenceRoot, "sha256", secondary.sha256.slice(0, 2), secondary.sha256),
            ),
          ),
          secondary.sha256,
        );
      },
    );
  } finally {
    await app?.close();
    await worker.close();
  }
});
