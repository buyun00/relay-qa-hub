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

const waitingLog = `00:00:05.928 [lock] 等待构建锁...
00:00:05.931 [lock] 另一个构建正在运行: iOS_Build_#30，等待释放...`;
test("a started Jenkins run blocked by the shared build lock is queued without preparation alarms", () => {
  const result = applyBuildHistory([
    describe(meta(10159, { building: true, result: null }), waitingLog, 1_600_000),
  ])[0];
  assert.equal(
    result.status,
    "BUILDING",
    "Jenkins state stays compatible with the upload coordinator",
  );
  assert.deepEqual(result.queueWait, {
    active: true,
    blockingBuild: "iOS_Build #30",
    elapsedMs: 594072,
    timing: "recorded",
  });
  assert.equal(result.percent, 0);
  assert.ok(result.stages.every((s) => s.state === "waiting" && s.elapsedMs === null && !s.alert));
});
test("recorded lock wait is subtracted from preparation and execution history, not raw build time", () => {
  const withWait =
    waitingLog + "\n00:08:38.273 [lock] 已获取构建锁\n00:08:43.000 + notify_stage 'Unity 导出中'";
  const live = describe(meta(10159, { building: true, result: null }), withWait, 1_550_000);
  assert.equal(live.queueWait.active, false);
  assert.equal(live.queueWait.elapsedMs, 512345);
  assert.equal(live.stages[0].elapsedMs, 10655);
  assert.equal(live.stages[1].elapsedMs, 27000);
  assert.equal(live.elapsedMs, 550000);
  assert.equal(live.executionElapsedMs, 37655);
  const shift = timed.replace(
    /^(\d+):(\d{2}):(\d{2})\.(\d{3})/gmu,
    (_, h, m, s, ms) => `${h}:${String(Number(m) + 10).padStart(2, "0")}:${s}.${ms}`,
  );
  const history = describe(
    meta(2, { duration: 1110000 }),
    "00:00:05.000 [lock] 等待构建锁...\n00:10:05.000 [lock] 已获取构建锁\n" + shift,
  );
  assert.equal(history.stages[0].elapsedMs, 10000);
  assert.equal(history.executionElapsedMs, 510000);
  assert.equal(applyBuildHistory([history, describe(meta(3))])[1].expectedMs, 510000);
});
test("untimed lock wait has a lower bound and preparation timing starts after acquisition", () => {
  const log = waitingLog.replace(/^\d+:\d+:\d+\.\d+ /gmu, "");
  const observations = new Map();
  const metadata = meta(4, { building: true, result: null });
  assert.equal(describe(metadata, log, 1_010_000, observations).queueWait.elapsedMs, 0);
  const waiting = describe(metadata, log, 1_500_000, observations);
  assert.equal(waiting.queueWait.elapsedMs, 490000);
  assert.equal(waiting.queueWait.timing, "observed");
  assert.equal(waiting.stages[0].elapsedMs, null);
  const acquired = log + "\n[lock] 已获取构建锁";
  const first = describe(metadata, acquired, 1_510_000, observations);
  assert.equal(first.queueWait.active, false);
  assert.equal(first.queueWait.elapsedMs, null);
  assert.equal(first.executionElapsedMs, null);
  assert.equal(first.stages[0].elapsedMs, 0);
  assert.equal(describe(metadata, acquired, 1_515_000, observations).stages[0].elapsedMs, 5000);
  const finished = describe(
    meta(4),
    acquired + "\n+ notify_stage 'Unity 导出中'",
    1_515_000,
    observations,
  );
  assert.equal(finished.stages[0].elapsedMs, null);
});
test("cancellation while waiting and non-whitelisted log content do not pretend to execute preparation", () => {
  const cancelled = describe(meta(5, { result: "ABORTED", duration: 650000 }), waitingLog);
  assert.equal(cancelled.queueWait.active, false);
  assert.equal(cancelled.stages[0].state, "waiting");
  assert.equal(cancelled.stages[0].elapsedMs, null);
  const echo = describe(
    meta(6, { building: true, result: null }),
    "00:00:00.000 + echo '[lock] 等待构建锁...'",
  );
  assert.equal(echo.queueWait, undefined);
  const secret = describe(
    meta(7, { building: true, result: null }),
    waitingLog.split("\n")[0] + "\n[lock] 另一个构建正在运行: PASSWORD_SECRET，等待释放...",
  );
  assert.equal(secret.queueWait.blockingBuild, null);
  assert.ok(!JSON.stringify(secret).includes("PASSWORD_SECRET"));
});
test("positive stage evidence ends the queue display even when the acquisition marker is absent", () => {
  const value = describe(
    meta(8, { building: true, result: null }),
    waitingLog + "\n00:10:00.000 + notify_stage 'Unity 导出中'",
    1_610_000,
  );
  assert.equal(value.queueWait.active, false);
  assert.equal(value.queueWait.elapsedMs, null);
  assert.equal(value.stages[0].elapsedMs, null);
  assert.equal(value.stages[1].state, "running");
});

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
