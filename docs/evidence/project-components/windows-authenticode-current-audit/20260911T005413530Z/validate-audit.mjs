import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const auditPath = resolve(here, "audit.json");
const audit = JSON.parse(readFileSync(auditPath, "utf8"));
const expectedRoles = ["installer", "main", "updater", "uninstaller"];
const expectedHashes = {
  installer: "e0e68a626657f4431447764d96f0cf95ded8b6b081c8b13f809ccacd252e7e41",
  main: "47e3d83120f29a6b2e0dc1fa54a2de6327c15c21620999b421b615a346e1fbac",
  updater: "1e0ec8e4f74d9dbfca43639f90bb677d0e4d7df817a13331d0beef6c8affef28",
  uninstaller: "d5b8e3216da3eca98d1e21b388b6dfe020177223ca12424abadc375ede34bf7b",
};
const checks = [];
const check = (label, operation) => {
  operation();
  checks.push(label);
};

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

check("audit identity", () => {
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.auditType, "windows_authenticode_current_state");
  assert.match(audit.capturedAtUtc, /^2026-09-11T/u);
  assert.equal(audit.source.repository, "Relay-QA-Hub");
  assert.match(audit.source.head, /^[0-9a-f]{40}$/u);
});
check("audit source remains in current history", () => {
  assert.doesNotThrow(() =>
    execFileSync("git.exe", ["merge-base", "--is-ancestor", audit.source.head, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    }),
  );
});
check("capture was read-only", () => {
  for (const key of [
    "productExecuted",
    "artifactModified",
    "certificateCreated",
    "certificateStoreModified",
    "privateKeyReadOrExported",
    "secretEnvironmentValuesRecorded",
    "repackaged",
  ])
    assert.equal(audit.safety[key], false, `${key} must be false`);
});
check("no usable trusted code-signing identity was found", () => {
  assert.equal(audit.certificateAudit.acceptableTrustedCodeSigningIdentityCount, 0);
  assert(
    audit.certificateAudit.standardPersonalStores.every(
      (store) => store.currentlyValidTrustedPrivateKeyCandidates === 0,
    ),
  );
  assert.equal(audit.signingConfiguration.matchingEnvironmentVariableCount, 0);
  assert.deepEqual(audit.signingConfiguration.matchingEnvironmentVariableNames, []);
  assert.equal(audit.signingConfiguration.environmentVariableValuesInspectedOrRecorded, false);
  assert.equal(audit.signingConfiguration.repositoryCredentialFileCount, 0);
  assert.deepEqual(audit.signingConfiguration.repositoryCredentialFiles, []);
});
check("Microsoft SignTool exists but is not the blocker", () => {
  const tool = audit.tooling.vendoredMicrosoftSignedSignTool;
  assert.equal(tool.sha256, "a36f5e81ce208137acc8fa9c00547c020fa10f044583002ccd23799b7f64078e");
  assert.equal(statSync(tool.path).size, tool.bytes);
  assert.equal(tool.authenticodeStatus, "Valid");
  assert.equal(tool.companyName, "Microsoft Corporation");
  assert.equal(tool.capabilities.fileDigest, true);
  assert.equal(tool.capabilities.rfc3161Timestamp, true);
  assert.equal(tool.capabilities.timestampDigest, true);
  assert.equal(tool.capabilities.certificateThumbprintSelection, true);
});
check("four required artifact roles are present exactly once", () => {
  assert.deepEqual(audit.artifacts.map((artifact) => artifact.role), expectedRoles);
  assert.equal(new Set(audit.artifacts.map((artifact) => artifact.path)).size, expectedRoles.length);
});

for (const artifact of audit.artifacts) {
  check(`${artifact.role} artifact bytes and hash`, () => {
    assert.equal(artifact.exists, true);
    assert.equal(statSync(artifact.path).size, artifact.bytes);
    assert.equal(artifact.sha256, expectedHashes[artifact.role]);
  });
  assert.equal(await sha256(artifact.path), artifact.sha256, `${artifact.role} hash changed`);
  check(`${artifact.role} recorded Authenticode failure`, () => {
    assert.equal(artifact.getAuthenticodeSignature.status, "NotSigned");
    assert.equal(artifact.getAuthenticodeSignature.signerSubject, null);
    assert.equal(artifact.getAuthenticodeSignature.signerThumbprint, null);
    assert.equal(artifact.getAuthenticodeSignature.timestamperSubject, null);
    assert.equal(artifact.signToolVerify.policy, "/pa");
    assert.equal(artifact.signToolVerify.allSignatures, true);
    assert.equal(artifact.signToolVerify.exitCode, 1);
    assert.equal(artifact.signToolVerify.noSignatureFound, true);
  });
}

check("current artifacts are byte-identical to the recorded signature audit", () => {
  assert(
    audit.artifacts.every(
      (artifact) =>
        artifact.getAuthenticodeSignature.status === "NotSigned" &&
        artifact.getAuthenticodeSignature.signerSubject === null &&
        artifact.getAuthenticodeSignature.timestamperSubject === null,
    ),
  );
});
check("blocker conclusion is fail-closed", () => {
  assert.equal(audit.conclusion.existingTrustedCodeSigningMaterialUsable, false);
  assert.equal(audit.conclusion.requiresUserOrCaProvidedExternalSigningIdentity, true);
  assert.equal(audit.conclusion.blockerCode, "TRUSTED_CODE_SIGNING_IDENTITY_MISSING");
  assert.equal(audit.conclusion.toolingBlocker, false);
  assert.equal(audit.conclusion.artifactStatus, "all_required_windows_executables_not_signed");
  assert.equal(audit.conclusion.currentArtifactsMayBeSignedInPlace, false);
  assert.equal(audit.missingMaterials.length, 4);
  assert(audit.nextFailClosedGates.length >= 7);
});

console.log(
  JSON.stringify({
    passed: true,
    checks: checks.length,
    artifacts: audit.artifacts.map((artifact) => ({
      role: artifact.role,
      sha256: artifact.sha256,
      authenticodeStatus: artifact.getAuthenticodeSignature.status,
    })),
    trustedCodeSigningIdentityCount:
      audit.certificateAudit.acceptableTrustedCodeSigningIdentityCount,
    blockerCode: audit.conclusion.blockerCode,
    toolingBlocker: audit.conclusion.toolingBlocker,
    trialReleaseRequirementEstablishedByV21: false,
    distributionLimitationRecorded: true,
  }),
);
