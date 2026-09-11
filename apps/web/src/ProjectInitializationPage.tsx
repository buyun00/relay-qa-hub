import { type FormEvent, useEffect, useMemo, useState } from "react";
import { QaHubApiError } from "./api";
import {
  completeProjectInitialization,
  inspectProjectInitialization,
  type ManagedProject,
} from "./project-api";

const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"] as const);
type LogoType = "image/png" | "image/jpeg" | "image/webp";
interface LogoValue {
  readonly mediaType: LogoType;
  readonly dataBase64: string;
  readonly previewUrl: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof QaHubApiError)
    return error.code === "INITIALIZATION_ALREADY_COMPLETED"
      ? "此初始化链接已经完成。"
      : `请求未完成：${error.code ?? error.status}`;
  return error instanceof Error ? error.message : "请求未完成。";
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(result);
}

export default function ProjectInitializationPage({ token }: { token: string }) {
  const [project, setProject] = useState<ManagedProject | null>(null);
  const [name, setName] = useState("");
  const [membersText, setMembersText] = useState("");
  const [logo, setLogo] = useState<LogoValue | null>(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState<ManagedProject | null>(null);
  const memberCount = useMemo(
    () =>
      membersText
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean).length,
    [membersText],
  );
  useEffect(() => {
    return () => {
      if (logo) URL.revokeObjectURL(logo.previewUrl);
    };
  }, [logo]);
  useEffect(() => {
    let active = true;
    void inspectProjectInitialization(token)
      .then((value) => {
        if (!active) return;
        setProject(value);
        setName(value.joinName ?? "");
        setError("");
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [token]);
  const chooseLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!LOGO_TYPES.has(file.type as LogoType)) {
      setError("Logo 仅支持 PNG、JPEG 或 WebP。");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError("Logo 不能超过 512 KiB。");
      return;
    }
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const mediaType = file.type as LogoType;
      setLogo({
        mediaType,
        dataBase64: bytesToBase64(data),
        previewUrl: URL.createObjectURL(file),
      });
      setError("");
    } catch {
      setError("Logo 读取失败，请重新选择文件。");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await completeProjectInitialization({
        token,
        name: name.trim(),
        initialMembers: membersText
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter(Boolean),
        ...(logo
          ? { logo: { mediaType: logo.mediaType, dataBase64: logo.dataBase64 } }
          : { logo: null }),
      });
      setComplete(result);
      setProject(result);
      if (typeof history !== "undefined")
        history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  if (busy) return <main className="auth-status">正在读取项目初始化入口…</main>;
  if (project === null)
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="initialize-title">
          <h1 id="initialize-title">项目初始化入口不可用</h1>
          <p className="auth-error" role="alert">
            {error || "链接不存在、已撤销或已完成。"}
          </p>
        </section>
      </main>
    );
  if (complete !== null)
    return (
      <main className="project-management-page">
        <section className="hero">
          <div>
            <p className="eyebrow">项目已初始化</p>
            <h1>{complete.name}</h1>
            <p>请将下面的项目名称、四位验证码和加入地址交给项目员工。</p>
          </div>
        </section>
        <section className="project-settings-summary">
          <h2>员工加入说明</h2>
          <p>员工登录时填写项目名称、固定四位验证码和自己的姓名。</p>
          <p>
            项目名称：<strong>{complete.joinName ?? complete.name}</strong>
          </p>
          <p>
            固定四位验证码：<code>{complete.joinCode ?? "已由管理流程保存"}</code>
          </p>
          <p>不要把验证码放入 URL、二维码或普通下载清单。</p>
        </section>
      </main>
    );
  return (
    <main className="project-management-page">
      <section className="hero">
        <div>
          <p className="eyebrow">项目负责人</p>
          <h1>初始化项目</h1>
          <p>设置项目名称、Logo 和初始员工名单。提交成功后此链接将不能再次写入。</p>
        </div>
      </section>
      {error && (
        <div className="banner error-banner" role="alert">
          {error}
        </div>
      )}
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="initialization-project-name">项目名称</label>
        <input
          id="initialization-project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          required
        />
        <p>
          固定四位验证码：<code>{project.joinCode ?? "由管理流程保存"}</code>
          。完成后请自行传达给员工。
        </p>
        <label htmlFor="initialization-members">初始员工名单（每行一个姓名，可留空）</label>
        <textarea
          id="initialization-members"
          rows={6}
          value={membersText}
          onChange={(event) => setMembersText(event.target.value)}
          placeholder="例如：\n张三\n李四"
        />
        <small>当前 {memberCount} 人；姓名提交后用于项目加入匹配。</small>
        <label htmlFor="initialization-logo">项目 Logo（PNG/JPEG/WebP，最大 512 KiB）</label>
        <input
          id="initialization-logo"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => void chooseLogo(event.target.files?.[0])}
        />
        {logo && (
          <div className="project-settings-summary">
            <img src={logo.previewUrl} alt="项目 Logo 预览" className="project-logo" />
            <button type="button" className="secondary-button" onClick={() => setLogo(null)}>
              清除 Logo
            </button>
          </div>
        )}
        <button className="primary-button" disabled={saving} type="submit">
          {saving ? "提交中…" : "完成初始化"}
        </button>
      </form>
    </main>
  );
}
