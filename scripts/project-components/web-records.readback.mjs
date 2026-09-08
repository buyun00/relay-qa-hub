import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const base = "http://127.0.0.1:4419";
const origin = "http://127.0.0.1:4274";
const projects = [
  ["fb914b3b-4169-47f8-8dec-76f3a3cc780d", "TA1788885078625-4"],
  ["383a122d-5c4b-478c-9bd7-7bb2196cf5b2", "TB1788885078632-1"],
];
const auth = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ name: "Web验收0909", projectId: projects[0][0], client: "web" }),
});
if (!auth.ok) throw new Error(`Readback login failed ${auth.status}`);
const cookie = auth.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
await auth.json();
async function get(path, projectId, binary = false) {
  const response = await fetch(base + path, {
    headers: {
      cookie,
      origin,
      "x-qa-project-id": projectId,
      accept: "application/vnd.relay-qa-hub.v1.1+json",
    },
  });
  if (!response.ok) throw new Error(`Readback failed ${response.status} ${path}`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}
const results = [];
for (const [projectId, key] of projects) {
  const components = await get(`/api/v1/projects/${projectId}/components`, projectId);
  const list = await get(`/api/v1/bugs?projectId=${projectId}&limit=500`, projectId);
  const bug = list.items.find((item) => item.key === key);
  if (!bug) throw new Error(`Missing UI-created Bug ${key}`);
  const comments = await get(`/api/v1/bugs/${bug.id}/comments`, projectId);
  const attachments = await get(`/api/v1/bugs/${bug.id}/attachments`, projectId);
  let binary = null;
  if (attachments.items[0]) {
    const bytes = await get(
      `/api/v1/attachments/${attachments.items[0].attachmentId}`,
      projectId,
      true,
    );
    const local = readFileSync(
      "docs/evidence/project-components/web-browser/qa-preview-evidence.jpg",
    );
    binary = {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      matchesLocal: bytes.equals(local),
    };
  }
  results.push({
    projectId,
    components: components.items.map(({ key, enabled, status, version }) => ({
      key,
      enabled,
      status,
      version,
    })),
    bug: {
      id: bug.id,
      key: bug.key,
      state: bug.state,
      version: bug.version,
      ownerId: bug.ownerId,
      verificationOwnerId: bug.verificationOwnerId,
    },
    comments: comments.items,
    attachments: attachments.items.map(({ attachmentId, filename, mediaType, size, sha256 }) => ({
      attachmentId,
      filename,
      mediaType,
      size,
      sha256,
    })),
    binary,
  });
}
const evidence = {
  capturedAt: new Date().toISOString(),
  source: "Independent read-only HTTP readback of UI-created records; cookies remain in memory",
  results,
};
writeFileSync(
  "docs/evidence/project-components/web-browser/http-readback.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    projects: results.map((item) => ({
      projectId: item.projectId,
      bug: item.bug,
      binary: item.binary,
      allComponentsDisabled: item.components.every((component) => !component.enabled),
    })),
  }),
);
