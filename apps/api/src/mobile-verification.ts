import type {
  CreateMobileVerificationInput,
  GetMobileVerificationInput,
  MobileRelayScope,
  MobileVerificationRecord,
  MobileVerificationResultResponse,
  RecordMobileVerificationResultInput,
  SqliteStorageWorker,
  StartMobileVerificationInput,
} from "@relay-qa-hub/storage";

export const MOBILE_VERIFICATION_COLLECTION_PATH =
  "/api/v1/bugs/:bugId/verifications" as const;
export const MOBILE_VERIFICATION_ITEM_PATH = "/api/v1/verifications/:verificationId" as const;
export const MOBILE_VERIFICATION_START_PATH =
  "/api/v1/verifications/:verificationId/start" as const;
export const MOBILE_VERIFICATION_RESULT_PATH =
  "/api/v1/verifications/:verificationId/result" as const;

export interface MobileCreateVerificationRequest {
  readonly expectedVersion: number;
  readonly repairAttemptId: string;
  readonly buildId: string;
  readonly verifierId: string;
  readonly criteria: string;
}

export interface MobileStartVerificationRequest {
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface MobileRecordVerificationResultRequest {
  readonly submissionContractVersion: "1.1.0";
  readonly clientSubmissionId: string;
  readonly expectedVersion: number;
  readonly status: "passed";
  readonly resultSummary: string;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId?: string | null;
}

export interface MobileVerificationStore {
  readonly createVerification: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileCreateVerificationRequest;
  }) => MobileVerificationRecord | Promise<MobileVerificationRecord>;
  readonly getVerification: (query: {
    readonly actorId: string;
    readonly verificationId: string;
  }) => MobileVerificationRecord | null | Promise<MobileVerificationRecord | null>;
  readonly startVerification: (command: {
    readonly actorId: string;
    readonly verificationId: string;
    readonly idempotencyKey: string;
    readonly request: MobileStartVerificationRequest;
  }) => MobileVerificationRecord | Promise<MobileVerificationRecord>;
  readonly recordResult: (command: {
    readonly actorId: string;
    readonly verificationId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRecordVerificationResultRequest;
  }) => MobileVerificationResultResponse | Promise<MobileVerificationResultResponse>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function record(value: unknown, label = "request body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unexpected property: ${key}`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function requireVerificationUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
}

export function requireVerificationIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length < 1 || value.length > 255) {
    throw new TypeError("Idempotency-Key is required");
  }
  return value;
}

export function parseMobileCreateVerificationRequest(
  value: unknown,
): MobileCreateVerificationRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "repairAttemptId", "buildId", "verifierId", "criteria"]));
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    repairAttemptId: requireVerificationUuid(body["repairAttemptId"], "repairAttemptId"),
    buildId: requireVerificationUuid(body["buildId"], "buildId"),
    verifierId: requireVerificationUuid(body["verifierId"], "verifierId"),
    criteria: boundedString(body["criteria"], "criteria", 1, 10_000),
  };
}

export function parseMobileStartVerificationRequest(
  value: unknown,
): MobileStartVerificationRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "reason"]));
  const reason = body["reason"];
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 2_000)) {
    throw new TypeError("reason is invalid");
  }
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    ...(reason === undefined ? {} : { reason: reason as string }),
  };
}

export function parseMobileRecordVerificationResultRequest(
  value: unknown,
): MobileRecordVerificationResultRequest {
  const body = record(value);
  onlyKeys(
    body,
    new Set([
      "submissionContractVersion",
      "clientSubmissionId",
      "expectedVersion",
      "status",
      "resultSummary",
      "attachmentIds",
      "captureBundleId",
    ]),
  );
  if (body["submissionContractVersion"] !== "1.1.0") {
    throw new TypeError("submissionContractVersion must be 1.1.0");
  }
  if (body["status"] !== "passed") {
    throw new TypeError("only passed Verification results are supported");
  }
  if (!Array.isArray(body["attachmentIds"]) || body["attachmentIds"].length > 20) {
    throw new TypeError("attachmentIds must contain at most twenty UUIDs");
  }
  const attachmentIds = body["attachmentIds"].map((entry) =>
    requireVerificationUuid(entry, "attachmentId"),
  );
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new TypeError("attachmentIds must be unique");
  }
  const captureBundleId = body["captureBundleId"];
  if (captureBundleId !== undefined && captureBundleId !== null) {
    requireVerificationUuid(captureBundleId, "captureBundleId");
  }
  return {
    submissionContractVersion: "1.1.0",
    clientSubmissionId: requireVerificationUuid(body["clientSubmissionId"], "clientSubmissionId"),
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    status: "passed",
    resultSummary: boundedString(body["resultSummary"], "resultSummary", 1, 2_000),
    attachmentIds,
    ...(captureBundleId === undefined ? {} : { captureBundleId: captureBundleId as string | null }),
  };
}

export type {
  CreateMobileVerificationInput,
  GetMobileVerificationInput,
  MobileRelayScope,
  MobileVerificationRecord,
  MobileVerificationResultResponse,
  RecordMobileVerificationResultInput,
  SqliteStorageWorker,
  StartMobileVerificationInput,
};
