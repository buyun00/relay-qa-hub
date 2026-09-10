import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const apiOrigin = process.env.QA_V21_API_ORIGIN;
const secretsPath = process.env.QA_V21_SECRETS_PATH;
const outputPath = process.env.QA_V21_OUTPUT_PATH;
const sourceCommit = process.env.QA_V21_SOURCE_COMMIT;
if (!apiOrigin || !secretsPath || !outputPath || !sourceCommit) {
  throw new Error("isolated live E2E environment is incomplete");
}

const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
assert.equal(typeof secrets.gmPassword, "string");
const runSuffix = Date.now().toString(36).toUpperCase().slice(-7);
const startedAt = new Date().toISOString();
const ledger = [];

async function request(label, path, options = {}, expectedStatus = 200) {
  const response = await fetch(apiOrigin + path, options);
  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { nonJsonBytes: Buffer.byteLength(text) };
    }
  }
  ledger.push({ label, method: options.method ?? "GET", path, status: response.status });
  assert.equal(response.status, expectedStatus, `${label}: ${JSON.stringify(body)}`);
  return { response, body, text };
}

const json = (body, token, projectId, idempotencyKey, method = "POST") => ({
  method,
  headers: {
    accept: "application/vnd.relay-qa-hub.v1.1+json",
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(projectId ? { "x-qa-project-id": projectId } : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  },
  body: JSON.stringify(body),
});

const gmLogin = await request(
  "gm-login",
  "/api/v1/auth/gm/login",
  json({ password: secrets.gmPassword, client: "android" }),
);
const gmToken = gmLogin.body.accessToken;
assert.equal(typeof gmToken, "string");

const projectA = (
  await request(
    "create-project-a",
    "/api/v1/gm/projects",
    json({ key: `V21A${runSuffix}`, name: `v2.1 HTTP E2E A ${runSuffix}` }, gmToken),
  )
).body;
const projectB = (
  await request(
    "create-project-b",
    "/api/v1/gm/projects",
    json({ key: `V21B${runSuffix}`, name: `v2.1 HTTP E2E B ${runSuffix}` }, gmToken),
  )
).body;
assert.match(projectA.id, /^[0-9a-f-]{36}$/u);
assert.match(projectB.id, /^[0-9a-f-]{36}$/u);

const actorA = (
  await request(
    "login-project-a",
    "/api/v1/auth/login",
    json({ projectId: projectA.id, name: `v21-http-a-${runSuffix}`, client: "android" }),
  )
).body;
const actorB = (
  await request(
    "login-project-b",
    "/api/v1/auth/login",
    json({ projectId: projectB.id, name: `v21-http-b-${runSuffix}`, client: "android" }),
  )
).body;
assert.equal(actorA.projectId, projectA.id);
assert.equal(actorB.projectId, projectB.id);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = createHash("sha256").update(png).digest("hex");
const clientSubmissionId = randomUUID();
const clientAttachmentId = randomUUID();
const initKey =
  `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:init`;
const init = (
  await request(
    "upload-init",
    "/api/v1/uploads/init",
    json(
      {
        submissionContractVersion: "1.1.0",
        projectId: projectA.id,
        clientSubmissionId,
        clientAttachmentId,
        uploadAttempt: 1,
        filename: "v21-live-http-e2e.png",
        mediaType: "image/png",
        expectedSize: png.length,
        sha256,
      },
      actorA.accessToken,
      projectA.id,
      initKey,
    ),
    201,
  )
).body;
assert.equal(init.status, "open");
assert.equal(init.version, 1);

const chunkKey =
  `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:chunk:0`;
const chunkResponse = await request(
  "upload-chunk-lost-ack",
  `/api/v1/uploads/${init.sessionId}/chunks/0`,
  {
    method: "PUT",
    headers: {
      authorization: `Bearer ${actorA.accessToken}`,
      "x-qa-project-id": projectA.id,
      "content-type": "application/octet-stream",
      "content-length": String(png.length),
      "if-match": `"${init.version}"`,
      "x-chunk-sha256": sha256,
      "x-client-submission-id": clientSubmissionId,
      "x-client-attachment-id": clientAttachmentId,
      "idempotency-key": chunkKey,
    },
    body: png,
  },
  204,
);
assert.equal(chunkResponse.text, "");

const recoveredChunk = (
  await request(
    "recover-chunk-receipt",
    `/api/v1/uploads/${init.sessionId}`,
    { headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id } },
  )
).body;
assert.equal(recoveredChunk.status, "finalizing");
assert.deepEqual(recoveredChunk.confirmedChunks, [0]);
assert.equal(recoveredChunk.receivedBytes, png.length);
assert.equal(recoveredChunk.version, Number(chunkResponse.response.headers.get("x-upload-version")));

const finalizeKey =
  `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:1:finalize`;
