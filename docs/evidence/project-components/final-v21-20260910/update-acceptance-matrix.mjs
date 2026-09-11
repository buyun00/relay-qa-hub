import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const canonicalPreviewConfigPath =
  "C:\\Users\\lin0\\AppData\\Local\\Programs\\RelayQaHubPreview-v21-e2e-fresh-0910\\preview-instance.json";
const canonicalSecretsPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\secrets.json";
const canonicalPublicKeyPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\desktop-signing\\public.pem";
const build20ManifestPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\downloads\\qa-hub-preview-v21-e2e-fresh-0910-windows-latest.json";
const build20InstallerPath =
  "C:\\Users\\lin0\\.codex\\parallel-runtimes\\qa-hub-preview-v21-e2e-fresh-0910\\downloads\\qa-hub-preview-v21-e2e-fresh-0910-windows-0.2.0-preview.20-20260911T000006100Z.exe";
const windowsPowerShellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const moveFileWriteThroughPath =
  "C:\\Users\\lin0\\.codex\\worktrees\\7c86\\Relay-QA-Hub\\scripts\\project-components\\move-file-write-through.ps1";
const expectedInputFingerprints = [
  {
    path: canonicalInstancePath,
    bytes: 1327,
    sha256: "cf92bad26060bbcddcfc37d620320e8bac15e09104088944e456a3b9205257db",
  },
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
  {
    path: canonicalSecretsPath,
    bytes: 242,
    sha256: "fcf0173d2eaac6c6a7d6fa56a990870796a80fac34bee3de696a7fdd094c4468",
  },
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
const continuationSummaryPath = "continuation-20260911/postfix-fd0f0f8/summary.json";
const packageVerificationPath = continuationSummaryPath;
const continuationValidatorPath =
  "continuation-20260911/postfix-fd0f0f8/validate-postfix-evidence.mjs";
const packageReceiptPath = "continuation-20260911/postfix-fd0f0f8/package/receipt.json";
const publicationResultPath =
  "continuation-20260911/postfix-fd0f0f8/package/publication-result.json";
const signedManifestPath =
  "continuation-20260911/postfix-fd0f0f8/package/signed-manifest.json";
const upgradeVerificationPath =
  "continuation-20260911/postfix-fd0f0f8/upgrade/auto-relaunch-verification.json";
const postUpgradeReadbackPath =
  "continuation-20260911/postfix-fd0f0f8/upgrade/postupgrade-readonly.json";
const registrationVerificationPath =
  "continuation-20260911/postfix-fd0f0f8/upgrade/registration-readonly.json";
const retainedAndroidArtifactPath =
  "android/acceptance/android-code28-self-update/artifact-verification.json";
const historicalWebReadbackPath = "continuation-20260910/web-cua-readback.json";
const notificationProofPath =
  "../desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json";
const defaultAgentGateEvidence = [
  notificationProofPath,
  continuationSummaryPath,
];

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
const rootFromRepo = path.relative(repoRoot, root);
assert.ok(
  rootFromRepo &&
    rootFromRepo !== ".." &&
    !rootFromRepo.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rootFromRepo),
  "evidence root must be inside the repository",
);
const matrixPath = path.join(root, "acceptance-matrix.json");
const markdownPath = path.join(root, "acceptance-matrix.md");

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

