import { createHmac } from "node:crypto";

const MOBILE_REPLAY_DIGEST_KEY_DOMAIN = "relay-qa-hub/mobile-replay-digest-key/v1";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function deriveMobileReplayDigestKey(accessToken: string): Uint8Array {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new TypeError("mobile access token must not be empty");
  }
  return Uint8Array.from(
    createHmac("sha256", Buffer.from(accessToken, "utf8"))
      .update(MOBILE_REPLAY_DIGEST_KEY_DOMAIN, "utf8")
      .digest(),
  );
}

export function createMobileNotificationReadRequestDigest(input: {
  readonly key: Uint8Array;
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly notificationId: string;
  readonly idempotencyKey: string;
  readonly request: Readonly<{ expectedVersion: number }>;
}): string {
  if (input.key.byteLength < 32) {
    throw new TypeError("mobile replay digest key must contain at least 32 bytes");
  }
  const message = JSON.stringify(
    canonicalize({
      idempotencyKey: input.idempotencyKey,
      operationId: "markNotificationRead",
      request: input.request,
      scope: {
        accountId: input.accountId,
        actorId: input.actorId,
        notificationId: input.notificationId,
        projectId: input.projectId,
      },
    }),
  );
  return createHmac("sha256", input.key).update(message, "utf8").digest("hex");
}
