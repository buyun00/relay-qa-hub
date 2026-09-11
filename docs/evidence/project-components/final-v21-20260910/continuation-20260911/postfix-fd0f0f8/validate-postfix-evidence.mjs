import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const finalRoot = path.resolve(here, "../..");
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: here,
  encoding: "utf8",
}).trim();
const sourceCommit = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const releaseId = "20260911T000006100Z";
const version = "0.2.0-preview.20";
const installerSha256 = "e0e68a626657f4431447764d96f0cf95ded8b6b081c8b13f809ccacd252e7e41";
const installedExeSha256 = "47e3d83120f29a6b2e0dc1fa54a2de6327c15c21620999b421b615a346e1fbac";
const installedAsarSha256 = "beecc244ab14d52a4b05e3475926285fb8fed2769c17d18f5e34e970644bbf96";
const userLabel = "用户自测／已移交，代理未执行";
const delegatedIds = [
  "android-physical-device",
  "external-build-terminal",
  "external-single-build-upload-terminal",
  "external-incremental-publication-terminal",
  "external-relay-delivery-terminal",
  "external-qingyu-order-terminal",
];

async function regularFile(absolute, label) {
  const resolved = path.resolve(absolute);
  const fromRepo = path.relative(repoRoot, resolved);
  assert.ok(
    fromRepo &&
      fromRepo !== ".." &&
      !fromRepo.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(fromRepo),
    `${label}: path escaped repository`,
  );
  let cursor = repoRoot;
  let stat;
  for (const part of fromRepo.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    stat = await lstat(cursor);
    assert.equal(stat.isSymbolicLink(), false, `${label}: symbolic links are forbidden`);
  }
  assert.equal(stat?.isFile(), true, `${label}: regular file required`);
  return resolved;
}

async function readJson(absolute, label) {
  const verified = await regularFile(absolute, label);
  return JSON.parse((await readFile(verified, "utf8")).replace(/^\uFEFF/u, ""));
}

async function evidence(summary, key, expectedSha256, expectedBytes) {
  const relative = summary.evidence[key];
  assert.equal(typeof relative, "string", `${key}: evidence path required`);
  assert.ok(!relative.includes("\\"), `${key}: forward-slash path required`);
  const absolute = await regularFile(path.resolve(finalRoot, ...relative.split("/")), key);
  const bytes = await readFile(absolute);
  assert.equal(bytes.byteLength, expectedBytes, `${key}: byte length mismatch`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expectedSha256,
    `${key}: SHA-256 mismatch`,
  );
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
}

const summary = await readJson(path.join(here, "summary.json"), "summary");
assert.equal(summary.schemaVersion, 1);
assert.equal(summary.kind, "relay-qa-hub-v21-postfix-final-evidence-summary");
assert.equal(summary.productSourceCommit, sourceCommit);
assert.equal(summary.overallStatus, "not_complete");
assert.equal(summary.completionAllowed, false);
assert.equal(summary.release.releaseId, releaseId);
assert.equal(summary.release.version, version);
assert.equal(summary.release.sourceDirty, false);
assert.deepEqual(summary.release.installer, {
  name: `qa-hub-preview-v21-e2e-fresh-0910-windows-${version}-${releaseId}.exe`,
  bytes: 107992506,
  sha256: installerSha256,
});
assert.deepEqual(summary.release.manifest, {
  bytes: 480,
  sha256: "41083ceeaa88c7cbd115e258bc8d2cb2f3cc7e2f2105687bfd1246de842d0204",
  ed25519Verified: true,
});

