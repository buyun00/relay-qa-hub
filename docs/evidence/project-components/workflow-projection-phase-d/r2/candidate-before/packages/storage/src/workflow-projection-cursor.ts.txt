import { createHmac, timingSafeEqual } from "node:crypto";
import { WorkflowProjectionError } from "./workflow-projection-types.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const invalid = (): never => {
  throw new WorkflowProjectionError("INVALID_REQUEST", "Invalid workflow cursor");
};
export interface WorkflowCursorReference {
  readonly snapshotId: string;
  readonly cursorId: string;
}
const payload = (reference: WorkflowCursorReference) =>
  `workflow-page-v1:${reference.snapshotId}:${reference.cursorId}`;

/** The token only names immutable private records. Full scope/watermarks remain in SQLite. */
export function encodeWorkflowCursor(reference: WorkflowCursorReference, key: Uint8Array): string {
  if (!UUID.test(reference.snapshotId) || !UUID.test(reference.cursorId) || key.length !== 32)
    invalid();
  const signature = createHmac("sha256", key).update(payload(reference)).digest("base64url");
  return `w1.${reference.snapshotId}.${reference.cursorId}.${signature}`;
}
export function parseWorkflowCursor(
  token: string,
): WorkflowCursorReference & { readonly signature: string } {
  if (typeof token !== "string" || token.length > 500) invalid();
  const parts = token.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "w1" ||
    !UUID.test(parts[1]!) ||
    !UUID.test(parts[2]!) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(parts[3]!)
  )
    invalid();
  return { snapshotId: parts[1]!, cursorId: parts[2]!, signature: parts[3]! };
}
export function verifyWorkflowCursor(token: string, key: Uint8Array): WorkflowCursorReference {
  const reference = parseWorkflowCursor(token);
  if (key.length !== 32) invalid();
  const expected = encodeWorkflowCursor(reference, key).split(".")[3]!;
  if (!timingSafeEqual(Buffer.from(reference.signature), Buffer.from(expected))) invalid();
  return { snapshotId: reference.snapshotId, cursorId: reference.cursorId };
}
