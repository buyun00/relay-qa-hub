import type {
  MobileBugRecord,
  MobileRelayContinueAccepted,
  MobileRelayDispatchAccepted,
  MobileRelayReceipt,
  MobileManualRepairAttemptRecord,
  MobileRepairAttemptRecord,
} from "@relay-qa-hub/storage";

export const MOBILE_BUG_TRANSITION_PATH = "/api/v1/bugs/:bugId/transitions" as const;
export const MOBILE_BUG_COMPLETE_PATH = "/api/v1/bugs/:bugId/complete" as const;
export const MOBILE_BUG_REPAIR_ATTEMPTS_PATH = "/api/v1/bugs/:bugId/repair-attempts" as const;
export const MOBILE_RELAY_DISPATCH_PATH =
  "/api/v1/repair-attempts/:attemptId/dispatch/relay" as const;
export const MOBILE_RELAY_RECEIPT_PATH =
  "/api/v1/repair-attempts/:attemptId/relay-receipt" as const;
export const MOBILE_RELAY_CONTINUE_PATH =
  "/api/v1/repair-attempts/:attemptId/dispatch/relay/continue" as const;
export const MOBILE_REPAIR_ATTEMPT_ITEM_PATH = "/api/v1/repair-attempts/:attemptId" as const;
export const MOBILE_REPAIR_ATTEMPT_START_PATH = "/api/v1/repair-attempts/:attemptId/start" as const;
export const MOBILE_REPAIR_ATTEMPT_DELIVER_PATH =
  "/api/v1/repair-attempts/:attemptId/deliver" as const;

export interface MobileBugReadyRequest {
  readonly expectedVersion: number;
  readonly toState: "ready";
}

export interface MobileBugCompleteRequest {
  readonly expectedVersion: number;
  readonly repairAttemptId: string;
  readonly reason: string;
}

export interface MobileRelayAttemptRequest {
  readonly expectedVersion: number;
  readonly mode: "relay";
  readonly assigneeId: string;
  readonly summary?: string;
}

export interface MobileManualRepairAttemptRequest {
  readonly expectedVersion: number;
  readonly mode: "human";
  readonly assigneeId: string;
  readonly summary?: string;
}

export type MobileRepairAttemptRequest =
  MobileRelayAttemptRequest | MobileManualRepairAttemptRequest;

interface MobileRepairAttemptDeliveryBase {
  readonly expectedVersion: number;
  readonly summary: string;
}

export type MobileRepairAttemptDeliveryRequest = MobileRepairAttemptDeliveryBase &
  (
    | {
        readonly deliveryKind: "code";
        readonly branch: string;
        readonly commitSha: string;
        readonly mergeRequestUrl?: string;
        readonly patchUrl?: string;
      }
    | {
        readonly deliveryKind: "no_code";
        readonly noCodeReason: string;
      }
  );

