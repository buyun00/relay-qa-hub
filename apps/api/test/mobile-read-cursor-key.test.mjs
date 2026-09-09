import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { deriveMobileReadCursorSigningKey } from "../dist/mobile-read-cursor-key.js";

const DOMAIN = "relay-qa-hub/mobile-read-cursor-signing-key/v1";

test("mobile read cursor keys are deterministic, 32-byte, and domain separated", () => {
  const token = "test-access-token-with-sufficient-entropy";
  const first = deriveMobileReadCursorSigningKey(token);
  const second = deriveMobileReadCursorSigningKey(token);
  const expected = createHmac("sha256", Buffer.from(token, "utf8")).update(DOMAIN).digest();

  assert.equal(first.byteLength, 32);
  assert.deepEqual(Buffer.from(first), expected);
  assert.deepEqual(Buffer.from(second), expected);
  assert.notDeepEqual(Buffer.from(first), createHash("sha256").update(token).digest());
});

test("mobile read cursor key derivation isolates access tokens and rejects empty input", () => {
  const first = deriveMobileReadCursorSigningKey("first-access-token");
  const second = deriveMobileReadCursorSigningKey("second-access-token");

  assert.notDeepEqual(Buffer.from(first), Buffer.from(second));
  assert.throws(() => deriveMobileReadCursorSigningKey(""), /must not be empty/u);
});
