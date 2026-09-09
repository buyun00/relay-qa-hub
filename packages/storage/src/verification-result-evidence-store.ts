import type { DatabaseSync } from "node:sqlite";
import { MobileRelayStorageError } from "./mobile-relay-store.js";

export interface VerificationResultEvidenceInput {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly verificationId: string;
  readonly clientSubmissionId: string | null;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
  readonly createdAt: string;
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const MAX_BYTES = 100 * 1024 * 1024;
function invalid(message: string): never {
  throw new MobileRelayStorageError("INVALID_REQUEST", message);
}

/** Shape checks are also safe before receipt replay; active reservations are checked only on first commit. */
export function validateVerificationResultEvidence(input: VerificationResultEvidenceInput): void {
  if (
    input.attachmentIds.length > 20 ||
    new Set(input.attachmentIds).size !== input.attachmentIds.length ||
    input.attachmentIds.some((id) => !UUID.test(id)) ||
    (input.captureBundleId !== null && !UUID.test(input.captureBundleId)) ||
    (input.clientSubmissionId === null &&
      (input.attachmentIds.length > 0 || input.captureBundleId !== null))
  )
    invalid(
      "Verification accepts at most twenty unique attachments; evidence requires a client submission",
    );
}

/** Caller owns the same write transaction as Verification, audit, notification and original receipt. */
export function claimVerificationResultEvidence(
  database: DatabaseSync,
  input: VerificationResultEvidenceInput,
  bugId: string,
): void {
  if (!database.isTransaction)
    invalid("Verification evidence requires the caller's write transaction");
  validateVerificationResultEvidence(input);
  type Capture = {
    id: string;
    capture_id: string;
    actor_id: string;
    client_submission_id: string;
    primary_attachment_id: string;
    status: string;
    version: number;
    updated_at: string;
  };
  const capture =
    input.captureBundleId === null
      ? undefined
      : (database
          .prepare(
            `
    SELECT id,capture_id,actor_id,client_submission_id,primary_attachment_id,status,version,updated_at
    FROM capture_bundles WHERE account_id=? AND project_id=? AND id=?
  `,
          )
          .get(input.accountId, input.projectId, input.captureBundleId) as Capture | undefined);
  if (input.captureBundleId !== null) {
    if (
      !capture ||
      capture.id !== capture.capture_id ||
      capture.actor_id !== input.actorId ||
      capture.client_submission_id !== input.clientSubmissionId ||
      capture.status !== "uploaded"
    ) {
      invalid("Verification capture must be the exact unconsumed uploaded capture");
    }
    const artifacts = database
      .prepare(
        `SELECT attachment_id,artifact_type,status
      FROM capture_artifacts WHERE account_id=? AND project_id=? AND capture_bundle_id=? AND capture_id=?
    `,
      )
      .all(input.accountId, input.projectId, capture.id, capture.capture_id);
    const successful = artifacts.filter((row) => row["status"] === "succeeded");
    const ids = successful.map((row) => String(row["attachment_id"]));
    if (
      artifacts.some((row) => row["status"] === "pending") ||
      new Set(ids).size !== ids.length ||
      ids.length !== input.attachmentIds.length ||
      ids.some((id) => !input.attachmentIds.includes(id)) ||
      !successful.some(
        (row) =>
          row["attachment_id"] === capture.primary_attachment_id &&
          ["system_screenshot", "system_recording"].includes(String(row["artifact_type"])),
      )
    ) {
      invalid(
        "Verification attachments must exactly match all successful capture artifacts and its primary evidence",
      );
    }
  }
  type Reservation = {
    id: string;
    version: number;
    attachment_version: number;
    size_bytes: number;
    attachment_id: string;
  };
  const reservations: Reservation[] = [];
  let totalBytes = 0;
  for (const attachmentId of input.attachmentIds) {
    const reservation = database
      .prepare(
        `
      SELECT binding.id,binding.version,attachment.version AS attachment_version,attachment.size_bytes,attachment.id AS attachment_id
      FROM attachment_bindings AS binding
      JOIN attachments AS attachment ON attachment.account_id=binding.account_id
        AND attachment.project_id=binding.project_id AND attachment.id=binding.attachment_id
      JOIN blobs AS blob ON blob.account_id=attachment.account_id AND blob.id=attachment.blob_id
        AND blob.sha256=attachment.sha256 AND blob.size_bytes=attachment.size_bytes AND blob.state='ready'
      JOIN upload_sessions AS upload ON upload.account_id=attachment.account_id AND upload.project_id=attachment.project_id
        AND upload.id=attachment.upload_session_id AND upload.status='finalized' AND upload.finalized_attachment_id=attachment.id
        AND upload.actor_id=attachment.actor_id AND upload.client_submission_id=attachment.client_submission_id
        AND upload.client_attachment_id=attachment.client_attachment_id AND upload.capture_id IS attachment.capture_id
      WHERE binding.account_id=? AND binding.project_id=? AND binding.attachment_id=?
        AND binding.intent='verification_result' AND binding.target_bug_id=? AND binding.state='reserved'
        AND unixepoch(binding.expires_at)>unixepoch('now') AND binding.bound_by_actor_id=?
        AND attachment.actor_id=? AND attachment.client_submission_id=? AND attachment.capture_id IS ?
        AND attachment.status='ready' AND attachment.scan_state='clean'
    `,
      )
      .get(
        input.accountId,
        input.projectId,
        attachmentId,
        bugId,
        input.actorId,
        input.actorId,
        input.clientSubmissionId,
        input.captureBundleId,
      ) as Reservation | undefined;
    if (!reservation)
      invalid("Verification attachment requires its exact active reservation and capture identity");
    totalBytes += reservation.size_bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BYTES)
      invalid("Verification attachments must total at most 100 MiB");
    reservations.push(reservation);
  }
  for (const reservation of reservations) {
    const claimed = database
      .prepare(
        `UPDATE attachment_bindings SET state='claimed',expires_at=NULL,claimed_at=?,version=version+1
      WHERE account_id=? AND project_id=? AND id=? AND version=? AND state='reserved'`,
      )
      .run(input.createdAt, input.accountId, input.projectId, reservation.id, reservation.version);
    const attachment = database
      .prepare(
        `UPDATE attachments SET version=version+1
      WHERE account_id=? AND project_id=? AND id=? AND version=?`,
      )
      .run(
        input.accountId,
        input.projectId,
        reservation.attachment_id,
        reservation.attachment_version,
      );
    if (claimed.changes !== 1 || attachment.changes !== 1)
      throw new MobileRelayStorageError(
        "VERSION_CONFLICT",
        "Verification evidence claim did not advance exactly once",
      );
    database
      .prepare(
        `INSERT INTO verification_attachments(account_id,project_id,verification_id,attachment_id,binding_id)
      VALUES (?,?,?,?,?)`,
      )
      .run(
        input.accountId,
        input.projectId,
        input.verificationId,
        reservation.attachment_id,
        reservation.id,
      );
  }
  if (capture) {
    const updatedAt = new Date(
      Math.max(Date.parse(input.createdAt), Date.parse(capture.updated_at) + 1),
    ).toISOString();
    const changed = database
      .prepare(
        `UPDATE capture_bundles SET status='bound',updated_at=?,version=version+1
      WHERE account_id=? AND project_id=? AND id=? AND actor_id=? AND client_submission_id=? AND status='uploaded' AND version=?`,
      )
      .run(
        updatedAt,
        input.accountId,
        input.projectId,
        capture.id,
        input.actorId,
        input.clientSubmissionId,
        capture.version,
      );
    if (changed.changes !== 1)
      throw new MobileRelayStorageError(
        "VERSION_CONFLICT",
        "Verification capture was not consumed exactly once",
      );
  }
}
