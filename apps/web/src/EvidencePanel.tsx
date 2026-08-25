import { useEffect, useRef, useState } from "react";

import {
  downloadAttachment,
  getCaptureBundle,
  listBugAttachments,
  QaHubApiError,
  type AttachmentMetadata,
  type CaptureBundleSummary,
} from "./api";

type EvidenceEntry =
  | { readonly metadata: AttachmentMetadata; readonly state: "loading" }
  | { readonly metadata: AttachmentMetadata; readonly state: "ready"; readonly objectUrl: string }
  | {
      readonly metadata: AttachmentMetadata;
      readonly state: "error";
      readonly status: number;
      readonly code: string;
    };

type ListState =
  | { readonly state: "loading" }
  | { readonly state: "success"; readonly snapshotSequence: number }
  | { readonly state: "error"; readonly status: number; readonly code: string };

type CaptureContextState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly bundle: CaptureBundleSummary }
  | { readonly state: "unavailable"; readonly status: number; readonly code: string };

function evidenceError(cause: unknown): { readonly status: number; readonly code: string } {
  if (cause instanceof QaHubApiError) {
    return { status: cause.status, code: cause.code ?? "ATTACHMENT_UNAVAILABLE" };
  }
  return { status: 0, code: "NETWORK_ERROR" };
}

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function captureContextLabel(bundle: CaptureBundleSummary): string {
  if (bundle.enrichmentStatus === "complete") return "已获取 Unity 上下文";
  if (bundle.enrichmentStatus === "partial") return "部分";
  return "未连接";
}

export interface EvidencePanelProps {
  readonly bugId: string;
  readonly bugKey: string;
}

