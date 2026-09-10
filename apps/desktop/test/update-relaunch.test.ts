import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acknowledgeUpdateRelaunch, resolveUpdateRelaunchMarker } from "../src/update-relaunch.js";

test("update relaunch acknowledgement is confined to its unique updater directory", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "qa-hub-relaunch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const updates = path.join(root, "updates");
  const handoff = path.join(
    updates,
    "updater-20260910T025617451Z-11304-d9cd3aad-338c-4b9b-b78f-963923e077e9",
  );
  await fs.mkdir(handoff, { recursive: true });
  const marker = path.join(handoff, "relaunched.flag");
  const argument = `--update-relaunch-marker=${marker}`;
  assert.equal(resolveUpdateRelaunchMarker([argument], updates), marker);
  assert.equal(resolveUpdateRelaunchMarker([argument, argument], updates), null);
  assert.equal(
    resolveUpdateRelaunchMarker(
      [`--update-relaunch-marker=${path.join(root, "outside.flag")}`],
      updates,
    ),
    null,
  );
  assert.equal(
    resolveUpdateRelaunchMarker(
      [`--update-relaunch-marker=${path.join(updates, "unexpected", "relaunched.flag")}`],
      updates,
    ),
    null,
  );

  assert.equal(
    await acknowledgeUpdateRelaunch({
      argv: [argument],
      updatesDirectory: updates,
      version: "0.2.0-preview.12",
      pid: 24680,
      now: () => new Date("2026-09-10T03:20:00.000Z"),
    }),
    marker,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), {
    schemaVersion: 1,
    status: "ready",
    version: "0.2.0-preview.12",
    pid: 24680,
    recordedAt: "2026-09-10T03:20:00.000Z",
  });
  await assert.rejects(
    acknowledgeUpdateRelaunch({
      argv: [argument],
      updatesDirectory: updates,
      version: "0.2.0-preview.12",
    }),
    { code: "EEXIST" },
  );
});
