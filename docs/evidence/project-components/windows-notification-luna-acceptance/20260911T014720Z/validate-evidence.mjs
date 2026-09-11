import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const attemptPath = join(directory, "luna-acceptance-attempt.json");
const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
const root = resolve(directory, "..", "..");
const checks = [];
const check = (id, passed, details = {}) => checks.push({ id, passed, ...details });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

check("schema", attempt.schemaVersion === 1 && attempt.kind === "windows-notification-luna-acceptance-attempt");
check("scope", attempt.scope.version === "0.2.0-preview.20" && attempt.scope.sourceCommit === "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711" && attempt.scope.installedAppPid === 22020 && attempt.scope.desktopMcpPort === 4642 && attempt.scope.cdpPort === 9433);
check("no-product-action", attempt.actions.runnerStarted === false && attempt.actions.notificationsSubmitted === 0 && attempt.actions.nativeToastObserved === false && attempt.actions.nativeToastClicked === false && attempt.actions.projectDetailReadback === false && attempt.actions.projectApiReadback === false && attempt.actions.sessionActions.length === 0 && attempt.actions.productionOrDailyActions.length === 0);
check("current-process-session", attempt.observations.installedPreviewProcesses.length === 4 && attempt.observations.installedPreviewProcesses.every((entry) => entry.sessionId === 2) && attempt.observations.installedPreviewProcesses.some((entry) => entry.pid === 22020));
check("current-wpn-session-gate", attempt.observations.currentSessionAudit.runnerSessionId === 2 && attempt.observations.currentSessionAudit.activeConsoleSessionId === 1 && attempt.observations.currentSessionAudit.wpnCompleteChainCount === 275 && attempt.observations.currentSessionAudit.wpnDestinationSessionCounts.length === 1 && attempt.observations.currentSessionAudit.wpnDestinationSessionCounts[0].sessionId === 1 && attempt.observations.currentSessionAudit.appObserverWpnSameSessionGateReady === false);
check("fail-closed-verdict", attempt.verdict.status === "environment_blocker" && attempt.verdict.productPass === false && attempt.verdict.code === "WINDOWS_TOAST_SESSION_MISMATCH" && attempt.verdict.repeatObservationSuppressed === true && attempt.verdict.finalMatrixModified === false);
check("minimum-conditions", attempt.minimumRetestConditions.length === 3 && attempt.minimumRetestConditions.every((entry) => typeof entry === "string" && entry.length > 20));

const runnerProof = resolve(root, "desktop-notification-project-route-live", "81c44b26-5c6f-47c6-a56a-d4eb27f19d7a", "proof.json");
const sessionAudit = resolve(root, "windows-notification-session-current-audit", "20260911T005709Z", "current-session-wpn-routing.json");
const runnerBytes = readFileSync(runnerProof);
const sessionBytes = readFileSync(sessionAudit);
check("runner-proof-anchor", runnerBytes.length === attempt.evidenceAnchors.runnerProof.bytes && sha256(runnerBytes) === attempt.evidenceAnchors.runnerProof.sha256);
check("session-audit-anchor", sessionBytes.length === attempt.evidenceAnchors.sessionAudit.bytes && sha256(sessionBytes) === attempt.evidenceAnchors.sessionAudit.sha256);

const failures = checks.filter((entry) => !entry.passed);
const result = { schemaVersion: 1, kind: "windows-notification-luna-acceptance-validation", passed: failures.length === 0, checkCount: checks.length, failureCount: failures.length, checks };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
