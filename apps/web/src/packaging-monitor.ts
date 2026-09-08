import type { PackagingProgress } from "./packaging-api";

export interface WatchedBuild {
  queueId: number;
  number?: number;
  submittedAt: number;
  finished: boolean;
  alerts: string[];
}
export interface PackagingNotice {
  id: string;
  kind: "success" | "warning" | "failure";
  title: string;
  body: string;
}
const TERMINAL = new Set(["SUCCESS", "FAILURE", "ABORTED", "UNSTABLE", "NOT_BUILT"]);

export function readWatchedBuilds(storage: string | null, now = Date.now()): WatchedBuild[] {
  try {
    const value: unknown = JSON.parse(storage ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (v): v is WatchedBuild =>
          v !== null &&
          typeof v === "object" &&
          Number.isSafeInteger(v.queueId) &&
          v.queueId > 0 &&
          (v.number === undefined || (Number.isSafeInteger(v.number) && v.number > 0)) &&
          typeof v.finished === "boolean" &&
          Number.isFinite(v.submittedAt) &&
          v.submittedAt > now - 7 * 86_400_000 &&
          Array.isArray(v.alerts) &&
          v.alerts.length <= 10 &&
          v.alerts.every((id: unknown) => typeof id === "string" && /^[a-z]+$/u.test(id)),
      )
      .slice(-10);
  } catch {
    return [];
  }
}

/** Exact queue/build identity and durable per-stage receipts prevent duplicate notifications. */
export function reconcileBuilds(watched: WatchedBuild[], progress: PackagingProgress) {
  const notices: PackagingNotice[] = [];
  let completed = false;
  const next = watched.map((watch) => {
    if (watch.finished) return watch;
    const build = progress.builds.find(
      (b) =>
        b.queueId === watch.queueId || (watch.number !== undefined && b.number === watch.number),
    );
    const queue = progress.queues.find((q) => q.id === watch.queueId);
    if (!build) {
      if (queue?.status !== "CANCELLED") return watch;
      notices.push({
        id: `queue-${watch.queueId}-cancelled`,
        kind: "failure",
        title: "打包已取消",
        body: `排队 #${watch.queueId} 已被 Jenkins 取消。`,
      });
      return { ...watch, finished: true };
    }
    const updated = { ...watch, number: build.number, alerts: [...watch.alerts] };
    if (TERMINAL.has(build.status)) {
      updated.finished = true;
      completed = true;
      notices.push({
        id: `build-${build.number}-finished`,
        kind: build.status === "SUCCESS" ? "success" : "failure",
        title:
          build.status === "SUCCESS"
            ? "打包完成"
            : build.status === "ABORTED"
              ? "打包已取消"
              : "打包未成功",
        body: `构建 #${build.number}${build.status === "SUCCESS" ? (build.mode === "Res" ? " 资源更新完成；此流程不生成新 APK。下载列表正在刷新。" : " 已完成，下载列表正在刷新。") : ` 已结束（${build.status}），请查看构建阶段。`}`,
      });
    } else if (!build.logError && !build.queueWait?.active) {
      for (const stage of build.stages) {
        if (!stage.alert || updated.alerts.includes(stage.id)) continue;
        updated.alerts.push(stage.id);
        notices.push({
          id: `build-${build.number}-${stage.id}`,
          kind: "warning",
          title: "打包阶段耗时异常",
          body: `构建 #${build.number}「${stage.label}」已超过 ${Math.ceil(stage.alertAfterMs / 60_000)} 分钟警戒线。当前工作：${stage.work}。任务继续执行。`,
        });
      }
    }
    return updated;
  });
  return { watched: next, notices, completed };
}
