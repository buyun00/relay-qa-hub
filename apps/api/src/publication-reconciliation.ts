import { createHash } from "node:crypto";
import path from "node:path";

type RecordValue = Record<string, unknown>;
export const publicationDigest = (...records: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(records)).digest("hex");

export function awaitingPublication(config: RecordValue, state: RecordValue): boolean {
  return (
    config["mode"] === "prepare_publish" &&
    state["stage"] === "AWAITING_PUBLISH_CONFIRMATION" &&
    state["runStatus"] === "WAITING" &&
    state["finalRemoteStatus"] === 60 &&
    !state["pendingAction"] &&
    Array.isArray(state["done"]) &&
    state["done"].includes("PREPARE_PUBLISH")
  );
}

// Same publication identity checks as the worker's Engine.ReconcilePublication.
// Status 100 alone must never release another ZIP's channel reservation.
export function verifiedPublication(
  config: RecordValue,
  state: RecordValue,
  detail: RecordValue,
): { releaseDir: string; publishTime: string } | null {
  if (
    !Number.isSafeInteger(state["versionId"]) ||
    Number(state["versionId"]) <= 0 ||
    !state["version"] ||
    String(detail["id"]) !== String(state["versionId"]) ||
    detail["version"] !== state["version"] ||
    String(detail["product_id"]) !== config["productId"] ||
    String(detail["channel_id"]) !== config["channelId"]
  )
    throw new Error("VERSION_CONFLICT");
  if (Number(detail["status"]) !== 100) return null;
  const key = state["objectKey"];
  if (
    !Array.isArray(state["done"]) ||
    !state["done"].includes("OBJECT_READY") ||
    typeof key !== "string" ||
    !key.startsWith("test/pkg/") ||
    !key.endsWith(".zip") ||
    key.includes("..") ||
    key.includes("\\")
  )
    throw new Error("VERSION_CONFLICT");
  const releaseDir = `release/dir/${path.posix.basename(key, ".zip")}/`;
  const publishTime = detail["publish_time"];
  if (
    detail["url"] !== releaseDir ||
    typeof publishTime !== "string" ||
    publishTime.startsWith("0000") ||
    !Number.isFinite(Date.parse(publishTime))
  )
    throw new Error("VERSION_CONFLICT");
  return { releaseDir, publishTime };
}
