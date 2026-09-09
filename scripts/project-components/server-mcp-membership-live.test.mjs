import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guardMembershipTool, redactMembershipEvidence } from "./server-mcp-membership-live.mjs";

const scope = {
  runId: "fixture-run",
  projects: ["fixture-a", "fixture-b"],
  names: ["single", "shared"],
  keyPrefix: "MIFIXTURE",
  sharedId: "fixture-user",
};

test("guard allows only planned fixture membership changes", () => {
  guardMembershipTool(
    "qa_set_membership",
    {
      projectId: "fixture-a",
      userId: "fixture-user",
      request: { active: false, expectedVersion: 1 },
    },
    scope,
  );
  for (const replacement of [
    { projectId: "fixture-b" },
    { userId: "existing-user" },
    { projectId: "production" },
  ])
    assert.throws(() =>
      guardMembershipTool(
        "qa_set_membership",
        {
          projectId: "fixture-a",
          userId: "fixture-user",
          request: { active: false, expectedVersion: 1 },
          ...replacement,
        },
        scope,
      ),
    );
});

test("guard rejects business writes and mixed payloads", () => {
  assert.throws(() => guardMembershipTool("qa_create_bug", { projectId: "fixture-a" }, scope));
  assert.throws(() => guardMembershipTool("qa_set_component", { projectId: "fixture-a" }, scope));
  assert.throws(() =>
    guardMembershipTool(
      "qa_login",
      { projectId: "fixture-a", name: "shared", actorId: "injected" },
      scope,
    ),
  );
  assert.throws(() =>
    guardMembershipTool(
      "qa_set_membership",
      {
        projectId: "fixture-a",
        userId: "fixture-user",
        request: { active: false, expectedVersion: 1, roles: ["gm"] },
      },
      scope,
    ),
  );
});

test("scope guard confines project creation, logins and reads", () => {
  guardMembershipTool(
    "qa_create_project",
    { request: { id: "fixture-a", key: "MIFIXTUREA", name: "fixture-run A" } },
    scope,
  );
  guardMembershipTool("qa_login", { projectId: "fixture-b", name: "shared" }, scope);
  guardMembershipTool("qa_list_users", { projectId: "fixture-a" }, scope);
  assert.throws(() =>
    guardMembershipTool(
      "qa_create_project",
      { request: { id: "old-a", key: "MIFIXTUREA", name: "fixture-run A" } },
      scope,
    ),
  );
  assert.throws(() =>
    guardMembershipTool("qa_login", { projectId: "fixture-a", name: "old employee" }, scope),
  );
  assert.throws(() => guardMembershipTool("qa_list_users", { projectId: "old-a" }, scope));
});

test("redaction handles mirrored MCP JSON without changing primitive versions", () => {
  const secret = "synthetic-only-secret";
  const result = redactMembershipEvidence(
    {
      jsonrpc: "2.0",
      content: [
        {
          text: JSON.stringify({
            accessToken: secret,
            nested: JSON.stringify({ password: secret, ordinary: secret }),
          }),
        },
      ],
      ordinary: secret,
    },
    new Set([secret]),
  );
  assert.equal(result.jsonrpc, "2.0");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(JSON.parse(result.content[0].text).accessToken, undefined);
});

test("default CLI remains inert with a nonexistent config", () => {
  const source = fileURLToPath(new URL("./server-mcp-membership-live.mjs", import.meta.url));
  const result = JSON.parse(
    execFileSync(process.execPath, [source, "does-not-exist.json"], { encoding: "utf8" }),
  );
  assert.equal(result.status, "not_run");
});
