import assert from "node:assert/strict";
import test from "node:test";
import { parsePackagingNotice } from "../src/packaging-notifications.js";

test("packaging IPC accepts bounded notices and rejects unrelated IDs or oversized payloads", () => {
  const notice = {
    id: "build-10140-unity",
    kind: "warning",
    title: "阶段耗时异常",
    body: "请检查 Unity 导出",
  };
  assert.deepEqual(parsePackagingNotice(notice), notice);
  assert.equal(parsePackagingNotice({ ...notice, id: "https://example.com" }), null);
  assert.equal(parsePackagingNotice({ ...notice, body: "x".repeat(601) }), null);
  assert.equal(parsePackagingNotice({ ...notice, kind: "script" }), null);
});
