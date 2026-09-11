import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const productSourceCommit = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const userLabel = "用户自测／已移交，代理未执行";
const notificationTitle = "QA Hub · 这个单子已创建";
const inaccessibleNotificationText =
  "通知所属项目当前不可访问，已保持当前项目并刷新项目列表。";
const build20ExeSha256 = "47e3d83120f29a6b2e0dc1fa54a2de6327c15c21620999b421b615a346e1fbac";
const build20AsarSha256 = "beecc244ab14d52a4b05e3475926285fb8fed2769c17d18f5e34e970644bbf96";
const build20ExePath =
  "C:\\Users\\lin0\\AppData\\Local\\Programs\\RelayQaHubPreview-v21-e2e-fresh-0910\\RelayQaHubPreview-v21-e2e-fresh-0910.exe";
const build20AsarPath =
  "C:\\Users\\lin0\\AppData\\Local\\Programs\\RelayQaHubPreview-v21-e2e-fresh-0910\\resources\\app.asar";
const canonicalInstancePath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\instance.json";
const canonicalSecretsPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\secrets.json";
const canonicalPreviewConfigPath =
  "C:\\Users\\lin0\\AppData\\Local\\Programs\\RelayQaHubPreview-v21-e2e-fresh-0910\\preview-instance.json";
const canonicalPublicKeyPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\desktop-signing\\public.pem";
const build20ManifestPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\downloads\\qa-hub-preview-v21-e2e-fresh-0910-windows-latest.json";
const build20InstallerPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\downloads\\qa-hub-preview-v21-e2e-fresh-0910-windows-0.2.0-preview.20-20260911T000006100Z.exe";
const windowsPowerShellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const moveFileWriteThroughPath =
  "C:\\Users\\lin0\\.codex\\worktrees\\7c86\\Relay-QA-Hub\\scripts\\project-components\\move-file-write-through.ps1";
const canonicalInstanceSha256 = "cf92bad26060bbcddcfc37d620320e8bac15e09104088944e456a3b9205257db";
const canonicalSecretsSha256 = "fcf0173d2eaac6c6a7d6fa56a990870796a80fac34bee3de696a7fdd094c4468";
const canonicalSecretNames = ["debugToken", "gmPassword", "sessionSecret"];
const expectedInputFingerprints = [
  { path: canonicalInstancePath, bytes: 1327, sha256: canonicalInstanceSha256 },
  { path: build20ExePath, bytes: 235871744, sha256: build20ExeSha256 },
  { path: build20AsarPath, bytes: 1304284, sha256: build20AsarSha256 },
  {
    path: canonicalPreviewConfigPath,
    bytes: 742,
    sha256: "dbde6a7d32476ed526bce22af042fd5eab0e7abf1cd4b871513688edc534a71c",
  },
  {
    path: canonicalPublicKeyPath,
    bytes: 113,
    sha256: "65960279443905ce011ba50de37588a5815d0a80067c6dd336caeea1f76e4119",
  },
  { path: canonicalSecretsPath, bytes: 242, sha256: canonicalSecretsSha256 },
  {
    path: build20ManifestPath,
    bytes: 480,
    sha256: "41083ceeaa88c7cbd115e258bc8d2cb2f3cc7e2f2105687bfd1246de842d0204",
  },
  {
    path: build20InstallerPath,
    bytes: 107992506,
    sha256: "e0e68a626657f4431447764d96f0cf95ded8b6b081c8b13f809ccacd252e7e41",
  },
  {
    path: windowsPowerShellPath,
    bytes: 454656,
    sha256: "7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5",
  },
  {
    path: moveFileWriteThroughPath,
    bytes: 5616,
    sha256: "f52003ee89347e47775bc411499ee0ffafa5dd91a603aba4edd27048d333c0ab",
  },
];
const protectedNotificationPorts = new Set([4174, 4319, 4320, 4639, 4640, 4641, 4642, 9333]);
const delegatedIds = [
  "android-physical-device",
  "external-build-terminal",
  "external-single-build-upload-terminal",
  "external-incremental-publication-terminal",
  "external-relay-delivery-terminal",
  "external-qingyu-order-terminal",
];
const requiredAdditionalAgentGateIds = ["desktop-notification-project-route-live"];
const indexExcludedPaths = ["evidence-index.json", "final-validation.json"];
const productSourceRoots = [
  "apps/api/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/android/app/src/main",
  "apps/worker/src",
  "packages/domain/src",
];
const continuationSummaryPath = "continuation-20260911/postfix-fd0f0f8/summary.json";
const continuationValidatorPath =
  "continuation-20260911/postfix-fd0f0f8/validate-postfix-evidence.mjs";
const packageReceiptPath = "continuation-20260911/postfix-fd0f0f8/package/receipt.json";
const registrationVerificationPath =
  "continuation-20260911/postfix-fd0f0f8/upgrade/registration-readonly.json";
const notificationProofPath =
  "../desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json";
const retainedAndroidArtifactPath =
  "android/acceptance/android-code28-self-update/artifact-verification.json";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `${name} requires a value`);
  return value;
}

const dryRun = process.argv.includes("--dry-run");
const root = path.resolve(
  option("--root") ?? fileURLToPath(new URL("./", import.meta.url)),
);
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const rootRelativeFromRepo = path.relative(repoRoot, root);
assert.ok(
  rootRelativeFromRepo &&
    rootRelativeFromRepo !== ".." &&
    !rootRelativeFromRepo.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rootRelativeFromRepo),
  "evidence root must be inside the repository",
);
const rootFromRepo = rootRelativeFromRepo.split(path.sep).join("/");

function repoContainedPath(relative, label) {
  assert.equal(typeof relative, "string", `${label}: path must be a string`);
  assert.ok(relative.length > 0 && !path.isAbsolute(relative), `${label}: relative path required`);
  assert.ok(!relative.includes("\\"), `${label}: forward-slash path required`);
  const absolute = path.resolve(root, ...relative.split("/"));
  const fromRepo = path.relative(repoRoot, absolute);
  assert.ok(
    fromRepo &&
      fromRepo !== ".." &&
      !fromRepo.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(fromRepo),
    `${label}: path escaped the repository`,
  );
  return absolute;
}

