// Artifact-only audit. No HTTP, browser, device, process or profile access.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, "../../../../..");
const firstId = "97e972b8-4a90-48b7-bebe-8b49c58eed15";
const proof = JSON.parse(await fs.readFile(path.join(here, "proof.json"), "utf8"));
const privateRoot = path.resolve(proof.runtime);
const prep = path.join(workspace, "docs/evidence/project-components/web-project-switch-draft-preparation/92f622d8-49b9-4f10-a580-3463722b630d");
const checks = [];
const files = [];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function check(label, actual, expected = true) {
  const passed = isDeepStrictEqual(actual, expected);
  checks.push({ label, passed, actual, expected });
  if (!passed) throw new Error(`ARTIFACT_CHECK_FAILED: ${label}`);
}
function contained(file, root) {
  const relative = path.relative(root, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("ARTIFACT_PATH_REFUSED");
  return path.resolve(file);
}
async function fileHash(file, expected) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ARTIFACT_FILE_REFUSED");
  const bytes = await fs.readFile(file);
  const item = { path: path.resolve(file), size: bytes.length, sha256: sha(bytes) };
  files.push(item);
  if (expected) check(`SHA ${path.basename(file)}`, item.sha256, expected);
  return item;
}
async function jsonRaw(entry, root = privateRoot) {
  const location = contained(entry.rawPath, path.join(root, "raw"));
  await fileHash(location, entry.sha256);
  const bytes = await fs.readFile(location);
  check(`raw bytes ${path.basename(location)}`, bytes.length, entry.bytes ?? entry.sizeBytes);
  return JSON.parse(bytes);
}