const receipt = await evidence(
  summary,
  "receipt",
  "5161bc558d5f6a32709b33601a18a32f3ad451be3848f360c4a7d51994e5ce5e",
  93397,
);
const publication = await evidence(
  summary,
  "publicationResult",
  "fe788e722763a445b3bbc4380aa90cd6bcd0d172c61df7019ea80fee5a195c70",
  2564,
);
const manifest = await evidence(
  summary,
  "signedManifest",
  summary.release.manifest.sha256,
  summary.release.manifest.bytes,
);
const autoRelaunch = await evidence(
  summary,
  "autoRelaunch",
  "7ecf6926ef87bba2c946eef6585fcf20acc58bf291ef5f0c06306638e8ab001a",
  8418,
);
const preUpgrade = await evidence(
  summary,
  "preUpgradeReadback",
  "74e9b7db334eec5b542c7f434e073fd0afbc588f926212f9844c4556ed91ac65",
  6380,
);
const postUpgrade = await evidence(
  summary,
  "postUpgradeReadback",
  "a569aaef15607b069de2a4b40d2e2486a19250d53fc2052b6d22a7de0416449b",
  6304,
);
const registration = await evidence(
  summary,
  "registration",
  "5fa14c67019f727c54cb36b9fad021bc4efc3f245c665d60698b5e183bfa6143",
  3046,
);
const notification = await evidence(
  summary,
  "notificationProof",
  "1c571b31b9152a653ad1ce25ab6fb7c80a1be7735cb01207c6fe61cf3751db3d",
  56423,
);
const notificationDirectory = path.dirname(
  path.resolve(finalRoot, ...summary.evidence.notificationProof.split("/")),
);
const notificationRaw = Object.fromEntries(
  await Promise.all(
    [
      "host-before.json",
      "host-after.json",
      "session-preflight-native-submit.json",
      "session-preflight-native-close.json",
      "session-preflight-toast-ready.json",
      "session-preflight-wpn-boundary.json",
      "session-preflight-wpn-events.json",
      "session-preflight-wpn-query-002.json",
      "session-preflight-wpn-correlation.json",
    ].map(async (name) => [
      name,
      await readJson(path.join(notificationDirectory, "raw", name), `notification raw ${name}`),
    ]),
  ),
);

assert.equal(receipt.schemaVersion, 2);
assert.equal(receipt.kind, "relay-qa-hub-preview-publication-receipt");
assert.equal(receipt.releaseId, releaseId);
assert.equal(receipt.version, version);
assert.equal(receipt.sourceCommit, sourceCommit);
assert.equal(receipt.sourceDirty, false);
assert.equal(receipt.sha256, installerSha256);
assert.equal(receipt.bytes, summary.release.installer.bytes);
assert.equal(receipt.publication.manifestSha256, summary.release.manifest.sha256);
assert.equal(receipt.publication.installerSha256, installerSha256);
assert.equal(receipt.publication.sourceCommit, sourceCommit);
assert.equal(receipt.releaseAttestation.publicKeySha256, "134709109a3e26a059a1e49ee21cebe467de39acc3e200d142e34d0fa80fb09b");
assert.equal(receipt.packageIdentity.toastActivatorClsid, summary.registration.toastActivatorClsid);
assert.deepEqual(receipt.packageContent.expected, receipt.packageContent.packaged);
assert.deepEqual(receipt.packageContent.expected, receipt.packageContent.finalPackaged);
assert.deepEqual(receipt.packageContent.expected, receipt.packageContent.finalStaged);
assert.deepEqual(receipt.installerContent.source, receipt.installerContent.finalSource);
assert.deepEqual(receipt.installerContent.source, receipt.installerContent.extracted);
assert.deepEqual(receipt.build.artifacts, receipt.build.packagedArtifacts);
assert.deepEqual(receipt.build.artifacts, receipt.build.finalPackagedArtifacts);
assert.deepEqual(receipt.build.artifacts, receipt.build.finalStagedArtifacts);