async function repoRegularFile(relative, label) {
  const absolute = repoContainedPath(relative, label);
  const fromRepo = path.relative(repoRoot, absolute);
  let cursor = repoRoot;
  let stat;
  for (const part of fromRepo.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    stat = await lstat(cursor);
    assert.equal(stat.isSymbolicLink(), false, `${label}: path contains a symbolic link`);
  }
  assert.equal(stat?.isFile(), true, `${label}: evidence must be a regular file`);
  return absolute;
}

async function json(relative, label = relative) {
  const absolute = await repoRegularFile(relative, label);
  return JSON.parse((await readFile(absolute, "utf8")).replace(/^\uFEFF/u, ""));
}

async function assertEvidenceFile(owner, relative) {
  await repoRegularFile(relative, owner);
}

async function regularJson(relative, label) {
  await assertEvidenceFile(label, relative);
  return json(relative);
}

async function validatePassingDesktopNotificationEvidence(evidence) {
  const proofPattern =
    /^\.\.\/desktop-notification-project-route-live\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/proof\.json$/u;
  const candidates = [];
  for (const relative of evidence) {
    const match = proofPattern.exec(relative);
    if (!match) continue;
    const proof = await regularJson(relative, "desktop notification proof");
    if (proof.passed === true) candidates.push({ relative, runId: match[1], proof });
  }
  assert.equal(
    candidates.length,
    1,
    "a passing desktop notification gate needs exactly one semantic PASS runner proof",
  );
  const { relative, runId, proof } = candidates[0];
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.runId, runId);
  assert.equal(proof.instanceId, "qa-hub-preview-v21-e2e-fresh-0910");
  assert.equal(proof.error, undefined);
  assert.equal(proof.cleanupError, undefined);
  assert.equal(proof.finalizationError, undefined);
  assert.equal(proof.guarantees.installedCanonicalRunsDirectly, true);
  assert.equal(proof.guarantees.isolatedProfileAndPreviewConfig, true);
  assert.equal(proof.guarantees.foreignProcessesAreNeverSignaled, true);
  assert.equal(proof.guarantees.noForceKillFallback, true);
  assert.deepEqual(
    [...proof.guarantees.productionPortsRejected].sort((a, b) => a - b),
    [4174, 4319, 4320],
  );
  assert.deepEqual(
    proof.inputFingerprints,
    expectedInputFingerprints,
    "runner proof must fingerprint the complete canonical build 20 input set",
  );
  assert.ok(Array.isArray(proof.checks) && proof.checks.length > 0);
  assert.ok(proof.checks.every((check) => check.passed === true));
  for (const check of proof.checks) {
    assert.equal(Object.hasOwn(check, "actual"), true, `${check.label}: missing actual`);
    assert.equal(Object.hasOwn(check, "expected"), true, `${check.label}: missing expected`);
    assert.notEqual(check.expected, "predicate", `${check.label}: predicate checks are not accepted`);
    assert.match(check.at, /^\d{4}-\d{2}-\d{2}T/u, `${check.label}: invalid timestamp`);
    assert.deepEqual(check.actual, check.expected, `${check.label}: actual/expected mismatch`);
  }
  const checks = new Map(proof.checks.map((check) => [check.label, check]));
  assert.equal(checks.size, proof.checks.length, "runner proof check labels must be unique");
  assert.deepEqual(Object.keys(proof.ports).sort(), ["cdp", "inspector", "mcp"]);
  const ownPorts = Object.values(proof.ports);
  assert.equal(ownPorts.length, 3, "runner proof must allocate three isolated ports");
  assert.equal(new Set(ownPorts).size, ownPorts.length, "runner proof ports must be unique");
  assert.ok(ownPorts.every((port) => Number.isInteger(port) && port > 0 && port < 65_536));
  assert.ok(
    ownPorts.every((port) => !protectedNotificationPorts.has(port)),
    "runner proof ports overlap protected listeners",
  );
  const requiredChecks = [
    "canonical inputs unchanged before preparation",
    "interactive desktop session",
    "input preview has no running process",
    "same instance has no running process",
    "read-only readiness before any business write status",
    "isolated API ready",
    "quit-probe canonical inputs unchanged before launch",
    "quit-probe exact PID",
    "quit-probe exact installed canonical EXE",
    "quit-probe exact isolated profile",
    "quit-probe graceful quit acknowledged",
    "quit-probe exact child exited",
    "quit-probe exit code",
    "all Relay QA Hub processes unchanged by quit probe",
    "installed canonical EXE absent after quit probe",
    "canonical inputs unchanged after quit probe",
    "route-1 canonical inputs unchanged before launch",
    "route-1 exact PID",
    "route-1 exact installed canonical EXE",
    "route-1 exact isolated profile",
    "a1 exact toast title",
    "a1 exact toast body",
    "a1 toast title visible",
    "a1 toast body visible",
    "a1 UIAutomation Invoke",
    "A1 exact detail requested",
    "A1 first detail carries project A",
    "B draft roundtrip exact",
    "a2 exact toast title",
    "a2 exact toast body",
    "a2 toast title visible",
    "a2 toast body visible",
    "a2 UIAutomation Invoke",
    "revoked route stays B",
    "revoked route exact visible alert",
    "revoked route sends no A2 detail request",
    "b3 exact native toast visible",
    "B3 history exactly once before restart",
    "B3 not shown again after restart",
    "B3 history remains exactly once",
    "notification history stable across restart",
    "controlled-restart-stop graceful quit acknowledged",
    "controlled-restart-stop exact child exited",
    "controlled-restart-stop exit code",
    "route-2-restart canonical inputs unchanged before launch",
    "route-2-restart exact PID",
    "route-2-restart exact installed canonical EXE",
    "route-2-restart exact isolated profile",
    "final-cleanup graceful quit acknowledged",
    "final-cleanup exact child exited",
    "final-cleanup exit code",
    "all pre-existing QA Hub processes unchanged",
    "configured and production listeners unchanged",
    "installed canonical EXE absent after final cleanup",
    "instance and installed preview inputs unchanged",
  ];
  for (const port of ownPorts) {
    requiredChecks.push(
      `new port ${port} vacant`,
      `probe port ${port} released`,
      `final own port ${port} released`,
    );
  }
  for (const label of requiredChecks) {
    assert.equal(checks.get(label)?.passed, true, `runner proof missing mandatory check: ${label}`);
  }
  const proofRoot = path.posix.dirname(relative);
  const rawNames = [
    "a1-toast-observed.json",
    "a1-toast-invoked.json",
    "a1-routed-renderer.json",
    "a2-toast-observed.json",
    "a2-toast-invoked.json",
    "a2-denied-renderer.json",
    "b3-toast-observed.json",
    "host-before.json",
    "host-after-quit-probe.json",
    "host-after.json",
  ];
  const raw = Object.fromEntries(
    await Promise.all(
      rawNames.map(async (name) => [
        name,
        await regularJson(`${proofRoot}/raw/${name}`, `desktop notification raw ${name}`),
      ]),
    ),
  );
  const compactRunId = runId.replaceAll("-", "");
  const expectedBodies = {
    "a1-toast-observed.json": `${proof.fixtures.bugs.a1.key} · ${proof.fixtures.bugs.a1.title}`,
    "a2-toast-observed.json": `${proof.fixtures.bugs.a2.key} · ${proof.fixtures.bugs.a2.title}`,
    "b3-toast-observed.json": `${proof.fixtures.bugs.b3.key} · ${proof.fixtures.bugs.b3.title}`,
  };
  assert.match(proof.fixtures.bugs.a1.title, new RegExp(`^通知路由A1-${compactRunId}$`, "u"));
  assert.match(proof.fixtures.bugs.a2.title, new RegExp(`^通知撤权A2-${compactRunId}$`, "u"));
  assert.match(proof.fixtures.bugs.b3.title, new RegExp(`^通知重启B3-${compactRunId}$`, "u"));
  for (const name of Object.keys(expectedBodies)) {
    assert.equal(raw[name].title, notificationTitle, `${name}: exact title required`);
    assert.equal(raw[name].body, expectedBodies[name], `${name}: exact body required`);
    assert.equal(raw[name].titleOffscreen, false, `${name}: title must be visible`);
    assert.equal(raw[name].bodyOffscreen, false, `${name}: body must be visible`);
  }
  for (const label of ["a1", "a2"]) {
    assert.equal(raw[`${label}-toast-invoked.json`].title, notificationTitle);
    assert.equal(
      raw[`${label}-toast-invoked.json`].body,
      expectedBodies[`${label}-toast-observed.json`],
    );
    assert.equal(raw[`${label}-toast-invoked.json`].invoked, true);
  }
  assert.notEqual(proof.fixtures.projectA.id, proof.fixtures.projectB.id);
  assert.equal(raw["a1-routed-renderer.json"].projectId, proof.fixtures.projectA.id);
  assert.equal(raw["a1-routed-renderer.json"].detailOpen, true);
  assert.equal(raw["a1-routed-renderer.json"].detailKey, proof.fixtures.bugs.a1.key);
  assert.equal(raw["a2-denied-renderer.json"].projectId, proof.fixtures.projectB.id);
  assert.equal(raw["a2-denied-renderer.json"].inaccessibleExact, true);
  assert.equal(raw["a2-denied-renderer.json"].alert, inaccessibleNotificationText);
  assert.equal(
    raw["a2-denied-renderer.json"].projects.some(
      (project) => project.id === proof.fixtures.projectA.id,
    ),
    false,
  );
  const processFingerprint = (snapshot) =>
    snapshot.processes
      .map(({ pid, parentPid, name, path: executable, startedAt, commandLineSha256 }) => ({
        pid,
        parentPid,
        name,
        path: executable,
        startedAt,
        commandLineSha256,
      }))
      .sort((a, b) => a.pid - b.pid);
  const listenerFingerprint = (snapshot) =>
    snapshot.listeners
      .filter((item) => !new Set(ownPorts).has(item.port))
      .map(({ port, listening, address = null, pid = null }) => ({
        port,
        listening,
        address,
        pid,
      }))
      .sort((a, b) => a.port - b.port || Number(a.pid ?? 0) - Number(b.pid ?? 0));
  const hostBefore = raw["host-before.json"];
  assert.ok(hostBefore.sessionId > 0, "notification proof requires an interactive session");
  assert.equal(
    hostBefore.processes.some(
      (item) =>
        path.win32.normalize(item.path ?? "").toLowerCase() ===
        path.win32.normalize(build20ExePath).toLowerCase(),
    ),
    false,
    "host-before.json: canonical EXE was already running",
  );
  assert.equal(
    hostBefore.processes.some((item) =>
      String(item.path ?? "")
        .toLowerCase()
        .includes("v21-e2e-fresh-0910"),
    ),
    false,
    "host-before.json: same isolated instance was already running",
  );
  for (const port of ownPorts) {
    const entries = hostBefore.listeners.filter((item) => item.port === port);
    assert.equal(entries.length, 1, `host-before.json: missing isolated port ${port}`);
    assert.equal(entries[0].listening, false, `host-before.json: isolated port ${port} was occupied`);
  }
  for (const name of ["host-after-quit-probe.json", "host-after.json"]) {
    const snapshot = raw[name];
    assert.equal(snapshot.sessionId, hostBefore.sessionId, `${name}: session changed`);
    assert.deepEqual(processFingerprint(snapshot), processFingerprint(hostBefore));
    assert.deepEqual(listenerFingerprint(snapshot), listenerFingerprint(hostBefore));
    assert.equal(
      snapshot.processes.some(
        (item) =>
          path.win32.normalize(item.path ?? "").toLowerCase() ===
          path.win32.normalize(build20ExePath).toLowerCase(),
      ),
      false,
      `${name}: canonical EXE remained running`,
    );
    for (const port of ownPorts) {
      const entries = snapshot.listeners.filter((item) => item.port === port);
      assert.equal(entries.length, 1, `${name}: missing isolated port ${port}`);
      assert.equal(entries[0].listening, false, `${name}: isolated port ${port} remained open`);
    }
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  assert.match(proof.fixtures.projectA.id, uuidPattern);
  assert.match(proof.fixtures.projectB.id, uuidPattern);
  const notificationIds = [
    proof.fixtures.notifications.a1,
    proof.fixtures.notifications.a2,
    proof.fixtures.notifications.b3,
  ];
  assert.ok(notificationIds.every((id) => uuidPattern.test(id)));
  assert.equal(new Set(notificationIds).size, 3);
  const profileRoot = path.win32.join(
    path.win32.dirname(canonicalInstancePath),
    "acceptance",
    "desktop-notification-project-route-live",
    runId,
    "profiles",
    proof.instanceId,
  );
  const processPhase = (phase) => {
    const matches = proof.processes.filter((item) => item.phase === phase);
    assert.equal(matches.length, 1, `runner proof requires one ${phase} process record`);
    assert.match(matches[0].at, /^\d{4}-\d{2}-\d{2}T/u);
    return matches[0];
  };
  const launchPhase = (phase, profileName) => {
    const record = processPhase(`${phase}_launch`);
    assert.ok(Number.isInteger(record.pid) && record.pid > 0);
    assert.equal(
      path.win32.normalize(record.executable).toLowerCase(),
      path.win32.normalize(build20ExePath).toLowerCase(),
    );
    assert.equal(
      path.win32.normalize(record.profile).toLowerCase(),
      path.win32.normalize(path.win32.join(profileRoot, profileName)).toLowerCase(),
    );
    return record;
  };
  const quitPhase = (phase, expectedPid) => {
    const record = processPhase(`${phase}_quit`);
    assert.equal(record.pid, expectedPid);
    assert.equal(record.exitCode, 0);
    return record;
  };
  const quitProbeLaunch = launchPhase("quit-probe", "quit-probe");
  quitPhase("quit-probe", quitProbeLaunch.pid);
  const route1Launch = launchPhase("route-1", "route");
  quitPhase("controlled-restart-stop", route1Launch.pid);
  const route2Launch = launchPhase("route-2-restart", "route");
  quitPhase("final-cleanup", route2Launch.pid);
  const expectedHistory = {
    schemaVersion: 1,
    notificationIds: notificationIds.map((id) => id.toLowerCase()),
  };
  const requiredExpected = new Map([
    ["canonical inputs unchanged before preparation", expectedInputFingerprints],
    ["interactive desktop session", true],
    ["input preview has no running process", 0],
    ["same instance has no running process", 0],
    ["read-only readiness before any business write status", 200],
    ["isolated API ready", "ready"],
    ["quit-probe canonical inputs unchanged before launch", expectedInputFingerprints],
    ["quit-probe exact PID", quitProbeLaunch.pid],
    ["quit-probe exact installed canonical EXE", build20ExePath],
    ["quit-probe exact isolated profile", path.win32.join(profileRoot, "quit-probe")],
    ["quit-probe graceful quit acknowledged", "OWN_APP_QUIT_SCHEDULED"],
    ["quit-probe exact child exited", true],
    ["quit-probe exit code", 0],
    ["all Relay QA Hub processes unchanged by quit probe", processFingerprint(hostBefore)],
    ["installed canonical EXE absent after quit probe", 0],
    ["canonical inputs unchanged after quit probe", expectedInputFingerprints],
    ["route-1 canonical inputs unchanged before launch", expectedInputFingerprints],
    ["route-1 exact PID", route1Launch.pid],
    ["route-1 exact installed canonical EXE", build20ExePath],
    ["route-1 exact isolated profile", path.win32.join(profileRoot, "route")],
    ["a1 exact toast title", notificationTitle],
    ["a1 exact toast body", expectedBodies["a1-toast-observed.json"]],
    ["a1 toast title visible", false],
    ["a1 toast body visible", false],
    ["a1 UIAutomation Invoke", true],
    ["A1 exact detail requested", true],
    ["A1 first detail carries project A", proof.fixtures.projectA.id],
    ["B draft roundtrip exact", `B项目唯一未提交草稿-${compactRunId}`],
    ["a2 exact toast title", notificationTitle],
    ["a2 exact toast body", expectedBodies["a2-toast-observed.json"]],
    ["a2 toast title visible", false],
    ["a2 toast body visible", false],
    ["a2 UIAutomation Invoke", true],
    ["revoked route stays B", proof.fixtures.projectB.id],
    ["revoked route exact visible alert", inaccessibleNotificationText],
    ["revoked route sends no A2 detail request", 0],
    ["b3 exact native toast visible", true],
    ["B3 history exactly once before restart", 1],
    ["B3 not shown again after restart", 0],
    ["B3 history remains exactly once", 1],
    ["notification history stable across restart", expectedHistory],
    ["controlled-restart-stop graceful quit acknowledged", "OWN_APP_QUIT_SCHEDULED"],
    ["controlled-restart-stop exact child exited", true],
    ["controlled-restart-stop exit code", 0],
    ["route-2-restart canonical inputs unchanged before launch", expectedInputFingerprints],
    ["route-2-restart exact PID", route2Launch.pid],
    ["route-2-restart exact installed canonical EXE", build20ExePath],
    ["route-2-restart exact isolated profile", path.win32.join(profileRoot, "route")],
    ["final-cleanup graceful quit acknowledged", "OWN_APP_QUIT_SCHEDULED"],
    ["final-cleanup exact child exited", true],
    ["final-cleanup exit code", 0],
    ["all pre-existing QA Hub processes unchanged", processFingerprint(hostBefore)],
    ["configured and production listeners unchanged", listenerFingerprint(hostBefore)],
    ["installed canonical EXE absent after final cleanup", 0],
    ["instance and installed preview inputs unchanged", expectedInputFingerprints],
  ]);
  for (const port of ownPorts) {
    requiredExpected.set(`new port ${port} vacant`, 0);
    requiredExpected.set(`probe port ${port} released`, 0);
    requiredExpected.set(`final own port ${port} released`, 0);
  }
  assert.deepEqual(
    [...requiredExpected.keys()].sort(),
    [...requiredChecks].sort(),
    "every mandatory runner check must have an independent normative expectation",
  );
  for (const [label, expected] of requiredExpected) {
    const check = checks.get(label);
    assert.deepEqual(check.actual, expected, `${label}: non-normative actual`);
    assert.deepEqual(check.expected, expected, `${label}: non-normative expected`);
  }
  return relative;
}

