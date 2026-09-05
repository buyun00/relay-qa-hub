import { useEffect, useRef, useState } from "react";

type Bridge = NonNullable<Window["qaHubDesktop"]>;
type Runtime = Awaited<ReturnType<Bridge["getRuntimeInfo"]>>;
type Connection = Awaited<ReturnType<NonNullable<Bridge["getConnectionStatus"]>>>;
type Update = Awaited<ReturnType<Bridge["getUpdateState"]>>;

export function useDesktopStatus() {
  const bridge = typeof window === "undefined" ? undefined : window.qaHubDesktop;
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const info = await bridge.getRuntimeInfo();
        if (active) {
          setRuntime(info);
          setUnavailable(false);
        }
      } catch {
        if (active) setUnavailable(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
    void bridge
      .getConnectionStatus?.()
      .then((next) => {
        if (active) setConnection(next);
      })
      .catch(() => undefined);
    void bridge
      .getUpdateState()
      .then((next) => {
        if (active) setUpdate(next);
      })
      .catch(() => undefined);
    const unsubscribeConnection = bridge.onConnectionStatus?.(setConnection);
    const unsubscribeUpdate = bridge.onUpdateState(setUpdate);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribeConnection?.();
      unsubscribeUpdate();
    };
  }, [bridge]);

  return { bridge, runtime, connection, update, unavailable };
}

const mcpLabels = {
  disabled: "已禁用",
  stopped: "未启动",
  starting: "启动中",
  listening: "运行中",
  failed: "启动失败",
};

export function updateStatusLabel(state: Update | null): string {
  if (!state) return "正在读取更新状态";
  switch (state.status) {
    case "disabled":
      return "当前构建未启用自动更新";
    case "idle":
      return "可检查更新";
    case "checking":
      return "正在检查更新…";
    case "up-to-date":
      return "已是最新版本";
    case "downloading":
      return `正在下载 ${state.version} · ${state.progressPercent}%`;
    case "ready":
      return `新版本 ${state.version} 已就绪`;
    case "installing":
      return "正在安装，即将重启…";
    case "error":
      return "更新失败，可重试";
  }
}

export function ConnectionLight({
  state,
  label,
}: {
  state: "connected" | "checking" | "offline";
  label: string;
}) {
  return (
    <span className={`connection-light is-${state}`} role="img" aria-label={label} title={label} />
  );
}

