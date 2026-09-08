import { relayOutboxResumeReason, type RelayOutboxItem } from "./relay-outbox-api";

const stateLabels: Record<string, string> = {
  paused: "已暂停",
  pending: "等待交接",
  retry: "等待重试",
  claimed: "正在交接",
  submitted: "已提交 Relay",
  failed: "交接失败",
};
export default function RelayOutboxPanel({
  projectId,
  items,
  enabled,
  held,
  busy,
  onResume,
}: {
  projectId: string;
  items: readonly RelayOutboxItem[];
  enabled: boolean;
  held: boolean;
  busy: boolean;
  onResume: (item: RelayOutboxItem) => void;
}) {
  return (
    <section aria-labelledby="relay-outbox-title">
      <h2 id="relay-outbox-title">Bug 的 Relay 交接记录</h2>
      <p>
        交接与批次任务分别记录。重新启用组件不会自动重放暂停交接；提交到 Relay
        后仍需查看任务最终结果。
      </p>
      <ul className="project-history-list">
        {items.length === 0 ? (
          <li>暂无交接记录。</li>
        ) : (
          items
            .filter((item) => item.projectId === projectId)
            .map((item) => {
              const reason = relayOutboxResumeReason(item, projectId, enabled, held);
              return (
                <li key={item.id}>
                  <strong>
                    Bug {item.bugId} · {stateLabels[item.state] ?? item.state}
                  </strong>
                  <p>
                    项目 {item.projectId} · 配置版本 {item.componentVersion} · 尝试{" "}
                    {item.attemptCount} 次
                  </p>
                  <p>
                    交接 {item.handoffId} · 队列记录 {item.id}
                  </p>
                  <p>
                    创建于 {item.createdAt}
                    {item.submittedAt ? ` · 提交于 ${item.submittedAt}` : ""}
                  </p>
                  {item.relayTaskId && <p>Relay 任务 {item.relayTaskId}</p>}
                  {item.errorCode && (
                    <p>
                      {item.errorCode === "COMPONENT_DISABLED_PAUSED"
                        ? "暂停原因：组件关闭或开始执行条件变化，等待明确恢复。"
                        : `上次交接结果：${item.errorCode}`}
                    </p>
                  )}
                  {item.state === "paused" && (
                    <>
                      {reason && <p>{reason}</p>}
                      <button
                        className="secondary-button"
                        disabled={busy || !!reason}
                        onClick={() => onResume(item)}
                      >
                        恢复此交接
                      </button>
                    </>
                  )}
                </li>
              );
            })
        )}
      </ul>
    </section>
  );
}
