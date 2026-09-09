import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// No filesystem writes: the complete mapper's two output calls are intercepted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = path.join(root, "docs/evidence/project-components");
const mapperPath = path.join(root, "scripts/project-components/map-coverage-evidence.mjs");
const matrixPath = path.join(evidenceRoot, "coverage-matrix.json");
const reviewPath = path.join(evidenceRoot, "coverage-mapping-review.md");
const mdPath = path.join(evidenceRoot, "coverage-matrix.md");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectedInput = "53eafe84381682efdb6a56cca8c2fd5044883a3e341a99b8b06eb242d8044990";
const referenceCommit = "3baff66d84dd6ad2f9b5f48230ff4375510269ec";
const referenceSha = "a6ce0ab3e9dda7b910682e4b6584d32dca2eb88dca06f5734dd89b9c35744ee5";
const mapperBytes = fs.readFileSync(mapperPath);
const inputBytes = fs.readFileSync(matrixPath);
if (hash(inputBytes) !== expectedInput) throw new Error("Frozen input matrix changed");
const argumentIndex = process.argv.indexOf("--expected-mapper");
if (argumentIndex < 0 || process.argv[argumentIndex + 1] !== hash(mapperBytes))
  throw new Error("Pass the explicitly reviewed mapper SHA with --expected-mapper");
const protectedFiles = [matrixPath, reviewPath, mdPath];
const protectedHashes = () =>
  Object.fromEntries(
    protectedFiles.map((file) => [path.relative(root, file), hash(fs.readFileSync(file))]),
  );
const protectedBefore = protectedHashes();
const original = JSON.parse(inputBytes);
const referenceBytes = execFileSync(
  "git",
  ["show", `${referenceCommit}:scripts/project-components/map-coverage-evidence.mjs`],
  { cwd: root },
);
if (hash(referenceBytes) !== referenceSha) throw new Error("Historical mapper changed");
function executable(bytes) {
  return bytes
    .toString("utf8")
    .replace(/^import .*;\r?\n/gmu, "")
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(mapperPath).href));
}
class FixedDate extends Date {
  constructor(value = "2026-09-09T02:10:00.000Z") {
    super(value);
  }
  static now() {
    return new Date("2026-09-09T02:10:00.000Z").getTime();
  }
}
function run(input, bytes = mapperBytes, altered = null, absent = null) {
  const writes = new Map();
  const virtualFs = {
    readdirSync: fs.readdirSync,
    existsSync(file) {
      return path.resolve(file) === absent ? false : fs.existsSync(file);
    },
    readFileSync(file, encoding) {
      const resolved = path.resolve(file);
      const body =
        resolved === matrixPath ? Buffer.from(JSON.stringify(input)) : fs.readFileSync(file);
      const output = resolved === altered ? Buffer.concat([body, Buffer.from(" ")]) : body;
      return encoding ? output.toString(encoding) : output;
    },
    writeFileSync(file, body) {
      writes.set(path.resolve(file), String(body));
    },
  };
  try {
    new Function("fs", "path", "fileURLToPath", "createHash", "console", "Date", executable(bytes))(
      virtualFs,
      path,
      fileURLToPath,
      createHash,
      { log() {} },
      FixedDate,
    );
    return { matrix: JSON.parse(writes.get(matrixPath)), writes };
  } catch (error) {
    return { error: error.message, writes };
  }
}
function mustRun(result) {
  if (result.error) throw new Error(result.error);
  return result;
}
function diff(a, b, prefix = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return [prefix + "/length"];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      diff(a[key], b[key], prefix + "/" + key),
    );
  }
  return [prefix];
}
const base = (m, n) =>
  m.items.find((i) => i.kind === "baseline" && Number(i.title.slice(0, 2)) === n);
const notes = (m) => m.items.reduce((n, i) => n + (i.manual.retainedReviewNotes?.length ?? 0), 0);
const whole = (m) =>
  m.items
    .filter((i) => i.kind === "baseline" && i.status === "passed")
    .map((i) => Number(i.title.slice(0, 2)));
