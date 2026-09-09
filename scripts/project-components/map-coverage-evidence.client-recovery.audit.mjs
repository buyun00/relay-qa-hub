import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// Read-only acceptance of one frozen mapper/input pair. No filesystem writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error("Missing path for " + name);
  return path.resolve(process.argv[index + 1]);
};
const mapperPath = argument(
  "--mapper",
  path.join(root, "scripts/project-components/map-coverage-evidence.mjs"),
);
const actualMatrixPath = path.join(root, "docs/evidence/project-components/coverage-matrix.json");
const actualReviewPath = path.join(
  root,
  "docs/evidence/project-components/coverage-mapping-review.md",
);
const inputMatrixPath = argument("--input-matrix", actualMatrixPath);
const hash = (body) => createHash("sha256").update(body).digest("hex");
const expected = {
  mapper: "657d2ec8126435cb120623d900973d08b5e67bf73ec2ce11b2b47bf34f8179f6",
  inputMatrix: "aa09c534edb6d28454357ce90c0364ce7d2f7499f544320d8ca9a7002bd87bc7",
};
const mapperBytes = fs.readFileSync(mapperPath);
const inputBytes = fs.readFileSync(inputMatrixPath);
if (hash(mapperBytes) !== expected.mapper || hash(inputBytes) !== expected.inputMatrix)
  throw new Error(
    "Frozen mapper/input hash changed; provide the reviewed snapshots with --mapper/--input-matrix",
  );
const protectedBefore = Object.fromEntries(
  [mapperPath, actualMatrixPath, actualReviewPath].map((file) => [
    path.relative(root, file),
    hash(fs.readFileSync(file)),
  ]),
);
const source = mapperBytes
  .toString("utf8")
  .replace(/^import .*;\r?\n/gmu, "")
  .replaceAll(
    "import.meta.url",
    JSON.stringify(
      pathToFileURL(path.join(root, "scripts/project-components/map-coverage-evidence.mjs")).href,
    ),
  );
const original = JSON.parse(inputBytes);
class FixedDate extends Date {
  constructor(value = "2026-09-08T23:20:00.000Z") {
    super(value);
  }
  static now() {
    return new Date("2026-09-08T23:20:00.000Z").getTime();
  }
}
function run(input, executable = source, corruptPath = null) {
  const writes = new Map();
  const virtualFs = {
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
    readFileSync(file, encoding) {
      if (corruptPath && path.resolve(file) === corruptPath) {
        const altered = Buffer.concat([fs.readFileSync(file), Buffer.from(" ")]);
        return encoding ? altered.toString(encoding) : altered;
      }
      return path.resolve(file) === actualMatrixPath
        ? encoding
          ? JSON.stringify(input)
          : Buffer.from(JSON.stringify(input))
        : fs.readFileSync(file, encoding);
    },
    writeFileSync(file, body) {
      writes.set(path.resolve(file), String(body));
    },
  };
  try {
    new Function("fs", "path", "fileURLToPath", "createHash", "console", "Date", executable)(
      virtualFs,
      path,
      fileURLToPath,
      createHash,
      { log() {} },
      FixedDate,
    );
    return { matrix: JSON.parse(writes.get(actualMatrixPath)), writes };
  } catch (cause) {
    return { error: cause.message, writes };
  }
}
function differences(a, b, prefix = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return [prefix + ".length"];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      differences(a[key], b[key], prefix + "/" + key),
    );
  }
  return [prefix];
}
const base = (matrix, number) =>
  matrix.items.find(
    (item) => item.kind === "baseline" && Number(item.title.slice(0, 2)) === number,
  );
const retainedCount = (matrix) =>
  matrix.items.reduce((count, item) => count + (item.manual.retainedReviewNotes?.length ?? 0), 0);