export interface MobileRepairAttemptStartRequest {
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface MobileRelayDispatchRequest {
  readonly expectedVersion: number;
  readonly handoffId: string;
  readonly selectedAttachmentIds: readonly string[];
}

export interface MobileRelayContinueRequest {
  readonly handoffId: string;
  readonly actionId: string;
  readonly prompt: string;
  readonly selectedAttachmentIds: readonly string[];
}

export interface MobileRelayStore {
  readonly transitionBugReady: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileBugReadyRequest;
  }) => MobileBugRecord | Promise<MobileBugRecord>;
  readonly completeBugForVerification: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileBugCompleteRequest;
  }) => MobileBugRecord | Promise<MobileBugRecord>;
  readonly createRelayAttempt: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRelayAttemptRequest;
  }) => MobileRepairAttemptRecord | Promise<MobileRepairAttemptRecord>;
  readonly createManualAttempt: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileManualRepairAttemptRequest;
  }) => MobileManualRepairAttemptRecord | Promise<MobileManualRepairAttemptRecord>;
  readonly getManualAttempt: (query: {
    readonly actorId: string;
    readonly attemptId: string;
  }) => MobileManualRepairAttemptRecord | null | Promise<MobileManualRepairAttemptRecord | null>;
  readonly startManualAttempt: (command: {
    readonly actorId: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRepairAttemptStartRequest;
  }) => MobileManualRepairAttemptRecord | Promise<MobileManualRepairAttemptRecord>;
  readonly deliverManualAttempt: (command: {
    readonly actorId: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRepairAttemptDeliveryRequest;
  }) => MobileManualRepairAttemptRecord | Promise<MobileManualRepairAttemptRecord>;
  readonly dispatchRelay: (command: {
    readonly actorId: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRelayDispatchRequest;
  }) => MobileRelayDispatchAccepted | Promise<MobileRelayDispatchAccepted>;
  readonly continueRelay: (command: {
    readonly actorId: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRelayContinueRequest;
  }) => MobileRelayContinueAccepted | Promise<MobileRelayContinueAccepted>;
  readonly getRelayReceipt: (query: {
    readonly actorId: string;
    readonly attemptId: string;
  }) => MobileRelayReceipt | null | Promise<MobileRelayReceipt | null>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unexpected property: ${key}`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value as number;
}

export function requireRelayUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
}

export function requireRelayIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length < 1 || value.length > 255) {
    throw new TypeError("Idempotency-Key is required");
  }
  return value;
}

export function parseMobileBugReadyRequest(value: unknown): MobileBugReadyRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "toState"]));
  if (body["toState"] !== "ready") throw new TypeError("only ready is supported");
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    toState: "ready",
  };
}

export function parseMobileBugCompleteRequest(value: unknown): MobileBugCompleteRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "repairAttemptId", "reason"]));
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    repairAttemptId: requireRelayUuid(body["repairAttemptId"], "repairAttemptId"),
    reason: boundedDeliveryString(body["reason"], "reason", 1, 5_000),
  };
}

export function parseMobileRelayAttemptRequest(value: unknown): MobileRelayAttemptRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "mode", "assigneeId", "summary"]));
  if (body["mode"] !== "relay") throw new TypeError("mode must be relay");
  const summary = body["summary"];
  if (summary !== undefined && (typeof summary !== "string" || summary.length > 5_000)) {
    throw new TypeError("summary is invalid");
  }
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    mode: "relay",
    assigneeId: requireRelayUuid(body["assigneeId"], "assigneeId"),
    ...(summary === undefined ? {} : { summary }),
  };
}

export function parseMobileManualRepairAttemptRequest(
  value: unknown,
): MobileManualRepairAttemptRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "mode", "assigneeId", "summary"]));
  if (body["mode"] !== "human") throw new TypeError("mode must be human");
  const summary = body["summary"];
  if (summary !== undefined && (typeof summary !== "string" || summary.length > 5_000)) {
    throw new TypeError("summary is invalid");
  }
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    mode: "human",
    assigneeId: requireRelayUuid(body["assigneeId"], "assigneeId"),
    ...(summary === undefined ? {} : { summary }),
  };
}

export function parseMobileRepairAttemptStartRequest(
  value: unknown,
): MobileRepairAttemptStartRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "reason"]));
  const reason = body["reason"];
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 5_000)) {
    throw new TypeError("reason is invalid");
  }
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseMobileRepairAttemptRequest(value: unknown): MobileRepairAttemptRequest {
  const body = record(value);
  return body["mode"] === "human"
    ? parseMobileManualRepairAttemptRequest(body)
    : parseMobileRelayAttemptRequest(body);
}

function boundedDeliveryString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function deliveryUrl(value: unknown, label: string): string {
  const candidate = boundedDeliveryString(value, label, 1, 4_000);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTP or HTTPS`);
  }
  return candidate;
}