assert.equal(publication.schemaVersion, 1);
assert.equal(publication.kind, "relay-qa-hub-preview-publication-result");
assert.equal(publication.receiptSha256, summary.release.receipt.sha256);
assert.equal(publication.transactionId, summary.release.publication.transactionId);
assert.equal(publication.recovered, false);
assert.equal(publication.latest.sha256, summary.release.manifest.sha256);
assert.equal(publication.latest.bytes, summary.release.manifest.bytes);
assert.equal(publication.latest.httpValidation, "exact-signed-bytes");
assert.equal(publication.installer.sha256, installerSha256);
assert.equal(publication.installer.bytes, summary.release.installer.bytes);
assert.equal(publication.installer.httpValidation, "exact-bytes");
assert.equal(publication.stateValidation.contentCommitted, true);
assert.equal(publication.stateValidation.completed, true);
assert.equal(publication.stateValidation.recovered, false);
assert.equal(
  publication.stateValidation.stateValidation,
  summary.release.publication.stateValidation,
);

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.releaseId, releaseId);
assert.equal(manifest.version, version);
assert.deepEqual(manifest.archive, {
  url: `/downloads/${summary.release.installer.name}`,
  size: summary.release.installer.bytes,
  sha256: installerSha256,
});
assert.match(manifest.signature, /^[A-Za-z0-9+/]{86}==$/u);

assert.equal(autoRelaunch.schemaVersion, 1);
assert.deepEqual(autoRelaunch.transition, {
  from: summary.upgrade.from,
  to: summary.upgrade.to,
  releaseId,
  sourceCommit,
});
assert.equal(autoRelaunch.result.status, "installed");
assert.equal(autoRelaunch.result.releaseId, releaseId);
assert.equal(autoRelaunch.result.version, version);
assert.equal(autoRelaunch.marker.status, "ready");
assert.equal(autoRelaunch.marker.version, version);
assert.equal(autoRelaunch.installed.exe.sha256, installedExeSha256);
assert.equal(autoRelaunch.installed.asar.sha256, installedAsarSha256);
assert.deepEqual(
  { bytes: autoRelaunch.installed.exe.bytes, sha256: autoRelaunch.installed.exe.sha256 },
  { bytes: autoRelaunch.portable.exe.bytes, sha256: autoRelaunch.portable.exe.sha256 },
);
assert.deepEqual(
  { bytes: autoRelaunch.installed.asar.bytes, sha256: autoRelaunch.installed.asar.sha256 },
  { bytes: autoRelaunch.portable.asar.bytes, sha256: autoRelaunch.portable.asar.sha256 },
);
assert.equal(autoRelaunch.rollback.exe.sha256, summary.upgrade.rollback.exeSha256);
assert.equal(autoRelaunch.rollback.asar.sha256, summary.upgrade.rollback.asarSha256);
assert.equal(autoRelaunch.installed.config.sha256, summary.upgrade.preserved.previewConfigSha256);
assert.equal(autoRelaunch.rollback.config.sha256, summary.upgrade.preserved.previewConfigSha256);
assert.equal(autoRelaunch.mcp.result.serverInfo.version, version);
assert.equal(autoRelaunch.passed, true);
assert.ok(Object.values(autoRelaunch.checks).every((value) => value === true));

for (const [label, readback] of [
  ["pre-upgrade", preUpgrade],
  ["post-upgrade", postUpgrade],
]) {
  assert.equal(readback.schemaVersion, 1, `${label}: schema`);
  assert.equal(readback.passed, true, `${label}: passed`);
  assert.ok(Object.values(readback.checks).every((value) => value === true), `${label}: checks`);
  assert.equal(readback.beforeReload.projectId, summary.upgrade.preserved.projectId);
  assert.equal(readback.afterReload.projectId, summary.upgrade.preserved.projectId);
  assert.equal(readback.beforeReload.uiDraft.sha256, summary.upgrade.preserved.primaryDraftSha256);
  assert.equal(readback.afterReload.uiDraft.sha256, summary.upgrade.preserved.primaryDraftSha256);
  const fallback = readback.afterReload.database.records.find(
    (record) => record.newContentSha256 === summary.upgrade.preserved.fallbackDraftSha256,
  );
  assert.ok(fallback, `${label}: fallback draft missing`);
}
assert.equal(preUpgrade.afterReload.runtime.version, summary.upgrade.from);
assert.equal(preUpgrade.afterReload.update.status, "ready");
assert.equal(preUpgrade.afterReload.update.releaseId, releaseId);
assert.equal(postUpgrade.afterReload.runtime.version, version);
assert.equal(postUpgrade.afterReload.update.status, "up-to-date");
assert.equal(postUpgrade.afterReload.update.currentReleaseId, releaseId);