const first = run(original);
if (first.error) throw new Error(first.error);
const second = run(first.matrix);
if (second.error) throw new Error(second.error);
const replayPaths = differences(first.matrix, second.matrix);
const expectedWrites = [actualMatrixPath, actualReviewPath];
const writeTargetsValid = [first, second].every(
  (entry) => entry.writes.size === 2 && expectedWrites.every((file) => entry.writes.has(file)),
);
const synthetic = structuredClone(original);
let failedSurfaces = 0;
for (const item of synthetic.items) {
  for (const surface of ["http", "server_mcp"]) {
    if (!item.results[surface]?.applicable) continue;
    failedSurfaces++;
    item.results[surface] = {
      ...item.results[surface],
      status: "failed",
      note: "manual-negative-note",
      actual: "manual-negative-actual",
      evidence: ["manual-negative-evidence"],
    };
    item.manual.surfaceProgress ??= {};
    item.manual.surfaceProgress[surface] = {
      completed: ["manual-positive-subset"],
      remaining: ["manual-negative-gap"],
      evidence: ["manual-progress-evidence"],
      status: "partial",
    };
    item.status = "failed";
  }
}
const negative = run(synthetic);
if (negative.error) throw new Error(negative.error);
const failedPaths = negative.matrix.items.flatMap((item, index) =>
  ["http", "server_mcp"]
    .filter((surface) => item.results[surface]?.applicable)
    .flatMap((surface) =>
      differences(
        synthetic.items[index].results[surface],
        item.results[surface],
        item.id + "/" + surface,
      ),
    ),
);
const failedProgressPaths = negative.matrix.items.flatMap((item, index) =>
  ["http", "server_mcp"]
    .filter((surface) => item.results[surface]?.applicable)
    .flatMap((surface) =>
      differences(
        synthetic.items[index].manual.surfaceProgress[surface],
        item.manual.surfaceProgress?.[surface],
        item.id + "/" + surface + "/progress",
      ),
    ),
);
const guard = ' || item.results[surface].status === "failed"';
if (source.split(guard).length !== 3)
  throw new Error("Guard regression control no longer matches exactly two central checks");
const guardDisabled = run(synthetic, source.replaceAll(guard, ""));
if (guardDisabled.error) throw new Error(guardDisabled.error);
const guardDisabledLosses = guardDisabled.matrix.items.flatMap((item) =>
  ["http", "server_mcp"]
    .filter(
      (surface) => item.results[surface]?.applicable && item.results[surface].status !== "failed",
    )
    .map((surface) => item.id + "/" + surface),
);
const oldNotes = original.items.flatMap((item) =>
  (item.manual.retainedReviewNotes ?? []).map((note) => ({ id: item.id, note })),
);
const missingNotes = oldNotes.filter(
  ({ id, note }) =>
    !first.matrix.items
      .find((item) => item.id === id)
      .manual.retainedReviewNotes.some(
        (retained) => JSON.stringify(retained) === JSON.stringify(note),
      ),
);
const fourPaths = [5, 6, 14].flatMap((number) =>
  (number === 14 ? ["apk", "exe", "local_mcp"] : ["apk", "exe", "web", "local_mcp"]).flatMap(
    (surface) =>
      differences(
        base(original, number).results[surface],
        base(first.matrix, number).results[surface],
        base(original, number).id + "/" + surface,
      ),
  ),
);
const flagPaths = original.items.flatMap((item, index) =>
  differences(
    {
      needsRevalidation: item.needsRevalidation,
      manualNeedsRevalidation: item.manual.needsRevalidation,
    },
    {
      needsRevalidation: first.matrix.items[index].needsRevalidation,
      manualNeedsRevalidation: first.matrix.items[index].manual.needsRevalidation,
    },
    item.id + "/flags",
  ),
);
const flagCount = original.items.filter(
  (item) => item.needsRevalidation || item.manual.needsRevalidation,
).length;
const manualInput = structuredClone(original);
const manualRow = base(manualInput, 1);
manualRow.results.http.note = "new manual note";
manualRow.results.http.actual = "new manual actual";
manualRow.manual.surfaceProgress ??= {};
manualRow.manual.surfaceProgress.http = {
  completed: ["manual completed"],
  remaining: ["manual remaining"],
  evidence: ["manual proof"],
  status: "partial",
};
const manualOutput = run(manualInput);
if (manualOutput.error) throw new Error(manualOutput.error);
const manualRetained = base(manualOutput.matrix, 1).manual.retainedReviewNotes.some(
  (note) =>
    note.note === "new manual note" &&
    note.actual === "new manual actual" &&
    note.progress?.remaining?.includes("manual remaining"),
);
const tampered = structuredClone(original);
const reviewedRow = tampered.items.find(
  (item) => Object.keys(item.manual.reviewedEvidence?.proofHashes ?? {}).length,
);
const changedProof = Object.keys(reviewedRow.manual.reviewedEvidence.proofHashes)[0];
reviewedRow.manual.reviewedEvidence.proofHashes[changedProof] = "0".repeat(64);
const rejected = run(tampered);

const referenceBytes = execFileSync(
  "git",
  ["show", "6b28723:scripts/project-components/map-coverage-evidence.mjs"],
  { cwd: root },
);
if (hash(referenceBytes) !== "19acf90afb515919b13258733578dd9a8bb4328d84e9b80b2b9e8d5d9527fca5")
  throw new Error("Historical mapper hash differs");
const referenceSource = referenceBytes
  .toString("utf8")
  .replace(/^import .*;\r?\n/gmu, "")
  .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(mapperPath).href));
