import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  decodeMobileReadCursor,
  digestMobileReadBinding,
  encodeMobileReadCursor,
} from "../src/mobile-read-cursor.js";

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

test("mobile read cursor round-trips one canonical endpoint-bound position", () => {
  const token = encodeMobileReadCursor(
    {
      kind: "project-members",
      authorizationDigest: digestMobileReadBinding({ accountId: "a", actorId: "u" }),
      filterDigest: digestMobileReadBinding({ projectId: "p" }),
      snapshotSequence: 17,
      position: { displayName: "alice", userId: "00000000-0000-4000-8000-000000000001" },
    },
    key,
  );

  assert.ok(token.length <= 500);
  assert.deepEqual(
    decodeMobileReadCursor(token, {
      kind: "project-members",
      authorizationDigest: digestMobileReadBinding({ accountId: "a", actorId: "u" }),
      filterDigest: digestMobileReadBinding({ projectId: "p" }),
      signingKey: key,
    }),
    {
      snapshotSequence: 17,
      position: { displayName: "alice", userId: "00000000-0000-4000-8000-000000000001" },
    },
  );
});

test("mobile read cursor rejects a validly signed non-canonical or extra-field payload", () => {
  const authorizationDigest = digestMobileReadBinding({ accountId: "a", actorId: "u" });
  const filterDigest = digestMobileReadBinding({ projectId: "p" });
  const payload = `{"v":1,"k":"project-members","a":"${authorizationDigest}","f":"${filterDigest}","s":17,"p":null,"extra":true}`;
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(`r1.${encoded}`).digest("base64url");

  assert.throws(
    () =>
      decodeMobileReadCursor(`r1.${encoded}.${signature}`, {
        kind: "project-members",
        authorizationDigest,
        filterDigest,
        signingKey: key,
      }),
    /cursor is invalid/u,
  );
});

test("mobile read cursor is bound to endpoint, authorization and normalized filters", () => {
  const authorizationDigest = digestMobileReadBinding({ accountId: "a", actorId: "u" });
  const filterDigest = digestMobileReadBinding({ projectId: "p", status: null });
  const token = encodeMobileReadCursor(
    {
      kind: "project-builds",
      authorizationDigest,
      filterDigest,
      snapshotSequence: 2,
      position: { id: "00000000-0000-4000-8000-000000000001" },
    },
    key,
  );

  for (const changed of [
    { kind: "bug-comments", authorizationDigest, filterDigest },
    {
      kind: "project-builds",
      authorizationDigest: digestMobileReadBinding({ accountId: "a", actorId: "other" }),
      filterDigest,
    },
    {
      kind: "project-builds",
      authorizationDigest,
      filterDigest: digestMobileReadBinding({ projectId: "p", status: "ready" }),
    },
  ] as const) {
    assert.throws(
      () => decodeMobileReadCursor(token, { ...changed, signingKey: key }),
      /cursor is invalid/u,
    );
  }
});