await request(
  "upload-finalize-lost-ack",
  `/api/v1/uploads/${init.sessionId}/finalize`,
  json(
    {
      submissionContractVersion: "1.1.0",
      expectedVersion: recoveredChunk.version,
      clientSubmissionId,
      clientAttachmentId,
      uploadAttempt: 1,
      sha256,
      expectedSize: png.length,
    },
    actorA.accessToken,
    projectA.id,
    finalizeKey,
  ),
);
const recoveredFinalize = (
  await request(
    "recover-finalize-receipt",
    `/api/v1/uploads/${init.sessionId}`,
    { headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id } },
  )
).body;
assert.equal(recoveredFinalize.status, "finalized");
assert.match(recoveredFinalize.attachmentId, /^[0-9a-f-]{36}$/u);
assert.equal(recoveredFinalize.receivedBytes, png.length);
assert.equal(recoveredFinalize.sha256, sha256);

const metadataPath = `/api/v1/attachments/${recoveredFinalize.attachmentId}/metadata`;
const unbound = (
  await request("metadata-unbound", metadataPath, {
    headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id },
  })
).body;
assert.equal(unbound.bindingStatus, "unbound");
assert.equal(unbound.readyToBind, true);
assert.equal(unbound.scanStatus, "clean");
assert.equal(unbound.sha256, sha256);
assert.equal(unbound.size, png.length);

const bindKey = `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:bind:1`;
const reserved = (
  await request(
    "attachment-bind",
    `/api/v1/attachments/${recoveredFinalize.attachmentId}/bind`,
    json(
      {
        submissionContractVersion: "1.1.0",
        expectedVersion: unbound.version,
        projectId: projectA.id,
        clientSubmissionId,
        clientAttachmentId,
        leaseGeneration: 1,
        intent: "bug_create",
      },
      actorA.accessToken,
      projectA.id,
      bindKey,
    ),
  )
).body;
const reservedMetadata = (
  await request("metadata-reserved", metadataPath, {
    headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id },
  })
).body;
assert.equal(reservedMetadata.bindingStatus, "reserved");
assert.equal(reservedMetadata.version, reserved.version);

const bug = (
  await request(
    "create-bug-and-claim",
    "/api/v1/bugs",
    json(
      {
        submissionContractVersion: "1.1.0",
        projectId: projectA.id,
        clientSubmissionId,
        title: `v2.1 live HTTP E2E ${runSuffix}`,
        description: "Isolated upload reconciliation and notification receipt acceptance",
        expectedBehavior: "Recovery, metadata and notification reads remain exact and project scoped",
        ownerId: actorA.userId,
        verificationOwnerId: actorA.userId,
        severity: "S3",
        priority: "P3",
        attachmentIds: [recoveredFinalize.attachmentId],
        occurrence: {
          observedAt: new Date().toISOString(),
          platform: "web",
          steps: ["Run isolated live HTTP acceptance"],
          actualBehavior: "Acceptance record created",
        },
      },
      actorA.accessToken,
      projectA.id,
      `submission:${clientSubmissionId}:commit`,
    ),
    201,
  )
).body;
const claimedMetadata = (
  await request("metadata-claimed", metadataPath, {
    headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id },
  })
).body;
assert.equal(claimedMetadata.bindingStatus, "claimed");
assert.equal(claimedMetadata.version, reserved.version + 1);

await request(
  "upload-project-isolation",
  `/api/v1/uploads/${init.sessionId}`,
  { headers: { authorization: `Bearer ${actorB.accessToken}`, "x-qa-project-id": projectB.id } },
  404,
);
await request(
  "metadata-project-isolation",
  metadataPath,
  { headers: { authorization: `Bearer ${actorB.accessToken}`, "x-qa-project-id": projectB.id } },
  404,
);
await request("upload-unauthenticated", `/api/v1/uploads/${init.sessionId}`, {}, 401);
await request("metadata-unauthenticated", metadataPath, {}, 401);
const malformed = await request(
  "upload-malformed-uuid",
  "/api/v1/uploads/not-a-uuid",
  { headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id } },
  400,
);
assert.equal(malformed.body.code, "INVALID_REQUEST");

const notificationListPath = `/api/v1/notifications?projectId=${projectA.id}&limit=100`;
const notificationsBefore = (
  await request("notifications-before-read", notificationListPath, {
    headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id },
  })
).body;
const notification = notificationsBefore.items.find(
  (item) => item.bugId === bug.bug.id && item.userId === actorA.userId && item.readAt === null,
);
assert.ok(notification, "new Bug notification is missing");
const notificationPath = `/api/v1/notifications/${notification.id}/read`;
await request(
  "notification-project-isolation",
  notificationPath,
  json(
    { expectedVersion: notification.version },
    actorB.accessToken,
    projectB.id,
    `read-b-${runSuffix}`,
  ),
  404,
);
await request(
  "notification-unauthenticated",
  notificationPath,
  json({ expectedVersion: notification.version }, undefined, undefined, `read-none-${runSuffix}`),
  401,
);

