import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
const config = readParallelInstanceConfig(process.argv[2]);
const api = `http://${config.apiHost}:${config.apiPort}`;
const path = join(
  config.sourceRoot,
  "docs/evidence/project-components/web-browser/dual-window-fixture.json",
);
const secrets = JSON.parse(readFileSync(config.secretsFile, "utf8"));
let token;
async function request(method, route, body) {
  const response = await fetch(api + route, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(`${method} ${route}: ${response.status} ${value.code ?? "error"}`);
  return value;
}
token = (
  await request("POST", "/api/v1/auth/gm/login", {
    password: secrets.gmPassword,
    client: "android",
  })
).accessToken;
if (process.argv[3] === "setup") {
  const stamp = Date.now();
  const name = `Web双窗${stamp}`;
  const projects = [];
  for (const suffix of ["A", "B"])
    projects.push(
      await request("POST", "/api/v1/gm/projects", {
        id: randomUUID(),
        key: `DW${suffix}${stamp}`,
        name: `双窗草稿验收 ${suffix}`,
      }),
    );
  let userId;
  for (const project of projects)
    userId = (
      await request("POST", "/api/v1/auth/login", {
        projectId: project.id,
        name,
        client: "android",
      })
    ).userId;
  const record = { createdAt: new Date().toISOString(), name, userId, projects, actions: [] };
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record));
} else if (process.argv[3] === "readback") {
  const record = JSON.parse(readFileSync(path, "utf8"));
  const projects = [];
  for (const project of record.projects) {
    const bugs = await request("GET", `/api/v1/bugs?projectId=${project.id}`);
    const attachments = [];
    for (const bug of bugs.items)
      attachments.push(await request("GET", `/api/v1/bugs/${bug.id}/attachments`));
    projects.push({ projectId: project.id, bugs, attachments });
  }
  record.readback = { at: new Date().toISOString(), projects };
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record.readback));
} else {
  const record = JSON.parse(readFileSync(path, "utf8"));
  const project = record.projects[0];
  const member = (await request("GET", `/api/v1/projects/${project.id}/users`)).items.find(
    (item) => item.userId === record.userId,
  );
  const active = process.argv[3] === "restore";
  const value = await request("PUT", `/api/v1/gm/projects/${project.id}/members/${record.userId}`, {
    active,
    expectedVersion: member.membershipVersion,
  });
  record.actions.push({
    at: new Date().toISOString(),
    active,
    expectedVersion: member.membershipVersion,
    result: value,
  });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record.actions.at(-1)));
}
