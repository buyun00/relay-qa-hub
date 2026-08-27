import { type FormEvent, useEffect, useState } from "react";

import App from "./App";
import {
  getBrowserSession,
  loginBrowserSession,
  logoutBrowserSession,
  QaHubApiError,
  setBrowserCsrfToken,
  type BrowserSessionPrincipal,
} from "./api";

type AuthState = "checking" | "signed-out" | "signed-in" | "unavailable";

export default function AuthGate() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [principal, setPrincipal] = useState<BrowserSessionPrincipal | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const checkSession = async () => {
    setAuthState("checking");
    setMessage(null);
    try {
      const current = await getBrowserSession();
      setPrincipal(current);
      setAuthState("signed-in");
    } catch (cause) {
      setBrowserCsrfToken(null);
      setPrincipal(null);
      if (cause instanceof QaHubApiError && cause.status === 401) {
        setAuthState("signed-out");
      } else {
        setAuthState("unavailable");
      }
    }
  };

  useEffect(() => {
    void checkSession();
  }, []);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const current = await loginBrowserSession(name);
      setPrincipal(current);
      setAuthState("signed-in");
    } catch (cause) {
      setMessage(
        cause instanceof QaHubApiError && cause.status === 400
          ? "请输入有效的姓名。"
          : "登录服务暂时不可用。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const signOut = async () => {
    setSubmitting(true);
    setMessage(null);
    try {
      await logoutBrowserSession();
      setPrincipal(null);
      setAuthState("signed-out");
    } catch {
      setMessage("注销失败，请稍后重试。当前页面不会假装已经退出。");
    } finally {
      setSubmitting(false);
    }
  };

  if (authState === "checking") {
    return <main className="auth-status">正在核对 QA Hub 会话…</main>;
  }

  if (authState === "unavailable") {
    return (
      <main className="auth-status">
        <h1>QA Hub 暂时无法连接</h1>
        <p>服务没有返回可验证的登录状态。</p>
        <button onClick={() => void checkSession()} type="button">
          重试
        </button>
      </main>
    );
  }

  if (authState === "signed-out" || principal === null) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="login-title">
          <p className="eyebrow">独立事实源</p>
          <h1 id="login-title">进入 Relay QA Hub</h1>
          <p>输入姓名进入内部管理台；新姓名会由后端自动创建为账号。</p>
          <form className="auth-form" onSubmit={(event) => void submitLogin(event)}>
            <label htmlFor="login-name">姓名</label>
            <input
              autoComplete="off"
              id="login-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="输入姓名"
              spellCheck={false}
              type="text"
              value={name}
            />
            {message === null ? null : <p className="auth-error">{message}</p>}
            <button disabled={submitting} type="submit">
              {submitting ? "登录中…" : "登录"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <>
      <div className="session-bar">
        <span>
          {principal.displayName}
        </span>
        <button disabled={submitting} onClick={() => void signOut()} type="button">
          注销
        </button>
        {message === null ? null : <span className="session-bar__error">{message}</span>}
      </div>
      <App />
    </>
  );
}
