import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  addBugComment,
  createBug,
  createHumanRepairAttempt,
  createRelayAttempt,
  createVerification,
  deliverHumanRepairAttemptNoCode,
  dispatchRelay,
  downloadAttachment,
  downloadCaptureArtifact,
  getBug,
  getCaptureBundle,
  getHumanWorkflow,
  listBugAttachments,
  listBugEvents,
  listBugs,
  listProjectMembers,
  listVisibleProjects,
  QaHubApiError,
  recordVerificationFailed,
  recordVerificationPassed,
  startHumanRepairAttempt,
  startVerification,
  transitionBugReady,
  updateBugAssignments,
  uploadBugCreateAttachment,
  type BrowserSessionPrincipal,
  type BugDetail,
  type BugEvent,
  type BugListItem,
  type BugListState,
  type HumanWorkflowSnapshot,
  type ProjectMember,
  type VisibleProject,
} from "./api";
import PocoContextPanel, { type PocoCaptureContext } from "./PocoContextPanel";
import OverviewPage from "./OverviewPage";

const DEFAULT_PROJECT_ID =
  import.meta.env.VITE_QA_HUB_PROJECT_ID ?? "10000000-0000-4000-8000-000000000004";

type Category = "pending" | "inProgress" | "verification" | "completed";
type WorkspaceView = "workbench" | "overview";

interface AppProps {
  readonly principal: BrowserSessionPrincipal;
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
}

interface EvidenceImage {
  readonly attachmentId: string;
  readonly filename: string;
  readonly url: string;
}

interface ClipboardImageItem {
  readonly kind: string;
  readonly type: string;
  getAsFile(): File | null;
}

