import { useCallback, useEffect, useRef, useState } from "react";

import {
  downloadAttachment,
  downloadCaptureArtifact,
  getCaptureBundle,
  listBugAttachments,
  QaHubApiError,
  type AttachmentMetadata,
  type CaptureArtifactBinary,
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

type PocoScreenshotState =
  | { readonly state: "loading" }
  | {
      readonly state: "ready";
      readonly artifact: CaptureArtifactBinary;
      readonly objectUrl: string;
    }
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
  const [pocoScreenshots, setPocoScreenshots] = useState<
    Readonly<Record<string, PocoScreenshotState>>
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

  const loadPocoScreenshot = useCallback(async function loadPocoScreenshot(
    selectedBugId: string,
    captureId: string,
    generation: number,
  ): Promise<void> {
    try {
      const artifact = await downloadCaptureArtifact(selectedBugId, captureId, "poco_screenshot");
      const objectUrl = URL.createObjectURL(artifact.blob);
      if (generationRef.current !== generation) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      objectUrlsRef.current.add(objectUrl);
      setPocoScreenshots((current) => ({
        ...current,
        [captureId]: { state: "ready", artifact, objectUrl },
      }));
    } catch (cause: unknown) {
      if (generationRef.current !== generation) return;
      const failure = evidenceError(cause);
      setPocoScreenshots((current) => ({
        ...current,
        [captureId]: { state: "unavailable", ...failure },
      }));
    }
  }, []);

  const loadCaptureContext = useCallback(
    async function loadCaptureContext(
      selectedBugId: string,
      captureId: string,
      generation: number,
    ): Promise<void> {
      try {
        const bundle = await getCaptureBundle(captureId);
        if (generationRef.current !== generation) return;
        setCaptureContexts((current) => ({
          ...current,
          [captureId]: { state: "ready", bundle },
        }));
        setPocoScreenshots((current) => ({
          ...current,
          [captureId]: { state: "loading" },
        }));
        await loadPocoScreenshot(selectedBugId, captureId, generation);
      } catch (cause: unknown) {
        if (generationRef.current !== generation) return;
        const failure = evidenceError(cause);
        setCaptureContexts((current) => ({
          ...current,
          [captureId]: { state: "unavailable", ...failure },
        }));
        setPocoScreenshots((current) => ({
          ...current,
          [captureId]: { state: "unavailable", ...failure },
        }));
      }
    },
    [loadPocoScreenshot],
  );

  useEffect(() => {
    const generation = generationRef.current + 1;
    const objectUrls = objectUrlsRef.current;
    generationRef.current = generation;
    setListState({ state: "loading" });
    setEntries([]);
    setCaptureContexts({});
    setPocoScreenshots({});

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
          ...captureIds.map((captureId) => loadCaptureContext(bugId, captureId, generation)),
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
  }, [bugId, loadCaptureContext]);

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
      const currentPocoScreenshot = pocoScreenshots[captureId];
      if (currentPocoScreenshot?.state === "ready") {
        releaseObjectUrl(currentPocoScreenshot.objectUrl);
      }
      setCaptureContexts((current) => ({
        ...current,
        [captureId]: { state: "loading" },
      }));
      setPocoScreenshots((current) => ({
        ...current,
        [captureId]: { state: "loading" },
      }));
    }
    await Promise.all([
      loadEvidenceBytes(entry.metadata, generation),
      ...(captureId === null ? [] : [loadCaptureContext(bugId, captureId, generation)]),
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
            const pocoScreenshot =
              entry.metadata.captureId === null
                ? ({ state: "unavailable", status: 404, code: "NO_CAPTURE_ID" } as const)
                : (pocoScreenshots[entry.metadata.captureId] ?? ({ state: "loading" } as const));
            const pocoArtifact =
              captureContext.state === "ready"
                ? captureContext.bundle.artifacts.find(
                    (artifact) => artifact.kind === "poco_screenshot",
                  )
                : undefined;
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
                  {captureContext.state === "ready" && (
                    <section
                      aria-label={`${captureContext.bundle.captureId} 的 Poco 干净截图`}
                      className="poco-artifact"
                    >
                      <div className="poco-artifact__heading">
                        <strong>Poco 干净截图</strong>
                        <span>与系统画面同一 captureId</span>
                      </div>
                      {pocoScreenshot.state === "loading" ? (
                        <p>正在读取可选 Unity framebuffer…</p>
                      ) : pocoScreenshot.state === "unavailable" ? (
                        <p className="poco-artifact__error">
                          HTTP {pocoScreenshot.status === 0 ? "网络不可达" : pocoScreenshot.status}{" "}
                          · {pocoScreenshot.code}。主系统截图与 Bug 详情仍可使用。
                        </p>
                      ) : (
                        <>
                          <img
                            alt={`${bugKey} · Poco clean screenshot`}
                            src={pocoScreenshot.objectUrl}
                          />
                          <dl>
                            <div>
                              <dt>类型</dt>
                              <dd>{pocoScreenshot.artifact.mediaType}</dd>
                            </div>
                            <div>
                              <dt>大小</dt>
                              <dd>{readableBytes(pocoScreenshot.artifact.size)}</dd>
                            </div>
                            <div>
                              <dt>SHA-256</dt>
                              <dd>{pocoScreenshot.artifact.sha256}</dd>
                            </div>
                            <div>
                              <dt>Attachment ID</dt>
                              <dd>{pocoArtifact?.attachmentId ?? "未提供"}</dd>
                            </div>
                          </dl>
                          <a
                            download={`poco-${captureContext.bundle.captureId}.png`}
                            href={pocoScreenshot.objectUrl}
                          >
                            打开或保存 Poco 原图
                          </a>
                        </>
                      )}
                    </section>
                  )}
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
