import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceDirectory = dirname(fileURLToPath(import.meta.url));
const auditPath = join(evidenceDirectory, 'current-session-wpn-routing.json');
const validationPath = join(evidenceDirectory, 'validation.json');
const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const validation = JSON.parse(readFileSync(validationPath, 'utf8'));
const checks = [];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(id, evaluate) {
  try {
    const details = evaluate();
    const passed = details === true || details?.passed === true;
    checks.push({ id, passed, ...(details === true ? {} : details) });
  } catch (error) {
    checks.push({ id, passed: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function sameMembers(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function allTrue(object, keys) {
  return keys.every((key) => object[key] === true);
}

function chainIsExact(chain, expectedSessionId) {
  return (
    chain?.valid === true &&
    chain.destinationSessionId === expectedSessionId &&
    Number.isSafeInteger(chain.acceptedRecordId) &&
    Number.isSafeInteger(chain.deliveredRecordId) &&
    Number.isSafeInteger(chain.presentedRecordId) &&
    chain.acceptedRecordId < chain.deliveredRecordId &&
    chain.deliveredRecordId < chain.presentedRecordId &&
    typeof chain.trackingId === 'string' &&
    chain.trackingId.length > 0 &&
    /^\{[0-9a-f-]{36}\}$/i.test(chain.messageId)
  );
}

function collectForbiddenJsonKeys(value, at = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectForbiddenJsonKeys(entry, `${at}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const forbidden = /^(?:password|passwd|authorization|cookie|credential|accessToken|refreshToken|clientSecret|apiKey|privateKey|commandLine|environment)$/i;
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.test(key)) found.push(`${at}.${key}`);
    collectForbiddenJsonKeys(entry, `${at}.${key}`, found);
  }
  return found;
}

record('validation-manifest-shape', () => ({
  passed:
    validation.schemaVersion === 1 &&
    validation.kind === 'windows-notification-session-current-audit-validation' &&
    validation.verdict?.status === 'pass' &&
    validation.verdict?.productPass === false &&
    Object.values(validation.validations ?? {}).length === 11 &&
    Object.values(validation.validations).every((value) => value === true) &&
    Array.isArray(validation.trackedArtifacts),
}));

record('publication-private-exact-scan-result', () => ({
  passed:
    validation.privateExactScan?.performed === true &&
    validation.privateExactScan.rawIdentityCandidateCount === 3 &&
    validation.privateExactScan.rawAbsolutePathCandidateCount === 11 &&
    validation.privateExactScan.canonicalSecretValueCount === 3 &&
    validation.privateExactScan.exactHits?.length === 0 &&
    validation.privateExactScan.passed === true,
}));

record('tracked-directory-inventory-complete', () => {
  const declared = validation.trackedArtifacts.map((entry) => entry.path);
  const expected = [...declared, 'validation.json'];
  const actual = readdirSync(evidenceDirectory).filter((name) => statSync(join(evidenceDirectory, name)).isFile());
  return { passed: sameMembers(actual, expected), actual, expected };
});

record('tracked-artifact-fingerprints', () => {
  const mismatches = [];
  for (const entry of validation.trackedArtifacts) {
    if (basename(entry.path) !== entry.path || entry.path.includes('..')) {
      mismatches.push({ path: entry.path, reason: 'non-local manifest path' });
      continue;
    }
    const bytes = readFileSync(join(evidenceDirectory, entry.path));
    const actual = { bytes: bytes.length, sha256: sha256(bytes) };
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      mismatches.push({ path: entry.path, expected: entry, actual });
    }
  }
  return { passed: mismatches.length === 0, mismatches };
});

record('audit-schema-and-redaction-profile', () => ({
  passed:
    audit.schemaVersion === 2 &&
    audit.kind === 'windows-notification-session-routing-readonly-sanitized-audit' &&
    audit.redaction?.profile === 'local-identity-and-paths-v1' &&
    audit.redaction?.transformation === 'allowlisted-field-copy' &&
    allTrue(audit.redaction, [
      'rawUserNameDomainAndClientNameOmitted',
      'absolutePathsOmitted',
      'processCommandLinesOmitted',
      'proofErrorMessageAndDetailsOmitted',
    ]),
}));

record('source-capture-fingerprints-preserved', () => ({
  passed:
    audit.sourceCapture?.rawAudit?.bytes === 20399 &&
    audit.sourceCapture?.rawAudit?.sha256 ===
      '7247e02728ca6cbe9eaf7153809b2535bf8ba265b5788fac494c73bdedf96a16' &&
    audit.sourceCapture?.rawAudit?.tracked === false &&
    audit.sourceCapture?.rawCaptureScript?.bytes === 19443 &&
    audit.sourceCapture?.rawCaptureScript?.sha256 ===
      'ef66e79b1561781499afd6a89724a47520b83d78a20f9c5b61d846d442d9f70c' &&
    audit.sourceCapture?.rawCaptureScript?.tracked === false,
}));

record('proof-anchor-file-fingerprint', () => {
  const expectedTail =
    'desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json';
  if (audit.proofAnchor?.fingerprint?.pathTail !== expectedTail) return { passed: false };
  const proofPath = resolve(evidenceDirectory, '..', '..', ...expectedTail.split('/'));
  const proofBytes = readFileSync(proofPath);
  return {
    passed:
      proofBytes.length === audit.proofAnchor.fingerprint.bytes &&
      sha256(proofBytes) === audit.proofAnchor.fingerprint.sha256 &&
      audit.proofAnchor.fingerprint.sha256 ===
        '1c571b31b9152a653ad1ce25ab6fb7c80a1be7735cb01207c6fe61cf3751db3d',
    proofPath: expectedTail,
  };
});

record('proof-anchor-remains-fail-closed', () => ({
  passed:
    audit.proofAnchor.runId === '81c44b26-5c6f-47c6-a56a-d4eb27f19d7a' &&
    audit.proofAnchor.version === '0.2.0-preview.20' &&
    audit.proofAnchor.sourceCommit === 'fd0f0f850f907b8a77aac8ec8b6a71b308bdd711' &&
    audit.proofAnchor.passed === false &&
    audit.proofAnchor.error?.code === 'WINDOWS_TOAST_SESSION_MISMATCH' &&
    audit.proofAnchor.error?.classification === 'environment_blocker' &&
    audit.proofAnchor.sessionPreflight?.environmentOnly === true &&
    audit.proofAnchor.sessionPreflight?.productPass === false,
}));

record('proof-anchor-app-observer-session-facts', () => {
  const ready = audit.proofAnchor.watcherReady;
  return {
    passed:
      ready?.ready === true &&
      ready.observerSessionId === 2 &&
      ready.appSessionId === 2 &&
      ready.activeConsoleSessionId === 1 &&
      ready.explorer?.some((entry) => entry.sessionId === 2 && entry.name === 'explorer.exe') &&
      ready.shellExperienceHost?.some(
        (entry) => entry.sessionId === 2 && entry.name === 'ShellExperienceHost.exe',
      ),
  };
});

record('proof-anchor-wpn-chain-exact', () => {
  const correlation = audit.proofAnchor.wpnCorrelation;
  const events = correlation?.[0]?.events;
  const accepted = events?.[0];
  const delivered = events?.[1];
  const presented = events?.[2];
  return {
    passed:
      correlation?.length === 1 &&
      correlation[0].destinationSessionId === 1 &&
      events?.length === 3 &&
      accepted.eventId === 2418 &&
      delivered.eventId === 3052 &&
      presented.eventId === 3153 &&
      accepted.recordId < delivered.recordId &&
      delivered.recordId < presented.recordId &&
      delivered.sessionId === 1 &&
      presented.sessionId === 1 &&
      delivered.messageId === presented.messageId &&
      events.every(
        (event) =>
          event.appUserModelId === audit.target.appUserModelId &&
          event.trackingId === correlation[0].trackingId,
      ),
  };
});

record('capture-performed-no-product-or-session-actions', () => ({
  passed:
    audit.capture.notificationsSubmitted === 0 &&
    audit.capture.productActionsPerformed?.length === 0 &&
    audit.capture.sessionActionsPerformed?.length === 0 &&
    audit.capture.serviceActionsPerformed?.length === 0 &&
    audit.capture.productProcessesStartedOrStopped?.length === 0 &&
    sameMembers(audit.capture.readOnlyQueries, [
      'WTSEnumerateSessionsW',
      'WTSQuerySessionInformationW',
      'WTSGetActiveConsoleSessionId',
      'Win32_Process',
      'Win32_Service',
      'Get-WinEvent',
    ]),
}));

record('current-session-topology-exact', () => {
  const topology = audit.currentSessionTopology;
  const sessions = new Map(topology.sessions.map((entry) => [entry.sessionId, entry]));
  const processIn = (name, sessionId) =>
    topology.selectedProcesses.some((entry) => entry.name === name && entry.sessionId === sessionId);
  return {
    passed:
      topology.runnerSessionId === 2 &&
      topology.activeConsoleSessionId === 1 &&
      sessions.get(1)?.stateName === 'Connected' &&
      sessions.get(1)?.hasLoggedOnUser === false &&
      sessions.get(1)?.protocolName === 'Console' &&
      sessions.get(2)?.stateName === 'Active' &&
      sessions.get(2)?.hasLoggedOnUser === true &&
      sessions.get(2)?.protocolName === 'RDP' &&
      processIn('LogonUI.exe', 1) &&
      !processIn('explorer.exe', 1) &&
      !processIn('ShellExperienceHost.exe', 1) &&
      processIn('explorer.exe', 2) &&
      processIn('ShellExperienceHost.exe', 2),
  };
});

record('current-target-and-wpn-service-session-facts', () => ({
  passed:
    audit.target.preExistingAtCapture === true &&
    audit.target.observedProcesses.length === 4 &&
    audit.target.observedProcesses.some((entry) => entry.pid === 22020) &&
    audit.target.observedProcesses.every((entry) => entry.sessionId === 2) &&
    audit.currentSessionTopology.wpnUserServices.length === 1 &&
    audit.currentSessionTopology.wpnUserServices.every(
      (entry) => entry.serviceFamily === 'WpnUserService_*' && entry.sessionId === 2,
    ),
}));

record('current-wpn-chain-counts-and-samples-exact', () => {
  const wpn = audit.currentWpnAudit;
  const counts = wpn.destinationSessionCounts;
  const samples = [wpn.firstRetainedChain, wpn.lastRetainedChain, ...wpn.lastFiveCompleteChains];
  return {
    passed:
      wpn.logName === 'Microsoft-Windows-PushNotification-Platform/Operational' &&
      wpn.retainedEventCount === 825 &&
      wpn.eventCounts.accepted2418 === 275 &&
      wpn.eventCounts.delivered3052 === 275 &&
      wpn.eventCounts.presented3153 === 275 &&
      wpn.completeChainCount === 275 &&
      wpn.invalidChainCount === 0 &&
      counts.length === 1 &&
      counts[0].sessionId === 1 &&
      counts[0].count === 275 &&
      counts.reduce((sum, entry) => sum + entry.count, 0) === wpn.completeChainCount &&
      wpn.lastFiveCompleteChains.length === 5 &&
      samples.every((chain) => chainIsExact(chain, 1)),
  };
});

record('fail-closed-assertions-and-conclusion', () => ({
  passed:
    audit.assertions.runnerSessionHasLoggedOnUser === true &&
    audit.assertions.runnerSessionHasExplorerAndShellExperienceHost === true &&
    audit.assertions.activeConsoleSessionHasLoggedOnUser === false &&
    audit.assertions.activeConsoleSessionHasExplorerAndShellExperienceHost === false &&
    audit.assertions.activeConsoleSessionHasLogonUi === true &&
    audit.assertions.targetExecutableProcessesOnlyInRunnerSession === true &&
    audit.assertions.wpnCompleteChainsPresent === true &&
    audit.assertions.allWpnDestinationsEqualActiveConsoleSession === true &&
    audit.assertions.allWpnDestinationsEqualRunnerSession === false &&
    audit.assertions.appObserverWpnSameSessionGateReady === false &&
    audit.conclusion.status === 'environment_blocker' &&
    audit.conclusion.productPass === false &&
    audit.conclusion.code === 'WINDOWS_TOAST_SESSION_MISMATCH' &&
    audit.conclusion.supportedPerToastTerminalSessionOverrideFound === false &&
    audit.conclusion.supportedPerToastTerminalSessionOverrideFindingIsInference === true &&
    audit.conclusion.safeAutomaticRemediationUnderCurrentConstraints === false,
}));

record('safe-retest-prerequisites-preserved', () => ({
  passed:
    audit.safeRetestPrerequisites?.length === 4 &&
    audit.safeRetestPrerequisites.some((entry) =>
      entry.includes('installed EXE, native submit, and UIAutomation observer'),
    ) &&
    audit.safeRetestPrerequisites.some((entry) => entry.includes('3052 and 3153 SessionId')) &&
    audit.safeRetestPrerequisites.some((entry) =>
      entry.includes('do not switch, disconnect, log off, or restart'),
    ) &&
    audit.safeRetestPrerequisites.some((entry) =>
      entry.includes('leave production and daily EXEs untouched'),
    ),
}));

record('json-sensitive-value-slots-absent', () => {
  const findings = [
    ...collectForbiddenJsonKeys(audit),
    ...collectForbiddenJsonKeys(validation),
  ];
  return { passed: findings.length === 0, findings };
});

record('tracked-text-secret-and-absolute-path-scan', () => {
  const files = [...validation.trackedArtifacts.map((entry) => entry.path), 'validation.json'];
  const findings = [];
  const valuePatterns = [
    {
      id: 'absolute-drive-path',
      pattern: /(?:^|[^A-Za-z])[A-Za-z]:[\\/](?![\\/])/m,
    },
    { id: 'absolute-user-path', pattern: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/i },
    { id: 'unc-path', pattern: /(?:^|[\s"'`])\\\\[^\\\s]+\\[^\s"']+/m },
    { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
    { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/ },
    { id: 'known-token-prefix', pattern: /\b(?:ghp_|github_pat_|xox[baprs]-|AKIA|ASIA|sk-)[A-Za-z0-9_-]{12,}\b/ },
    { id: 'authorization-value', pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i },
    { id: 'url-userinfo', pattern: /https?:\/\/[^/\s:@]+:[^@\s/]+@/i },
  ];
  for (const file of files) {
    const text = readFileSync(join(evidenceDirectory, file), 'utf8');
    for (const { id, pattern } of valuePatterns) {
      if (pattern.test(text)) findings.push({ file, id });
    }
  }
  return { passed: findings.length === 0, findings };
});

const failures = checks.filter((check) => !check.passed);
const result = {
  schemaVersion: 1,
  kind: 'windows-notification-session-current-audit-offline-validation-result',
  passed: failures.length === 0,
  checkCount: checks.length,
  failureCount: failures.length,
  checks,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
