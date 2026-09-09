import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Execute the complete mapper with only in-memory output sinks. Do not invoke
// generators, import app code, inspect profiles or connect to any service.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = path.join(root, "docs/evidence/project-components");
const mapperPath = path.join(root, "scripts/project-components/map-coverage-evidence.mjs");
const outputs = ["coverage-matrix.json", "coverage-mapping-review.md", "coverage-matrix.md"].map(
  (file) => path.join(evidenceRoot, file),
);
const [matrixPath, reviewPath] = outputs;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mapperBytes = fs.readFileSync(mapperPath);
const inputBytes = fs.readFileSync(matrixPath);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--expected-mapper" || args[1] !== sha(mapperBytes))
  throw new Error("Explicit current mapper SHA required");
const referenceCommit = "2d687b47b658d6d38e096872e9a92950bcb30c7d";
const referenceBytes = execFileSync(
  "git",
  ["show", `${referenceCommit}:scripts/project-components/map-coverage-evidence.mjs`],
  { cwd: root },
);
if (sha(referenceBytes) !== "c0de8ebdc985eeecbda449977b0380d1eedef4de33cda2b9d6f524e3c81da02b")
  throw new Error("Reference mapper SHA changed");
const protectedHashes = () =>
  Object.fromEntries(
    outputs.map((file) => [path.relative(root, file), sha(fs.readFileSync(file))]),
  );
const protectedBefore = protectedHashes();
const input = JSON.parse(inputBytes);
const checks = [];
function check(label, actual, expected = true) {
  checks.push({ label, passed: isDeepStrictEqual(actual, expected), actual, expected });
}
const all = (matrix) => [...matrix.items, ...matrix.retiredItems];
const index = (matrix) => new Map(all(matrix).map((item) => [item.id, item]));
const baseline = (matrix, number) =>
  matrix.items.find(
    (item) => item.kind === "baseline" && Number(item.title.slice(0, 2)) === number,
  );
