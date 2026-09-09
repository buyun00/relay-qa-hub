import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(import.meta.url);
const root = resolve(dirname(sourcePath), "../..");
const instancePath = "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/instance.json";
const instanceSha = "2b8e97ce9b62d072b74eaf00015fb04f5b818d318203f2a91e59d15873da349b";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sensitive = /token|secret|password|cookie|authorization|csrf|private.?key|credential/iu;

export function redactMembershipEvidence(value, secrets = new Set()) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object")
        return JSON.stringify(redactMembershipEvidence(parsed, secrets));
    } catch {
      /* Plain text, including protocol versions. */
    }
    let text = value;
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redactMembershipEvidence(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitive.test(key))
        .map(([key, item]) => [key, redactMembershipEvidence(item, secrets)]),
    );
  return value;
}

export function guardMembershipTool(name, args, scope) {
  const reads = new Set([
    "qa_get_components",
    "qa_list_members",
    "qa_list_users",
    "qa_list_bugs",
    "qa_list_management_events",
  ]);
  if (name === "qa_login_gm") {
    assert.deepEqual(Object.keys(args), ["request"]);
    assert.deepEqual(Object.keys(args.request), ["password"]);
    assert.equal(typeof args.request.password, "string");
  } else if (name === "qa_create_project") {
    assert.deepEqual(Object.keys(args), ["request"]);
    assert.ok(scope.projects.includes(args.request.id));
    assert.ok(args.request.key.startsWith(scope.keyPrefix));
    assert.ok(args.request.name.includes(scope.runId));
    assert.deepEqual(Object.keys(args.request).sort(), ["id", "key", "name"]);
  } else if (name === "qa_login") {
    assert.ok(scope.projects.includes(args.projectId));
    assert.ok(scope.names.includes(args.name));
    assert.deepEqual(Object.keys(args).sort(), ["name", "projectId"]);
  } else if (reads.has(name)) {
    assert.ok(scope.projects.includes(args.projectId));
    assert.deepEqual(Object.keys(args), ["projectId"]);
  } else if (name === "qa_list_projects" || name === "qa_get_session") {
    assert.deepEqual(args, {});
  } else if (name === "qa_set_membership") {
    assert.equal(args.projectId, scope.projects[0]);
    assert.ok(scope.sharedId && args.userId === scope.sharedId);
    assert.deepEqual(Object.keys(args).sort(), ["projectId", "request", "userId"]);
    assert.deepEqual(Object.keys(args.request).sort(), ["active", "expectedVersion"]);
    assert.equal(typeof args.request.active, "boolean");
    assert.ok(
      Number.isSafeInteger(args.request.expectedVersion) && args.request.expectedVersion > 0,
    );
  } else throw new Error("Unreviewed MCP tool");
}

function identities() {
  const command =
    "$ports = @(4419,4421); @($ports | ForEach-Object { $port=$_; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop); if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1'){throw 'Unexpected listener'}; $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess); [pscustomobject]@{port=$port;pid=[int]$owner.ProcessId;startedAt=$owner.CreationDate.ToUniversalTime().ToString('o');path=$owner.ExecutablePath} }) | ConvertTo-Json -Compress";
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
}

