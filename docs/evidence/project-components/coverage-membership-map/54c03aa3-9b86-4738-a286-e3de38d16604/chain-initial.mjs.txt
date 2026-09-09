import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";

// Execute the real static generator and mapper, but route their three generated
// files to an isolated directory. App code is parsed, never imported or run.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = path.join(root, "docs/evidence/project-components");
const names = ["coverage-matrix.json", "coverage-mapping-review.md", "coverage-matrix.md"];
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "qa-coverage-chain-"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const before = Object.fromEntries(
  names.map((name) => [name, sha(fs.readFileSync(path.join(evidenceRoot, name)))]),
);
const input = JSON.parse(fs.readFileSync(path.join(evidenceRoot, names[0])));
const clone = structuredClone(input);
const target = clone.items.find(
  (item) =>
    item.kind === "web_control" &&
    item.source?.file === "apps/web/src/App.tsx" &&
    /setNewContent/u.test(item.title),
);
if (!target) throw new Error("Expected current Bug text control for real discovery fixture");
clone.items = clone.items.filter((item) => item.id !== target.id);
const changed = clone.items.find(
  (item) =>
    item.kind === "web_control" &&
    item.source?.file === "apps/web/src/App.tsx" &&
    /openCreateBug/u.test(item.title),
);
if (!changed) throw new Error("Expected existing create control");
changed.sourceHash = "0".repeat(64);
changed.needsRevalidation = false;
// This fixture represents the first source change for this node, independently
// of any review already attached to the actual input checkpoint.
delete changed.manual.sourceEvidenceReview;
for (const surface of ["web", "exe"])
  changed.results[surface] = {
    ...changed.results[surface],
    status: "not_run",
    actual: "manual source-change pending",
    evidence: [],
    note: "manual source-change note",
  };
const failed = [];
for (const item of clone.items) {
  for (const surface of [
    "http",
    "server_mcp",
    ...(item.kind === "baseline" && item.title.startsWith("14 ") ? ["web"] : []),
  ]) {
    if (!item.results[surface].applicable) continue;
    item.results[surface] = {
      ...item.results[surface],
      status: "failed",
      note: "manual negative note",
      actual: "manual negative observation",
      evidence: ["synthetic negative proof"],
    };
    item.manual.surfaceProgress ??= {};
    item.manual.surfaceProgress[surface] = {
      completed: ["manual subset"],
      remaining: ["manual unresolved failure"],
      evidence: ["synthetic negative proof"],
      status: "partial",
    };
    failed.push({
      id: item.id,
      surface,
      result: structuredClone(item.results[surface]),
      progress: structuredClone(item.manual.surfaceProgress[surface]),
    });
  }
}
const manual = clone.items.find((item) => item.kind === "baseline" && item.title.startsWith("01 "));
manual.results.exe.note = "unique manual annotation before composite replay";
manual.results.exe.actual = "manual source observation";
manual.manual.surfaceProgress ??= {};
manual.manual.surfaceProgress.exe = {
  completed: ["manual completed"],
  remaining: ["manual remaining"],
  evidence: ["manual proof"],
  status: "partial",
};
fs.writeFileSync(path.join(fixture, names[0]), JSON.stringify(clone));
const sourceHashes = {};
function execute(name) {
  const sourcePath = path.join(root, "scripts/project-components", name);
  const bytes = fs.readFileSync(sourcePath);
  sourceHashes[name] = sha(bytes);
  const source = bytes
    .toString("utf8")
    .replace(/^import .*;\r?\n/gmu, "")
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(sourcePath).href));
  const redirect = (file) =>
    path.dirname(path.resolve(file)) === evidenceRoot && names.includes(path.basename(file))
      ? path.join(fixture, path.basename(file))
      : file;
  const virtualFs = {
    ...fs,
    readFileSync(file, ...args) {
      return fs.readFileSync(redirect(file), ...args);
    },
    existsSync(file) {
      return fs.existsSync(redirect(file));
    },
    mkdirSync(file, ...args) {
      if (path.resolve(file) !== evidenceRoot) throw new Error("Unexpected mkdir");
      return fs.mkdirSync(fixture, ...args);
    },
    writeFileSync(file, ...args) {
      if (redirect(file) === file) throw new Error("Unexpected write target");
      return fs.writeFileSync(redirect(file), ...args);
    },
  };
  new Function(
    "fs",
    "path",
    "fileURLToPath",
    "createHash",
    "execFileSync",
    "ts",
    "console",
    "process",
    source,
  )(
    virtualFs,
    path,
    fileURLToPath,
    createHash,
    execFileSync,
    ts,
    { log() {} },
    { stdout: { write() {} } },
  );
}
function chain() {
  for (const name of [
    "generate-coverage-matrix.mjs",
    "map-coverage-evidence.mjs",
    "generate-coverage-matrix.mjs",
  ])
    execute(name);
  return JSON.parse(fs.readFileSync(path.join(fixture, names[0])));
}
function normalized(value) {
  const result = structuredClone(value);
  delete result.generatedAt;
  delete result.evidenceMapping.at;
  for (const item of [...result.items, ...result.retiredItems]) delete item.manual.evidenceMappedAt;
  return JSON.stringify(result);
}
const first = chain(),
  second = chain();
