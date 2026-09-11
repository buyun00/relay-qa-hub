import type { BuildPreset } from "./jenkins-builds.js";
import { QUICK_BUILD_PRESETS } from "@relay-qa-hub/upload-contract";

export interface JenkinsBuildRecord {
  number: number;
  timestamp: number;
  duration?: number;
  estimatedDuration?: number;
  queueId?: number;
  builtOn?: string;
  building: boolean;
  result: string | null;
  actions?: {
    parameters?: { name: string; value?: unknown }[];
    causes?: { userName?: string; upstreamProject?: string; upstreamBuild?: number }[];
  }[];
}

const MINUTE = 60_000;
export const BUILD_STAGES = [
  {
    id: "prepare",
    label: "准备环境",
    work: "分配版本、同步代码并判断构建方式",
    limit: 5 * MINUTE,
  },
  {
    id: "unity",
    label: "Unity 导出",
    work: "生成热更资源、编译脚本并导出 Android 工程",
    limit: 30 * MINUTE,
  },
  {
    id: "apk",
    label: "编译 APK",
    work: "Gradle / IL2CPP 编译、签名并复制 APK 到下载目录",
    limit: 15 * MINUTE,
  },
  { id: "publish", label: "发布资源", work: "上传热更资源并更新 CDN", limit: 10 * MINUTE },
  {
    id: "zip",
    label: "生成增量 ZIP",
    work: "从 CDN 目录汇总模块并生成可下载 ZIP",
    limit: 10 * MINUTE,
  },
  {
    id: "finalize",
    label: "完成校验",
    work: "记录发布版本、保存包体基线并完成 Jenkins 任务",
    limit: 3 * MINUTE,
  },
] as const;
export type StageId = (typeof BUILD_STAGES)[number]["id"];
export interface BuildStageProgress {
  id: StageId;
  label: string;
  work: string;
  state: "waiting" | "running" | "complete" | "skipped" | "failed";
  elapsedMs: number | null;
  toolElapsedMs: number | null;
  timing: "recorded" | "observed" | "unavailable";
  expectedMs: number | null;
  sampleCount: number;
  alertAfterMs: number;
  alertBasis: "history" | "initial";
  percent: number | null;
  alert: boolean;
}
export interface BuildProgress {
  errorCode?: string;
  number: number;
  queueId: number | null;
  preset: BuildPreset | null;
  status: string;
  startedAt: string;
  elapsedMs: number;
  executionElapsedMs?: number | null;
  queueWait?: {
    active: boolean;
    blockingBuild: string | null;
    elapsedMs: number | null;
    timing: "recorded" | "observed" | "unavailable";
  };
  expectedMs: number | null;
  triggeredBy: string;
  historySampleCount?: number;
  progressBasis?: "build_history" | "stages";
  executor: string;
  mode: "App" | "Res" | "Script" | null;
  includesZip: boolean | null;
  percent: number;
  stages: BuildStageProgress[];
  logError: boolean;
}
export interface PackagingProgress {
  checkedAt: string;
  builds: BuildProgress[];
  queues: { id: number; status: "QUEUED" | "CANCELLED" | "UNKNOWN"; reason: string }[];
}
export interface ParsedBuildLog {
  downstream?: { job: string; number: number };
  errorCode?: string;
  markers: Partial<Record<StageId, number | null>>;
  mode: BuildProgress["mode"];
  zip: boolean | null;
  gradleMs: number | null;
  lockWait?: {
    start: number | null;
    end: number | null;
    acquired: boolean;
    blockingBuild: string | null;
  };
}

