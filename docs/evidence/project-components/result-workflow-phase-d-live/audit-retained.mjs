import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const base =
  "C:/Users/lin0/.codex/parallel-runtimes/result-workflow-d-69618261-6c5a-4092-a8a6-2168a2768c8e";
const runId = "667b0e87-e0fd-44bd-8bb3-c0506dbf5b81";
const evidence = new URL(`./69618261-6c5a-4092-a8a6-2168a2768c8e/${runId}/`, import.meta.url);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fileSha = (p) => sha(readFileSync(p));
const resultPath = new URL("result.json", evidence);
const proof = read(resultPath),
  plan = read(join(base, "plan.json"));
const audit = {
  kind: "author_readonly_postrun_audit",
  createdAt: new Date().toISOString(),
  checks: [],
  processes: [],
  archives: [],
  snapshots: [],
  wireResults: 0,
  status: "running",
};
function check(label, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  audit.checks.push({ label, actual, expected, passed });
  if (!passed) throw new Error("AUDIT_FAILED:" + label);
}
try {
  check(
    "original result SHA",
    fileSha(resultPath),
    "a20f087468dd5bd29adef84359662313d6755ecde0c76c8ea4624b87fe18a08b",
  );
  check(
    "plan SHA",
    fileSha(join(base, "plan.json")),
    "dfe24ec1c116629f730150b0290de58a0ad8a05b7f1b8f3c174a321781b503e2",
  );
  check("actual outcome", proof.status, "passed");
  check(
    "all 665 original assertions",
    [proof.checkCounts.total, proof.checkCounts.passed],
    [665, 665],
  );
  check("ready schema is literal string 17", proof.ready.schemaVersion, "17");
  check("ready status", proof.ready.status, "ready");
  check(
    "ready database/evidence/worker",
    proof.ready.checks.map((x) => [x.name, x.status]),
    [
      ["database", "ok"],
      ["evidence", "ok"],
      ["worker", "ok"],
    ],
  );
  check("241 real requests", proof.requests.length, 241);
  check(
    "HTTP/server MCP network lanes",
    [
      proof.requests.filter((x) => x.port === 4459).length,
      proof.requests.filter((x) => x.port === 4461).length,
    ],
    [183, 58],
  );
  const pids = proof.processes.map((x) => x.pid);
  check(
    "only safe positive integer PID selectors",
    pids.every((x) => Number.isSafeInteger(x) && x > 0),
    true,
  );
  const cmd = `$p=@(Get-CimInstance Win32_Process -Filter '${pids.map((x) => `ProcessId = ${x}`).join(" OR ")}' | ForEach-Object { @{pid=$_.ProcessId;exe=$_.ExecutablePath;createdAt=$_.CreationDate.ToUniversalTime().ToString('o')} }); $l=@(Get-NetTCPConnection -LocalPort 4459,4461 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{port=$_.LocalPort;pid=$_.OwningProcess} }); ConvertTo-Json -Depth 5 -Compress @{processes=$p;listeners=$l}`;
  const live = JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  check("owned ports no longer listen", live.listeners, []);
  check(
    "four real service process lifetimes",
    proof.processes.filter((x) => x.role !== "selftest").length,
    4,
  );
  for (const p of proof.processes) {
    check(`${p.label} actual child exit`, p.exit.code, 0);
    check(`${p.label} executable matches frozen Node`, p.executable, plan.node.path);
    const samePid = live.processes.find((x) => x.pid === p.pid);
    const reusedAfterExit = samePid ? Date.parse(samePid.createdAt) > Date.parse(p.exit.at) : false;
    audit.processes.push({
      label: p.label,
      pid: p.pid,
      exe: p.executable,
      startedAt: p.startedAt,
      exit: p.exit,
      currentIdentity: samePid ?? null,
      reusedAfterExit,
    });
    // Child exit is authoritative. A later CIM creation time belongs to a new process,
    // even if Windows reused both PID and executable; no action is taken on that process.
    check(
      `${p.label} absent or demonstrably reused after original exit`,
      !samePid || reusedAfterExit,
      true,
    );
    if (p.role !== "selftest") {
      check(
        `${p.label} official graceful shutdown`,
        p.shutdownMechanism,
        "IPC command emits SIGTERM into original official handlers",
      );
      check(
        `${p.label} zero external attempts`,
        existsSync(p.guardLog) ? readFileSync(p.guardLog, "utf8") : "",
        "",
      );
    }
  }
  const dbPath = join(plan.config.dataRoot, "db/qa-hub.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const snapshots = [];
  try {
    check(
      "actual database PRAGMA user_version",
      db.prepare("PRAGMA user_version").get().user_version,
      17,
    );
    check(
      "actual database integrity",
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    check("actual database foreign keys", db.prepare("PRAGMA foreign_key_check").all(), []);
    check(
      "no enabled components",
      db.prepare("SELECT count(*) AS n FROM project_components WHERE enabled=1").get().n,
      0,
    );
    for (const s of db.prepare("SELECT * FROM verification_result_snapshots ORDER BY id").all()) {
      const dto = JSON.parse(s.response_json),
        event = db.prepare("SELECT * FROM events WHERE id=?").get(s.event_id);
      const r = db
        .prepare(
          "SELECT * FROM idempotency_records WHERE account_id=? AND project_id=? AND actor_id=? AND operation_id=? AND idempotency_key=?",
        )
        .get(s.account_id, s.project_id, s.actor_id, s.operation_id, s.idempotency_key);
      check(
        `${s.id} exact original snapshot identities`,
        [dto.eventId, dto.bug.id, dto.verification.id, dto.replayed],
        [s.event_id, s.bug_id, s.verification_id, false],
      );
      check(
        `${s.id} same-scope actor/event binding`,
        [
          event.account_id,
          event.project_id,
          event.actor_user_id,
          event.resource_id,
          event.resource_version_after,
          event.request_digest,
        ],
        [
          s.account_id,
          s.project_id,
          s.actor_id,
          s.verification_id,
          dto.verification.version,
          s.request_digest,
        ],
      );
      check(
        `${s.id} committed immutable pointer`,
        [r.status, r.audit_event_id, r.request_digest, JSON.parse(r.response_json).snapshotId],
        ["committed", s.event_id, s.request_digest, s.id],
      );
      audit.snapshots.push({
        id: s.id,
        projectId: s.project_id,
        bugId: s.bug_id,
        verificationId: s.verification_id,
        actorId: s.actor_id,
        status: dto.verification.status,
        originalBugVersion: dto.bug.version,
        originalVerificationVersion: dto.verification.version,
        responseSha256: sha(s.response_json),
      });
      snapshots.push({ row: s, dto });
    }
    check("twelve original result snapshots", snapshots.length, 12);
    check(
      "persisted workflow snapshot sets exist",
      db.prepare("SELECT count(*) AS n FROM workflow_projection_snapshots").get().n > 0,
      true,
    );
    audit.workflow = db
      .prepare(
        "SELECT id,project_id,actor_id,bug_id,bug_version,snapshot_sequence,limit_per_collection,item_count,byte_count FROM workflow_projection_snapshots ORDER BY id",
      )
      .all();
  } finally {
    db.close();
  }
  const { frozenVerificationResult } = await import(
    pathToFileURL(join(plan.sourceRoot, "apps/api/dist/frozen-workflow-response.js"))
  );
  for (const r of proof.requests) {
    let value, media;
    if (r.port === 4459 && /\/verifications\/[^/]+\/result$/.test(r.path) && r.status === 200) {
      value = r.response;
      media = r.responseHeaders.contentType.split(";")[0];
    } else if (
      r.port === 4461 &&
      r.body?.method === "tools/call" &&
      r.body.params?.name === "qa_record_verification_result" &&
      r.response?.result?.isError === false
    ) {
      value = r.response.result.structuredContent;
      media = "application/vnd.relay-qa-hub.v1.1+json";
      check(`${r.sequence} JSON-RPC literal`, r.response.jsonrpc, "2.0");
      check(
        `${r.sequence} MCP two JSON mirrors`,
        JSON.parse(r.response.result.content[0].text),
        value,
      );
    }
    if (value) {
      const s = snapshots.find((x) => x.row.verification_id === value.verification.id);
      check(`${r.sequence} wire result has original stored source`, Boolean(s), true);
      check(
        `${r.sequence} exact original wire projection`,
        value,
        frozenVerificationResult({ ...s.dto, replayed: value.replayed === true }, media),
      );
      audit.wireResults++;
    }
    if (r.path.includes("/workflow") && r.status === 200) {
      check(
        `${r.sequence} workflow vendor media`,
        r.responseHeaders.contentType.split(";")[0],
        "application/vnd.relay-qa-hub.v1.1+json",
      );
      check(
        `${r.sequence} workflow exact public keys`,
        Object.keys(r.response).sort(),
        [
          "bugId",
          "bugVersion",
          "snapshotSequence",
          "truncated",
          "nextCursor",
          "occurrences",
          "repairAttempts",
          "verifications",
          "builds",
          "relayReceipts",
        ].sort(),
      );
    }
  }
  for (const name of ["consistent-before-stop.sqlite", "consistent-after-stop.sqlite"]) {
    const path = join(base, "runs", runId, name),
      db = new DatabaseSync(path, { readOnly: true });
    try {
      check(`${name} PRAGMA17`, db.prepare("PRAGMA user_version").get().user_version, 17);
      check(`${name} integrity`, db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      check(`${name} FK`, db.prepare("PRAGMA foreign_key_check").all(), []);
      const rows = db
        .prepare("SELECT id,response_json FROM verification_result_snapshots ORDER BY id")
        .all();
      check(
        `${name} all immutable bytes retained`,
        rows.map((x) => [x.id, sha(x.response_json)]),
        audit.snapshots.map((x) => [x.id, x.responseSha256]),
      );
      audit.archives.push({ path, bytes: lstatSync(path).size, sha256: fileSha(path) });
    } finally {
      db.close();
    }
  }
  check(
    "online backups match after graceful stop",
    audit.archives[0].sha256,
    audit.archives[1].sha256,
  );
  check(
    "held executors remain paused",
    read(join(plan.config.dataRoot, ".qa-hub-import-hold.json")).state,
    "paused",
  );
  function tree(root, prefix = "") {
    return readdirSync(join(root, prefix), { withFileTypes: true })
      .flatMap((e) => {
        const p = join(prefix, e.name),
          f = join(root, p);
        if (lstatSync(f).isSymbolicLink()) throw new Error("CLOSURE_LINK");
        return e.isDirectory()
          ? tree(root, p)
          : [{ path: p.split(sep).join("/"), bytes: lstatSync(f).size, sha256: fileSha(f) }];
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  const expected = read(join(base, "closure.json")).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  check("all 5815 frozen source bytes remain", tree(plan.sourceRoot), expected);
  // Avoid embedding all source file details twice in the audit; both full lists have
  // just been compared above and the original closure file remains separately pinned.
  audit.checks.at(-1).actual = { files: expected.length, sha256: sha(JSON.stringify(expected)) };
  audit.checks.at(-1).expected = { files: expected.length, sha256: sha(JSON.stringify(expected)) };
  const secretValues = Object.values(read(plan.config.secretsFile));
  const publicText = readFileSync(resultPath, "utf8");
  check(
    "public result contains none of independent private secret values",
    secretValues.some((x) => publicText.includes(x)),
    false,
  );
  check(
    "public result has no unredacted Bearer literal",
    /Bearer\s+(?!\[REDACTED\])[^\s"\\]+/.test(publicText),
    false,
  );
  audit.status = "passed";
} catch (error) {
  audit.status = "failed_retained";
  audit.failure = { name: error.name, message: error.message };
}
audit.completedAt = new Date().toISOString();
audit.checkCount = {
  total: audit.checks.length,
  passed: audit.checks.filter((x) => x.passed).length,
};
const out = new URL(`audit-${Date.now()}.json`, evidence);
writeFileSync(out, JSON.stringify(audit, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    status: audit.status,
    checks: audit.checkCount,
    path: out.pathname,
    sha256: fileSha(out),
    failure: audit.failure,
  }),
);
if (audit.status !== "passed") process.exitCode = 1;
