import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MOBILE_RELAY_WEBHOOK_PATH = "/api/v1/integrations/relay/webhooks" as const;
export const MAX_RELAY_WEBHOOK_BYTES = 256 * 1024;
export const RELAY_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

/**
 * The Relay outbox sends the normalized status name as the event type. Keep
 * this list deliberately small: a Relay event is a delivery fact, not a
 * command to accept or close a QA item.
 */
export const MOBILE_RELAY_WEBHOOK_EVENT_TYPES = Object.freeze([
  "submitted",
  "running",
  "needs_input",
  "blocked",
  "failed",
  "fix_delivered",
] as const);

export type MobileRelayWebhookEventType = (typeof MOBILE_RELAY_WEBHOOK_EVENT_TYPES)[number];

/**
 * Relay and QA Hub use identifiers that are safe to put in a header, log, or
 * SQLite key. They are not required to be UUIDs: the Relay event outbox uses
 * stable labels such as `relay-main:event:<id>`.
 */
const RELAY_SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const RELAY_SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/u;
const RELAY_DELIVERY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/u;
const BUILD_PROJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface MobileRelayDeliveryEvidence {
  readonly pushed: true;
  readonly verified: true;
  readonly commitSha: string;
  readonly remoteSha: string;
  readonly branch: string;
  readonly mergeRequestUrl: string | null;
}
export interface MobileRelayBuildRequirement {
  readonly required: boolean;
  readonly projectKey: string | null;
}

export interface MobileRelayWorkspace {
  readonly projectId: string;
  readonly branchName: string | null;
  readonly threadId: string | null;
}

export type MobileRelayIdentity = string | number;

export interface MobileRelayWebhookPayload {
  readonly taskId?: MobileRelayIdentity | null;
  readonly turnId?: MobileRelayIdentity | null;
  readonly threadId?: string | null;
  readonly workspace?: MobileRelayWorkspace | null;
  readonly requestHash?: string | null;
  readonly statusReason: string | null;
  readonly deliveryEvidence?: MobileRelayDeliveryEvidence;
  readonly buildRequirement?: MobileRelayBuildRequirement;
}

/**
 * Canonical schemaVersion 1.0 envelope accepted from the real Relay
 * provider. `legacyTurnDelivered` is an in-memory marker only; it is never
 * serialized or forwarded to storage. It exists solely for the old fake
 * callback fixture, whose `turn.delivered` envelope predates this contract.
 */
export interface MobileRelayWebhook {
  readonly schemaVersion: "1.0";
  readonly relayInstanceId: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly eventType: MobileRelayWebhookEventType;
  readonly handoffId: string;
  readonly attemptId: string;
  readonly externalRevision: number;
  readonly occurredAt: string;
  readonly payload: MobileRelayWebhookPayload;
  readonly legacyTurnDelivered?: true;
}

/**
 * Compatibility view retained for callers/tests that explicitly exercise the
 * historical turn.delivered envelope. New callers should use
 * parseMobileRelayWebhook(); the HTTP route forwards only normalized status
 * names to the generalized store command.
 */
export interface MobileRelayDeliveredWebhook extends Omit<
  MobileRelayWebhook,
  "eventType" | "legacyTurnDelivered"
> {
  readonly eventType: "turn.delivered";
}

/**
 * The API adapter deliberately owns one generalized command. Storage can
 * project every Relay status through the same durable Inbox/revision path,
 * while event-specific payload remains explicitly allowlisted.
 */
export interface MobileRelayWebhookCommand {
  readonly relayInstanceId: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly eventType: MobileRelayWebhookEventType;
  readonly handoffId: string;
  readonly attemptId: string;
  readonly externalRevision: number;
  readonly occurredAt: string;
  readonly taskId?: MobileRelayIdentity | null;
  readonly turnId?: MobileRelayIdentity | null;
  readonly threadId?: string | null;
  readonly workspace?: MobileRelayWorkspace | null;
  readonly requestHash?: string | null;
  readonly statusReason: string | null;
  readonly commitSha?: string | null;
  readonly remoteSha?: string | null;
  readonly branch?: string | null;
  readonly mergeRequestUrl?: string | null;
  readonly buildRequirement?: MobileRelayBuildRequirement | "required" | "not_required" | null;
  readonly payloadDigest: string;
  readonly rawPayloadJson: string;
  readonly receivedAt: string;
}

export interface MobileRelayWebhookStore {
  readonly receiveRelayWebhook: (
    command: MobileRelayWebhookCommand,
  ) => MobileRelayWebhookStoreResult | Promise<MobileRelayWebhookStoreResult>;
}

export interface MobileRelayWebhookStoreResult {
  readonly inboxMessageId: string;
  readonly replayed: boolean;
  readonly projectionStatus: "applied" | "ignored" | "replayed";
}

export class MobileRelayWebhookRequestError extends Error {
  readonly code:
    "INVALID_REQUEST" | "INTEGRATION_SIGNATURE_INVALID" | "RELAY_DELIVERY_EVIDENCE_INVALID";

