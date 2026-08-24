import { useEffect, useState } from "react";

import { getPwaNotice, PWA_STATUS_EVENT, type PwaStatus } from "./pwa-events";
import { product } from "./product";

function BrandMark() {
  return (
    <svg aria-hidden="true" className="brand-mark" viewBox="0 0 64 64">
      <circle cx="29" cy="28" fill="none" r="16" stroke="currentColor" strokeWidth="6" />
      <path
        d="M40 40l10 10"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <path
        className="brand-mark__check"
        d="M21 29l6 6 14-15"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5"
      />
    </svg>
  );
}

export default function App() {
  const [pwaStatus, setPwaStatus] = useState<PwaStatus | null>(null);

  useEffect(() => {
    const handlePwaStatus = (event: CustomEvent<PwaStatus>) => {
      setPwaStatus(event.detail);
    };

    window.addEventListener(PWA_STATUS_EVENT, handlePwaStatus);
    return () => {
      window.removeEventListener(PWA_STATUS_EVENT, handlePwaStatus);
    };
  }, []);

  const pwaNotice = pwaStatus === null ? null : getPwaNotice(pwaStatus);

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="brand-row">
          <span className="brand-icon">
            <BrandMark />
          </span>
          <div>
            <p className="eyebrow">独立 QA 事实源</p>
            <h1>{product.name}</h1>
          </div>
        </div>
        <p className="hero__summary">
          即使 Relay 离线，人工提单、修复登记与验收闭环仍由 QA Hub 负责。
        </p>
        <span className="skeleton-badge">P0 运行骨架 · 暂未连接业务 API</span>
      </header>

      {pwaNotice !== null && (
        <section aria-live="polite" className={`pwa-notice pwa-notice--${pwaNotice.tone}`}>
          <p>{pwaNotice.message}</p>
          {pwaStatus?.kind === "update" && (
            <button className="text-button" onClick={pwaStatus.apply} type="button">
              刷新到新版本
            </button>
          )}
        </section>
      )}

      <section aria-labelledby="boundary-title" className="boundary-card">
        <div>
          <p className="card-kicker">产品边界</p>
          <h2 id="boundary-title">Relay（可选执行器）</h2>
        </div>
        <p>Relay 只可标记修复交付、待构建或待验收，不能验收或关闭 QA Bug。</p>
      </section>

      <section aria-labelledby="entry-title" className="workspace-card">
        <div className="section-heading">
          <div>
            <p className="card-kicker">手机优先入口</p>
            <h2 id="entry-title">QA 工作台</h2>
          </div>
          <span className="status-dot">壳已就绪</span>
        </div>

        <div className="action-grid" role="list">
          <article role="listitem">
            <span aria-hidden="true" className="action-number">
              01
            </span>
            <h3>快速上报</h3>
            <p>后续接入 30 秒提单、媒体证据与本地草稿。</p>
          </article>
          <article role="listitem">
            <span aria-hidden="true" className="action-number">
              02
            </span>
            <h3>待我验收</h3>
            <p>验收始终由获授权的人执行，不接受集成自动通过。</p>
          </article>
          <article role="listitem">
            <span aria-hidden="true" className="action-number">
              03
            </span>
            <h3>站内通知</h3>
            <p>Inbox 是通知事实源，Push 仅作为渐进增强。</p>
          </article>
        </div>
      </section>

      <footer>
        <span>版本 {product.appVersion}</span>
        <span aria-hidden="true">·</span>
        <span>Contract {product.contractVersion}</span>
      </footer>
    </main>
  );
}
