import type { CaptureBundleSummary } from "./api";
import {
  summarizePocoHierarchy,
  summarizeUnitySnapshot,
  type PocoUiNode,
  type UnityRecentError,
} from "./poco-context";

export interface PocoCaptureContext {
  readonly captureId: string;
  readonly bundle: CaptureBundleSummary | null;
  readonly snapshot: unknown | null;
  readonly hierarchy: unknown | null;
  readonly error: string | null;
}

interface PocoContextPanelProps {
  readonly captures: readonly PocoCaptureContext[];
}

const warningCopy: Readonly<Record<string, string>> = {
  business_provider_unavailable: "游戏业务调试 Provider 未注册",
  business_fields_unavailable: "游戏业务调试字段暂不可用",
  ui_context_truncated: "页面上下文已按上限裁剪",
  recent_errors_truncated: "近期错误已按上限裁剪",
};

function statusCopy(status: CaptureBundleSummary["enrichmentStatus"]): string {
  if (status === "complete") return "完整采集";
  if (status === "partial") return "部分采集";
  return "未采集";
}

function artifactStatus(
  bundle: CaptureBundleSummary,
  kind: "poco_hierarchy" | "poco_snapshot",
): "succeeded" | "failed" | "skipped" | "missing" {
  return bundle.artifacts.find((artifact) => artifact.kind === kind)?.status ?? "missing";
}