  constructor(
    code: "INVALID_REQUEST" | "INTEGRATION_SIGNATURE_INVALID" | "RELAY_DELIVERY_EVIDENCE_INVALID",
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

function safeIdentifier(value: unknown, max = 200): string {
  const parsed = boundedString(value, 1, max);
  if (
    parsed !== parsed.trim() ||
    !RELAY_SAFE_IDENTIFIER_PATTERN.test(parsed) ||
    parsed.length > 200
  ) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  return parsed;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  return value as number;
}

function relayIdentity(value: unknown): MobileRelayIdentity | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number") return positiveInteger(value);
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 300 ||
    value !== value.trim() ||
    !RELAY_SAFE_REFERENCE_PATTERN.test(value)
  ) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  return value;
}

function nullableReference(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 300 ||
    value !== value.trim() ||
    !RELAY_SAFE_REFERENCE_PATTERN.test(value)
  ) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  void field;
  return value;
}

function parseWorkspace(value: unknown): MobileRelayWorkspace | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const workspace = object(value);
  onlyKeys(workspace, new Set(["projectId", "branchName", "threadId"]));
  const projectId = nullableReference(workspace["projectId"], "workspace.projectId");
  if (projectId === null) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  return {
    projectId,
    branchName: nullableReference(workspace["branchName"], "workspace.branchName"),
    threadId: nullableReference(workspace["threadId"], "workspace.threadId"),
  };
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

function parseDeliveryEvidence(value: unknown): MobileRelayDeliveryEvidence {
  const evidence = object(value);
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
    commitSha !== remoteSha ||
    branch !== branch.trim() ||
    /[\u0000-\u001f\u007f]/u.test(branch)
  ) {
    throw new MobileRelayWebhookRequestError("RELAY_DELIVERY_EVIDENCE_INVALID");
  }

  return {
    pushed: true,
    verified: true,
    commitSha,
    remoteSha,
    branch,
    mergeRequestUrl: nullableUri(evidence["mergeRequestUrl"]),
  };
}

function parseBuildRequirement(value: unknown): MobileRelayBuildRequirement {
  const requirement = object(value);
  onlyKeys(requirement, new Set(["required", "projectKey"]));
  if (typeof requirement["required"] !== "boolean") {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  const projectKey = requirement["projectKey"];
  if (projectKey !== null && projectKey !== undefined) {
    if (typeof projectKey !== "string" || !BUILD_PROJECT_KEY_PATTERN.test(projectKey)) {
      throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
    }
  }
  return {
    required: requirement["required"] as boolean,
    projectKey: projectKey === undefined ? null : (projectKey as string | null),
  };
}

const COMMON_PAYLOAD_KEYS = new Set([
  "taskId",
  "turnId",
  "threadId",
  "workspace",
  "requestHash",
  "statusReason",
]);
const DELIVERY_PAYLOAD_KEYS = new Set([
  ...COMMON_PAYLOAD_KEYS,
  "deliveryEvidence",
  "buildRequirement",
]);

function parsePayload(
  value: unknown,
  eventType: MobileRelayWebhookEventType,
  legacyTurnDelivered: boolean,
): MobileRelayWebhookPayload {
  const payload = object(value);
  onlyKeys(payload, eventType === "fix_delivered" ? DELIVERY_PAYLOAD_KEYS : COMMON_PAYLOAD_KEYS);
  const parsedTaskId = relayIdentity(payload["taskId"]);
  const parsedTurnId = relayIdentity(payload["turnId"]);
  const threadId = nullableReference(payload["threadId"], "threadId");
  const workspace = parseWorkspace(payload["workspace"]);
  const requestHash = payload["requestHash"];
  if (
    requestHash !== undefined &&
    requestHash !== null &&
    (typeof requestHash !== "string" || !/^[0-9a-f]{64}$/u.test(requestHash))
  ) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  const statusReason = nullableReason(payload["statusReason"]);

  if (eventType !== "fix_delivered") {
    return {
      ...(parsedTaskId === undefined ? {} : { taskId: parsedTaskId }),
      ...(parsedTurnId === undefined ? {} : { turnId: parsedTurnId }),
      threadId,
      ...(workspace === undefined ? {} : { workspace }),
      ...(requestHash === undefined ? {} : { requestHash: requestHash as string | null }),
      statusReason,
    };
  }

  if (
    parsedTaskId === undefined ||
    parsedTaskId === null ||
    parsedTurnId === undefined ||
    parsedTurnId === null
  ) {
    throw new MobileRelayWebhookRequestError("RELAY_DELIVERY_EVIDENCE_INVALID");
  }

  const evidenceValue = payload["deliveryEvidence"];
  if (evidenceValue === undefined) {
    throw new MobileRelayWebhookRequestError("RELAY_DELIVERY_EVIDENCE_INVALID");
  }
  const deliveryEvidence = parseDeliveryEvidence(evidenceValue);
  const buildRequirementValue = payload["buildRequirement"];
  if (buildRequirementValue === undefined && !legacyTurnDelivered) {
    throw new MobileRelayWebhookRequestError("RELAY_DELIVERY_EVIDENCE_INVALID");
  }
  const buildRequirement =
    buildRequirementValue === undefined
      ? { required: false, projectKey: null }
      : parseBuildRequirement(buildRequirementValue);
  return {
    taskId: parsedTaskId,
    turnId: parsedTurnId,
    threadId,
    ...(workspace === undefined ? {} : { workspace }),
    ...(requestHash === undefined ? {} : { requestHash: requestHash as string | null }),
    statusReason,
    deliveryEvidence,
    buildRequirement,
  };
}

function parseEnvelope(
  value: unknown,
  options: { readonly allowLegacyTurnDelivered: boolean },
): MobileRelayWebhook {
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
  if (body["schemaVersion"] !== "1.0") {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }

  const relayInstanceId = boundedString(body["relayInstanceId"], 3, 64);
  if (!INSTANCE_PATTERN.test(relayInstanceId)) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  const occurredAt = boundedString(body["occurredAt"], 1, 100);
  if (occurredAt !== occurredAt.trim() || !Number.isFinite(Date.parse(occurredAt))) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }

  const rawEventType = body["eventType"];
  const legacyTurnDelivered = rawEventType === "turn.delivered";
  if (
    !MOBILE_RELAY_WEBHOOK_EVENT_TYPES.includes(rawEventType as MobileRelayWebhookEventType) &&
    !(legacyTurnDelivered && options.allowLegacyTurnDelivered)
  ) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  const eventType: MobileRelayWebhookEventType = legacyTurnDelivered
    ? "fix_delivered"
    : (rawEventType as MobileRelayWebhookEventType);

  const deliveryId = boundedString(body["deliveryId"], 1, 255);
  if (deliveryId !== deliveryId.trim() || !RELAY_DELIVERY_IDENTIFIER_PATTERN.test(deliveryId)) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }

  return {
    schemaVersion: "1.0",
    relayInstanceId,
    eventId: safeIdentifier(body["eventId"]),
    deliveryId,
    eventType,
    handoffId: safeIdentifier(body["handoffId"]),
    attemptId: safeIdentifier(body["attemptId"]),
    externalRevision: positiveInteger(body["externalRevision"]),
    occurredAt,
    payload: parsePayload(body["payload"], eventType, legacyTurnDelivered),
    ...(legacyTurnDelivered ? { legacyTurnDelivered: true as const } : {}),
  };
}