class FixedDate extends Date {
  constructor(value = "2026-09-09T03:15:00.000Z") {
    super(value);
  }
  static now() {
    return new Date("2026-09-09T03:15:00.000Z").getTime();
  }
}
function run(matrix, bytes = mapperBytes, altered = null, absent = null) {
  const writes = new Map();
  const virtualFs = {
    readdirSync: fs.readdirSync,
    existsSync(file) {
      return path.resolve(file) === absent ? false : fs.existsSync(file);
    },
    readFileSync(file, encoding) {
      const location = path.resolve(file);
      const original =
        location === matrixPath ? Buffer.from(JSON.stringify(matrix)) : fs.readFileSync(location);
      const body = location === altered ? Buffer.concat([original, Buffer.from(" ")]) : original;
      return encoding ? body.toString(encoding) : body;
    },
    writeFileSync(file, body) {
      const location = path.resolve(file);
      if (![matrixPath, reviewPath].includes(location))
        throw new Error("Unexpected virtual output");
      writes.set(location, String(body));
    },
  };
  try {
    const executable = bytes
      .toString("utf8")
      .replace(/^import .*;\r?\n/gmu, "")
      .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(mapperPath).href));
    new Function("fs", "path", "fileURLToPath", "createHash", "console", "Date", executable)(
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
function requireSuccess(value) {
  if (value.error) throw new Error(value.error);
  return value;
}
const old = requireSuccess(run(input, referenceBytes));
const first = requireSuccess(run(input));
const second = requireSuccess(run(first.matrix));
const oldIndex = index(old.matrix);
const firstIndex = index(first.matrix);
const allowedPromotions = [2, 4].map((number) => `${baseline(input, number).id}/server_mcp`).sort();
const promotions = all(first.matrix)
  .flatMap((item) =>
    Object.entries(item.results)
      .filter(
        ([surface, result]) => result.status !== oldIndex.get(item.id).results[surface].status,
      )
      .map(([surface]) => `${item.id}/${surface}`),
  )
  .sort();
check("only baseline02/04 server MCP statuses change", promotions, allowedPromotions);
for (const number of [2, 4]) {
  check(
    `baseline ${number} server MCP passed`,
    baseline(first.matrix, number).results.server_mcp.status,
    "passed",
  );
  for (const surface of Object.keys(baseline(first.matrix, number).results).filter(
    (value) => value !== "server_mcp",
  ))
    check(
      `baseline ${number} ${surface} result unchanged`,
      baseline(first.matrix, number).results[surface],
      baseline(old.matrix, number).results[surface],
    );
}
check(
  "whole-baseline pass set unchanged",
  first.matrix.items
    .filter((item) => item.kind === "baseline" && item.status === "passed")
    .map((item) => item.id),
  old.matrix.items
    .filter((item) => item.kind === "baseline" && item.status === "passed")
    .map((item) => item.id),
);
check(
  "two mapper passes matrix byte stable with fixed clock",
  first.writes.get(matrixPath),
  second.writes.get(matrixPath),
);
// Avoid outputting multi-megabyte equal matrix strings in the audit report.
for (const item of checks.filter((entry) => entry.label.includes("byte stable"))) {
  item.actual = sha(item.actual);
  item.expected = sha(item.expected);
}
check(
  "two mapper passes review byte stable",
  sha(first.writes.get(reviewPath)),
  sha(second.writes.get(reviewPath)),
);
check("retired items unchanged", first.matrix.retiredItems, input.retiredItems);
const flagLosses = [],
  noteLosses = [],
  currentFailureLosses = [];
for (const item of all(input)) {
  const after = firstIndex.get(item.id);
  if (
    !isDeepStrictEqual(
      [item.needsRevalidation, item.manual.needsRevalidation],
      [after.needsRevalidation, after.manual.needsRevalidation],
    )
  )
    flagLosses.push(item.id);
  for (const note of item.manual.retainedReviewNotes ?? [])
    if (!after.manual.retainedReviewNotes?.some((entry) => isDeepStrictEqual(entry, note)))
      noteLosses.push(item.id);
  for (const [surface, result] of Object.entries(item.results))
    if (
      result.status === "failed" &&
      (!isDeepStrictEqual(result, after.results[surface]) ||
        !isDeepStrictEqual(
          item.manual.surfaceProgress?.[surface],
          after.manual.surfaceProgress?.[surface],
        ))
    )
      currentFailureLosses.push(`${item.id}/${surface}`);
}
check("all current/retired revalidation flags retained", flagLosses, []);
check("all prior retained review notes retained", noteLosses, []);
check("all actual failed result and progress bytes retained", currentFailureLosses, []);
check(
  "source snapshot not silently revalidated",
  [first.matrix.sourceHead, first.matrix.sourceHashes],
  [input.sourceHead, input.sourceHashes],
);
// Populate every applicable surface, including retired items and intended
// promotion targets, with failure/progress/sentinel fields before full mapping.
const negative = structuredClone(input);
let syntheticFailedSurfaces = 0;
for (const item of all(negative)) {
  item.manual.membershipAuditSentinel = { note: "retain manual annotation", nested: [item.id] };
  for (const [surface, result] of Object.entries(item.results)) {
    if (!result.applicable) continue;
    syntheticFailedSurfaces++;
    item.results[surface] = {
      ...result,
      status: "failed",
      note: "manual failure note",
      actual: "manual negative observation",
      evidence: ["synthetic-failure-only"],
    };
    item.manual.surfaceProgress ??= {};
    item.manual.surfaceProgress[surface] = {
      status: "partial",
      completed: ["known subset"],
      remaining: ["unresolved negative"],
      evidence: ["synthetic-progress-only"],
    };
  }
}
const negativeResult = requireSuccess(run(negative));
const negativeIndex = index(negativeResult.matrix);
const losses = [];
for (const item of all(negative)) {
  const after = negativeIndex.get(item.id);
  if (!isDeepStrictEqual(item.manual.membershipAuditSentinel, after.manual.membershipAuditSentinel))
    losses.push(`${item.id}/manual`);
  for (const [surface, result] of Object.entries(item.results))
    if (
      result.applicable &&
      (!isDeepStrictEqual(result, after.results[surface]) ||
        !isDeepStrictEqual(
          item.manual.surfaceProgress[surface],
          after.manual.surfaceProgress[surface],
        ))
    )
      losses.push(`${item.id}/${surface}`);
}
check("all synthetic current/retired failed surfaces and progress survive", losses, []);
check(
  "negative replay stable",
  sha(requireSuccess(run(negativeResult.matrix)).writes.get(matrixPath)),
  sha(negativeResult.writes.get(matrixPath)),
);
const annotated = structuredClone(input);
for (const number of [2, 4]) {
  const item = baseline(annotated, number);
  item.needsRevalidation = true;
  item.manual.needsRevalidation = true;
  item.manual.membershipAuditSentinel = { note: "keep unrelated manual fields", number };
  delete item.manual.serverMembershipPriorProgress;
  item.results.server_mcp = {
    ...item.results.server_mcp,
    status: "not_run",
    note: `manual membership note ${number}`,
    actual: "manual incomplete observation",
    evidence: ["synthetic-membership-progress"],
  };
  item.manual.surfaceProgress ??= {};
  item.manual.surfaceProgress.server_mcp = {
    status: "partial",
    completed: ["prior partial"],
    remaining: ["prior unresolved"],
    evidence: ["synthetic-membership-progress"],
  };
}
const annotatedResult = requireSuccess(run(annotated));
const annotatedReference = requireSuccess(run(annotated, referenceBytes));
for (const number of [2, 4]) {
  const original = baseline(annotated, number),
    result = baseline(annotatedResult.matrix, number);
  check(
    `promotion ${number} retains exact pre-addition mapped progress`,
    result.manual.serverMembershipPriorProgress,
    baseline(annotatedReference.matrix, number).manual.surfaceProgress.server_mcp,
  );
  check(
    `promotion ${number} retains manual note and progress history`,
    result.manual.retainedReviewNotes.some(
      (note) =>
        note.note === original.results.server_mcp.note &&
        isDeepStrictEqual(note.progress, original.manual.surfaceProgress.server_mcp),
    ),
  );
  check(
    `promotion ${number} flags remain true`,
    [result.needsRevalidation, result.manual.needsRevalidation],
    [true, true],
  );
  check(
    `promotion ${number} unrelated manual field retained`,
    result.manual.membershipAuditSentinel,
    original.manual.membershipAuditSentinel,
  );
}
check(
  "annotated promotion replay stable",
  sha(requireSuccess(run(annotatedResult.matrix)).writes.get(matrixPath)),
  sha(annotatedResult.writes.get(matrixPath)),
);
const pins = [
  [
    "web-detail-loading-live/ab51a7d8-3d97-40e0-86af-bf2fe77af389/proof.json",
    "a860b14e12fdd1abe799e118722e4acf280903ae0e7c1b6c1a2cb790925bdcab",
  ],
  [
    "server-mcp-membership-live/e21431f0-e927-4a3f-8275-167accb1eaef/proof.json",
    "55ac6023679282fb4a7a0a985ff79db0a2718999f1869e41fe60b25e569834e5",
  ],
  [
    "contracts-result-phase-a/result.json",
    "b35d2d0d774ce94ca902629625b68a068cdff21edc49f64000471e45a3e449ca",
  ],
];
const proofAudit = [];
for (const [file, expected] of pins) {
  const location = path.join(evidenceRoot, file);
  const bytes = fs.readFileSync(location),
    body = JSON.parse(bytes);
  check(`proof SHA ${file}`, sha(bytes), expected);
  for (const [i, item] of (body.checks ?? []).entries())
    check(`proof actual/expected ${file} ${i}`, item.actual, item.expected);
  const tamper = run(input, mapperBytes, location);
  check(
    `tamper rejected before any write ${file}`,
    [!!tamper.error, tamper.writes.size],
    [true, 0],
  );
  const absent = requireSuccess(run(input, mapperBytes, null, location));
  check(
    `missing optional proof marked absent ${file}`,
    absent.matrix.evidenceMapping.recentVersionedEvidence.absent.includes(file),
  );
  check(
    `new proof validation entry ${file}`,
    first.matrix.evidenceMapping.validationEvidence.some(
      (entry) => entry.file === file && entry.matched === true,
    ),
  );
  if (file === pins[1][0]) {
    for (const number of [2, 4])
      check(
        `absent membership does not promote ${number}`,
        baseline(absent.matrix, number).results.server_mcp.status,
        baseline(old.matrix, number).results.server_mcp.status,
      );
    const denial = body.requests.filter((entry) =>
      ["disabled A refuses same name", "old A token refuses A read"].includes(entry.label),
    );
    check("two denied membership MCP calls actually present", denial.length, 2);
    for (const entry of denial) {
      const result = entry.response.result;
      check(`real MCP denial envelope ${entry.label}`, result.isError, true);
      const parsed = JSON.parse(result.content.find((item) => item.type === "text").text);
      check(`real MCP denial status ${entry.label}`, parsed.status, 403);
    }
  } else {
    check(
      `validation-only proof does not affect any surface result ${file}`,
      all(absent.matrix).map((item) => item.results),
      all(first.matrix).map((item) => item.results),
    );
    const last = checks.at(-1);
    last.actual = sha(JSON.stringify(last.actual));
    last.expected = sha(JSON.stringify(last.expected));
  }
  proofAudit.push({
    file,
    sha256: sha(bytes),
    tamperError: tamper.error,
    tamperVirtualWrites: tamper.writes.size,
  });
}
check(
  "exact two virtual outputs each normal run",
  [old, first, second, negativeResult, annotatedResult].every(
    (value) =>
      value.writes.size === 2 && value.writes.has(matrixPath) && value.writes.has(reviewPath),
  ),
);
const protectedAfter = protectedHashes();
check("actual three generated outputs unchanged", protectedAfter, protectedBefore);
// Preserve useful equality verdicts without duplicating whole matrices/retired
// records/source dictionaries into this report.
for (const item of checks)
  for (const key of ["actual", "expected"])
    if (JSON.stringify(item[key])?.length > 1000)
      item[key] = {
        sha256: sha(JSON.stringify(item[key])),
        serializedBytes: Buffer.byteLength(JSON.stringify(item[key])),
      };
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  passed: checks.every((item) => item.passed),
  checkCount: checks.length,
  method:
    "Full current/reference mapper, fixed Date, virtual matrix input and two in-memory output sinks; no generated workspace writes, service/UI/runtime calls. Three exact proof tamper and absence simulations affect virtual reads only.",
  input: {
    mapperSha256: sha(mapperBytes),
    matrixSha256: sha(inputBytes),
    referenceCommit,
    referenceMapperSha256: sha(referenceBytes),
    items: input.items.length,
    retiredItems: input.retiredItems.length,
  },
  promotions,
  syntheticFailedSurfaces,
  semanticHashes: [first, second].map((value) => sha(value.writes.get(matrixPath))),
  proofAudit,
  checks,
  protectedBefore,
  protectedAfter,
  limits: [
    "This is a mapping/tool audit, not a live business rerun or current-source E2E.",
    "The two promoted server MCP surfaces do not promote whole baselines or other clients.",
    "Detail59 and Phase A source/temporary HTTP evidence remain validation-only; historical failures and source revalidation flags remain.",
    "The separate generation-chain test validates real current-source discovery and current/retired preservation; this audit does not regenerate the actual matrix.",
  ],
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
