import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
const root = fileURLToPath(new URL(".", import.meta.url));
const successful = join(
  root,
  "93ba2b78-ec31-41ad-a62e-540218654fc2/fd3648a5-61f9-4c17-8c44-fa6eb00e5341/result.json",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => sha(readFileSync(path));
const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
if (process.argv[2] !== "--run-readonly") {
  console.log(JSON.stringify({ status: "not_run" }));
  process.exit(0);
}
const proof = parse(successful),
  plan = parse(proof.planPath);
const { frozenVerificationResult } = await import(
  pathToFileURL(join(plan.sourceRoot, "apps/api/dist/frozen-workflow-response.js")).href
);
const result = {
  kind: "post_run_readonly_artifact_and_consistent_sql_audit",
  at: new Date().toISOString(),
  rawPath: successful,
  rawSha256: hashFile(successful),
  sourceSha256: hashFile(fileURLToPath(import.meta.url)),
  checks: [],
  evidence: {},
  boundaries: {
    readOnlyDatabase: true,
    noHttp: true,
    noServiceOperation: true,
    noProductionRead: true,
  },
};
function check(label, actual, expected) {
  const passed = isDeepStrictEqual(actual, expected);
  result.checks.push({ label, actual, expected, passed });
  if (!passed) throw new Error(label);
}
function fingerprint(db) {
  return Object.fromEntries(
    [
      "bugs",
      "repair_attempts",
      "verifications",
      "events",
      "submissions",
      "idempotency_records",
      "outbox",
      "bug_deletions",
      "verification_result_snapshots",
    ].map((table) => {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      return [table, { count: rows.length, sha256: sha(JSON.stringify(rows)) }];
    }),
  );
}
try {
  check(
    "raw source frozen hash",
    result.rawSha256,
    "2978f312e9047be9d58b95c6e6e7b624acba5e88ba548b22b0d62a54aea9ab84",
  );
  check(
    "all 246 checks independently actual equals expected",
    proof.checks.every((x) => x.passed && JSON.stringify(x.actual) === JSON.stringify(x.expected)),
    true,
  );
  check("request ledger exact", proof.requests.length, 115);
  const counts = Object.fromEntries(
    [4459, 4461].map((port) => [port, proof.requests.filter((x) => x.port === port).length]),
  );
  result.evidence.requestCounts = {
    directHttp: counts[4459],
    serverMcpJsonRpc: counts[4461],
    totalOnWireHarnessRequests: 115,
    note: "MCP internal app.inject mirrors are not counted as extra HTTP; readiness polling before ledger is excluded.",
  };
  check(
    "only permitted ports",
    proof.requests.every((x) => [4459, 4461].includes(x.port)),
    true,
  );
  check(
    "no executor routes",
    proof.requests.every(
      (x) => !/\/(production|packaging|increment-upload|build-chains|qingyu)(\/|$)/.test(x.path),
    ),
    true,
  );
  check("Phase B source pins retained", plan.sourcePins.length, 8);
  check("unfinished D dist excluded", plan.excludedD.length > 0, true);
  check(
    "before/after official shutdown domain unchanged",
    proof.databaseAfterStop.snapshot,
    proof.databaseBeforeStop.snapshot,
  );
  for (const p of proof.processes) {
    check(`owned ${p.role} exit`, p.exit.code, 0);
    if (p.role !== "selftest")
      check(
        `owned ${p.role} official SIGTERM`,
        p.shutdownMechanism,
        "IPC command emits SIGTERM into original official handlers",
      );
  }
  const pids = proof.processes.map((x) => x.pid);
  const host = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$ids=@(${pids.join(",")}); $live=@(Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | Select-Object ProcessId,CreationDate,ExecutablePath); $ports=@(Get-NetTCPConnection -LocalPort 4459,4461 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess); ConvertTo-Json -Depth 4 -Compress @{capturedAt=[DateTime]::UtcNow.ToString('o');ownedPids=$live;listeners=$ports}`,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  result.evidence.finalHost = host;
  const originalIdentities = host.ownedPids.filter((live) =>
    proof.processes.some(
      (owned) =>
        live.ProcessId === owned.pid &&
        String(live.ExecutablePath).toLowerCase() === owned.executable.toLowerCase() &&
        Date.parse(live.CreationDate) >= Date.parse(owned.startedAt) &&
        Date.parse(live.CreationDate) <= Date.parse(owned.exit.at),
    ),
  );
  result.evidence.reusedNumericPids = host.ownedPids.filter((x) => !originalIdentities.includes(x));
  check(
    "owned process identities absent (PID, executable, lifetime)",
    originalIdentities.length,
    0,
  );
  check("4459/4461 listeners absent", host.listeners.length, 0);
  const archivePaths = ["consistent-before-stop.sqlite", "consistent-after-stop.sqlite"].map((p) =>
    join(proof.privateRoot, p),
  );
  result.evidence.archives = [];
  for (const path of archivePaths) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("BEGIN");
      const fingerprintValue = fingerprint(db);
      check(`${path} exact domain readback`, fingerprintValue, proof.databaseBeforeStop.snapshot);
      check(`${path} integrity`, db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      check(`${path} foreign keys`, db.prepare("PRAGMA foreign_key_check").all(), []);
      db.exec("COMMIT");
      result.evidence.archives.push({
        path,
        sha256: hashFile(path),
        bytes: readFileSync(path).length,
        fingerprint: fingerprintValue,
      });
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(archivePaths[1], { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshots = db
      .prepare("SELECT * FROM verification_result_snapshots ORDER BY created_at,id")
      .all();
    check("seven immutable result receipts retained", snapshots.length, 7);
    result.evidence.receipts = [];
    for (const row of snapshots) {
      const dto = JSON.parse(row.response_json),
        event = db
          .prepare(
            "SELECT id,type,actor_user_id,project_id,bug_id,resource_id,resource_version_after,request_digest FROM events WHERE id=?",
          )
          .get(row.event_id);
      check(`${row.id} event actor binding`, event.actor_user_id, row.actor_id);
      check(`${row.id} event digest`, event.request_digest, row.request_digest);
      check(`${row.id} project`, event.project_id, row.project_id);
      check(`${row.id} bug`, event.bug_id, row.bug_id);
      check(`${row.id} event Verification identity`, event.resource_id, row.verification_id);
      check(
        `${row.id} event typed result version`,
        event.resource_version_after,
        dto.verification.version,
      );
      check(
        `${row.id} unique typed result event`,
        db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE resource_id=? AND type='verification.result_recorded'",
          )
          .get(row.verification_id).n,
        1,
      );
      const http = proof.requests.find(
        (x) => x.path === `/api/v1/verifications/${row.verification_id}/result` && x.status === 200,
      );
      if (http) {
        check(
          `${row.id} HTTP original complete negotiated DTO projection exact`,
          http.response,
          JSON.parse(
            JSON.stringify(frozenVerificationResult(dto, http.responseHeaders.contentType)),
          ),
        );
      } else {
        const rpc = proof.requests.find(
          (x) =>
            x.port === 4461 &&
            x.response?.result?.structuredContent?.result?.eventId === row.event_id,
        );
        check(
          `${row.id} MCP original full DTO exact`,
          rpc.response.result.structuredContent.result,
          dto,
        );
      }
      result.evidence.receipts.push({
        snapshotId: row.id,
        projectId: row.project_id,
        bugId: row.bug_id,
        verificationId: row.verification_id,
        actorId: row.actor_id,
        assignedVerifierId: dto.verification.verifierId,
        eventId: row.event_id,
        eventType: event.type,
        operation: row.operation_id,
        bytes: Buffer.byteLength(row.response_json),
        responseSha256: sha(row.response_json),
        resultStatus: dto.verification.status,
        bugVersion: dto.bug.version,
        verificationVersion: dto.verification.version,
        attemptId: dto.repairAttempt.id,
        parentAttemptId: dto.repairAttempt.parentAttemptId,
      });
    }
    check(
      "ordinary human closure by another active employee preserved",
      result.evidence.receipts.filter((x) => x.actorId !== x.assignedVerifierId).length,
      1,
    );
    check(
      "valid successor round preserved",
      result.evidence.receipts.filter((x) => x.parentAttemptId !== null).length,
      2,
    );
    check(
      "four blocked immutable snapshots",
      result.evidence.receipts.filter((x) => x.resultStatus === "blocked").length,
      4,
    );
    check(
      "three passed immutable snapshots",
      result.evidence.receipts.filter((x) => x.resultStatus === "passed").length,
      3,
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const privateSecrets = Object.values(parse(plan.config.secretsFile));
  for (const name of ["api-process.json", "mcp-process.json"]) {
    const record = parse(join(proof.privateRoot, name));
    check(`${name} no guard denial`, existsSync(record.guardLog), false);
  }
  const rawText = readFileSync(successful, "utf8");
  check(
    "exact instance secret values absent from public raw",
    privateSecrets.every((x) => !rawText.includes(x)),
    true,
  );
  check(
    "JSON-RPC primitive version preserved",
    proof.requests
      .filter((x) => x.port === 4461)
      .every(
        (x) => x.body.jsonrpc === "2.0" && (x.response === null || x.response.jsonrpc === "2.0"),
      ),
    true,
  );
  result.status = "passed";
} catch (error) {
  result.status = "failed_retained";
  result.failure = error.message;
}
result.checkCounts = {
  total: result.checks.length,
  passed: result.checks.filter((x) => x.passed).length,
};
const output = join(root, `audit-${Date.now()}.json`);
writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    status: result.status,
    output,
    sha256: hashFile(output),
    checks: result.checkCounts,
    failure: result.failure,
  }),
);
