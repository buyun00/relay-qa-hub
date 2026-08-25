import type {
  MobileBugRecord,
  MobileRelayDispatchAccepted,
  MobileRelayReceipt,
  MobileRepairAttemptRecord,
} from "@relay-qa-hub/storage";

export const MOBILE_BUG_TRANSITION_PATH = "/api/v1/bugs/:bugId/transitions" as const;
export const MOBILE_BUG_REPAIR_ATTEMPTS_PATH = "/api/v1/bugs/:bugId/repair-attempts" as const;
export const MOBILE_RELAY_DISPATCH_PATH =
  "/api/v1/repair-attempts/:attemptId/dispatch/relay" as const;
export const MOBILE_RELAY_RECEIPT_PATH =
  "/api/v1/repair-attempts/:attemptId/relay-receipt" as const;

export interface MobileBugReadyRequest {
  readonly expectedVersion: number;
  readonly toState: "ready";
}

export interface MobileRelayAttemptRequest {
  readonly expectedVersion: number;
  readonly mode: "relay";
  readonly assigneeId: string;
  readonly summary?: string;
}

export interface MobileRelayDispatchRequest {
  readonly expectedVersion: number;
  readonly handoffId: string;
  readonly selectedAttachmentIds: readonly string[];
}

export interface MobileRelayStore {
  readonly transitionBugReady: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileBugReadyRequest;
  }) => MobileBugRecord | Promise<MobileBugRecord>;
  readonly createRelayAttempt: (command: {
    readonly actorId: string;
    readonly bugId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRelayAttemptRequest;
  }) => MobileRepairAttemptRecord | Promise<MobileRepairAttemptRecord>;
  readonly dispatchRelay: (command: {
    readonly actorId: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRelayDispatchRequest;
  }) => MobileRelayDispatchAccepted | Promise<MobileRelayDispatchAccepted>;
  readonly getRelayReceipt: (query: {
    readonly actorId: string;
    readonly attemptId: string;
  }) => MobileRelayReceipt | null | Promise<MobileRelayReceipt | null>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

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
  return { expectedVersion: positiveInteger(body["expectedVersion"], "expectedVersion"), toState: "ready" };
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
