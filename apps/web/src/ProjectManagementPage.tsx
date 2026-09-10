import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { listManagedProjectUsers, QaHubApiError, type ManagedProjectUser } from "./api";
import {
  componentLabels,
  listGmProjects,
  listProjectComponents,
  saveComponent,
  saveMembership,
  saveProject,
  updateProject,
  type ManagedProject,
  type ProjectComponent,
} from "./project-api";

export function projectManagementErrorMessage(error: unknown): string {
  if (error instanceof QaHubApiError) {
    if (error.code === "COMPONENT_DEPENDENCY_REQUIRED")
      return "请先启用打包和增量上传，再启用单次打包上传；当前输入仍保留。";
    return error.code === "VERSION_CONFLICT" || error.status === 412
      ? "记录已变化，请刷新后重试；未保存的输入仍保留。"
      : `请求未完成：${error.code ?? error.status}`;
  }
  return error instanceof Error ? error.message : "请求未完成。";
}
const fields: Record<string, { key: string; label: string }[]> = {
  build: [
    { key: "baseUrl", label: "Jenkins 地址" },
    { key: "job", label: "独立测试 Job" },
    { key: "downloadOrigin", label: "产物下载源" },
    { key: "zipPath", label: "增量 ZIP 路径" },
    { key: "artifactUrlTemplate", label: "本次产物地址模板（含 {buildNumber}）" },
    { key: "credentialRef", label: "凭据引用名" },
  ],
  "upload.incremental": [
    { key: "sourceUrl", label: "增量包来源地址" },
    { key: "apiBase", label: "上传接口地址" },
    { key: "loginBase", label: "上传登录地址" },
    { key: "targetPrefix", label: "上传目标相对前缀（以 / 结束）" },
    { key: "testDirectoryPrefix", label: "测试解压目录前缀（以 / 结束）" },
    { key: "releaseDirectoryPrefix", label: "正式解压目录前缀（以 / 结束）" },
    { key: "credentialRef", label: "凭据引用名" },
  ],
  "build_upload.single": [{ key: "buildPreset", label: "打包预设键" }],
  "relay.production": [
    { key: "baseUrl", label: "Relay 地址" },
    { key: "relayInstanceId", label: "目的 Relay 实例 ID" },
    { key: "externalProjectId", label: "Relay 外部项目 Key" },
    { key: "credentialRef", label: "测试凭据引用名" },
  ],
  "qingyu.sync": [
    { key: "baseUrl", label: "第三方服务地址" },
    { key: "externalProjectId", label: "第三方项目 ID" },
    { key: "credentialRef", label: "测试凭据引用名" },
  ],
};