export default function DesktopTools({
  desktop,
  backendState,
  usersActive,
  memberCount,
  onOpenUsers,
}: {
  desktop: ReturnType<typeof useDesktopStatus>;
  backendState: "connected" | "checking" | "offline";
  usersActive: boolean;
  memberCount: number;
  onOpenUsers: () => void;
}) {
  const { bridge, runtime, connection, update, unavailable } = desktop;
  const [panel, setPanel] = useState<"mcp" | "status" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const mcp = runtime?.mcp;
  const mcpLabel = unavailable
    ? "状态读取失败"
    : mcp
      ? mcpLabels[mcp.state]
      : runtime
        ? "请更新客户端"
        : "正在读取";
  const version = runtime?.version;
  const configText = mcp
    ? JSON.stringify({ mcpServers: { qahub: { url: mcp.url } } }, null, 2)
    : "";
  const updateBusy =
    busy ||
    update?.status === "checking" ||
    update?.status === "downloading" ||
    update?.status === "installing";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (panel && dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      if (panel) openerRef.current?.focus({ preventScroll: true });
    };
  }, [panel]);

  const openPanel = (next: "mcp" | "status") => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFeedback(null);
    setPanel(next);
  };
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(`${label}已复制`);
    } catch {
      setFeedback("复制失败，请选中下方配置手动复制。");
    }
  };
  const runUpdate = async () => {
    if (!bridge || updateBusy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const accepted =
        update?.status === "ready" ? await bridge.installUpdate() : await bridge.checkForUpdate();
      if (!accepted) setFeedback("更新操作暂不可用，请稍后重试。");
    } catch {
      setFeedback("更新操作未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sidebar-tools" aria-label="管理与设置">
        <button
          className={`utility-card users-card${usersActive ? " is-active" : ""}`}
          aria-current={usersActive ? "page" : undefined}
          onClick={onOpenUsers}
          type="button"
        >
          <svg
            className="utility-icon"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" />
          </svg>
          <span>
            <strong>用户管理</strong>
            <small>{memberCount} 位项目成员</small>
          </span>
          <span className="utility-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        {bridge ? (
          <>
            <button
              className="utility-card compact-card"
              onClick={() => openPanel("mcp")}
              type="button"
              aria-haspopup="dialog"
            >
              <span className="utility-card-heading">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  aria-hidden="true"
                >
                  <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 22" />
                </svg>
                <span
                  className={`mini-light${!unavailable && mcp?.state === "listening" ? " is-online" : ""}`}
                />
              </span>
              <strong>MCP 设置</strong>
              <small>
                {mcpLabel}
                {mcp ? ` · ${mcp.port}` : ""}
              </small>
            </button>
            <button
              className="utility-card compact-card"
              onClick={() => openPanel("status")}
              type="button"
              aria-haspopup="dialog"
            >
              <span className="utility-card-heading">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                {update?.status === "ready" ? <span className="update-badge">新</span> : null}
              </span>
              <strong>当前状态</strong>
              <small>{version ? `v${version}` : unavailable ? "状态读取失败" : "正在读取"}</small>
            </button>
          </>
        ) : null}
      </div>
      {panel ? (
        <dialog
          ref={dialogRef}
          className="desktop-tools-dialog"
          aria-labelledby="desktop-tools-title"
          onCancel={() => setPanel(null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <section className="desktop-tools-content">
            <div className="modal-head">
              <div>
                <p className="eyebrow">QA HUB</p>
                <h2 id="desktop-tools-title">{panel === "mcp" ? "MCP 设置" : "当前状态"}</h2>
              </div>
              <button aria-label="关闭设置" onClick={() => setPanel(null)} type="button">
                ×
              </button>
            </div>
            {panel === "mcp" ? (
              <>
                <p className="desktop-tools-intro">让 AI 工具通过本机 QA Hub 读取和处理任务。</p>
                <dl className="desktop-status-list">
                  <div>
                    <dt>服务状态</dt>
                    <dd>{mcpLabel}</dd>
                  </div>
                  <div>
                    <dt>端口号</dt>
                    <dd>{mcp?.port ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>连接地址</dt>
                    <dd className="desktop-endpoint">{mcp?.url ?? "—"}</dd>
                  </div>
                </dl>
                {mcp?.lastError ? (
                  <p className="desktop-tools-error" role="alert">
                    {mcp.lastError === "EADDRINUSE"
                      ? "端口已被占用，请检查是否有另一个 QA Hub 正在运行。"
                      : mcp.lastError}
                  </p>
                ) : null}
                <div className="desktop-config-heading">
                  <strong>客户端配置 · JSON</strong>
                  <button
                    className="secondary-button"
                    disabled={!mcp}
                    onClick={() => void copy(configText, "配置")}
                    type="button"
                  >
                    复制配置
                  </button>
                </div>
                <pre className="desktop-config" tabIndex={0}>
                  {configText || "当前客户端尚未提供 MCP 配置。"}
                </pre>
                <div className="desktop-tools-actions">
                  <button
                    className="secondary-button"
                    disabled={!mcp}
                    onClick={() => void copy(mcp?.url ?? "", "连接地址")}
                    type="button"
                  >
                    复制连接地址
                  </button>
                </div>
                <p className="desktop-tools-hint">
                  将配置合并到支持 HTTP MCP 的客户端。MCP
                  使用当前登录身份；关闭窗口后仍可在托盘中运行。
                </p>
              </>
            ) : (
              <>
                <div className="desktop-version">
                  <span className="brand-mark">Q</span>
                  <div>
                    <strong>Relay QA Hub</strong>
                    <span>{version ? `当前版本 v${version}` : "当前版本暂不可用"}</span>
                  </div>
                </div>
                <dl className="desktop-status-list">
                  <div>
                    <dt>服务连接</dt>
                    <dd>
                      {backendState === "connected"
                        ? "已连接"
                        : backendState === "offline"
                          ? "连接中断"
                          : "连接中"}
                    </dd>
                  </div>
                  <div>
                    <dt>通知连接</dt>
                    <dd>
                      {connection?.state === "connected"
                        ? "已连接"
                        : connection?.state === "paused"
                          ? "已暂停"
                          : connection?.state === "disabled"
                            ? "未启用"
                            : connection?.state === "connecting" ||
                                connection?.state === "reconnecting"
                              ? "连接中"
                              : "未连接"}
                    </dd>
                  </div>
                  <div>
                    <dt>MCP 服务</dt>
                    <dd>{mcpLabel}</dd>
                  </div>
                </dl>
                <div className="desktop-update-status" role="status">
                  <strong>{updateStatusLabel(update)}</strong>
                  {update?.status === "error" ? <p>{update.message}</p> : null}
                  {update?.status === "downloading" ? (
                    <progress value={update.progressPercent} max={100} aria-label="更新下载进度" />
                  ) : null}
                </div>
                <div className="desktop-tools-actions">
                  <button
                    className="primary-button"
                    disabled={updateBusy || !update || update.status === "disabled"}
                    onClick={() => void runUpdate()}
                    type="button"
                  >
                    {update?.status === "ready"
                      ? "安装并重启"
                      : update?.status === "checking"
                        ? "正在检查…"
                        : update?.status === "downloading"
                          ? "正在下载…"
                          : update?.status === "installing"
                            ? "正在安装…"
                            : "检查更新"}
                  </button>
                </div>
              </>
            )}
            {feedback ? (
              <p className="desktop-tools-feedback" role="status">
                {feedback}
              </p>
            ) : null}
          </section>
        </dialog>
      ) : null}
    </>
  );
}
