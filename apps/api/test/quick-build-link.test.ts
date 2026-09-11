import assert from "node:assert/strict";
import test from "node:test";
import { JenkinsBuildService } from "../src/jenkins-builds.js";
import { buildInfo, QUICK_BUILD_PRESETS, QUICK_JOB_NAME } from "./quick-build-fixture.mjs";

for (const mismatch of [false, true])
  test(`quick result verifies upstream while artifact number differs: mismatch=${mismatch}`, async () => {
    const preset = QUICK_BUILD_PRESETS[2]!;
    const info = buildInfo(preset, 508);
    info.requestId = preset.childJob + "#507";
    const parentPath = `/job/${encodeURIComponent(QUICK_JOB_NAME)}/3/`;
    const childPath = `/job/${encodeURIComponent(preset.childJob)}/507/`;
    const service = new JenkinsBuildService(async (value) => {
      const url = new URL(value);
      if (url.pathname === parentPath + "api/json")
        return Response.json({
          number: 3,
          building: false,
          result: "SUCCESS",
          actions: [{ parameters: [{ name: "打包用途", value: preset.label }] }],
        });
      if (url.pathname === parentPath + "artifact/build-result.json") return Response.json(info);
      if (url.pathname === childPath + "api/json")
        return Response.json({
          number: 507,
          building: false,
          result: "SUCCESS",
          actions: [
            { causes: [{ upstreamProject: QUICK_JOB_NAME, upstreamBuild: mismatch ? 2 : 3 }] },
          ],
        });
      throw new Error("Unexpected path " + url.pathname);
    });
    if (mismatch)
      await assert.rejects(service.buildResult(3, preset.id), { code: "BUILD_IDENTITY_MISMATCH" });
    else {
      const result = await service.buildResult(3, preset.id);
      assert.equal(result.childBuildNumber, 507);
      assert.equal(result.buildNumber, 508);
      assert.ok(result.hotUpdate.url.includes("/508/hot-update/"));
    }
  });

test("quick parent projects the verified child's lock wait and path failure", async () => {
  let fail = false;
  const parentPath = `/job/${encodeURIComponent(QUICK_JOB_NAME)}/`,
    childJob = "01-【OZDQP】【Android】",
    childPath = `/job/${encodeURIComponent(childJob)}/`;
  const fetcher: typeof fetch = async (value) => {
    const u = new URL(value);
    if (u.pathname === parentPath + "api/json")
      return Response.json({
        buildable: true,
        builds: [
          {
            number: 3,
            queueId: 40,
            timestamp: 100000,
            duration: 20000,
            building: !fail,
            result: fail ? "FAILURE" : null,
            actions: [{ parameters: [{ name: "打包用途", value: QUICK_BUILD_PRESETS[1]!.label }] }],
          },
        ],
      });
    if (u.pathname === parentPath + "3/timestamps/")
      return new Response("Starting building: " + childJob + " #507");
    if (u.pathname === childPath + "507/api/json")
      return Response.json({
        number: 507,
        timestamp: 101000,
        building: !fail,
        result: fail ? "FAILURE" : null,
        actions: [{ causes: [{ upstreamProject: QUICK_JOB_NAME, upstreamBuild: 3 }] }],
      });
    if (u.pathname === childPath + "507/timestamps/")
      return new Response(
        fail
          ? "[JenkinsPlayerPolicy] ERROR: Invalid Unity project path: secret-path"
          : "00:00:01.000 [lock] 等待构建锁...\n00:00:01.100 [lock] 另一个构建正在运行: iOS_Build_#30，等待释放...",
      );
    throw new Error("Unexpected path");
  };
  const waiting = (await new JenkinsBuildService(fetcher).progress()).builds[0]!;
  assert.equal(waiting.queueWait?.active, true);
  assert.equal(waiting.queueWait?.blockingBuild, "iOS_Build #30");
  fail = true;
  const failed = (await new JenkinsBuildService(fetcher).progress()).builds[0]!;
  assert.equal(failed.errorCode, "BUILD_PROJECT_PATH_INVALID");
  assert.ok(!JSON.stringify(failed).includes("secret-path"));
});
