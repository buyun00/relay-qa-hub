import AppIcon from "./AppIcon";
import { saveMembership } from "./project-api";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  linkManagedProjectUser,
  listManagedProjectUsers,
  QaHubApiError,
  unlinkManagedProjectUser,
  type ManagedProjectUser,
} from "./api";

interface UserManagementPageProps {
  readonly currentUserId: string;
  readonly projectId: string;
  readonly refreshRevision: number;
  readonly onChanged: () => void;
}

function userManagementError(error: unknown): string {
  if (error instanceof QaHubApiError) {
    if (error.status === 403) return "当前身份不能执行这项用户管理操作。";
    if (error.status === 409) return "用户关系已变化，或该用户仍被其他身份关联，请刷新后重试。";
    if (error.status === 404) return "用户或关联关系已不存在，请刷新列表。";
    return error.code === null ? `请求失败（HTTP ${error.status}）` : `请求失败：${error.code}`;
  }
  return error instanceof Error ? error.message : "用户管理操作失败。";
}

function shortId(userId: string): string {
  return userId.slice(0, 8);
}

function statusCopy(user: ManagedProjectUser): string {
  if (user.membershipStatus !== "active") return "此项目已停用";
  if (user.status === "disabled") return "已停用";
  if (user.linkedToUserId !== null) return "已关联";
  return "使用中";
}

export function mutationTargetsManagedUser(mutation: string | null, userId: string): boolean {
  return mutation?.endsWith(`:${userId}`) === true;
}

