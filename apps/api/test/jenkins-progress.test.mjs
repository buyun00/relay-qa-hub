import assert from "node:assert/strict";
import test from "node:test";
import { parseBuildLog, describeBuild, applyBuildHistory } from "../dist/jenkins-progress.js";
import { JenkinsBuildService } from "../dist/jenkins-builds.js";

const timed = `00:00:01.000 [JenkinsPlayerPolicy] profile=sdk-external requested=App effective=App reason=external_profile_unchanged
00:00:01.100 [init] MAKE_PKG_ZIP_VAL=true
00:00:10.000 + notify_stage '🛠 Unity 导出中（最耗时，约 10-30 分钟）…'
00:02:10.000 + notify_stage '📦 Unity 导出完成，开始编译 APK…'
00:07:10.000 BUILD SUCCESSFUL in 5m 0s
00:07:15.000 + notify_stage '☁️ APK 完成，上传热更资源到 CDN…'
00:07:30.000 + notify_stage '📦 开始打整包 ZIP（从本地 CDN 目录读取所有模块）…'
00:08:20.000 [OZDQP-PUBLISH] finalize revision=abc`;
const meta = (number = 1, overrides = {}) => ({
  number,
  timestamp: 1_000_000,
  duration: 510_000,
  queueId: number + 100,
  result: "SUCCESS",
  building: false,
  actions: [
    {
      causes: [{ userName: "admin" }],
      parameters: [{ name: "networkScope", value: "外网_保留原参数" }],
    },
  ],
  ...overrides,
});
const describe = (metadata, log = timed, now = 2_000_000, observed = new Map()) =>
  describeBuild(metadata, parseBuildLog(log), now, observed);

test("timestamped stages carry actual boundaries, worker work and a separate Gradle timer", () => {
  const result = describe(meta());
  assert.deepEqual(
    result.stages.map((s) => s.elapsedMs),
    [10_000, 120_000, 305_000, 15_000, 50_000, 10_000],
  );
  assert.ok(result.stages.every((s) => s.timing === "recorded" && s.state === "complete"));
  assert.equal(result.stages[2].toolElapsedMs, 300_000);
  assert.equal(result.triggeredBy, "admin");
  assert.equal(result.executor, "Jenkins · 内置节点");
  assert.equal(applyBuildHistory([result])[0].percent, 100);
});

test("legacy logs retain stage order without inventing stage durations or exposing console secrets", () => {
  const legacy = timed.replace(/^\d+:\d+:\d+\.\d+ /gmu, "  ") + "\n+ PRIVATE_TOKEN=not-for-browser";
  const result = describe(meta(), legacy);
  assert.ok(result.stages.every((s) => s.elapsedMs === null));
  assert.equal(result.elapsedMs, 510_000);
  assert.equal(result.stages[2].toolElapsedMs, 300_000);
  assert.equal(JSON.stringify(result).includes("PRIVATE_TOKEN"), false);
  assert.equal(JSON.stringify(result).includes("not-for-browser"), false);
});

test("resource-only history skips APK and ZIP, failures stop at the observed stage", () => {
  const resourceLog =
    "00:00:01.000 [JenkinsPlayerPolicy] profile=internal-nosdk requested=Res effective=Res reason=hot_update_allowed\n00:00:01.100 [init] MAKE_PKG_ZIP_VAL=false\n00:00:10.000 + notify_stage '🛠 Unity 导出中…'\n00:05:10.000 + notify_stage '☁️ 资源导出完成，上传热更资源到 CDN…'";
  const result = describe(meta(), resourceLog);
  assert.equal(result.mode, "Res");
  assert.equal(result.stages[2].state, "skipped");
  assert.equal(result.stages[4].state, "skipped");
  const failed = applyBuildHistory([
    describe(meta(1, { result: "ABORTED" }), timed.split("\n").slice(0, 3).join("\n")),
  ])[0];
  assert.equal(failed.stages[1].state, "failed");
  assert.equal(failed.stages[2].state, "waiting");
  assert.ok(failed.percent < 100);
});

test("matching successful stage history sets robust alarms; failures and other modes cannot skew it", () => {
  const historical = [1, 2, 3].map((id) => describe(meta(id)));
  const current = describe(
    meta(4, { building: true, result: null }),
    timed.split("\n").slice(0, 3).join("\n"),
    1_500_000,
  );
  const unrelated = describe(meta(5, { result: "FAILURE", duration: 99_000_000 }));
  const differentMode = { ...describe(meta(6)), mode: "Res" };
  const result = applyBuildHistory([...historical, unrelated, differentMode, current]).at(-1);
  assert.equal(result.stages[1].sampleCount, 3);
  assert.equal(result.stages[1].expectedMs, 120_000);
  assert.equal(result.stages[1].alertAfterMs, 240_000);
  assert.equal(result.stages[1].alert, true);
  assert.equal(result.stages[1].percent, 95);
  assert.equal(result.expectedMs, 510_000);
  assert.ok(result.percent < 100);
});

test("untimed running stages use lower-bound observation and initial alarms, never become samples", () => {
  const observations = new Map();
  const log = timed
    .split("\n")
    .slice(0, 3)
    .join("\n")
    .replace(/^\d+:\d+:\d+\.\d+ /gmu, "");
  const metadata = meta(1, { building: true, result: null });
  const initial = describe(metadata, log, 2_000_000, observations);
  assert.equal(initial.stages[1].timing, "observed");
  assert.equal(initial.stages[1].elapsedMs, 0);
  const later = applyBuildHistory([describe(metadata, log, 4_000_000, observations)])[0];
  assert.equal(later.stages[1].elapsedMs, 2_000_000);
  assert.equal(later.stages[1].alert, true);
  assert.equal(later.stages[1].alertBasis, "initial");
});

test("monitor follows the precise queue executable, handles canceled/expired queues and tolerates log loss", async () => {
  const jobPath = `/job/${encodeURIComponent("01-【OZDQP】【Android】")}/`;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const seen = [];
  const service = new JenkinsBuildService(async (value) => {
    const url = new URL(value);
    seen.push(url.pathname);
    if (url.pathname === `${jobPath}api/json`) return json({ buildable: true, builds: [meta(2)] });
    if (url.pathname === "/queue/item/101/api/json")
      return json({
        id: 101,
        task: { url: `http://10.100.5.129:8080${jobPath}` },
        executable: { number: 1 },
      });
    if (url.pathname === "/queue/item/103/api/json")
      return json({
        id: 103,
        task: { url: `http://10.100.5.129:8080${jobPath}` },
        cancelled: true,
      });
    if (url.pathname === "/queue/item/104/api/json") return json({}, 404);
    if (url.pathname === `${jobPath}1/api/json`) return json(meta(1));
    if (url.pathname === `${jobPath}1/timestamps/`) return new Response(timed);
    if (url.pathname === `${jobPath}2/timestamps/`) return json({}, 503);
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  const result = await service.progress([101, 103, 104]);
  assert.equal(result.builds.find((b) => b.queueId === 101).number, 1);
  assert.equal(result.builds.find((b) => b.number === 2).logError, true);
  assert.deepEqual(
    result.queues.map((q) => q.status),
    ["CANCELLED", "UNKNOWN"],
  );
  const before = seen.length;
  assert.deepEqual(await service.progress([104, 103, 101]), result);
  assert.equal(seen.length, before, "identical watches share cached requests");
});