const reference = run(original, referenceSource);
if (reference.error) throw new Error(reference.error);
const deltaPaths = first.matrix.items.flatMap((item, index) =>
  Object.keys(item.results).flatMap((surface) =>
    differences(
      reference.matrix.items[index].results[surface],
      item.results[surface],
      item.id + "/" + surface,
    ),
  ),
);
const allowedPrefix = base(original, 14).id + "/web/";
const unexpectedDeltaPaths = deltaPaths.filter((entry) => !entry.startsWith(allowedPrefix));
const fiveSurfacePaths = ["apk", "exe", "http", "server_mcp", "local_mcp"].flatMap((surface) =>
  differences(
    base(reference.matrix, 14).results[surface],
    base(first.matrix, 14).results[surface],
    "14/" + surface,
  ),
);
const webNegativeInput = structuredClone(original);
const webNegativeRow = base(webNegativeInput, 14);
webNegativeRow.results.web = {
  ...webNegativeRow.results.web,
  status: "failed",
  note: "existing Web failure",
  actual: "negative Web observation",
  evidence: ["preserved-negative-Web-proof"],
};
webNegativeRow.manual.surfaceProgress ??= {};
webNegativeRow.manual.surfaceProgress.web = {
  completed: ["earlier subset"],
  remaining: ["unresolved Web failure"],
  evidence: ["negative proof"],
  status: "partial",
};
const webNegative = run(webNegativeInput);
if (webNegative.error) throw new Error(webNegative.error);
const webNegativePaths = [
  ...differences(webNegativeRow.results.web, base(webNegative.matrix, 14).results.web, "14/web"),
  ...differences(
    webNegativeRow.manual.surfaceProgress.web,
    base(webNegative.matrix, 14).manual.surfaceProgress.web,
    "14/web/progress",
  ),
];
const androidFile = path.join(
  root,
  "docs/evidence/project-components/android-offline-create-recovery.json",
);
const android = JSON.parse(fs.readFileSync(androidFile));
const androidValidation = first.matrix.evidenceMapping.validationEvidence.find(
  (entry) => entry.file === "android-offline-create-recovery.json",
);
const webRow = base(first.matrix, 14);
const freshTamperFiles = [
  androidFile,
  path.join(root, android.sourceFiles[0].path),
  path.join(
    root,
    "docs/evidence/project-components/web-submission-recovery-live/bf3a4621-6c48-459e-b776-5c9011d7d327/proof.json",
  ),
];
const freshTamperResults = freshTamperFiles.map((file) => {
  const rejected = run(original, source, file);
  return {
    path: path.relative(root, file),
    rejected: !!rejected.error,
    virtualWrites: rejected.writes.size,
  };
});
const clientRecovery = {
  referenceCommit: "6b28723",
  referenceMapperSha256: hash(referenceBytes),
  deltaResultPaths: deltaPaths,
  otherFiveBaseline14SurfaceDiffs: fiveSurfacePaths.length,
  otherEntryResultDiffs: unexpectedDeltaPaths.length,
  webFailedResultAndProgressDiffs: webNegativePaths.length,
  baseline14WebStatus: webRow.results.web.status,
  webRunHistory: webRow.manual.webSubmissionRecoveryRuns.map((run) => ({
    status: run.status,
    checks: run.completedChecks,
    evidence: run.evidence,
  })),
  androidCurrentSources: androidValidation.sourceFiles.length,
  androidNormalization: androidValidation.normalization,
  newProofAndSourceTamper: freshTamperResults,
  retainedNotesExplanation:
    "159 original notes are preserved; the frozen prior mapper adds 59 once (218). This addition archives the previous baseline14 Web note once (219); the second run remains 219.",
};