const originalPublicFiles = (await fs.readdir(here)).filter((name) => name === "proof.json" || name === "runner.mjs.txt" || name.endsWith(".png"));
const before = await Promise.all(originalPublicFiles.map((name) => fileHash(path.join(here, name))));
check("ten original public artifacts", before.length, 10);
check("run status", proof.status, "passed");
check("164 actual checks", proof.checks.length, 164);
for (const item of proof.checks) check(`recomputed run check: ${item.label}`, item.actual, item.expected);
check("reported actual checks all passed", proof.checks.every((item) => item.passed === true));
const publicProof = before.find((item) => path.basename(item.path) === "proof.json");
await fileHash(path.join(privateRoot, "proof.json"), publicProof.sha256);
await fileHash(path.join(here, "runner.mjs.txt"), proof.sourceSha256);
await fileHash(path.join(privateRoot, "runner.mjs"), proof.sourceSha256);
await fileHash(path.join(workspace, "scripts/project-components/web-project-switch-draft-live.mjs"), proof.sourceSha256);
await fileHash(path.join(workspace, "scripts/project-components/web-project-switch-draft-live.test.mjs"), "d10188a3c81838698c10157d80f569aadd4b0b283bd78e4a478ea8e0b359a7ec");
await fileHash(proof.gate.gatePath, proof.gate.gateSha256);
await fileHash(proof.gate.publicationProof.path, proof.gate.publicationProof.sha256);
// Configuration bytes are hashed only and are never parsed or displayed.
await fileHash(path.join(path.dirname(privateRoot), "instance.json"), proof.gate.instanceSha256);
const stats = Object.fromEntries([...new Set(proof.requests.map((entry) => entry.kind))].map((kind) => [kind, proof.requests.filter((entry) => entry.kind === kind).length]));
check("request/response ledger counts", stats, { fixture_api: 18, browser_request: 47, browser_real_response: 28 });
const posts = proof.requests.filter((entry) => entry.method === "POST");
check("eight allowed authentication/setup POSTs", posts.length, 8);
check("POST allowlist", posts.every((entry) => ["/api/v1/auth/gm/login", "/api/v1/gm/projects", "/api/v1/auth/login"].includes(entry.path)));
check("two new project POST IDs", posts.filter((entry) => entry.path === "/api/v1/gm/projects").map((entry) => entry.requestBody.id), proof.projectIds);
check("one browser login and no browser business POST", posts.filter((entry) => entry.kind === "browser_request").map((entry) => entry.category), ["login"]);
check("new shared and exclusive employees distinct", new Set([proof.actorId, ...proof.onlyActorIds]).size, 3);
const raw = new Map();
for (const entry of proof.requests.filter((item) => item.rawPath)) raw.set(entry.rawPath, await jsonRaw(entry));
check("40 non-auth raw bodies rehashed", raw.size, 40);
for (let i = 0; i < 2; i++) {
  const expectedPeople = [proof.gmActorId, proof.actorId, proof.onlyActorIds[i]].sort();
  const member = proof.requests.find((entry) => entry.label === `initial-members-${i}`);
  check(`project ${i} includes actual creator/shared/exclusive`, raw.get(member.rawPath).items.map((item) => item.userId).sort(), expectedPeople);
  const empty = proof.requests.find((entry) => entry.label === `final-empty-${i}`);
  check(`project ${i} final official Bug list empty`, raw.get(empty.rawPath).items, []);
  const components = proof.requests.find((entry) => entry.label === `final-five-off-${i}`);
  check(`project ${i} final component scope`, raw.get(components.rawPath).projectId, proof.projectIds[i]);
  check(`project ${i} five off`, raw.get(components.rawPath).items.map((item) => item.enabled), [false, false, false, false, false]);
  const media = proof.media[i];
  await fileHash(contained(media.path, privateRoot), media.sha256);
  const drafts = proof.drafts.filter((entry) => entry.projectId === proof.projectIds[i]);
  check(`project ${i} several durable checkpoints`, drafts.length >= 5);
  for (const draft of drafts) {
    check(`draft ${draft.label} exact scoped key`, draft.key, `qa-hub:preview:v2:${JSON.stringify(["http://127.0.0.1:4274", proof.projectIds[i], proof.actorId, "bug-drafts"])}`);
    check(`draft ${draft.label} unsubmitted text`, draft.newContent, `UNSUBMITTED_${i === 0 ? "A" : "B"}_PROJECT_SWITCH_${proof.runId}`);
    check(`draft ${draft.label} owner`, draft.newOwnerId, proof.onlyActorIds[i]);
    check(`draft ${draft.label} verifier`, draft.newVerifierId, proof.actorId);
    check(`draft ${draft.label} PNG File`, draft.newFiles.map(({ name, type, size, sha256 }) => ({ name, type, size, sha256 })), [{ name: media.name, type: "image/png", size: media.size, sha256: media.sha256 }]);
  }
}
check("13 durable checkpoints", proof.drafts.length, 13);
const late = proof.lateScenario;
const action = (name) => proof.holds.find((entry) => entry.action === name);
const held = action("hold_A_members_real_200");
const switched = action("begin_actual_A_to_B_switch");
const canceled = action("target_network_failure");
const verified = action("B_verified_before_A_settlement");
const settled = action("expected_project_switch_cancellation");
check("true Abort path recorded", late.settlement, "canceled");
check("same Network ID across request hold switch and cancellation", [held.networkId, switched.networkId, canceled.networkId, settled.failure.networkId], Array(4).fill(late.networkId));
check("exact cancellation true", canceled.canceled, true);
check("cancellation happened after switch", Date.parse(canceled.at) >= Date.parse(switched.at));
check("B verified before cancellation accepted", Date.parse(settled.at) >= Date.parse(verified.at));
check("settled project B", settled.verifiedProjectId, proof.projectIds[1]);
check("original genuine A body hash", held.sha256, late.bodySha256);
check("controlled window below 15 seconds", Date.parse(settled.at) - Date.parse(held.at) < 15000);
const heldResponse = proof.requests.find((entry) => entry.kind === "browser_real_response" && entry.networkId === late.networkId);
check("held response was 200", heldResponse.status, 200);
check("held response raw binding", heldResponse.sha256, late.bodySha256);
check("held original A member set", raw.get(heldResponse.rawPath).items.map((item) => item.userId).sort(), [proof.gmActorId, proof.actorId, proof.onlyActorIds[0]].sort());
check("target was never continued after confirmed cancellation", proof.holds.filter((entry) => entry.requestId === late.requestId && entry.action === "release_real_response_unmodified"), []);
check("zero unreleased real responses", proof.unreleasedRealResponses, []);
check("normal own browser close", proof.processes.map((entry) => entry.phase), ["launched", "normal_close"]);
check("same browser PID", proof.processes[0].pid, proof.processes[1].pid);
check("own browser exited", proof.processes[1].exited, true);
check("no forced stop", proof.boundaries.forcedStop, false);
const screenshots = proof.checkpoints.filter((entry) => entry.kind === "screenshot");
check("eight screenshot checkpoints", screenshots.length, 8);
for (const item of screenshots) {
  await fileHash(contained(item.path, privateRoot), item.sha256);
  await fileHash(path.join(here, path.basename(item.path)), item.sha256);
}
const firstDir = path.join(path.dirname(here), firstId);
const first = JSON.parse(await fs.readFile(path.join(firstDir, "proof.json"), "utf8"));
const firstPublic = await fileHash(path.join(firstDir, "proof.json"));
await fileHash(path.join(first.runtime, "proof.json"), firstPublic.sha256);
await fileHash(path.join(firstDir, "runner.mjs.txt"), first.sourceSha256);
await fileHash(path.join(first.runtime, "runner.mjs"), first.sourceSha256);
check("first attempt retained as failure", first.status, "failed_retained");
check("first attempt no browser launch", first.processes, []);
check("first failure was actual creator member", first.checks.filter((entry) => !entry.passed).map((entry) => entry.label), ["exact fixture members 0"]);
for (const entry of first.requests.filter((item) => item.rawPath)) await jsonRaw(entry, first.runtime);
await fileHash(first.gate.gatePath, first.gate.gateSha256);
for (const name of ["checks.json", "checks-r2.json", "gate-reference.json", "gate-reference-r2.json", "actual-first-run.log.txt", "actual-second-run.log.txt", "pure-tests.txt", "pure-tests-r2.txt"]) await fileHash(path.join(prep, name));
for (const original of before) check(`original public unchanged ${path.basename(original.path)}`, sha(await fs.readFile(original.path)), original.sha256);
const audit = {
  schemaVersion: 1,
  status: "passed",
  auditedAt: new Date().toISOString(),
  runId: proof.runId,
  mode: "artifact_only_same_agent_followup",
  noNetworkBrowserDeviceOrProfileAccess: true,
  originalProof: publicProof,
  retainedFirstFailure: firstPublic,
  checkCount: checks.length,
  checks,
  files,
  requestLedger: { ...stats, note: "93 is a mixed ledger count, not HTTP request count; eight asset preflights are separately checked." },
  lateResponse: { networkId: late.networkId, settlement: late.settlement, heldAt: held.at, switchAt: switched.at, canceledAt: canceled.at, bVerifiedAt: verified.at, settledAt: settled.at, holdToSettlementMs: Date.parse(settled.at) - Date.parse(held.at) },
  visualReview: { performedBy: "same executing agent via local image inspection", screenshots: screenshots.map(({ label, sha256 }) => ({ label, sha256 })), observations: ["A red PNG and A text/owner recur in frames 01/07; B blue PNG and B text/owner recur in 02/04/05/06/08.", "Frame 03 shows the A workbench during the genuine response hold; request timing comes from the ledger, not pixels.", "The open modal blurs project text; exact URL/project/UUID assertions come from observed DOM and scoped draft reads. Long names/file labels are visibly truncated."] },
  limits: [...proof.limits, "The actual trajectory is Abort cancellation, not delivery of a stale A callback into B.", "Authentication response bodies were intentionally not stored; their hashes cannot be recomputed from retained bodies.", "This audit hashes stored records; it does not repeat live API/process/port observation or re-open the browser profile.", "No continuous-frame absence claim, 15-second timeout execution, full browser process restart, cross-user/origin, existing-client preservation or submission success is inferred."],
};
await fs.writeFile(path.join(here, "artifact-audit.json"), JSON.stringify(audit, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: audit.status, checkCount: audit.checkCount, fileEntries: files.length, originalProofSha256: publicProof.sha256, firstFailureSha256: firstPublic.sha256 }));