const reference = mustRun(run(original, referenceBytes));
const first = mustRun(run(original));
const second = mustRun(run(first.matrix));
const stableDiffs = diff(first.matrix, second.matrix);
const summary = first.matrix.evidenceMapping.recentVersionedEvidence;
const statusDiffs = first.matrix.items.flatMap((i, n) =>
  Object.keys(i.results)
    .filter((s) => i.results[s].status !== reference.matrix.items[n].results[s].status)
    .map((s) => `${i.id}/${s}`),
);
const resultDiffs = first.matrix.items.flatMap((i, n) =>
  Object.keys(i.results).flatMap((s) =>
    diff(reference.matrix.items[n].results[s], i.results[s], `${i.id}/${s}`),
  ),
);
const allowed = new Set(summary.matches.map((m) => `${m.itemId}/${m.surface}`));
const unexpectedResults = resultDiffs.filter(
  (p) => ![...allowed].some((a) => p.startsWith(a + "/")),
);
const flagDiffs = first.matrix.items.flatMap((i, n) =>
  diff(
    {
      flag: original.items[n].needsRevalidation,
      manual: original.items[n].manual.needsRevalidation,
    },
    { flag: i.needsRevalidation, manual: i.manual.needsRevalidation },
    `${i.id}/flags`,
  ),
);
const missingRetained = original.items.flatMap((i) =>
  (i.manual.retainedReviewNotes ?? [])
    .filter(
      (note) =>
        !first.matrix.items
          .find((j) => j.id === i.id)
          .manual.retainedReviewNotes?.some((n) => JSON.stringify(n) === JSON.stringify(note)),
    )
    .map(() => i.id),
);
const automatic = new Set([
  "Real execution and read-back required.",
  "This entry inventories a different surface; requirement-level coverage is tracked separately. Not an accepted scope exclusion.",
  "Status describes the explicitly recorded cases. Other guards and complete cross-surface baselines remain independently required.",
]);
const lostCurrentNotes = original.items.flatMap((i) =>
  Object.entries(i.results)
    .filter(([surface, result]) => {
      if (!result.note || automatic.has(result.note)) return false;
      const target = first.matrix.items.find((j) => j.id === i.id);
      return (
        target.results[surface].note !== result.note &&
        !target.manual.retainedReviewNotes?.some(
          (n) => n.surface === surface && n.note === result.note,
        )
      );
    })
    .map(([surface]) => `${i.id}/${surface}`),
);

// All applicable surfaces, including the newly targeted Web/APK/EXE controls.
const negativeInput = structuredClone(original);
let failedSurfaces = 0;
for (const i of negativeInput.items)
  for (const [surface, result] of Object.entries(i.results)) {
    if (!result.applicable) continue;
    failedSurfaces++;
    i.results[surface] = {
      ...result,
      status: "failed",
      note: "manual failure note",
      actual: "manual negative case",
      evidence: ["manual-failure-proof"],
    };
    i.manual.surfaceProgress ??= {};
    i.manual.surfaceProgress[surface] = {
      status: "partial",
      completed: ["known subset"],
      remaining: ["unresolved negative"],
      evidence: ["manual-progress"],
    };
  }
