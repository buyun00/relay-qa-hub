import assert from "node:assert/strict";
import test from "node:test";
import { readBuildBranches, parseBranchChoices } from "../dist/jenkins-branches.js";
import { JenkinsBuildService } from "../dist/jenkins-builds.js";
import { buildInfo, QUICK_BUILD_PRESETS } from "./quick-build-fixture.mjs";
import {
  buildSourceBranch,
  buildSourceBranches,
  QUICK_JOB_NAME,
} from "@relay-qa-hub/upload-contract";

test("build handoff binds its manifest to the pinned source request and selected branch", async () => {
  const preset = QUICK_BUILD_PRESETS[2],
    raw = buildInfo(preset),
    source = {
      requestId: raw.sourceRequestId,
      sourceRevision: raw.sourceRevision,
      sourceBranch: raw.sourceBranch,
      platform: preset.platform,
      configuration: preset.configuration,
    };
  const make = (change = {}) =>
    new JenkinsBuildService(async (value) => {
      const p = decodeURIComponent(new URL(value).pathname);
      if (p.endsWith("/artifact/build-result.json")) return Response.json(raw);
      if (p.endsWith("/artifact/source-request.json"))
        return Response.json({ ...source, ...change });
      if (p.includes(QUICK_JOB_NAME))
        return Response.json({
          number: 42,
          building: false,
          result: "SUCCESS",
          actions: [
            {
              parameters: [
                { name: "打包用途", value: preset.label },
                { name: "源码分支", value: raw.sourceBranch },
              ],
            },
          ],
        });
      return Response.json({
        number: 46,
        building: false,
        result: "SUCCESS",
        actions: [{ causes: [{ upstreamProject: QUICK_JOB_NAME, upstreamBuild: 42 }] }],
      });
    });
  assert.equal((await make().buildResult(42, preset.id)).sourceBranch, raw.sourceBranch);
  for (const change of [
    { sourceBranch: "release/older" },
    { sourceRevision: "d".repeat(40) },
    { requestId: "e".repeat(32) },
    { platform: "iOS" },
  ])
    await assert.rejects(make(change).buildResult(42, preset.id), /BUILD_IDENTITY_MISMATCH/);
});

test("branch selection respects builder rules and rejects invalid refs without silently falling back", () => {
  assert.equal(buildSourceBranch(undefined, "Debug"), "main");
  assert.equal(buildSourceBranch(undefined, "Release"), "auto");
  assert.equal(buildSourceBranch("release/2026-08-30", "Release"), "release/2026-08-30");
  for (const branch of [
    "main",
    "release/../main",
    "release/a.lock",
    "release//a",
    "release/a;curl",
    "release/a b",
    null,
  ])
    assert.throws(() => buildSourceBranch(branch, "Release"), /INVALID_BUILD_BRANCH/);
  assert.throws(() => buildSourceBranch("release/2026-09-11", "Debug"));
  assert.throws(() => buildSourceBranches({ "android-debug": "main", shell: "bad" }));
});
test("catalog uses the installed helper default and permits manual releases when auto is unavailable", () => {
  const list = [
    "auto | 自动：最新封板分支 → release/2026-09-11 | abcdef1234:selected",
    "release/2026-08-30 | 123456789a",
  ];
  assert.deepEqual(
    parseBranchChoices([list, list], "Release").map((c) => [c.value, c.resolvedBranch]),
    [
      ["auto", "release/2026-09-11"],
      ["release/2026-08-30", "release/2026-08-30"],
    ],
  );
  const manual = ["unavailable | 没有自动候选", "release/hotfix | abcdef1234"];
  assert.equal(parseBranchChoices([manual, manual], "Release")[0].value, "release/hotfix");
  assert.throws(() =>
    parseBranchChoices([["main | abcdef1234"], ["main | abcdef1234"]], "Release"),
  );
});
test("Active Choices queries preserve their isolated session and never submit a build", async () => {
  let configuration;
  const posts = [];
  const fetcher = async (value, init) => {
    const u = new URL(value),
      h = new Headers(init.headers);
    assert.equal(h.get("authorization"), "Basic fixture");
    if (u.pathname === "/crumbIssuer/api/json")
      return Response.json(
        { crumbRequestField: "Jenkins-Crumb", crumb: "csrf" },
        { headers: { "set-cookie": "JSESSIONID=branches; Path=/" } },
      );
    assert.equal(h.get("cookie"), "JSESSIONID=branches");
    if (u.pathname === `/job/${encodeURIComponent(QUICK_JOB_NAME)}/build`)
      return new Response(
        '<span data-name="源码分支" data-proxy-name="branch_1"></span><script src="/$stapler/bound/script/$stapler/bound/aaaa-1111?var=branch_1&amp;methods=doUpdate,getChoicesForUI"></script>',
        { status: 405 },
      );
    if (u.pathname.includes("/bound/script/"))
      return new Response(
        "branch_1 = makeStaplerProxy('/$stapler/bound/aaaa-1111','abc123',['doUpdate','getChoicesForUI']);",
      );
    assert.equal(init.method, "POST");
    assert.equal(h.get("crumb"), "abc123");
    assert.equal(h.get("jenkins-crumb"), "csrf");
    posts.push(u.pathname);
    if (u.pathname.endsWith("/doUpdate")) {
      configuration = JSON.parse(init.body)[0].includes(" Release ") ? "Release" : "Debug";
      return Response.json(null);
    }
    assert.ok(u.pathname.endsWith("/getChoicesForUI"));
    const list =
      configuration === "Debug"
        ? ["main | abcdef1234:selected"]
        : [
            "auto | 自动：最新封板分支 → release/2026-09-11 | 123456789a:selected",
            "release/2026-09-11 | 123456789a",
          ];
    return Response.json([list, list]);
  };
  const result = await readBuildBranches(fetcher, "http://jenkins.test", "Basic fixture");
  assert.equal(result.Debug[0].value, "main");
  assert.equal(result.Release[0].value, "auto");
  assert.equal(posts.length, 4);
  assert.ok(posts.every((p) => p.startsWith("/$stapler/bound/")));
});
