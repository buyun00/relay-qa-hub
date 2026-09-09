import { VERIFICATION_RESULT_SNAPSHOT_SQL } from "./verification-result-snapshot-migration.js";

// Migration 15 is immutable. Replace only its result status whitelist, retaining
// every DTO shape, typed relation, event, attachment and reserved-receipt guard.
const start = "CREATE TRIGGER verification_result_snapshot_exact_effect ";
const end = "CREATE TRIGGER verification_result_receipt_exact_snapshot ";
const original = VERIFICATION_RESULT_SNAPSHOT_SQL.slice(
  VERIFICATION_RESULT_SNAPSHOT_SQL.indexOf(start),
  VERIFICATION_RESULT_SNAPSHOT_SQL.indexOf(end),
);
const predicate = "verification.status IN ('passed','failed')";
if (!original.startsWith(start) || original.split(predicate).length !== 2)
  throw new Error("Immutable schema15 result trigger differs from its reviewed shape");

export const VERIFICATION_BLOCKED_RESULT_SQL = `
DROP TRIGGER verification_result_snapshot_exact_effect;
${original.replace(predicate, "verification.status IN ('passed','failed','blocked')")}
`;
