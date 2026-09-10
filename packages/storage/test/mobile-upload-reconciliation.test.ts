import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  bindMobileAttachment,
  finalizeMobileUpload,
  getMobileAttachmentMetadata,
  getMobileUploadSession,
  initMobileUpload,
  putMobileUploadChunk,
} from "../src/mobile-attachment-store.ts";
import { createMobileBug } from "../src/mobile-bug-store.ts";
import { evidenceFixture, PNG, sha, stamp, tx } from "./verification-result-evidence-fixture.ts";

test("upload reads reconcile lost receipts and advance unbound, reserved and claimed metadata", async (t) => {
  const fixture = await evidenceFixture(t);
  try {
    const clientSubmissionId = randomUUID();
    const clientAttachmentId = randomUUID();
    const session = tx(fixture.database, () =>
      initMobileUpload(fixture.database, {
        ...fixture.scope,
        clientSubmissionId,
        clientAttachmentId,
        captureId: null,
        uploadAttempt: 1,
        filename: "reconcile.png",
        mediaType: "image/png",
        expectedSize: PNG.length,
        sha256: sha(PNG),
        createdAt: stamp(),
      }),
    );
    const chunkInput = {
      ...fixture.scope,
      sessionId: session.sessionId,
      clientSubmissionId,
      clientAttachmentId,
      chunkNumber: 0,
      expectedVersion: session.version,
      sha256: sha(PNG),
      bytes: PNG,
      idempotencyKey:
        `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:` + "upload:1:chunk:0",
      receivedAt: stamp(),
    };
    const acceptedChunk = tx(fixture.database, () =>
      putMobileUploadChunk(fixture.database, fixture.roots, chunkInput),
    );

    const recoveredChunkReceipt = tx(fixture.database, () =>
      getMobileUploadSession(fixture.database, {
        ...fixture.scope,
        sessionId: session.sessionId,
        observedAt: stamp(),
      }),
    );
    assert.deepEqual(recoveredChunkReceipt, {
      sessionId: session.sessionId,
      projectId: fixture.scope.projectId,
      clientSubmissionId,
      clientAttachmentId,
      uploadAttempt: 1,
      status: "finalizing",
      filename: "reconcile.png",
      mediaType: "image/png",
      captureId: null,
      expectedSize: PNG.length,
      chunkSize: PNG.length < 256 * 1024 ? 256 * 1024 : PNG.length,
      sha256: sha(PNG),
      expectedChunkCount: 1,
      receivedBytes: PNG.length,
      confirmedChunks: [0],
      attachmentId: null,
      expiresAt: session.expiresAt,
      version: acceptedChunk.version,
    });
    assert.deepEqual(
      tx(fixture.database, () =>
        getMobileUploadSession(fixture.database, {
          ...fixture.scope,
          sessionId: session.sessionId,
          observedAt: new Date(Date.parse(session.expiresAt) + 1_000).toISOString(),
        }),
      ),
      recoveredChunkReceipt,
    );
    assert.deepEqual(
      tx(fixture.database, () => putMobileUploadChunk(fixture.database, fixture.roots, chunkInput)),
      { version: acceptedChunk.version, replayed: true },
    );

    const finalizeInput = {
      ...fixture.scope,
      sessionId: session.sessionId,
      expectedVersion: acceptedChunk.version,
      clientSubmissionId,
      clientAttachmentId,
      uploadAttempt: 1,
      sha256: sha(PNG),
      expectedSize: PNG.length,
      finalizedAt: stamp(),
    };
    const finalized = tx(fixture.database, () =>
      finalizeMobileUpload(fixture.database, fixture.roots, finalizeInput),
    );
    assert.deepEqual(
      tx(fixture.database, () =>
        getMobileUploadSession(fixture.database, {
          ...fixture.scope,
          sessionId: session.sessionId,
          observedAt: stamp(),
        }),
      ),
      {
        ...recoveredChunkReceipt,
        status: "finalized",
        attachmentId: finalized.attachmentId,
        version: finalized.version,
      },
    );
    assert.deepEqual(
      tx(fixture.database, () =>
        finalizeMobileUpload(fixture.database, fixture.roots, finalizeInput),
      ),
      { ...finalized, replayed: true },
    );

    const unbound = getMobileAttachmentMetadata(fixture.database, {
      ...fixture.scope,
      attachmentId: finalized.attachmentId,
    });
    assert.deepEqual(unbound, {
      attachmentId: finalized.attachmentId,
      projectId: fixture.scope.projectId,
      clientSubmissionId,
      clientAttachmentId,
      captureId: null,
      filename: "reconcile.png",
      mediaType: "image/png",
      size: PNG.length,
      sha256: sha(PNG),
      scanStatus: "clean",
      readyToBind: true,
      bindingStatus: "unbound",
      version: finalized.version,
    });

    const bindInput = {
      ...fixture.scope,
      attachmentId: finalized.attachmentId,
      expectedVersion: finalized.version,
      clientSubmissionId,
      clientAttachmentId,
      leaseGeneration: 1,
      intent: "bug_create" as const,
      boundAt: stamp(),
    };
    const reserved = tx(fixture.database, () => bindMobileAttachment(fixture.database, bindInput));
    assert.deepEqual(
      getMobileAttachmentMetadata(fixture.database, {
        ...fixture.scope,
        attachmentId: finalized.attachmentId,
      }),
      { ...unbound, bindingStatus: "reserved", version: reserved.version },
    );
    assert.deepEqual(
      tx(fixture.database, () => bindMobileAttachment(fixture.database, bindInput)),
      { ...reserved, replayed: true },
    );

    tx(fixture.database, () =>
      createMobileBug(fixture.database, {
        ...fixture.scope,
        clientSubmissionId,
        payloadDigest: "7".repeat(64),
        title: "Claim reconciled attachment",
        description: "Exercise the real attachment claim transition",
        expectedBehavior: "Metadata advances with the claim",
        severity: "S2",
        priority: "P2",
        ownerId: fixture.scope.actorId,
        verificationOwnerId: fixture.scope.actorId,
        occurrence: {
          observedAt: stamp(),
          platform: "android",
          steps: ["Upload", "Bind", "Create Bug"],
          actualBehavior: "The evidence is claimed",
        },
        attachmentIds: [finalized.attachmentId],
        captureBundleId: null,
        createdAt: stamp(),
      }),
    );
    assert.deepEqual(
      getMobileAttachmentMetadata(fixture.database, {
        ...fixture.scope,
        attachmentId: finalized.attachmentId,
      }),
      { ...unbound, bindingStatus: "claimed", version: reserved.version + 1 },
    );

    const otherProject = fixture.addProjectScope("UPLOADREADB").scope;
    assert.equal(
      tx(fixture.database, () =>
        getMobileUploadSession(fixture.database, {
          ...otherProject,
          sessionId: session.sessionId,
          observedAt: stamp(),
        }),
      ),
      null,
    );
    assert.equal(
      getMobileAttachmentMetadata(fixture.database, {
        ...otherProject,
        attachmentId: finalized.attachmentId,
      }),
      null,
    );
    const actorWithoutMembership = { ...fixture.scope, actorId: randomUUID() };
    assert.equal(
      tx(fixture.database, () =>
        getMobileUploadSession(fixture.database, {
          ...actorWithoutMembership,
          sessionId: session.sessionId,
          observedAt: stamp(),
        }),
      ),
      null,
    );
    assert.equal(
      getMobileAttachmentMetadata(fixture.database, {
        ...actorWithoutMembership,
        attachmentId: finalized.attachmentId,
      }),
      null,
    );

    fixture.database
      .prepare(
        `UPDATE memberships
         SET status='revoked', updated_at=?, version=version+1
         WHERE account_id=? AND project_id=? AND user_id=?`,
      )
      .run(stamp(), fixture.scope.accountId, fixture.scope.projectId, fixture.scope.actorId);
    assert.equal(
      tx(fixture.database, () =>
        getMobileUploadSession(fixture.database, {
          ...fixture.scope,
          sessionId: session.sessionId,
          observedAt: stamp(),
        }),
      ),
      null,
    );
    assert.equal(
      getMobileAttachmentMetadata(fixture.database, {
        ...fixture.scope,
        attachmentId: finalized.attachmentId,
      }),
      null,
    );
  } finally {
    fixture.database.close();
  }
});

