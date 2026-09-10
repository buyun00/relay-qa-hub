import assert from "node:assert/strict";
import test from "node:test";

import { parseDesktopBugRoute } from "../src/bug-route.cjs";

const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const USER_ID = "50000000-0000-4000-8000-000000000001";
const BUG_ID = "30000000-0000-4000-8000-000000000001";

test("desktop Bug routes preserve and normalize their project and user scope", () => {
  assert.deepEqual(
    parseDesktopBugRoute({
      projectId: PROJECT_ID.toUpperCase(),
      userId: USER_ID.toUpperCase(),
      bugId: BUG_ID.toUpperCase(),
    }),
    { projectId: PROJECT_ID, userId: USER_ID, bugId: BUG_ID },
  );
});

test("legacy deep links retain an explicitly null project and user scope", () => {
  assert.deepEqual(parseDesktopBugRoute({ projectId: null, userId: null, bugId: BUG_ID }), {
    projectId: null,
    userId: null,
    bugId: BUG_ID,
  });
});

test("desktop Bug routes reject missing, mismatched, invalid, or extra scope data", () => {
  for (const value of [
    { projectId: PROJECT_ID, userId: USER_ID },
    { projectId: PROJECT_ID, userId: null, bugId: BUG_ID },
    { projectId: null, userId: USER_ID, bugId: BUG_ID },
    { projectId: "not-a-uuid", userId: USER_ID, bugId: BUG_ID },
    { projectId: PROJECT_ID, userId: USER_ID, bugId: "not-a-uuid" },
    { projectId: PROJECT_ID, userId: USER_ID, bugId: BUG_ID, extra: true },
  ]) {
    assert.equal(parseDesktopBugRoute(value), null);
  }
});
