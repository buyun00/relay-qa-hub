import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { crc32, deflateSync } from "node:zlib";
import { migrateSqliteDatabase, openSqliteDatabaseForWorker } from "../src/sqlite.ts";
import { createMobileBug, ensureMobileScope, getMobileBug } from "../src/mobile-bug-store.ts";
import {
  ensureMobileRelayRoles,
  manuallyCompleteMobileBug,
  transitionMobileBugReady,
} from "../src/mobile-relay-store.ts";
import {
  createMobileVerification,
  startMobileVerification,
  recordMobileVerificationResult,
  type RecordMobileVerificationResultInput,
  type MobileVerificationRecord,
} from "../src/mobile-verification-store.ts";
import { getMobileHumanWorkflowForBug } from "../src/mobile-human-workflow-store.ts";
import {
  bindMobileAttachment,
  finalizeMobileUpload,
  initMobileUpload,
  putMobileUploadChunk,
  type MobileFinalizedAttachment,
  type MobileAttachmentReservation,
} from "../src/mobile-attachment-store.ts";
import {
  createMobileCapture,
  MOBILE_CAPTURE_ALLOWED_METHODS,
} from "../src/mobile-capture-store.ts";
import { VERIFICATION_RESULT_EVIDENCE_SQL } from "../src/verification-result-evidence-migration.ts";

