import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const sourceCommit = "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b";

async function evidence(name, assertions) {
  const bytes = await readFile(new URL(name, root));
  const text = bytes.toString("utf8");
  for (const pattern of assertions) assert.match(text, pattern, `${name}: ${pattern}`);
  return {
    file: name,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const storage = await evidence("storage-tests.tap.txt", [
  /tests 167/u,
  /pass 166/u,
  /fail 0/u,
  /skipped 1/u,
]);
const apiJavaScript = await evidence("api-js-tests.tap.txt", [
  /tests 274/u,
  /pass 274/u,
  /fail 0/u,
]);
const apiTypeScript = await evidence("api-ts-tests.tap.txt", [
  /tests 47/u,
  /pass 47/u,
  /fail 0/u,
]);
const contractChecks = await evidence("contract-checks.txt", [
  /Contract check passed: 9 schemas/u,
  /Breaking-change check passed: 24 frozen contract/u,
  /App-first contract check passed:/u,
  /Additive compatibility passed:/u,
  /Breaking-change check passed: 13 versioned files/u,
  /EXIT 0/u,
]);
const retainedConcurrentFailure = await evidence("api-js-tests.concurrent-first-failure.tap.txt", [
  /tests 274/u,
  /pass 273/u,
  /fail 1/u,
  /real server supervisor records the worker result after the API closes/u,
]);
const androidFull = await evidence(
  "../android/acceptance/android-code28-self-update/gradle-clean-test-lint-assemble.log",
  [/BUILD SUCCESSFUL in 2m 8s/u, /59 actionable tasks: 58 executed, 1 up-to-date/u],
);
const androidTargeted = await evidence(
  "../android/acceptance/android-code28-self-update/gradle-targeted-update-ui-tests.log",
  [/BUILD SUCCESSFUL in 40s/u, /32 actionable tasks: 32 executed/u],
);

const summary = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  sourceCommit,
  finalRuns: {
    storage: { tests: 167, passed: 166, failed: 0, skipped: 1, evidence: storage },
    apiJavaScript: { tests: 274, passed: 274, failed: 0, skipped: 0, evidence: apiJavaScript },
    apiTypeScript: { tests: 47, passed: 47, failed: 0, skipped: 0, evidence: apiTypeScript },
    contracts: { status: "passed", checks: 5, evidence: contractChecks },
    androidCleanUnitLintAssemble: { status: "passed", tasks: 59, evidence: androidFull },
    androidTargetedUpdateUi: { status: "passed", tasks: 32, evidence: androidTargeted },
  },
  retainedFirstFailure: {
    status: "retained",
    trigger: "API suite ran concurrently with the storage suite",
    observed: "one isolated uploader supervisor fixture did not load its expected test login cache",
    independentFullRerunPassed: true,
    evidence: retainedConcurrentFailure,
  },
  credentialsPersisted: false,
  passed: true,
};
await writeFile(new URL("summary.json", root), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
