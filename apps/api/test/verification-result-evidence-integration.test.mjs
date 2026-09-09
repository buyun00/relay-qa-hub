import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  MOBILE_CAPTURE_ALLOWED_METHODS,
  SqliteStorageWorker,
  projectMembershipId,
} from "@relay-qa-hub/storage";
import { createApiApp } from "../dist/app.js";
import { createSqliteBrowserAuthStore } from "../dist/browser-auth.js";
import { ProjectManagementService } from "../dist/project-management.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileAttachmentStore } from "../dist/sqlite-mobile-attachment-store.js";
import { createSqliteMobileBugStore } from "../dist/sqlite-mobile-bug-store.js";
import { createSqliteMobileCaptureStore } from "../dist/sqlite-mobile-capture-store.js";
import { createSqliteMobileHumanWorkflowStore } from "../dist/sqlite-mobile-human-workflow-store.js";
import { createSqliteMobileRelayStore } from "../dist/sqlite-mobile-relay-store.js";
import { createSqliteMobileVerificationStore } from "../dist/sqlite-mobile-verification-store.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("server MCP commits captured Verification evidence through real HTTP and schema 19 storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qa-verification-evidence-http-"));
  const evidenceRoot = join(root, "evidence");
  const quarantineRoot = join(root, "quarantine");
  const databaseFile = join(root, "qa-hub.sqlite");
  await Promise.all([mkdir(evidenceRoot), mkdir(quarantineRoot)]);
  const worker = new SqliteStorageWorker({
    databaseFile,
    backupRoot: join(root, "backups"),
    busyTimeoutMs: 5_000,
    evidenceRoot,
    quarantineRoot,
  });
  const accountId = randomUUID();
  const gmUserId = randomUUID();
  const projectId = randomUUID();
  const bootstrap = {
    accountId,
    actorId: gmUserId,
    projectId,
    projectKey: "EVHTTP",
    actorDisplayName: "Evidence fixture GM",
    membershipId: projectMembershipId(projectId, gmUserId),
    createdAt: new Date().toISOString(),
  };
  let app;
  let requestCount = 0;
  try {
    await worker.ensureMobileScope(bootstrap);
    assert.equal((await worker.initialization).migration.toVersion, 19);
    const management = new ProjectManagementService({ accountId, gmUserId, worker });
    const context = new ProjectRequestContext();
    const scope = context.scope(bootstrap);
    app = createApiApp({
      logger: false,
      isolateLegacyComponents: true,
      automationPublicApiOrigin: "https://evidence.fixture.invalid",
      projectManagementService: management,
      projectRequestContext: context,
      mobileAttachmentStore: createSqliteMobileAttachmentStore({ worker, scope }),
      mobileBugStore: createSqliteMobileBugStore({ worker, scope }),
      mobileCaptureStore: createSqliteMobileCaptureStore({ worker, scope }),
      mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({ worker, scope }),
      mobileRelayStore: createSqliteMobileRelayStore({
        worker,
        scope,
        relayDispatchEnabled: false,
      }),
      mobileVerificationStore: createSqliteMobileVerificationStore({ worker, scope }),
      browserAuth: {
        store: createSqliteBrowserAuthStore({ worker }),
        accountId,
        userId: gmUserId,
        actorId: gmUserId,
        adminEmail: "unused@example.invalid",
        passwordlessLogin: async () => {
          throw new Error("Project selection is required");
        },
        projectLogin: (name, selected, stamp) => management.login(name, selected, stamp),
        sessionSecret: "verification-evidence-integration-only",
        webOrigins: [],
        gm: { userId: gmUserId, password: "verification-evidence-gm-only" },
      },
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    assert(![4174, 4274, 4319, 4320, 4419, 4420, 4421].includes(Number(new URL(origin).port)));
    let token;
    let rpcId = 0;
    const call = async (name, argumentsValue) => {
      requestCount++;
      const response = await fetch(origin + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: { name, arguments: argumentsValue },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200);
      const envelope = await response.json();
      const result = envelope.result;
      const value = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.equal(result.isError, false, `${name}: ${JSON.stringify(value)}`);
      return value;
    };
    token = (await call("qa_login", { projectId, name: "Evidence verifier" })).accessToken;
    const actorId = (await call("qa_get_session", {})).userId;
    const bugSubmissionId = randomUUID();
    const created = await call("qa_create_bug", {
      projectId,
      request: {
        submissionContractVersion: "1.1.0",
        clientSubmissionId: bugSubmissionId,
        projectId,
        title: "Captured verification evidence",
        description: "The result must own its exact retained capture",
        expectedBehavior: "Evidence remains bound to this verification",
        severity: "S2",
        priority: "P2",
        attachmentIds: [],
        ownerId: actorId,
        verificationOwnerId: actorId,
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["Run the isolated integration fixture"],
          actualBehavior: "Evidence is pending",
        },
      },
    });
    const bugId = created.bug.id;
    const action = async (name, expectedVersion, extra = {}) =>
      call("qa_bug_action", {
        projectId,
        bugId,
        action: name,
        expectedVersion,
        idempotencyKey: `evidence:${name}:${bugId}:${expectedVersion}`,
        ...extra,
      });
    const ready = await action("ready", created.bug.version);
    const planned = await action("plan_fix", ready.bug.version, {
      request: { assigneeId: actorId, summary: "Verify captured evidence" },
    });
    const attemptId = planned.result.id;
    const started = await action("begin_fix", planned.result.version, { attemptId });
    const delivered = await action("submit_fix", started.result.version, {
      attemptId,
      request: {
        deliveryKind: "no_code",
        noCodeReason: "The fixture validates retained evidence",
        summary: "Ready for verification",
      },
    });
    const createdVerification = await action("create_verification", delivered.bug.version, {
      request: {
        repairAttemptId: attemptId,
        buildId: null,
        verifierId: actorId,
        criteria: "Captured PNG is retained with the result",
      },
    });
    const verificationId = createdVerification.result.id;
    const startedVerification = await action(
      "start_verification",
      createdVerification.result.version,
      { verificationId },
    );

    const clientSubmissionId = randomUUID();
    const captureId = randomUUID();
    const uploaded = [];
    for (const [index, bytes] of [png, Buffer.concat([png, Buffer.from([0])])].entries()) {
      const clientAttachmentId = randomUUID();
      const common = {
        submissionContractVersion: "1.1.0",
        clientSubmissionId,
        clientAttachmentId,
        uploadAttempt: 1,
      };
      const key = (suffix) =>
        `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:${suffix}`;
      const contentSha = sha256(bytes);
      const session = await call("qa_init_upload", {
        projectId,
        request: {
          ...common,
          projectId,
          filename: `verification-${index + 1}.png`,
          mediaType: "image/png",
          captureId,
          expectedSize: bytes.length,
          sha256: contentSha,
        },
        idempotencyKey: key("init"),
      });
      const chunk = await call("qa_put_upload_chunk", {
        projectId,
        sessionId: session.sessionId,
        chunkNumber: 0,
        expectedVersion: session.version,
        clientSubmissionId,
        clientAttachmentId,
        bytesBase64: bytes.toString("base64"),
        chunkSha256: contentSha,
        idempotencyKey: key("chunk:0"),
      });
      const attachment = await call("qa_finalize_upload", {
        projectId,
        sessionId: session.sessionId,
        request: {
          ...common,
          expectedVersion: chunk.version,
          expectedSize: bytes.length,
          sha256: contentSha,
        },
        idempotencyKey: key("finalize"),
      });
      uploaded.push({ ...attachment, clientAttachmentId, bytes, sha256: contentSha });
    }
    const capturedAt = new Date().toISOString();
    await call("qa_create_capture", {
      projectId,
      request: {
        submissionContractVersion: "1.1.0",
        projectId,
        clientSubmissionId,
        capture: {
          captureId,
          clientSubmissionId,
          projectId,
          capturedAt,
          source: "overlay_single_tap",
          primaryEvidenceClientAttachmentId: uploaded[0].clientAttachmentId,
          primaryEvidenceAttachmentId: uploaded[0].attachmentId,
          artifacts: uploaded.map((attachment, index) => ({
            captureId,
            clientAttachmentId: attachment.clientAttachmentId,
            attachmentId: attachment.attachmentId,
            kind: index === 0 ? "system_screenshot" : "poco_screenshot",
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
            sdkVersion: "fixture",
            snapshotCapability: "standard_only",
            screenSize: null,
            allowedReadOnlyMethods: MOBILE_CAPTURE_ALLOWED_METHODS,
            negotiatedMethods: ["GetSDKVersion", "Screenshot"],
            succeededMethods: ["GetSDKVersion", "Screenshot"],
            failureReason: null,
          },
          deviceMetadata: {
            manufacturer: "Fixture",
            model: "Isolated HTTP",
            androidApi: 35,
            androidRelease: "15",
            qaAppVersion: "verification-evidence-test",
            networkType: "offline",
          },
        },
      },
      idempotencyKey: `submission:${clientSubmissionId}:capture:${captureId}`,
    });
    for (const attachment of uploaded) {
      await call("qa_bind_attachment", {
        projectId,
        attachmentId: attachment.attachmentId,
        request: {
          submissionContractVersion: "1.1.0",
          projectId,
          clientSubmissionId,
          clientAttachmentId: attachment.clientAttachmentId,
          leaseGeneration: 1,
          expectedVersion: attachment.version,
          intent: "verification_result",
          targetQaItemId: bugId,
        },
        idempotencyKey: `submission:${clientSubmissionId}:attachment:${attachment.clientAttachmentId}:bind:1`,
      });
    }
    const resultRequest = {
      submissionContractVersion: "1.1.0",
      clientSubmissionId,
      expectedVersion: startedVerification.result.version,
      status: "passed",
      resultSummary: "Captured evidence verified",
      attachmentIds: uploaded.map(({ attachmentId }) => attachmentId),
      captureBundleId: captureId,
    };
    const resultArguments = { projectId, verificationId, request: resultRequest };
    const result = await call("qa_record_verification_result", resultArguments);
    assert.equal(result.replayed, false);
    assert.equal(result.captureBundleId, captureId);
    assert.deepEqual(
      result.attachmentIds.slice().sort(),
      resultRequest.attachmentIds.slice().sort(),
    );
    const replay = await call("qa_record_verification_result", resultArguments);
    assert.equal(replay.replayed, true);
    assert.equal(replay.eventId, result.eventId);
    assert.deepEqual(replay.attachmentIds, result.attachmentIds);

    const readback = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.equal(readback.prepare("PRAGMA user_version").get().user_version, 19);
      assert.equal(
        readback
          .prepare("SELECT count(*) AS count FROM verification_attachments WHERE verification_id=?")
          .get(verificationId).count,
        2,
      );
      assert.deepEqual(
        readback
          .prepare(
            `SELECT attachment_id FROM verification_attachments
             WHERE verification_id=? ORDER BY attachment_id`,
          )
          .all(verificationId)
          .map((row) => row.attachment_id),
        result.attachmentIds.slice().sort(),
      );
      const snapshot = readback
        .prepare(
          `SELECT response_json FROM verification_result_snapshots
           WHERE verification_id=? AND client_submission_id=?`,
        )
        .get(verificationId, clientSubmissionId);
      assert.ok(snapshot);
      const frozen = JSON.parse(snapshot.response_json);
      assert.equal(frozen.captureBundleId, captureId);
      assert.deepEqual(frozen.attachmentIds, result.attachmentIds);
      assert.equal(
        readback.prepare("SELECT status FROM capture_bundles WHERE id=?").get(captureId).status,
        "bound",
      );
      assert.equal(
        readback.prepare("SELECT count(*) AS count FROM storage_command_authorizations").get()
          .count,
        0,
      );
    } finally {
      readback.close();
    }
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(
        {
          schema: 19,
          realHttp: true,
          serverMcp: true,
          requestCount,
          verificationId,
          captureId,
          attachmentIds: result.attachmentIds,
          evidenceSha256: uploaded.map(({ sha256: value }) => value),
          replayed: replay.replayed,
          externalRequests: 0,
        },
        null,
        2,
      ),
    );
    t.diagnostic(`retained isolated evidence fixture ${root}; ${requestCount} real MCP/HTTP calls`);
  } finally {
    await app?.close();
    await worker.close();
  }
});
