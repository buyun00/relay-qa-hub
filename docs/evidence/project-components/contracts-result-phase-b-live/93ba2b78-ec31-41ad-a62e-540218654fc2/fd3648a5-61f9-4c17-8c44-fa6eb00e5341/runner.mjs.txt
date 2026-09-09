import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  existsSync,
  copyFileSync,
  constants,
} from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const evidenceRoot = join(repo, "docs/evidence/project-components/contracts-result-phase-b-live");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function requireTrue(value, label) {
  if (!value) throw new Error(label);
}
function files(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const name = join(prefix, e.name),
      path = join(root, e.name);
    requireTrue(!lstatSync(path).isSymbolicLink(), "SOURCE_LINK_REFUSED");
    return e.isDirectory() ? files(path, name) : [name];
  });
}
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  requireTrue(fileHash(from) === fileHash(to), "COPY_HASH_MISMATCH");
}
function tree(root) {
  return files(root)
    .sort()
    .map((path) => ({
      path: path.split(sep).join("/"),
      bytes: lstatSync(join(root, path)).size,
      sha256: fileHash(join(root, path)),
    }));
}
function copyTree(from, to, excludes = () => false) {
  for (const path of files(from)) if (!excludes(path)) copy(join(from, path), join(to, path));
}
function packageRoot(req, name) {
  let path = dirname(req.resolve(name));
  while (true) {
    if (existsSync(join(path, "package.json")) && json(join(path, "package.json")).name === name)
      return path;
    const parent = dirname(path);
    requireTrue(parent !== path, "PACKAGE_ROOT_NOT_FOUND");
    path = parent;
  }
}
function packageCopy(from, to, ancestors = []) {
  const rel = relative(repo, from);
  requireTrue(
    rel && !rel.startsWith("..") && !resolve(from).toLowerCase().startsWith("d:"),
    "DEPENDENCY_OUTSIDE_WORKTREE",
  );
  const manifest = json(join(from, "package.json"));
  if (ancestors.includes(from)) return;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const source = join(from, entry.name),
      target = join(to, entry.name);
    requireTrue(!entry.isSymbolicLink(), "PACKAGE_LINK_REFUSED");
    if (entry.isDirectory()) copyTree(source, target);
    else copy(source, target);
  }
  const req = createRequire(join(from, "package.json"));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    let source;
    try {
      source = packageRoot(req, name);
    } catch (error) {
      if (manifest.optionalDependencies?.[name]) continue;
      throw error;
    }
    packageCopy(source, join(to, "node_modules", name), [...ancestors, from]);
  }
}
async function prepare(parentPath, parentSha) {
  const sourceProof = {
    source: [
      "apps/api/src/mobile-verification.ts",
      "apps/api/src/sqlite-mobile-verification-store.ts",
      "packages/storage/src/mobile-verification-store.ts",
      "packages/storage/src/verification-blocked-result-migration.ts",
      "packages/storage/src/sqlite-migrations.ts",
      "apps/api/test/verification-result-phase-b.test.mjs",
      "apps/api/src/frozen-workflow-response.ts",
      "apps/api/src/app.ts",
    ].map((path) => ({
      path,
      bytes: lstatSync(join(repo, path)).size,
      sha256: fileHash(join(repo, path)),
    })),
  };
  let parent;
  if (parentPath) {
    requireTrue(fileHash(parentPath) === parentSha, "PARENT_PIN_MISMATCH");
    parent = json(parentPath);
    requireTrue(
      JSON.stringify(tree(parent.sourceRoot)) ===
        JSON.stringify(json(join(parent.base, "closure.json"))),
      "PARENT_CLOSURE_CHANGED",
    );
  }
  for (const row of parent ? [] : sourceProof.source)
    requireTrue(
      fileHash(join(repo, row.path)) === row.sha256,
      `PHASE_B_SOURCE_CHANGED:${row.path}`,
    );
  const id = randomUUID(),
    base = join("C:/Users/lin0/.codex/parallel-runtimes", `result-phase-b-${id}`);
  const sourceRoot = join(base, "source"),
    runtimeRoot = join(base, "runtime"),
    evidence = join(evidenceRoot, id);
  mkdirSync(base);
  mkdirSync(sourceRoot);
  mkdirSync(runtimeRoot);
  mkdirSync(evidence, { recursive: true });
  const instanceId = `qa-hub-preview-result-b-${id.slice(0, 8)}`;
  const config = {
    schemaVersion: 1,
    instanceId,
    sourceRoot,
    runtimeRoot,
    ...Object.fromEntries(
      ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"].map((x) => [
        x,
        join(runtimeRoot, x),
      ]),
    ),
    apiHost: "127.0.0.1",
    apiPort: 4459,
    webHost: "127.0.0.1",
    webPort: 4458,
    mcpPort: 4461,
    desktopMcpPort: 4460,
    cookieName: `${instanceId}-session`,
    gmUserId: randomUUID(),
    secretsFile: join(runtimeRoot, "secrets.json"),
    peopleFile: join(runtimeRoot, "people.json"),
    releaseChannel: instanceId,
  };
  for (const key of ["dataRoot", "backupRoot", "downloadsRoot", "logsRoot", "desktopRoot"])
    mkdirSync(config[key]);
  save(
    config.secretsFile,
    Object.fromEntries(
      ["sessionSecret", "debugToken", "gmPassword"].map((x) => [
        x,
        randomBytes(48).toString("hex"),
      ]),
    ),
  );
  save(config.peopleFile, { schemaVersion: 4, projectKey: "LOCAL", people: [] });
  save(join(config.dataRoot, ".qa-hub-import-hold.json"), {
    markerVersion: 1,
    state: "paused",
    reason: "Independent Phase B E2E: no external execution authorized",
    heldExecutors: ["relay-outbox", "upload", "build", "qingyu-sync", "scheduled-jobs"],
  });
  const configPath = join(runtimeRoot, "instance.json");
  save(configPath, config);
  const excluded = [];
  if (parent) {
    copyTree(
      parent.sourceRoot,
      sourceRoot,
      (p) => p.replaceAll("\\", "/") === "scripts/project-components/result-phase-b-guard.mjs",
    );
    copy(
      join(repo, "scripts/project-components/result-phase-b-guard.mjs"),
      join(sourceRoot, "scripts/project-components/result-phase-b-guard.mjs"),
    );
    excluded.push(...parent.excludedD);
  } else {
    for (const name of ["apps/api", "packages/storage"]) {
      copy(join(repo, name, "package.json"), join(sourceRoot, name, "package.json"));
      copyTree(join(repo, name, "dist"), join(sourceRoot, name, "dist"), (path) => {
        if (/^(?:sqlite-)?workflow-projection/.test(path)) {
          excluded.push(`${name}/dist/${path}`);
          return true;
        }
        return false;
      });
    }
    copyTree(
      join(repo, "packages/upload-contract"),
      join(sourceRoot, "packages/upload-contract"),
      (p) => p.startsWith("node_modules"),
    );
    for (const name of ["storage", "upload-contract"])
      copyTree(
        join(sourceRoot, "packages", name),
        join(sourceRoot, "node_modules/@relay-qa-hub", name),
      );
    const req = createRequire(join(repo, "apps/api/package.json"));
    for (const name of ["fastify", "pinyin-pro"])
      packageCopy(packageRoot(req, name), join(sourceRoot, "node_modules", name));
    for (const path of [
      "apps/api/src/parallel-instance.ts",
      "scripts/project-components/run-preview-service.mjs",
      "scripts/project-components/preview-mcp.mjs",
      "scripts/project-components/result-phase-b-guard.mjs",
      "scripts/project-components/result-phase-b-guard-selftest.mjs",
    ])
      copy(join(repo, path), join(sourceRoot, path));
  }
  const closure = tree(sourceRoot);
  save(join(base, "closure.json"), closure);
  save(join(evidence, "closure.json"), closure);
  const plan = {
    id,
    preparedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    phaseAParentCommit: "2d687b4",
    phaseBSourceFrozenAtPrepare: true,
    ...(parent
      ? {
          parentPlanPath: parentPath,
          parentPlanSha256: parentSha,
          inheritedProductClosure: true,
          onlyChangedClosureFile: "scripts/project-components/result-phase-b-guard.mjs",
        }
      : {}),
    node: { version: process.version, path: process.execPath, sha256: fileHash(process.execPath) },
    sourceProofSha256: hash(JSON.stringify(sourceProof)),
    sourcePins: sourceProof.source,
    config,
    configPath,
    configSha256: fileHash(configPath),
    base,
    evidence,
    sourceRoot,
    closureSha256: fileHash(join(base, "closure.json")),
    closureFiles: closure.length,
    excludedD: excluded,
    guardSha256: fileHash(join(sourceRoot, "scripts/project-components/result-phase-b-guard.mjs")),
    runnerSha256: fileHash(fileURLToPath(import.meta.url)),
    boundaries: {
      services: [4459, 4461],
      noBuildOrInstall: true,
      productionOrPrimaryPreview: false,
      externalExecutors: false,
      guardIsNotMaliciousNativeSandbox: true,
    },
  };
  save(join(base, "plan.json"), plan);
  save(join(evidence, "prepare.json"), plan);
  console.log(
    JSON.stringify({
      status: "prepared",
      planPath: join(base, "plan.json"),
      planSha256: fileHash(join(base, "plan.json")),
      evidence,
      closureFiles: closure.length,
      closureSha256: plan.closureSha256,
      configSha256: plan.configSha256,
      guardSha256: plan.guardSha256,
    }),
  );
}