export function EvidencePanel({ bugId, bugKey }: EvidencePanelProps) {
  const [listState, setListState] = useState<ListState>({ state: "loading" });
  const [entries, setEntries] = useState<readonly EvidenceEntry[]>([]);
  const [captureContexts, setCaptureContexts] = useState<
    Readonly<Record<string, CaptureContextState>>
  >({});
  const generationRef = useRef(0);
  const objectUrlsRef = useRef(new Set<string>());

  function releaseObjectUrl(objectUrl: string): void {
    if (!objectUrlsRef.current.delete(objectUrl)) return;
    URL.revokeObjectURL(objectUrl);
  }

  async function loadEvidenceBytes(
    metadata: AttachmentMetadata,
    generation: number,
  ): Promise<void> {
    try {
      const blob = await downloadAttachment(metadata);
      const objectUrl = URL.createObjectURL(blob);
      if (generationRef.current !== generation) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      objectUrlsRef.current.add(objectUrl);
      setEntries((current) =>
        current.map((entry) =>
          entry.metadata.attachmentId === metadata.attachmentId
            ? { metadata, state: "ready", objectUrl }
            : entry,
        ),
      );
    } catch (cause: unknown) {
      if (generationRef.current !== generation) return;
      const failure = evidenceError(cause);
      setEntries((current) =>
        current.map((entry) =>
          entry.metadata.attachmentId === metadata.attachmentId
            ? { metadata, state: "error", ...failure }
            : entry,
        ),
      );
    }
  }

  async function loadCaptureContext(captureId: string, generation: number): Promise<void> {
    try {
      const bundle = await getCaptureBundle(captureId);
      if (generationRef.current !== generation) return;
      setCaptureContexts((current) => ({
        ...current,
        [captureId]: { state: "ready", bundle },
      }));
    } catch (cause: unknown) {
      if (generationRef.current !== generation) return;
      const failure = evidenceError(cause);
      setCaptureContexts((current) => ({
        ...current,
        [captureId]: { state: "unavailable", ...failure },
      }));
    }
  }

  useEffect(() => {
    const generation = generationRef.current + 1;
    const objectUrls = objectUrlsRef.current;
    generationRef.current = generation;
    setListState({ state: "loading" });
    setEntries([]);
    setCaptureContexts({});

    void (async () => {
      try {
        const result = await listBugAttachments(bugId);
        if (generationRef.current !== generation) return;
        setListState({ state: "success", snapshotSequence: result.snapshotSequence });
        setEntries(result.items.map((metadata) => ({ metadata, state: "loading" })));
        const captureIds = [
          ...new Set(
            result.items.flatMap((metadata) =>
              metadata.captureId === null ? [] : [metadata.captureId],
            ),
          ),
        ];
        setCaptureContexts(
          Object.fromEntries(captureIds.map((captureId) => [captureId, { state: "loading" }])),
        );
        await Promise.all([
          ...result.items.map((metadata) => loadEvidenceBytes(metadata, generation)),
          ...captureIds.map((captureId) => loadCaptureContext(captureId, generation)),
        ]);
      } catch (cause: unknown) {
        if (generationRef.current !== generation) return;
        const failure = evidenceError(cause);
        setListState({ state: "error", ...failure });
      }
    })();

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
      objectUrls.clear();
    };
  }, [bugId]);

  async function retry(entry: EvidenceEntry): Promise<void> {
    const generation = generationRef.current;
    if (entry.state === "ready") releaseObjectUrl(entry.objectUrl);
    setEntries((current) =>
      current.map((candidate) =>
        candidate.metadata.attachmentId === entry.metadata.attachmentId
          ? { metadata: entry.metadata, state: "loading" }
          : candidate,
      ),
    );
    const captureId = entry.metadata.captureId;
    if (captureId !== null) {
      setCaptureContexts((current) => ({
        ...current,
        [captureId]: { state: "loading" },
      }));
    }
    await Promise.all([
      loadEvidenceBytes(entry.metadata, generation),
      ...(captureId === null ? [] : [loadCaptureContext(captureId, generation)]),
    ]);
  }

  return (
    <section aria-label={`${bugKey} 的现场证据`} className="evidence-panel">
      <div className="evidence-panel__heading">
        <div>
          <p className="card-kicker">Android / capture evidence</p>
          <h3>现场证据</h3>
        </div>
        {listState.state === "success" && (
          <span className="evidence-panel__count">
            {entries.length} 项 · snapshot {listState.snapshotSequence}
          </span>
        )}
      </div>

      {listState.state === "loading" && <p className="evidence-panel__empty">正在读取证据…</p>}
      {listState.state === "error" && (
        <p aria-live="assertive" className="api-error">
          证据清单读取失败：HTTP {listState.status === 0 ? "网络不可达" : listState.status} ·{" "}
          {listState.code}。Bug 详情仍可继续使用。
        </p>
      )}
      {listState.state === "success" && entries.length === 0 && (
        <p className="evidence-panel__empty">这张 Bug 暂无已认领附件。</p>
      )}

      {entries.length > 0 && (
        <div className="evidence-grid">
          {entries.map((entry) => {
            const captureContext =
              entry.metadata.captureId === null
                ? ({ state: "unavailable", status: 404, code: "NO_CAPTURE_ID" } as const)
                : (captureContexts[entry.metadata.captureId] ?? ({ state: "loading" } as const));
            return (
              <article className="evidence-card" key={entry.metadata.attachmentId}>
                <div className="evidence-card__preview">
                  {entry.state === "ready" && entry.metadata.mediaType.startsWith("image/") ? (
                    <img alt={`${bugKey} · ${entry.metadata.filename}`} src={entry.objectUrl} />
                  ) : entry.state === "loading" ? (
                    <span>正在读取原始文件…</span>
                  ) : entry.state === "error" ? (
                    <span className="evidence-card__unavailable">证据不可用</span>
                  ) : (
                    <span>附件可下载</span>
                  )}
                </div>
                <div className="evidence-card__body">
                  <div className="evidence-card__title">
                    <strong>{entry.metadata.filename}</strong>
                    <span>{entry.metadata.mediaType}</span>
                  </div>
                  <aside
                    aria-label={`${entry.metadata.captureId ?? entry.metadata.attachmentId} 的 Unity 上下文`}
                    className={`evidence-context evidence-context--${
                      captureContext.state === "ready"
                        ? captureContext.bundle.enrichmentStatus
                        : captureContext.state
                    }`}
                  >
                    {captureContext.state === "loading" ? (
                      <p>正在读取 Unity 上下文…</p>
                    ) : captureContext.state === "unavailable" ? (
                      <>
                        <div className="evidence-context__heading">
                          <strong>未连接</strong>
                          <span>Unity / Poco context</span>
                        </div>
                        <p>
                          HTTP {captureContext.status === 0 ? "网络不可达" : captureContext.status}{" "}
                          · {captureContext.code}。普通截图仍可使用。
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="evidence-context__heading">
                          <strong>{captureContextLabel(captureContext.bundle)}</strong>
                          <span>Unity / Poco context</span>
                        </div>
                        <dl>
                          <div>
                            <dt>Poco</dt>
                            <dd>
                              {captureContext.bundle.poco.connectedPort === null
                                ? "未连接"
                                : `127.0.0.1:${captureContext.bundle.poco.connectedPort}`}
                            </dd>
                          </div>
                          <div>
                            <dt>SDK</dt>
                            <dd>{captureContext.bundle.poco.sdkVersion ?? "未知"}</dd>
                          </div>
                          <div>
                            <dt>已获取方法</dt>
                            <dd>
                              {captureContext.bundle.poco.succeededMethods.length === 0
                                ? "无"
                                : captureContext.bundle.poco.succeededMethods.join(" + ")}
                            </dd>
                          </div>
                          <div>
                            <dt>Artifacts</dt>
                            <dd>
                              {
                                captureContext.bundle.artifacts.filter(
                                  (artifact) => artifact.status === "succeeded",
                                ).length
                              }
                              /{captureContext.bundle.artifacts.length} 成功
                            </dd>
                          </div>
                        </dl>
                        {captureContext.bundle.poco.failureReason !== null && (
                          <p>降级原因：{captureContext.bundle.poco.failureReason}</p>
                        )}
                      </>
                    )}
                  </aside>
                  <dl>
                    <div>
                      <dt>Capture ID</dt>
                      <dd>{entry.metadata.captureId ?? "无"}</dd>
                    </div>
                    <div>
                      <dt>大小</dt>
                      <dd>{readableBytes(entry.metadata.size)}</dd>
                    </div>
                    <div>
                      <dt>SHA-256</dt>
                      <dd>{entry.metadata.sha256}</dd>
                    </div>
                    <div>
                      <dt>Attachment ID</dt>
                      <dd>{entry.metadata.attachmentId}</dd>
                    </div>
                  </dl>
                  {entry.state === "error" && (
                    <p aria-live="assertive" className="evidence-card__error">
                      HTTP {entry.status === 0 ? "网络不可达" : entry.status} · {entry.code}。其余
                      Bug 事实未受影响。
                    </p>
                  )}
                  <div className="evidence-card__actions">
                    {entry.state === "ready" && (
                      <a download={entry.metadata.filename} href={entry.objectUrl}>
                        打开或保存原图
                      </a>
                    )}
                    <button
                      className="link-button"
                      disabled={entry.state === "loading"}
                      onClick={() => void retry(entry)}
                      type="button"
                    >
                      重新读取
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