async function validateBlockedDesktopNotificationEvidence(evidence) {
  const proofPattern =
    /^\.\.\/desktop-notification-project-route-live\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/proof\.json$/u;
  const candidates = [];
  for (const relative of evidence) {
    const match = proofPattern.exec(relative);
    if (!match) continue;
    const proof = await regularJson(relative, "blocked desktop notification proof");
    if (proof.error?.classification === "environment_blocker") {
      candidates.push({ relative, runId: match[1], proof });
    }
  }
  assert.equal(candidates.length, 1, "one environment-blocked notification proof is required");
  const { relative, runId, proof } = candidates[0];
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.runId, runId);
  assert.equal(proof.passed, false);
  assert.equal(proof.releaseProvenance.sourceCommit, productSourceCommit);
  assert.equal(proof.releaseProvenance.releaseId, "20260911T000006100Z");
  assert.equal(proof.releaseProvenance.version, "0.2.0-preview.20");
  assert.deepEqual(proof.inputFingerprints, expectedInputFingerprints);
  assert.deepEqual(proof.fixtures, {});
  assert.equal(proof.requests.length, 1);
  assert.equal(proof.requests[0].method, "GET");
  assert.equal(proof.requests[0].path, "/api/v1/health/ready");
  assert.equal(proof.requests[0].projectId, null);
  assert.equal(proof.requests[0].request, null);
  assert.equal(proof.requests[0].status, 200);
  assert.equal(proof.sessionPreflight.environmentOnly, true);
  assert.equal(proof.sessionPreflight.productPass, false);
  assert.equal(proof.sessionPreflight.status, "blocked");
  assert.equal(proof.sessionPreflight.error, "WINDOWS_TOAST_SESSION_MISMATCH");
  assert.equal(proof.error.code, "WINDOWS_TOAST_SESSION_MISMATCH");
  assert.equal(proof.error.classification, "environment_blocker");
  assert.equal(proof.checks.length, 39);
  assert.ok(proof.checks.every((check) => check.passed === true));
  assert.deepEqual(proof.ports, { mcp: 57500, cdp: 57501, inspector: 57502 });
  assert.equal(proof.watchers[0].ready.appSessionId, 2);
  assert.equal(proof.watchers[0].ready.observerSessionId, 2);
  assert.equal(proof.watchers[0].ready.activeConsoleSessionId, 1);
  assert.equal(proof.wpn[0].destinationSessionId, 1);
  assert.deepEqual(proof.sourceAttributionAfter.trackedChanges, []);
  assert.deepEqual(proof.sourceAttributionAfter.unexpectedUntracked, []);
  return relative;
}

