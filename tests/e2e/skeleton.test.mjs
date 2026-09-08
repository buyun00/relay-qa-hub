import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const apiEntryPoint = path.join(repositoryRoot, "apps", "api", "dist", "main.js");
const livePath = "/api/v1/health/live";
const buildSha = "0123456789abcdef0123456789abcdef01234567";

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

async function createLiveHealthValidator() {
  const [apiSchema, commonSchema] = await Promise.all([
    loadJson("packages/contracts/schemas/api.schema.json"),
    loadJson("packages/contracts/schemas/common.schema.json"),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema);
  ajv.addSchema(apiSchema);
  const validator = ajv.getSchema(`${apiSchema.$id}#/$defs/liveHealth`);
  assert.notEqual(validator, undefined);
  return validator;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

function startApi(configFile) {
  const output = [];
  const child = spawn(process.execPath, [apiEntryPoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      QA_HUB_INSTANCE_CONFIG_FILE: configFile,
      QA_HUB_BUILD_SHA: buildSha,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  return { child, output };
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 10_000;
  const url = `http://127.0.0.1:${port}${livePath}`;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited before becoming healthy (${child.exitCode}): ${output.join("")}`);
    }

    try {
      const response = await fetch(url);
      if (response.status === 200) {
        return response;
      }
    } catch {
      // The socket is not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`API did not become healthy: ${output.join("")}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(child.kill(), true);
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("API child did not exit within 5 seconds")),
      5_000,
    );
    timer.unref();
  });
  const result = await Promise.race([exited, timeout]);
  assert.equal(result.code !== null || result.signal !== null, true);
}

test("built API process starts healthy and can be restarted on the same port", async (t) => {
  const port = await reservePort();
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "qa-hub-preview-e2e-"));
  const ports = new Set([port]);
  while (ports.size < 4) ports.add(await reservePort());
  const [, webPort, mcpPort, desktopMcpPort] = [...ports];
  const instanceId = "qa-hub-preview-e2e";
  const config = {
    schemaVersion: 1,
    instanceId,
    sourceRoot: repositoryRoot,
    runtimeRoot,
    dataRoot: path.join(runtimeRoot, "data"),
    backupRoot: path.join(runtimeRoot, "backups"),
    downloadsRoot: path.join(runtimeRoot, "downloads"),
    logsRoot: path.join(runtimeRoot, "logs"),
    desktopRoot: path.join(runtimeRoot, "desktop"),
    apiHost: "127.0.0.1",
    apiPort: port,
    webHost: "127.0.0.1",
    webPort,
    mcpPort,
    desktopMcpPort,
    cookieName: `${instanceId}-session`,
    releaseChannel: instanceId,
    gmUserId: randomUUID(),
    secretsFile: path.join(runtimeRoot, "secrets.json"),
    peopleFile: path.join(runtimeRoot, "people.json"),
  };
  for (const root of [
    config.dataRoot,
    config.backupRoot,
    config.downloadsRoot,
    config.logsRoot,
    config.desktopRoot,
    path.join(config.dataRoot, "evidence"),
    path.join(config.dataRoot, "evidence", "quarantine"),
  ])
    await mkdir(root, { recursive: true });
  await writeFile(
    config.secretsFile,
    JSON.stringify(
      Object.fromEntries(
        ["sessionSecret", "debugToken", "gmPassword"].map((key) => [
          key,
          randomBytes(48).toString("base64url"),
        ]),
      ),
    ),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    config.peopleFile,
    JSON.stringify({ schemaVersion: 4, projectKey: "LOCAL", people: [] }),
  );
  const configFile = path.join(runtimeRoot, "instance.json");
  await writeFile(configFile, JSON.stringify(config));
  const first = startApi(configFile);
  t.after(async () => stopChild(first.child));

  const firstResponse = await waitForHealth(port, first.child, first.output);
  const firstHealth = await firstResponse.json();
  const validateLiveHealth = await createLiveHealthValidator();
  assert.equal(validateLiveHealth(firstHealth), true, JSON.stringify(validateLiveHealth.errors));
  assert.equal(firstHealth.status, "ok");
  assert.equal(firstHealth.service, "relay-qa-hub-api");
  assert.equal(firstHealth.version, "0.1.0-debug");
  assert.equal(firstHealth.buildSha, "dev", "untrusted inherited QA_HUB overrides are discarded");
  const firstReady = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`).then((r) =>
    r.json(),
  );
  assert.equal(firstReady.status, "ready");
  assert.equal(firstReady.schemaVersion, "14");
  await stopChild(first.child);

  const second = startApi(configFile);
  t.after(async () => stopChild(second.child));
  const secondResponse = await waitForHealth(port, second.child, second.output);
  assert.equal(secondResponse.status, 200);
  await stopChild(second.child);
});