/**
 * Parse the schemaVersion 1.0 generalized Relay webhook. The legacy option is
 * intentionally opt-in and is used only by the compatibility wrapper and
 * the historical fake Relay fixture.
 */
export function parseMobileRelayWebhook(
  value: unknown,
  options: { readonly allowLegacyTurnDelivered?: boolean } = {},
): MobileRelayWebhook {
  return parseEnvelope(value, {
    allowLegacyTurnDelivered: options.allowLegacyTurnDelivered === true,
  });
}

/**
 * Historical compatibility parser. New callers should use
 * parseMobileRelayWebhook(); the real Relay contract is the normalized status
 * event set above, not turn.delivered.
 */
export function parseMobileRelayDeliveredWebhook(value: unknown): MobileRelayDeliveredWebhook {
  const parsed = parseEnvelope(value, { allowLegacyTurnDelivered: true });
  if (!parsed.legacyTurnDelivered) {
    throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
  }
  const legacyPayload: MobileRelayWebhookPayload = {
    ...(parsed.payload.taskId === undefined ? {} : { taskId: parsed.payload.taskId }),
    ...(parsed.payload.turnId === undefined ? {} : { turnId: parsed.payload.turnId }),
    ...(parsed.payload.threadId === undefined ? {} : { threadId: parsed.payload.threadId }),
    ...(parsed.payload.workspace === undefined ? {} : { workspace: parsed.payload.workspace }),
    ...(parsed.payload.requestHash === undefined
      ? {}
      : { requestHash: parsed.payload.requestHash }),
    statusReason: parsed.payload.statusReason,
    ...(parsed.payload.deliveryEvidence === undefined
      ? {}
      : { deliveryEvidence: parsed.payload.deliveryEvidence }),
  };
  return {
    schemaVersion: parsed.schemaVersion,
    relayInstanceId: parsed.relayInstanceId,
    eventId: parsed.eventId,
    deliveryId: parsed.deliveryId,
    eventType: "turn.delivered",
    handoffId: parsed.handoffId,
    attemptId: parsed.attemptId,
    externalRevision: parsed.externalRevision,
    occurredAt: parsed.occurredAt,
    payload: legacyPayload,
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
  readonly webhook: Pick<MobileRelayWebhook, "deliveryId" | "eventId">;
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
