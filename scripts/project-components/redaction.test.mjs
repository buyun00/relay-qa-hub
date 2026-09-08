import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Load only the real, self-contained sanitizer. Importing the smoke runner
// would execute live acceptance requests and read its runtime credentials.
const sanitizers = [
  ["mcp-core.smoke.mjs", "redact", "rpc"],
  ["frozen-workflow-live.mjs", "clean", "call"],
].map(([filename, name, nextFunction]) => {
  const source = readFileSync(new URL(`./${filename}`, import.meta.url), "utf8");
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nasync function ${nextFunction}`, start);
  assert.ok(start >= 0 && end > start, filename);
  const sanitize = runInNewContext(`(${source.slice(start, end)})`);
  return { filename, redact: (value, depth) => JSON.parse(JSON.stringify(sanitize(value, depth))) };
});

for (const { filename, redact } of sanitizers) {
  const check = (name, run) => test(`${filename}: ${name}`, run);

  check("MCP structured and text mirrors both remove session credentials", () => {
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

  check("repeated JSON encoding and nested arrays do not hide sensitive fields", () => {
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

  check("private keys API credentials and refresh secrets are removed by field name", () => {
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

  check("non-JSON diagnostic text and ordinary data survive redaction idempotently", () => {
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

  check("primitive strings retain spelling, precision, whitespace and repeated encoding", () => {
    const primitives = [
      "2.0",
      "1.0",
      "3.50",
      "1e3",
      "1e400",
      "-0",
      "9007199254740993",
      " true ",
      "\nnull\t",
      "false",
      "1.1.0",
      '"\\u0032.0"',
      ' \n"2.0"\t',
    ];
    const value = {
      primitives,
      encoded: primitives.map((item) => JSON.stringify(JSON.stringify(item))),
      container: JSON.stringify({ jsonrpc: "2.0", items: [{ schemaVersion: "1.0" }] }),
    };
    assert.deepEqual(redact(value), value);
    assert.deepEqual(redact(redact(value)), value);
  });

  check(
    "nested secret removal preserves wire-version fields and the original request object",
    () => {
      const details = {
        jsonrpc: "2.0",
        events: [{ schemaVersion: "1.0", version: "9007199254740993" }],
        headers: { Authorization: "synthetic-request-secret" },
      };
      const value = {
        jsonrpc: "2.0",
        structuredContent: details,
        content: [{ text: JSON.stringify(JSON.stringify(details)) }],
      };
      const original = JSON.stringify(value);
      function freeze(item) {
        if (item && typeof item === "object") {
          Object.values(item).forEach(freeze);
          Object.freeze(item);
        }
      }
      freeze(value);
      const result = redact(value);
      const expected = { ...details, headers: {} };
      assert.equal(result.jsonrpc, "2.0");
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(JSON.parse(result.content[0].text)), expected);
      assert.equal(JSON.stringify(value), original);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-request-secret/u);
      assert.deepEqual(redact(result), result);
    },
  );

  check("excessive nesting fails closed without disclosing the inner credential", () => {
    let value = { password: "synthetic-depth-secret" };
    for (let depth = 0; depth < 70; depth++) value = { child: value };
    const result = JSON.stringify(redact(value));
    assert.match(result, /REDACTED_NESTING_LIMIT/u);
    assert.doesNotMatch(result, /synthetic-depth-secret/u);
  });

  check("depth boundary preserves primitive text and fails closed beyond the limit", () => {
    assert.equal(redact("2.0", 64), "2.0");
    assert.equal(redact("2.0", 65), "[REDACTED_NESTING_LIMIT]");
  });

  check("deep containers remain decodable through one or two JSON string layers", () => {
    let details = { password: "synthetic-encoded-depth-secret" };
    for (let depth = 0; depth < 70; depth++) details = { child: details };
    for (const layers of [1, 2]) {
      let text = details;
      for (let layer = 0; layer < layers; layer++) text = JSON.stringify(text);
      const result = redact({ content: [{ type: "text", text }] });
      let decoded = result.content[0].text;
      for (let layer = 0; layer < layers; layer++) decoded = JSON.parse(decoded);
      assert.equal(typeof decoded, "object");
      assert.match(JSON.stringify(decoded), /REDACTED_NESTING_LIMIT/u);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-encoded-depth-secret/u);
    }
  });
}