assert.equal(registration.schemaVersion, 1);
assert.equal(registration.passed, true);
assert.ok(Object.values(registration.checks).every((value) => value === true));
assert.equal(registration.links.length, summary.registration.shortcutCount);
assert.ok(
  registration.links.every(
    (link) =>
      link.exists === true &&
      link.appUserModelId === summary.registration.appUserModelId &&
      link.toastActivatorClsid === summary.registration.toastActivatorClsid,
  ),
);
assert.equal(registration.legacy.rootExists, false);
assert.equal(registration.legacy.nestedExists, false);
assert.equal(registration.uninstall.displayVersion, version);
assert.equal(registration.clsid.value, summary.registration.toastActivatorClsid);
assert.equal(registration.clsid.view64Exit, 0);
assert.equal(registration.clsid.view32Exit, 1);
assert.equal(registration.authenticode.status, "NotSigned");
assert.equal(registration.authenticode.signer, null);
assert.equal(registration.authenticode.timestamper, null);
assert.deepEqual(summary.authenticode, {
  required: true,
  status: "fail",
  observed: "NotSigned",
  signer: null,
  timestamper: null,
  completionImpact: "blocks_agent_scope_completion",
});

assert.equal(notification.schemaVersion, 1);
assert.equal(notification.runId, summary.notification.runId);
assert.equal(notification.instanceId, "qa-hub-preview-v21-e2e-fresh-0910");
assert.equal(notification.releaseProvenance.releaseId, releaseId);
assert.equal(notification.releaseProvenance.version, version);
assert.equal(notification.releaseProvenance.sourceCommit, sourceCommit);
assert.equal(notification.releaseProvenance.sourceDirty, false);
assert.equal(notification.releaseProvenance.appAsarSha256, installedAsarSha256);
assert.equal(notification.releaseProvenance.releaseAttestation.attestationValid, true);
assert.equal(notification.passed, false);
assert.equal(Object.hasOwn(notification, "cleanupError"), false);
assert.equal(Object.hasOwn(notification, "sessionPreflightCleanupError"), false);
assert.equal(Object.hasOwn(notification, "finalizationError"), false);
assert.deepEqual(notification.fixtures, {});
assert.equal(notification.requests.length, 1);
assert.deepEqual(notification.requests[0], {
  label: "read-only readiness before any business write",
  method: "GET",
  path: "/api/v1/health/ready",
  projectId: null,
  request: null,
  at: notification.requests[0].at,
  status: 200,
  responseSha256: notification.requests[0].responseSha256,
  response: notification.requests[0].response,
});
assert.equal(notification.requests[0].response.status, "ready");
assert.equal(notification.requests[0].response.schemaVersion, "20");
assert.ok(notification.requests.every((request) => request.method === "GET"));
assert.equal(notification.sessionPreflight.environmentOnly, true);
assert.equal(notification.sessionPreflight.productPass, false);
assert.equal(notification.sessionPreflight.status, "blocked");
assert.equal(notification.sessionPreflight.error, "WINDOWS_TOAST_SESSION_MISMATCH");
assert.deepEqual(notification.error, {
  name: "Error",
  code: "WINDOWS_TOAST_SESSION_MISMATCH",
  classification: "environment_blocker",
  message: "WINDOWS_TOAST_SESSION_MISMATCH",
  details: null,
});
assert.equal(notification.checks.length, 39);
assert.ok(notification.checks.every((check) => check.passed === true));
const notificationChecks = new Map(notification.checks.map((check) => [check.label, check]));
assert.equal(notificationChecks.size, notification.checks.length);
for (const check of notification.checks) {
  assert.equal(Object.hasOwn(check, "actual"), true, `${check.label}: missing actual`);
  assert.equal(Object.hasOwn(check, "expected"), true, `${check.label}: missing expected`);
  assert.deepEqual(check.actual, check.expected, `${check.label}: actual/expected mismatch`);
}
for (const label of [
  "canonical inputs unchanged before preparation",
  "quit-probe canonical inputs unchanged before launch",
  "instance and installed preview inputs unchanged",
]) {
  assert.deepEqual(notificationChecks.get(label)?.actual, notification.inputFingerprints, label);
}
assert.deepEqual(notification.ports, { mcp: 57500, cdp: 57501, inspector: 57502 });
assert.equal(notification.watchers[0].ready.appSessionId, 2);
assert.equal(notification.watchers[0].ready.observerSessionId, 2);
assert.equal(notification.watchers[0].ready.activeConsoleSessionId, 1);
assert.equal(notification.wpn.length, 1);
assert.equal(notification.wpn[0].destinationSessionId, 1);
assert.deepEqual(notification.sourceAttributionAfter.trackedChanges, []);
assert.deepEqual(notification.sourceAttributionAfter.unexpectedUntracked, []);
assert.equal(notification.sourceAttributionAfter.head, sourceCommit);
assert.equal(notification.sourceAttributionAfter.allowedUntrackedFiles, 9);
assert.equal(notification.releaseProvenance.sourceCommit, notification.sourceAttributionAfter.head);
assert.equal(notification.network.length, 1);
assert.equal(notification.network[0].method, "GET");
assert.equal(
  notification.network[0].url,
  "qa-hub-preview-v21-e2e-fresh-0910://app/api/v1/auth/me",
);
assert.equal(notification.processes.length, 2);
assert.equal(notification.processes[0].phase, "quit-probe_launch");
assert.equal(notification.processes[1].phase, "final-cleanup_quit");
assert.equal(notification.processes[1].exitCode, 0);
assert.equal(notification.processes[1].pid, notification.processes[0].pid);

