import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createValidators, runtimeRoot, sha256 } from "./android-recovery-proxy.mjs";

const here = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(here), "../..");
export const expectedProxySha256 =
  "a164c85357260430d8ad8d8566ca7d9f98249669823dbbe8ecf3ea621430d7af";
export const optionalUpdateGet = "/api/v1/android-updates/preview/latest.json";
export const optionalUpdateGetSha256 = sha256(optionalUpdateGet);
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
export const inputNames = [
  "status.json",
  "public-events.jsonl",
  "original-request.json",
  "confirm-native-action.json",
  ...Array.from({ length: 5 }, (_, i) => `upstream-create-${i + 1}.body`),
];
function guard(value, code) {
  if (!value) throw new Error(code);
}
function json(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** No filesystem or network calls. Builds public output only from validated IDs, counts and hashes. */
export function auditSnapshot(files, expected, validators = createValidators()) {
  for (const key of ["runId", "projectId", "actorId"])
    guard(uuid.test(expected[key]), "EXPECTED_SCOPE_REQUIRED");
  for (const name of inputNames) guard(Buffer.isBuffer(files[name]), "INPUT_FILE_REQUIRED");
  const status = json(files["status.json"]);
  const original = json(files["original-request.json"]);
  const marker = json(files["confirm-native-action.json"]);
  const events = files["public-events.jsonl"]
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const receipts = Array.from({ length: 5 }, (_, i) =>
    json(files[`upstream-create-${i + 1}.body`]),
  );
  const checks = [];
  const check = (code, passed) => {
    checks.push({ code, passed: Boolean(passed) });
  };
  check(
    "expected_scope",
    status.runId === expected.runId &&
      status.projectId === expected.projectId &&
      status.actorId === expected.actorId,
  );
  check(
    "pinned_running_source",
    status.scriptSha256 === expectedProxySha256 &&
      events.filter((event) => event.kind === "listening").length === 1 &&
      events.find((event) => event.kind === "listening")?.scriptSha256 === expectedProxySha256,
  );
  check(
    "terminal_confirmation",
    status.phase === "confirmed" &&
      status.inFlightCreate === false &&
      status.inFlightAuthentication === false,
  );
  check(
    "exact_counts",
    status.dropped === 4 && status.forwardedCreates === 5 && status.proxyRetries === 0,
  );
  check(
    "runner_prerequisites",
    status.emptyProjectObserved === true &&
      status.componentsOffObserved === true &&
      status.authenticationBound === true,
  );
  check("request_schema", validators.request(original));
  check(
    "request_scope_text_only",
    original.projectId === expected.projectId &&
      uuid.test(original.clientSubmissionId) &&
      (original.attachmentIds ?? []).length === 0 &&
      !original.captureBundleId,
  );
  const bodySha256 = sha256(files["original-request.json"]);
  const keySha256 = sha256(`submission:${original.clientSubmissionId}:commit`);
  check(
    "original_request_fingerprints",
    status.target?.bodySha256 === bodySha256 &&
      status.target?.keySha256 === keySha256 &&
      status.target?.clientSubmissionId === original.clientSubmissionId,
  );
  check(
    "exact_operator_marker",
    same(
      Object.keys(marker).sort(),
      ["runId", "keySha256", "bodySha256", "explicitNativeAction"].sort(),
    ) &&
      marker.runId === expected.runId &&
      marker.keySha256 === keySha256 &&
      marker.bodySha256 === bodySha256 &&
      marker.explicitNativeAction === true,
  );
  const creates = events.filter((event) => event.kind === "native_create");
  check("five_create_events", creates.length === 5);
  const canonical = receipts[0];
  const canonicalIds = {
    bugId: canonical.bug?.id,
    occurrenceId: canonical.occurrenceId,
    eventId: canonical.eventId,
    clientSubmissionId: canonical.clientSubmissionId,
  };
  check(
    "canonical_uuid_ids",
    Object.values(canonicalIds).every((id) => uuid.test(id)),
  );
  check("canonical_status_receipt", same(status.receipt, canonicalIds));
  const actions = [];
  for (let index = 0; index < 5; index++) {
    const receipt = receipts[index];
    const event = creates[index];
    check(`receipt_${index + 1}_schema`, validators.response(receipt));
    check(
      `receipt_${index + 1}_scope`,
      receipt.bug?.projectId === expected.projectId &&
        receipt.bug?.reporterId === expected.actorId &&
        receipt.clientSubmissionId === original.clientSubmissionId,
    );
    check(
      `receipt_${index + 1}_same_effect_ids`,
      same(
        {
          bugId: receipt.bug?.id,
          occurrenceId: receipt.occurrenceId,
          eventId: receipt.eventId,
          clientSubmissionId: receipt.clientSubmissionId,
        },
        canonicalIds,
      ) &&
        receipt.qaItem?.id === receipt.bug?.id &&
        receipt.qaItem?.key === receipt.bug?.key,
    );
    check(
      `receipt_${index + 1}_original_content_and_binding`,
      receipt.bug?.title === original.title &&
        receipt.bug?.description === original.description &&
        receipt.bug?.expectedBehavior === original.expectedBehavior &&
        receipt.bug?.ownerId === (original.ownerId ?? null) &&
        receipt.bug?.verificationOwnerId === (original.verificationOwnerId ?? null) &&
        Array.isArray(receipt.attachmentIds) &&
        receipt.attachmentIds.length === 0 &&
        receipt.captureBundleId === null,
    );
    check(
      `receipt_${index + 1}_single_new_bug_snapshot`,
      receipt.disposition === "created" &&
        receipt.bug?.occurrenceCount === 1 &&
        receipt.bug?.version === 1 &&
        receipt.bug?.state === "reported",
    );
    const action = index < 4 ? "drop_before_headers" : "forward_valid_201";
    const filename = `upstream-create-${index + 1}.body`;
    check(
      `event_${index + 1}_request_and_receipt_hashes`,
      event?.ordinal === index + 1 &&
        event?.upstreamStatus === 201 &&
        event?.action === action &&
        event?.keySha256 === keySha256 &&
        event?.bodySha256 === bodySha256 &&
        event?.responseSha256 === sha256(files[filename]) &&
        event?.privateReceipt === filename,
    );
    check(
      `event_${index + 1}_canonical_ids`,
      Object.entries(canonicalIds).every(([key, value]) => event?.[key] === value),
    );
    actions.push({
      ordinal: index + 1,
      expectedAction: action,
      upstreamStatus: event?.upstreamStatus === 201 ? 201 : null,
      receiptSha256: sha256(files[filename]),
      replayed: receipt.replayed === true,
    });
  }
  check("fifth_is_replayed", receipts[4].replayed === true);
  check(
    "event_order",
    events.every(
      (event, index) =>
        Number.isSafeInteger(event.sequence) &&
        event.sequence > 0 &&
        (index === 0 || event.sequence > events[index - 1].sequence) &&
        Number.isFinite(Date.parse(event.at)),
    ),
  );
  const refused = events.filter((event) => event.kind === "refused");
  const expectedRefusal = (event) =>
    event.code === "AUTH_FINGERPRINT_REFUSED" &&
    event.method === "GET" &&
    event.targetSha256 === optionalUpdateGetSha256;
  check("only_exact_optional_update_refusals", refused.every(expectedRefusal));
  check("refusal_counter", status.denied === refused.length);
  check("no_adapter_failures", !events.some((event) => event.kind === "adapter_failure"));
  const bootstraps = events.filter((event) => event.kind === "native_bootstrap");
  check(
    "bootstrap_scope_and_count",
    status.bootstrapCount === bootstraps.length &&
      bootstraps.length <= 3 &&
      bootstraps.every(
        (event, index) =>
          event.status === 200 &&
          event.projectId === expected.projectId &&
          event.actorId === expected.actorId &&
          event.ordinal === index + 1,
      ),
  );
  const recordKinds = new Set([
    "native_create",
    "refused",
    "native_bootstrap",
    "project_entry",
    "project_list",
    "project_users",
    "project_read",
    "bug_list",
    "components",
    "bug_detail",
    "bound_bug_read",
  ]);
  check(
    "all_handled_requests_accounted",
    status.requests === events.filter((event) => recordKinds.has(event.kind)).length,
  );
  check(
    "no_unknown_event_kind",
    events.every(
      (event) =>
        recordKinds.has(event.kind) ||
        ["listening", "stop_requested", "stopped"].includes(event.kind),
    ),
  );
  const safeIds = Object.fromEntries(
    Object.entries(canonicalIds).map(([key, value]) => [key, uuid.test(value) ? value : null]),
  );
  return {
    schemaVersion: 1,
    kind: "read-only-android-proxy-artifact-audit",
    status: checks.every((item) => item.passed) ? "passed" : "failed",
    expectedScope: {
      runId: expected.runId,
      projectId: expected.projectId,
      actorId: expected.actorId,
    },
    expectedProxySha256,
    sourceArtifacts: inputNames.map((name) => ({
      name,
      sizeBytes: files[name].length,
      sha256: sha256(files[name]),
    })),
    originalRequest: {
      clientSubmissionId: uuid.test(original.clientSubmissionId)
        ? original.clientSubmissionId
        : null,
      keySha256,
      bodySha256,
    },
    canonicalServiceIds: safeIds,
    actions,
    checks,
    refusals: {
      total: refused.length,
      expectedOptionalUpdateGet: refused.filter(expectedRefusal).length,
      unexpected: refused.filter((event) => !expectedRefusal(event)).length,
      knownPath: optionalUpdateGet,
      knownPathSha256: optionalUpdateGetSha256,
    },
    runnerStopped: events.some((event) => event.kind === "stopped"),
    limits: {
      apiRequestedByAudit: false,
      deviceAccessedByAudit: false,
      proxyPortRequestedByAudit: false,
      rawBodiesPublished: false,
      authenticationReceiptBodiesRead: false,
      independentlyReadServerDatabase: false,
      independentlyReadNativeQueue: false,
      nativeGestureProvenByArtifactsAlone: false,
      numberOfAllServerBugsProven: false,
      prerequisiteGetBodies:
        "Only hashes and validated flags are retained by the pinned runner; original read payloads are not independently revalidated here.",
      conclusion:
        "Checks the pinned proxy's original request, five received API receipts and exact event/hash lineage. Independent official API count/readback and native UI/queue evidence remain necessary.",
    },
  };
}

function noLinks(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current)) guard(!lstatSync(current).isSymbolicLink(), "LINK_REFUSED");
    if (dirname(current) === current) break;
  }
}
function within(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function safePublic(report) {
  const text = JSON.stringify(report, null, 2) + "\n";
  guard(
    !/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~-]{12,}/u.test(
      text,
    ),
    "PUBLIC_SECRET_PATTERN_REFUSED",
  );
  return text;
}
export function auditFiles(privateDirectory, outputDirectory, projectId, actorId) {
  guard(isAbsolute(privateDirectory) && isAbsolute(outputDirectory), "ABSOLUTE_PATH_REQUIRED");
  const runId = relative(resolve(runtimeRoot), resolve(privateDirectory)).replace(
    /^android-recovery-proxy-/u,
    "",
  );
  guard(
    uuid.test(runId) &&
      resolve(privateDirectory) === resolve(runtimeRoot, `android-recovery-proxy-${runId}`),
    "PRIVATE_DIRECTORY_REFUSED",
  );
  const publicRoot = join(
    sourceRoot,
    "docs/evidence/project-components/android-recovery-proxy-audits",
  );
  guard(
    within(outputDirectory, publicRoot) && !existsSync(outputDirectory),
    "NEW_PUBLIC_DIRECTORY_REQUIRED",
  );
  noLinks(privateDirectory);
  noLinks(outputDirectory);
  guard(
    sha256(
      readFileSync(join(sourceRoot, "scripts/project-components/android-recovery-proxy.mjs")),
    ) === expectedProxySha256,
    "RUNNER_SOURCE_CHANGED",
  );
  const files = {};
  for (const name of inputNames) {
    const path = join(privateDirectory, name);
    noLinks(path);
    guard(
      lstatSync(path).isFile() &&
        lstatSync(path).size <= (name === "public-events.jsonl" ? 4 * 1024 * 1024 : 256 * 1024),
      "INPUT_SIZE_REFUSED",
    );
    files[name] = readFileSync(path);
  }
  const report = auditSnapshot(files, { runId, projectId, actorId });
  // One bounded before/after comparison; no polling and no mutable live-record interpretation.
  for (const name of inputNames)
    guard(
      sha256(readFileSync(join(privateDirectory, name))) === sha256(files[name]),
      "EVIDENCE_CHANGED_DURING_AUDIT",
    );
  const output = safePublic({
    ...report,
    auditedAt: new Date().toISOString(),
    auditScriptSha256: sha256(readFileSync(here)),
  });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, "proof.json"), output, { flag: "wx" });
  console.log(
    JSON.stringify({
      status: report.status,
      proof: join(outputDirectory, "proof.json"),
      checks: report.checks.length,
      failedChecks: report.checks.filter((item) => !item.passed).map((item) => item.code),
    }),
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  if (process.argv[2] !== "--audit")
    console.log(
      "not_run: requires --audit <private-run-directory> <new-public-output-directory> <projectId> <actorId>; no API/device/port operation",
    );
  else {
    guard(process.argv.length === 7, "ARGUMENTS_REQUIRED");
    try {
      if (auditFiles(...process.argv.slice(3)).status !== "passed") process.exitCode = 1;
    } catch {
      console.error(
        "AUDIT_NOT_COMPLETED: input absent, changing, malformed or outside reviewed bounds; no raw data printed",
      );
      process.exitCode = 1;
    }
  }
}
