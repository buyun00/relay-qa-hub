import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Load only the real, self-contained sanitizer. Importing the smoke runner
// would execute live acceptance requests and read its runtime credentials.
const source = readFileSync(new URL("./mcp-core.smoke.mjs", import.meta.url), "utf8");
const start = source.indexOf("function redact(");
const end = source.indexOf("\nasync function rpc", start);
assert.ok(start >= 0 && end > start);
const sanitize = runInNewContext(`(${source.slice(start, end)})`);
const redact = (value) => JSON.parse(JSON.stringify(sanitize(value)));

test("MCP structured and text mirrors both remove session credentials", () => {
  const principal = {
    userId: "fixture-user",
    projectId: "fixture-project",
    accessToken: "synthetic-bearer-only",
    csrfToken: "synthetic-csrf-only",
    expiresAt: "fixture-time",
  };
  const value = {
    structuredContent: principal,
    content: [{ type: "text", text: JSON.stringify(principal) }],
  };
  const result = redact(value);
  const expected = {
    userId: "fixture-user",
    projectId: "fixture-project",
    expiresAt: "fixture-time",
  };
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-(bearer|csrf)-only/u);
});

test("repeated JSON encoding and nested arrays do not hide sensitive fields", () => {
  const nested = {
    items: [
      {
        Password: "synthetic-password",
        good: "preserved",
        headers: { Cookie: "synthetic-cookie", Authorization: "synthetic-authorization" },
      },
    ],
  };
  const input = { text: JSON.stringify({ envelope: JSON.stringify(JSON.stringify(nested)) }) };
  const result = redact(input);
  const inner = JSON.parse(JSON.parse(JSON.parse(result.text).envelope));
  assert.deepEqual(inner, { items: [{ good: "preserved", headers: {} }] });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-/u);
});

test("private keys API credentials and refresh secrets are removed by field name", () => {
  const result = redact({
    private_key: "synthetic-private",
    apiKey: "synthetic-api",
    clientSecret: "synthetic-client",
    refresh_token: "synthetic-refresh",
    credentials: { name: "synthetic" },
    "set-cookie": "synthetic-cookie",
    nested: [{ status: "failed", errorCode: "TOKEN_EXPIRED" }],
  });
  assert.deepEqual(result, { nested: [{ status: "failed", errorCode: "TOKEN_EXPIRED" }] });
});

test("non-JSON diagnostic text and ordinary data survive redaction idempotently", () => {
  const value = {
    title: "Fixture Bug",
    text: "ordinary diagnostic: connection refused",
    state: "closed",
    count: 2,
    passed: true,
    empty: null,
    evidence: ["sha256", 42],
    jsonText: JSON.stringify({ state: "closed", note: "Token was rejected" }),
  };
  assert.deepEqual(redact(value), value);
  assert.deepEqual(redact(redact(value)), value);
});

test("excessive nesting fails closed without disclosing the inner credential", () => {
  let value = { password: "synthetic-depth-secret" };
  for (let depth = 0; depth < 70; depth++) value = { child: value };
  const result = JSON.stringify(redact(value));
  assert.match(result, /REDACTED_NESTING_LIMIT/u);
  assert.doesNotMatch(result, /synthetic-depth-secret/u);
});
