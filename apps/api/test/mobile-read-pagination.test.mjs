import assert from "node:assert/strict";
import test from "node:test";

import { createApiApp } from "../dist/index.js";
import { ProjectRequestContext } from "../dist/project-request-context.js";
import { createSqliteMobileProjectDirectoryStore } from "../dist/sqlite-mobile-project-directory-store.js";

const actorId = "10000000-0000-4000-8000-000000000001";
const accountId = "10000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-000000000003";
const bugId = "10000000-0000-4000-8000-000000000004";
const itemId = "10000000-0000-4000-8000-000000000005";
const authorization = { authorization: "Bearer read-token" };

test("frozen read routes pass strict normalized pagination and project filters to stores", async (t) => {
  const calls = [];
  const app = createApiApp({
    logger: false,
    debugActorId: actorId,
    debugBearerToken: "read-token",
    now: () => new Date("2026-09-09T00:00:00.000Z"),
    mobileProjectDirectoryStore: {
      async listProjects(query) {
        calls.push(["projects", query]);
        return { snapshotSequence: 7, items: [], nextCursor: null };
      },
      async listMembers(query) {
        calls.push(["members", query]);
        return { projectId, snapshotSequence: 7, items: [], nextCursor: null };
      },
      async listModules() {
        throw new Error("not used");
      },
    },
    mobileBuildStore: {
      async listBuilds(query) {
        calls.push(["builds", query]);
        return { projectId, snapshotSequence: 7, items: [], nextCursor: null };
      },
      async registerBuild() {
        throw new Error("not used");
      },
      async getBuild() {
        return null;
      },
      async linkRepair() {
        throw new Error("not used");
      },
    },
    mobileCommentStore: {
      async listComments(query) {
        calls.push(["comments", query]);
        return { bugId, projectId, snapshotSequence: 7, items: [], nextCursor: null };
      },
      async addComment() {
        throw new Error("not used");
      },
      async listEvents(query) {
        calls.push(["events", query]);
        return { bugId, projectId, snapshotSequence: 7, items: [], nextCursor: null };
      },
    },
    mobileNotificationStore: {
      async listNotifications(query) {
        calls.push(["notifications", query]);
        return {
          snapshotSequence: 7,
          items: [
            {
              id: itemId,
              accountId,
              projectId,
              userId: actorId,
              type: "bug.updated",
              title: "Updated",
              body: "internal body",
              bugId,
              buildId: null,
              sourceEventId: itemId,
              payload: { internal: true },
              createdAt: "2026-09-09T00:00:00.000Z",
              readAt: null,
              version: 1,
            },
          ],
          nextCursor: null,
          unreadCount: 1,
          consumed: 0,
          duplicate: 0,
        };
      },
    },
  });
  t.after(() => app.close());

  const requests = [
    `/api/v1/projects?cursor=project-cursor&limit=2`,
    `/api/v1/projects/${projectId}/members?cursor=member-cursor&limit=3`,
    `/api/v1/projects/${projectId}/builds?status=ready&cursor=build-cursor&limit=4`,
    `/api/v1/bugs/${bugId}/comments?cursor=comment-cursor&limit=5`,
    `/api/v1/bugs/${bugId}/events?afterSequence=6&limit=7`,
    `/api/v1/notifications?projectId=${projectId}&unreadOnly=true&cursor=notice-cursor&limit=8`,
  ];
  const responses = [];
  for (const url of requests) {
    const response = await app.inject({ method: "GET", url, headers: authorization });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    responses.push(response.json());
  }

  assert.deepEqual(calls[0], ["projects", { actorId, cursor: "project-cursor", limit: 2 }]);
  assert.deepEqual(calls[1], [
    "members",
    { actorId, projectId, cursor: "member-cursor", limit: 3 },
  ]);
  assert.deepEqual(calls[2], [
    "builds",
    { actorId, projectId, status: "ready", cursor: "build-cursor", limit: 4 },
  ]);
  assert.deepEqual(calls[3], ["comments", { actorId, bugId, cursor: "comment-cursor", limit: 5 }]);
  assert.deepEqual(calls[4], ["events", { actorId, bugId, afterSequence: 6, limit: 7 }]);
  assert.deepEqual(calls[5], [
    "notifications",
    {
      actorId,
      projectId,
      unreadOnly: true,
      cursor: "notice-cursor",
      limit: 8,
      now: "2026-09-09T00:00:00.000Z",
    },
  ]);
  const notification = responses.at(-1);
  assert.equal(notification.snapshotSequence, 7);
  assert.equal("body" in notification.items[0], false);
  assert.deepEqual(Object.keys(notification.items[0]).sort(), [
    "accountId",
    "bugId",
    "createdAt",
    "id",
    "projectId",
    "readAt",
    "title",
    "type",
    "userId",
    "version",
  ]);

  const jsonResponse = await app.inject({
    method: "GET",
    url: `/api/v1/notifications?projectId=${projectId}&unreadOnly=true&limit=8`,
    headers: { ...authorization, accept: "application/json" },
  });
  assert.equal(jsonResponse.statusCode, 200, jsonResponse.body);
  assert.match(jsonResponse.headers["content-type"], /^application\/json/u);
  const jsonNotification = jsonResponse.json();
  assert.equal("snapshotSequence" in jsonNotification, false);
  assert.equal(jsonNotification.items[0].body, "internal body");
  assert.equal("accountId" in jsonNotification.items[0], false);
  assert.deepEqual(Object.keys(jsonNotification.items[0]).sort(), [
    "body",
    "bugId",
    "createdAt",
    "id",
    "projectId",
    "readAt",
    "title",
    "type",
    "userId",
    "version",
  ]);
});