export function parseMobileRepairAttemptDeliveryRequest(
  value: unknown,
): MobileRepairAttemptDeliveryRequest {
  const body = record(value);
  onlyKeys(
    body,
    new Set([
      "expectedVersion",
      "summary",
      "deliveryKind",
      "branch",
      "commitSha",
      "mergeRequestUrl",
      "patchUrl",
      "noCodeReason",
    ]),
  );
  const deliveryKind = body["deliveryKind"];
  if (deliveryKind !== "code" && deliveryKind !== "no_code") {
    throw new TypeError("deliveryKind must be code or no_code");
  }
  const summary = boundedDeliveryString(body["summary"], "summary", 1, 10_000);
  const expectedVersion = positiveInteger(body["expectedVersion"], "expectedVersion");
  const branch = body["branch"];
  const commitSha = body["commitSha"];
  const mergeRequestUrl = body["mergeRequestUrl"];
  const patchUrl = body["patchUrl"];
  const noCodeReason = body["noCodeReason"];
  if (deliveryKind === "code") {
    if (branch === undefined || commitSha === undefined) {
      throw new TypeError("code delivery requires branch and commitSha evidence");
    }
    const parsedCommitSha = boundedDeliveryString(commitSha, "commitSha", 40, 40);
    if (!COMMIT_PATTERN.test(parsedCommitSha)) throw new TypeError("commitSha is invalid");
    if (noCodeReason !== undefined)
      throw new TypeError("code delivery cannot include noCodeReason");
    return {
      expectedVersion,
      summary,
      deliveryKind,
      branch: boundedDeliveryString(branch, "branch", 1, 300),
      commitSha: parsedCommitSha,
      ...(mergeRequestUrl === undefined
        ? {}
        : { mergeRequestUrl: deliveryUrl(mergeRequestUrl, "mergeRequestUrl") }),
      ...(patchUrl === undefined ? {} : { patchUrl: deliveryUrl(patchUrl, "patchUrl") }),
    };
  }
  if (
    branch !== undefined ||
    commitSha !== undefined ||
    mergeRequestUrl !== undefined ||
    patchUrl !== undefined ||
    noCodeReason === undefined
  ) {
    throw new TypeError("no_code delivery requires noCodeReason and no code evidence");
  }
  return {
    expectedVersion,
    summary,
    deliveryKind,
    noCodeReason: boundedDeliveryString(noCodeReason, "noCodeReason", 1, 5_000),
  };
}

export function parseMobileRelayDispatchRequest(value: unknown): MobileRelayDispatchRequest {
  const body = record(value);
  onlyKeys(body, new Set(["expectedVersion", "handoffId", "selectedAttachmentIds"]));
  if (!Array.isArray(body["selectedAttachmentIds"]) || body["selectedAttachmentIds"].length > 8) {
    throw new TypeError("selectedAttachmentIds must be an array of at most eight UUIDs");
  }
  const selectedAttachmentIds = body["selectedAttachmentIds"].map((entry) =>
    requireRelayUuid(entry, "selectedAttachmentId"),
  );
  if (new Set(selectedAttachmentIds).size !== selectedAttachmentIds.length) {
    throw new TypeError("selectedAttachmentIds must be unique");
  }
  return {
    expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"),
    handoffId: requireRelayUuid(body["handoffId"], "handoffId"),
    selectedAttachmentIds,
  };
}

export function parseMobileRelayContinueRequest(value: unknown): MobileRelayContinueRequest {
  const body = record(value);
  onlyKeys(body, new Set(["handoffId", "actionId", "prompt", "selectedAttachmentIds"]));
  if (!Array.isArray(body["selectedAttachmentIds"]) || body["selectedAttachmentIds"].length > 8) {
    throw new TypeError("selectedAttachmentIds must be an array of at most eight UUIDs");
  }
  const selectedAttachmentIds = body["selectedAttachmentIds"].map((entry) =>
    requireRelayUuid(entry, "selectedAttachmentId"),
  );
  if (new Set(selectedAttachmentIds).size !== selectedAttachmentIds.length) {
    throw new TypeError("selectedAttachmentIds must be unique");
  }
  return {
    handoffId: requireRelayUuid(body["handoffId"], "handoffId"),
    actionId: requireRelayUuid(body["actionId"], "actionId"),
    prompt: boundedDeliveryString(body["prompt"], "prompt", 1, 20_000),
    selectedAttachmentIds,
  };
}