/** Only known stage markers are exported. Console output can contain credentials. */
export function parseBuildLog(log: string): ParsedBuildLog {
  const parsed: ParsedBuildLog = { markers: { prepare: 0 }, mode: null, zip: null, gradleMs: null };
  for (const raw of log.split(/\r?\n/u)) {
    const timed = /^(\d+):(\d{2}):(\d{2})\.(\d{3})\s+(.*)$/u.exec(raw.trimStart());
    const elapsed = timed
      ? ((Number(timed[1]) * 60 + Number(timed[2])) * 60 + Number(timed[3])) * 1000 +
        Number(timed[4])
      : null;
    const line = (timed ? timed[5]! : raw).trim();
    const downstream =
      /^Starting building: (01-【OZDQP】【Android】|02-【OZDQP】【iOS】) #(\d{1,10})$/.exec(line);
    if (downstream) parsed.downstream = { job: downstream[1]!, number: Number(downstream[2]) };
    if (/^\[JenkinsPlayerPolicy\] ERROR: Invalid Unity project path:/.test(line))
      parsed.errorCode = "BUILD_PROJECT_PATH_INVALID";
    if (/^Scheduling project: /u.test(line))
      parsed.lockWait = { start: elapsed, end: null, acquired: false, blockingBuild: null };
    if (/^Starting building: /u.test(line)) {
      if (parsed.lockWait) {
        parsed.lockWait.acquired = true;
        parsed.lockWait.end = elapsed;
      }
      parsed.markers.unity = elapsed;
    }
    if (line === "[Pipeline] { (核对产物并提供下载)") parsed.markers.finalize = elapsed;
    // Actual script output only: an echoed command is not proof it has executed.
    if (/^\[lock\] 等待构建锁(?:\.{3}|…)?$/u.test(line) && !parsed.lockWait)
      parsed.lockWait = { start: elapsed, end: null, acquired: false, blockingBuild: null };
    if (parsed.lockWait && !parsed.lockWait.acquired) {
      const blocker =
        /^\[lock\] 另一个构建正在运行: (iOS_Build|Android_Build)_#(\d{1,10})，等待释放(?:\.{3}|…)?$/u.exec(
          line,
        );
      if (blocker) parsed.lockWait.blockingBuild = `${blocker[1]} #${blocker[2]}`;
      if (line === "[lock] 已获取构建锁") {
        parsed.lockWait.acquired = true;
        parsed.lockWait.end = elapsed;
      }
    }
    const policy =
      /^\[(?:JenkinsPlayerPolicy|iOSPlayerPolicy)\].*\beffective=(App|Res|Script)\b/u.exec(line);
    if (policy) parsed.mode = policy[1] as ParsedBuildLog["mode"];
    const zip = /^\[init\] MAKE_PKG_ZIP_VAL=(true|false)$/u.exec(line);
    if (zip) parsed.zip = zip[1] === "true";
    const gradle = /^BUILD SUCCESSFUL in (?:(\d+)h )?(?:(\d+)m )?(\d+)(?:\.\d+)?s$/u.exec(line);
    if (gradle)
      parsed.gradleMs =
        ((Number(gradle[1] ?? 0) * 60 + Number(gradle[2] ?? 0)) * 60 + Number(gradle[3])) * 1000;
    let stage: StageId | undefined;
    if (/^(?:\+ notify_stage ['"]|\[build\] ).*Unity 导出中/u.test(line)) stage = "unity";
    else if (
      /^(?:\+ notify_stage ['"]|\[build\] ).*(开始编译 APK|开始编译 IPA|Xcode 编译)/u.test(line) ||
      /^> (?:Configure project|Task) :(?:launcher|unityLibrary)\b/u.test(line) ||
      /^\[buildIPA\] xcodebuild (?:archive|-exportArchive) 开始$/u.test(line) ||
      line === "[buildIPA] 检测到 Podfile，执行 pod install"
    )
      stage = "apk";
    else if (/^(?:\+ notify_stage ['"]|\[build\] ).*上传热更资源到 CDN/u.test(line))
      stage = "publish";
    else if (/^(?:\+ notify_stage ['"]|\[build\] ).*开始打整包 ZIP/u.test(line)) stage = "zip";
    else if (
      /^\[OZDQP-PUBLISH\] finalize\b/u.test(line) ||
      /^\+ record_player_base_revision\b/u.test(line)
    )
      stage = "finalize";
    if (stage && !(stage in parsed.markers)) parsed.markers[stage] = elapsed;
  }
  return parsed;
}

export function buildPreset(build: JenkinsBuildRecord): BuildPreset | null {
  const params = Object.fromEntries(
    (build.actions ?? []).flatMap((a) => a.parameters ?? []).map((p) => [p.name, p.value]),
  );
  const quick = QUICK_BUILD_PRESETS.find((p) => p.label === params["打包用途"]);
  if (quick) return quick.id;
  return params["networkScope"] === "外网_保留原参数"
    ? "external"
    : params["networkScope"] === "内网_自动判断"
      ? params["internalUseSdk"] === "接入SDK"
        ? "internal-sdk"
        : "internal-nosdk"
      : null;
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function describeBuild(
  build: JenkinsBuildRecord,
  parsed: ParsedBuildLog,
  now: number,
  observed: Map<string, number>,
  logError = false,
): BuildProgress {
  const elapsedMs = build.building
    ? Math.max(0, now - build.timestamp)
    : Math.max(0, build.duration ?? 0);
  const seen = BUILD_STAGES.filter((s) => s.id in parsed.markers);
  const current = seen.at(-1)!.id;
  const currentIndex = BUILD_STAGES.findIndex((s) => s.id === current);
  // The iOS script reports its policy before export, but has no export-start marker.
  // Keep this interval explicit instead of showing a five-minute preparation alarm.
  const combinedIosExport =
    buildPreset(build)?.startsWith("ios-") && parsed.mode !== null && !("unity" in parsed.markers);
  const lock = parsed.lockWait;
  const pendingLock = !!lock && !lock.acquired && current === "prepare";
  const waiting = pendingLock && build.building;
  let waitMs: number | null = null;
  let waitTiming: "recorded" | "observed" | "unavailable" = "unavailable";
  const waitEnd = lock?.acquired ? lock.end : pendingLock ? elapsedMs : null;
  if (lock && lock.start !== null && waitEnd !== null && waitEnd >= lock.start && !logError) {
    waitMs = waitEnd - lock.start;
    waitTiming = "recorded";
  } else if (waiting && !logError) {
    const key = `${build.number}:queue`;
    if (!observed.has(key)) observed.set(key, now);
    waitMs = Math.max(0, now - observed.get(key)!);
    waitTiming = "observed";
  }
  if (pendingLock) observed.delete(`${build.number}:prepare`);
  const stages = BUILD_STAGES.map((definition, index): BuildStageProgress => {
    const start = parsed.markers[definition.id];
    const next = seen[seen.findIndex((s) => s.id === definition.id) + 1];
    const end = next ? parsed.markers[next.id] : elapsedMs;
    const seenStage = start !== undefined;
    const skipped =
      !seenStage &&
      (index < currentIndex ||
        (!build.building && build.result === "SUCCESS") ||
        (definition.id === "apk" && parsed.mode === "Res") ||
        (definition.id === "zip" && parsed.zip === false));
    const state = pendingLock
      ? "waiting"
      : skipped
        ? "skipped"
        : !seenStage
          ? "waiting"
          : definition.id !== current
            ? "complete"
            : build.building
              ? "running"
              : build.result === "SUCCESS"
                ? "complete"
                : "failed";
    let timing: BuildStageProgress["timing"] = "unavailable";
    let duration: number | null = null;
    // Preparation has a known start, but its end still needs a timestamp.
    if (
      seenStage &&
      !pendingLock &&
      start !== null &&
      end != null &&
      end >= start &&
      !(logError && build.building) &&
      (definition.id !== "prepare" || !lock || waitTiming === "recorded")
    ) {
      duration = Math.max(0, end - start - (definition.id === "prepare" ? (waitMs ?? 0) : 0));
      timing = "recorded";
    } else if (state === "running" && !logError) {
      const key = `${build.number}:${definition.id}`;
      if (!observed.has(key)) observed.set(key, now);
      duration = Math.max(0, now - observed.get(key)!);
      timing = "observed";
    }
    return {
      id: definition.id,
      label:
        combinedIosExport && definition.id === "prepare" ? "准备并导出 iOS 工程" : definition.label,
      work:
        combinedIosExport && definition.id === "prepare"
          ? "同步构建配置、编译脚本并导出 iOS 工程"
          : definition.work,
      state,
      elapsedMs: duration,
      toolElapsedMs: definition.id === "apk" ? parsed.gradleMs : null,
      timing,
      expectedMs: null,
      sampleCount: 0,
      alertAfterMs:
        combinedIosExport && definition.id === "prepare" ? BUILD_STAGES[1].limit : definition.limit,
      alertBasis: "initial",
      percent: state === "complete" ? 100 : null,
      alert: false,
    };
  });
  return {
    ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
    number: build.number,
    queueId: build.queueId ?? null,
    preset: buildPreset(build),
    status: build.building ? "BUILDING" : (build.result ?? "UNKNOWN"),
    startedAt: new Date(build.timestamp).toISOString(),
    elapsedMs,
    executionElapsedMs: lock
      ? waitTiming === "recorded"
        ? Math.max(0, elapsedMs - (waitMs ?? 0))
        : null
      : elapsedMs,
    ...(lock
      ? {
          queueWait: {
            active: waiting,
            blockingBuild: lock.blockingBuild,
            elapsedMs: waitMs,
            timing: waitTiming,
          },
        }
      : {}),
    expectedMs: null,
    triggeredBy:
      (build.actions ?? [])
        .flatMap((a) => a.causes ?? [])
        .find((c) => c.userName)
        ?.userName?.slice(0, 100) ?? "自动触发 / 未记录",
    executor: `Jenkins · ${build.builtOn || "内置节点"}`,
    mode: parsed.mode,
    includesZip: parsed.zip ?? ("zip" in parsed.markers ? true : null),
    percent: 0,
    stages,
    logError,
  };
}

/** Compare matching environment and effective mode, excluding failures and partial observations. */
export function applyBuildHistory(builds: BuildProgress[]): BuildProgress[] {
  return builds.map((build) => {
    const peers = builds.filter(
      (other) =>
        other.number !== build.number &&
        other.status === "SUCCESS" &&
        !other.logError &&
        build.preset !== null &&
        other.preset === build.preset &&
        build.mode !== null &&
        other.mode === build.mode &&
        other.includesZip === build.includesZip,
    );
    const durationSamples = peers.flatMap((p) => {
      const elapsed = p.executionElapsedMs === undefined ? p.elapsedMs : p.executionElapsedMs;
      return elapsed !== null && Number.isFinite(elapsed) && elapsed > 0 ? [elapsed] : [];
    });
    const expectedMs = median(durationSamples);
    const stages = build.stages.map((stage) => {
      const samples = peers.flatMap((p) =>
        p.stages
          .filter(
            (s) =>
              s.id === stage.id &&
              s.state === "complete" &&
              s.timing === "recorded" &&
              s.elapsedMs !== null,
          )
          .map((s) => s.elapsedMs!),
      );
      const expectedMs = median(samples);
      const ordered = [...samples].sort((a, b) => a - b);
      const alertAfterMs =
        samples.length >= 3 && expectedMs !== null
          ? Math.max(
              expectedMs * 2,
              expectedMs + MINUTE,
              ordered[Math.ceil(ordered.length * 0.9) - 1]! + 30_000,
            )
          : stage.alertAfterMs;
      return {
        ...stage,
        expectedMs,
        sampleCount: samples.length,
        alertAfterMs,
        alertBasis: samples.length >= 3 ? ("history" as const) : ("initial" as const),
        percent:
          stage.state === "complete"
            ? 100
            : stage.state === "running" && expectedMs && stage.elapsedMs !== null
              ? Math.min(95, Math.floor((stage.elapsedMs / expectedMs) * 100))
              : null,
        alert:
          !build.logError &&
          stage.state === "running" &&
          stage.elapsedMs !== null &&
          stage.elapsedMs > alertAfterMs,
      };
    });
    const required = stages.filter((s) => s.state !== "skipped");
    const stagePercent =
      build.status === "SUCCESS"
        ? 100
        : Math.min(
            99,
            Math.floor(
              (required.reduce(
                (n, s) =>
                  n +
                  (s.state === "complete" ? 1 : s.state === "running" ? (s.percent ?? 0) / 100 : 0),
                0,
              ) /
                required.length) *
                100,
            ),
          );
    const executionMs =
      build.executionElapsedMs === undefined ? build.elapsedMs : build.executionElapsedMs;
    // A valid total-duration sample remains useful even when older logs did not
    // record individual stage boundaries. Keep this explicitly an estimate;
    // only Jenkins SUCCESS can set 100%, and queue time cannot advance it.
    const useTotalHistory =
      expectedMs !== null &&
      executionMs !== null &&
      Number.isFinite(executionMs) &&
      executionMs >= 0 &&
      !build.queueWait?.active;
    const percent =
      build.status === "SUCCESS"
        ? 100
        : useTotalHistory
          ? Math.min(95, Math.floor((executionMs / expectedMs) * 100))
          : stagePercent;
    return {
      ...build,
      stages,
      percent,
      expectedMs,
      historySampleCount: durationSamples.length,
      progressBasis: useTotalHistory ? "build_history" : "stages",
    };
  });
}
