import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { QRCodeSVG } from "qrcode.react";

import {
  addBugComment,
  completeBugForVerification,
  createBug,
  createHumanRepairAttempt,
  createRelayAttempt,
  createVerification,
  deleteBug,
  deliverHumanRepairAttemptNoCode,
  dispatchRelay,
  downloadAttachment,
  downloadCaptureArtifact,
  getBug,
  getCaptureBundle,
  getHumanWorkflow,
  getQingyuBugLink,
  getQingyuSession,
  getVerification,
  importOwnQingyuDefects,
  listBugAttachments,
  listBugEvents,
  listBugs,
  listProjectMembers,
  listProjectModules,
  listOwnQingyuDefects,
  listQingyuProjects,
  listVisibleProjects,
  logoutQingyu,
  pollQingyuLogin,
  QaHubApiError,
  recordVerificationFailed,
  recordVerificationPassed,
  startHumanRepairAttempt,
  startQingyuLogin,
  startVerification,
  transitionBugReady,
  updateBugAssignments,
  updateBugDetails,
  uploadBugCreateAttachment,
  type BrowserSessionPrincipal,
  type BugDetail,
  type BugEvent,
  type BugListItem,
  type BugPriority,
  type BugSeverity,
  type BugListState,
  type HumanWorkflowSnapshot,
  type ProjectMember,
  type ProjectModule,
  type QingyuBugLink,
  type QingyuDefect,
  type QingyuProject,
  type QingyuSession,
  type VerificationRecord,
  type VisibleProject,
} from "./api";
import PocoContextPanel, { type PocoCaptureContext } from "./PocoContextPanel";
import OverviewPage, { formatOverviewDateLabel, type OverviewDateBucket } from "./OverviewPage";
import UserManagementPage from "./UserManagementPage";
import {
  TASK_STATUS_ORDER,
  taskStatusCopy,
  taskStatusForBugState,
  taskStatusLabel,
  taskStatusMatches,
  type TaskStatus,
} from "./task-status";

const DEFAULT_PROJECT_ID =
  import.meta.env.VITE_QA_HUB_PROJECT_ID ?? "10000000-0000-4000-8000-000000000004";

type Category = TaskStatus;
type WorkspaceView = "workbench" | "overview" | "users";

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

interface BugDetailDraft {
  readonly expectedVersion: number;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly moduleId: string | null;
  readonly severity: BugSeverity;
  readonly priority: BugPriority;
}

interface ClipboardImageItem {
  readonly kind: string;
  readonly type: string;
  getAsFile(): File | null;
}

const DEFAULT_EXPECTED_BEHAVIOR = "问题修复后不再复现";
const AUTO_REFRESH_INTERVAL_MS = 5_000;
const CREATE_BUG_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function canSubmitNewBug(mutation: string | null, verifierId: string): boolean {
  return mutation === null && verifierId.length > 0;
}

export function selectableQingyuDefectIds(
  defects: readonly Pick<QingyuDefect, "id" | "actionable" | "importedBugId">[],
): readonly string[] {
  return defects
    .filter((defect) => defect.actionable && defect.importedBugId === null)
    .map((defect) => defect.id);
}

export function updateQingyuDefectSelection(
  current: readonly string[],
  defectId: string,
  selected: boolean,
): readonly string[] {
  if (selected) return current.includes(defectId) ? current : [...current, defectId];
  return current.filter((id) => id !== defectId);
}

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

function draftFromBug(bug: BugDetail): BugDetailDraft {
  return {
    expectedVersion: bug.version,
    title: bug.title,
    description: bug.description,
    expectedBehavior: bug.expectedBehavior,
    moduleId: bug.moduleId,
    severity: bug.severity,
    priority: bug.priority,
  };
}

export function canSaveBugDetailDraft(
  draft: BugDetailDraft | null,
  bug: BugDetail | null,
  mutation: string | null,
  versionConflict: boolean,
  pendingImageCount = 0,
): boolean {
  if (draft === null || bug === null || mutation !== null || versionConflict) return false;
  const title = draft.title.trim();
  const description = draft.description.trim();
  const expectedBehavior = draft.expectedBehavior.trim();
  if (title.length === 0 || description.length === 0 || expectedBehavior.length === 0) return false;
  return (
    title !== bug.title ||
    description !== bug.description ||
    expectedBehavior !== bug.expectedBehavior ||
    draft.moduleId !== bug.moduleId ||
    draft.severity !== bug.severity ||
    draft.priority !== bug.priority ||
    pendingImageCount > 0
  );
}

function bugContent(bug: Pick<BugListItem, "description" | "title">): string {
  return bug.description.trim() || bug.title.trim();
}

function internalBugSummary(content: string): string {
  return content.replace(/\s+/gu, " ").trim().slice(0, 160);
}

const DEFAULT_RETURN_REASON = "问题仍可复现，请继续处理";
const VERIFICATION_RETRY_DELAY_MS = 200;

export type VerificationStepReconciliation<T> =
  | { readonly status: "committed"; readonly value: T }
  | { readonly status: "retry" }
  | { readonly status: "conflict" };

export function isRecoverableVerificationWriteFailure(cause: unknown): boolean {
  return (
    cause instanceof TypeError ||
    (cause instanceof QaHubApiError &&
      (cause.status >= 500 ||
        cause.code === "ERR_SQLITE_ERROR" ||
        cause.code === "SQLITE_BUSY" ||
        cause.code === "SQLITE_LOCKED" ||
        cause.code === "SQLITE_WORKER_FAILED" ||
        cause.code === "STORAGE_WRITE_TEMPORARILY_UNAVAILABLE"))
  );
}

export async function runRecoverableVerificationStep<T>(
  action: () => Promise<T>,
  reconcile: () => Promise<VerificationStepReconciliation<T>>,
  waitBeforeRetry: () => Promise<void> = () =>
    new Promise((resolve) => window.setTimeout(resolve, VERIFICATION_RETRY_DELAY_MS)),
): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    if (!isRecoverableVerificationWriteFailure(cause)) throw cause;

    let reconciliation: VerificationStepReconciliation<T>;
    try {
      reconciliation = await reconcile();
    } catch (reconcileCause) {
      if (isRecoverableVerificationWriteFailure(reconcileCause)) {
        throw new QaHubApiError(503, "VERIFICATION_WRITE_TEMPORARILY_UNAVAILABLE");
      }
      throw reconcileCause;
    }
    if (reconciliation.status === "committed") return reconciliation.value;
    if (reconciliation.status === "conflict") {
      throw new QaHubApiError(412, "VERSION_CONFLICT");
    }

    await waitBeforeRetry();
    try {
      return await action();
    } catch (retryCause) {
      if (isRecoverableVerificationWriteFailure(retryCause)) {
        throw new QaHubApiError(503, "VERIFICATION_WRITE_TEMPORARILY_UNAVAILABLE");
      }
      throw retryCause;
    }
  }
}

