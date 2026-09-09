import { VERIFICATION_RESULT_SNAPSHOT_SQL } from "./verification-result-snapshot-migration.js";
import { VERIFICATION_BLOCKED_RESULT_SQL } from "./verification-blocked-result-migration.js";

// Additive candidate; the integrator assigns its migration number. Never rewrite 15/16/17.
function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error("Reviewed Verification evidence trigger anchor changed");
  return source.replace(before, after);
}
const snapshotStart = "CREATE TRIGGER verification_result_snapshot_exact_effect ";
let snapshot = VERIFICATION_BLOCKED_RESULT_SQL.slice(
  VERIFICATION_BLOCKED_RESULT_SQL.indexOf(snapshotStart),
);
if (!snapshot.startsWith(snapshotStart))
  throw new Error("Reviewed blocked-result trigger is unavailable");
snapshot = replaceOnce(
  snapshot,
  "json_array_length(new.response_json,'$.attachmentIds') <= 8",
  "json_array_length(new.response_json,'$.attachmentIds') <= 20",
);
snapshot = replaceOnce(
  snapshot,
  "AND json_extract(new.response_json, '$.captureBundleId') IS NULL",
  `AND (
    json_type(new.response_json,'$.captureBundleId') IS 'null'
    OR (json_type(new.response_json,'$.captureBundleId') IS 'text' AND EXISTS (
      SELECT 1 FROM capture_bundles AS capture
      WHERE capture.account_id=new.account_id AND capture.project_id=new.project_id
        AND capture.id=json_extract(new.response_json,'$.captureBundleId') AND capture.capture_id=capture.id
        AND capture.actor_id=new.actor_id AND capture.client_submission_id=new.client_submission_id AND capture.status='bound'
        AND EXISTS (SELECT 1 FROM capture_artifacts AS primary_artifact
          WHERE primary_artifact.account_id=capture.account_id AND primary_artifact.project_id=capture.project_id
            AND primary_artifact.capture_bundle_id=capture.id AND primary_artifact.capture_id=capture.capture_id
            AND primary_artifact.attachment_id=capture.primary_attachment_id
            AND primary_artifact.client_attachment_id=capture.primary_client_attachment_id
            AND primary_artifact.artifact_type IN ('system_screenshot','system_recording') AND primary_artifact.status='succeeded')
        AND NOT EXISTS (SELECT 1 FROM capture_artifacts AS pending
          WHERE pending.account_id=capture.account_id AND pending.project_id=capture.project_id
            AND pending.capture_bundle_id=capture.id AND pending.status='pending')
        AND (SELECT count(DISTINCT attachment_id) FROM capture_artifacts AS artifact
          WHERE artifact.account_id=capture.account_id AND artifact.project_id=capture.project_id
            AND artifact.capture_bundle_id=capture.id AND artifact.status='succeeded') = json_array_length(new.response_json,'$.attachmentIds')
        AND NOT EXISTS (SELECT 1 FROM capture_artifacts AS artifact
          WHERE artifact.account_id=capture.account_id AND artifact.project_id=capture.project_id
            AND artifact.capture_bundle_id=capture.id AND artifact.status='succeeded'
            AND NOT EXISTS (SELECT 1 FROM verification_attachments AS link
              WHERE link.account_id=new.account_id AND link.project_id=new.project_id
                AND link.verification_id=new.verification_id AND link.attachment_id=artifact.attachment_id))
    ))
  )
  AND COALESCE((SELECT sum(attachment.size_bytes) FROM verification_attachments AS link
    JOIN attachments AS attachment ON attachment.account_id=link.account_id AND attachment.project_id=link.project_id AND attachment.id=link.attachment_id
    WHERE link.account_id=new.account_id AND link.project_id=new.project_id AND link.verification_id=new.verification_id),0) <= 104857600
  AND NOT EXISTS (SELECT 1 FROM verification_attachments AS link
    WHERE link.account_id=new.account_id AND link.project_id=new.project_id AND link.verification_id=new.verification_id
      AND NOT EXISTS (SELECT 1 FROM attachments AS attachment
        JOIN attachment_bindings AS binding ON binding.account_id=attachment.account_id AND binding.project_id=attachment.project_id
          AND binding.id=link.binding_id AND binding.attachment_id=attachment.id AND binding.intent='verification_result'
          AND binding.target_bug_id=new.bug_id AND binding.state='claimed' AND binding.bound_by_actor_id=new.actor_id
        JOIN blobs AS blob ON blob.account_id=attachment.account_id AND blob.id=attachment.blob_id
          AND blob.state='ready' AND blob.size_bytes=attachment.size_bytes AND blob.sha256=attachment.sha256
        JOIN upload_sessions AS upload ON upload.account_id=attachment.account_id AND upload.project_id=attachment.project_id
          AND upload.id=attachment.upload_session_id AND upload.status='finalized' AND upload.finalized_attachment_id=attachment.id
        WHERE attachment.account_id=link.account_id AND attachment.project_id=link.project_id AND attachment.id=link.attachment_id
          AND attachment.actor_id=new.actor_id AND attachment.client_submission_id=new.client_submission_id
          AND attachment.capture_id IS json_extract(new.response_json,'$.captureBundleId')
          AND attachment.status='ready' AND attachment.scan_state='clean'))`,
);
const receiptStart = "CREATE TRIGGER verification_result_receipt_exact_snapshot ";
const receiptEnd = "CREATE TRIGGER verification_result_snapshots_no_update ";
let receipt = VERIFICATION_RESULT_SNAPSHOT_SQL.slice(
  VERIFICATION_RESULT_SNAPSHOT_SQL.indexOf(receiptStart),
  VERIFICATION_RESULT_SNAPSHOT_SQL.indexOf(receiptEnd),
);
if (!receipt.startsWith(receiptStart))
  throw new Error("Reviewed result receipt trigger is unavailable");
receipt = replaceOnce(
  receipt,
  "    AND json_extract(new.response_json,'$.captureBundleId') IS NULL\n",
  "",
);
receipt = replaceOnce(
  receipt,
  "AND snapshot.verification_id IS json_extract(new.response_json,'$.verificationId')))",
  "AND snapshot.verification_id IS json_extract(new.response_json,'$.verificationId')\n      AND json_extract(snapshot.response_json,'$.captureBundleId') IS json_extract(new.response_json,'$.captureBundleId')))",
);

export const VERIFICATION_RESULT_EVIDENCE_SQL = `
DROP TRIGGER verification_result_snapshot_exact_effect;
${snapshot}
DROP TRIGGER verification_result_receipt_exact_snapshot;
${receipt}
CREATE TRIGGER verification_attachments_result_limit BEFORE INSERT ON verification_attachments
WHEN (SELECT count(*) FROM verification_attachments WHERE account_id=new.account_id AND project_id=new.project_id AND verification_id=new.verification_id) >= 20
  OR COALESCE((SELECT sum(attachment.size_bytes) FROM verification_attachments AS link
    JOIN attachments AS attachment ON attachment.account_id=link.account_id AND attachment.project_id=link.project_id AND attachment.id=link.attachment_id
    WHERE link.account_id=new.account_id AND link.project_id=new.project_id AND link.verification_id=new.verification_id),0)
    + (SELECT size_bytes FROM attachments WHERE account_id=new.account_id AND project_id=new.project_id AND id=new.attachment_id) > 104857600
BEGIN SELECT RAISE(ABORT,'Verification evidence permits at most twenty attachments totaling 100 MiB'); END;
`;
