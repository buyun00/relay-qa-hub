import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TOAST_UIA_PS,
  classifyBugDetailRequest,
  durableToastBody,
  notificationProjectKey,
  parseArguments,
  redactEvidence,
} from "./desktop-notification-project-route-live.mjs";

const INSTANCE = "C:\\isolated\\qa-hub-preview-test\\instance.json";
const EXE = "C:\\isolated\\RelayQaHubPreview-test\\RelayQaHubPreview-test.exe";
const runnerSource = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "desktop-notification-project-route-live.mjs",
  ),
  "utf8",
);

test("CLI is inert without --run and requires both explicit absolute inputs", () => {
  assert.deepEqual(parseArguments([]), { usageOnly: true, execute: false });
  assert.deepEqual(parseArguments(["--instance", INSTANCE, "--exe", EXE]), {
    usageOnly: false,
    execute: false,
    instancePath: INSTANCE,
    executablePath: EXE,
  });
  assert.equal(parseArguments(["--run", "--exe", EXE, "--instance", INSTANCE]).execute, true);
  assert.throws(() => parseArguments(["--run", "--instance", INSTANCE]), /EXPLICIT_EXE_REQUIRED/u);
  assert.throws(
    () => parseArguments(["--instance", INSTANCE, "--exe", EXE, "--force"]),
    /UNKNOWN_ARGUMENT/u,
  );
  assert.throws(
    () => parseArguments(["--instance", "instance.json", "--exe", EXE]),
    /INSTANCE_MUST_BE_ABSOLUTE/u,
  );
});

test("toast body follows the frozen v1.1 Inbox shape and accepts a future explicit body", () => {
  assert.equal(durableToastBody({ type: "occurrence.appended" }), "occurrence.appended");
  assert.equal(
    durableToastBody({ type: "occurrence.appended", body: "QA-12 · Login failure" }),
    "QA-12 · Login failure",
  );
  assert.throws(() => durableToastBody({ type: "" }), /INVALID_TOAST_BODY/u);
});

test("detail classifier requires an exact GET path and preserves the project header", () => {
  const bugId = "10000000-0000-4000-8000-000000000001";
  const projectId = "20000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    classifyBugDetailRequest(
      {
        requestId: "9.2",
        method: "GET",
        url: `qa-hub-preview-test://app/api/v1/bugs/${bugId}`,
        headers: { "X-QA-Project-ID": projectId },
      },
      bugId,
    ),
    { projectId, requestId: "9.2" },
  );
  assert.equal(
    classifyBugDetailRequest(
      { method: "GET", url: `qa-hub-preview-test://app/api/v1/bugs/${bugId}?extra=1` },
      bugId,
    ),
    null,
  );
  assert.equal(
    classifyBugDetailRequest(
      { method: "GET", url: `qa-hub-preview-test://app/api/v1/bugs/${bugId}/comments` },
      bugId,
    ),
    null,
  );
});

test("notification fixture project keys satisfy the API uppercase key contract", () => {
  assert.equal(notificationProjectKey("ea8556055d1044f79a4bbb4b59b10176", "A"), "NEA8556055DA");
  assert.match(
    notificationProjectKey("0123456789abcdef0123456789abcdef", "B"),
    /^[A-Z][A-Z0-9]{1,15}$/u,
  );
  assert.throws(() => notificationProjectKey("too-short", "A"), /RUN_ID_INVALID/u);
  assert.throws(
    () => notificationProjectKey("0123456789abcdef0123456789abcdef", "C"),
    /PROJECT_SUFFIX_INVALID/u,
  );
});

test("evidence redaction removes auth material from keys and free text", () => {
  const secret = "gm-secret-value";
  const value = redactEvidence(
    {
      authorization: `Bearer ${secret}`,
      nested: { accessToken: "token-value", safe: `prefix ${secret} suffix` },
      line: "Bearer abc.def_123",
    },
    new Set([secret]),
  );
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("token-value"), false);
  assert.match(serialized, /REDACTED/u);
});

test("toast helper performs exact title/body lookup and only invokes through InvokePattern", () => {
  assert.match(TOAST_UIA_PS, /Get-Content[^\n]+-Encoding utf8/u);
  assert.match(TOAST_UIA_PS, /AutomationElement\]::NameProperty/u);
  assert.match(TOAST_UIA_PS, /\$inputData\.title/u);
  assert.match(TOAST_UIA_PS, /\$inputData\.body/u);
  assert.match(TOAST_UIA_PS, /InvokePattern\]::Pattern/u);
  assert.match(TOAST_UIA_PS, /AMBIGUOUS_EXACT_TOAST/u);
  assert.doesNotMatch(TOAST_UIA_PS, /SendKeys|mouse_event|SetCursorPos/iu);
});

test("toast watcher handles early PowerShell rejection before delayed invocation", () => {
  assert.match(runnerSource, /let watcherOutcome = null/u);
  assert.match(runnerSource, /watcherOutcome = \{ error \}/u);
  assert.match(runnerSource, /if \(watcherOutcome\?\.error\) throw watcherOutcome\.error/u);
});

test("second A notification is observed in A and only then clicked from B", () => {
  const draftVerified = runnerSource.indexOf('"B_DRAFT_ROUNDTRIP"');
  const enterA = runnerSource.indexOf("await switchProject(renderer, projectA.id);", draftVerified);
  const createA2 = runnerSource.indexOf("const description2", enterA);
  const shownA2 = runnerSource.indexOf('"A2_SHOWN"', createA2);
  const enterB = runnerSource.indexOf("await switchProject(renderer, projectB.id);", shownA2);
  const revokeA = runnerSource.indexOf('"GM revokes target A membership"', enterB);
  const invokeA2 = runnerSource.indexOf("await watcher2.invoke();", revokeA);
  assert.ok(
    [draftVerified, enterA, createA2, shownA2, enterB, revokeA, invokeA2].every(
      (offset, index, offsets) => offset >= 0 && (index === 0 || offset > offsets[index - 1]),
    ),
  );
});

test("runner has no force-kill path and graceful quit is bound to the copied EXE inspector", () => {
  assert.doesNotMatch(runnerSource, /taskkill|Stop-Process|TerminateProcess|\.kill\s*\(/iu);
  assert.match(runnerSource, /check\(`\$\{phase\} exact copied EXE`/u);
  assert.match(runnerSource, /app\.quit\(\)/u);
  assert.match(runnerSource, /NO_GRACEFUL_CHANNEL/u);
});