function ComponentEditor({
  projectId,
  component,
  onSaved,
}: {
  projectId: string;
  component: ProjectComponent;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(component.enabled);
  const [config, setConfig] = useState(component.config);
  const objectKey =
    component.key === "build"
      ? "presets"
      : component.key === "upload.incremental"
        ? "defaults"
        : null;
  const [objectJson, setObjectJson] = useState(
    JSON.stringify(objectKey ? (component.config[objectKey] ?? {}) : {}, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = { ...config };
      if (objectKey) {
        const value: unknown = JSON.parse(objectJson);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("配置 JSON 必须是对象。");
        if (/"(?:password|token|secret|authorization)"\s*:/iu.test(objectJson))
          throw new Error("请仅填写凭据引用名，不能在配置中保存口令或令牌。");
        next[objectKey] = value;
      }
      await saveComponent(projectId, component, enabled, next);
      onSaved();
    } catch (cause) {
      setError(projectManagementErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="project-component-card" onSubmit={(event) => void save(event)}>
      <div className="project-component-heading">
        <strong>{componentLabels[component.key] ?? component.key}</strong>
        <span>
          {component.enabled ? (component.status === "ready" ? "可用" : "待配置") : "未启用"}
        </span>
      </div>
      <label className="project-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        为此项目启用
      </label>
      {component.key === "build_upload.single" && (
        <p>需要先启用并配置打包和增量上传。停用依赖时，此入口也会停用。</p>
      )}
      {(fields[component.key] ?? []).map((field) => (
        <label key={field.key}>
          {field.label}
          <input
            value={String(config[field.key] ?? "")}
            onChange={(event) =>
              setConfig((current) => ({ ...current, [field.key]: event.target.value }))
            }
            autoComplete="off"
          />
        </label>
      ))}
      {objectKey && (
        <label>
          {objectKey === "presets" ? "打包预设参数 JSON" : "上传默认值 JSON"}
          <textarea
            rows={7}
            spellCheck={false}
            value={objectJson}
            onChange={(event) => setObjectJson(event.target.value)}
          />
          <small>
            {objectKey === "presets"
              ? '例如 {"external": {"mode": "App"}}'
              : "填写 productId、channelId、belongName、testerId。"}
          </small>
        </label>
      )}
      <p className="project-help">
        连接仅用于此项目。停用后保留历史；排队任务暂停，正在运行的任务按原配置安全收尾。
      </p>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="secondary-button" disabled={busy}>
        {busy ? "保存中…" : "保存组件"}
      </button>
    </form>
  );
}

export default function ProjectManagementPage({
  projectId,
  onSelectProject,
  onChanged,
}: {
  projectId: string;
  onSelectProject: (id: string) => void;
  onChanged?: () => void;
}) {
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [selected, setSelected] = useState(projectId);
  const [components, setComponents] = useState<ProjectComponent[]>([]);
  const [users, setUsers] = useState<readonly ManagedProjectUser[]>([]);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const revision = useRef(0);
  const current = projects.find((project) => project.id === selected);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const next = await listGmProjects();
    if (request !== revision.current) return;
    setProjects(next);
    if (next.some((project) => project.id === selected && project.active)) {
      const [configuration, people] = await Promise.all([
        listProjectComponents(selected),
        listManagedProjectUsers(selected),
      ]);
      if (request !== revision.current) return;
      setComponents(configuration.items);
      setUsers(people.items);
    } else {
      setComponents([]);
      setUsers([]);
    }
  }, [selected]);
  useEffect(() => {
    let mounted = true;
    const revisionRef = revision;
    void refresh().catch((cause) => {
      if (mounted) setError(projectManagementErrorMessage(cause));
    });
    return () => {
      mounted = false;
      revisionRef.current++;
    };
  }, [refresh]);
  const mutate = async (operation: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await refresh();
      onChanged?.();
      setNotice(message);
    } catch (cause) {
      setError(projectManagementErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="project-management-page">
      <section className="hero">
        <div>
          <p className="eyebrow">GM</p>
          <h1>项目管理</h1>
          <p>管理项目、人员归属及可选组件。每个新项目默认只有 Bug 管理。</p>
        </div>
        <button
          className="secondary-button"
          onClick={() =>
            void refresh().catch((cause) => setError(projectManagementErrorMessage(cause)))
          }
        >
          刷新
        </button>
      </section>
      {error && (
        <div className="banner error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner success-banner" role="status">
          {notice}
        </div>
      )}
      <form
        className="project-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(async () => {
            const created = await saveProject({ key: key.trim(), name: name.trim() });
            setKey("");
            setName("");
            setSelected(created.id);
          }, "项目已创建，仅启用 Bug 管理。");
        }}
      >
        <h2>新建项目</h2>
        <label>
          项目名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
          />
        </label>
        <label>
          入口短码
          <input
            value={key}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
            placeholder="例如 QADEMO"
            required
            pattern="[A-Z][A-Z0-9]{1,15}"
            minLength={2}
            maxLength={16}
            title="2–16 位大写字母或数字，以字母开头"
          />
        </label>
        <button className="primary-button" disabled={busy}>
          创建项目
        </button>
      </form>
      <label className="project-settings-picker">
        当前管理项目
        <select
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setComponents([]);
            setUsers([]);
          }}
        >
          <option value="">选择项目</option>
          {projects.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name}
              {project.active ? "" : "（已停用）"}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <>
          <section className="project-settings-summary">
            <h2>{current.name}</h2>
            <p>
              项目 ID：<code>{current.id}</code> · 入口短码：<code>{current.key}</code>
            </p>
            <div className="project-action-row">
              <button
                className="primary-button"
                disabled={!current.active}
                onClick={() => onSelectProject(current.id)}
              >
                进入此项目
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  const value = window.prompt("项目名称", current.name);
                  if (value?.trim())
                    void mutate(
                      () => updateProject(current, { name: value.trim() }),
                      "项目名称已保存。",
                    );
                }}
              >
                修改名称
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () => updateProject(current, { active: !current.active }),
                    current.active ? "项目已停用，历史保留。" : "项目已恢复。",
                  )
                }
              >
                {current.active ? "停用项目" : "恢复项目"}
              </button>
            </div>
          </section>
          {!current.active && (
            <p>项目已停用，历史与人员归属保留。恢复项目后可继续管理组件和人员。</p>
          )}
          {current.active && (
            <>
              <h2>组件设置</h2>
              <div className="project-component-grid">
                {components.map((component) => (
                  <ComponentEditor
                    key={`${selected}:${component.key}:${component.version}`}
                    projectId={selected}
                    component={component}
                    onSaved={() =>
                      void refresh()
                        .then(() => onChanged?.())
                        .catch((cause) => setError(projectManagementErrorMessage(cause)))
                    }
                  />
                ))}
              </div>
              <section className="project-members-panel">
                <h2>人员归属</h2>
                <p>人员可以属于多个项目；在这里停用只影响当前项目。</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(
                      () => saveMembership(selected, memberId.trim(), true, 0, true),
                      "人员已加入项目。",
                    );
                  }}
                >
                  <label>
                    已有人员 ID
                    <input
                      value={memberId}
                      onChange={(event) => setMemberId(event.target.value)}
                      required
                      placeholder="稳定人员 ID"
                    />
                  </label>
                  <button className="secondary-button" disabled={busy}>
                    加入项目
                  </button>
                </form>
                <ul>
                  {users.map((user) => (
                    <li key={user.userId}>
                      <span>
                        {user.displayName}
                        <small>{user.userId}</small>
                      </span>
                      <span>{user.membershipStatus === "active" ? "使用中" : "已停用"}</span>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () =>
                              saveMembership(
                                selected,
                                user.userId,
                                user.membershipStatus !== "active",
                                user.membershipVersion ?? 1,
                                true,
                              ),
                            "项目人员关系已保存。",
                          )
                        }
                      >
                        {user.membershipStatus === "active" ? "停用" : "恢复"}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