if (process.argv[2] === "--prepare") await prepare(process.argv[3], process.argv[4]);
else if (process.argv[2] === "--run") await run(process.argv[3], process.argv[4]);
else
  console.log(
    JSON.stringify({
      status: "not_run",
      defaultInert: true,
      modes: ["--prepare", "--run <plan> <sha256>"],
    }),
  );

async function run(planPath, expectedHash) {
  requireTrue(fileHash(planPath) === expectedHash, "PLAN_PIN_MISMATCH");
  const plan = json(planPath),
    config = plan.config;
  requireTrue(plan.configSha256 === fileHash(plan.configPath), "CONFIG_PIN_MISMATCH");
  requireTrue(
    plan.closureSha256 === fileHash(join(plan.base, "closure.json")),
    "CLOSURE_PIN_MISMATCH",
  );
  const expectedClosure = json(join(plan.base, "closure.json"));
  requireTrue(
    JSON.stringify(tree(plan.sourceRoot)) === JSON.stringify(expectedClosure),
    "CLOSURE_BYTES_CHANGED",
  );
  requireTrue(
    config.apiPort === 4459 && config.mcpPort === 4461 && config.apiHost === "127.0.0.1",
    "PORT_SCOPE_MISMATCH",
  );
  requireTrue(
    json(join(config.dataRoot, ".qa-hub-import-hold.json")).state === "paused",
    "IMPORT_HOLD_REQUIRED",
  );
  const runId = randomUUID(),
    publicRoot = join(plan.evidence, runId),
    privateRoot = join(plan.base, "runs", runId);
  mkdirSync(publicRoot);
  mkdirSync(privateRoot, { recursive: true });
  copy(fileURLToPath(import.meta.url), join(publicRoot, "runner.mjs.txt"));
  const proof = {
    kind: "isolated_full_main_worker_http_server_mcp",
    status: "running",
    runId,
    startedAt: new Date().toISOString(),
    planPath,
    planSha256: expectedHash,
    runnerSha256: fileHash(fileURLToPath(import.meta.url)),
    configSha256: plan.configSha256,
    closureSha256: plan.closureSha256,
    guardSha256: plan.guardSha256,
    checks: [],
    requests: [],
    processes: [],
    fixtures: [],
    boundaries: {
      originalPreviewTouched: false,
      productionTouched: false,
      componentsOff: true,
      importHoldReleased: false,
      externalExecutorsRun: false,
      assembledFastifyFixture: false,
    },
  };
  const secrets = json(config.secretsFile),
    secretValues = new Set(Object.values(secrets));
  function remember(value) {
    if (typeof value === "string") {
      try {
        const nested = JSON.parse(value);
        if (nested && typeof nested === "object") remember(nested);
      } catch {
        /* literal */
      }
      return;
    }
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (
          /token|cookie|password|secret|authorization/i.test(key) &&
          typeof item === "string" &&
          item.length > 3
        )
          secretValues.add(item);
        remember(item);
      }
  }
  function redact(value) {
    if (typeof value === "string") {
      try {
        const nested = JSON.parse(value);
        if (nested && typeof nested === "object") return JSON.stringify(redact(nested));
      } catch {
        /* primitive stays exact */
      }
      let text = value;
      for (const secret of secretValues) text = text.split(secret).join("[REDACTED]");
      return text.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          /token|cookie|password|secret|authorization/i.test(k) ? "[REDACTED]" : redact(v),
        ]),
      );
    return value;
  }
  function check(label, actual, expected) {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    proof.checks.push({ label, expected: redact(expected), actual: redact(actual), passed });
    if (!passed) throw new Error(`CHECK_FAILED:${label}`);
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      [
        "systemroot",
        "windir",
        "comspec",
        "path",
        "temp",
        "tmp",
        "userprofile",
        "appdata",
        "localappdata",
      ].includes(k.toLowerCase()),
    ),
  );
  const guard = join(plan.sourceRoot, "scripts/project-components/result-phase-b-guard.mjs");
  const children = [];
  function launch(role, script, args = [], ipc = true) {
    const startedAt = new Date().toISOString(),
      guardLog = join(privateRoot, `${role}-guard.jsonl`);
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(guard).href, script, ...args],
      {
        cwd: plan.sourceRoot,
        windowsHide: true,
        env: { ...env, QA_PHASE_B_ROLE: role, QA_PHASE_B_GUARD_LOG: guardLog },
        stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      },
    );
    const record = {
      role,
      pid: child.pid,
      startedAt,
      executable: process.execPath,
      script,
      guardLog,
      stdout: "",
      stderr: "",
      exit: null,
    };
    child.stdout.on("data", (chunk) => (record.stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (record.stderr += chunk.toString()));
    child.on("exit", (code, signal) => {
      record.exit = { code, signal, at: new Date().toISOString() };
    });
    child.on("error", (e) => {
      record.error = e.code ?? e.message;
    });
    children.push({ child, record });
    proof.processes.push(record);
    return { child, record };
  }
  async function exited(entry) {
    const until = Date.now() + 30000;
    while (entry.record.exit === null && Date.now() < until)
      await new Promise((r) => setTimeout(r, 100));
    requireTrue(entry.record.exit !== null, `OWNED_PROCESS_DID_NOT_EXIT:${entry.record.pid}`);
  }
  let sequence = 0,
    rpcId = 0;
  async function request(
    path,
    {
      body,
      token,
      cookie,
      csrf,
      project,
      key,
      method = body === undefined ? "GET" : "POST",
      accept = "application/json",
      contentType = "application/json",
      expected = 200,
      port = 4459,
    } = {},
  ) {
    requireTrue([4459, 4461].includes(port) && path.startsWith("/"), "REQUEST_SCOPE_INVALID");
    const headers = {
      accept,
      origin: "http://127.0.0.1:4458",
      ...(body === undefined ? {} : { "content-type": contentType }),
      ...(project ? { "x-qa-project-id": project } : {}),
      ...(key ? { "idempotency-key": key } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    };
    const row = {
      sequence: ++sequence,
      startedAt: new Date().toISOString(),
      port,
      method,
      path,
      headers: Object.fromEntries(
        Object.entries(headers).filter(
          ([key]) => !["authorization", "cookie", "x-csrf-token"].includes(key),
        ),
      ),
      body: redact(body),
    };
    proof.requests.push(row);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = text;
    }
    remember(value);
    const setCookie = response.headers.get("set-cookie")?.split(";")[0];
    if (setCookie) secretValues.add(setCookie);
    Object.assign(row, {
      completedAt: new Date().toISOString(),
      status: response.status,
      response: redact(value),
      responseHeaders: {
        contentType: response.headers.get("content-type"),
        instance: response.headers.get("x-qa-hub-instance"),
      },
    });
    check(`${row.sequence} ${method} ${port}${path} status`, response.status, expected);
    return { value, cookie: setCookie };
  }
  const req = async (path, options = {}) => (await request(`/api/v1/${path}`, options)).value;
  async function rpc(method, params, token, expected = 200, notification = false) {
    const response = await request("/mcp", {
      port: 4461,
      body: {
        jsonrpc: "2.0",
        ...(notification ? {} : { id: ++rpcId }),
        method,
        ...(params === undefined ? {} : { params }),
      },
      token,
      expected,
    });
    if (!notification) {
      check(`${method} jsonrpc literal`, response.value.jsonrpc, "2.0");
      requireTrue(!response.value.error, `RPC_ERROR:${method}`);
    }
    return response.value?.result;
  }
  async function tool(name, args, token, errorStatus) {
    const result = await rpc("tools/call", { name, arguments: args }, token);
    check(`tool ${name} error`, result.isError === true, errorStatus !== undefined);
    const value =
      result.structuredContent ?? JSON.parse(result.content.find((x) => x.type === "text").text);
    if (errorStatus !== undefined) check(`tool ${name} status`, value.status, errorStatus);
    return value;
  }
  const databaseFile = join(config.dataRoot, "db/qa-hub.sqlite");
  function snapshot() {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      db.exec("BEGIN");
      const value = Object.fromEntries(
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
          return [table, { count: rows.length, sha256: hash(JSON.stringify(rows)) }];
        }),
      );
      db.exec("COMMIT");
      return value;
    } finally {
      db.close();
    }
  }
  async function deniedUnchanged(f, path, options, expected) {
    const before = snapshot();
    await f.call(path, { ...options, expected });
    check(`denied ${expected} preserves domain ${path}`, snapshot(), before);
  }
  function bugBody(projectId, actorId, title = "Isolated full-main Phase B result") {
    return {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: randomUUID(),
      projectId,
      title,
      description: "Synthetic retained acceptance fixture",
      expectedBehavior: "Exact immutable receipt",
      severity: "S2",
      priority: "P2",
      attachmentIds: [],
      ownerId: actorId,
      verificationOwnerId: actorId,
      occurrence: {
        observedAt: new Date().toISOString(),
        platform: "web",
        steps: ["Full main acceptance"],
        actualBehavior: "Pending review",
      },
    };
  }
  let gm;
  async function fixture(label) {
    const projectId = randomUUID();
    await req("gm/projects", {
      token: gm.accessToken,
      body: {
        id: projectId,
        key: `A${randomUUID().slice(0, 8).toUpperCase()}`,
        name: `Phase B ${label}`,
      },
      expected: 200,
    });
    const name = `Phase B ${label} ${randomUUID().slice(0, 8)}`;
    const employee = await req("auth/login", { body: { projectId, name, client: "android" } });
    const f = {
      projectId,
      name,
      employee,
      actorId: employee.userId,
      call: (path, options = {}) =>
        req(path, { token: employee.accessToken, project: projectId, ...options }),
    };
    f.bug = async () => {
      const body = bugBody(projectId, f.actorId);
      return (
        await f.call("bugs", {
          body,
          key: `submission:${body.clientSubmissionId}:commit`,
          expected: 201,
          accept: vendor,
        })
      ).bug;
    };
    const components = await f.call(`projects/${projectId}/components`);
    check(`${label} five components`, components.items.length, 5);
    check(
      `${label} all off`,
      components.items.every((x) => x.enabled === false),
      true,
    );
    proof.fixtures.push({ label, projectId, actorId: f.actorId, bugs: [] });
    f.record = proof.fixtures.at(-1);
    return f;
  }
  const vendor = "application/vnd.relay-qa-hub.v1.1+json";
  async function round(f, parent = false) {
    let bug = await f.bug();
    f.record.bugs.push({ id: bug.id, initialVersion: bug.version });
    bug = await f.call(`bugs/${bug.id}/transitions`, {
      body: { expectedVersion: bug.version, toState: "ready" },
      key: `workflow:transitionBug:bug:${bug.id}:v${bug.version}:ready`,
    });
    let attempt = await f.call(`bugs/${bug.id}/repair-attempts`, {
      body: {
        expectedVersion: bug.version,
        mode: "human",
        assigneeId: f.actorId,
        summary: "Actual full main human round",
      },
      key: `workflow:createRepairAttempt:bug:${bug.id}:v${bug.version}`,
      expected: 201,
    });
    const parentId = parent ? attempt.id : null;
    if (parent) {
      const current = await f.call(`bugs/${bug.id}`);
      await f.call(`bugs/${bug.id}/manual-complete`, {
        body: { expectedVersion: current.version, reason: "Human takes over prior round" },
        key: `workflow:manualCompleteBug:bug:${bug.id}:v${current.version}`,
      });
      attempt = (await f.call(`bugs/${bug.id}/human-workflow`)).repairAttempt;
    } else {
      attempt = await f.call(`repair-attempts/${attempt.id}/start`, {
        body: { expectedVersion: attempt.version },
        key: `workflow:startRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
      });
      attempt = await f.call(`repair-attempts/${attempt.id}/deliver`, {
        body: {
          expectedVersion: attempt.version,
          deliveryKind: "no_code",
          noCodeReason: "Synthetic configuration fixed manually",
          summary: "Delivered",
        },
        key: `workflow:deliverRepairAttempt:attempt:${attempt.id}:v${attempt.version}`,
      });
    }
    bug = await f.call(`bugs/${bug.id}`);
    let verification = await f.call(`bugs/${bug.id}/verifications`, {
      body: {
        expectedVersion: bug.version,
        repairAttemptId: attempt.id,
        buildId: null,
        verifierId: f.actorId,
        criteria: "Actual isolated verification",
      },
      key: `workflow:createVerification:bug:${bug.id}:attempt:${attempt.id}:v${bug.version}`,
      expected: 201,
    });
    verification = await f.call(`verifications/${verification.id}/start`, {
      body: { expectedVersion: verification.version },
      key: `workflow:startVerification:verification:${verification.id}:v${verification.version}`,
    });
    return {
      bug,
      attempt,
      parentId,
      verification,
      path: `verifications/${verification.id}/result`,
      key: `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`,
    };
  }
  const resultBody = (r, status, legacy) => ({
    ...(legacy
      ? {}
      : {
          submissionContractVersion: "1.1.0",
          clientSubmissionId: randomUUID(),
          attachmentIds: [],
        }),
    expectedVersion: r.verification.version,
    status,
    resultSummary: "Original actual full-main result",
    ...(status === "failed" ? { failureReason: "Synthetic remaining issue" } : {}),
    ...(status === "blocked"
      ? { blockedReason: "Synthetic target device is temporarily unavailable" }
      : {}),
  });
  try {
    const listeners = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$x=@(Get-NetTCPConnection -LocalPort 4459,4461 -State Listen -ErrorAction SilentlyContinue); ConvertTo-Json -Compress @{count=$x.Count}",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    check("4459/4461 free before startup", JSON.parse(listeners).count, 0);
    const self = launch(
      "selftest",
      join(plan.sourceRoot, "scripts/project-components/result-phase-b-guard-selftest.mjs"),
      [],
      false,
    );
    await exited(self);
    check("preload selftest exit", self.record.exit.code, 0);
    const guardResult = JSON.parse(self.record.stdout.trim());
    check("guard main denials", guardResult.main.length, 10);
    check("worker inherited denials", guardResult.worker.length, 10);
    save(join(publicRoot, "guard-selftest.json"), guardResult);
    const entry = join(plan.sourceRoot, "scripts/project-components/run-preview-service.mjs");
    const api = launch("api", entry, [plan.configPath, "api"]);
    async function ready(port, path, owned) {
      for (let n = 0; n < 100; n++) {
        if (owned.record.exit) throw new Error(`SERVICE_EXITED:${owned.record.role}`);
        try {
          const r = await fetch(`http://127.0.0.1:${port}${path}`, {
            signal: AbortSignal.timeout(1000),
          });
          if (r.ok) {
            const b = await r.json();
            if (b.status === "ready") return;
          }
        } catch {
          /* start delay */
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`SERVICE_NOT_READY:${port}`);
    }
    await ready(4459, "/api/v1/health/ready", api);
    const mcp = launch("mcp", entry, [plan.configPath, "mcp"]);
    await ready(4461, "/health", mcp);
    const health = await req("health/ready");
    proof.ready = health;
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const migrations = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      check("real worker schema16", migrations.at(-1).version, 16);
      proof.schema = migrations.map((x) => ({ version: x.version, name: x.name }));
    } finally {
      db.close();
    }
    console.log(
      JSON.stringify({
        milestone: "full_main_and_real_worker_ready",
        apiPid: api.child.pid,
        mcpPid: mcp.child.pid,
        schema: 16,
        runId,
      }),
    );
    gm = await req("auth/gm/login", { body: { password: secrets.gmPassword, client: "android" } });
    for (const legacy of [true, false]) {
      const status = "blocked";
      const f = await fixture(`${legacy ? "legacy" : "vendor"}-${status}`),
        r = await round(f, !legacy),
        body = resultBody(r, status, legacy);
      const options = {
        body,
        key: legacy ? "k".repeat(200) : r.key,
        contentType: legacy ? "application/json" : vendor,
        accept: legacy ? "application/json" : vendor,
      };
      const before = snapshot(),
        first = await f.call(r.path, options),
        committed = snapshot();
      check(`${f.name} result state`, first.bug.state, "ready_for_verification");
      check(
        `${f.name} frozen response excludes reason field`,
        Object.hasOwn(first.verification, "blockedReason"),
        false,
      );
      check(
        `${f.name} delivered attempt whole-table bytes preserved`,
        committed.repair_attempts,
        before.repair_attempts,
      );
      const sql = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        sql.exec("BEGIN");
        const pointers = sql
          .prepare("SELECT active_repair_attempt_id,active_verification_id FROM bugs WHERE id=?")
          .get(r.bug.id);
        check(`${f.name} active repair retained`, pointers.active_repair_attempt_id, r.attempt.id);
        check(`${f.name} active verification cleared`, pointers.active_verification_id, null);
        const stored = sql
          .prepare("SELECT blocked_reason,failure_reason FROM verifications WHERE id=?")
          .get(r.verification.id);
        check(`${f.name} real SQL blocked reason`, stored.blocked_reason, body.blockedReason);
        check(`${f.name} real SQL failure reason null`, stored.failure_reason, null);
        const receipt = sql
          .prepare(
            "SELECT response_json FROM verification_result_snapshots WHERE verification_id=?",
          )
          .get(r.verification.id);
        check(
          `${f.name} immutable full DTO blocked reason`,
          JSON.parse(receipt.response_json).verification.blockedReason,
          body.blockedReason,
        );
        sql.exec("COMMIT");
      } finally {
        sql.close();
      }
      check(
        `${f.name} verification version`,
        first.verification.version,
        r.verification.version + 1,
      );
      check(`${f.name} one event`, committed.events.count, before.events.count + 1);
      check(`${f.name} one notification`, committed.outbox.count, before.outbox.count + 1);
      check(
        `${f.name} snapshot`,
        committed.verification_result_snapshots.count,
        before.verification_result_snapshots.count + 1,
      );
      if (legacy)
        check("legacy no invented client identity", Object.keys(first).sort(), [
          "bug",
          "verification",
        ]);
      else {
        check("vendor client identity exact", first.clientSubmissionId, body.clientSubmissionId);
        if (r.parentId)
          check("non-first parent projection", first.repairAttempt.parentAttemptId, r.parentId);
      }
      const expectedReplay = legacy ? first : { ...first, replayed: true };
      check(`${f.name} exact first replay`, await f.call(r.path, options), expectedReplay);
      check(`${f.name} replay no domain effect`, snapshot(), committed);
      const edit = await f.call(`bugs/${r.bug.id}`, {
        method: "PATCH",
        body: {
          expectedVersion: first.bug.version,
          title: "Later title must not replace original receipt",
        },
        key: `web:updateBug:bug:${r.bug.id}:v${first.bug.version}`,
      });
      const later = snapshot();
      check(`${f.name} original after later edit`, await f.call(r.path, options), expectedReplay);
      check(`${f.name} later replay unchanged`, snapshot(), later);
      check("later edit advanced version", edit.version, first.bug.version + 1);
      await deniedUnchanged(
        f,
        r.path,
        { ...options, body: { ...body, blockedReason: "Changed reason" } },
        409,
      );
      let nextVerification = await f.call(`bugs/${r.bug.id}/verifications`, {
        body: {
          expectedVersion: edit.version,
          repairAttemptId: r.attempt.id,
          buildId: null,
          verifierId: f.actorId,
          criteria: "Synthetic device is now available",
        },
        key: `workflow:createVerification:bug:${r.bug.id}:attempt:${r.attempt.id}:v${edit.version}`,
        expected: 201,
      });
      check(
        `${f.name} subsequent verification new identity`,
        nextVerification.id !== r.verification.id,
        true,
      );
      nextVerification = await f.call(`verifications/${nextVerification.id}/start`, {
        body: { expectedVersion: nextVerification.version },
        key: `workflow:startVerification:verification:${nextVerification.id}:v${nextVerification.version}`,
      });
      const oldTerminal = { verification: { version: first.verification.version } };
      await deniedUnchanged(
        f,
        r.path,
        {
          body: resultBody(oldTerminal, "passed", legacy),
          key: legacy
            ? "new-key-old-blocked"
            : `workflow:recordVerificationResult:verification:${r.verification.id}:v${first.verification.version}`,
          contentType: options.contentType,
          accept: options.accept,
        },
        412,
      );
      const passed = await f.call(`verifications/${nextVerification.id}/result`, {
        body: resultBody({ verification: nextVerification }, "passed", false),
        key: `workflow:recordVerificationResult:verification:${nextVerification.id}:v${nextVerification.version}`,
        accept: vendor,
      });
      check(`${f.name} subsequent verification closes`, passed.bug.state, "closed");
      const closedSnapshot = snapshot();
      check(
        `${f.name} blocked receipt remains original after another result`,
        await f.call(r.path, options),
        expectedReplay,
      );
      check(`${f.name} old receipt adds no facts after closure`, snapshot(), closedSnapshot);
      check(
        `${f.name} delivered attempt retained after new pass`,
        closedSnapshot.repair_attempts,
        before.repair_attempts,
      );
      check(
        `${f.name} blocked historical verification remains`,
        (await f.call(`verifications/${r.verification.id}`)).status,
        "blocked",
      );
      f.record.result = {
        bugId: r.bug.id,
        verificationId: r.verification.id,
        attemptId: r.attempt.id,
        parentId: r.parentId,
        result: status,
        originalVersion: first.bug.version,
        laterVersion: edit.version,
        subsequentVerificationId: nextVerification.id,
        closedVersion: passed.bug.version,
        originalResponseSha256: hash(JSON.stringify(first)),
        snapshot: committed.verification_result_snapshots,
      };
      console.log(
        JSON.stringify({
          milestone: "result_format_completed",
          format: legacy ? "legacy" : "vendor",
          status,
          checks: proof.checks.length,
        }),
      );
    }
    const f = await fixture("authorization"),
      r = await round(f),
      body = resultBody(r, "blocked", true);
    const browser = await request("/api/v1/auth/login", {
      body: { projectId: f.projectId, name: f.name, client: "web" },
    });
    const peer = await req("auth/login", {
      body: { projectId: f.projectId, name: `Other ${randomUUID()}`, client: "android" },
    });
    const options = {
      body,
      key: "cookie-result",
      token: undefined,
      cookie: browser.cookie,
      accept: "application/json",
    };
    for (const patch of [
      { blockedReason: undefined },
      { blockedReason: "" },
      { blockedReason: " ".repeat(3) },
      { blockedReason: null },
      { blockedReason: "x".repeat(5001) },
      { failureReason: "Mixed reason invalid" },
      { status: "passed" },
    ]) {
      await deniedUnchanged(f, r.path, { body: { ...body, ...patch }, key: "reason-invalid" }, 400);
    }
    await deniedUnchanged(f, r.path, options, 403);
    await deniedUnchanged(f, r.path, { ...options, csrf: "wrong" }, 403);
    await deniedUnchanged(f, r.path, { body, key: "not-assigned", token: peer.accessToken }, 403);
    await deniedUnchanged(
      f,
      r.path,
      { body: { ...body, requireAssignedVerifier: false }, key: "cannot-inject" },
      400,
    );
    await deniedUnchanged(
      f,
      r.path,
      { ...options, csrf: browser.value.csrfToken, body: { ...body, expectedVersion: 1 } },
      412,
    );
    await deniedUnchanged(
      f,
      r.path,
      { ...options, csrf: browser.value.csrfToken, accept: vendor },
      406,
    );
    const first = await f.call(r.path, { ...options, csrf: browser.value.csrfToken });
    check(
      "Cookie first and Bearer original replay",
      await f.call(r.path, { body, key: "cookie-result" }),
      first,
    );
    const deniedProject = proof.fixtures[0].projectId;
    await deniedUnchanged(f, r.path, { body, key: "cookie-result", project: deniedProject }, 404);
    await req(`gm/projects/${f.projectId}/members/${f.actorId}`, {
      token: gm.accessToken,
      method: "PUT",
      body: { active: false, expectedVersion: 1 },
    });
    await deniedUnchanged(f, r.path, { body, key: "cookie-result" }, 403);
    const deleted = await fixture("deleted"),
      dr = await round(deleted),
      dbod = resultBody(dr, "blocked", false);
    const dfirst = await deleted.call(dr.path, { body: dbod, key: dr.key, accept: vendor });
    await deleted.call(`bugs/${dr.bug.id}?expectedVersion=${dfirst.bug.version}`, {
      method: "DELETE",
      key: `web:deleteBug:bug:${dr.bug.id}:v${dfirst.bug.version}`,
    });
    await deniedUnchanged(deleted, dr.path, { body: dbod, key: dr.key, accept: vendor }, 404);
    await deleted.call(`verifications/${dr.verification.id}`, { expected: 404 });
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "phase-b-full-main-e2e", version: "1.0" },
    });
    await rpc("notifications/initialized", undefined, undefined, 202, true);
    const listed = await rpc("tools/list", {});
    check("existing tool catalog count", listed.tools.length, 90);
    const mf = await fixture("server-mcp");
    const member = await tool("qa_login", { projectId: mf.projectId, name: `MCP ${randomUUID()}` });
    const token = member.accessToken;
    const mb = bugBody(mf.projectId, member.userId, "MCP actual manual workflow");
    let created = await tool("qa_create_bug", { projectId: mf.projectId, request: mb }, token),
      current = created.bug;
    mf.record.bugs.push({
      id: current.id,
      actorId: member.userId,
      initialVersion: current.version,
    });
    const mtool = (name, args, actor = token, errorStatus) =>
      tool(name, { projectId: mf.projectId, bugId: current.id, ...args }, actor, errorStatus);
    const unsupportedBefore = snapshot();
    await mtool(
      "qa_bug_action",
      {
        action: "blocked",
        expectedVersion: current.version,
        idempotencyKey: `phase-b:unsupported:${randomUUID()}`,
        request: { blockedReason: "No MCP blocked action currently exists" },
      },
      token,
      400,
    );
    check("unsupported MCP blocked action leaves no facts", snapshot(), unsupportedBefore);
    const comment = { clientSubmissionId: randomUUID(), body: "MCP real persistent comment" };
    const cfirst = await mtool("qa_add_comment", { request: comment });
    check(
      "MCP comment replay",
      (await mtool("qa_add_comment", { request: comment })).comment.id,
      cfirst.comment.id,
    );
    current = (await mtool("qa_get_bug_context", {})).bug;
    const action = (name, version, requestBody, extra = {}, actor = token) =>
      mtool(
        "qa_bug_action",
        {
          action: name,
          expectedVersion: version,
          request: requestBody,
          idempotencyKey: `phase-b:${randomUUID()}`,
          ...extra,
        },
        actor,
      );
    await action("manual_complete", current.version, { reason: "Actual MCP human takeover" });
    let context = await mtool("qa_get_bug_context", {});
    current = context.bug;
    check("MCP manual ready", current.state, "ready_for_verification");
    const createdVerification = await action("create_verification", current.version, {
      repairAttemptId: context.humanWorkflow.repairAttempt.id,
      buildId: null,
      verifierId: member.userId,
      criteria: "MCP manual closure",
    });
    let verification = createdVerification.result;
    verification = (
      await action(
        "start_verification",
        verification.version,
        {},
        { verificationId: verification.id },
      )
    ).result;
    const resultRequest = {
      submissionContractVersion: "1.1.0",
      clientSubmissionId: randomUUID(),
      attachmentIds: [],
      resultSummary: "Another active employee human closure remains allowed",
    };
    await req(`verifications/${verification.id}/result`, {
      token: mf.employee.accessToken,
      project: mf.projectId,
      body: { ...resultRequest, status: "passed", expectedVersion: verification.version },
      key: `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`,
      expected: 403,
    });
    const closeKey = `workflow:recordVerificationResult:verification:${verification.id}:v${verification.version}`;
    const closeArgs = {
      action: "verify_pass",
      expectedVersion: verification.version,
      verificationId: verification.id,
      request: resultRequest,
      idempotencyKey: closeKey,
    };
    const closed = await mtool("qa_bug_action", closeArgs, mf.employee.accessToken);
    check("ordinary other employee MCP closure", closed.bug.state, "closed");
    check("MCP original result actor", closed.result.eventId !== undefined, true);
    check(
      "MCP closure replay flag",
      (await mtool("qa_bug_action", closeArgs, mf.employee.accessToken)).result.replayed,
      true,
    );
    context = await mtool("qa_get_bug_context", {});
    check(
      "MCP latest verification after closed",
      context.humanWorkflow.latestVerification.id,
      verification.id,
    );
    check(
      "MCP persistent comment content",
      context.comments.items.some((x) => x.body === comment.body),
      true,
    );
    await req(`verifications/${verification.id}/result`, {
      token: mf.employee.accessToken,
      project: mf.projectId,
      body: { ...resultRequest, status: "passed", expectedVersion: verification.version },
      key: closeKey,
      expected: 403,
    });
    check(
      "MCP components off",
      (await mtool("qa_get_components", {})).items.every((x) => !x.enabled),
      true,
    );
    const finalDb = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      proof.databaseBeforeStop = {
        snapshot: snapshot(),
        integrity: finalDb.prepare("PRAGMA integrity_check").get(),
        foreignKeys: finalDb.prepare("PRAGMA foreign_key_check").all(),
        schema: 16,
      };
      check("foreign keys clean", proof.databaseBeforeStop.foreignKeys.length, 0);
      await backup(finalDb, join(privateRoot, "consistent-before-stop.sqlite"));
    } finally {
      finalDb.close();
    }
    check(
      "import hold remains paused",
      json(join(config.dataRoot, ".qa-hub-import-hold.json")).state,
      "paused",
    );
    check(
      "frozen source closure remains exact",
      hash(JSON.stringify(tree(plan.sourceRoot))),
      hash(JSON.stringify(expectedClosure)),
    );
    for (const entry of children.filter((x) => x.record.role !== "selftest"))
      check(
        `${entry.record.role} no forbidden external attempts`,
        existsSync(entry.record.guardLog) ? readFileSync(entry.record.guardLog, "utf8") : "",
        "",
      );
    proof.status = "passed";
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = { name: error.name, message: redact(error.message) };
  } finally {
    for (const entry of children.toReversed()) {
      if (entry.record.exit === null && entry.child.connected) {
        entry.record.shutdownRequestedAt = new Date().toISOString();
        entry.record.shutdownMechanism =
          "IPC command emits SIGTERM into original official handlers";
        entry.child.send({ command: "phase-b-official-sigterm" });
      }
      try {
        await exited(entry);
      } catch (error) {
        proof.status = "failed_retained";
        proof.shutdownFailure = error.message;
      }
      save(join(privateRoot, `${entry.record.role}-process.json`), entry.record);
    }
    if (existsSync(databaseFile)) {
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        await backup(db, join(privateRoot, "consistent-after-stop.sqlite"));
        proof.databaseAfterStop = {
          snapshot: snapshot(),
          integrity: db.prepare("PRAGMA integrity_check").get(),
          archiveSha256: fileHash(join(privateRoot, "consistent-after-stop.sqlite")),
        };
      } finally {
        db.close();
      }
    }
    proof.finishedAt = new Date().toISOString();
    proof.requestCount = proof.requests.length;
    proof.checkCounts = {
      total: proof.checks.length,
      passed: proof.checks.filter((x) => x.passed).length,
    };
    proof.privateRoot = privateRoot;
    const publicValue = redact(proof),
      serialized = JSON.stringify(publicValue, null, 2) + "\n";
    for (const secret of secretValues)
      requireTrue(!serialized.includes(secret), "PUBLIC_SECRET_SCAN_FAILED");
    writeFileSync(join(publicRoot, "result.json"), serialized, { flag: "wx" });
    console.log(
      JSON.stringify({
        status: proof.status,
        runId,
        requestCount: proof.requestCount,
        checks: proof.checkCounts,
        resultPath: join(publicRoot, "result.json"),
        sha256: fileHash(join(publicRoot, "result.json")),
        failure: proof.failure,
      }),
    );
  }
}