export default function UserManagementPage({
  currentUserId,
  projectId,
  refreshRevision,
  onChanged,
}: UserManagementPageProps) {
  const [users, setUsers] = useState<readonly ManagedProjectUser[]>([]);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<Readonly<Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [mutation, setMutation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listManagedProjectUsers(projectId);
      setUsers(response.items);
    } catch (cause) {
      setError(userManagementError(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshRevision]);

  const visibleUsers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (normalized.length === 0) return users;
    return users.filter(
      (user) =>
        user.displayName.toLocaleLowerCase("zh-CN").includes(normalized) ||
        user.linkedToDisplayName?.toLocaleLowerCase("zh-CN").includes(normalized) === true ||
        user.userId.includes(normalized),
    );
  }, [query, users]);

  const activeCount = users.filter(
    (user) =>
      user.status === "active" &&
      user.membershipStatus === "active" &&
      user.linkedToUserId === null,
  ).length;
  const linkedCount = users.filter((user) => user.linkedToUserId !== null).length;
  const disabledCount = users.filter((user) => user.membershipStatus !== "active").length;

  const candidatesFor = (source: ManagedProjectUser) =>
    users.filter(
      (candidate) =>
        candidate.userId !== source.userId &&
        candidate.status === "active" &&
        candidate.membershipStatus === "active" &&
        candidate.linkedToUserId === null,
    );

  const mutate = async (key: string, action: () => Promise<void>, success: string) => {
    setMutation(key);
    setError(null);
    setNotice(null);
    let succeeded = false;
    try {
      await action();
      succeeded = true;
      setNotice(success);
    } catch (cause) {
      setError(userManagementError(cause));
    } finally {
      // Do not keep the whole page locked while the post-mutation refresh is in flight.
      setMutation(null);
    }
    if (!succeeded) return;
    await load();
    onChanged();
  };

  return (
    <main className="user-management-page">
      <section className="user-management-hero">
        <div>
          <p className="eyebrow">账号与显示归一</p>
          <h1>用户管理</h1>
          <p>
            手动把重复用户名关联到一个主用户。关联后，人员筛选和任务分配只显示主用户；停用只撤销当前项目资格，其他项目不受影响；可恢复资格，任务与审计历史保留。
          </p>
        </div>
        <div className="user-management-summary" aria-label="用户统计">
          <span>
            <b>{activeCount}</b> 个主用户
          </span>
          <span>
            <b>{linkedCount}</b> 个已关联身份
          </span>
          <span>
            <b>{disabledCount}</b> 个已停用身份
          </span>
        </div>
      </section>

      {error === null ? null : <div className="banner error-banner">{error}</div>}
      {notice === null ? null : (
        <div className="banner success-banner">
          <AppIcon name="success" /> {notice}
        </div>
      )}

      <section className="user-management-panel">
        <div className="user-management-toolbar">
          <div>
            <strong>当前项目用户</strong>
            <span>不会根据名字相似度自动合并，所有关联都由你明确选择。</span>
          </div>
          <label className="user-search">
            <AppIcon name="search" />
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索用户名或用户 ID"
              type="search"
              value={query}
            />
          </label>
        </div>

        <div className="user-management-table" role="table" aria-label="用户列表">
          <div className="user-management-row user-management-header" role="row">
            <span role="columnheader">用户</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">历史引用</span>
            <span role="columnheader">关联到主用户</span>
            <span role="columnheader">操作</span>
          </div>
          {loading ? <div className="loading-row">正在读取用户目录…</div> : null}
          {!loading && visibleUsers.length === 0 ? (
            <div className="empty-state">
              <strong>没有匹配的用户</strong>
              <p>请更换用户名或用户 ID 再搜索。</p>
            </div>
          ) : null}
          {visibleUsers.map((user) => {
            const current = user.userId === currentUserId;
            const busy = mutationTargetsManagedUser(mutation, user.userId);
            const candidates = candidatesFor(user);
            const selectedTarget = targets[user.userId] ?? "";
            const protectedReason = user.protected
              ? "系统人员配置中的用户不能在这里停用或作为重复身份关联。"
              : current
                ? "不能修改当前登录用户。"
                : user.linkedUserCount > 0
                  ? "该用户是其他身份的主用户，请先取消这些关联。"
                  : null;
            const linkRestrictionCopy = user.protected
              ? "配置用户可作为主用户；请在重复账号那一行选择它。"
              : current
                ? "当前登录用户可作为主用户；请在重复账号那一行选择它。"
                : user.linkedUserCount > 0
                  ? `已作为 ${user.linkedUserCount} 个身份的主用户；如需调整，请先取消现有关联。`
                  : candidates.length === 0
                    ? "当前没有可关联的主用户。"
                    : null;
            return (
              <div
                aria-busy={busy || undefined}
                className="user-management-row"
                key={user.userId}
                role="row"
              >
                <div className="managed-user-identity" role="cell">
                  <span className="avatar">{[...user.displayName].at(-1)}</span>
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>
                      {shortId(user.userId)}
                      {current ? " · 当前登录" : ""}
                      {user.protected ? " · 配置用户" : ""}
                    </small>
                  </span>
                </div>
                <div role="cell">
                  <span
                    className={`managed-user-status is-${
                      user.status === "disabled"
                        ? "disabled"
                        : user.linkedToUserId === null
                          ? "active"
                          : "linked"
                    }`}
                  >
                    {statusCopy(user)}
                  </span>
                  {user.activeSessionCount > 0 ? (
                    <small>{user.activeSessionCount} 个活动会话</small>
                  ) : null}
                </div>
                <div className="managed-user-history" role="cell">
                  <strong>{user.taskCount}</strong>
                  <span>个任务</span>
                </div>
                <div className="managed-user-link" role="cell">
                  {user.linkedToUserId !== null ? (
                    <span className="linked-user-copy">
                      <strong>{user.linkedToDisplayName}</strong>
                      <small>作为同一个用户显示</small>
                    </span>
                  ) : user.status === "disabled" ? (
                    <span className="managed-user-muted">已从人员选择器移除</span>
                  ) : linkRestrictionCopy !== null ? (
                    <span className="managed-user-muted">{linkRestrictionCopy}</span>
                  ) : (
                    <select
                      aria-label={`选择 ${user.displayName} 的主用户`}
                      disabled={busy}
                      onChange={(event) =>
                        setTargets((currentTargets) => ({
                          ...currentTargets,
                          [user.userId]: event.target.value,
                        }))
                      }
                      value={selectedTarget}
                    >
                      <option value="">选择主用户…</option>
                      {candidates.map((candidate) => (
                        <option key={candidate.userId} value={candidate.userId}>
                          {candidate.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="managed-user-actions" role="cell">
                  {user.linkedToUserId !== null ? (
                    <button
                      className="secondary-button compact-button"
                      disabled={busy || protectedReason !== null}
                      onClick={() =>
                        void mutate(
                          `unlink:${user.userId}`,
                          () => unlinkManagedProjectUser(projectId, user.userId),
                          `${user.displayName} 的关联已取消。`,
                        )
                      }
                      title={protectedReason ?? undefined}
                      type="button"
                    >
                      取消关联
                    </button>
                  ) : linkRestrictionCopy === null ? (
                    <button
                      className="secondary-button compact-button"
                      disabled={busy || protectedReason !== null || selectedTarget.length === 0}
                      onClick={() => {
                        const target = users.find((item) => item.userId === selectedTarget);
                        if (target === undefined) return;
                        if (
                          !globalThis.confirm(
                            `将“${user.displayName}”关联到主用户“${target.displayName}”？关联后任务选择器只显示主用户。`,
                          )
                        )
                          return;
                        void mutate(
                          `link:${user.userId}`,
                          () => linkManagedProjectUser(projectId, user.userId, target.userId),
                          `${user.displayName} 已关联到 ${target.displayName}。`,
                        );
                      }}
                      title={protectedReason ?? undefined}
                      type="button"
                    >
                      确认关联
                    </button>
                  ) : null}
                  {user.membershipStatus === "active" ? (
                    !current ? (
                      <button
                        className="danger-text-button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !globalThis.confirm(
                              `停用“${user.displayName}”？其当前项目资格会被停用，其他项目不受影响， ${user.taskCount} 个历史任务引用会保留。`,
                            )
                          )
                            return;
                          void mutate(
                            `disable:${user.userId}`,
                            () =>
                              saveMembership(
                                projectId,
                                user.userId,
                                false,
                                user.membershipVersion ?? 1,
                              ),
                            `${user.displayName} 已停用并从人员选择器移除。`,
                          );
                        }}
                        type="button"
                      >
                        {busy ? "处理中…" : "停用"}
                      </button>
                    ) : (
                      <span className="managed-user-muted">受保护</span>
                    )
                  ) : user.membershipStatus === "revoked" ? (
                    <button
                      className="secondary-button compact-button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          `restore:${user.userId}`,
                          () =>
                            saveMembership(
                              projectId,
                              user.userId,
                              true,
                              user.membershipVersion ?? 1,
                            ),
                          `${user.displayName} 的项目资格已恢复。`,
                        )
                      }
                      type="button"
                    >
                      恢复资格
                    </button>
                  ) : (
                    <span className="managed-user-muted">先取消关联再停用</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
