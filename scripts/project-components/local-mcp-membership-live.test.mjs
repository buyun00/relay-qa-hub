import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectedFuse,
  makeCopyConfig,
  guardLocalCall,
  guardAuxiliary,
} from "./local-mcp-membership-live.mjs";

const projectA = "ad349afc-cd32-4c2a-84cc-2e36e5c23b9b",
  projectB = "bc938119-c43a-4c0d-aa3b-4a46f8d40935",
  shared = "d223fc6b-5979-4c62-9504-f4a37aa762c1";
const scope = {
  projects: [projectA, projectB],
  names: ["SyntheticSingle", "SyntheticShared"],
  sharedId: shared,
  runId: "synthetic",
  keyPrefix: "SYN",
};
test("inspector fuse requires exactly enabled V1 CLI inspect", () => {
  const base = Buffer.concat([
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
    Buffer.from([1, 9]),
    Buffer.from("101100011"),
  ]);
  assert.equal(inspectedFuse(base).nodeCliInspectEnabled, true);
  const disabled = Buffer.from(base);
  disabled[disabled.length - 6] = 0x30;
  assert.throws(() => inspectedFuse(disabled), /NODE_CLI_INSPECT_DISABLED/);
  assert.throws(() => inspectedFuse(Buffer.concat([base, base])), /EXACT_ONE_FUSE_WIRE/);
});
test("copy config retains API cookie identity but isolates profile port and feed", () => {
  const original = {
    instanceId: "qa-hub-preview-7c86",
    cookieName: "qa-hub-preview-7c86-session",
    apiBaseUrl: "http://127.0.0.1:4419",
    csrfOrigin: "http://127.0.0.1:4274",
    profileDirectory: "C:/original-profile",
    mcpPort: 4420,
    updateManifestUrl: "http://127.0.0.1:4419/downloads/formal.json",
  };
  const before = structuredClone(original);
  const value = makeCopyConfig(
    original,
    "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/acceptance/local-mcp-membership-copy-synthetic",
    "membership",
  );
  assert.deepEqual(original, before);
  assert.equal(value.mcpPort, 4470);
  assert.notEqual(value.profileDirectory, original.profileDirectory);
  assert.match(value.updateManifestUrl, /not-published\.json$/u);
  assert.equal(new URL(value.updateManifestUrl).origin, "http://127.0.0.1:4274");
  assert.equal(value.cookieName, original.cookieName);
});
test("copy config refuses outside experiment or invented API cookie", () => {
  const original = {
    instanceId: "qa-hub-preview-7c86",
    cookieName: "qa-hub-preview-7c86-session",
    apiBaseUrl: "http://127.0.0.1:4419",
    csrfOrigin: "http://127.0.0.1:4274",
    profileDirectory: "C:/original-profile",
  };
  assert.throws(() => makeCopyConfig(original, "C:/outside", "membership"));
  assert.throws(() =>
    makeCopyConfig({ ...original, cookieName: "other-session" }, "C:/outside", "membership"),
  );
});
test("local login/read are exact new scopes and have no per-request credential override", () => {
  guardLocalCall("qa_login", { projectId: projectA, name: "SyntheticShared" }, scope);
  guardLocalCall("qa_list_users", { projectId: projectB }, scope);
  assert.throws(() =>
    guardLocalCall("qa_login", { projectId: projectA, name: "OriginalEmployee" }, scope),
  );
  assert.throws(() =>
    guardLocalCall("qa_list_users", { projectId: projectA, accessToken: "synthetic-only" }, scope),
  );
  assert.throws(
    () =>
      guardLocalCall(
        "qa_set_membership",
        { projectId: projectA, userId: shared, request: { active: false, expectedVersion: 1 } },
        scope,
      ),
    /REVOKE_ONLY/,
  );
});
test("GM auxiliary permits only exact A shared version1 disable and version2 restore", () => {
  const route = `/api/v1/projects/${projectA}/members/${shared}`;
  guardAuxiliary("PATCH", route, { active: false, expectedVersion: 1 }, scope);
  guardAuxiliary("PATCH", route, { active: true, expectedVersion: 2 }, scope);
  assert.throws(() => guardAuxiliary("PATCH", route, { active: false, expectedVersion: 2 }, scope));
  assert.throws(() =>
    guardAuxiliary(
      "PATCH",
      route.replace(projectA, projectB),
      { active: false, expectedVersion: 1 },
      scope,
    ),
  );
  assert.throws(() => guardAuxiliary("POST", "/api/v1/bugs", {}, scope));
});