test("upload reconciliation persists an expired open lease before the next attempt", async (t) => {
  const fixture = await evidenceFixture(t);
  try {
    const sessionId = randomUUID();
    const clientSubmissionId = randomUUID();
    const clientAttachmentId = randomUUID();
    const createdAt = stamp();
    const expiresAt = new Date(Date.parse(createdAt) + 1_000).toISOString();
    fixture.database
      .prepare(
        `INSERT INTO upload_sessions(
           id, account_id, project_id, actor_id, client_submission_id,
           client_attachment_id, capture_id, upload_attempt, file_name, media_type,
           expected_size_bytes, expected_sha256, received_size_bytes, chunk_size_bytes,
           expected_chunk_count, generation, finalized_attachment_id, status,
           expires_at, created_at, updated_at, version
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 'expired.png', 'image/png',
                   ?, ?, 0, 262144, 1, 1, NULL, 'open', ?, ?, ?, 1)`,
      )
      .run(
        sessionId,
        fixture.scope.accountId,
        fixture.scope.projectId,
        fixture.scope.actorId,
        clientSubmissionId,
        clientAttachmentId,
        PNG.length,
        sha(PNG),
        expiresAt,
        createdAt,
        createdAt,
      );
    const early = tx(fixture.database, () =>
      getMobileUploadSession(fixture.database, {
        ...fixture.scope,
        sessionId,
        observedAt: createdAt,
      }),
    );
    assert.equal(early?.status, "open");
    assert.equal(early?.version, 1);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now() + 1_100)),
    );

    const expired = tx(fixture.database, () =>
      getMobileUploadSession(fixture.database, {
        ...fixture.scope,
        sessionId,
        observedAt: stamp(),
      }),
    );
    assert.equal(expired?.status, "expired");
    assert.equal(expired?.version, 2);
    assert.deepEqual(
      {
        ...fixture.database
          .prepare("SELECT status, version FROM upload_sessions WHERE id = ?")
          .get(sessionId),
      },
      { status: "expired", version: 2 },
    );

    const replacement = tx(fixture.database, () =>
      initMobileUpload(fixture.database, {
        ...fixture.scope,
        clientSubmissionId,
        clientAttachmentId,
        captureId: null,
        uploadAttempt: 2,
        filename: "expired.png",
        mediaType: "image/png",
        expectedSize: PNG.length,
        sha256: sha(PNG),
        createdAt: stamp(),
      }),
    );
    assert.equal(replacement.uploadAttempt, 2);
    assert.equal(replacement.status, "open");
    assert.notEqual(replacement.sessionId, sessionId);
  } finally {
    fixture.database.close();
  }
});
