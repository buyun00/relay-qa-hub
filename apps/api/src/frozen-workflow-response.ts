import type {
  MobileBugRecord,
  MobileManualRepairAttemptRecord,
  MobileRepairAttemptRecord,
  MobileVerificationRecord,
  MobileVerificationResultResponse,
} from "@relay-qa-hub/storage";
import { MOBILE_API_CONTENT_TYPE, MOBILE_API_MEDIA_TYPE } from "./mobile-bugs.js";

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}

/** The frozen mutation DTOs are distinct from the richer, unfrozen read models. */
export function frozenRepairAttempt(
  value: MobileManualRepairAttemptRecord | MobileRepairAttemptRecord,
) {
  return pick(value, [
    "id",
    "bugId",
    "sequence",
    "mode",
    "status",
    "assigneeId",
    "parentAttemptId",
    "summary",
    "branch",
    "commitSha",
    "mergeRequestUrl",
    "targetBuildId",
    "version",
  ] as const);
}

export function frozenVerification(value: MobileVerificationRecord) {
  return pick(value, [
    "id",
    "bugId",
    "repairAttemptId",
    "buildId",
    "status",
    "verifierId",
    "criteriaSnapshot",
    "resultSummary",
    "version",
  ] as const);
}

function legacyBug(value: MobileBugRecord) {
  return pick(value, [
    "id",
    "projectId",
    "number",
    "key",
    "title",
    "description",
    "expectedBehavior",
    "state",
    "severity",
    "priority",
    "reporterId",
    "ownerId",
    "verificationOwnerId",
    "occurrenceCount",
    "reopenCount",
    "version",
    "createdAt",
    "updatedAt",
    "closedAt",
  ] as const);
}

/** An explicit JSON preference selects legacy output; absent/wildcard Accept keeps current clients. */
export function workflowResponseMedia(accept: string | undefined): string {
  const preferences = (accept ?? "").split(",").map((entry, index) => {
    const [media, ...parameters] = entry.trim().toLowerCase().split(";");
    const quality = parameters.find((part) => part.trim().startsWith("q="));
    const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
    return { media, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index };
  });
  const json = preferences.find((entry) => entry.media === "application/json");
  const vendor = preferences.find((entry) => entry.media === MOBILE_API_MEDIA_TYPE);
  return json &&
    json.q > 0 &&
    (!vendor || json.q > vendor.q || (json.q === vendor.q && json.index < vendor.index))
    ? "application/json; charset=utf-8"
    : MOBILE_API_CONTENT_TYPE;
}

export function frozenVerificationResult(value: MobileVerificationResultResponse, media: string) {
  const verification = frozenVerification(value.verification);
  if (media.startsWith("application/json")) return { verification, bug: legacyBug(value.bug) };
  if (value.clientSubmissionId === null)
    throw new TypeError("Legacy result has no client submission identity");
  return {
    clientSubmissionId: value.clientSubmissionId,
    qaItem: value.qaItem,
    verification,
    repairAttempt: frozenRepairAttempt(value.repairAttempt),
    bug: value.bug,
    attachmentIds: value.attachmentIds,
    captureBundleId: value.captureBundleId,
    eventId: value.eventId,
    replayed: value.replayed,
  };
}

/** Legacy requests have no client submission identity, so only the JSON DTO is representable. */
export function legacyVerificationResultMedia(accept: string | undefined): string {
  if (!accept?.trim()) return "application/json; charset=utf-8";
  const matches = accept
    .split(",")
    .flatMap((entry) => {
      const [media, ...parameters] = entry.trim().toLowerCase().split(";");
      const specificity =
        media === "application/json" ? 2 : media === "application/*" ? 1 : media === "*/*" ? 0 : -1;
      if (specificity < 0) return [];
      const quality = parameters.find((part) => part.trim().startsWith("q="));
      const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
      return [{ specificity, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 }];
    })
    .sort((a, b) => b.specificity - a.specificity || b.q - a.q);
  if (!matches[0] || matches[0].q <= 0) {
    throw Object.assign(
      new Error("Legacy Verification result requires an acceptable application/json response"),
      { code: "NOT_ACCEPTABLE" },
    );
  }
  return "application/json; charset=utf-8";
}