function formatCapturedAt(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatWindow(milliseconds: number | null): string {
  if (milliseconds === null) return "截图前的有界时间窗口";
  if (milliseconds < 60_000) return `截图前 ${Math.max(1, Math.round(milliseconds / 1_000))} 秒`;
  return `截图前 ${Math.max(1, Math.round(milliseconds / 60_000))} 分钟`;
}

function warningLabel(code: string): string {
  return warningCopy[code] ?? code;
}

function usefulFailureReason(reason: string | null): string | null {
  if (reason === null || reason.trim().toLowerCase() === "unknown") return null;
  return reason;
}

function UiTreeNode({ node }: { readonly node: PocoUiNode }) {
  const metadata = [node.type, ...node.components.filter((component) => component !== node.type)];
  return (
    <li>
      <div className="poco-tree-row">
        <span className="poco-tree-name">{node.name}</span>
        {metadata.slice(0, 4).map((item) => (
          <span className="poco-component" key={item}>
            {item}
          </span>
        ))}
        {node.clickable ? <span className="poco-clickable">可点击</span> : null}
        {node.instanceId === null ? null : (
          <span className="poco-instance">#{node.instanceId}</span>
        )}
        {node.runtimeText === null ? null : (
          <span className="poco-runtime-text">文：{node.runtimeText}</span>
        )}
        {node.visuals.map((visual) => (
          <span className="poco-visual" key={visual}>
            图/纹理：{visual}
          </span>
        ))}
      </div>
      {node.children.length === 0 ? null : (
        <ul>
          {node.children.map((child, index) => (
            <UiTreeNode key={`${child.path}-${index}`} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ErrorEntry({ error }: { readonly error: UnityRecentError }) {
  const occurredAt = formatCapturedAt(error.occurredAtUnixMs);
  return (
    <article className={`poco-error poco-error-${error.level}`}>
      <div>
        <strong>{error.level === "unknown" ? "错误" : error.level}</strong>
        <span>
          {occurredAt ?? "时间未知"}
          {error.repeatCount > 1 ? ` · 重复 ${error.repeatCount} 次` : ""}
        </span>
      </div>
      <p>{error.message}</p>
      {error.stackTrace === null ? null : (
        <details>
          <summary>查看截断后的调用栈</summary>
          <pre>{error.stackTrace}</pre>
        </details>
      )}
    </article>
  );
}

export default function PocoContextPanel({ captures }: PocoContextPanelProps) {
  return (
    <details className="detail-more poco-context-section" open>
      <summary>
        Poco 详情（截图时游戏上下文） <span>{captures.length} 组</span>
      </summary>
      {captures.length === 0 ? (
        <p className="poco-empty">
          这张任务目前没有带 captureId 的 Poco 上下文；普通截图和任务处理不受影响。
        </p>
      ) : null}
      {captures.map(({ captureId, bundle, snapshot, hierarchy, error }) => {
        if (bundle === null) {
          return (
            <section className="context-card" key={captureId}>
              <header className="poco-context-head">
                <div>
                  <strong>Poco 详情暂不可用</strong>
                  <span>Capture ID：{captureId}</span>
                </div>
                <span className="poco-context-status is-unavailable">unavailable</span>
              </header>
              <p className="poco-failure">
                {error ?? "采集包读取失败"}。区域会保留显示，普通截图和任务处理仍可继续。
              </p>
            </section>
          );
        }
        const hierarchySummary = summarizePocoHierarchy(hierarchy);
        const snapshotSummary = summarizeUnitySnapshot(snapshot);
        const hierarchyState = artifactStatus(bundle, "poco_hierarchy");
        const snapshotState = artifactStatus(bundle, "poco_snapshot");
        const capturedAt = formatCapturedAt(snapshotSummary?.capturedAtUnixMs ?? null);
        const failureReason = usefulFailureReason(bundle.poco.failureReason);
        return (
          <section className="context-card" key={captureId}>
            <header className="poco-context-head">
              <div>
                <strong>{statusCopy(bundle.enrichmentStatus)}</strong>
                <span>
                  {snapshotSummary?.scene ?? "场景未知"}
                  {capturedAt === null ? "" : ` · ${capturedAt}`}
                </span>
              </div>
              <span className={`poco-context-status is-${bundle.enrichmentStatus}`}>
                {bundle.enrichmentStatus}
              </span>
            </header>

            <div className="poco-facts">
              <span>游戏 {snapshotSummary?.appVersion ?? "未知"}</span>
              <span>Unity {snapshotSummary?.unityVersion ?? "未知"}</span>
              <span>SDK {bundle.poco.sdkVersion ?? "未知"}</span>
              <span>端口 {bundle.poco.connectedPort ?? "未连接"}</span>
            </div>

            {snapshotSummary?.warnings.length ? (
              <div className="poco-warnings">
                {snapshotSummary.warnings.map((warning) => (
                  <span key={warning}>{warningLabel(warning)}</span>
                ))}
              </div>
            ) : null}
            {failureReason === null ? null : <p className="poco-failure">{failureReason}</p>}

            <div className="poco-debug-grid">
              <section className="poco-debug-card">
                <div className="poco-debug-title">
                  <strong>当前可见页面与层级</strong>
                  <span>
                    {hierarchySummary === null
                      ? "未读取"
                      : `${hierarchySummary.pageRoots.length} 个页面实例 · ${hierarchySummary.visibleNodes} 个可见节点`}
                  </span>
                </div>

                {snapshotSummary?.activePages.length ? (
                  <div className="poco-provider-pages">
                    <p>游戏业务页面</p>
                    {snapshotSummary.activePages.map((page) => (
                      <div
                        key={`${page.path ?? page.prefab ?? page.name}-${page.sortingOrder ?? "-"}`}
                      >
                        <strong>{page.name}</strong>
                        <span>
                          {[
                            page.prefab,
                            page.layer,
                            page.sortingOrder === null ? null : `顺序 ${page.sortingOrder}`,
                            page.rootInstanceId === null ? null : `Dump #${page.rootInstanceId}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {page.path === null ? null : <small>{page.path}</small>}
                      </div>
                    ))}
                  </div>
                ) : null}

                {hierarchySummary?.pageRoots.length ? (
                  <div className="poco-page-list">
                    {hierarchySummary.pageRoots.map((page, index) => (
                      <details key={page.path} open={index === 0}>
                        <summary>
                          <span>
                            <strong>{page.name}</strong>
                            <small>{page.path}</small>
                          </span>
                          <b>{page.components.includes("UIForm") ? "UIForm" : "页面候选"}</b>
                        </summary>
                        <ul className="poco-tree">
                          <UiTreeNode node={page} />
                        </ul>
                      </details>
                    ))}
                    {hierarchySummary.renderTruncated || hierarchySummary.scanTruncated ? (
                      <p className="poco-limit-note">
                        层级较大，网页已做有界展示；原始附件仍保留在后端。
                      </p>
                    ) : null}
                  </div>
                ) : hierarchyState === "succeeded" ? (
                  <p className="poco-empty">
                    已拿到标准 Poco 层级，但没有识别到带 UIForm/页面组件的根节点。原始树仍已保存。
                  </p>
                ) : (
                  <p className="poco-empty">
                    标准 Poco Dump {hierarchyState === "failed" ? "采集失败" : "尚未随这次截图保存"}
                    ；普通截图不受影响。
                  </p>
                )}
              </section>

              <section className="poco-debug-card">
                <div className="poco-debug-title">
                  <strong>截图前的近期错误</strong>
                  <span>
                    {snapshotSummary?.recentErrorsAvailable
                      ? `${snapshotSummary.recentErrors.length} 条 · ${formatWindow(snapshotSummary.recentErrorWindowMs)}`
                      : "游戏侧未提供"}
                  </span>
                </div>
                {snapshotSummary?.recentErrorsAvailable ? (
                  snapshotSummary.recentErrors.length === 0 ? (
                    <p className="poco-empty is-ok">采集窗口内没有 Error / Exception / Assert。</p>
                  ) : (
                    <div className="poco-error-list">
                      {snapshotSummary.recentErrors.map((error, index) => (
                        <ErrorEntry
                          error={error}
                          key={`${error.occurredAtUnixMs ?? "unknown"}-${index}`}
                        />
                      ))}
                    </div>
                  )
                ) : (
                  <p className="poco-empty">
                    当前游戏快照只提供基础运行信息。普通 Android App 无法跨应用读取游戏
                    logcat；需要游戏进程把脱敏后的 Error / Exception / Assert 写入有界缓冲并通过
                    qa.snapshot 返回。
                  </p>
                )}
                {(snapshotSummary?.droppedErrorCount ?? 0) > 0 ? (
                  <p className="poco-limit-note">
                    另有 {snapshotSummary?.droppedErrorCount} 条错误因窗口/容量上限未返回。
                  </p>
                ) : null}
              </section>
            </div>

            <details className="poco-raw">
              <summary>原始采集信息</summary>
              <p>{bundle.poco.succeededMethods.join("、") || "无成功方法"}</p>
              {snapshot === null ? (
                <p>
                  {snapshotState === "failed" ? "qa.snapshot 采集失败" : "没有 qa.snapshot 附件"}
                </p>
              ) : (
                <pre>{JSON.stringify(snapshot, null, 2)}</pre>
              )}
            </details>
          </section>
        );
      })}
    </details>
  );
}