const rawSubmit = notificationRaw["session-preflight-native-submit.json"];
const rawClose = notificationRaw["session-preflight-native-close.json"];
const rawReady = notificationRaw["session-preflight-toast-ready.json"];
const rawBoundary = notificationRaw["session-preflight-wpn-boundary.json"];
const rawEvents = notificationRaw["session-preflight-wpn-events.json"];
const rawQuery = notificationRaw["session-preflight-wpn-query-002.json"];
const rawCorrelation = notificationRaw["session-preflight-wpn-correlation.json"];
assert.deepEqual(notification.watchers, [
  { label: "session-preflight", mode: "observe", ready: rawReady },
]);
assert.equal(rawSubmit.pid, notification.processes[0].pid);
assert.equal(rawSubmit.supported, true);
assert.equal(rawSubmit.submitted, true);
assert.equal(rawSubmit.notificationId, notification.sessionPreflight.notificationId);
assert.deepEqual(rawClose, { pid: notification.processes[0].pid, closed: true });
assert.deepEqual(rawCorrelation.boundary, rawBoundary);
assert.deepEqual(rawCorrelation.snapshot, rawEvents);
assert.deepEqual(rawQuery, rawEvents);
assert.deepEqual(rawCorrelation.watcherReady, rawReady);
const { label: embeddedWpnLabel, ...embeddedWpn } = notification.wpn[0];
assert.equal(embeddedWpnLabel, "session-preflight");
assert.deepEqual(embeddedWpn, rawCorrelation.correlation);
assert.equal(rawBoundary.newestRecordId, 73495);
assert.deepEqual(
  rawEvents.events.map((event) => ({ eventId: event.eventId, recordId: event.recordId })),
  [
    { eventId: 2418, recordId: 73497 },
    { eventId: 3052, recordId: 73498 },
    { eventId: 3153, recordId: 73499 },
  ],
);
assert.ok(rawEvents.events.every((event) => event.recordId > rawBoundary.newestRecordId));
assert.ok(rawEvents.events.every((event) => event.trackingId === rawCorrelation.correlation.trackingId));
assert.equal(rawEvents.events[1].messageId, rawCorrelation.correlation.messageId);
assert.equal(rawEvents.events[2].messageId, rawCorrelation.correlation.messageId);
assert.equal(rawCorrelation.correlation.destinationSessionId, 1);
assert.equal(rawReady.appSessionId, 2);
assert.equal(rawReady.observerSessionId, 2);
assert.equal(rawReady.activeConsoleSessionId, 1);

