import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { isWithinOrEqual, pathsOverlap } from "../../scripts/path-boundaries.mjs";

test("Windows path boundaries reject equal, nested, and parent data roots", () => {
  const source = "D:\\Relay-QA-Hub";

  assert.equal(isWithinOrEqual(source, source, path.win32), true);
  assert.equal(pathsOverlap(source, "D:\\Relay-QA-Hub\\runtime-data", path.win32), true);
  assert.equal(pathsOverlap(source, "D:\\", path.win32), true);
});

test("Windows path boundaries allow sibling and cross-drive data roots", () => {
  const source = "D:\\Relay-QA-Hub";

  assert.equal(pathsOverlap(source, "D:\\Relay-QA-Hub-Data", path.win32), false);
  assert.equal(pathsOverlap(source, "E:\\Relay-QA-Hub-Data", path.win32), false);
});