async function isFile(relative) {
  try {
    await repoRegularFile(relative, relative);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function regularJson(relative, label) {
  return json(relative, label);
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

const matrix = await json("acceptance-matrix.json");
assert.equal(
  new Set(matrix.cases.map((item) => item.id)).size,
  matrix.cases.length,
  "acceptance case ids must be globally unique",
);
const coverageMatrix = await json("../coverage-matrix.json");
const continuationSummary = await json(continuationSummaryPath);
const packageReceipt = await json(packageReceiptPath);
const publicationResult = await json(publicationResultPath);
const signedManifest = await json(signedManifestPath);
const upgradeVerification = await json(upgradeVerificationPath);
const postUpgradeReadback = await json(postUpgradeReadbackPath);
const registrationVerification = await json(registrationVerificationPath);
const notificationProof = await json(notificationProofPath);
const androidArtifact = await json(retainedAndroidArtifactPath);
const historicalWebReadback = await json(historicalWebReadbackPath);
const retainedMcpReadback = await json("post-restart-mcp-check.json");
const postfixValidatorAbsolute = await repoRegularFile(
  continuationValidatorPath,
  "postfix evidence validator",
);
const postfixValidation = JSON.parse(
  execFileSync(process.execPath, [postfixValidatorAbsolute], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }),
);
assert.equal(postfixValidation.passed, true);
assert.equal(postfixValidation.productSourceCommit, productSourceCommit);
assert.equal(continuationSummary.productSourceCommit, productSourceCommit);
assert.equal(continuationSummary.overallStatus, "not_complete");
assert.equal(continuationSummary.completionAllowed, false);
assert.equal(packageReceipt.sourceCommit, productSourceCommit);
assert.equal(packageReceipt.sourceDirty, false);
assert.equal(packageReceipt.releaseId, continuationSummary.release.releaseId);
assert.equal(packageReceipt.version, continuationSummary.release.version);
assert.equal(publicationResult.receiptSha256, continuationSummary.release.receipt.sha256);
assert.equal(publicationResult.stateValidation.contentCommitted, true);
assert.equal(publicationResult.stateValidation.completed, true);
assert.equal(signedManifest.releaseId, continuationSummary.release.releaseId);
assert.equal(signedManifest.version, continuationSummary.release.version);
assert.equal(upgradeVerification.transition.sourceCommit, productSourceCommit);
assert.equal(upgradeVerification.passed, true);
assert.equal(postUpgradeReadback.passed, true);
assert.equal(registrationVerification.passed, true);
assert.equal(registrationVerification.authenticode.status, "NotSigned");
assert.equal(notificationProof.passed, false);
assert.equal(notificationProof.error.classification, "environment_blocker");
assert.equal(notificationProof.sessionPreflight.productPass, false);
const packageVerification = {
  sourceCommit: productSourceCommit,
  passed: postfixValidation.packagePublicationPassed,
  releaseId: continuationSummary.release.releaseId,
  version: continuationSummary.release.version,
  installer: continuationSummary.release.installer,
  checks: {
    signatureValid: continuationSummary.release.manifest.ed25519Verified,
    webDistByteExact: true,
  },
};
assert.equal(coverageMatrix.summary.itemCount, coverageMatrix.items.length);
assert.ok(Array.isArray(coverageMatrix.retiredItems));
assert.match(androidArtifact.sourceCommit, /^[a-f0-9]{40}$/u);
assert.equal(androidArtifact.signatureVerified, true);
assert.equal(historicalWebReadback.passed, true);
assert.equal(retainedMcpReadback.passed, true);
assert.deepEqual(
  retainedMcpReadback.results.map((item) => item.toolCount),
  [96, 96],
);

const byId = new Map(matrix.cases.map((item) => [item.id, item]));
const requireCase = (id) => {
  const item = byId.get(id);
  assert.ok(item, `missing acceptance case ${id}`);
  return item;
};
const addEvidence = (item, ...paths) => {
  item.evidence = [...new Set([...(item.evidence ?? []), ...paths])];
};

function normalizeAgentGateReport(raw, reportPath) {
  assert.equal(raw.sourceCommit, productSourceCommit, "agent gate report must target the product source");
  assert.ok(Array.isArray(raw.requiredGateIds) && raw.requiredGateIds.length > 0);
  assert.equal(new Set(raw.requiredGateIds).size, raw.requiredGateIds.length);
  assert.deepEqual(
    [...raw.requiredGateIds].sort(),
    [...requiredAdditionalAgentGateIds].sort(),
    "agent gate report must cover the configured final revalidation gates",
  );
  assert.ok(Array.isArray(raw.gates));
  const gateById = new Map(raw.gates.map((gate) => [gate.id, gate]));
  assert.equal(gateById.size, raw.gates.length, "agent gate report contains duplicate ids");
  assert.deepEqual(
    [...gateById.keys()].sort(),
    [...raw.requiredGateIds].sort(),
    "agent gate report must contain every required gate exactly once",
  );
  for (const gate of raw.gates) {
    assert.match(gate.id, /^[a-z0-9][a-z0-9._-]*$/u);
    assert.ok(["pass", "fail", "not_run", "pending"].includes(gate.status));
    assert.ok(Array.isArray(gate.evidence) && gate.evidence.length > 0, `${gate.id} needs evidence`);
    assert.ok(gate.evidence.every((evidence) => !path.isAbsolute(evidence)));
  }
  const allPassed = raw.gates.every((gate) => gate.status === "pass");
  assert.equal(raw.passed, allPassed, "agent gate report passed flag must match its gates");
  return {
    schemaVersion: 1,
    sourceCommit: productSourceCommit,
    report: reportPath,
    reportSupplied: true,
    requiredGateIds: [...raw.requiredGateIds],
    gates: raw.gates.map((gate) => ({
      id: gate.id,
      status: gate.status,
      evidence: [...gate.evidence],
      ...(gate.detail ? { detail: gate.detail } : {}),
      ...(gate.classification ? { classification: gate.classification } : {}),
      ...(Object.hasOwn(gate, "productPass") ? { productPass: gate.productPass } : {}),
    })),
    allRequiredGatesPassed: allPassed,
  };
}

const agentGatesFile = option("--agent-gates-file");
let agentRevalidation;
if (agentGatesFile) {
  const reportAbsolute = repoContainedPath(agentGatesFile, "agent gate report");
  const reportRelative = path.relative(root, reportAbsolute).split(path.sep).join("/");
  assert.ok(!reportRelative.startsWith("../"), "agent gate report must be inside the evidence root");
  agentRevalidation = normalizeAgentGateReport(
    await json(reportRelative, "agent gate report"),
    reportRelative,
  );
  for (const gate of agentRevalidation.gates) {
    for (const evidence of gate.evidence) {
      assert.equal(await isFile(evidence), true, `${gate.id}: missing ${evidence}`);
    }
    if (gate.id === "desktop-notification-project-route-live" && gate.status === "pass") {
      gate.semanticProof = await validatePassingDesktopNotificationEvidence(gate.evidence);
    } else if (gate.id === "desktop-notification-project-route-live" && gate.status === "fail") {
      assert.equal(gate.classification, "environment_blocker");
      assert.equal(gate.productPass, false);
      gate.semanticProof = await validateBlockedDesktopNotificationEvidence(gate.evidence);
    }
  }
} else {
  for (const evidence of defaultAgentGateEvidence) {
    assert.equal(await isFile(evidence), true, `missing retained failed gate evidence: ${evidence}`);
  }
  agentRevalidation = {
    schemaVersion: 1,
    sourceCommit: productSourceCommit,
    report: null,
    reportSupplied: false,
    requiredGateIds: requiredAdditionalAgentGateIds,
    gates: [
      {
        id: "desktop-notification-project-route-live",
        status: "fail",
        classification: "environment_blocker",
        productPass: false,
        detail:
          "The build 20 preflight submitted and closed its native test notification, but WPN routed it to console SessionId 1 while the app and observer ran in RDP SessionId 2. No business fixture or business write request was created; only one read-only readiness request ran. The environment blocker is not a product pass.",
        evidence: defaultAgentGateEvidence,
        semanticProof: await validateBlockedDesktopNotificationEvidence(defaultAgentGateEvidence),
      },
    ],
    allRequiredGatesPassed: false,
  };
}

for (const id of delegatedIds) {
  const item = requireCase(id);
  item.status = "not_run";
  item.owner = "user";
  item.handoffStatus = "delegated_pending";
  item.agentExecuted = false;
  item.completionImpact = "blocks_final_acceptance";
  item.resultLabel = userLabel;
  addEvidence(item, "user-self-test-handoff.md");
}

const oldServerMcp = byId.get("server-mcp-96-tools-business");
assert.ok(
  !oldServerMcp || !byId.has("server-mcp-catalog-and-business-subset"),
  "legacy and scoped server MCP cases cannot coexist",
);
const serverMcp = oldServerMcp ?? requireCase("server-mcp-catalog-and-business-subset");
if (oldServerMcp) {
  serverMcp.id = "server-mcp-catalog-and-business-subset";
  serverMcp.legacyId = "server-mcp-96-tools-business";
  byId.delete("server-mcp-96-tools-business");
  byId.set(serverMcp.id, serverMcp);
}
serverMcp.status = "pass";
serverMcp.claimScope = "catalog_and_executed_business_subset";
serverMcp.catalogToolCountObserved = 96;
serverMcp.executedBusinessSubset = ["qa_login", "qa_list_projects", "qa_list_bugs"];
serverMcp.detail =
  "The server and local MCP catalogs each exposed 96 entries. The executed business scope is limited to initialize, catalog, login, project-list, Bug-list, and the retained attachment parity subset; catalog size does not establish per-tool business E2E.";

const windowsCase = requireCase("windows-built-in-update-and-local-mcp");
windowsCase.status = "pass";
windowsCase.detail =
  "The isolated signed-manifest updater completed 0.2.0-preview.19 to 0.2.0-preview.20, relaunched the exact installed executable, preserved the version 19 rollback backup, preview configuration, project, drafts, and local MCP, and passed the post-upgrade read-only reload. Authenticode and desktop notification routing remain separate failed agent gates.";
addEvidence(
  windowsCase,
  continuationSummaryPath,
  packageReceiptPath,
  publicationResultPath,
  signedManifestPath,
  upgradeVerificationPath,
  postUpgradeReadbackPath,
  registrationVerificationPath,
);

const coexistenceCase = requireCase("production-and-preview-coexistence");
coexistenceCase.status = "pass";
coexistenceCase.detail =
  "Build 20 auto-relaunch preserved the production and isolated service owners while local MCP 4642 belonged to the upgraded preview. The later native-notification preflight started and gracefully stopped only its exact child, and its final host check kept the pre-existing QA Hub process and protected listener fingerprints unchanged. Native toast visibility itself remains failed.";
addEvidence(coexistenceCase, upgradeVerificationPath, notificationProofPath, continuationSummaryPath);

let authenticodeCase = byId.get("windows-authenticode");
if (!authenticodeCase) {
  authenticodeCase = { id: "windows-authenticode", evidence: [] };
  matrix.cases.push(authenticodeCase);
  byId.set(authenticodeCase.id, authenticodeCase);
}
authenticodeCase.status = "fail";
authenticodeCase.owner = "agent";
authenticodeCase.completionImpact = "blocks_agent_scope_completion";
authenticodeCase.detail =
  "Authenticode is required for final acceptance. The installed build 20 EXE was inspected after upgrade and returned NotSigned with no signer or timestamper, so this gate remains failed.";
authenticodeCase.evidence = [registrationVerificationPath, continuationSummaryPath];

matrix.artifacts.windows = {
  releaseId: packageVerification.releaseId,
  version: packageVerification.version,
  bytes: packageVerification.installer.bytes,
  sha256: packageVerification.installer.sha256,
  manifestEd25519: packageVerification.checks.signatureValid,
  authenticode: {
    required: true,
    status: "fail",
    observed: registrationVerification.authenticode.status,
    signer: registrationVerification.authenticode.signer,
    timestamper: registrationVerification.authenticode.timestamper,
    completionImpact: "blocks_agent_scope_completion",
    evidence: [registrationVerificationPath, continuationSummaryPath],
  },
  sourceCommit: productSourceCommit,
};
matrix.artifacts.android = {
  ...matrix.artifacts.android,
  sourceCommit: androidArtifact.sourceCommit,
};

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
assert.equal(androidArtifactTree, androidProductTree, "retained Android source must match the product tree");

matrix.recordedAt = new Date().toISOString();
matrix.overallStatus = "not_complete";
matrix.completionAllowed = false;
matrix.productAcceptancePassed = false;
matrix.userAcceptanceStatus = "delegated_pending";
matrix.productSourceCommit = productSourceCommit;
matrix.statusVocabulary.user_handoff = userLabel;
matrix.sourceProvenance = {
  productSourceAnchor: productSourceCommit,
  windowsTrialArtifact: {
    sourceCommit: productSourceCommit,
    releaseId: continuationSummary.release.releaseId,
    version: continuationSummary.release.version,
    evidence: [continuationSummaryPath, packageReceiptPath, publicationResultPath, signedManifestPath],
  },
  webInWindowsTrialArtifact: {
    sourceCommit: productSourceCommit,
    packagedByteExact: packageVerification.checks.webDistByteExact,
    evidence: [continuationSummaryPath, packageReceiptPath],
  },
  windowsTrialRuntime: {
    sourceCommit: productSourceCommit,
    status: "upgrade_verified",
    evidence: [upgradeVerificationPath, postUpgradeReadbackPath, notificationProofPath],
  },
  retainedAndroidTrialArtifact: {
    sourceCommit: androidArtifact.sourceCommit,
    artifactTree: androidArtifactTree,
    productTree: androidProductTree,
    treeEqual: true,
    evidence: [retainedAndroidArtifactPath],
  },
  historicalWebBrowserReadback: {
    sourceCommit: historicalWebReadback.source.productSourceCommit,
    evidence: [historicalWebReadbackPath],
  },
  note:
    "The product source anchor and Windows/Web build 20 package are fd0f0f8. The retained Android artifact predates that commit but its apps/android Git tree is identical. Historical browser evidence keeps its recorded source; current-source agent revalidation is tracked separately and cannot be inferred from source equivalence.",
};

const delegatedSet = new Set(delegatedIds);
const nonUserCaseFailures = matrix.cases
  .filter((item) => !delegatedSet.has(item.id) && item.id !== "final-source-gate")
  .filter((item) => item.status !== "pass")
  .map((item) => ({
    id: item.id,
    status: item.status,
    owner: "agent",
    completionImpact: "blocks_agent_scope_completion",
    evidence: [...(item.evidence ?? [])],
    ...(item.id === "windows-authenticode"
      ? { classification: "required_artifact_signature", required: true, observed: "NotSigned" }
      : {}),
  }));
const failedAgentGates = agentRevalidation.gates
  .filter((gate) => gate.status !== "pass")
  .map((gate) => ({
    id: gate.id,
    status: gate.status,
    owner: "agent",
    completionImpact: "blocks_agent_scope_completion",
    evidence: [...gate.evidence],
    ...(gate.classification ? { classification: gate.classification } : {}),
    ...(Object.hasOwn(gate, "productPass") ? { productPass: gate.productPass } : {}),
  }));
const allAgentGatesPassed =
  agentRevalidation.reportSupplied &&
  agentRevalidation.allRequiredGatesPassed &&
  nonUserCaseFailures.length === 0;
matrix.agentScopeStatus = allAgentGatesPassed
  ? "complete_user_acceptance_pending"
  : "incomplete_agent_revalidation_pending";
matrix.agentRevalidation = agentRevalidation;
matrix.agentBlocking = [...nonUserCaseFailures, ...failedAgentGates];
matrix.userAcceptancePending = delegatedIds.map((id) => ({
  id,
  status: "not_run",
  owner: "user",
  handoffStatus: "delegated_pending",
  agentExecuted: false,
  completionImpact: "blocks_final_acceptance",
  resultLabel: userLabel,
}));
matrix.blocking = [...matrix.agentBlocking, ...matrix.userAcceptancePending];

const finalSourceCase = requireCase("final-source-gate");
const agentGateEvidence = [
  ...(agentRevalidation.report ? [agentRevalidation.report] : []),
  ...agentRevalidation.gates.flatMap((gate) => gate.evidence),
];
finalSourceCase.status = allAgentGatesPassed ? "pass" : "partial";
finalSourceCase.detail = allAgentGatesPassed
  ? `All required agent gate results for product source ${productSourceCommit} passed; the six delegated user gates remain NOT_RUN and still block final acceptance.`
  : `Product source is anchored at ${productSourceCommit}, but one or more required agent gates remain failed, pending, or unreported.`;
addEvidence(finalSourceCase, packageVerificationPath, ...agentGateEvidence);

matrix.sourceGate = {
  productSourceCommit,
  status: matrix.agentScopeStatus,
  agentGateReport: agentRevalidation.report,
  allRequiredAgentGatesPassed: allAgentGatesPassed,
  evidence: [...new Set([packageVerificationPath, ...agentGateEvidence])],
};
matrix.coverageAudit = {
  status: "retained_open_inventory",
  detail: `The generated ${coverageMatrix.items.length.toLocaleString("en-US")}-item inventory retains ${coverageMatrix.items.filter((item) => item.needsRevalidation === true).length.toLocaleString("en-US")} source-revalidation flags. These are retained as inventory and are never rewritten as PASS by this updater.`,
  evidence: ["../coverage-matrix.json", "../coverage-matrix.md"],
};
matrix.fineGrainedCoverage = {
  items: coverageMatrix.items.length,
  retiredItems: coverageMatrix.retiredItems.length,
  needsRevalidation: coverageMatrix.items.filter((item) => item.needsRevalidation === true).length,
  unavailableReviewedEvidence:
    coverageMatrix.evidenceMapping?.unavailableReviewedEvidence?.length ?? 0,
  note:
    "Fine-grained not_run and needsRevalidation rows remain retained and are not counted as PASS. They do not replace the explicit agent and user acceptance gates.",
};

const verifiedMarkdownPath = await repoRegularFile(
  "acceptance-matrix.md",
  "acceptance matrix markdown",
);
const markdownLines = (await readFile(verifiedMarkdownPath, "utf8"))
  .split(/\r?\n/u)
  .filter(
    (line) =>
      !line.startsWith("保留客户端源码等价：") &&
      !line.startsWith("来源说明：") &&
      !line.startsWith("| 桌面通知项目路由 |"),
  );
const replaceMarkdownLine = (prefixOrPrefixes, value) => {
  const prefixes = Array.isArray(prefixOrPrefixes) ? prefixOrPrefixes : [prefixOrPrefixes];
  const indexes = markdownLines
    .map((line, index) => (prefixes.some((prefix) => line.startsWith(prefix)) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(indexes.length, 1, `expected one Markdown line for ${prefixes.join(" or ")}`);
  markdownLines[indexes[0]] = value;
  return indexes[0];
};
const provenanceLine = replaceMarkdownLine(
  ["最终 API/Android 源码：", "最终产品源码锚点："],
  `最终产品源码锚点：\`${productSourceCommit}\`；Windows/Web build 20 来自该提交，Android 保留产物的 \`apps/android\` Git tree 与该提交一致。  `,
);
markdownLines.splice(
  provenanceLine + 1,
  0,
  `来源说明：历史浏览器回读保留其原始提交 \`${historicalWebReadback.source.productSourceCommit}\`；当前源码代理复验状态单独记录，不能由源码等价推定。  `,
);
replaceMarkdownLine(
  "结论：",
  allAgentGatesPassed
    ? "结论：**代理门禁已通过，但整体仍为 NOT COMPLETE。** 六项用户自测均已移交、代理未执行且保持 NOT_RUN；在用户真实验收全部通过前，禁止宣布完成。"
    : "结论：**代理复验仍未完成，整体为 NOT COMPLETE。** 当前仍有代理门禁失败、待测或未提供完整报告；六项用户自测也均已移交、代理未执行且保持 NOT_RUN。",
);
replaceMarkdownLine(
  "| server MCP |",
  "| server MCP | MCP `4641` | PASS（目录与已执行子集） | server/local MCP 均观察到 96 项工具目录；真实执行范围仅为 initialize、目录、登录、项目列表、Bug 列表与已有附件一致性子集。该证据不声称 96 项工具全部通过业务 E2E。见 [`post-restart-mcp-check.json`](post-restart-mcp-check.json)。 |",
);
replaceMarkdownLine(
  "| Windows EXE 与 local MCP |",
  `| Windows EXE 与 local MCP | EXE + MCP \`4642\` | PASS（升级链路） | 隔离 Ed25519 清单更新器完成 \`0.2.0-preview.19→0.2.0-preview.20\`，精确重启已安装 EXE，保留 version 19 回退备份、preview 配置、项目、草稿与 local MCP；升级后只读 reload 通过。Authenticode 与桌面通知路由仍为独立失败门禁。见 [\`${upgradeVerificationPath}\`](${upgradeVerificationPath})、[\`${postUpgradeReadbackPath}\`](${postUpgradeReadbackPath})、[\`${registrationVerificationPath}\`](${registrationVerificationPath}) 与 [\`${continuationSummaryPath}\`](${continuationSummaryPath})。 |`,
);
replaceMarkdownLine(
  "| Windows 候选完整性 |",
  `| Windows 候选完整性 | installer/feed | PASS | \`${packageVerification.version}\`，release \`${packageVerification.releaseId}\`，installer SHA-256 \`${packageVerification.installer.sha256}\`；独立 receipt、publication-result 与 signed manifest 绑定同一 source/release/version/hash，发布事务完成。见 [\`${continuationSummaryPath}\`](${continuationSummaryPath})、[\`${packageReceiptPath}\`](${packageReceiptPath})、[\`${publicationResultPath}\`](${publicationResultPath}) 与 [\`${signedManifestPath}\`](${signedManifestPath})。 |`,
);
const authenticodeLine = replaceMarkdownLine(
  "| Windows Authenticode |",
  `| Windows Authenticode | installed EXE | FAIL（必需门禁） | build 20 升级后只读检查为 \`NotSigned\`，signer 与 timestamper 均为空；该结果阻断代理范围完成。见 [\`${registrationVerificationPath}\`](${registrationVerificationPath}) 与 [\`${continuationSummaryPath}\`](${continuationSummaryPath})。 |`,
);
markdownLines.splice(
  authenticodeLine + 1,
  0,
  `| 桌面通知项目路由 | installed EXE + Windows WPN | FAIL（environment_blocker） | run \`81c44b26-5c6f-47c6-a56a-d4eb27f19d7a\` 仅完成 admission 与环境预检：无业务 fixture、无业务写请求，仅一次只读 readiness；WPN 投递到 console Session 1，而应用与 observer 位于 RDP Session 2，错误为 \`WINDOWS_TOAST_SESSION_MISMATCH\`。\`productPass=false\`，不得计为 PASS。见 [\`${notificationProofPath}\`](${notificationProofPath}) 与 [\`${continuationSummaryPath}\`](${continuationSummaryPath})。 |`,
);
replaceMarkdownLine(
  "| 生产、旧 preview 与失败现场并存 |",
  `| 生产、旧 preview 与失败现场并存 | read-only observation | PASS | build 20 自动重启期间生产与隔离服务 owner 保持；随后通知预检只启动并优雅退出其精确子进程，最终 host 指纹保留全部既有 QA Hub 进程与受保护监听。此项不把通知可见性记为通过。见 [\`${upgradeVerificationPath}\`](${upgradeVerificationPath})、[\`${notificationProofPath}\`](${notificationProofPath}) 与 [\`${continuationSummaryPath}\`](${continuationSummaryPath})。 |`,
);
replaceMarkdownLine(
  "| 最终源码门禁 |",
  allAgentGatesPassed
    ? `| 最终源码门禁 | source | PASS | 产品源码锚定 \`${productSourceCommit}\`，所提供的代理门禁报告覆盖全部必需门禁且全部通过；六项用户自测仍为 NOT_RUN。 |`
    : `| 最终源码门禁 | source | PARTIAL | 产品源码锚定 \`${productSourceCommit}\`，但代理复验仍有失败、待测或未报告门禁，不能记作完成。 |`,
);
replaceMarkdownLine(
  "- Windows：",
  `- Windows：隔离 feed 中的 \`qa-hub-preview-v21-e2e-fresh-0910-windows-${packageVerification.version}-${packageVerification.releaseId}.exe\`，SHA-256 \`${packageVerification.installer.sha256}\`。`,
);
replaceMarkdownLine(
  "- Web/API/server MCP：",
  `- Web/API/server MCP：隔离实例 \`4640/4639/4641\`；Windows ${packageVerification.version} 提供 local MCP \`4642\`。`,
);
replaceMarkdownLine(
  "用户侧六项均为",
  "用户侧六项均为 `用户自测／已移交，代理未执行`：物理 Android 真机、真实打包、单次打包上传、真实增量上传发布、Relay AI 制作交付、第三方同步/青鱼真实订单闭环。操作与回填要求见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。",
);

if (!dryRun) {
  const verifiedMatrixOutputPath = await repoRegularFile(
    "acceptance-matrix.json",
    "acceptance matrix output",
  );
  const verifiedMarkdownOutputPath = await repoRegularFile(
    "acceptance-matrix.md",
    "acceptance matrix markdown output",
  );
  assert.equal(verifiedMatrixOutputPath, matrixPath);
  assert.equal(verifiedMarkdownOutputPath, markdownPath);
  await writeFile(verifiedMatrixOutputPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  await writeFile(
    verifiedMarkdownOutputPath,
    `${markdownLines.join("\n").trimEnd()}\n`,
    "utf8",
  );
}
console.log(
  JSON.stringify(
    {
      dryRun,
      overallStatus: matrix.overallStatus,
      completionAllowed: matrix.completionAllowed,
      productAcceptancePassed: matrix.productAcceptancePassed,
      productSourceCommit: matrix.productSourceCommit,
      agentScopeStatus: matrix.agentScopeStatus,
      agentBlocking: matrix.agentBlocking.length,
      userAcceptancePending: matrix.userAcceptancePending.length,
      serverMcpClaimScope: serverMcp.claimScope,
    },
    null,
    2,
  ),
);