async function run(configFile) {
  assert.equal(resolve(configFile), resolve(instancePath));
  assert.equal(resolve(process.cwd()), root);
  const configBytes = readFileSync(configFile);
  assert.equal(sha(configBytes), instanceSha);
  const config = JSON.parse(configBytes);
  assert.equal(config.instanceId, "qa-hub-preview-7c86");
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.apiPort, 4419);
  assert.equal(config.mcpPort, 4421);
  assert.equal(resolve(config.sourceRoot), root);
  assert.equal(config.gmUserId, "850912b5-61bf-4f6b-aae6-f7c59e1b087e");
  const runId = randomUUID();
  const compact = runId.replaceAll("-", "");
  const scope = {
    runId,
    projects: [randomUUID(), randomUUID()],
    names: [`McpSingle${compact}`, `McpShared${compact}`],
    keyPrefix: `MI${compact.slice(0, 10).toUpperCase()}`,
  };
  const output = join(root, "docs/evidence/project-components/server-mcp-membership-live", runId);
  mkdirSync(output, { recursive: true });
  const secrets = new Set();
  const proof = {
    schemaVersion: 1,
    status: "running",
    runId,
    startedAt: new Date().toISOString(),
    scope,
    sourceSha256: sha(readFileSync(sourcePath)),
    checks: [],
    requests: [],
    boundaries: {
      serverMcpOnly: true,
      localMcpCalled: false,
      clientsOperated: false,
      componentsEnabled: false,
      bugsCreated: 0,
      externalCalls: 0,
      servicesChanged: false,
      productionInventoryRepeated: false,
      cleanupDeletes: false,
    },
  };
  let sequence = 0;
  const safe = (value) => {
    const text = JSON.stringify(redactMembershipEvidence(value, secrets), null, 2) + "\n";
    assert.ok(![...secrets].some((secret) => text.includes(secret)));
    assert.ok(
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(
        text,
      ),
    );
    return text;
  };
  const remember = (value) => {
    if (Array.isArray(value)) return value.forEach(remember);
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (sensitive.test(key) && typeof item === "string" && item.length > 8) secrets.add(item);
        else if (typeof item === "string") {
          try {
            const parsed = JSON.parse(item);
            if (parsed && typeof parsed === "object") remember(parsed);
          } catch {
            /* Plain text. */
          }
        } else remember(item);
      }
  };
  function check(label, actual, expected) {
    const entry = { label, actual, expected, at: new Date().toISOString(), passed: false };
    proof.checks.push(entry);
    assert.deepEqual(actual, expected, label);
    entry.passed = true;
  }
  async function rpc(label, method, params = {}, token, denial) {
    assert.ok(["initialize", "tools/list", "tools/call"].includes(method));
    if (method === "tools/call") guardMembershipTool(params.name, params.arguments, scope);
    const id = ++sequence;
    const request = { jsonrpc: "2.0", id, method, params };
    const entry = {
      label,
      id,
      request: redactMembershipEvidence(request, secrets),
      at: new Date().toISOString(),
    };
    proof.requests.push(entry);
    try {
      const response = await fetch("http://127.0.0.1:4421/mcp", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(request),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const envelope = JSON.parse(bytes.toString("utf8"));
      remember(envelope);
      Object.assign(entry, {
        httpStatus: response.status,
        sizeBytes: bytes.length,
        responseSha256: sha(bytes),
        response: redactMembershipEvidence(envelope, secrets),
      });
      assert.equal(response.status, 200, label);
      assert.equal(envelope.id, id, label);
      assert.equal(envelope.jsonrpc, "2.0", label);
      assert.equal(envelope.error, undefined, label);
      if (method !== "tools/call") return envelope.result;
      const result = envelope.result;
      const value = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.equal(result.isError, !!denial, label);
      if (denial) {
        assert.equal(value.code, denial.code, label);
        assert.equal(value.status, denial.status, label);
      }
      return value;
    } catch (error) {
      entry.failure = String(error);
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
    }
  }
  const tool = (label, name, args, token, denial) =>
    rpc(label, "tools/call", { name, arguments: args }, token, denial);
  const projectIds = (value) => value.items.map((p) => p.id).sort();
  const membershipFact = (value, userId) => {
    const user = value.items.find((p) => p.userId === userId);
    assert.ok(user, "Fixture user must be present");
    return {
      userId: user.userId,
      displayName: user.displayName,
      status: user.status,
      membershipStatus: user.membershipStatus,
      membershipVersion: user.membershipVersion,
      roles: [...user.roles].sort(),
    };
  };
  const checkOff = (label, value) => {
    check(label + " keys", value.items.map((i) => i.key).sort(), [
      "build",
      "build_upload.single",
      "qingyu.sync",
      "relay.production",
      "upload.incremental",
    ]);
    check(
      label + " disabled",
      value.items.map((i) => i.enabled),
      [false, false, false, false, false],
    );
  };
  try {
    const before = identities();
    proof.hostBefore = before;
    check("API owner", before.find((p) => p.port === 4419)?.pid, 22852);
    check(
      "API start",
      Date.parse(before.find((p) => p.port === 4419)?.startedAt),
      Date.parse("2026-09-09T01:22:20.2728640Z"),
    );
    check("MCP owner", before.find((p) => p.port === 4421)?.pid, 15736);
    check(
      "MCP start",
      Date.parse(before.find((p) => p.port === 4421)?.startedAt),
      Date.parse("2026-09-08T16:46:02.4598690Z"),
    );
    const ready = await fetch("http://127.0.0.1:4421/health", {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const health = await ready.json();
    proof.health = health;
    check("MCP proxy health HTTP", ready.status, 200);
    check("MCP proxy ready", health.status, "ready");
    check("Current API schema", String(health.schemaVersion), "14");
    await rpc("initialize actual server MCP", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "preview-membership-acceptance", version: "1" },
    });
    const catalog = await rpc("catalog", "tools/list");
    check("catalog count", catalog.tools.length, 90);
    for (const name of [
      "qa_login_gm",
      "qa_create_project",
      "qa_login",
      "qa_list_projects",
      "qa_list_users",
      "qa_set_membership",
      "qa_list_management_events",
    ])
      check(
        "catalog " + name,
        catalog.tools.some((t) => t.name === name),
        true,
      );
    const secretConfig = JSON.parse(readFileSync(config.secretsFile, "utf8"));
    assert.equal(typeof secretConfig.gmPassword, "string");
    secrets.add(secretConfig.gmPassword);
    const gm = await tool("GM login", "qa_login_gm", {
      request: { password: secretConfig.gmPassword },
    });
    check("same configured GM", gm.userId, config.gmUserId);
    check("GM identity", gm.isGm, true);
    const [a, b] = scope.projects;
    for (const [index, projectId] of scope.projects.entries()) {
      const created = await tool(
        `create fresh ${index ? "B" : "A"}`,
        "qa_create_project",
        {
          request: {
            id: projectId,
            key: scope.keyPrefix + (index ? "B" : "A"),
            name: `Server MCP membership ${index ? "B" : "A"} ${runId}`,
          },
        },
        gm.accessToken,
      );
      check("fresh project identity " + index, created.id, projectId);
      checkOff(
        "initial components " + index,
        await tool("five off", "qa_get_components", { projectId }, gm.accessToken),
      );
    }
    const single = await tool("first single A login", "qa_login", {
      projectId: a,
      name: scope.names[0],
    });
    check("single selected A", single.projectId, a);
    check("single is employee", single.isGm, false);
    const repeated = await tool("same name A login", "qa_login", {
      projectId: a,
      name: scope.names[0],
    });
    check("repeat keeps user ID", repeated.userId, single.userId);
    check(
      "single project directory",
      projectIds(await tool("single directory", "qa_list_projects", {}, repeated.accessToken)),
      [a],
    );
    const sharedA = await tool("first shared A login", "qa_login", {
      projectId: a,
      name: scope.names[1],
    });
    scope.sharedId = sharedA.userId;
    proof.singleId = single.userId;
    assert.notEqual(scope.sharedId, single.userId);
    assert.notEqual(scope.sharedId, config.gmUserId);
    check(
      "shared initially only A",
      projectIds(
        await tool("shared initial directory", "qa_list_projects", {}, sharedA.accessToken),
      ),
      [a],
    );
    const sharedB = await tool("same shared name joins B", "qa_login", {
      projectId: b,
      name: scope.names[1],
    });
    check("same global employee across projects", sharedB.userId, sharedA.userId);
    check("shared selected B", sharedB.projectId, b);
    check(
      "shared has exact A B",
      projectIds(
        await tool("shared two-project directory", "qa_list_projects", {}, sharedB.accessToken),
      ),
      [a, b].sort(),
    );
    const usersA = await tool(
      "A personnel before disable",
      "qa_list_users",
      { projectId: a },
      gm.accessToken,
    );
    const usersB = await tool(
      "B personnel before disable",
      "qa_list_users",
      { projectId: b },
      gm.accessToken,
    );
    const originalA = membershipFact(usersA, sharedA.userId),
      originalB = membershipFact(usersB, sharedA.userId);
    check("one shared entry A", usersA.items.filter((p) => p.userId === sharedA.userId).length, 1);
    check("one single entry A", usersA.items.filter((p) => p.userId === single.userId).length, 1);
    check(
      "single absent from B",
      usersB.items.some((p) => p.userId === single.userId),
      false,
    );
    check("A originally active", originalA.membershipStatus, "active");
    check("B originally active", originalB.membershipStatus, "active");
    const disabled = await tool(
      "disable only shared A membership",
      "qa_set_membership",
      {
        projectId: a,
        userId: sharedA.userId,
        request: { active: false, expectedVersion: originalA.membershipVersion },
      },
      gm.accessToken,
    );
    check("A disabled receipt", disabled, {
      projectId: a,
      userId: sharedA.userId,
      active: false,
      version: originalA.membershipVersion + 1,
    });
    check(
      "B membership unchanged after A disable",
      membershipFact(
        await tool("B unaffected readback", "qa_list_users", { projectId: b }, gm.accessToken),
        sharedA.userId,
      ),
      originalB,
    );
    await tool(
      "disabled A refuses same name",
      "qa_login",
      { projectId: a, name: scope.names[1] },
      undefined,
      { status: 403, code: "PROJECT_MEMBERSHIP_DISABLED" },
    );
    await tool(
      "old A token refuses A read",
      "qa_list_bugs",
      { projectId: a },
      sharedA.accessToken,
      { status: 403, code: "PROJECT_NOT_ACCESSIBLE" },
    );
    check(
      "B still reads empty Bugs",
      (await tool("B remains usable", "qa_list_bugs", { projectId: b }, sharedB.accessToken)).items
        .length,
      0,
    );
    check(
      "directory drops only A",
      projectIds(
        await tool(
          "B current directory after A disable",
          "qa_list_projects",
          {},
          sharedB.accessToken,
        ),
      ),
      [b],
    );
    const reloginB = await tool("B login remains available", "qa_login", {
      projectId: b,
      name: scope.names[1],
    });
    check("B identity survives A disable", reloginB.userId, sharedA.userId);
    const restored = await tool(
      "restore only shared A membership",
      "qa_set_membership",
      {
        projectId: a,
        userId: sharedA.userId,
        request: { active: true, expectedVersion: disabled.version },
      },
      gm.accessToken,
    );
    check("A restored receipt", restored, {
      projectId: a,
      userId: sharedA.userId,
      active: true,
      version: disabled.version + 1,
    });
    const finalA = await tool("same name after A restore", "qa_login", {
      projectId: a,
      name: scope.names[1],
    });
    check("restore keeps original user ID", finalA.userId, sharedA.userId);
    check(
      "restore exact two projects",
      projectIds(await tool("restored directory", "qa_list_projects", {}, finalA.accessToken)),
      [a, b].sort(),
    );
    check(
      "single directory unaffected",
      projectIds(await tool("single final directory", "qa_list_projects", {}, single.accessToken)),
      [a],
    );
    check(
      "B membership remains original",
      membershipFact(
        await tool("B final personnel", "qa_list_users", { projectId: b }, gm.accessToken),
        sharedA.userId,
      ),
      originalB,
    );
    const finalUsersA = await tool(
      "A final personnel",
      "qa_list_users",
      { projectId: a },
      gm.accessToken,
    );
    check(
      "A restored membership version",
      membershipFact(finalUsersA, sharedA.userId).membershipVersion,
      restored.version,
    );
    check(
      "A restored active",
      membershipFact(finalUsersA, sharedA.userId).membershipStatus,
      "active",
    );
    for (const projectId of scope.projects) {
      checkOff(
        "final components " + projectId,
        await tool("final five off", "qa_get_components", { projectId }, gm.accessToken),
      );
      check(
        "no fixture Bugs " + projectId,
        (await tool("no business writes", "qa_list_bugs", { projectId }, gm.accessToken)).items
          .length,
        0,
      );
    }
    const auditA = await tool(
      "A final management audit",
      "qa_list_management_events",
      { projectId: a },
      gm.accessToken,
    );
    const auditB = await tool(
      "B final management audit",
      "qa_list_management_events",
      { projectId: b },
      gm.accessToken,
    );
    const ownAudit = (audit, action) =>
      audit.items.filter((item) => item.subjectId === sharedA.userId && item.action === action);
    check("exact one A disable audit", ownAudit(auditA, "membership.disabled").length, 1);
    check("exact one A restore audit", ownAudit(auditA, "membership.activated").length, 1);
    check("no B disable audit", ownAudit(auditB, "membership.disabled").length, 0);
    check("no B restore audit", ownAudit(auditB, "membership.activated").length, 0);
    const after = identities();
    proof.hostAfter = after;
    check("API and server MCP identities unchanged", after, before);
    proof.status = "passed_scoped_server_mcp_membership";
  } catch (error) {
    proof.status = "failed_retained";
    proof.failure = String(error);
    process.exitCode = 1;
  } finally {
    proof.finishedAt = new Date().toISOString();
    writeFileSync(join(output, "runner.mjs.txt"), readFileSync(sourcePath), { flag: "wx" });
    writeFileSync(join(output, "proof.json"), safe(proof), { flag: "wx" });
    console.log(
      JSON.stringify({
        status: proof.status,
        runId,
        checks: proof.checks.length,
        requests: proof.requests.length,
        proof: join(output, "proof.json"),
      }),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === sourcePath) {
  if (process.argv[2] === "--run") {
    assert.equal(process.argv.length, 4);
    await run(process.argv[3]);
  } else
    console.log(
      JSON.stringify({
        status: "not_run",
        command:
          "node scripts/project-components/server-mcp-membership-live.mjs --run <reviewed-preview-instance.json>",
      }),
    );
}