export const stamp = () => new Date().toISOString();
export const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const digest = (data: unknown) => sha(JSON.stringify(data));
const pngChunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0);
ihdr.writeUInt32BE(1, 4);
ihdr[8] = 8;
ihdr[9] = 2;
export const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk("IHDR", ihdr),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
  pngChunk("IEND", Buffer.alloc(0)),
]);
/** Valid private ancillary padding keeps the one-pixel image and exact byte boundary. */
export function paddedPng(size: number): Buffer {
  if (size < PNG.length + 12) throw Error("Padding size too small");
  return Buffer.concat([
    PNG.subarray(0, -12),
    pngChunk("npAD", Buffer.alloc(size - PNG.length - 12)),
    PNG.subarray(-12),
  ]);
}
export function tx<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
export function fingerprint(database: DatabaseSync): Record<string, string> {
  return Object.fromEntries(
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => {
        const table = String(row["name"]);
        return [
          table,
          digest(
            database
              .prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`)
              .all()
              .map((row) => JSON.stringify(row))
              .sort(),
          ),
        ];
      }),
  );
}
export interface StagedVerificationEvidence {
  readonly bugId: string;
  readonly verification: MobileVerificationRecord;
  readonly input: RecordMobileVerificationResultInput;
  readonly attachments: MobileFinalizedAttachment[];
  readonly bindings: MobileAttachmentReservation[];
}
export async function evidenceFixture(
  t: { diagnostic(message: string): void },
  options: { readonly applyEvidenceMigration?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "qa-verification-evidence-"));
  t.diagnostic(`retained isolated verification evidence fixture ${directory}`);
  const databaseFile = join(directory, "state.sqlite");
  const database = openSqliteDatabaseForWorker({ databaseFile, busyTimeoutMs: 5000 });
  await migrateSqliteDatabase(database, databaseFile, { targetVersion: 17 });
  if (options.applyEvidenceMigration !== false) {
    tx(database, () => database.exec(VERIFICATION_RESULT_EVIDENCE_SQL));
  }
  const scope = { accountId: randomUUID(), projectId: randomUUID(), actorId: randomUUID() };
  const roots = {
    evidenceRoot: join(directory, "evidence"),
    quarantineRoot: join(directory, "quarantine"),
  };
  const bootstrap = {
    ...scope,
    membershipId: randomUUID(),
    projectKey: "VREVIDENCE",
    createdAt: stamp(),
  };
  tx(database, () => {
    ensureMobileScope(database, bootstrap);
    ensureMobileRelayRoles(database, bootstrap);
  });
  const common = () => ({
    ...scope,
    createdAt: stamp(),
    idempotencyKey: randomUUID(),
    requestDigest: digest(randomUUID()),
  });
  const prepareVerification = () => {
    const bug = tx(database, () =>
      createMobileBug(database, {
        ...scope,
        clientSubmissionId: randomUUID(),
        payloadDigest: digest(randomUUID()),
        title: "Verification evidence",
        description: "Local immutable evidence",
        expectedBehavior: "Keep original result",
        severity: "S2",
        priority: "P2",
        ownerId: scope.actorId,
        verificationOwnerId: scope.actorId,
        occurrence: {
          observedAt: stamp(),
          platform: "android",
          steps: ["Verify"],
          actualBehavior: "Recorded",
        },
        attachmentIds: [],
        captureBundleId: null,
        createdAt: stamp(),
      }),
    ).bug;
    const version = () => getMobileBug(database, scope, bug.id)!.version;
    tx(database, () =>
      transitionMobileBugReady(database, {
        ...common(),
        bugId: bug.id,
        expectedVersion: version(),
      }),
    );
    tx(database, () =>
      manuallyCompleteMobileBug(database, {
        ...common(),
        bugId: bug.id,
        expectedVersion: version(),
        reason: "Local human completion",
      }),
    );
    const attempt = getMobileHumanWorkflowForBug(database, {
      ...scope,
      bugId: bug.id,
    }).repairAttempt!;
    const requested = tx(database, () =>
      createMobileVerification(database, {
        ...common(),
        bugId: bug.id,
        expectedVersion: version(),
        repairAttemptId: attempt.id,
        buildId: null,
        verifierId: scope.actorId,
        criteria: "Inspect retained evidence",
      }),
    );
    const verification = tx(database, () =>
      startMobileVerification(database, {
        ...common(),
        verificationId: requested.id,
        expectedVersion: requested.version,
        reason: null,
      }),
    );
    return { bugId: bug.id, verification };
  };
  const upload = (
    clientSubmissionId: string,
    captureId: string | null = null,
    bytes: Uint8Array = PNG,
  ) => {
    const clientAttachmentId = randomUUID();
    const session = tx(database, () =>
      initMobileUpload(database, {
        ...scope,
        clientSubmissionId,
        clientAttachmentId,
        captureId,
        uploadAttempt: 1,
        filename: "evidence.png",
        mediaType: "image/png",
        expectedSize: bytes.length,
        sha256: sha(bytes),
        createdAt: stamp(),
      }),
    );
    let version = session.version;
    for (let index = 0; index < session.expectedChunkCount; index++) {
      const chunkBytes = bytes.subarray(index * session.chunkSize, (index + 1) * session.chunkSize);
      version = tx(database, () =>
        putMobileUploadChunk(database, roots, {
          ...scope,
          sessionId: session.sessionId,
          clientSubmissionId,
          clientAttachmentId,
          chunkNumber: index,
          expectedVersion: version,
          sha256: sha(chunkBytes),
          bytes: chunkBytes,
          idempotencyKey: `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:chunk:${index}`,
          receivedAt: stamp(),
        }),
      ).version;
    }
    return tx(database, () =>
      finalizeMobileUpload(database, roots, {
        ...scope,
        sessionId: session.sessionId,
        clientSubmissionId,
        clientAttachmentId,
        expectedVersion: version,
        uploadAttempt: 1,
        sha256: sha(bytes),
        expectedSize: bytes.length,
        finalizedAt: stamp(),
      }),
    );
  };
  const stage = (
    count: number,
    withCapture = false,
    reservationTarget?: string,
    bytes: Uint8Array = PNG,
    bindingIntent: "verification_result" | "bug_create" = "verification_result",
  ): StagedVerificationEvidence => {
    const target = prepareVerification(),
      clientSubmissionId = randomUUID(),
      captureId = withCapture ? randomUUID() : null;
    const attachments = Array.from({ length: count }, () =>
      upload(clientSubmissionId, captureId, bytes),
    );
    if (withCapture) {
      if (count < 1 || count > 2) throw Error("This fixture uses at most two typed PNG artifacts");
      const primary = attachments[0]!;
      const createdAt = stamp();
      tx(database, () =>
        createMobileCapture(database, {
          ...scope,
          clientSubmissionId,
          captureId: captureId!,
          capturedAt: createdAt,
          source: "overlay_single_tap",
          primaryEvidenceClientAttachmentId: primary.clientAttachmentId,
          primaryEvidenceAttachmentId: primary.attachmentId,
          artifacts: attachments.map((attachment, index) => ({
            captureId: captureId!,
            clientAttachmentId: attachment.clientAttachmentId,
            attachmentId: attachment.attachmentId,
            kind: index === 0 ? "system_screenshot" : "poco_screenshot",
            status: "succeeded",
            startedAt: createdAt,
            endedAt: createdAt,
            skewMs: 0,
            truncated: false,
            failureReason: null,
          })),
          poco:
            count === 1
              ? {
                  attempted: false,
                  connectedPort: null,
                  sdkVersion: null,
                  snapshotCapability: "not_probed",
                  screenSize: null,
                  allowedReadOnlyMethods: MOBILE_CAPTURE_ALLOWED_METHODS,
                  negotiatedMethods: [],
                  succeededMethods: [],
                  failureReason: null,
                }
              : {
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
            model: "Local",
            androidApi: 31,
            androidRelease: "12",
            qaAppVersion: "fixture",
            networkType: "wifi",
          },
          createdAt,
        }),
      );
    }
    const bindings = attachments.map((attachment) =>
      tx(database, () =>
        bindMobileAttachment(database, {
          ...scope,
          attachmentId: attachment.attachmentId,
          expectedVersion: attachment.version,
          clientSubmissionId,
          clientAttachmentId: attachment.clientAttachmentId,
          leaseGeneration: 1,
          intent: bindingIntent,
          ...(bindingIntent === "verification_result"
            ? { targetQaItemId: reservationTarget ?? target.bugId }
            : {}),
          boundAt: stamp(),
        }),
      ),
    );
    const input: RecordMobileVerificationResultInput = {
      ...common(),
      verificationId: target.verification.id,
      expectedVersion: target.verification.version,
      requireAssignedVerifier: true,
      clientSubmissionId,
      attachmentIds: attachments.map((x) => x.attachmentId),
      captureBundleId: captureId,
      status: "passed",
      failureReason: null,
      resultSummary: "Verified local evidence",
    };
    return { ...target, input, attachments, bindings };
  };
  const submit = (input: RecordMobileVerificationResultInput) =>
    tx(database, () => recordMobileVerificationResult(database, input));
  return {
    directory,
    databaseFile,
    database,
    scope,
    roots,
    bootstrap,
    common,
    prepareVerification,
    upload,
    stage,
    submit,
  };
}
