import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createMobileNotificationReadRequestDigest,
  deriveMobileReplayDigestKey,
} from "../dist/mobile-replay-digest.js";

const DOMAIN = "relay-qa-hub/mobile-replay-digest-key/v1";

test("notification read replay digest is server-keyed and binds the canonical complete command", () => {
  const token = "protected-server-access-token-with-sufficient-entropy";
  const key = deriveMobileReplayDigestKey(token);
  const input = {
    key,
    accountId: "10000000-0000-4000-8000-000000000001",
    projectId: "10000000-0000-4000-8000-000000000002",
    actorId: "10000000-0000-4000-8000-000000000003",
    notificationId: "10000000-0000-4000-8000-000000000004",
    idempotencyKey: "read-once",
    request: { expectedVersion: 1 },
  };
  const expectedKey = createHmac("sha256", Buffer.from(token, "utf8"))
    .update(DOMAIN, "utf8")
    .digest();
  const canonicalMessage = JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    operationId: "markNotificationRead",
    request: input.request,
    scope: {
      accountId: input.accountId,
      actorId: input.actorId,
      notificationId: input.notificationId,
      projectId: input.projectId,
    },
  });
  const expectedDigest = createHmac("sha256", expectedKey)
    .update(canonicalMessage, "utf8")
    .digest("hex");

  assert.deepEqual(Buffer.from(key), expectedKey);
  assert.equal(createMobileNotificationReadRequestDigest(input), expectedDigest);
  assert.notEqual(
    createMobileNotificationReadRequestDigest({ ...input, idempotencyKey: "read-again" }),
    expectedDigest,
  );
  assert.notEqual(
    createMobileNotificationReadRequestDigest({
      ...input,
      notificationId: "10000000-0000-4000-8000-000000000005",
    }),
    expectedDigest,
  );
});

test("mobile replay digest key validation rejects missing server secrets and short keys", () => {
  assert.throws(() => deriveMobileReplayDigestKey(""), /must not be empty/u);
  assert.throws(
    () =>
      createMobileNotificationReadRequestDigest({
        key: new Uint8Array(31),
        accountId: "10000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000002",
        actorId: "10000000-0000-4000-8000-000000000003",
        notificationId: "10000000-0000-4000-8000-000000000004",
        idempotencyKey: "read-once",
        request: { expectedVersion: 1 },
      }),
    /at least 32 bytes/u,
  );
});