function trackedAllowlist() {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", rootFromRepo], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const prefix = `${rootFromRepo}/`;
  const relativePaths = stdout
    .split("\0")
    .filter(Boolean)
    .map((repoRelative) => {
      assert.ok(repoRelative.startsWith(prefix), `tracked path escaped evidence root: ${repoRelative}`);
      return repoRelative.slice(prefix.length);
    })
    .filter((relative) => !indexExcludedPaths.includes(relative))
    .sort((a, b) => a.localeCompare(b, "en"));
  assert.equal(new Set(relativePaths).size, relativePaths.length, "tracked allowlist contains duplicates");
  return relativePaths;
}

const acceptance = await json("acceptance-matrix.json");
const index = await json("evidence-index.json");
const continuationSummary = await json(continuationSummaryPath);
const packageReceipt = await json(packageReceiptPath);
const registrationVerification = await json(registrationVerificationPath);
const postfixValidatorAbsolute = await repoRegularFile(
  continuationValidatorPath,
  "postfix evidence validator",
);
const postfixValidationProcess = spawnSync(process.execPath, [postfixValidatorAbsolute], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(
  postfixValidationProcess.status,
  0,
  `postfix evidence validation failed: ${postfixValidationProcess.stderr}`,
);
const postfixValidation = JSON.parse(postfixValidationProcess.stdout);
assert.equal(postfixValidation.passed, true);
assert.equal(postfixValidation.productSourceCommit, productSourceCommit);
assert.equal(postfixValidation.releaseId, "20260911T000006100Z");
assert.equal(postfixValidation.version, "0.2.0-preview.20");
assert.equal(postfixValidation.notification.productPass, false);
assert.equal(postfixValidation.notification.classification, "environment_blocker");
assert.equal(postfixValidation.authenticode.required, true);
assert.equal(postfixValidation.authenticode.status, "fail");
assert.equal(
  new Set(acceptance.cases.map((item) => item.id)).size,
  acceptance.cases.length,
  "acceptance case ids must be globally unique",
);
const indexedPaths = new Set(index.entries.map((entry) => entry.path));
const assertIndexedWhenInRoot = (owner, evidence) => {
  const absolute = repoContainedPath(evidence, owner);
  const relativeToRoot = path.relative(root, absolute).split(path.sep).join("/");
  if (!relativeToRoot.startsWith("../") && !indexExcludedPaths.includes(relativeToRoot)) {
    assert.equal(indexedPaths.has(relativeToRoot), true, `${owner}: evidence omitted from index: ${evidence}`);
  }
};

assert.equal(acceptance.productSourceCommit, productSourceCommit);
assert.equal(acceptance.overallStatus, "not_complete");
assert.equal(acceptance.completionAllowed, false);
assert.equal(acceptance.productAcceptancePassed, false);
assert.equal(acceptance.userAcceptanceStatus, "delegated_pending");
assert.equal(acceptance.sourceProvenance.productSourceAnchor, productSourceCommit);
assert.equal(acceptance.sourceProvenance.windowsTrialArtifact.sourceCommit, productSourceCommit);
assert.equal(acceptance.sourceProvenance.webInWindowsTrialArtifact.sourceCommit, productSourceCommit);
assert.equal(acceptance.sourceProvenance.windowsTrialRuntime.sourceCommit, productSourceCommit);
assert.equal(acceptance.sourceProvenance.windowsTrialRuntime.status, "upgrade_verified");
assert.equal(acceptance.sourceProvenance.retainedAndroidTrialArtifact.treeEqual, true);
assert.equal(acceptance.artifacts.windows.sourceCommit, productSourceCommit);
assert.equal(acceptance.artifacts.windows.releaseId, continuationSummary.release.releaseId);
assert.equal(acceptance.artifacts.windows.version, continuationSummary.release.version);
assert.equal(acceptance.artifacts.windows.sha256, continuationSummary.release.installer.sha256);
assert.deepEqual(acceptance.artifacts.windows.authenticode, {
  required: true,
  status: "fail",
  observed: "NotSigned",
  signer: null,
  timestamper: null,
  completionImpact: "blocks_agent_scope_completion",
  evidence: [registrationVerificationPath, continuationSummaryPath],
});
assert.equal(packageReceipt.sourceCommit, productSourceCommit);
assert.equal(packageReceipt.sourceDirty, false);
assert.equal(registrationVerification.authenticode.status, "NotSigned");
assert.equal(acceptance.userAcceptancePending.length, delegatedIds.length);
for (const id of delegatedIds) {
  const expected = {
    id,
    status: "not_run",
    owner: "user",
    handoffStatus: "delegated_pending",
    agentExecuted: false,
    completionImpact: "blocks_final_acceptance",
    resultLabel: userLabel,
  };
  const item = acceptance.cases.find((candidate) => candidate.id === id);
  assert.ok(item, `missing delegated case ${id}`);
  assert.deepEqual(
    {
      id: item.id,
      status: item.status,
      owner: item.owner,
      handoffStatus: item.handoffStatus,
      agentExecuted: item.agentExecuted,
      completionImpact: item.completionImpact,
      resultLabel: item.resultLabel,
    },
    expected,
  );
  assert.deepEqual(acceptance.userAcceptancePending.find((candidate) => candidate.id === id), expected);
}
assert.deepEqual(
  acceptance.userAcceptancePending.map((item) => item.id).sort(),
  [...delegatedIds].sort(),
  "user acceptance list must contain exactly the six delegated gates",
);
assert.deepEqual(
  acceptance.cases
    .filter((item) => item.owner === "user" || item.handoffStatus === "delegated_pending")
    .map((item) => item.id)
    .sort(),
  [...delegatedIds].sort(),
  "only the six named cases may be delegated to the user",
);

const authenticodeCase = acceptance.cases.find((item) => item.id === "windows-authenticode");
assert.ok(authenticodeCase, "missing required Windows Authenticode gate");
assert.equal(authenticodeCase.status, "fail");
assert.equal(authenticodeCase.owner, "agent");
assert.equal(authenticodeCase.completionImpact, "blocks_agent_scope_completion");
assert.match(authenticodeCase.detail, /NotSigned/u);
assert.deepEqual(authenticodeCase.evidence, [registrationVerificationPath, continuationSummaryPath]);

const serverMcp = acceptance.cases.find(
  (item) => item.id === "server-mcp-catalog-and-business-subset",
);
assert.ok(serverMcp, "missing scoped server MCP case");
assert.equal(
  acceptance.cases.some((item) => item.id === "server-mcp-96-tools-business"),
  false,
  "the legacy server MCP id overclaims all-tools business validation",
);
assert.equal(serverMcp.claimScope, "catalog_and_executed_business_subset");
assert.equal(serverMcp.catalogToolCountObserved, 96);
assert.ok(serverMcp.executedBusinessSubset.length > 0 && serverMcp.executedBusinessSubset.length < 96);
assert.match(serverMcp.detail, /catalog size does not establish per-tool business E2E/u);

assert.equal(acceptance.agentRevalidation.sourceCommit, productSourceCommit);
assert.ok(acceptance.agentRevalidation.requiredGateIds.length > 0);
assert.equal(
  new Set(acceptance.agentRevalidation.requiredGateIds).size,
  acceptance.agentRevalidation.requiredGateIds.length,
);
assert.deepEqual(
  [...acceptance.agentRevalidation.requiredGateIds].sort(),
  [...requiredAdditionalAgentGateIds].sort(),
);
assert.deepEqual(
  acceptance.agentRevalidation.gates.map((gate) => gate.id).sort(),
  [...acceptance.agentRevalidation.requiredGateIds].sort(),
  "agent revalidation must contain every required gate exactly once",
);
assert.equal(
  acceptance.agentRevalidation.reportSupplied,
  acceptance.agentRevalidation.report !== null,
);
if (acceptance.agentRevalidation.reportSupplied) {
  const reportAbsolute = repoContainedPath(
    acceptance.agentRevalidation.report,
    "agent-revalidation-report",
  );
  const reportFromRoot = path.relative(root, reportAbsolute);
  assert.ok(
    reportFromRoot &&
      reportFromRoot !== ".." &&
      !reportFromRoot.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(reportFromRoot),
    "agent revalidation report must be inside the evidence root",
  );
  await assertEvidenceFile("agent-revalidation-report", acceptance.agentRevalidation.report);
  assertIndexedWhenInRoot("agent-revalidation-report", acceptance.agentRevalidation.report);
  const report = await json(acceptance.agentRevalidation.report);
  assert.equal(report.sourceCommit, productSourceCommit);
  assert.deepEqual(
    [...report.requiredGateIds].sort(),
    [...acceptance.agentRevalidation.requiredGateIds].sort(),
  );
  assert.deepEqual(
    report.gates.map((gate) => ({ id: gate.id, status: gate.status, evidence: gate.evidence })),
    acceptance.agentRevalidation.gates.map((gate) => ({
      id: gate.id,
      status: gate.status,
      evidence: gate.evidence,
    })),
  );
  assert.equal(report.passed, report.gates.every((gate) => gate.status === "pass"));
}
for (const gate of acceptance.agentRevalidation.gates) {
  assert.ok(["pass", "fail", "not_run", "pending"].includes(gate.status));
  assert.ok(gate.evidence.length > 0, `${gate.id} needs evidence`);
  for (const evidence of gate.evidence) {
    await assertEvidenceFile(gate.id, evidence);
    assertIndexedWhenInRoot(gate.id, evidence);
  }
  if (gate.id === "desktop-notification-project-route-live" && gate.status === "pass") {
    assert.equal(
      gate.semanticProof,
      await validatePassingDesktopNotificationEvidence(gate.evidence),
    );
  } else if (gate.id === "desktop-notification-project-route-live") {
    assert.equal(gate.status, "fail");
    assert.equal(gate.classification, "environment_blocker");
    assert.equal(gate.productPass, false);
    assert.equal(
      gate.semanticProof,
      await validateBlockedDesktopNotificationEvidence(gate.evidence),
    );
  }
}
const notificationGate = acceptance.agentRevalidation.gates.find(
  (gate) => gate.id === "desktop-notification-project-route-live",
);
assert.ok(notificationGate);
assert.equal(notificationGate.status, "fail");
assert.equal(notificationGate.classification, "environment_blocker");
assert.equal(notificationGate.productPass, false);
assert.deepEqual(notificationGate.evidence, [notificationProofPath, continuationSummaryPath]);
assert.equal(notificationGate.semanticProof, notificationProofPath);
assert.equal(acceptance.agentRevalidation.reportSupplied, false);
assert.equal(acceptance.agentRevalidation.report, null);
assert.equal(acceptance.agentRevalidation.allRequiredGatesPassed, false);
const delegatedSet = new Set(delegatedIds);
const nonUserCaseFailures = acceptance.cases.filter(
  (item) =>
    !delegatedSet.has(item.id) && item.id !== "final-source-gate" && item.status !== "pass",
);
const allReportedAgentGatesPassed = acceptance.agentRevalidation.gates.every(
  (gate) => gate.status === "pass",
);
assert.equal(
  acceptance.agentRevalidation.allRequiredGatesPassed,
  allReportedAgentGatesPassed,
);
const allAgentGatesPassed =
  acceptance.agentRevalidation.reportSupplied === true &&
  allReportedAgentGatesPassed &&
  nonUserCaseFailures.length === 0;
assert.equal(
  acceptance.agentScopeStatus,
  allAgentGatesPassed
    ? "complete_user_acceptance_pending"
    : "incomplete_agent_revalidation_pending",
);
assert.equal(acceptance.sourceGate.productSourceCommit, productSourceCommit);
assert.equal(acceptance.sourceGate.allRequiredAgentGatesPassed, allAgentGatesPassed);
const finalSourceCase = acceptance.cases.find((item) => item.id === "final-source-gate");
assert.ok(finalSourceCase);
assert.equal(finalSourceCase.status, allAgentGatesPassed ? "pass" : "partial");
const expectedAgentBlocking = [
  ...nonUserCaseFailures.map((item) => ({
    id: item.id,
    status: item.status,
    owner: "agent",
    completionImpact: "blocks_agent_scope_completion",
    evidence: [...(item.evidence ?? [])],
    ...(item.id === "windows-authenticode"
      ? { classification: "required_artifact_signature", required: true, observed: "NotSigned" }
      : {}),
  })),
  ...acceptance.agentRevalidation.gates
    .filter((gate) => gate.status !== "pass")
    .map((gate) => ({
      id: gate.id,
      status: gate.status,
      owner: "agent",
      completionImpact: "blocks_agent_scope_completion",
      evidence: [...gate.evidence],
      ...(gate.classification ? { classification: gate.classification } : {}),
      ...(Object.hasOwn(gate, "productPass") ? { productPass: gate.productPass } : {}),
    })),
];
assert.deepEqual(acceptance.agentBlocking, expectedAgentBlocking);
assert.deepEqual(
  acceptance.blocking,
  [...expectedAgentBlocking, ...acceptance.userAcceptancePending],
);
if (allAgentGatesPassed) assert.deepEqual(acceptance.agentBlocking, []);
else assert.ok(acceptance.agentBlocking.length > 0);
assert.equal(allAgentGatesPassed, false);
assert.equal(acceptance.agentScopeStatus, "incomplete_agent_revalidation_pending");
assert.equal(acceptance.sourceGate.allRequiredAgentGatesPassed, false);
assert.equal(finalSourceCase.status, "partial");
assert.deepEqual(
  acceptance.agentBlocking.map((item) => item.id).sort(),
  ["desktop-notification-project-route-live", "windows-authenticode"],
);
assert.ok(
  acceptance.blocking.some(
    (item) =>
      item.id === "desktop-notification-project-route-live" &&
      item.status === "fail" &&
      item.classification === "environment_blocker" &&
      item.productPass === false,
  ),
);

for (const item of acceptance.cases) {
  for (const evidence of item.evidence ?? []) {
    await assertEvidenceFile(item.id, evidence);
    assertIndexedWhenInRoot(item.id, evidence);
  }
}
for (const evidence of acceptance.sourceGate.evidence) {
  await assertEvidenceFile("source-gate", evidence);
  assertIndexedWhenInRoot("source-gate", evidence);
}

const coverage = await json("../coverage-matrix.json", "coverage matrix");
assert.match(coverage.sourceHead, /^[a-f0-9]{40}$/u);
assert.equal(coverage.summary.itemCount, coverage.items.length);
assert.ok(Array.isArray(coverage.retiredItems));
const coverageDiff = spawnSync(
  "git",
  ["diff", "--quiet", productSourceCommit, coverage.sourceHead, "--", ...productSourceRoots],
  { cwd: repoRoot, stdio: "ignore" },
);
assert.ok([0, 1].includes(coverageDiff.status), "git diff failed while checking coverage provenance");
const coverageProductSourceMatches = coverageDiff.status === 0;
if (allAgentGatesPassed) {
  assert.equal(
    coverageProductSourceMatches,
    true,
    "coverage matrix must match the product source before agent scope can be complete",
  );
}

assert.equal(continuationSummary.productSourceCommit, productSourceCommit);
assert.equal(continuationSummary.release.releaseId, "20260911T000006100Z");
assert.equal(continuationSummary.release.version, "0.2.0-preview.20");
assert.equal(continuationSummary.release.installer.sha256, acceptance.artifacts.windows.sha256);
assert.equal(postfixValidation.packagePublicationPassed, true);
assert.equal(postfixValidation.installedUpgradePassed, true);
assert.equal(postfixValidation.registrationPassed, true);
const androidArtifact = await json(retainedAndroidArtifactPath);
assert.match(androidArtifact.sourceCommit, /^[a-f0-9]{40}$/u);
assert.equal(androidArtifact.signatureVerified, true);
const androidArtifactTree = execFileSync(
  "git",
  ["rev-parse", `${androidArtifact.sourceCommit}:apps/android`],
  { cwd: repoRoot, encoding: "utf8" },
).trim();
const androidProductTree = execFileSync(
  "git",
  ["rev-parse", `${productSourceCommit}:apps/android`],
  { cwd: repoRoot, encoding: "utf8" },
).trim();
assert.equal(androidArtifactTree, androidProductTree);

const liveHttp = await json("live-http-e2e.json");
const dbReceipt = await json("live-http-db-receipt.json");
const mcp = await json("post-restart-mcp-check.json");
const secretScan = await json("secret-scan.json");
const secretScannerPath = await repoRegularFile(
  "scan-evidence-secrets.mjs",
  "secret scanner",
);
const currentSecretScanProcess = spawnSync(
  process.execPath,
  [
    secretScannerPath,
    "--root",
    root,
    "--instance-path",
    canonicalInstancePath,
    "--dry-run",
  ],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
assert.equal(
  currentSecretScanProcess.status,
  0,
  `current secret scan failed: ${currentSecretScanProcess.stderr}`,
);
const currentSecretScan = JSON.parse(currentSecretScanProcess.stdout);
assert.equal(liveHttp.assertionsPassed, true);
assert.equal(dbReceipt.passed, true);
assert.equal(mcp.passed, true);
assert.equal(secretScan.schemaVersion, 2);
assert.equal(secretScan.passed, true);
assert.equal(secretScan.sourceCommit, productSourceCommit);
assert.equal(secretScan.productSourceCommit, productSourceCommit);
assert.equal(secretScan.credentialsPersisted, false);
assert.equal(
  secretScan.selection.instance.path,
  path.resolve(canonicalInstancePath).split(path.sep).join("/"),
);
assert.equal(secretScan.selection.instance.instanceId, "qa-hub-preview-v21-e2e-fresh-0910");
assert.equal(secretScan.selection.instance.sha256, canonicalInstanceSha256);
assert.deepEqual(secretScan.selection.secrets, {
  path: path.resolve(canonicalSecretsPath).split(path.sep).join("/"),
  names: canonicalSecretNames,
  sha256: canonicalSecretsSha256,
});
assert.equal(secretScan.protectedValueCount, canonicalSecretNames.length);
assert.deepEqual(secretScan.exactSecretHits, []);
assert.deepEqual(secretScan.credentialPatternHits, []);
for (const property of [
  "schemaVersion",
  "sourceCommit",
  "productSourceCommit",
  "selection",
  "scannedFileCount",
  "protectedValueCount",
  "exactSecretHits",
  "credentialPatternHits",
  "credentialsPersisted",
  "passed",
]) {
  assert.deepEqual(
    secretScan[property],
    currentSecretScan[property],
    `stored secret scan is stale or incomplete: ${property}`,
  );
}
assert.equal(dbReceipt.receipt.digestAlgorithm, "HMAC-SHA-256");
assert.equal(dbReceipt.receipt.count, 1);
assert.equal(dbReceipt.auditEvent.count, 1);
assert.deepEqual(
  mcp.results.map((item) => item.toolCount),
  [96, 96],
  "MCP tool counts validate catalog size only",
);
const executedMcpTools = [
  ...new Set(
    mcp.results.flatMap((result) =>
      result.calls.filter((call) => call.toolName).map((call) => call.toolName),
    ),
  ),
].sort();
assert.deepEqual(executedMcpTools, ["qa_list_bugs", "qa_list_projects", "qa_login"]);
assert.deepEqual([...serverMcp.executedBusinessSubset].sort(), executedMcpTools);

assert.equal(index.schemaVersion, 2);
assert.equal(index.root, rootFromRepo);
assert.equal(index.sourceCommit, productSourceCommit);
assert.equal(index.productSourceCommit, productSourceCommit);
assert.deepEqual(index.selection, {
  method: "git ls-files",
  trackedOnly: true,
  excludedPaths: indexExcludedPaths,
  completeTrackedSetVerified: true,
});
const expectedIndexedPaths = trackedAllowlist();
assert.deepEqual(
  index.entries.map((entry) => entry.path),
  expectedIndexedPaths,
  "index must include the complete tracked allowlist exactly once",
);
assert.equal(index.files, index.entries.length);
assert.equal(index.files, expectedIndexedPaths.length);
let indexedTotalBytes = 0;
let parsedJsonFiles = 0;
const aggregate = createHash("sha256");
for (const entry of index.entries) {
  const absolute = await repoRegularFile(entry.path, `index entry ${entry.path}`);
  assert.equal(
    path.relative(root, absolute).split(path.sep).join("/"),
    entry.path,
    `non-canonical index path: ${entry.path}`,
  );
  const bytes = await readFile(absolute);
  assert.equal(bytes.byteLength, entry.bytes, entry.path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.path);
  indexedTotalBytes += bytes.byteLength;
  aggregate.update(entry.path, "utf8");
  aggregate.update("\0", "utf8");
  aggregate.update(String(entry.bytes), "utf8");
  aggregate.update("\0", "utf8");
  aggregate.update(entry.sha256, "utf8");
  aggregate.update("\n", "utf8");
  if (path.extname(entry.path).toLowerCase() === ".json") {
    JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
    parsedJsonFiles += 1;
  }
}
assert.equal(index.totalBytes, indexedTotalBytes);
assert.equal(index.aggregateSha256, aggregate.digest("hex"));

const result = {
  schemaVersion: 2,
  validatedAt: new Date().toISOString(),
  validationScope: "evidence_structure_and_declared_gate_consistency",
  sourceCommit: productSourceCommit,
  productSourceCommit,
  acceptanceOverallStatus: acceptance.overallStatus,
  agentScopeStatus: acceptance.agentScopeStatus,
  completionAllowed: false,
  delegatedUserCases: delegatedIds.length,
  delegatedCasesAllNotRun: true,
  agentGatesAllPassed: allAgentGatesPassed,
  postfixEvidence: {
    passed: postfixValidation.passed,
    releaseId: postfixValidation.releaseId,
    version: postfixValidation.version,
    packagePublicationPassed: postfixValidation.packagePublicationPassed,
    installedUpgradePassed: postfixValidation.installedUpgradePassed,
    registrationPassed: postfixValidation.registrationPassed,
  },
  agentBlockers: acceptance.agentBlocking,
  authenticode: acceptance.artifacts.windows.authenticode,
  notificationGate: {
    id: notificationGate.id,
    status: notificationGate.status,
    classification: notificationGate.classification,
    productPass: notificationGate.productPass,
    semanticProof: notificationGate.semanticProof,
  },
  fineGrainedCoverage: {
    items: coverage.items.length,
    retiredItems: coverage.retiredItems.length,
    needsRevalidation: coverage.items.filter((item) => item.needsRevalidation === true).length,
  },
  coverageSourceHead: coverage.sourceHead,
  coverageProductSourceMatches,
  indexedTrackedFiles: index.entries.length,
  parsedIndexedJsonFiles: parsedJsonFiles,
  indexCompleteTrackedSetVerified: true,
  serverMcpEvidenceScope: {
    claim: "catalog_and_executed_business_subset",
    catalogToolCountsObserved: mcp.results.map((item) => item.toolCount),
    executedTools: executedMcpTools,
    allCatalogToolsBusinessValidated: false,
  },
  credentialsPersisted: false,
  evidenceStructurePassed: true,
  productAcceptancePassed: false,
};
if (!dryRun) {
  const outputPath = await repoRegularFile("final-validation.json", "final validation output");
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ dryRun, ...result }, null, 2));
