import { useCallback, useEffect, useRef, useState } from "react";

import { getProjectMetricsOverview, QaHubApiError, type ProjectMetricsOverview } from "./api";

const DAY_MS = 24 * 60 * 60 * 1000;

type MetricsState = "loading" | "success" | "error";

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dateBoundary(value: string): string {
  return `${value}T00:00:00.000Z`;
}

function metricsError(cause: unknown): { readonly status: number; readonly code: string } {
  if (cause instanceof QaHubApiError) {
    return { status: cause.status, code: cause.code ?? "METRICS_UNAVAILABLE" };
  }
  return { status: 0, code: "NETWORK_ERROR" };
}

export interface MetricsPanelProps {
  readonly projectId: string;
}

export function MetricsPanel({ projectId }: MetricsPanelProps) {
  const initialNow = useRef(Date.now());
  const [fromDate, setFromDate] = useState(() => utcDate(initialNow.current - 29 * DAY_MS));
  const [toDate, setToDate] = useState(() => utcDate(initialNow.current + DAY_MS));
  const [state, setState] = useState<MetricsState>("loading");
  const [overview, setOverview] = useState<ProjectMetricsOverview | null>(null);
  const [error, setError] = useState<{ readonly status: number; readonly code: string } | null>(
    null,
  );
  const requestGenerationRef = useRef(0);
  const rangeRef = useRef({ fromDate, toDate });
  rangeRef.current = { fromDate, toDate };

  const load = useCallback(
    async (selectedProjectId: string, selectedFromDate: string, selectedToDate: string) => {
      const generation = requestGenerationRef.current + 1;
      requestGenerationRef.current = generation;
      setState("loading");
      setError(null);
      try {
        const nextOverview = await getProjectMetricsOverview(
          selectedProjectId,
          dateBoundary(selectedFromDate),
          dateBoundary(selectedToDate),
        );
        if (requestGenerationRef.current !== generation) return;
        setOverview(nextOverview);
        setState("success");
      } catch (cause: unknown) {
        if (requestGenerationRef.current !== generation) return;
        setState("error");
        setError(metricsError(cause));
      }
    },
    [],
  );

  useEffect(() => {
    setOverview(null);
    void load(projectId, rangeRef.current.fromDate, rangeRef.current.toDate);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [load, projectId]);

  const totalBugCount =
    overview?.currentStateCounts.reduce((total, item) => total + item.count, 0) ?? 0;

  return (
    <section aria-labelledby="metrics-title" className="workspace-card metrics-card">
      <div className="section-heading">
        <div>
          <p className="card-kicker">QA Hub facts · read only</p>
          <h2 id="metrics-title">项目概览</h2>
        </div>
        <span className={`status-dot status-dot--${state}`}>
          {state === "loading" ? "计算中" : state === "error" ? "统计错误" : "事实已读取"}
        </span>
      </div>

      <form
        className="metrics-filter"
        onSubmit={(event) => {
          event.preventDefault();
          void load(projectId, fromDate, toDate);
        }}
      >
        <label>
          新 Bug 起始（UTC）
          <input
            onChange={(event) => setFromDate(event.target.value)}
            required
            type="date"
            value={fromDate}
          />
        </label>
        <label>
          截止、不含当日（UTC）
          <input
            onChange={(event) => setToDate(event.target.value)}
            required
            type="date"
            value={toDate}
          />
        </label>
        <button className="secondary-button" disabled={state === "loading"} type="submit">
          重新计算
        </button>
      </form>

      {state === "error" && error !== null && (
        <p aria-live="assertive" className="api-error" id="metrics-error">
          统计读取失败：HTTP {error.status === 0 ? "网络不可达" : error.status} · {error.code}。
          {overview === null ? "Bug 列表与详情仍可继续使用。" : "下方保留上一次成功快照。"}
        </p>
      )}

      {overview !== null && (
        <>
          <div aria-label="真实项目统计" className="metrics-summary">
            <article>
              <span>窗口内新 Bug</span>
              <strong>{overview.newBugCount}</strong>
              <small>
                {overview.window.from.slice(0, 10)} 至 {overview.window.to.slice(0, 10)}（不含）
              </small>
            </article>
            <article>
              <span>当前 Bug 总数</span>
              <strong>{totalBugCount}</strong>
              <small>项目当前状态事实</small>
            </article>
          </div>
          <div aria-label="当前 Bug 状态分布" className="metrics-states">
            {overview.currentStateCounts.map((item) => (
              <div key={item.state}>
                <span>{item.state}</span>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
          <p className="api-footnote">
            来自 QA Hub SQLite 事实源 · snapshot {overview.snapshotSequence}
          </p>
        </>
      )}
    </section>
  );
}