const hostBefore = structuredClone(notificationRaw["host-before.json"]);
const hostAfter = structuredClone(notificationRaw["host-after.json"]);
assert.deepEqual(notification.hostAfter, notificationRaw["host-after.json"]);
assert.equal(hostBefore.sessionId, 2);
assert.equal(hostAfter.sessionId, 2);
delete hostBefore.capturedAt;
delete hostAfter.capturedAt;
assert.deepEqual(hostAfter, hostBefore);
for (const port of Object.values(notification.ports)) {
  assert.equal(hostBefore.listeners.find((listener) => listener.port === port)?.listening, false);
  assert.equal(hostAfter.listeners.find((listener) => listener.port === port)?.listening, false);
  assert.deepEqual(notificationChecks.get(`final own port ${port} released`), {
    ...notificationChecks.get(`final own port ${port} released`),
    passed: true,
    actual: 0,
    expected: 0,
  });
}
assert.equal(
  notificationChecks.get("final-cleanup graceful quit acknowledged")?.actual,
  "OWN_APP_QUIT_SCHEDULED",
);
assert.equal(notificationChecks.get("final-cleanup exact child exited")?.actual, true);
assert.equal(notificationChecks.get("final-cleanup exit code")?.actual, 0);
assert.equal(notificationChecks.get("installed canonical EXE absent after final cleanup")?.actual, 0);
assert.deepEqual(summary.notification, {
  gateId: "desktop-notification-project-route-live",
  runId: notification.runId,
  status: "fail",
  classification: "environment_blocker",
  environmentOnly: true,
  productPass: false,
  errorCode: "WINDOWS_TOAST_SESSION_MISMATCH",
  runnerSessionId: 2,
  activeConsoleSessionId: 1,
  wpnDestinationSessionId: 1,
  businessFixturesCreated: 0,
  businessWriteRequests: 0,
  readOnlyReadinessRequests: 1,
  allRecordedChecksPassed: true,
  recordedCheckCount: 39,
  completionImpact: "blocks_agent_scope_completion",
});

assert.equal(summary.userOnlyGates.length, 6);
assert.deepEqual(
  summary.userOnlyGates.map((gate) => gate.id),
  delegatedIds,
);
for (const gate of summary.userOnlyGates) {
  assert.deepEqual(gate, {
    id: gate.id,
    status: "not_run",
    owner: "user",
    handoffStatus: "delegated_pending",
    agentExecuted: false,
    completionImpact: "blocks_final_acceptance",
    resultLabel: userLabel,
  });
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      validationScope: "postfix_fd0f0f8_release_upgrade_registration_notification",
      passed: true,
      productSourceCommit: sourceCommit,
      releaseId,
      version,
      packagePublicationPassed: true,
      installedUpgradePassed: true,
      registrationPassed: true,
      authenticode: summary.authenticode,
      notification: summary.notification,
      delegatedUserGates: summary.userOnlyGates.length,
      overallStatus: summary.overallStatus,
      completionAllowed: summary.completionAllowed,
    },
    null,
    2,
  ),
);