function categoryMatches(category: Category, state: BugListState): boolean {
  return taskStatusMatches(category, state);
}

export function canDirectCloseBug(
  state: BugListState,
  hasRepairAttempt: boolean,
  verificationStatus: VerificationRecord["status"] | null,
): boolean {
  return (
    state === "ready_for_verification" &&
    hasRepairAttempt &&
    (verificationStatus === null ||
      verificationStatus === "requested" ||
      verificationStatus === "in_progress")
  );
}

export function canReturnCompletedBug(
  state: BugListState,
  hasRepairAttempt: boolean,
  verificationStatus: VerificationRecord["status"] | null,
): boolean {
  return (
    (state === "awaiting_build" || state === "ready_for_verification") &&
    hasRepairAttempt &&
    (verificationStatus === null ||
      verificationStatus === "requested" ||
      verificationStatus === "in_progress")
  );
}

export function canCompleteDeliveredTask(
  state: BugListState,
  repairAttemptStatus: NonNullable<HumanWorkflowSnapshot["repairAttempt"]>["status"] | null,
): boolean {
  return state === "awaiting_build" && repairAttemptStatus === "delivered";
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

function canonicalProjectMemberId(
  members: readonly ProjectMember[],
  userId: string | null,
): string | null {
  if (userId === null) return null;
  return (
    members.find(
      (member) => member.userId === userId || member.linkedUserIds?.includes(userId) === true,
    )?.userId ?? userId
  );
}

function messageFor(cause: unknown): string {
  if (cause instanceof QaHubApiError) {
    const qingyuMessages: Readonly<Record<string, string>> = {
      QINGYU_AUTH_REQUIRED: "轻语登录已过期，请重新扫码连接。",
      QINGYU_LINKED_SESSION_REQUIRED: "请先用导入这条 Bug 的轻语账号扫码连接，再执行关单。",
      QINGYU_ACCOUNT_MISMATCH: "当前轻语账号与导入 Bug 时的账号不一致，请切换账号后重试。",
      QINGYU_RESOLVE_TRANSITION_UNAVAILABLE:
        "轻语当前状态没有可用的“已解决”流转，或当前账号没有关单权限。",
      QINGYU_RESOLVE_VERSION_REQUIRED: "轻语要求填写解决版本，但项目没有可用版本。",
      QINGYU_TRANSITION_FIELD_REQUIRED: "轻语关单还缺少必填字段，QA Hub 已保留为已完成待验收状态。",
      QINGYU_RESOLUTION_NOT_VERIFIED: "轻语未确认 Bug 已解决，QA Hub 未执行本地关单。",
      QINGYU_TIMEOUT: "轻语响应超时，请稍后重试。",
      QINGYU_UNAVAILABLE: "当前无法连接轻语，请检查网络后重试。",
      QINGYU_UPSTREAM_FAILED: "轻语拒绝了本次请求，请稍后重试或检查账号权限。",
      STORAGE_WRITE_TEMPORARILY_UNAVAILABLE: "数据写入暂时繁忙，系统已保留原状态，请稍后重新操作。",
      VERIFICATION_WRITE_TEMPORARILY_UNAVAILABLE:
        "验收状态暂时无法写入，系统已保留原状态，请稍后重新操作。",
      ERR_SQLITE_ERROR: "数据写入暂时失败，系统已保留原状态，请稍后重新操作。",
    };
    const qingyuMessage = cause.code === null ? undefined : qingyuMessages[cause.code];
    if (qingyuMessage !== undefined) return qingyuMessage;
    if (cause.status === 409 || cause.status === 412)
      return "数据刚刚被其他人更新，已重新读取，请再操作一次。";
    if (cause.status === 403) return "当前身份没有执行这项操作的权限。";
    return cause.code === null ? `请求失败（HTTP ${cause.status}）` : `请求失败：${cause.code}`;
  }
  return cause instanceof Error ? cause.message : "发生了未知错误。";
}

function eventCopy(event: BugEvent): string {
  const from =
    typeof event.fromState === "string" ? taskStatusLabel(event.fromState as BugListState) : null;
  const to =
    typeof event.toState === "string" ? taskStatusLabel(event.toState as BugListState) : null;
  if (from !== null && to !== null && from !== to) return `${from} → ${to}`;
  const labels: Readonly<Record<string, string>> = {
    "bug.created": "提交了 Bug",
    "bug.updated": "更新了分配或详情",
    "bug.comment_added": "添加了处理记录",
    "repair_attempt.created": "建立了处理任务",
    "repair_attempt.started": "开始处理",
    "repair_attempt.delivered": "标记修复完成",
    "bug.completed_for_verification": "已完成，等待验收",
    "verification.requested": "修复已完成，等待验收",
    "verification.started": "开始验收",
    "verification.failed": "验收未通过",
    "verification.passed": "验收通过并关闭 Bug",
    "relay.handoff_queued": "已交给 Relay",
  };
  return labels[event.type] ?? event.type;
}

export default function App({ principal, signingOut, onSignOut }: AppProps) {
  const [view, setView] = useState<WorkspaceView>("workbench");
  const [overviewDate, setOverviewDate] = useState<string | null>(null);
  const [overviewDateBuckets, setOverviewDateBuckets] = useState<readonly OverviewDateBucket[]>([]);
  const [projects, setProjects] = useState<readonly VisibleProject[]>([]);
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT_ID);
  const [members, setMembers] = useState<readonly ProjectMember[]>([]);
  const [modules, setModules] = useState<readonly ProjectModule[]>([]);
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
  const [editingDetail, setEditingDetail] = useState(false);
  const [detailDraft, setDetailDraft] = useState<BugDetailDraft | null>(null);
  const [detailEditError, setDetailEditError] = useState<string | null>(null);
  const [detailEditVersionConflict, setDetailEditVersionConflict] = useState(false);
  const [detailAttachmentIds, setDetailAttachmentIds] = useState<readonly string[]>([]);
  const [detailNewFiles, setDetailNewFiles] = useState<readonly File[]>([]);
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
  const [qingyuLink, setQingyuLink] = useState<QingyuBugLink | null>(null);
  const [qingyuOpen, setQingyuOpen] = useState(false);
  const [qingyuSession, setQingyuSession] = useState<QingyuSession | null>(null);
  const [qingyuProjects, setQingyuProjects] = useState<readonly QingyuProject[]>([]);
  const [qingyuProjectId, setQingyuProjectId] = useState("");
  const [qingyuDefects, setQingyuDefects] = useState<readonly QingyuDefect[]>([]);
  const [qingyuSelectedDefectIds, setQingyuSelectedDefectIds] = useState<readonly string[]>([]);
  const [qingyuBusy, setQingyuBusy] = useState(false);
  const [qingyuError, setQingyuError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const evidenceRef = useRef<readonly EvidenceImage[]>([]);
  const workbenchRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const detailBugIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [userManagementRevision, setUserManagementRevision] = useState(0);

  const newFilePreviews = useMemo(
    () =>
      newFiles.map((file, index) => ({
        file,
        key: `${createBugImageKey(file)}\u0000${index}`,
        url: URL.createObjectURL(file),
      })),
    [newFiles],
  );
  const detailNewFilePreviews = useMemo(
    () =>
      detailNewFiles.map((file, index) => ({
        file,
        key: `${createBugImageKey(file)}\u0000${index}`,
        url: URL.createObjectURL(file),
      })),
    [detailNewFiles],
  );
  const qingyuSelectableDefectIds = useMemo(
    () => selectableQingyuDefectIds(qingyuDefects),
    [qingyuDefects],
  );
  const qingyuSelectedDefectIdSet = useMemo(
    () => new Set(qingyuSelectedDefectIds),
    [qingyuSelectedDefectIds],
  );

  useEffect(
    () => () => {
      for (const preview of newFilePreviews) URL.revokeObjectURL(preview.url);
    },
    [newFilePreviews],
  );
  useEffect(
    () => () => {
      for (const preview of detailNewFilePreviews) URL.revokeObjectURL(preview.url);
    },
    [detailNewFilePreviews],
  );

  const currentProject = projects.find((project) => project.id === projectId) ?? null;
  const overviewBugCount = overviewDateBuckets.reduce((total, bucket) => total + bucket.count, 0);
  const overviewDateLabel =
    overviewDate === null ? "全部日期" : formatOverviewDateLabel(overviewDate);
  const updateOverviewDateBuckets = useCallback(
    (buckets: readonly OverviewDateBucket[]) => setOverviewDateBuckets(buckets),
    [],
  );
  const memberName = useCallback(
    (id: string | null): string => {
      if (id === null) return "未分配";
      if (id === principal.userId) return principal.displayName;
      return (
        members.find(
          (member) => member.userId === id || member.linkedUserIds?.includes(id) === true,
        )?.displayName ?? id.slice(0, 8)
      );
    },
    [members, principal.displayName, principal.userId],
  );

  const owners = useMemo(
    () => members.filter((member) => member.roles.includes("developer")),
    [members],
  );
  const verifiers = useMemo(
    () =>
      members.filter(
        (member) => member.roles.includes("verifier") || member.userId === principal.userId,
      ),
    [members, principal.userId],
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

  useEffect(() => {
    if (scopeId === "team" || scopeId === principal.userId) return;
    const canonicalScopeId = canonicalProjectMemberId(members, scopeId);
    if (canonicalScopeId !== scopeId) {
      setScopeId(canonicalScopeId ?? principal.userId);
    } else if (!members.some((member) => member.userId === scopeId)) {
      setScopeId(principal.userId);
    }
  }, [members, principal.userId, scopeId]);

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

  const loadQingyuDefects = useCallback(async (externalProjectId: string) => {
    if (externalProjectId.length === 0) {
      setQingyuDefects([]);
      setQingyuSelectedDefectIds([]);
      return;
    }
    const response = await listOwnQingyuDefects(externalProjectId);
    setQingyuDefects(response.defects);
    const selectableIds = new Set(selectableQingyuDefectIds(response.defects));
    setQingyuSelectedDefectIds((current) =>
      current.filter((defectId) => selectableIds.has(defectId)),
    );
  }, []);

  const loadQingyuWorkspace = useCallback(async () => {
    const nextProjects = await listQingyuProjects();
    setQingyuProjects(nextProjects);
    const selected =
      nextProjects.find((project) => project.id === qingyuProjectId) ?? nextProjects[0];
    const selectedId = selected?.id ?? "";
    setQingyuProjectId(selectedId);
    await loadQingyuDefects(selectedId);
  }, [loadQingyuDefects, qingyuProjectId]);

  const openQingyuImport = async () => {
    setQingyuOpen(true);
    setQingyuSelectedDefectIds([]);
    setQingyuBusy(true);
    setQingyuError(null);
    try {
      let session = await getQingyuSession();
      if (!session.authenticated && session.login === null) session = await startQingyuLogin();
      setQingyuSession(session);
      if (session.authenticated) await loadQingyuWorkspace();
    } catch (cause) {
      setQingyuError(messageFor(cause));
    } finally {
      setQingyuBusy(false);
    }
  };

  useEffect(() => {
    if (
      !qingyuOpen ||
      qingyuSession?.authenticated !== false ||
      qingyuSession.login === null ||
      qingyuSession.login.status === "expired" ||
      qingyuSession.login.status === "cancelled"
    ) {
      return;
    }
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const session = await pollQingyuLogin();
        if (disposed) return;
        setQingyuSession(session);
        if (session.authenticated) {
          await loadQingyuWorkspace();
        }
      } catch (cause) {
        if (!disposed) setQingyuError(messageFor(cause));
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1_500);
    void poll();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadQingyuWorkspace, qingyuOpen, qingyuSession]);

  const importQingyuBugs = async () => {
    if (qingyuProjectId.length === 0 || qingyuSelectedDefectIds.length === 0) return;
    setQingyuBusy(true);
    setQingyuError(null);
    try {
      const result = await importOwnQingyuDefects(qingyuProjectId, qingyuSelectedDefectIds);
      const created = result.items.filter((item) => item.status === "created").length;
      const existing = result.items.filter((item) => item.status === "already_imported").length;
      const terminal = result.items.filter((item) => item.status === "skipped_terminal").length;
      const failed = result.items.filter((item) => item.status === "failed");
      if (failed.length > 0) {
        setQingyuError(
          `已导入 ${created} 条，${existing} 条已存在，${terminal} 条已结束；${failed.length} 条失败：${failed[0]?.errorMessage ?? failed[0]?.errorCode ?? "未知错误"}`,
        );
      } else {
        setNotice(
          `轻语导入完成：新增 ${created} 条，已存在 ${existing} 条，已结束 ${terminal} 条。`,
        );
      }
      await Promise.all([loadQingyuDefects(qingyuProjectId), loadWorkbench(true)]);
    } catch (cause) {
      setQingyuError(messageFor(cause));
    } finally {
      setQingyuBusy(false);
    }
  };

  const disconnectQingyu = async () => {
    setQingyuBusy(true);
    setQingyuError(null);
    try {
      setQingyuSession(await logoutQingyu());
      setQingyuProjects([]);
      setQingyuProjectId("");
      setQingyuDefects([]);
      setQingyuSelectedDefectIds([]);
    } catch (cause) {
      setQingyuError(messageFor(cause));
    } finally {
      setQingyuBusy(false);
    }
  };

  const restartQingyuLogin = async () => {
    setQingyuBusy(true);
    setQingyuError(null);
    try {
      setQingyuSession(await startQingyuLogin());
    } catch (cause) {
      setQingyuError(messageFor(cause));
    } finally {
      setQingyuBusy(false);
    }
  };

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
    setQingyuLink(null);
    setCaptures([]);
    setDetailLoading(false);
    setDetailError(null);
    setEditingDetail(false);
    setDetailDraft(null);
    setDetailEditError(null);
    setDetailEditVersionConflict(false);
    setDetailAttachmentIds([]);
    setDetailNewFiles([]);
    setPreviewImage(null);
    setModules([]);
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
        setModules([]);
      }
      try {
        const nextDetail = await getBug(bugId);
        const [
          eventResponse,
          attachmentResponse,
          workflowResponse,
          moduleResponse,
          nextQingyuLink,
        ] = await Promise.all([
          listBugEvents(bugId),
          listBugAttachments(bugId),
          getHumanWorkflow(bugId),
          listProjectModules(nextDetail.projectId),
          getQingyuBugLink(bugId),
        ]);
        if (requestId !== detailRequestRef.current) return;
        setDetail(nextDetail);
        setEvents(eventResponse.items);
        setWorkflow(workflowResponse);
        setQingyuLink(nextQingyuLink);
        setModules(moduleResponse.items.filter((item) => item.active));
        setDetailAttachmentIds(attachmentResponse.items.map((item) => item.attachmentId));
        setOwnerId(canonicalProjectMemberId(members, nextDetail.ownerId) ?? "");
        setVerifierId(
          canonicalProjectMemberId(
            members,
            nextDetail.verificationOwnerId ?? nextDetail.reporterId,
          ) ?? nextDetail.reporterId,
        );

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
    [clearEvidence, members],
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
        else if (editingDetail) {
          setEditingDetail(false);
          setDetailDraft(null);
          setDetailEditError(null);
          setDetailEditVersionConflict(false);
          setDetailNewFiles([]);
        } else closeDetail();
        setCreateOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDetail, editingDetail, previewImage]);

  const counts = useMemo(
    () => ({
      pending: bugs.filter((bug) => categoryMatches("pending", bug.state)).length,
      inProgress: bugs.filter((bug) => categoryMatches("inProgress", bug.state)).length,
      verification: bugs.filter((bug) => categoryMatches("verification", bug.state)).length,
      closed: bugs.filter((bug) => categoryMatches("closed", bug.state)).length,
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
        if (
          cause instanceof QaHubApiError &&
          (cause.status === 409 || cause.status === 412) &&
          activeBugId !== null
        ) {
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

  const beginDetailEdit = () => {
    if (detail === null || mutation !== null) return;
    setDetailDraft(draftFromBug(detail));
    setDetailEditError(null);
    setDetailEditVersionConflict(false);
    setDetailNewFiles([]);
    setEditingDetail(true);
  };

  const cancelDetailEdit = () => {
    setEditingDetail(false);
    setDetailDraft(null);
    setDetailEditError(null);
    setDetailEditVersionConflict(false);
    setDetailNewFiles([]);
  };

  const appendDetailFiles = (files: readonly File[]) => {
    setDetailNewFiles((current) => mergeCreateBugImages(current, files));
  };

  const pasteDetailImages = (event: ClipboardEvent<HTMLFormElement>) => {
    const pastedImages = collectClipboardImages([...event.clipboardData.items]);
    if (pastedImages.length === 0) return;
    event.preventDefault();
    appendDetailFiles(pastedImages);
  };

  const saveBugDetail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      detail === null ||
      detailDraft === null ||
      !canSaveBugDetailDraft(detailDraft, detail, mutation, detailEditVersionConflict)
    ) {
      return;
    }
    setMutation("正在保存 Bug 详情…");
    setError(null);
    setNotice(null);
    setDetailEditError(null);
    try {
      const clientMutationId = crypto.randomUUID();
      const uploadedAttachmentIds: string[] = [];
      for (const file of detailNewFiles) {
        uploadedAttachmentIds.push(
          await uploadBugCreateAttachment({
            projectId: detail.projectId,
            clientSubmissionId: clientMutationId,
            file,
          }),
        );
      }
      const updated = await updateBugDetails(
        detail.id,
        detailDraft.expectedVersion,
        {
          ...(detailDraft.title.trim() === detail.title ? {} : { title: detailDraft.title.trim() }),
          ...(detailDraft.description.trim() === detail.description
            ? {}
            : { description: detailDraft.description.trim() }),
          ...(detailDraft.expectedBehavior.trim() === detail.expectedBehavior
            ? {}
            : { expectedBehavior: detailDraft.expectedBehavior.trim() }),
          ...(detailDraft.moduleId === detail.moduleId ? {} : { moduleId: detailDraft.moduleId }),
          ...(detailDraft.severity === detail.severity ? {} : { severity: detailDraft.severity }),
          ...(detailDraft.priority === detail.priority ? {} : { priority: detailDraft.priority }),
          ...(uploadedAttachmentIds.length === 0
            ? {}
            : { attachmentIds: [...detailAttachmentIds, ...uploadedAttachmentIds] }),
        },
        clientMutationId,
      );
      setDetail(updated);
      cancelDetailEdit();
      setNotice(`${updated.key} 的 Bug 详情已更新`);
      setOverviewRevision((value) => value + 1);
      await loadWorkbench(true);
      if (selectedIdRef.current === updated.id) await loadDetail(updated.id);
    } catch (cause) {
      const conflict =
        cause instanceof QaHubApiError && (cause.status === 409 || cause.status === 412);
      setDetailEditVersionConflict(conflict);
      setDetailEditError(
        conflict
          ? "这条 Bug 刚刚被其他人更新。你的输入尚未保存，请取消编辑后重新打开最新内容。"
          : messageFor(cause),
      );
      if (conflict) await loadDetail(detail.id);
    } finally {
      setMutation(null);
    }
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
    await runMutation("已完成待验收，等待验收人处理", async () => {
      await deliverHumanRepairAttemptNoCode(
        attempt.id,
        attempt.version,
        "已由人工完成修复并提交关闭",
        "本次处理无需独立代码或构建产物",
      );
      const nextBug = await getBug(detail.id);
      await createVerification({
        bugId: nextBug.id,
        expectedBugVersion: nextBug.version,
        repairAttemptId: attempt.id,
        buildId: null,
        verifierId: nextBug.verificationOwnerId ?? principal.userId,
        criteria: nextBug.expectedBehavior || "关闭人确认问题已解决且未引入回归",
      });
    });
  };

  const completeDeliveredWork = async () => {
    if (detail === null || repairAttempt === null) return;
    await runMutation("已完成待验收，等待验收人处理", async () => {
      await completeBugForVerification(detail.id, detail.version, repairAttempt.id);
    });
  };

  const ensureVerificationStarted = async () => {
    if (detail === null || repairAttempt === null) return null;
    let verificationBug = detail;
    let current = workflow?.verification ?? null;
    if (verificationBug.state === "awaiting_build") {
      if (repairAttempt.status !== "delivered") return null;
      let expectedBugVersion = verificationBug.version;
      verificationBug = await runRecoverableVerificationStep(
        () => completeBugForVerification(verificationBug.id, expectedBugVersion, repairAttempt.id),
        async () => {
          const latest = await getBug(verificationBug.id);
          if (latest.state === "ready_for_verification") {
            return { status: "committed", value: latest };
          }
          if (latest.state === "awaiting_build") {
            expectedBugVersion = latest.version;
            return { status: "retry" };
          }
          return { status: "conflict" };
        },
      );
      current = null;
    }
    if (verificationBug.state !== "ready_for_verification") return null;
    if (current === null) {
      let expectedBugVersion = verificationBug.version;
      let buildId = workflow?.build?.id ?? null;
      current = await runRecoverableVerificationStep(
        () =>
          createVerification({
            bugId: verificationBug.id,
            expectedBugVersion,
            repairAttemptId: repairAttempt.id,
            buildId,
            verifierId: verificationBug.verificationOwnerId ?? principal.userId,
            criteria: verificationBug.expectedBehavior || "关闭人确认问题已解决且未引入回归",
          }),
        async () => {
          const [latestBug, latestWorkflow] = await Promise.all([
            getBug(verificationBug.id),
            getHumanWorkflow(verificationBug.id),
          ]);
          const latestVerification = latestWorkflow.verification;
          if (
            latestVerification !== null &&
            latestVerification.repairAttemptId === repairAttempt.id &&
            (latestVerification.status === "requested" ||
              latestVerification.status === "in_progress" ||
              latestVerification.status === "passed" ||
              latestVerification.status === "failed")
          ) {
            return { status: "committed", value: latestVerification };
          }
          if (
            latestBug.state === "ready_for_verification" &&
            latestWorkflow.repairAttempt?.id === repairAttempt.id &&
            latestVerification === null
          ) {
            verificationBug = latestBug;
            expectedBugVersion = latestBug.version;
            buildId = latestWorkflow.build?.id ?? null;
            return { status: "retry" };
          }
          return { status: "conflict" };
        },
      );
    }
    if (current.status === "requested") {
      let expectedVerificationVersion = current.version;
      return runRecoverableVerificationStep(
        () => startVerification(current.id, expectedVerificationVersion),
        async () => {
          const latest = await getVerification(current.id);
          if (
            latest.status === "in_progress" ||
            latest.status === "passed" ||
            latest.status === "failed"
          ) {
            return { status: "committed", value: latest };
          }
          if (latest.status === "requested") {
            expectedVerificationVersion = latest.version;
            return { status: "retry" };
          }
          return { status: "conflict" };
        },
      );
    }
    return current;
  };

  const recordVerificationResultReliably = async (
    verification: VerificationRecord,
    expectedStatus: "passed" | "failed",
    action: (expectedVersion: number) => Promise<unknown>,
  ) => {
    if (verification.status === expectedStatus) return;
    if (verification.status !== "in_progress") {
      throw new QaHubApiError(412, "VERSION_CONFLICT");
    }
    let expectedVerificationVersion = verification.version;
    await runRecoverableVerificationStep(
      async () => {
        await action(expectedVerificationVersion);
      },
      async () => {
        const latest = await getVerification(verification.id);
        if (latest.status === expectedStatus) {
          return { status: "committed", value: undefined };
        }
        if (latest.status === "in_progress") {
          expectedVerificationVersion = latest.version;
          return { status: "retry" };
        }
        return { status: "conflict" };
      },
    );
  };

  const acceptBug = async () => {
    await runMutation(
      "Bug 已验收并关闭",
      async () => {
        const verification = await ensureVerificationStarted();
        if (verification === null) return;
        const clientSubmissionId = crypto.randomUUID();
        await recordVerificationResultReliably(verification, "passed", (expectedVersion) =>
          recordVerificationPassed(
            verification.id,
            expectedVersion,
            "关闭人确认修复有效，直接关闭 Bug",
            clientSubmissionId,
          ),
        );
      },
      { closeDetailOnSuccess: true },
    );
  };

  const returnBug = async () => {
    const reason = returnReason.trim();
    if (reason.length === 0) return;
    await runMutation("验收未通过，已打回待处理", async () => {
      const verification = await ensureVerificationStarted();
      if (verification === null) return;
      const clientSubmissionId = crypto.randomUUID();
      await recordVerificationResultReliably(verification, "failed", (expectedVersion) =>
        recordVerificationFailed(
          verification.id,
          expectedVersion,
          reason,
          reason,
          clientSubmissionId,
        ),
      );
      setReturnReason(DEFAULT_RETURN_REASON);
    });
  };

  const deleteSelectedBug = async () => {
    if (detail === null) return;
    const confirmed = window.confirm(
      `确认删除 ${detail.key}？删除后会从 QA Hub 列表、详情和 MCP 中隐藏。`,
    );
    if (!confirmed) return;
    await runMutation(
      `${detail.key} 已删除`,
      async () => {
        await deleteBug(detail.id, detail.version);
      },
      { closeDetailOnSuccess: true },
    );
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
    setNewVerifierId(principal.userId);
    setCreateOpen(true);
  };

  const canManageDetail = detail !== null && mutation === null;
  const isOwner = canonicalProjectMemberId(members, detail?.ownerId ?? null) === principal.userId;
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
          <button
            aria-current={view === "users" ? "page" : undefined}
            className={`nav-item${view === "users" ? " is-active" : ""}`}
            onClick={() => setView("users")}
            type="button"
          >
            <span className="nav-icon">♙</span>
            <span>用户管理</span>
            <span className="nav-count">{members.length}</span>
          </button>
          {view === "overview" ? (
            <div aria-label="总览日期分页" className="overview-date-nav">
              <div className="overview-date-nav-head">
                <span>按提出日期</span>
                <small>{overviewDateBuckets.length} 天</small>
              </div>
              <button
                aria-current={overviewDate === null ? "page" : undefined}
                className={`overview-date-page${overviewDate === null ? " is-active" : ""}`}
                onClick={() => setOverviewDate(null)}
                type="button"
              >
                <span>全部日期</span>
                <b>{overviewBugCount}</b>
              </button>
              <label className="overview-date-picker">
                <span>选择日期</span>
                <input
                  aria-label="选择总览日期"
                  onChange={(event) => setOverviewDate(event.target.value || null)}
                  type="date"
                  value={overviewDate ?? ""}
                />
              </label>
              <div className="overview-date-pages">
                {overviewDateBuckets.map((bucket) => (
                  <button
                    aria-current={overviewDate === bucket.date ? "page" : undefined}
                    className={`overview-date-page${overviewDate === bucket.date ? " is-active" : ""}`}
                    data-overview-date={bucket.date}
                    key={bucket.date}
                    onClick={() => setOverviewDate(bucket.date)}
                    type="button"
                  >
                    <span>{formatOverviewDateLabel(bucket.date)}</span>
                    <b>{bucket.count}</b>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
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
            <span>
              {view === "workbench"
                ? "工作台"
                : view === "overview"
                  ? `总览 · ${overviewDateLabel}`
                  : "用户管理"}
            </span>
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
          ) : view === "overview" ? (
            <div className="overview-topbar-copy">{overviewDateLabel} · 表格视图</div>
          ) : (
            <div className="overview-topbar-copy">关联重复账号或停用多余用户</div>
          )}
          <button
            aria-label="刷新"
            className="icon-button"
            disabled={refreshing}
            onClick={() => {
              if (view === "workbench") void loadWorkbench(true);
              else if (view === "overview") setOverviewRevision((value) => value + 1);
              else setUserManagementRevision((value) => value + 1);
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
              <div className="hero-actions">
                <button
                  className="secondary-button"
                  onClick={() => void openQingyuImport()}
                  type="button"
                >
                  从轻语导入
                </button>
                <button className="primary-button" onClick={openCreateBug} type="button">
                  <span>＋</span> 新建 Bug
                </button>
              </div>
            </section>

            {error === null ? null : <div className="banner error-banner">{error}</div>}
            {notice === null ? null : <div className="banner success-banner">✓ {notice}</div>}

            <section aria-label="工作统计" className="summary-grid">
              {TASK_STATUS_ORDER.map((value) => (
                <button
                  className={`summary-card${category === value ? " is-selected" : ""}`}
                  key={value}
                  onClick={() => setCategory(value)}
                  type="button"
                >
                  <span className={`summary-icon icon-${value}`}>{taskStatusCopy[value].icon}</span>
                  <span className="summary-value">{counts[value]}</span>
                  <span className="summary-label">{taskStatusCopy[value].label}</span>
                  <small>{taskStatusCopy[value].hint}</small>
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
                  const isAwaitingVerification =
                    taskStatusForBugState(bug.state) === "verification";
                  const actionPersonId = isAwaitingVerification
                    ? bug.verificationOwnerId
                    : bug.ownerId;
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
                            <span>{memberName(bug.verificationOwnerId)} 关闭</span>
                          </span>
                        </span>
                      </span>
                      <span className="person-cell" role="cell">
                        <span className="person-mini">{initials(memberName(actionPersonId))}</span>
                        <span>
                          <strong>{memberName(actionPersonId)}</strong>
                          <small>{isAwaitingVerification ? "关闭人" : "修复人"}</small>
                        </span>
                      </span>
                      <span className={`status-badge state-${bug.state}`} role="cell">
                        {taskStatusLabel(bug.state)}
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
        ) : view === "overview" ? (
          <OverviewPage
            members={members}
            onCreateBug={openCreateBug}
            onDateBucketsChange={updateOverviewDateBuckets}
            onMutated={() => {
              setOverviewRevision((value) => value + 1);
              void loadWorkbench(true, false);
            }}
            onOpenBug={openDetail}
            principal={principal}
            projectId={projectId}
            refreshToken={overviewRevision}
            selectedDate={overviewDate}
          />
        ) : (
          <UserManagementPage
            currentUserId={principal.userId}
            onChanged={() => void loadWorkbench(true, false)}
            projectId={projectId}
            refreshRevision={userManagementRevision}
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
                      {taskStatusLabel(detail.state)}
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
                  {qingyuLink === null ? null : (
                    <section className={`qingyu-link-card sync-${qingyuLink.syncStatus}`}>
                      <div>
                        <strong>
                          轻语 Bug
                          {qingyuLink.defectCode === null ? "" : ` · ${qingyuLink.defectCode}`}
                        </strong>
                        <span>
                          {qingyuLink.syncStatus === "succeeded"
                            ? `已同步为${qingyuLink.externalStatus ?? "已解决"}`
                            : qingyuLink.syncStatus === "failed"
                              ? "上次同步关单失败，本地仍保留为已完成待验收"
                              : "直接关闭时，将同步解决轻语单"}
                        </span>
                      </div>
                      <a href={qingyuLink.defectUrl} rel="noreferrer" target="_blank">
                        打开轻语原单 ↗
                      </a>
                      {qingyuLink.lastSyncErrorMessage === null ? null : (
                        <small>{qingyuLink.lastSyncErrorMessage}</small>
                      )}
                    </section>
                  )}
                  <section className="detail-content-card">
                    <div className="detail-content-label">
                      <strong>Bug 内容</strong>
                      <div>
                        <span>
                          {memberName(detail.reporterId)} · {formatTime(detail.createdAt)}
                        </span>
                        {editingDetail ? null : (
                          <button
                            className="detail-edit-trigger"
                            disabled={mutation !== null || detailLoading}
                            onClick={beginDetailEdit}
                            type="button"
                          >
                            编辑详情
                          </button>
                        )}
                      </div>
                    </div>
                    {editingDetail && detailDraft !== null ? (
                      <form
                        className="detail-edit-form"
                        id="bug-detail-edit-form"
                        onPaste={pasteDetailImages}
                        onSubmit={(event) => void saveBugDetail(event)}
                      >
                        <label>
                          <span>标题</span>
                          <input
                            autoFocus
                            maxLength={300}
                            onChange={(event) =>
                              setDetailDraft((current) =>
                                current === null
                                  ? current
                                  : { ...current, title: event.target.value },
                              )
                            }
                            required
                            value={detailDraft.title}
                          />
                        </label>
                        <label>
                          <span>问题描述</span>
                          <textarea
                            maxLength={20000}
                            onChange={(event) =>
                              setDetailDraft((current) =>
                                current === null
                                  ? current
                                  : { ...current, description: event.target.value },
                              )
                            }
                            required
                            rows={6}
                            value={detailDraft.description}
                          />
                        </label>
                        <label>
                          <span>预期行为</span>
                          <textarea
                            maxLength={10000}
                            onChange={(event) =>
                              setDetailDraft((current) =>
                                current === null
                                  ? current
                                  : { ...current, expectedBehavior: event.target.value },
                              )
                            }
                            required
                            rows={3}
                            value={detailDraft.expectedBehavior}
                          />
                        </label>
                        <div className="detail-edit-selects">
                          <label>
                            <span>模块</span>
                            <select
                              onChange={(event) =>
                                setDetailDraft((current) =>
                                  current === null
                                    ? current
                                    : { ...current, moduleId: event.target.value || null },
                                )
                              }
                              value={detailDraft.moduleId ?? ""}
                            >
                              <option value="">未设置</option>
                              {modules.map((module) => (
                                <option key={module.id} value={module.id}>
                                  {module.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>严重程度</span>
                            <select
                              onChange={(event) =>
                                setDetailDraft((current) =>
                                  current === null
                                    ? current
                                    : {
                                        ...current,
                                        severity: event.target.value as BugSeverity,
                                      },
                                )
                              }
                              value={detailDraft.severity}
                            >
                              {(["S0", "S1", "S2", "S3", "S4"] as const).map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>优先级</span>
                            <select
                              onChange={(event) =>
                                setDetailDraft((current) =>
                                  current === null
                                    ? current
                                    : {
                                        ...current,
                                        priority: event.target.value as BugPriority,
                                      },
                                )
                              }
                              value={detailDraft.priority}
                            >
                              {(["P0", "P1", "P2", "P3", "P4"] as const).map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label className="detail-edit-attachments">
                          <span>添加截图 / 标注图</span>
                          <input
                            accept="image/png,image/jpeg,image/webp"
                            multiple
                            onChange={(event) => {
                              appendDetailFiles([...(event.target.files ?? [])]);
                              event.currentTarget.value = "";
                            }}
                            type="file"
                          />
                          <small aria-live="polite">
                            {detailNewFiles.length === 0
                              ? "可选择图片，或在编辑区域按 Ctrl+V 直接粘贴"
                              : `待添加 ${detailNewFiles.length} 张图片；还可以继续选择或 Ctrl+V 粘贴`}
                          </small>
                        </label>
                        {detailNewFilePreviews.length === 0 ? null : (
                          <div aria-label="编辑详情待上传图片" className="create-image-previews">
                            {detailNewFilePreviews.map((preview) => (
                              <figure key={preview.key}>
                                <img alt={preview.file.name} src={preview.url} />
                                <figcaption>{preview.file.name}</figcaption>
                                <button
                                  aria-label={`移除图片 ${preview.file.name}`}
                                  onClick={() =>
                                    setDetailNewFiles((current) =>
                                      current.filter((file) => file !== preview.file),
                                    )
                                  }
                                  type="button"
                                >
                                  ×
                                </button>
                              </figure>
                            ))}
                          </div>
                        )}
                        {detailEditError === null ? null : (
                          <p className="detail-edit-error" role="alert">
                            {detailEditError}
                          </p>
                        )}
                      </form>
                    ) : (
                      <div className="detail-content-view">
                        <h2>{detail.title}</h2>
                        <p>{detail.description}</p>
                        <div className="detail-expectation">
                          <strong>预期行为</strong>
                          <p>{detail.expectedBehavior}</p>
                        </div>
                        <div className="detail-facts" aria-label="Bug 分类信息">
                          <span>严重程度 {detail.severity}</span>
                          <span>优先级 {detail.priority}</span>
                          <span>
                            模块{" "}
                            {modules.find((module) => module.id === detail.moduleId)?.name ??
                              "未设置"}
                          </span>
                        </div>
                      </div>
                    )}
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
                        <span>{taskStatusLabel(detail.state)}</span>
                      </div>
                      <div className="flow">
                        {TASK_STATUS_ORDER.map((status, index) => {
                          const activeIndex = TASK_STATUS_ORDER.indexOf(
                            taskStatusForBugState(detail.state),
                          );
                          return (
                            <span
                              className={`flow-step${index < activeIndex ? " is-done" : index === activeIndex ? " is-active" : ""}`}
                              key={status}
                            >
                              <i />
                              {taskStatusCopy[status].label}
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
                        <span>关闭人</span>
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
                  {editingDetail && detailDraft !== null ? (
                    <>
                      <p className="action-note action-note-left">正在编辑 Bug 详情</p>
                      <button
                        className="secondary-button"
                        disabled={mutation !== null}
                        onClick={cancelDetailEdit}
                        type="button"
                      >
                        取消
                      </button>
                      <button
                        className="primary-button wide"
                        disabled={
                          !canSaveBugDetailDraft(
                            detailDraft,
                            detail,
                            mutation,
                            detailEditVersionConflict,
                            detailNewFiles.length,
                          )
                        }
                        form="bug-detail-edit-form"
                        type="submit"
                      >
                        {mutation === null ? "保存修改" : "正在保存…"}
                      </button>
                    </>
                  ) : (
                    <>
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
                              await startHumanRepairAttempt(
                                repairAttempt.id,
                                repairAttempt.version,
                              );
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
                      {canReturnCompletedBug(
                        detail.state,
                        repairAttempt !== null,
                        verification?.status ?? null,
                      ) ? (
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
                            验收不通过，打回待处理
                          </button>
                        </>
                      ) : null}
                      {canCompleteDeliveredTask(detail.state, repairAttempt?.status ?? null) ? (
                        <button
                          className="primary-button wide"
                          disabled={mutation !== null}
                          onClick={() => void completeDeliveredWork()}
                          type="button"
                        >
                          已完成
                        </button>
                      ) : null}
                      {canDirectCloseBug(
                        detail.state,
                        repairAttempt !== null,
                        verification?.status ?? null,
                      ) ? (
                        <button
                          className="primary-button wide"
                          disabled={mutation !== null}
                          onClick={() => void acceptBug()}
                          type="button"
                        >
                          {qingyuLink === null ? "直接关闭" : "关闭并同步轻语"}
                        </button>
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
                        <p className="action-note action-note-left">这条 Bug 已验收并关闭。</p>
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
                      <button
                        className="danger-button"
                        disabled={mutation !== null}
                        onClick={() => void deleteSelectedBug()}
                        type="button"
                      >
                        删除 Bug
                      </button>
                    </>
                  )}
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

      {qingyuOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-label="从轻语导入 Bug"
            aria-modal="true"
            className="create-modal qingyu-modal"
            role="dialog"
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">仅导入当前轻语账号负责的单</p>
                <h2>从轻语导入 Bug</h2>
              </div>
              <button
                onClick={() => {
                  setQingyuOpen(false);
                  setQingyuSelectedDefectIds([]);
                }}
                type="button"
              >
                ×
              </button>
            </div>
            {qingyuError === null ? null : <div className="banner error-banner">{qingyuError}</div>}
            {qingyuSession?.authenticated ? (
              <>
                <div className="qingyu-connected">
                  <div>
                    <span>已连接轻语账号</span>
                    <strong>{qingyuSession.user?.name ?? "未知账号"}</strong>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={qingyuBusy}
                    onClick={() => void disconnectQingyu()}
                    type="button"
                  >
                    断开连接
                  </button>
                </div>
                <label>
                  轻语项目
                  <select
                    disabled={qingyuBusy}
                    onChange={(event) => {
                      const nextProjectId = event.target.value;
                      setQingyuProjectId(nextProjectId);
                      setQingyuSelectedDefectIds([]);
                      setQingyuBusy(true);
                      setQingyuError(null);
                      void loadQingyuDefects(nextProjectId)
                        .catch((cause: unknown) => setQingyuError(messageFor(cause)))
                        .finally(() => setQingyuBusy(false));
                    }}
                    value={qingyuProjectId}
                  >
                    {qingyuProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="qingyu-import-summary">
                  <div className="qingyu-import-counts">
                    <strong>我的可处理 Bug</strong>
                    <span>
                      {qingyuSelectableDefectIds.length} 条待导入 ·{" "}
                      {qingyuDefects.filter((defect) => defect.importedBugId !== null).length}{" "}
                      条已在 QA Hub
                    </span>
                  </div>
                  <div className="qingyu-selection-actions">
                    <strong>已选择 {qingyuSelectedDefectIds.length} 条</strong>
                    <button
                      className="secondary-button"
                      disabled={
                        qingyuBusy ||
                        qingyuSelectableDefectIds.length === 0 ||
                        qingyuSelectedDefectIds.length === qingyuSelectableDefectIds.length
                      }
                      onClick={() => setQingyuSelectedDefectIds(qingyuSelectableDefectIds)}
                      type="button"
                    >
                      全选可导入
                    </button>
                    <button
                      className="secondary-button"
                      disabled={qingyuBusy || qingyuSelectedDefectIds.length === 0}
                      onClick={() => setQingyuSelectedDefectIds([])}
                      type="button"
                    >
                      清空
                    </button>
                  </div>
                </div>
                <div className="qingyu-defect-list">
                  {qingyuBusy && qingyuDefects.length === 0 ? <p>正在读取轻语 Bug…</p> : null}
                  {!qingyuBusy && qingyuDefects.length === 0 ? (
                    <p>这个项目下没有分配给你的 Bug。</p>
                  ) : null}
                  {qingyuDefects.map((defect) => {
                    const selectable = defect.actionable && defect.importedBugId === null;
                    const selected = qingyuSelectedDefectIdSet.has(defect.id);
                    return (
                      <article
                        className={selected ? "is-selected" : selectable ? "" : "is-muted"}
                        key={defect.id}
                      >
                        <label className="qingyu-defect-select">
                          <input
                            aria-label={`选择 ${
                              defect.code === null ? defect.title : `${defect.code} ${defect.title}`
                            }`}
                            checked={selected}
                            disabled={qingyuBusy || !selectable}
                            onChange={(event) =>
                              setQingyuSelectedDefectIds((current) =>
                                updateQingyuDefectSelection(
                                  current,
                                  defect.id,
                                  event.target.checked,
                                ),
                              )
                            }
                            type="checkbox"
                          />
                          <div className="qingyu-defect-copy">
                            <strong>
                              {defect.code === null
                                ? defect.title
                                : `${defect.code} · ${defect.title}`}
                            </strong>
                            <span>
                              {[defect.status, defect.priority, defect.severity]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </div>
                        </label>
                        <em>
                          {defect.importedBugId !== null
                            ? "已导入"
                            : defect.actionable
                              ? selected
                                ? "已选择"
                                : "待选择"
                              : "已结束"}
                        </em>
                      </article>
                    );
                  })}
                </div>
                <div className="modal-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setQingyuOpen(false);
                      setQingyuSelectedDefectIds([]);
                    }}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      qingyuBusy ||
                      qingyuProjectId.length === 0 ||
                      qingyuSelectedDefectIds.length === 0
                    }
                    onClick={() => void importQingyuBugs()}
                    type="button"
                  >
                    {qingyuBusy ? "正在导入…" : `导入已选 ${qingyuSelectedDefectIds.length} 条`}
                  </button>
                </div>
              </>
            ) : (
              <div className="qingyu-login-panel">
                {qingyuSession?.login === null || qingyuSession === null ? (
                  <p>{qingyuBusy ? "正在生成轻语二维码…" : "需要扫码连接轻语账号。"}</p>
                ) : (
                  <>
                    <QRCodeSVG
                      bgColor="#ffffff"
                      fgColor="#15201b"
                      level="M"
                      marginSize={2}
                      size={220}
                      value={qingyuSession.login.qrContent}
                    />
                    <strong>
                      {qingyuSession.login.status === "scanned"
                        ? "已扫码，请在轻语 APP 中确认"
                        : "请使用轻语 APP 扫码登录"}
                    </strong>
                    <small>
                      二维码和登录令牌只在本机 QA Hub 宿主中处理，不会返回给其他客户端。
                    </small>
                  </>
                )}
                <button
                  className="secondary-button"
                  disabled={qingyuBusy}
                  onClick={() => void restartQingyuLogin()}
                  type="button"
                >
                  重新生成二维码
                </button>
              </div>
            )}
          </section>
        </div>
      ) : null}

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
                关闭人
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
                disabled={!canSubmitNewBug(mutation, newVerifierId)}
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