const readKey = `read-a-${runSuffix}`;
const firstRead = await request(
  "notification-read",
  notificationPath,
  json({ expectedVersion: notification.version }, actorA.accessToken, projectA.id, readKey),
);
assert.equal(firstRead.body.version, notification.version + 1);
assert.equal(typeof firstRead.body.readAt, "string");
const replayRead = await request(
  "notification-read-replay",
  notificationPath,
  json({ expectedVersion: notification.version }, actorA.accessToken, projectA.id, readKey),
);
assert.equal(replayRead.text, firstRead.text);
const mismatch = await request(
  "notification-read-key-mismatch",
  notificationPath,
  json({ expectedVersion: notification.version + 1 }, actorA.accessToken, projectA.id, readKey),
  409,
);
assert.equal(mismatch.body.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
const stale = await request(
  "notification-read-stale-version",
  notificationPath,
  json(
    { expectedVersion: notification.version },
    actorA.accessToken,
    projectA.id,
    `read-stale-${runSuffix}`,
  ),
  412,
);
assert.equal(stale.body.code, "VERSION_CONFLICT");

const unread = (
  await request(
    "notifications-unread-after-read",
    `/api/v1/notifications?projectId=${projectA.id}&unreadOnly=true&limit=100`,
    { headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id } },
  )
).body;
assert.equal(unread.items.some((item) => item.id === notification.id), false);
const allAfter = (
  await request("notifications-all-after-read", notificationListPath, {
    headers: { authorization: `Bearer ${actorA.accessToken}`, "x-qa-project-id": projectA.id },
  })
).body;
const persistedNotification = allAfter.items.find((item) => item.id === notification.id);
assert.equal(persistedNotification.readAt, firstRead.body.readAt);
assert.equal(persistedNotification.version, firstRead.body.version);

const projects = (
  await request("list-projects-for-cleanup", "/api/v1/gm/projects", {
    headers: { authorization: `Bearer ${gmToken}` },
  })
).body.items;
const cleanup = [];
for (const project of [projectA, projectB]) {
  const current = projects.find((item) => item.id === project.id);
  assert.ok(current);
  const deactivated = (
    await request(
      `deactivate-${project.id === projectA.id ? "project-a" : "project-b"}`,
      `/api/v1/gm/projects/${project.id}`,
      json({ expectedVersion: current.version, active: false }, gmToken, undefined, undefined, "PATCH"),
    )
  ).body;
  assert.equal(deactivated.active, false);
  cleanup.push({ projectId: project.id, priorVersion: current.version, finalVersion: deactivated.version });
}

const summary = {
  schemaVersion: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  apiOrigin,
  sourceCommit,
  isolatedOnly: true,
  credentialsPersisted: false,
  projects: {
    a: { id: projectA.id, key: projectA.key, userId: actorA.userId },
    b: { id: projectB.id, key: projectB.key, userId: actorB.userId },
  },
  upload: {
    sessionId: init.sessionId,
    attachmentId: recoveredFinalize.attachmentId,
    clientSubmissionId,
    clientAttachmentId,
    bytes: png.length,
    sha256,
    transitions: [
      { status: init.status, version: init.version },
      { status: recoveredChunk.status, version: recoveredChunk.version },
      { status: recoveredFinalize.status, version: recoveredFinalize.version },
    ],
    metadataVersions: {
      unbound: unbound.version,
      reserved: reservedMetadata.version,
      claimed: claimedMetadata.version,
    },
  },
  bug: { id: bug.bug.id, key: bug.bug.key, version: bug.bug.version },
  notification: {
    id: notification.id,
    versionBefore: notification.version,
    versionAfter: firstRead.body.version,
    readAt: firstRead.body.readAt,
    exactReplay: replayRead.text === firstRead.text,
    removedFromUnread: !unread.items.some((item) => item.id === notification.id),
    persistedAfterRead: persistedNotification.readAt === firstRead.body.readAt,
  },
  negativeProbes: ledger
    .filter((entry) => entry.status >= 400)
    .map(({ label, method, path, status }) => ({ label, method, path, status })),
  cleanup,
  ledger,
  assertionsPassed: true,
};
await writeFile(outputPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(
  JSON.stringify(
    {
      assertionsPassed: summary.assertionsPassed,
      projectA: summary.projects.a.id,
      projectB: summary.projects.b.id,
      upload: summary.upload.transitions,
      metadataVersions: summary.upload.metadataVersions,
      bug: summary.bug,
      notification: summary.notification,
      negativeProbeStatuses: summary.negativeProbes.map((probe) => ({
        label: probe.label,
        status: probe.status,
      })),
      cleanup: summary.cleanup,
    },
    null,
    2,
  ),
);