const DEFAULT_EXPECTED_BEHAVIOR = "问题修复后不再复现";
const AUTO_REFRESH_INTERVAL_MS = 5_000;
const CREATE_BUG_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function createBugImageKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`;
}

export function mergeCreateBugImages(
  current: readonly File[],
  incoming: readonly File[],
): readonly File[] {
  const seen = new Set(current.map(createBugImageKey));
  return [
    ...current,
    ...incoming.filter((file) => {
      if (!CREATE_BUG_IMAGE_TYPES.has(file.type) || seen.has(createBugImageKey(file))) return false;
      seen.add(createBugImageKey(file));
      return true;
    }),
  ];
}

export function collectClipboardImages(
  items: readonly ClipboardImageItem[],
  timestamp = Date.now(),
): readonly File[] {
  const images: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    const mediaType = file.type || item.type;
    if (!CREATE_BUG_IMAGE_TYPES.has(mediaType)) continue;
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
    images.push(
      new File([file], `clipboard-${timestamp}-${images.length + 1}.${extension}`, {
        type: mediaType,
        lastModified: timestamp,
      }),
    );
  }
  return images;
}

function bugContent(bug: Pick<BugListItem, "description" | "title">): string {
  return bug.description.trim() || bug.title.trim();
}

function internalBugSummary(content: string): string {
  return content.replace(/\s+/gu, " ").trim().slice(0, 160);
}

const categoryCopy: Readonly<
  Record<Category, { readonly label: string; readonly hint: string; readonly icon: string }>
> = {
  pending: {
    label: "待处理",
    hint: "待分配、需补充或等待开始修复",
    icon: "✓",
  },
  inProgress: {
    label: "处理中",
    hint: "正在修复或等待构建交付",
    icon: "…",
  },
  verification: {
    label: "待验收",
    hint: "所选人员已点完成，等待提报人确认",
    icon: "↗",
  },
  completed: { label: "已完成", hint: "提报人已确认并关闭", icon: "◎" },
};

const DEFAULT_RETURN_REASON = "问题仍可复现，请继续处理";

const stateCopy: Readonly<Record<BugListState, string>> = {
  reported: "待分配",
  needs_info: "需补充",
  ready: "待修复",
  in_progress: "处理中",
  awaiting_build: "等待构建",
  ready_for_verification: "待提报人确认",
  closed: "已完成",
  deferred: "已延期",
  rejected: "不处理",
  duplicate: "重复项",
};

const pendingStates = new Set<BugListState>(["reported", "needs_info", "ready"]);

const inProgressStates = new Set<BugListState>(["in_progress", "awaiting_build"]);

function categoryMatches(category: Category, state: BugListState): boolean {
  if (category === "pending") return pendingStates.has(state);
  if (category === "inProgress") return inProgressStates.has(state);
  if (category === "verification") return state === "ready_for_verification";
  return state === "closed";
}

function initials(name: string): string {
  return [...name].at(-1) ?? name;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function messageFor(cause: unknown): string {
  if (cause instanceof QaHubApiError) {
    if (cause.status === 409) return "数据刚刚被其他人更新，已重新读取，请再操作一次。";
    if (cause.status === 403) return "当前身份没有执行这项操作的权限。";
    return cause.code === null ? `请求失败（HTTP ${cause.status}）` : `请求失败：${cause.code}`;
  }
  return cause instanceof Error ? cause.message : "发生了未知错误。";
}

function eventCopy(event: BugEvent): string {
  const from =
    typeof event.fromState === "string" ? stateCopy[event.fromState as BugListState] : null;
  const to = typeof event.toState === "string" ? stateCopy[event.toState as BugListState] : null;
  if (from !== null && to !== null) return `${from} → ${to}`;
  const labels: Readonly<Record<string, string>> = {
    "bug.created": "提交了 Bug",
    "bug.updated": "更新了分配或详情",
    "bug.comment_added": "添加了处理记录",
    "repair_attempt.created": "建立了处理任务",
    "repair_attempt.started": "开始处理",
    "repair_attempt.delivered": "标记修复完成",
    "verification.requested": "发起验收",
    "verification.started": "开始验收",
    "verification.failed": "验收打回",
    "verification.passed": "确认关闭",
    "relay.handoff_queued": "已交给 Relay",
  };
  return labels[event.type] ?? event.type;
}

export default function App({ principal, signingOut, onSignOut }: AppProps) {
  const [view, setView] = useState<WorkspaceView>("workbench");
  const [projects, setProjects] = useState<readonly VisibleProject[]>([]);
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT_ID);
  const [members, setMembers] = useState<readonly ProjectMember[]>([]);
  const [scopeId, setScopeId] = useState(principal.userId);
  const [category, setCategory] = useState<Category>("pending");
  const [query, setQuery] = useState("");
  const [bugs, setBugs] = useState<readonly BugListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [events, setEvents] = useState<readonly BugEvent[]>([]);
  const [workflow, setWorkflow] = useState<HumanWorkflowSnapshot | null>(null);
  const [evidence, setEvidence] = useState<readonly EvidenceImage[]>([]);
  const [captures, setCaptures] = useState<readonly PocoCaptureContext[]>([]);
  const [previewImage, setPreviewImage] = useState<EvidenceImage | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [verifierId, setVerifierId] = useState("");
  const [comment, setComment] = useState("");
  const [returnReason, setReturnReason] = useState(DEFAULT_RETURN_REASON);
  const [mutation, setMutation] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [newVerifierId, setNewVerifierId] = useState(principal.userId);
  const [newSeverity, setNewSeverity] = useState<"S0" | "S1" | "S2" | "S3" | "S4">("S2");
  const [newFiles, setNewFiles] = useState<readonly File[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const evidenceRef = useRef<readonly EvidenceImage[]>([]);
  const workbenchRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const detailBugIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [overviewRevision, setOverviewRevision] = useState(0);

  const newFilePreviews = useMemo(
    () =>
      newFiles.map((file, index) => ({
        file,
        key: `${createBugImageKey(file)}\u0000${index}`,
        url: URL.createObjectURL(file),
      })),
    [newFiles],
  );

  useEffect(
    () => () => {
      for (const preview of newFilePreviews) URL.revokeObjectURL(preview.url);
    },
    [newFilePreviews],
  );

  const currentProject = projects.find((project) => project.id === projectId) ?? null;
  const memberName = useCallback(
    (id: string | null): string => {
      if (id === null) return "未分配";
      if (id === principal.userId) return principal.displayName;
      return members.find((member) => member.userId === id)?.displayName ?? id.slice(0, 8);
    },
    [members, principal.displayName, principal.userId],
  );

  const owners = useMemo(
    () => members.filter((member) => member.roles.includes("developer")),
    [members],
  );
  const verifiers = useMemo(
    () => members.filter((member) => member.roles.includes("verifier")),
    [members],
  );

  useEffect(() => {
    if (newOwnerId.length > 0 && !owners.some((member) => member.userId === newOwnerId)) {
      setNewOwnerId("");
    }
    if (verifiers.length > 0 && !verifiers.some((member) => member.userId === newVerifierId)) {
      setNewVerifierId(
        verifiers.find((member) => member.userId === principal.userId)?.userId ??
          verifiers[0]?.userId ??
          principal.userId,
      );
    }
  }, [newOwnerId, newVerifierId, owners, principal.userId, verifiers]);

  const loadProjects = useCallback(async () => {
    const response = await listVisibleProjects();
    setProjects(response.items);
    const preferred = response.items.find((project) => project.id === DEFAULT_PROJECT_ID);
    const nextProject = preferred ?? response.items[0];
    if (nextProject !== undefined) setProjectId(nextProject.id);
  }, []);

  const loadWorkbench = useCallback(
    async (quiet = false, indicateRefresh = quiet) => {
      const requestId = ++workbenchRequestRef.current;
      if (indicateRefresh) setRefreshing(true);
      else if (!quiet) setLoading(true);
      if (!quiet || indicateRefresh) setError(null);
      try {
        const [memberResponse, bugResponse] = await Promise.all([
          listProjectMembers(projectId),
          listBugs(projectId, scopeId === "team" ? {} : { ownerId: scopeId }),
        ]);
        if (requestId !== workbenchRequestRef.current) return;
        setMembers(memberResponse.items);
        setBugs(bugResponse.items);
        setError(null);
      } catch (cause) {
        if (requestId === workbenchRequestRef.current && (!quiet || indicateRefresh)) {
          setError(messageFor(cause));
        }
      } finally {
        if (requestId === workbenchRequestRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [projectId, scopeId],
  );

  const clearEvidence = useCallback(() => {
    for (const item of evidenceRef.current) URL.revokeObjectURL(item.url);
    evidenceRef.current = [];
    setEvidence([]);
  }, []);

  const resetDetail = useCallback(() => {
    detailRequestRef.current += 1;
    detailBugIdRef.current = null;
    setDetail(null);
    setEvents([]);
    setWorkflow(null);
    setCaptures([]);
    setDetailLoading(false);
    setDetailError(null);
    setPreviewImage(null);
    clearEvidence();
  }, [clearEvidence]);

  const closeDetail = useCallback(() => {
    resetDetail();
    selectedIdRef.current = null;
    setSelectedId(null);
  }, [resetDetail]);

  const openDetail = useCallback(
    (bugId: string) => {
      if (detailBugIdRef.current !== bugId) resetDetail();
      selectedIdRef.current = bugId;
      setSelectedId(bugId);
    },
    [resetDetail],
  );

  const loadDetail = useCallback(
    async (bugId: string) => {
      const requestId = ++detailRequestRef.current;
      const isInitialLoad = detailBugIdRef.current !== bugId;
      detailBugIdRef.current = bugId;
      setDetailLoading(true);
      setDetailError(null);
      setError(null);
      if (isInitialLoad) {
        setDetail(null);
        setEvents([]);
        setWorkflow(null);
        clearEvidence();
        setCaptures([]);
      }
      try {
        const [nextDetail, eventResponse, attachmentResponse, workflowResponse] = await Promise.all(
          [getBug(bugId), listBugEvents(bugId), listBugAttachments(bugId), getHumanWorkflow(bugId)],
        );
        if (requestId !== detailRequestRef.current) return;
        setDetail(nextDetail);
        setEvents(eventResponse.items);
        setWorkflow(workflowResponse);
        setOwnerId(nextDetail.ownerId ?? "");
        setVerifierId(nextDetail.verificationOwnerId ?? nextDetail.reporterId);

        const imageResults = await Promise.allSettled(
          attachmentResponse.items
            .filter((item) => item.mediaType.startsWith("image/"))
            .map(async (item) => ({
              attachmentId: item.attachmentId,
              filename: item.filename,
              url: URL.createObjectURL(await downloadAttachment(item)),
            })),
        );
        const images = imageResults.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failedImageCount = imageResults.length - images.length;
        if (requestId !== detailRequestRef.current) {
          for (const image of images) URL.revokeObjectURL(image.url);
          return;
        }
        const previousEvidence = evidenceRef.current;
        evidenceRef.current = images;
        setEvidence(images);
        window.setTimeout(() => {
          for (const item of previousEvidence) URL.revokeObjectURL(item.url);
        }, 0);
        if (failedImageCount > 0) {
          setDetailError(`${failedImageCount} 张图片读取失败；Bug 内容和流转仍可正常使用。`);
        }
        const captureIds = [
          ...new Set(
            attachmentResponse.items
              .map((item) => item.captureId)
              .filter((captureId): captureId is string => captureId !== null),
          ),
        ];
        const nextCaptures = (
          await Promise.all(
            captureIds.map(async (captureId): Promise<PocoCaptureContext | null> => {
              try {
                const bundle = await getCaptureBundle(captureId);
                const loadJsonArtifact = async (
                  kind: "poco_snapshot" | "poco_hierarchy",
                ): Promise<unknown | null> => {
                  const succeeded = bundle.artifacts.some(
                    (artifact) => artifact.kind === kind && artifact.status === "succeeded",
                  );
                  if (!succeeded) return null;
                  try {
                    const artifact = await downloadCaptureArtifact(bugId, captureId, kind);
                    return JSON.parse(await artifact.blob.text()) as unknown;
                  } catch {
                    return null;
                  }
                };
                const [snapshot, hierarchy] = await Promise.all([
                  loadJsonArtifact("poco_snapshot"),
                  loadJsonArtifact("poco_hierarchy"),
                ]);
                return { captureId, bundle, snapshot, hierarchy, error: null };
              } catch (cause) {
                // An ordinary screenshot may carry a captureId even when Poco/bundle
                // enrichment failed. Preserve a visible Poco section with the
                // capture identity and failure instead of silently deleting it.
                return {
                  captureId,
                  bundle: null,
                  snapshot: null,
                  hierarchy: null,
                  error: messageFor(cause),
                };
              }
            }),
          )
        ).filter((item): item is PocoCaptureContext => item !== null);
        if (requestId === detailRequestRef.current) setCaptures(nextCaptures);
      } catch (cause) {
        if (requestId === detailRequestRef.current) setDetailError(messageFor(cause));
      } finally {
        if (requestId === detailRequestRef.current) setDetailLoading(false);
      }
    },
    [clearEvidence],
  );

  useEffect(() => {
    void loadProjects().catch((cause: unknown) => setError(messageFor(cause)));
  }, [loadProjects]);

  useEffect(() => {
    void loadWorkbench();
  }, [loadWorkbench]);

  useEffect(() => {
    const refreshVisibleWorkbench = () => {
      if (document.visibilityState === "visible") void loadWorkbench(true, false);
    };
    const interval = window.setInterval(refreshVisibleWorkbench, AUTO_REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => refreshVisibleWorkbench();
    window.addEventListener("focus", refreshVisibleWorkbench);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleWorkbench);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadWorkbench]);

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    const bridge = window.qaHubDesktop;
    if (bridge === undefined) return;
    const stopBugChanged = bridge.onBugChanged((change) => {
      void loadWorkbench(true, false);
      setOverviewRevision((value) => value + 1);
      const activeBugId = selectedIdRef.current;
      if (change.bugId !== null && change.bugId === activeBugId) {
        void loadDetail(activeBugId);
      }
    });
    const stopOpenBug = bridge.onOpenBug((bugId) => {
      setScopeId("team");
      openDetail(bugId);
      void loadWorkbench(true, false);
    });
    return () => {
      stopBugChanged();
      stopOpenBug();
    };
  }, [loadDetail, loadWorkbench, openDetail]);

  useEffect(
    () => () => {
      for (const item of evidenceRef.current) URL.revokeObjectURL(item.url);
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        if (previewImage !== null) setPreviewImage(null);
        else closeDetail();
        setCreateOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDetail, previewImage]);

  const counts = useMemo(
    () => ({
      pending: bugs.filter((bug) => categoryMatches("pending", bug.state)).length,
      inProgress: bugs.filter((bug) => categoryMatches("inProgress", bug.state)).length,
      verification: bugs.filter((bug) => categoryMatches("verification", bug.state)).length,
      completed: bugs.filter((bug) => categoryMatches("completed", bug.state)).length,
    }),
    [bugs],
  );

  const visibleBugs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return bugs.filter((bug) => {
      if (!categoryMatches(category, bug.state)) return false;
      if (normalized.length === 0) return true;
      return `${bug.key} ${bugContent(bug)} ${memberName(bug.ownerId)} ${memberName(
        bug.verificationOwnerId,
      )}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized);
    });
  }, [bugs, category, memberName, query]);

  const runMutation = useCallback(
    async (
      label: string,
      action: () => Promise<void>,
      options: { readonly closeDetailOnSuccess?: boolean } = {},
    ) => {
      setMutation(label);
      setError(null);
      setNotice(null);
      try {
        await action();
        setNotice(label);
        setOverviewRevision((value) => value + 1);
        if (options.closeDetailOnSuccess === true) closeDetail();
        await loadWorkbench(true);
        const activeBugId = selectedIdRef.current;
        if (options.closeDetailOnSuccess !== true && activeBugId !== null) {
          await loadDetail(activeBugId);
        }
      } catch (cause) {
        setError(messageFor(cause));
        const activeBugId = selectedIdRef.current;
        if (cause instanceof QaHubApiError && cause.status === 409 && activeBugId !== null) {
          await loadDetail(activeBugId);
        }
      } finally {
        setMutation(null);
      }
    },
    [closeDetail, loadDetail, loadWorkbench],
  );

  const saveAssignments = async () => {
    if (detail === null || ownerId.length === 0 || verifierId.length === 0) return;
    await runMutation("分配已更新", async () => {
      await updateBugAssignments(detail.id, detail.version, ownerId, verifierId);
    });
  };

  const beginWork = async () => {
    if (detail === null || detail.ownerId === null) return;
    await runMutation("已开始处理", async () => {
      let nextBug = detail;
      if (nextBug.state !== "ready") {
        nextBug = await transitionBugReady(nextBug.id, nextBug.version);
      }
      const attempt = await createHumanRepairAttempt(
        nextBug.id,
        nextBug.version,
        nextBug.ownerId ?? detail.ownerId ?? principal.userId,
        "由 QA Hub Web 人工处理",
      );
      await startHumanRepairAttempt(attempt.id, attempt.version);
    });
  };

  const completeWork = async () => {
    if (
      detail === null ||
      workflow?.repairAttempt === null ||
      workflow?.repairAttempt === undefined
    )
      return;
    const attempt = workflow.repairAttempt;
    await runMutation("修复已完成，等待提报人确认", async () => {
      await deliverHumanRepairAttemptNoCode(
        attempt.id,
        attempt.version,
        "已由人工完成修复并提交验收",
        "本次处理无需独立代码或构建产物",
      );
      const nextBug = await getBug(detail.id);
      await createVerification({
        bugId: nextBug.id,
        expectedBugVersion: nextBug.version,
        repairAttemptId: attempt.id,
        buildId: null,
        verifierId: nextBug.verificationOwnerId ?? nextBug.reporterId,
        criteria: nextBug.expectedBehavior || "提报人确认问题已解决且未引入回归",
      });
    });
  };

  const ensureVerificationStarted = async () => {
    if (workflow?.verification === null || workflow?.verification === undefined) return null;
    if (workflow.verification.status === "requested") {
      return startVerification(workflow.verification.id, workflow.verification.version);
    }
    return workflow.verification;
  };

  const acceptBug = async () => {
    await runMutation(
      "已由提报人确认关闭",
      async () => {
        const verification = await ensureVerificationStarted();
        if (verification === null) return;
        await recordVerificationPassed(
          verification.id,
          verification.version,
          "提报人确认修复有效，关闭 Bug",
          crypto.randomUUID(),
        );
      },
      { closeDetailOnSuccess: true },
    );
  };

  const returnBug = async () => {
    const reason = returnReason.trim();
    if (reason.length === 0) return;
    await runMutation("已打回修复人", async () => {
      const verification = await ensureVerificationStarted();
      if (verification === null) return;
      await recordVerificationFailed(
        verification.id,
        verification.version,
        reason,
        reason,
        crypto.randomUUID(),
      );
      setReturnReason(DEFAULT_RETURN_REASON);
    });
  };

  const handoffRelay = async () => {
    if (detail === null || detail.ownerId === null) return;
    await runMutation("已将 Bug 交给 Relay，QA Hub 仍保留生命周期控制", async () => {
      let nextBug = detail;
      if (nextBug.state !== "ready")
        nextBug = await transitionBugReady(nextBug.id, nextBug.version);
      const attempt = await createRelayAttempt(
        nextBug.id,
        nextBug.version,
        nextBug.ownerId ?? principal.userId,
      );
      await dispatchRelay(attempt.id, attempt.version, crypto.randomUUID());
    });
  };

  const submitComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedId === null || comment.trim().length === 0) return;
    const body = comment.trim();
    await runMutation("处理记录已添加", async () => {
      await addBugComment(selectedId, body, crypto.randomUUID());
      setComment("");
    });
  };

  const submitBug = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = newContent.trim();
    if (content.length === 0) return;
    await runMutation("Bug 已创建并同步到统一后端", async () => {
      const clientSubmissionId = crypto.randomUUID();
      const attachmentIds: string[] = [];
      for (const file of newFiles) {
        attachmentIds.push(
          await uploadBugCreateAttachment({ projectId, clientSubmissionId, file }),
        );
      }
      const created = await createBug({
        projectId,
        clientSubmissionId,
        title: internalBugSummary(content),
        description: content,
        expectedBehavior: DEFAULT_EXPECTED_BEHAVIOR,
        severity: newSeverity,
        priority: `P${newSeverity.slice(1)}` as "P0" | "P1" | "P2" | "P3" | "P4",
        ownerId: newOwnerId || null,
        verificationOwnerId: newVerifierId,
        attachmentIds,
      });
      setOverviewRevision((value) => value + 1);
      setCreateOpen(false);
      setNewContent("");
      setNewFiles([]);
      setNewOwnerId("");
      setScopeId("team");
      setCategory("pending");
      openDetail(created.bug.id);
    });
  };

  const appendNewFiles = (files: readonly File[]) => {
    setNewFiles((current) => mergeCreateBugImages(current, files));
  };

  const pasteNewBugImages = (event: ClipboardEvent<HTMLFormElement>) => {
    const pastedImages = collectClipboardImages([...event.clipboardData.items]);
    if (pastedImages.length === 0) return;
    event.preventDefault();
    appendNewFiles(pastedImages);
  };

  const openCreateBug = () => {
    setNewOwnerId("");
    setCreateOpen(true);
  };

  const canManageDetail = detail !== null && mutation === null;
  const isOwner = detail?.ownerId === principal.userId;
  const isReporter = detail?.reporterId === principal.userId;
  const isAssignedVerifier = detail?.verificationOwnerId === principal.userId;
  const repairAttempt = workflow?.repairAttempt ?? null;
  const verification = workflow?.verification ?? null;
  const previousAttemptFailed = repairAttempt?.status === "verification_failed";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Q</span>
          <div>
            <strong>Relay QA</strong>
            <span>Bug 工作台</span>
          </div>
        </div>
        <nav aria-label="主导航">
          <p className="nav-label">工作区</p>
          <button
            aria-current={view === "workbench" ? "page" : undefined}
            className={`nav-item${view === "workbench" ? " is-active" : ""}`}
            onClick={() => setView("workbench")}
            type="button"
          >
            <span className="nav-icon">▦</span>
            <span>工作台</span>
            <span className="nav-count">{counts.pending}</span>
          </button>
          <button
            aria-current={view === "overview" ? "page" : undefined}
            className={`nav-item${view === "overview" ? " is-active" : ""}`}
            onClick={() => setView("overview")}
            type="button"
          >
            <span className="nav-icon">▤</span>
            <span>总览</span>
            <span className="nav-count">全部</span>
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          <div>
            <strong>统一事实源已连接</strong>
            <span>Web 与 Android 使用同一套数据</span>
          </div>
        </div>
        <button className="profile" disabled={signingOut} onClick={onSignOut} type="button">
          <span className="avatar">{initials(principal.displayName)}</span>
          <span className="profile-copy">
            <strong>{principal.displayName}</strong>
            <small>点击退出登录</small>
          </span>
          <span className="profile-arrow">›</span>
        </button>
      </aside>

      <section className="page">
        <header className="topbar">
          <div className="breadcrumb">
            <strong>{currentProject?.name ?? "QA Hub"}</strong>
            <span>/</span>
            <span>{view === "workbench" ? "工作台" : "总览"}</span>
          </div>
          {view === "workbench" ? (
            <label className="global-search">
              <span aria-hidden="true">⌕</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索编号、内容或人员"
                ref={searchRef}
                type="search"
                value={query}
              />
              <kbd>Ctrl K</kbd>
            </label>
          ) : (
            <div className="overview-topbar-copy">全部 Bug · 表格视图</div>
          )}
          <button
            aria-label="刷新"
            className="icon-button"
            disabled={refreshing}
            onClick={() => {
              if (view === "workbench") void loadWorkbench(true);
              else setOverviewRevision((value) => value + 1);
            }}
            type="button"
          >
            ↻
          </button>
        </header>

        {view === "workbench" ? (
          <main>
            <section className="hero">
              <div>
                <p className="eyebrow">
                  {new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date())}
                </p>
                <h1>你好，{principal.displayName}</h1>
                <p className="hero-copy">先完成需要你动作的 Bug，其他进度会自动留在工作台里。</p>
              </div>
              <button className="primary-button" onClick={openCreateBug} type="button">
                <span>＋</span> 新建 Bug
              </button>
            </section>

            {error === null ? null : <div className="banner error-banner">{error}</div>}
            {notice === null ? null : <div className="banner success-banner">✓ {notice}</div>}

            <section aria-label="工作统计" className="summary-grid">
              {(Object.keys(categoryCopy) as Category[]).map((value) => (
                <button
                  className={`summary-card${category === value ? " is-selected" : ""}`}
                  key={value}
                  onClick={() => setCategory(value)}
                  type="button"
                >
                  <span className={`summary-icon icon-${value}`}>{categoryCopy[value].icon}</span>
                  <span className="summary-value">{counts[value]}</span>
                  <span className="summary-label">{categoryCopy[value].label}</span>
                  <small>{categoryCopy[value].hint}</small>
                </button>
              ))}
            </section>

            <section className="work-panel">
              <div className="panel-head">
                <label className="person-filter">
                  <span>人员范围</span>
                  <select onChange={(event) => setScopeId(event.target.value)} value={scopeId}>
                    <option value={principal.userId}>我 · {principal.displayName}</option>
                    <option value="team">整个团队</option>
                    {members
                      .filter((member) => member.userId !== principal.userId)
                      .map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="panel-tools">
                  <span className="result-inline">{visibleBugs.length} 个事项</span>
                  <button
                    aria-label="刷新列表"
                    className="icon-button refresh-button"
                    disabled={refreshing}
                    onClick={() => void loadWorkbench(true)}
                    type="button"
                  >
                    ↻
                  </button>
                </div>
              </div>
              <div aria-label="Bug 列表" className="bug-table" role="table">
                <div className="table-row table-header" role="row">
                  <span role="columnheader">事项</span>
                  <span role="columnheader">当前动作人</span>
                  <span role="columnheader">进度</span>
                  <span role="columnheader">最后更新</span>
                  <span />
                </div>
                {loading ? <div className="loading-row">正在读取统一后端…</div> : null}
                {!loading && visibleBugs.length === 0 ? (
                  <div className="empty-state">
                    <span>✓</span>
                    <strong>当前筛选下没有事项</strong>
                    <p>换一个人员或状态，或清空搜索关键词。</p>
                  </div>
                ) : null}
                {visibleBugs.map((bug) => {
                  const actionPersonId =
                    bug.state === "ready_for_verification" ? bug.reporterId : bug.ownerId;
                  return (
                    <button
                      className="table-row bug-row"
                      key={bug.id}
                      onClick={() => openDetail(bug.id)}
                      role="row"
                      type="button"
                    >
                      <span className="bug-main" role="cell">
                        <span className={`priority ${bug.priority.toLowerCase()}`}>
                          {bug.priority}
                        </span>
                        <span className="bug-copy">
                          <strong>{bugContent(bug)}</strong>
                          <span className="bug-meta">
                            <b className="bug-key">{bug.key}</b>
                            <span>·</span>
                            <span>{memberName(bug.verificationOwnerId)} 验收</span>
                          </span>
                        </span>
                      </span>
                      <span className="person-cell" role="cell">
                        <span className="person-mini">{initials(memberName(actionPersonId))}</span>
                        <span>
                          <strong>{memberName(actionPersonId)}</strong>
                          <small>
                            {bug.state === "ready_for_verification" ? "提报人确认" : "修复人"}
                          </small>
                        </span>
                      </span>
                      <span className={`status-badge state-${bug.state}`} role="cell">
                        {stateCopy[bug.state]}
                      </span>
                      <span className="updated-cell" role="cell">
                        {formatTime(bug.updatedAt)}
                      </span>
                      <span className="open-arrow" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </main>
        ) : (
          <OverviewPage
            members={members}
            onCreateBug={openCreateBug}
            onMutated={() => {
              setOverviewRevision((value) => value + 1);
              void loadWorkbench(true, false);
            }}
            onOpenBug={openDetail}
            principal={principal}
            projectId={projectId}
            refreshToken={overviewRevision}
          />
        )}
      </section>

      {selectedId === null ? null : (
        <div className="detail-overlay">
          <button
            aria-label="关闭详情"
            className="detail-overlay-dismiss"
            onClick={closeDetail}
            type="button"
          />
          <section aria-label="Bug 详情" aria-modal="true" className="detail-modal" role="dialog">
            {detail === null ? (
              <div className="detail-loading">
                <button
                  aria-label="关闭详情"
                  className="detail-close detail-loading-close"
                  onClick={closeDetail}
                  type="button"
                >
                  ×
                </button>
                {detailLoading ? (
                  <span>正在读取 Bug 详情…</span>
                ) : (
                  <div className="detail-load-error" role="alert">
                    <strong>Bug 详情读取失败</strong>
                    <p>{detailError ?? "无法连接统一后端。"}</p>
                    <button
                      className="primary-button"
                      onClick={() => void loadDetail(selectedId)}
                      type="button"
                    >
                      重新读取
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <header className="detail-modal-head">
                  <div>
                    <span className="detail-key">{detail.key}</span>
                    <span className="priority-badge">{detail.priority}</span>
                    <span className={`status-badge state-${detail.state}`}>
                      {stateCopy[detail.state]}
                    </span>
                  </div>
                  <button className="detail-close" onClick={closeDetail} type="button">
                    ×
                  </button>
                </header>
                <div className="detail-modal-scroll">
                  {detailError === null ? null : (
                    <div className="detail-inline-warning" role="status">
                      <span>{detailError}</span>
                      <button onClick={() => void loadDetail(selectedId)} type="button">
                        重新读取
                      </button>
                    </div>
                  )}
                  <section className="detail-content-card">
                    <div className="detail-content-label">
                      <strong>Bug 内容</strong>
                      <span>
                        {memberName(detail.reporterId)} · {formatTime(detail.createdAt)}
                      </span>
                    </div>
                    <p>{bugContent(detail)}</p>
                  </section>
                  <section className="detail-images-card">
                    <div className="detail-section-title">
                      <strong>截图与标注</strong>
                      <span>
                        {detailLoading && evidence.length === 0
                          ? "正在读取图片…"
                          : `${evidence.length} 张 · 点击查看大图`}
                      </span>
                    </div>
                    {detailLoading && evidence.length === 0 ? (
                      <p className="muted">正在读取截图与标注图…</p>
                    ) : null}
                    {!detailLoading && detailError === null && evidence.length === 0 ? (
                      <p className="muted">这条 Bug 没有图片附件。</p>
                    ) : null}
                    <div className="evidence-grid">
                      {evidence.map((image) => (
                        <button
                          aria-label={`查看图片 ${image.filename}`}
                          key={image.attachmentId}
                          onClick={() => setPreviewImage(image)}
                          type="button"
                        >
                          <img alt={image.filename} src={image.url} />
                          <span>{image.filename}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="detail-support-grid">
                    <div className="detail-support-card flow-section">
                      <div className="detail-section-title">
                        <strong>处理进度</strong>
                        <span>{stateCopy[detail.state]}</span>
                      </div>
                      <div className="flow">
                        {["已提交", "处理中", "待提报人确认", "已关闭"].map((label, index) => {
                          const activeIndex =
                            detail.state === "closed"
                              ? 3
                              : detail.state === "ready_for_verification"
                                ? 2
                                : detail.state === "in_progress" ||
                                    detail.state === "awaiting_build"
                                  ? 1
                                  : 0;
                          return (
                            <span
                              className={`flow-step${index < activeIndex ? " is-done" : index === activeIndex ? " is-active" : ""}`}
                              key={label}
                            >
                              <i />
                              {label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <div className="detail-support-card assignment-grid">
                      <label>
                        <span>修复人</span>
                        <select
                          disabled={!canManageDetail}
                          onChange={(event) => setOwnerId(event.target.value)}
                          value={ownerId}
                        >
                          {owners.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.displayName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>验收人</span>
                        <select
                          disabled={!canManageDetail}
                          onChange={(event) => setVerifierId(event.target.value)}
                          value={verifierId}
                        >
                          {verifiers.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.displayName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="secondary-button assignment-save"
                        disabled={
                          !canManageDetail || ownerId.length === 0 || verifierId.length === 0
                        }
                        onClick={() => void saveAssignments()}
                        type="button"
                      >
                        保存分配
                      </button>
                    </div>
                  </section>
                  <details className="detail-more">
                    <summary>
                      状态轨迹与处理记录 <span>{events.length} 条</span>
                    </summary>
                    <div className="activity">
                      {events.map((event) => (
                        <p key={event.id}>
                          <span className="tiny-avatar">
                            {initials(memberName(event.actor.id))}
                          </span>
                          <span>
                            <strong>{memberName(event.actor.id)}</strong> {eventCopy(event)}
                            <small>{formatTime(event.occurredAt)}</small>
                          </span>
                        </p>
                      ))}
                      <form
                        className="comment-form"
                        onSubmit={(event) => void submitComment(event)}
                      >
                        <input
                          onChange={(event) => setComment(event.target.value)}
                          placeholder="补充评论或处理记录"
                          value={comment}
                        />
                        <button
                          disabled={mutation !== null || comment.trim().length === 0}
                          type="submit"
                        >
                          记录
                        </button>
                      </form>
                    </div>
                  </details>
                  <PocoContextPanel captures={captures} />
                </div>
                <footer className="detail-actions action-stack">
                  {detail.state !== "closed" &&
                  (repairAttempt === null || previousAttemptFailed) &&
                  isOwner ? (
                    <button
                      className="primary-button wide"
                      disabled={mutation !== null}
                      onClick={() => void beginWork()}
                      type="button"
                    >
                      {previousAttemptFailed ? "继续处理已打回 Bug" : "开始处理"}
                    </button>
                  ) : null}
                  {repairAttempt?.status === "planned" && isOwner ? (
                    <button
                      className="primary-button wide"
                      disabled={mutation !== null}
                      onClick={() =>
                        void runMutation("已开始处理", async () => {
                          await startHumanRepairAttempt(repairAttempt.id, repairAttempt.version);
                        })
                      }
                      type="button"
                    >
                      开始处理
                    </button>
                  ) : null}
                  {repairAttempt?.status === "running" && isOwner ? (
                    <button
                      className="primary-button wide"
                      disabled={mutation !== null}
                      onClick={() => void completeWork()}
                      type="button"
                    >
                      标记修复完成
                    </button>
                  ) : null}
                  {detail.state === "ready_for_verification" &&
                  verification?.status === "requested" &&
                  isAssignedVerifier &&
                  !isReporter ? (
                    <button
                      className="primary-button wide"
                      disabled={mutation !== null}
                      onClick={() =>
                        void runMutation("已开始验收，等待提报人最终确认", async () => {
                          await startVerification(verification.id, verification.version);
                        })
                      }
                      type="button"
                    >
                      开始验收
                    </button>
                  ) : null}
                  {detail.state === "ready_for_verification" &&
                  verification !== null &&
                  isReporter &&
                  (verification.status === "requested"
                    ? isAssignedVerifier
                    : verification.status === "in_progress") ? (
                    <>
                      <label className="return-reason">
                        <span>打回原因</span>
                        <input
                          maxLength={500}
                          onChange={(event) => setReturnReason(event.target.value)}
                          value={returnReason}
                        />
                      </label>
                      <button
                        className="secondary-button"
                        disabled={mutation !== null || returnReason.trim().length === 0}
                        onClick={() => void returnBug()}
                        type="button"
                      >
                        打回修复人
                      </button>
                      <button
                        className="primary-button wide"
                        disabled={mutation !== null}
                        onClick={() => void acceptBug()}
                        type="button"
                      >
                        确认修复并关闭
                      </button>
                    </>
                  ) : null}
                  {detail.state === "ready_for_verification" &&
                  verification?.status === "requested" &&
                  isReporter &&
                  !isAssignedVerifier ? (
                    <p className="action-note">
                      等待验收人 {memberName(verification.verifierId)}{" "}
                      开始验收后，由你最终确认或打回。
                    </p>
                  ) : null}
                  {detail.state === "ready_for_verification" &&
                  verification?.status === "in_progress" &&
                  isAssignedVerifier &&
                  !isReporter ? (
                    <p className="action-note">
                      验收已开始，最终关闭或打回由提报人 {memberName(detail.reporterId)} 确认。
                    </p>
                  ) : null}
                  {detail.state !== "closed" &&
                  (repairAttempt === null || previousAttemptFailed) &&
                  isOwner ? (
                    <button
                      className="secondary-button"
                      disabled={mutation !== null}
                      onClick={() => void handoffRelay()}
                      type="button"
                    >
                      可选：交给 Relay
                    </button>
                  ) : null}
                  {detail.state === "closed" ? (
                    <p className="action-note action-note-left">这条 Bug 已由提报人确认完成。</p>
                  ) : null}
                  {detail.state !== "closed" &&
                  detail.state !== "ready_for_verification" &&
                  !isOwner ? (
                    <p className="action-note action-note-left">
                      {detail.ownerId === null
                        ? "当前尚未分配修复人。"
                        : `当前等待修复人 ${memberName(detail.ownerId)} 处理。`}
                    </p>
                  ) : null}
                </footer>
              </>
            )}
          </section>
        </div>
      )}

      {previewImage === null ? null : (
        <div className="image-viewer">
          <button
            aria-label="关闭图片预览"
            className="image-viewer-dismiss"
            onClick={() => setPreviewImage(null)}
            type="button"
          />
          <figure aria-label={previewImage.filename} aria-modal="true" role="dialog">
            <button aria-label="关闭图片预览" onClick={() => setPreviewImage(null)} type="button">
              ×
            </button>
            <img alt={previewImage.filename} src={previewImage.url} />
            <figcaption>{previewImage.filename}</figcaption>
          </figure>
        </div>
      )}

      {createOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form
            className="create-modal"
            onPaste={pasteNewBugImages}
            onSubmit={(event) => void submitBug(event)}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">统一事实源</p>
                <h2>新建 Bug</h2>
              </div>
              <button onClick={() => setCreateOpen(false)} type="button">
                ×
              </button>
            </div>
            <label>
              Bug 内容
              <textarea
                autoFocus
                maxLength={20000}
                onChange={(event) => setNewContent(event.target.value)}
                placeholder="描述你看到的问题、复现位置和需要修复的表现"
                required
                rows={7}
                value={newContent}
              />
              <small>填写完整问题内容即可。</small>
            </label>
            <div className="form-grid">
              <label>
                严重程度
                <select
                  onChange={(event) => setNewSeverity(event.target.value as typeof newSeverity)}
                  value={newSeverity}
                >
                  {["S0", "S1", "S2", "S3", "S4"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                修复人（可稍后分配）
                <select onChange={(event) => setNewOwnerId(event.target.value)} value={newOwnerId}>
                  <option value="">暂不指定</option>
                  {owners.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                验收人
                <select
                  onChange={(event) => setNewVerifierId(event.target.value)}
                  value={newVerifierId}
                >
                  {verifiers.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              截图 / 标注图
              <input
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={(event) => {
                  appendNewFiles([...(event.target.files ?? [])]);
                  event.currentTarget.value = "";
                }}
                type="file"
              />
              <small aria-live="polite">
                {newFiles.length === 0
                  ? "可选择文件，或在弹窗内按 Ctrl+V 直接粘贴图片"
                  : `已添加 ${newFiles.length} 张图片；还可以继续选择或 Ctrl+V 粘贴`}
              </small>
            </label>
            {newFilePreviews.length === 0 ? null : (
              <div aria-label="待上传图片" className="create-image-previews">
                {newFilePreviews.map((preview) => (
                  <figure key={preview.key}>
                    <img alt={preview.file.name} src={preview.url} />
                    <figcaption>{preview.file.name}</figcaption>
                    <button
                      aria-label={`移除图片 ${preview.file.name}`}
                      onClick={() =>
                        setNewFiles((current) => current.filter((file) => file !== preview.file))
                      }
                      type="button"
                    >
                      ×
                    </button>
                  </figure>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setCreateOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={
                  mutation !== null || newOwnerId.length === 0 || newVerifierId.length === 0
                }
                type="submit"
              >
                {mutation === null ? "创建 Bug" : "正在提交…"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
