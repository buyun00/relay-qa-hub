import { randomUUID } from "node:crypto";

import type { MobileRelayOutboxClaim, SqliteStorageWorker } from "@relay-qa-hub/storage";

const FAKE_RELAY_HANDOFF_PATH = "/api/fake-relay/v1/handoffs";
const MAX_RECEIPT_BYTES = 64 * 1024;

export interface MobileRelayOutboxPump {
  stop(): Promise<void>;
}

export interface MobileRelayOutboxPumpOptions {
  readonly worker: SqliteStorageWorker;
  readonly endpoint: URL;
  readonly onDelivery?: (claim: MobileRelayOutboxClaim, status: "submitted") => void;
  readonly onRetry?: (claim: MobileRelayOutboxClaim, errorCode: string) => void;
}

interface FakeRelayReceipt {
  readonly handoffId: string;
  readonly bugId: string;
  readonly repairAttemptId: string;
  readonly relayInstanceId: "fake-relay-local";
  readonly relayTaskId: string;
  readonly handoffStatus: "submitted";
  readonly externalRevision: number;
  readonly lastEventAt: string;
  readonly payloadDigest: string;
}

export function parseFakeRelayEndpoint(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== FAKE_RELAY_HANDOFF_PATH
  ) {
    throw new Error(
      `QA_HUB_FAKE_RELAY_URL must be a credential-free loopback HTTP ${FAKE_RELAY_HANDOFF_PATH} endpoint`,
    );
  }
  return endpoint;
}

function requireString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength: number,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length < 1 || field.length > maximumLength) {
    throw new Error(`FAKE_RELAY_INVALID_${key.toUpperCase()}`);
  }
  return field;
}

function parseFakeRelayReceipt(text: string, claim: MobileRelayOutboxClaim): FakeRelayReceipt {
  if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) {
    throw new Error("FAKE_RELAY_RECEIPT_TOO_LARGE");
  }
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FAKE_RELAY_INVALID_RECEIPT");
  }
  const receipt = value as Readonly<Record<string, unknown>>;
  const externalRevision = receipt["externalRevision"];
  const parsed: FakeRelayReceipt = {
    handoffId: requireString(receipt, "handoffId", 36),
    bugId: requireString(receipt, "bugId", 36),
    repairAttemptId: requireString(receipt, "repairAttemptId", 36),
    relayInstanceId: requireString(receipt, "relayInstanceId", 120) as "fake-relay-local",
    relayTaskId: requireString(receipt, "relayTaskId", 200),
    handoffStatus: requireString(receipt, "handoffStatus", 40) as "submitted",
    externalRevision:
      typeof externalRevision === "number" && Number.isSafeInteger(externalRevision)
        ? externalRevision
        : 0,
    lastEventAt: requireString(receipt, "lastEventAt", 40),
    payloadDigest: requireString(receipt, "payloadDigest", 64),
  };
  if (
    parsed.handoffId !== claim.handoffId ||
    parsed.bugId !== claim.bugId ||
    parsed.repairAttemptId !== claim.repairAttemptId ||
    parsed.relayInstanceId !== claim.relayInstanceId ||
    parsed.handoffStatus !== "submitted" ||
    parsed.externalRevision < 1 ||
    parsed.payloadDigest !== claim.payloadDigest ||
    !Number.isFinite(Date.parse(parsed.lastEventAt))
  ) {
    throw new Error("FAKE_RELAY_RECEIPT_MISMATCH");
  }
  return parsed;
}

function deliveryErrorCode(error: unknown): string {
  if (error instanceof Error && /^FAKE_RELAY_[A-Z0-9_]+$/.test(error.message)) {
    return error.message.slice(0, 120);
  }
  return "FAKE_RELAY_UNAVAILABLE";
}

async function deliverOne(
  options: MobileRelayOutboxPumpOptions,
  leaseOwner: string,
): Promise<boolean> {
  const now = new Date();
  const claim = await options.worker.claimMobileRelayOutbox({
    leaseOwner,
    now: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 5_000).toISOString(),
  });
  if (claim === null) return false;

  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        handoffId: claim.handoffId,
        bugId: claim.bugId,
        attemptId: claim.repairAttemptId,
        idempotencyKey: claim.idempotencyKey,
        payloadDigest: claim.payloadDigest,
        selectedAttachmentIds: claim.selectedAttachmentIds,
      }),
      signal: AbortSignal.timeout(1_500),
    });
    if (response.status !== 202) throw new Error(`FAKE_RELAY_HTTP_${response.status}`);
    const receipt = parseFakeRelayReceipt(await response.text(), claim);
    await options.worker.completeMobileRelayOutbox({
      outboxMessageId: claim.outboxMessageId,
      leaseOwner,
      relayTaskId: receipt.relayTaskId,
      handoffStatus: receipt.handoffStatus,
      externalRevision: receipt.externalRevision,
      lastEventAt: receipt.lastEventAt,
      payloadDigest: receipt.payloadDigest,
      receivedAt: new Date().toISOString(),
    });
    options.onDelivery?.(claim, "submitted");
  } catch (error: unknown) {
    const errorCode = deliveryErrorCode(error);
    await options.worker.retryMobileRelayOutbox({
      outboxMessageId: claim.outboxMessageId,
      leaseOwner,
      errorCode,
      nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
    });
    options.onRetry?.(claim, errorCode);
  }
  return true;
}

export function startMobileRelayOutboxPump(
  options: MobileRelayOutboxPumpOptions,
): MobileRelayOutboxPump {
  const leaseOwner = `qa-hub-api-${randomUUID()}`;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active = Promise.resolve();

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      active = deliverOne(options, leaseOwner)
        .then((delivered) => schedule(delivered ? 0 : 100))
        .catch(() => schedule(250));
    }, delayMs);
    timer.unref();
  };
  schedule(0);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