const negative = mustRun(run(negativeInput));
const negativeDiffs = negative.matrix.items.flatMap((i, n) =>
  Object.entries(i.results)
    .filter(([, r]) => r.applicable)
    .flatMap(([s]) => [
      ...diff(negativeInput.items[n].results[s], i.results[s], `${i.id}/${s}`),
      ...diff(
        negativeInput.items[n].manual.surfaceProgress[s],
        i.manual.surfaceProgress[s],
        `${i.id}/${s}/progress`,
      ),
    ]),
);
const primaries = [
  "web-rejected-media-recovery-live/5f3c9726-5374-4c7d-9ba4-57573901968e/proof.json",
  "android-code23-recovery-live/65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/result.json",
  "android-code23-feed-publication/29a9b98b-2fa8-4625-a465-5d75a91b70e8/publish.json",
  "exe-preview8-live/1786509a-9de7-4d1a-ba8c-9fb282c9c453/result.json",
  "exe-preview9-live/f222d18f-4176-401f-9bdc-af6da4917991/result.json",
  "web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864/deploy.json",
];
const corrupt = primaries.map((file) => {
  const value = run(original, mapperBytes, path.join(evidenceRoot, file));
  return { file, rejected: !!value.error, virtualWrites: value.writes.size };
});
const absent = primaries.map((file) => {
  const value = mustRun(run(original, mapperBytes, null, path.join(evidenceRoot, file)));
  return {
    file,
    skipped: value.matrix.evidenceMapping.recentVersionedEvidence.absent.includes(file),
    absentProofMapped: value.matrix.evidenceMapping.recentVersionedEvidence.observations.some((o) =>
      o.evidence.includes(file),
    ),
    whole: whole(value.matrix),
  };
});
const changedNode = structuredClone(original);
const button = changedNode.items.find((i) => i.id === "web_control-f59fc9cda1c3d9");
button.id += "-different-node";
button.title = button.title.replace("submitBug", "submitComment");
const changedOutput = mustRun(run(changedNode));
const changedButton = changedOutput.matrix.items.find((i) => i.id === button.id);
const existingHashTamper = structuredClone(original);
const reviewed = existingHashTamper.items.find(
  (i) => Object.keys(i.manual.reviewedEvidence?.proofHashes ?? {}).length,
);
reviewed.manual.reviewedEvidence.proofHashes[
  Object.keys(reviewed.manual.reviewedEvidence.proofHashes)[0]
] = "0".repeat(64);
const existingHashRejected = run(existingHashTamper);
const historicalRuns = (m) => JSON.stringify(base(m, 14).manual.webSubmissionRecoveryRuns);
const protectedAfter = protectedHashes();
const checks = {
  wholeBaselinesRemainSeven:
    JSON.stringify(whole(first.matrix)) === JSON.stringify([9, 10, 11, 12, 15, 23, 24]),
  noEntryOrSurfaceStatusPromotion: statusDiffs.length === 0,
  exactAllowedResultTargetsOnly: unexpectedResults.length === 0,
  semanticReplayZeroDiff: stableDiffs.length === 0,
  virtualReviewReplayStable: first.writes.get(reviewPath) === second.writes.get(reviewPath),
  allOriginalRetainedNotesPreserved: missingRetained.length === 0,
  allNonDefaultCurrentNotesPreserved: lostCurrentNotes.length === 0,
  retainedNotesStable: notes(first.matrix) === notes(second.matrix),
  allRevalidationFlagsUnchanged: flagDiffs.length === 0,
  allSyntheticFailedResultsAndProgressUntouched: negativeDiffs.length === 0,
  allNewProofHashFailuresBeforeWrite: corrupt.every((i) => i.rejected && i.virtualWrites === 0),
  existingReviewedHashFailsBeforeWrite:
    !!existingHashRejected.error && existingHashRejected.writes.size === 0,
  absentOptionalProofsDoNotMap: absent.every(
    (i) =>
      i.skipped &&
      !i.absentProofMapped &&
      JSON.stringify(i.whole) === JSON.stringify(whole(reference.matrix)),
  ),
  differentNodeGetsNoInheritedObservationOrPass:
    changedButton.results.web.status === "not_run" &&
    !(changedButton.manual.recentEvidenceObservations ?? []).some(
      (o) => o.id === "web-7904e2c-rejected-media-81",
    ),
  oldWebHarnessFailureRetained: historicalRuns(first.matrix) === historicalRuns(reference.matrix),
  oldExe8FailureHistoryRetained: summary.observations.some(
    (o) =>
      o.id === "exe-native-upgrade-7-to-8" &&
      o.preservedFinding.status === "open_in_installed_preview8",
  ),
  noUnrunClientTransfer: ["exe", "http", "server_mcp", "local_mcp"].every(
    (surface) =>
      JSON.stringify(base(first.matrix, 14).results[surface]) ===
      JSON.stringify(base(reference.matrix, 14).results[surface]),
  ),
  noSourceSnapshotRefresh:
    JSON.stringify(original.sourceHashes) === JSON.stringify(first.matrix.sourceHashes) &&
    original.sourceHead === first.matrix.sourceHead,
  publicationOnlyValidation: first.matrix.evidenceMapping.validationEvidence.some(
    (i) => i.file === primaries[5] && i.scope.includes("不代表真实Web loading页面验收"),
  ),
  onlyVirtualMatrixAndReviewWrites: [first, second].every(
    (r) => r.writes.size === 2 && r.writes.has(matrixPath) && r.writes.has(reviewPath),
  ),
  actualThreeOutputsByteUnchanged:
    JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
};
const report = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  passed: Object.values(checks).every(Boolean),
  method:
    "Entire mapper in new Function after import removal and import.meta.url replacement; substitute only matrix reads and capture every writeFileSync in memory. Fixed Date for semantic comparison; six proof tamper/absence cases only alter virtual reads. No generate/map writes, business calls or runtime probes.",
  input: {
    mapperSha256: hash(mapperBytes),
    matrixSha256: hash(inputBytes),
    referenceCommit,
    referenceMapperSha256: referenceSha,
    items: original.items.length,
    retiredItems: original.retiredItems.length,
    historicalSourceFiles: Object.keys(original.sourceHashes).length,
  },
  results: {
    whole: whole(first.matrix),
    statusDiffs,
    resultDiffCount: resultDiffs.length,
    unexpectedResultDiffs: unexpectedResults,
    replayDiffs: stableDiffs.slice(0, 30),
    replayDiffCount: stableDiffs.length,
    semanticSha256: [hash(JSON.stringify(first.matrix)), hash(JSON.stringify(second.matrix))],
    retainedNoteCounts: [notes(original), notes(first.matrix), notes(second.matrix)],
    missingRetained,
    lostCurrentNotes,
    revalidationFlags: original.items.filter(
      (i) => i.needsRevalidation || i.manual.needsRevalidation,
    ).length,
    flagDiffs,
    syntheticFailedSurfaces: failedSurfaces,
    syntheticNegativeDiffCount: negativeDiffs.length,
    syntheticNegativeDiffs: negativeDiffs.slice(0, 30),
    proofTamper: corrupt,
    optionalAbsence: absent,
    existingReviewedHashVirtualWrites: existingHashRejected.writes.size,
    recentObservations: summary.observations.map((o) => ({
      id: o.id,
      version: o.version,
      evidence: o.evidence,
    })),
    matches: summary.matches,
    unmatched: summary.unmatched,
  },
  checks,
  protectedBefore,
  protectedAfter,
  limits: [
    "Pure memory mapping only; actual matrix/source inventory not regenerated or published.",
    "Input 191-source snapshot is historical. Other agents may change API sources without invalidating these historical version-bound proofs; Git dirty is not used as a test verdict.",
    "Whole baseline14/22 and physical Android remain incomplete; static Web publication is not browser loading acceptance.",
  ],
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