const firstIndex = new Map(first.items.map((item) => [item.id, item]));
const failedLosses = failed
  .filter(
    (entry) =>
      JSON.stringify(firstIndex.get(entry.id)?.results[entry.surface]) !==
        JSON.stringify(entry.result) ||
      JSON.stringify(firstIndex.get(entry.id)?.manual.surfaceProgress?.[entry.surface]) !==
        JSON.stringify(entry.progress),
  )
  .map((entry) => entry.id + "/" + entry.surface);
const newNode = firstIndex.get(target.id),
  changedNode = firstIndex.get(changed.id);
const manualAfter = firstIndex.get(manual.id);
const originalNotes = clone.items.flatMap((item) =>
  (item.manual.retainedReviewNotes ?? []).map((note) => ({ id: item.id, note })),
);
const notesMissing = originalNotes
  .filter(
    (entry) =>
      !firstIndex
        .get(entry.id)
        ?.manual.retainedReviewNotes?.some(
          (note) => JSON.stringify(note) === JSON.stringify(entry.note),
        ),
  )
  .map((entry) => entry.id);
const flagLosses = clone.items
  .filter((item) => item.needsRevalidation || item.manual.needsRevalidation)
  .filter(
    (item) =>
      !firstIndex.get(item.id)?.needsRevalidation &&
      !firstIndex.get(item.id)?.manual.needsRevalidation,
  )
  .map((item) => item.id);
const after = Object.fromEntries(
  names.map((name) => [name, sha(fs.readFileSync(path.join(evidenceRoot, name)))]),
);
const checks = {
  compositeSemanticReplayStable: normalized(first) === normalized(second),
  allSyntheticFailedResultsAndProgressPreserved: failedLosses.length === 0,
  originalNotesPreserved: notesMissing.length === 0,
  originalRevalidationFlagsPreserved: flagLosses.length === 0,
  actualNewNodeNotAutomaticallyPassed: ["web", "exe"].every(
    (surface) => newNode.results[surface].status === "not_run",
  ),
  newNodeHasExactSourceReview:
    newNode.needsRevalidation &&
    newNode.manual.sourceEvidenceReview.nodeId === target.id &&
    newNode.manual.sourceEvidenceReview.sourceFile === target.source.file,
  changedSourceNotAutomaticallyPassed: ["web", "exe"].every(
    (surface) => changedNode.results[surface].status === "not_run",
  ),
  oldSourceResultsRetained:
    changedNode.manual.sourceEvidenceReview?.priorResults?.web?.note ===
    "manual source-change note",
  manualAnnotationRetained: manualAfter.manual.retainedReviewNotes.some(
    (note) =>
      note.note === "unique manual annotation before composite replay" &&
      note.progress?.remaining?.includes("manual remaining"),
  ),
  actualWorkspaceGeneratedFilesUnchanged: JSON.stringify(before) === JSON.stringify(after),
};
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  passed: Object.values(checks).every(Boolean),
  method:
    "Actual generator→mapper→generator source evaluated twice with real TypeScript discovery and public evidence reads; only the three generated output files redirected to a new real temporary directory. No app execution, API or service control.",
  fixture,
  sourceHashes,
  syntheticFailedSurfaces: failed.length,
  failedLosses,
  notesMissing,
  flagLosses,
  semanticHashes: [first, second].map((value) => sha(normalized(value))),
  checks,
  workspaceBefore: before,
  workspaceAfter: after,
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