test("project collection does not require a selected project scope", async (t) => {
  const calls = [];
  const context = new ProjectRequestContext();
  const scoped = context.scope({
    accountId,
    projectId,
    actorId,
    membershipId: itemId,
    projectKey: "AAA",
    projectName: "Alpha",
    accountDisplayName: "Account",
    createdAt: "2026-09-09T00:00:00.000Z",
  });
  const directory = createSqliteMobileProjectDirectoryStore({
    scope: scoped,
    worker: {
      async listMobileVisibleProjects(query) {
        calls.push(query);
        return { snapshotSequence: 1, items: [], nextCursor: null };
      },
    },
  });
  const app = createApiApp({
    logger: false,
    debugActorId: actorId,
    debugBearerToken: "read-token",
    mobileProjectDirectoryStore: directory,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/projects?limit=1",
    headers: authorization,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls, [{ accountId, actorId, limit: 1 }]);
});

test("frozen read routes reject extra, duplicate and non-canonical query values", async (t) => {
  const app = createApiApp({
    logger: false,
    debugActorId: actorId,
    debugBearerToken: "read-token",
  });
  t.after(() => app.close());
  for (const url of [
    "/api/v1/projects?extra=true",
    `/api/v1/projects/${projectId}/builds?limit=01`,
    `/api/v1/bugs/${bugId}/events?afterSequence=1.0`,
    "/api/v1/notifications?unreadOnly=TRUE",
    "/api/v1/notifications?limit=1&limit=2",
  ]) {
    const response = await app.inject({ method: "GET", url, headers: authorization });
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
    assert.deepEqual(response.json(), { code: "INVALID_REQUEST" });
  }
});

test("notification reads fail closed with the frozen authorization response", async (t) => {
  const app = createApiApp({
    logger: false,
    debugActorId: actorId,
    debugBearerToken: "read-token",
    mobileNotificationStore: {
      async listNotifications() {
        throw Object.assign(new Error("current membership is required"), { code: "FORBIDDEN" });
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/notifications",
    headers: authorization,
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(response.json(), { code: "FORBIDDEN" });
});

test("notification read route passes the authenticated actor, CAS body and idempotency key", async (t) => {
  const calls = [];
  const readAt = "2026-09-10T10:05:00.000Z";
  const app = createApiApp({
    logger: false,
    debugActorId: actorId,
    debugBearerToken: "read-token",
    mobileNotificationStore: {
      async listNotifications() {
        throw new Error("not used");
      },
      async markRead(command) {
        calls.push(command);
        return {
          id: itemId,
          accountId,
          projectId,
          userId: actorId,
          type: "bug.updated",
          title: "Updated",
          bugId,
          createdAt: "2026-09-10T10:00:00.000Z",
          readAt,
          version: 2,
        };
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/notifications/${itemId}/read`,
    headers: { ...authorization, "idempotency-key": "client-read-action" },
    payload: { expectedVersion: 1 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls, [
    {
      actorId,
      notificationId: itemId,
      idempotencyKey: "client-read-action",
      request: { expectedVersion: 1 },
    },
  ]);
  assert.deepEqual(response.json(), {
    id: itemId,
    accountId,
    projectId,
    userId: actorId,
    type: "bug.updated",
    title: "Updated",
    bugId,
    createdAt: "2026-09-10T10:00:00.000Z",
    readAt,
    version: 2,
  });
});

test("notification read route preserves frozen CAS and authorization error statuses", async (t) => {
  let failure = "VERSION_CONFLICT";
  const app = createApiApp({
    logger: false,
    debugActorId: actorId,
    debugBearerToken: "read-token",
    mobileNotificationStore: {
      async listNotifications() {
        throw new Error("not used");
      },
      async markRead() {
        throw Object.assign(new Error(failure), { code: failure });
      },
    },
  });
  t.after(() => app.close());
  const inject = () =>
    app.inject({
      method: "POST",
      url: `/api/v1/notifications/${itemId}/read`,
      headers: { ...authorization, "idempotency-key": "client-read-action" },
      payload: { expectedVersion: 1 },
    });

  const stale = await inject();
  assert.equal(stale.statusCode, 412, stale.body);
  assert.deepEqual(stale.json(), { code: "VERSION_CONFLICT" });
  failure = "IDEMPOTENCY_PAYLOAD_MISMATCH";
  const mismatch = await inject();
  assert.equal(mismatch.statusCode, 409, mismatch.body);
  assert.deepEqual(mismatch.json(), { code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  failure = "FORBIDDEN";
  const forbidden = await inject();
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.deepEqual(forbidden.json(), { code: "FORBIDDEN" });
});

test("notification read route rejects malformed CAS bodies and missing idempotency keys", async (t) => {
  const app = createApiApp({
    logger: false,
    debugActorId: actorId,
    debugBearerToken: "read-token",
  });
  t.after(() => app.close());
  for (const request of [
    {
      headers: authorization,
      payload: { expectedVersion: 1 },
    },
    {
      headers: { ...authorization, "idempotency-key": "client-read-action" },
      payload: { expectedVersion: 0 },
    },
    {
      headers: { ...authorization, "idempotency-key": "client-read-action" },
      payload: { expectedVersion: 1, extra: true },
    },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${itemId}/read`,
      ...request,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { code: "INVALID_REQUEST" });
  }
});
