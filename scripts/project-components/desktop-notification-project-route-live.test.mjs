import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TOAST_UIA_PS,
  classifyBugDetailRequest,
  durableToastBody,
  liveRequestAccept,
  notificationProjectKey,
  parseArguments,
  redactEvidence,
  relayProcessFingerprint,
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

test("live notification reads request the base representation with the durable body", () => {
  assert.equal(
    liveRequestAccept("/api/v1/notifications?projectId=10000000-0000-4000-8000-000000000001"),
    "application/json",
  );
  assert.equal(liveRequestAccept("/api/v1/bugs"), "application/vnd.relay-qa-hub.v1.1+json");
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

test("Relay process fingerprint includes canonical and pre-existing processes", () => {
  const snapshot = {
    processes: [
      {
        pid: 22,
        parentPid: 2,
        name: "RelayQaHubPreview-test.exe",
        path: "C:\\isolated\\RelayQaHubPreview-test\\RelayQaHubPreview-test.exe",
        startedAt: "2026-09-10T00:00:00.000Z",
        commandLineSha256: "b".repeat(64),
      },
      {
        pid: 11,
        parentPid: 1,
        name: "RelayQaHub.exe",
        path: "D:\\Relay-QA-Hub\\RelayQaHub.exe",
        startedAt: "2026-09-09T00:00:00.000Z",
        commandLineSha256: "a".repeat(64),
      },
    ],
  };
  assert.deepEqual(
    relayProcessFingerprint(snapshot).map((item) => item.pid),
    [11, 22],
  );
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

test("runner directly launches the canonical EXE with isolated config and verified cleanup", () => {
  assert.doesNotMatch(runnerSource, /taskkill|Stop-Process|TerminateProcess|\.kill\s*\(/iu);
  assert.doesNotMatch(runnerSource, /copyTreeExclusive|installed-copy|copiedExe/u);
  assert.match(runnerSource, /child = spawn\(\s*scope\.executablePath/u);
  assert.match(runnerSource, /cwd: scope\.installedRoot/u);
  assert.match(runnerSource, /env\.QA_HUB_PREVIEW_DESKTOP_CONFIG = config\.file/u);
  assert.match(runnerSource, /\$\{phase\} exact installed canonical EXE/u);
  assert.match(runnerSource, /\$\{phase\} exact isolated profile/u);
  assert.match(runnerSource, /canonical inputs unchanged before launch/u);
  assert.match(runnerSource, /CLEANUP_PID_MISMATCH/u);
  assert.match(runnerSource, /FINAL_CLEANUP_NO_VERIFIED_GRACEFUL_CHANNEL/u);
  assert.match(runnerSource, /proof\.cleanupError[\s\S]+proof\.passed = false/u);
  assert.match(runnerSource, /relayProcessFingerprint\(hostAfter\)/u);
  const quitRequest = runnerSource.indexOf("OWN_APP_QUIT_SCHEDULED");
  const inspectorDetach = runnerSource.indexOf("stoppingInspector.close()", quitRequest);
  const exitWait = runnerSource.indexOf("stoppingChild.exitCode === null", inspectorDetach);
  assert.ok(quitRequest >= 0 && inspectorDetach > quitRequest && exitWait > inspectorDetach);
  assert.match(runnerSource, /app\.quit\(\)/u);
  assert.match(runnerSource, /NO_GRACEFUL_CHANNEL/u);
});
