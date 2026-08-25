import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MOBILE_RELAY_WEBHOOK_PATH = "/api/v1/integrations/relay/webhooks" as const;
export const MAX_RELAY_WEBHOOK_BYTES = 256 * 1024;
export const RELAY_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/u;

export interface MobileRelayDeliveredWebhook {
  readonly schemaVersion: "1.0";
  readonly relayInstanceId: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly eventType: "turn.delivered";
  readonly handoffId: string;
  readonly attemptId: string;
  readonly externalRevision: number;
  readonly occurredAt: string;
  readonly payload: {
    readonly taskId: number;
    readonly turnId: number;
    readonly statusReason: string | null;
    readonly deliveryEvidence: {
      readonly pushed: true;
      readonly verified: true;
      readonly commitSha: string;
      readonly remoteSha: string;
      readonly branch: string;
      readonly mergeRequestUrl: string | null;
    };
  };
}

export interface MobileRelayWebhookStore {
  readonly receiveRelayWebhook: (command: {
    readonly relayInstanceId: string;
    readonly eventId: string;
    readonly deliveryId: string;
    readonly eventType: "turn.delivered";
    readonly handoffId: string;
    readonly attemptId: string;
    readonly externalRevision: number;
    readonly occurredAt: string;
    readonly taskId: number;
    readonly turnId: number;
    readonly commitSha: string;
    readonly remoteSha: string;
    readonly branch: string;
    readonly mergeRequestUrl: string | null;
    readonly payloadDigest: string;
    readonly rawPayloadJson: string;
    readonly receivedAt: string;
  }) =>
    | MobileRelayWebhookStoreResult
    | Promise<MobileRelayWebhookStoreResult>;
}

export interface MobileRelayWebhookStoreResult {
  readonly inboxMessageId: string;
  readonly replayed: boolean;
  readonly projectionStatus: "applied" | "ignored" | "replayed";
}

export class MobileRelayWebhookRequestError extends Error {
  readonly code:
    | "INVALID_REQUEST"
    | "INTEGRATION_SIGNATURE_INVALID"
    | "RELAY_DELIVERY_EVIDENCE_INVALID";

  constructor(
    code:
      | "INVALID_REQUEST"
      | "INTEGRATION_SIGNATURE_INVALID"
      | "RELAY_DELIVERY_EVIDENCE_INVALID",
  ) {
    super(code);
    this.name = "MobileRelayWebhookRequestError";
    this.code = code;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
}

function boundedString(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  return value;
}

function uuid(value: unknown): string {
  const parsed = boundedString(value, 36, 36);
  if (!UUID_PATTERN.test(parsed)) throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  return parsed;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  return value as number;
}

function nullableReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, 0, 5_000);
}

function nullableUri(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const parsed = boundedString(value, 1, 2_048);
  try {
    new URL(parsed);
  } catch {
    throw new MobileRelayWebhookRequestError("RELAY_DELIVERY_EVIDENCE_INVALID");
  }
  return parsed;
}

export function parseMobileRelayDeliveredWebhook(value: unknown): MobileRelayDeliveredWebhook {
  const body = object(value);
  onlyKeys(
    body,
    new Set([
      "schemaVersion",
      "relayInstanceId",
      "eventId",
      "deliveryId",
      "eventType",
      "handoffId",
      "attemptId",
      "externalRevision",
      "occurredAt",
      "payload",
    ]),
  );
  if (body["schemaVersion"] !== "1.0" || body["eventType"] !== "turn.delivered") {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  const relayInstanceId = boundedString(body["relayInstanceId"], 3, 64);
  if (!INSTANCE_PATTERN.test(relayInstanceId)) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  const occurredAt = boundedString(body["occurredAt"], 1, 100);
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }

  const payload = object(body["payload"]);
  onlyKeys(payload, new Set(["taskId", "turnId", "statusReason", "deliveryEvidence"]));
  const evidence = object(payload["deliveryEvidence"]);
  onlyKeys(
    evidence,
    new Set(["pushed", "verified", "commitSha", "remoteSha", "branch", "mergeRequestUrl"]),
  );
  const commitSha = boundedString(evidence["commitSha"], 40, 40);
  const remoteSha = boundedString(evidence["remoteSha"], 40, 40);
  const branch = boundedString(evidence["branch"], 1, 300);
  if (
    evidence["pushed"] !== true ||
    evidence["verified"] !== true ||
    !SHA_PATTERN.test(commitSha) ||
    !SHA_PATTERN.test(remoteSha) ||
    commitSha !== remoteSha
  ) {
    throw new MobileRelayWebhookRequestError("RELAY_DELIVERY_EVIDENCE_INVALID");
  }

  return {
    schemaVersion: "1.0",
    relayInstanceId,
    eventId: uuid(body["eventId"]),
    deliveryId: boundedString(body["deliveryId"], 1, 200),
    eventType: "turn.delivered",
    handoffId: uuid(body["handoffId"]),
    attemptId: uuid(body["attemptId"]),
    externalRevision: positiveInteger(body["externalRevision"]),
    occurredAt,
    payload: {
      taskId: positiveInteger(payload["taskId"]),
      turnId: positiveInteger(payload["turnId"]),
      statusReason: nullableReason(payload["statusReason"]),
      deliveryEvidence: {
        pushed: true,
        verified: true,
        commitSha,
        remoteSha,
        branch,
        mergeRequestUrl: nullableUri(evidence["mergeRequestUrl"]),
      },
    },
  };
}

export function authenticateMobileRelayWebhook(input: {
  readonly rawBody: Buffer;
  readonly secret: string;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly now: Date;
}): void {
  if (!input.timestamp || !/^[0-9]{1,16}$/u.test(input.timestamp)) {
    throw new MobileRelayWebhookRequestError("INTEGRATION_SIGNATURE_INVALID");
  }
  const timestampSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > RELAY_WEBHOOK_REPLAY_WINDOW_SECONDS
  ) {
    throw new MobileRelayWebhookRequestError("INTEGRATION_SIGNATURE_INVALID");
  }
  if (!input.signature || !SIGNATURE_PATTERN.test(input.signature) || input.secret.length < 1) {
    throw new MobileRelayWebhookRequestError("INTEGRATION_SIGNATURE_INVALID");
  }
  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(input.timestamp)
    .update(".")
    .update(input.rawBody)
    .digest("hex")}`;
  const suppliedBytes = Buffer.from(input.signature, "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new MobileRelayWebhookRequestError("INTEGRATION_SIGNATURE_INVALID");
  }
}

export function relayWebhookPayloadDigest(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function validateMobileRelayWebhookHeaders(input: {
  readonly webhook: MobileRelayDeliveredWebhook;
  readonly idempotencyKey: string | undefined;
  readonly deliveryId: string | undefined;
  readonly eventId: string | undefined;
}): void {
  if (
    input.idempotencyKey !== input.webhook.deliveryId ||
    input.deliveryId !== input.webhook.deliveryId ||
    input.eventId !== input.webhook.eventId
  ) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
}