const protectedAfter = Object.fromEntries(
  [mapperPath, actualMatrixPath, actualReviewPath].map((file) => [
    path.relative(root, file),
    hash(fs.readFileSync(file)),
  ]),
);
const actualFilesUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
const checks = {
  onlyBaseline14WebResultDelta: unexpectedDeltaPaths.length === 0 && deltaPaths.length === 3,
  otherFiveBaseline14SurfacesUnchanged: fiveSurfacePaths.length === 0,
  existingWebFailureAndProgressPreserved: webNegativePaths.length === 0,
  webRemainsPartialWithBothRuns:
    webRow.results.web.status === "not_run" &&
    webRow.manual.surfaceProgress.web.status === "partial" &&
    webRow.manual.webSubmissionRecoveryRuns[0].status === "failed" &&
    webRow.manual.webSubmissionRecoveryRuns[1].completedChecks === 101,
  androidValidationOnlyAndTenSources:
    androidValidation.matched === true &&
    androidValidation.sourceFiles.length === 10 &&
    androidValidation.normalization.testsRerun === false,
  newProofAndSourceHashFailuresBeforeWrite: freshTamperResults.every(
    (entry) => entry.rejected && entry.virtualWrites === 0,
  ),
  semanticReplayStable: replayPaths.length === 0,
  twoExpectedVirtualWrites: writeTargetsValid,
  retainsAll159OriginalNotes: oldNotes.length === 159 && missingNotes.length === 0,
  noteCountsStable: retainedCount(first.matrix) === 219 && retainedCount(second.matrix) === 219,
  syntheticFailedResultsPreserved: failedPaths.length === 0,
  syntheticFailedProgressPreserved: failedProgressPaths.length === 0,
  regressionControlDetects68Downgrades: guardDisabledLosses.length === 68,
  unmeasuredClientSurfacesUnchanged: fourPaths.length === 0,
  all401RevalidationFlagsPreserved: flagCount === 401 && flagPaths.length === 0,
  explicitManualAnnotationRetained: manualRetained,
  mismatchedProofRejectedBeforeWrite: !!rejected.error && rejected.writes.size === 0,
  protectedActualFilesUnchanged: actualFilesUnchanged,
  rootVerdictPreservedAndClarified:
    source.includes("f8e2c6da-65c0-4cf6-9631-886bb777df2e") &&
    source.includes("验收结果各仅一个版本和事件效果"),
};
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  passed: Object.values(checks).every(Boolean),
  method:
    "Entire frozen mapper executed with new Function after removing four imports and replacing import.meta.url; normal runs substitute only the matrix read; every fs.writeFileSync is intercepted. Negative hash checks alter one proof/source read only in memory. Other reads remain real and read-only; fixed Date normalizes generated timestamps.",
  command: "node scripts/project-components/map-coverage-evidence.client-recovery.audit.mjs",
  input: {
    mapperSha256: hash(mapperBytes),
    matrixSha256: hash(inputBytes),
    actualReviewSha256: protectedBefore[path.relative(root, actualReviewPath)],
    inputMatrixPath: path.relative(root, inputMatrixPath),
    matrixLastCommittedAt: "cb9454b195071e78b006dab5cdac1b8a900a1b9c",
    items: original.items.length,
  },
  clientRecovery,
  previousAudit: {
    path: "docs/evidence/project-components/mapper-memory-audit.json",
    sha256: hash(
      fs.readFileSync(path.join(root, "docs/evidence/project-components/mapper-memory-audit.json")),
    ),
    frozenCommit: "6b28723",
    overwritten: false,
  },
  historicalBeforeFix: {
    observedInPriorReadOnlyAudit: true,
    firstRetainedNotes: 159,
    secondRetainedNotes: 198,
    changedPaths: 36,
    syntheticFailedDowngrades: 68,
    note: "Historical observation was captured before the fix. The current audit also reproduces the 68-status protection regression by disabling exactly the two central failed guards; that control is not a byte-identical reconstruction of the former source.",
  },
  results: {
    semanticReplayDiffs: replayPaths.length,
    noteCounts: [
      retainedCount(original),
      retainedCount(first.matrix),
      retainedCount(second.matrix),
    ],
    originalNotesMissing: missingNotes.length,
    syntheticFailedSurfaces: failedSurfaces,
    failedResultDiffs: failedPaths.length,
    failedProgressDiffs: failedProgressPaths.length,
    guardDisabledControlDowngrades: guardDisabledLosses.length,
    unmeasuredClientSurfaceDiffs: fourPaths.length,
    revalidationFlags: flagCount,
    flagDiffs: flagPaths.length,
    mismatchedProofVirtualWrites: rejected.writes.size,
    mismatchedProofError: rejected.error,
    virtualWriteTargets: [...first.writes.keys()].map((file) => path.relative(root, file)),
    differencePaths: [
      ...replayPaths,
      ...failedPaths,
      ...failedProgressPaths,
      ...fourPaths,
      ...flagPaths,
    ].slice(0, 20),
  },
  checks,
  protectedFilesBefore: protectedBefore,
  protectedFilesAfter: protectedAfter,
  limits: [
    "Pure memory audit only: no actual generate/map output was written and no baseline result was published.",
    "No UI, business API, service control or production probes. git show reads only the exact historical mapper for the incremental comparison.",
    "Virtual timestamp is fixed only to compare mapping semantics.",
    "For a later changed worktree, supply exact reviewed source/input snapshots with --mapper and --input-matrix; hash mismatch intentionally fails closed.",
  ],
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
