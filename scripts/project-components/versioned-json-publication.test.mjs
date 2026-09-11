import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishVersionedJson } from "./versioned-json-publication.mjs";

const manifest = (versionCode, label = `v${versionCode}`) =>
  Buffer.from(`${JSON.stringify({ schemaVersion: 1, versionCode, label }, null, 2)}\n`);

test("versioned JSON publication creates, advances with history, and replays exact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-versioned-json-"));
  const target = join(root, "latest.json");
  const first = manifest(24);
  const second = manifest(25);

  assert.deepEqual(publishVersionedJson({ target, bytes: first, versionCode: 24 }), {
    published: true,
    replayed: false,
    history: null,
  });
  const advanced = publishVersionedJson({ target, bytes: second, versionCode: 25 });
  assert.equal(advanced.published, true);
  assert.equal(advanced.replayed, false);
  assert.deepEqual(readFileSync(advanced.history), first);
  assert.deepEqual(readFileSync(target), second);
  assert.deepEqual(publishVersionedJson({ target, bytes: second, versionCode: 25 }), {
    published: false,
    replayed: true,
    history: null,
  });
});

test("versioned JSON publication rejects same-version drift and older replacements", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-versioned-json-"));
  const target = join(root, "latest.json");
  writeFileSync(target, manifest(25));

  assert.throws(
    () => publishVersionedJson({ target, bytes: manifest(25, "changed"), versionCode: 25 }),
    /VERSIONED_JSON_NOT_NEWER/u,
  );
  assert.throws(
    () => publishVersionedJson({ target, bytes: manifest(24), versionCode: 24 }),
    /VERSIONED_JSON_NOT_NEWER/u,
  );
  assert.deepEqual(readFileSync(target), manifest(25));
});
