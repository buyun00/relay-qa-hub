import { useCallback, useEffect, useRef, useState } from "react";

import {
  addBugComment,
  createHumanRepairAttempt,
  createRelayAttempt,
  createVerification,
  deliverHumanRepairAttempt,
  dispatchRelay,
  getBug,
  getBuild,
  getHumanRepairAttempt,
  getRelayReceipt,
  getVerification,
  linkBuildRepair,
  listBugEvents,
  listBugs,
  QaHubApiError,
  recordVerificationPassed,
  registerManualBuild,
  startHumanRepairAttempt,
  startVerification,
  transitionBugReady,
  updateBugOwner,
  type BugDetail,
  type BugEvent,
  type BugListFilters,
  type BugListItem,
  type BugListState,
  type BugSeverity,
  type HumanRepairAttempt,
  type LinkBuildRepairResponse,
  type RelayReceipt,
  type VerificationRecord,
} from "./api";
import { product } from "./product";

const DEFAULT_PROJECT_ID =
  import.meta.env.VITE_QA_HUB_PROJECT_ID ?? "10000000-0000-4000-8000-000000000004";
const INVALID_PROJECT_ID = "10000000-0000-4000-8000-000000000099";
const MISSING_BUG_ID = "20000000-0000-4000-8000-000000000099";
const MVP_OWNER_ID = "10000000-0000-4000-8000-000000000003";
const BUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

interface DesktopBridgeWindow extends Window {
  readonly qaHubDesktop?: {
    readonly onOpenBug: (listener: (bugId: string) => void) => () => void;
  };
}

function bugIdFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("bug");
  return value !== null && BUG_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

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

type RequestState = "idle" | "loading" | "success" | "error";
type MutationState = "idle" | "submitting" | "success" | "error";

function mutationError(cause: unknown): { readonly status: number; readonly code: string | null } {
  if (cause instanceof QaHubApiError) return { status: cause.status, code: cause.code };
  return { status: 0, code: "NETWORK_ERROR" };
}

function mutationErrorMessage(error: { readonly status: number; readonly code: string | null }) {
  if (error.code === "VERSION_CONFLICT" || error.status === 412) {
    return "版本冲突：Bug 已被其他操作更新，请重新读取后再提交。";
  }
  return `请求失败：HTTP ${error.status === 0 ? "网络不可达" : error.status}${
    error.code === null ? "" : ` · ${error.code}`
  }。`;
}

export default function App() {
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT_ID);
  const [bugQuery, setBugQuery] = useState("");
  const [bugStateFilter, setBugStateFilter] = useState<BugListState | "">("");
  const [bugSeverityFilter, setBugSeverityFilter] = useState<BugSeverity | "">("");
  const [bugs, setBugs] = useState<readonly BugListItem[]>([]);
  const [snapshotSequence, setSnapshotSequence] = useState<number | null>(null);
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [error, setError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [selectedBugId, setSelectedBugId] = useState<string | null>(null);
  const [selectedBug, setSelectedBug] = useState<BugDetail | null>(null);
  const [timeline, setTimeline] = useState<readonly BugEvent[]>([]);
  const [detailState, setDetailState] = useState<RequestState>("idle");
  const [detailError, setDetailError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentState, setCommentState] = useState<"idle" | "submitting" | "success" | "error">(
    "idle",
  );
  const [commentId, setCommentId] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [ownerSelection, setOwnerSelection] = useState("");
  const [assignmentState, setAssignmentState] = useState<MutationState>("idle");
  const [assignmentError, setAssignmentError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [transitionState, setTransitionState] = useState<MutationState>("idle");
  const [transitionError, setTransitionError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [relayState, setRelayState] = useState<MutationState>("idle");
  const [relayReceipt, setRelayReceipt] = useState<RelayReceipt | null>(null);
  const [relayError, setRelayError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [humanAttempt, setHumanAttempt] = useState<HumanRepairAttempt | null>(null);
  const [linkedBuild, setLinkedBuild] = useState<LinkBuildRepairResponse | null>(null);
  const [verification, setVerification] = useState<VerificationRecord | null>(null);
  const [humanWorkflowState, setHumanWorkflowState] = useState<MutationState>("idle");
  const [humanWorkflowError, setHumanWorkflowError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [humanWorkflowMessage, setHumanWorkflowMessage] = useState<string | null>(null);
  const [repairSummary, setRepairSummary] = useState("");
  const [repairBranch, setRepairBranch] = useState("");
  const [repairCommitSha, setRepairCommitSha] = useState("");
  const [buildExternalId, setBuildExternalId] = useState("");
  const [buildVersion, setBuildVersion] = useState("0.1.0-debug");
  const [buildDownloadUrl, setBuildDownloadUrl] = useState("");
  const [buildArtifactSha256, setBuildArtifactSha256] = useState("");
  const [buildCommitSha, setBuildCommitSha] = useState("");
  const [verificationCriteria, setVerificationCriteria] = useState("");
  const [verificationResultSummary, setVerificationResultSummary] = useState("");
  const listRequestSequence = useRef(0);

  const loadBugList = useCallback(
    async (nextProjectId: string, filters: BugListFilters = {}): Promise<void> => {
      const requestSequence = listRequestSequence.current + 1;
      listRequestSequence.current = requestSequence;
      const normalizedProjectId = nextProjectId.trim();
      setProjectId(normalizedProjectId);
      setRequestState("loading");
      setError(null);
      try {
        const response = await listBugs(normalizedProjectId, filters);
        if (listRequestSequence.current !== requestSequence) return;
        setBugs(response.items);
        setSnapshotSequence(response.snapshotSequence);
        setRequestState("success");
      } catch (cause: unknown) {
        if (listRequestSequence.current !== requestSequence) return;
        setBugs([]);
        setSnapshotSequence(null);
        setRequestState("error");
        if (cause instanceof QaHubApiError) {
          setError({ status: cause.status, code: cause.code });
        } else {
          setError({ status: 0, code: "NETWORK_ERROR" });
        }
      }
    },
    [],
  );

  const refreshVisibleBugList = useCallback(async (): Promise<void> => {
    await loadBugList(projectId, {
      ...(bugQuery.trim().length === 0 ? {} : { q: bugQuery.trim() }),
      ...(bugStateFilter === "" ? {} : { state: bugStateFilter }),
      ...(bugSeverityFilter === "" ? {} : { severity: bugSeverityFilter }),
    });
  }, [bugQuery, bugSeverityFilter, bugStateFilter, loadBugList, projectId]);

  const loadBugDetails = useCallback(
    async (
      bugId: string,
      preserveComment = false,
      preserveRelay = false,
      preserveHuman = false,
    ): Promise<{ readonly bug: BugDetail; readonly events: readonly BugEvent[] } | null> => {
      setSelectedBugId(bugId);
      setSelectedBug(null);
      setTimeline([]);
      setDetailState("loading");
      setDetailError(null);
      if (!preserveComment) {
        setCommentId(null);
        setCommentState("idle");
        setCommentError(null);
      }
      if (!preserveRelay) {
        setRelayState("idle");
        setRelayReceipt(null);
        setRelayError(null);
      }
      if (!preserveHuman) {
        setHumanAttempt(null);
        setLinkedBuild(null);
        setVerification(null);
        setHumanWorkflowState("idle");
        setHumanWorkflowError(null);
        setHumanWorkflowMessage(null);
        setRepairSummary("");
        setRepairBranch("");
        setRepairCommitSha("");
        setBuildExternalId("");
        setBuildVersion("0.1.0-debug");
        setBuildDownloadUrl("");
        setBuildArtifactSha256("");
        setBuildCommitSha("");
        setVerificationCriteria("");
        setVerificationResultSummary("");
      }
      try {
        const [bug, events] = await Promise.all([getBug(bugId), listBugEvents(bugId)]);
        setSelectedBug(bug);
        setOwnerSelection(bug.ownerId ?? "");
        setTimeline(events.items);
        setDetailState("success");
        return { bug, events: events.items };
      } catch (cause: unknown) {
        setDetailState("error");
        if (cause instanceof QaHubApiError) {
          setDetailError({ status: cause.status, code: cause.code });
        } else {
          setDetailError({ status: 0, code: "NETWORK_ERROR" });
        }
        return null;
      }
    },
    [],
  );

  const assignOwner = useCallback(async (): Promise<void> => {
    if (selectedBug === null) return;
    const nextOwnerId = ownerSelection.length === 0 ? null : ownerSelection;
    setAssignmentState("submitting");
    setAssignmentError(null);
    try {
      await updateBugOwner(selectedBug.id, selectedBug.version, nextOwnerId);
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true);
      if (refreshed?.bug.ownerId === nextOwnerId) {
        setAssignmentState("success");
      } else {
        setAssignmentState("error");
        setAssignmentError({ status: 200, code: "OWNER_READBACK_MISMATCH" });
      }
    } catch (cause: unknown) {
      setAssignmentState("error");
      setAssignmentError(mutationError(cause));
    }
  }, [loadBugDetails, ownerSelection, selectedBug]);

  const markReady = useCallback(async (): Promise<void> => {
    if (selectedBug === null || selectedBug.state !== "reported") return;
    setTransitionState("submitting");
    setTransitionError(null);
    try {
      await transitionBugReady(selectedBug.id, selectedBug.version);
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true);
      if (refreshed?.bug.state === "ready") {
        setTransitionState("success");
        await refreshVisibleBugList();
      } else {
        setTransitionState("error");
        setTransitionError({ status: 200, code: "STATE_READBACK_MISMATCH" });
      }
    } catch (cause: unknown) {
      setTransitionState("error");
      setTransitionError(mutationError(cause));
    }
  }, [loadBugDetails, refreshVisibleBugList, selectedBug]);

  const submitComment = useCallback(async (): Promise<void> => {
    if (selectedBugId === null || commentBody.trim().length === 0) return;
    const clientSubmissionId = globalThis.crypto.randomUUID();
    setCommentState("submitting");
    setCommentError(null);
    try {
      const result = await addBugComment(selectedBugId, commentBody.trim(), clientSubmissionId);
      setCommentBody("");
      setCommentId(result.comment.id);
      const refreshed = await loadBugDetails(selectedBugId, true, true, true);
      const eventConfirmed =
        refreshed?.events.some(
          (event) =>
            event.type === "comment.created" && event.payload.commentId === result.comment.id,
        ) === true;
      if (eventConfirmed) {
        setCommentState("success");
      } else {
        setCommentState("error");
        setCommentError({ status: 200, code: "COMMENT_EVENT_MISSING" });
      }
    } catch (cause: unknown) {
      setCommentState("error");
      if (cause instanceof QaHubApiError) {
        setCommentError({ status: cause.status, code: cause.code });
      } else {
        setCommentError({ status: 0, code: "NETWORK_ERROR" });
      }
    }
  }, [commentBody, loadBugDetails, selectedBugId]);

  const readRelayReceipt = useCallback(async (attemptId: string): Promise<RelayReceipt> => {
    let receipt = await getRelayReceipt(attemptId);
    for (let poll = 0; poll < 10 && receipt.handoffStatus === "queued"; poll += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      receipt = await getRelayReceipt(attemptId);
    }
    return receipt;
  }, []);

  const handoffToRelay = useCallback(async (): Promise<void> => {
    if (selectedBug === null || selectedBug.state !== "ready") return;
    setRelayState("submitting");
    setRelayReceipt(null);
    setRelayError(null);
    try {
      const attempt = await createRelayAttempt(selectedBug.id, selectedBug.version, MVP_OWNER_ID);
      const handoffId = globalThis.crypto.randomUUID();
      const accepted = await dispatchRelay(attempt.id, attempt.version, handoffId);
      const receipt = await readRelayReceipt(attempt.id);
      if (
        accepted.qaItem.id !== selectedBug.id ||
        receipt.qaItem.id !== selectedBug.id ||
        receipt.repairAttemptId !== attempt.id ||
        receipt.handoffId !== handoffId ||
        receipt.requiresHumanVerification !== true ||
        receipt.automationAuthority !== "delivery_build_projection_only"
      ) {
        setRelayState("error");
        setRelayError({ status: 200, code: "RELAY_RECEIPT_MISMATCH" });
        return;
      }
      setRelayReceipt(receipt);
      setRelayState("success");
      await loadBugDetails(selectedBug.id, true, true, true);
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      setRelayState("error");
      setRelayError(mutationError(cause));
    }
  }, [loadBugDetails, readRelayReceipt, refreshVisibleBugList, selectedBug]);

  const refreshRelayReceipt = useCallback(async (): Promise<void> => {
    if (relayReceipt === null) return;
    setRelayState("submitting");
    setRelayError(null);
    try {
      const receipt = await readRelayReceipt(relayReceipt.repairAttemptId);
      setRelayReceipt(receipt);
      setRelayState("success");
    } catch (cause: unknown) {
      setRelayState("error");
      setRelayError(mutationError(cause));
    }
  }, [readRelayReceipt, relayReceipt]);

  const createHumanWorkflow = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      selectedBug.state !== "ready" ||
      repairSummary.trim().length === 0
    ) {
      return;
    }
    setHumanWorkflowState("submitting");
    setHumanWorkflowError(null);
    setHumanWorkflowMessage(null);
    try {
      const created = await createHumanRepairAttempt(
        selectedBug.id,
        selectedBug.version,
        MVP_OWNER_ID,
        repairSummary.trim(),
      );
      const readback = await getHumanRepairAttempt(created.id);
      if (
        readback.id !== created.id ||
        readback.bugId !== selectedBug.id ||
        readback.mode !== "human" ||
        readback.status !== "planned"
      ) {
        setHumanWorkflowState("error");
        setHumanWorkflowError({ status: 200, code: "REPAIR_ATTEMPT_READBACK_MISMATCH" });
        return;
      }
      setHumanAttempt(readback);
      setHumanWorkflowMessage(`人工 RepairAttempt 已创建：${readback.id}`);
      setHumanWorkflowState("success");
      await loadBugDetails(selectedBug.id, true, true, true);
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [loadBugDetails, refreshVisibleBugList, repairSummary, selectedBug]);

  const deliverHumanWorkflow = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      humanAttempt === null ||
      humanAttempt.status !== "planned" ||
      repairSummary.trim().length === 0 ||
      repairBranch.trim().length === 0 ||
      !COMMIT_SHA_PATTERN.test(repairCommitSha.trim())
    ) {
      return;
    }
    setHumanWorkflowState("submitting");
    setHumanWorkflowError(null);
    setHumanWorkflowMessage(null);
    try {
      const started = await startHumanRepairAttempt(humanAttempt.id, humanAttempt.version);
      const delivered = await deliverHumanRepairAttempt(
        started.id,
        started.version,
        repairSummary.trim(),
        repairBranch.trim(),
        repairCommitSha.trim(),
      );
      const readback = await getHumanRepairAttempt(delivered.id);
      if (
        readback.status !== "delivered" ||
        readback.branch !== repairBranch.trim() ||
        readback.commitSha !== repairCommitSha.trim()
      ) {
        setHumanWorkflowState("error");
        setHumanWorkflowError({ status: 200, code: "CODE_DELIVERY_READBACK_MISMATCH" });
        return;
      }
      setHumanAttempt(readback);
      setBuildCommitSha(readback.commitSha ?? "");
      setHumanWorkflowMessage(`代码交付已登记：${readback.commitSha}`);
      setHumanWorkflowState("success");
      await loadBugDetails(selectedBug.id, true, true, true);
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    humanAttempt,
    loadBugDetails,
    refreshVisibleBugList,
    repairBranch,
    repairCommitSha,
    repairSummary,
    selectedBug,
  ]);

  const registerAndLinkBuild = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      selectedBug.state !== "awaiting_build" ||
      humanAttempt === null ||
      humanAttempt.status !== "delivered" ||
      humanAttempt.branch === null ||
      humanAttempt.commitSha === null ||
      buildExternalId.trim().length === 0 ||
      buildVersion.trim().length === 0 ||
      buildDownloadUrl.trim().length === 0 ||
      !COMMIT_SHA_PATTERN.test(buildCommitSha.trim()) ||
      !SHA256_PATTERN.test(buildArtifactSha256.trim())
    ) {
      return;
    }
    setHumanWorkflowState("submitting");
    setHumanWorkflowError(null);
    setHumanWorkflowMessage(null);
    try {
      const registered = await registerManualBuild({
        projectId: selectedBug.projectId,
        externalId: buildExternalId.trim(),
        version: buildVersion.trim(),
        branch: humanAttempt.branch,
        sourceCommitSha: buildCommitSha.trim(),
        downloadUrl: buildDownloadUrl.trim(),
        artifactSha256: buildArtifactSha256.trim(),
        repairAttemptId: humanAttempt.id,
      });
      const buildReadback = await getBuild(registered.build.id);
      if (
        buildReadback.id !== registered.build.id ||
        buildReadback.status !== "ready" ||
        buildReadback.sourceCommitSha !== buildCommitSha.trim()
      ) {
        setHumanWorkflowState("error");
        setHumanWorkflowError({ status: 200, code: "BUILD_READBACK_MISMATCH" });
        return;
      }
      const linked = await linkBuildRepair({
        buildId: buildReadback.id,
        expectedBuildVersion: buildReadback.version,
        expectedBugVersion: selectedBug.version,
        repairAttemptId: humanAttempt.id,
        deliveredCommitSha: humanAttempt.commitSha,
      });
      if (
        linked.bug.id !== selectedBug.id ||
        linked.bug.state !== "ready_for_verification" ||
        linked.repairLink.buildId !== buildReadback.id ||
        linked.repairLink.deliveredCommitSha !== humanAttempt.commitSha
      ) {
        setHumanWorkflowState("error");
        setHumanWorkflowError({ status: 200, code: "BUILD_LINK_READBACK_MISMATCH" });
        return;
      }
      setLinkedBuild(linked);
      setHumanWorkflowMessage(`Build 已精确关联：${linked.build.externalId}`);
      setHumanWorkflowState("success");
      await loadBugDetails(selectedBug.id, true, true, true);
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    buildArtifactSha256,
    buildCommitSha,
    buildDownloadUrl,
    buildExternalId,
    buildVersion,
    humanAttempt,
    loadBugDetails,
    refreshVisibleBugList,
    selectedBug,
  ]);

  const beginVerification = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      selectedBug.state !== "ready_for_verification" ||
      humanAttempt === null ||
      humanAttempt.status !== "delivered" ||
      linkedBuild === null ||
      verificationCriteria.trim().length === 0
    ) {
      return;
    }
    setHumanWorkflowState("submitting");
    setHumanWorkflowError(null);
    setHumanWorkflowMessage(null);
    try {
      const created = await createVerification({
        bugId: selectedBug.id,
        expectedBugVersion: selectedBug.version,
        repairAttemptId: humanAttempt.id,
        buildId: linkedBuild.build.id,
        verifierId: MVP_OWNER_ID,
        criteria: verificationCriteria.trim(),
      });
      const started = await startVerification(created.id, created.version);
      const readback = await getVerification(started.id);
      if (
        readback.status !== "in_progress" ||
        readback.bugId !== selectedBug.id ||
        readback.buildId !== linkedBuild.build.id
      ) {
        setHumanWorkflowState("error");
        setHumanWorkflowError({ status: 200, code: "VERIFICATION_READBACK_MISMATCH" });
        return;
      }
      setVerification(readback);
      setHumanWorkflowMessage(`人工验收已开始：${readback.id}`);
      setHumanWorkflowState("success");
      await loadBugDetails(selectedBug.id, true, true, true);
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    humanAttempt,
    linkedBuild,
    loadBugDetails,
    refreshVisibleBugList,
    selectedBug,
    verificationCriteria,
  ]);

  const passVerificationAndClose = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      verification === null ||
      verification.status !== "in_progress" ||
      verificationResultSummary.trim().length === 0
    ) {
      return;
    }
    setHumanWorkflowState("submitting");
    setHumanWorkflowError(null);
    setHumanWorkflowMessage(null);
    try {
      const result = await recordVerificationPassed(
        verification.id,
        verification.version,
        verificationResultSummary.trim(),
        globalThis.crypto.randomUUID(),
      );
      if (
        result.qaItem.id !== selectedBug.id ||
        result.verification.id !== verification.id ||
        result.verification.status !== "passed" ||
        result.bug.state !== "closed"
      ) {
        setHumanWorkflowState("error");
        setHumanWorkflowError({ status: 200, code: "VERIFICATION_RESULT_READBACK_MISMATCH" });
        return;
      }
      setVerification(result.verification);
      setHumanWorkflowMessage(`人工验收通过，${result.bug.key} 已由 QA Hub 关闭。`);
      setHumanWorkflowState("success");
      await loadBugDetails(selectedBug.id, true, true, true);
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [loadBugDetails, refreshVisibleBugList, selectedBug, verification, verificationResultSummary]);

  useEffect(() => {
    void loadBugList(DEFAULT_PROJECT_ID);
  }, [loadBugList]);

  useEffect(() => {
    const openDeepLink = (): void => {
      const bugId = bugIdFromHash(window.location.hash);
      if (bugId !== null) void loadBugDetails(bugId);
    };
    const unsubscribeDesktop = (window as DesktopBridgeWindow).qaHubDesktop?.onOpenBug((bugId) => {
      const nextHash = `#bug=${encodeURIComponent(bugId)}`;
      if (window.location.hash === nextHash) {
        void loadBugDetails(bugId);
      } else {
        window.location.hash = nextHash;
      }
    });
    openDeepLink();
    window.addEventListener("hashchange", openDeepLink);
    return () => {
      window.removeEventListener("hashchange", openDeepLink);
      unsubscribeDesktop?.();
    };
  }, [loadBugDetails]);

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="brand-row">
          <span className="brand-icon">
            <BrandMark />
          </span>
          <div>
            <p className="eyebrow">桌面管理平台 · 独立 QA 事实源</p>
            <h1>{product.name}</h1>
          </div>
        </div>
        <p className="hero__summary">
          Bug、证据、交付与人工验收全部由 QA Hub API/DB 统一保存；Relay 只是可选执行器。
        </p>
        <span className="skeleton-badge">Web 管理台 · 真实 API</span>
      </header>

      <section aria-labelledby="boundary-title" className="boundary-card">
        <div>
          <p className="card-kicker">产品边界</p>
          <h2 id="boundary-title">Relay（可选执行器）</h2>
        </div>
        <p>Relay 只可标记修复交付、待构建或待验收，不能验收或关闭 QA Bug。</p>
      </section>

      <section aria-labelledby="bug-list-title" className="workspace-card">
        <div className="section-heading">
          <div>
            <p className="card-kicker">真实 QA Hub API</p>
            <h2 id="bug-list-title">Bug 列表</h2>
          </div>
          <span className={`status-dot status-dot--${requestState}`}>
            {requestState === "loading"
              ? "读取中"
              : requestState === "error"
                ? "API 错误"
                : "已连接"}
          </span>
        </div>

        <form
          className="project-form"
          onSubmit={(event) => {
            event.preventDefault();
            void refreshVisibleBugList();
          }}
        >
          <label htmlFor="project-id">项目 ID</label>
          <div className="project-form__controls">
            <input
              id="project-id"
              onChange={(event) => setProjectId(event.target.value)}
              spellCheck={false}
              value={projectId}
            />
            <button
              className="primary-button"
              disabled={requestState === "loading"}
              id="bug-filter-submit"
              type="submit"
            >
              应用筛选
            </button>
          </div>
          <div className="filter-grid">
            <div>
              <label htmlFor="bug-search">关键词（编号、标题、描述）</label>
              <input
                id="bug-search"
                maxLength={200}
                onChange={(event) => setBugQuery(event.target.value)}
                placeholder="例如 LOCAL-1 或 login"
                value={bugQuery}
              />
            </div>
            <div>
              <label htmlFor="bug-state-filter">状态</label>
              <select
                id="bug-state-filter"
                onChange={(event) => setBugStateFilter(event.target.value as BugListState | "")}
                value={bugStateFilter}
              >
                <option value="">全部状态</option>
                <option value="reported">reported</option>
                <option value="needs_info">needs_info</option>
                <option value="ready">ready</option>
                <option value="in_progress">in_progress</option>
                <option value="awaiting_build">awaiting_build</option>
                <option value="ready_for_verification">ready_for_verification</option>
                <option value="closed">closed</option>
                <option value="deferred">deferred</option>
                <option value="rejected">rejected</option>
                <option value="duplicate">duplicate</option>
              </select>
            </div>
            <div>
              <label htmlFor="bug-severity-filter">严重度</label>
              <select
                id="bug-severity-filter"
                onChange={(event) => setBugSeverityFilter(event.target.value as BugSeverity | "")}
                value={bugSeverityFilter}
              >
                <option value="">全部严重度</option>
                <option value="S0">S0</option>
                <option value="S1">S1</option>
                <option value="S2">S2</option>
                <option value="S3">S3</option>
                <option value="S4">S4</option>
              </select>
            </div>
          </div>
          <div className="filter-actions">
            <button
              className="link-button"
              id="bug-filter-clear"
              onClick={() => {
                setBugQuery("");
                setBugStateFilter("");
                setBugSeverityFilter("");
                void loadBugList(projectId);
              }}
              type="button"
            >
              清空筛选
            </button>
            <button
              className="link-button"
              onClick={() => void loadBugList(INVALID_PROJECT_ID)}
              type="button"
            >
              验证无效项目错误
            </button>
          </div>
        </form>

        {requestState === "success" &&
          (bugQuery.trim().length > 0 || bugStateFilter !== "" || bugSeverityFilter !== "") && (
            <p className="filter-summary">
              服务端组合筛选：关键词={bugQuery.trim() || "全部"} · 状态=
              {bugStateFilter || "全部"} · 严重度={bugSeverityFilter || "全部"}
            </p>
          )}

        {requestState === "error" && error !== null && (
          <p aria-live="assertive" className="api-error">
            API 请求失败：HTTP {error.status === 0 ? "网络不可达" : error.status}
            {error.code === null ? "" : ` · ${error.code}`}
            。项目权限或参数错误会保留在此处，不会伪造为空列表。
          </p>
        )}

        {requestState === "success" && bugs.length === 0 && (
          <p className="empty-state">
            该项目当前没有符合条件的 Bug（snapshot {snapshotSequence}）。
          </p>
        )}

        {bugs.length > 0 && (
          <div aria-label="真实 Bug 列表" className="bug-list" role="list">
            {bugs.map((bug) => (
              <button
                className={`bug-row${selectedBugId === bug.id ? " bug-row--selected" : ""}`}
                key={bug.id}
                onClick={() => void loadBugDetails(bug.id)}
                type="button"
              >
                <div className="bug-row__heading">
                  <strong>{bug.key}</strong>
                  <span className="bug-state">{bug.state}</span>
                </div>
                <h3>{bug.title}</h3>
                <p>
                  {bug.severity} · {bug.priority} · 更新于{" "}
                  {new Date(bug.updatedAt).toLocaleString()}
                </p>
              </button>
            ))}
          </div>
        )}

        {requestState === "success" && snapshotSequence !== null && (
          <p className="api-footnote">来自 QA Hub SQLite 事实源 · snapshot {snapshotSequence}</p>
        )}

        {selectedBug !== null && !bugs.some((bug) => bug.id === selectedBug.id) && (
          <p className="filter-summary">当前详情位于筛选结果之外；详情事实保持可见。</p>
        )}

        <div aria-label="后续管理台切片" className="next-slices">
          <span>当前段：服务端关键词 / 状态 / 严重度组合筛选</span>
          <span>下一段：去重合并；Windows 桌面打包统一后置</span>
        </div>
      </section>

      <section aria-labelledby="bug-detail-title" className="workspace-card detail-card">
        <div className="section-heading">
          <div>
            <p className="card-kicker">Bug / audit</p>
            <h2 id="bug-detail-title">详情与时间线</h2>
          </div>
          <span className={`status-dot status-dot--${detailState}`}>
            {detailState === "loading"
              ? "读取中"
              : detailState === "error"
                ? "NOT_FOUND / API 错误"
                : "可选"}
          </span>
        </div>

        <button
          className="link-button detail-card__missing"
          onClick={() => void loadBugDetails(MISSING_BUG_ID)}
          type="button"
        >
          验证不存在 Bug（应显示 404 NOT_FOUND）
        </button>

        {detailState === "error" && detailError !== null && (
          <p aria-live="assertive" className="api-error">
            Bug 详情/时间线请求失败：HTTP{" "}
            {detailError.status === 0 ? "网络不可达" : detailError.status}
            {detailError.code === null ? "" : ` · ${detailError.code}`}。
          </p>
        )}

        {selectedBug !== null && detailState === "success" && (
          <>
            <article className="bug-detail">
              <div className="bug-row__heading">
                <strong>{selectedBug.key}</strong>
                <span className="bug-state">{selectedBug.state}</span>
              </div>
              <h3>{selectedBug.title}</h3>
              <dl className="bug-detail__facts">
                <div>
                  <dt>描述</dt>
                  <dd>{selectedBug.description}</dd>
                </div>
                <div>
                  <dt>预期行为</dt>
                  <dd>{selectedBug.expectedBehavior}</dd>
                </div>
                <div>
                  <dt>负责人</dt>
                  <dd>{selectedBug.ownerId ?? "未分配"}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>v{selectedBug.version}</dd>
                </div>
              </dl>
              <div aria-label="Bug 管理操作" className="bug-actions">
                <div className="bug-action">
                  <label htmlFor="bug-owner">负责人</label>
                  <div className="bug-action__controls">
                    <select
                      id="bug-owner"
                      onChange={(event) => setOwnerSelection(event.target.value)}
                      value={ownerSelection}
                    >
                      <option value="">未分配</option>
                      <option value={MVP_OWNER_ID}>QA 值班成员（MVP）</option>
                    </select>
                    <button
                      className="secondary-button"
                      disabled={assignmentState === "submitting"}
                      onClick={() => void assignOwner()}
                      type="button"
                    >
                      {assignmentState === "submitting" ? "保存中" : "保存负责人"}
                    </button>
                  </div>
                  <small>使用当前版本 v{selectedBug.version} 乐观锁提交</small>
                </div>
                <div className="bug-action">
                  <span className="bug-action__label">状态</span>
                  <div className="bug-action__controls">
                    <button
                      className="secondary-button"
                      disabled={
                        transitionState === "submitting" || selectedBug.state !== "reported"
                      }
                      onClick={() => void markReady()}
                      type="button"
                    >
                      {transitionState === "submitting" ? "更新中" : "标记为 ready"}
                    </button>
                    <span className="bug-action__hint">
                      {selectedBug.state === "reported"
                        ? "reported → ready"
                        : `当前为 ${selectedBug.state}`}
                    </span>
                  </div>
                </div>
                <div className="bug-action">
                  <span className="bug-action__label">可选执行器</span>
                  <div className="bug-action__controls">
                    <button
                      className="primary-button"
                      disabled={relayState === "submitting" || selectedBug.state !== "ready"}
                      onClick={() => void handoffToRelay()}
                      type="button"
                    >
                      {relayState === "submitting" ? "交付中" : "一键交给 Relay"}
                    </button>
                    <span className="bug-action__hint">
                      {selectedBug.state === "ready"
                        ? "经 QA Hub 创建 RepairAttempt 并持久派发"
                        : `需处于 ready；当前为 ${selectedBug.state}`}
                    </span>
                  </div>
                </div>
              </div>
              {assignmentState === "success" && (
                <p aria-live="polite" className="success-note">
                  负责人已保存，并已 GET 回读版本/负责人。
                </p>
              )}
              {assignmentState === "error" && assignmentError !== null && (
                <p aria-live="assertive" className="api-error">
                  负责人更新失败：{mutationErrorMessage(assignmentError)}
                </p>
              )}
              {transitionState === "success" && (
                <p aria-live="polite" className="success-note">
                  状态已更新为 ready，并已 GET 回读版本/状态。
                </p>
              )}
              {transitionState === "error" && transitionError !== null && (
                <p aria-live="assertive" className="api-error">
                  状态更新失败：{mutationErrorMessage(transitionError)}
                </p>
              )}
              {relayReceipt !== null && relayState === "success" && (
                <div aria-live="polite" className="relay-receipt">
                  <div className="relay-receipt__heading">
                    <strong>Relay 回执：{relayReceipt.handoffStatus}</strong>
                    <button
                      className="link-button"
                      onClick={() => void refreshRelayReceipt()}
                      type="button"
                    >
                      刷新回执
                    </button>
                  </div>
                  <p>
                    handoff {relayReceipt.handoffId} · task {relayReceipt.relayTaskId ?? "待分配"}
                  </p>
                  <p>
                    {relayReceipt.handoffStatus === "queued"
                      ? "QA Hub 已持久化派发；执行器不可用或尚未接单时由服务端可靠重试。"
                      : "执行器已回执；后续交付仍必须回到 QA Hub，由人工作出验收/关闭决定。"}
                  </p>
                  <strong>仍需人工验收，Relay 无权自动关闭 Bug。</strong>
                </div>
              )}
              {relayState === "error" && relayError !== null && (
                <p aria-live="assertive" className="api-error">
                  Relay 交付/回执失败：{mutationErrorMessage(relayError)}
                </p>
              )}

              <section aria-label="人工修复、Build 与人工验收" className="human-workflow">
                <div className="human-workflow__header">
                  <div>
                    <p className="card-kicker">QA 人工闭环</p>
                    <h3>RepairAttempt → 精确 Build → Verification</h3>
                  </div>
                  <div className="workflow-status">
                    <span>Attempt: {humanAttempt?.status ?? "未创建"}</span>
                    <span>Build: {linkedBuild?.build.status ?? "未关联"}</span>
                    <span>Verification: {verification?.status ?? "未开始"}</span>
                  </div>
                </div>

                <div className="workflow-grid">
                  <div className="workflow-step">
                    <strong>1 · 创建人工 RepairAttempt</strong>
                    <label htmlFor="repair-summary">修复摘要</label>
                    <textarea
                      id="repair-summary"
                      onChange={(event) => setRepairSummary(event.target.value)}
                      placeholder="描述本次人工修复范围"
                      rows={2}
                      value={repairSummary}
                    />
                    <div className="workflow-step__controls">
                      <button
                        className="secondary-button"
                        disabled={
                          humanWorkflowState === "submitting" ||
                          selectedBug.state !== "ready" ||
                          humanAttempt !== null ||
                          repairSummary.trim().length === 0
                        }
                        onClick={() => void createHumanWorkflow()}
                        type="button"
                      >
                        创建人工 RepairAttempt
                      </button>
                      <small>仅 ready Bug 可创建</small>
                    </div>
                  </div>

                  <div className="workflow-step">
                    <strong>2 · 登记代码交付</strong>
                    <label htmlFor="repair-branch">Git 分支</label>
                    <input
                      disabled={humanAttempt?.status === "delivered"}
                      id="repair-branch"
                      onChange={(event) => setRepairBranch(event.target.value)}
                      placeholder="qa/fix-local-1"
                      spellCheck={false}
                      value={repairBranch}
                    />
                    <label htmlFor="repair-commit">交付 commit SHA（40 位小写十六进制）</label>
                    <input
                      disabled={humanAttempt?.status === "delivered"}
                      id="repair-commit"
                      onChange={(event) => setRepairCommitSha(event.target.value)}
                      placeholder="40 位 commit SHA"
                      spellCheck={false}
                      value={repairCommitSha}
                    />
                    <div className="workflow-step__controls">
                      <button
                        className="secondary-button"
                        disabled={
                          humanWorkflowState === "submitting" ||
                          humanAttempt?.status !== "planned" ||
                          repairBranch.trim().length === 0 ||
                          !COMMIT_SHA_PATTERN.test(repairCommitSha.trim())
                        }
                        onClick={() => void deliverHumanWorkflow()}
                        type="button"
                      >
                        开始并登记代码交付
                      </button>
                    </div>
                  </div>

                  <div className="workflow-step workflow-step--wide">
                    <strong>3 · 登记并精确关联 Build</strong>
                    <div className="workflow-fields">
                      <div>
                        <label htmlFor="build-external-id">Build 外部 ID</label>
                        <input
                          id="build-external-id"
                          onChange={(event) => setBuildExternalId(event.target.value)}
                          placeholder="web-smoke-build-001"
                          spellCheck={false}
                          value={buildExternalId}
                        />
                      </div>
                      <div>
                        <label htmlFor="build-version">版本</label>
                        <input
                          id="build-version"
                          onChange={(event) => setBuildVersion(event.target.value)}
                          spellCheck={false}
                          value={buildVersion}
                        />
                      </div>
                      <div>
                        <label htmlFor="build-download-url">下载 URL</label>
                        <input
                          id="build-download-url"
                          onChange={(event) => setBuildDownloadUrl(event.target.value)}
                          placeholder="https://qa-hub.local/builds/001.apk"
                          spellCheck={false}
                          value={buildDownloadUrl}
                        />
                      </div>
                      <div>
                        <label htmlFor="build-source-commit">Build source commit</label>
                        <input
                          id="build-source-commit"
                          onChange={(event) => setBuildCommitSha(event.target.value)}
                          placeholder="必须与交付 commit 精确一致"
                          spellCheck={false}
                          value={buildCommitSha}
                        />
                      </div>
                      <div className="workflow-fields__wide">
                        <label htmlFor="build-artifact-sha">产物 SHA-256</label>
                        <input
                          id="build-artifact-sha"
                          onChange={(event) => setBuildArtifactSha256(event.target.value)}
                          placeholder="64 位 SHA-256"
                          spellCheck={false}
                          value={buildArtifactSha256}
                        />
                      </div>
                    </div>
                    <div className="workflow-step__controls">
                      <button
                        className="secondary-button"
                        disabled={
                          humanWorkflowState === "submitting" ||
                          selectedBug.state !== "awaiting_build" ||
                          humanAttempt?.status !== "delivered" ||
                          linkedBuild !== null ||
                          buildExternalId.trim().length === 0 ||
                          buildDownloadUrl.trim().length === 0 ||
                          !COMMIT_SHA_PATTERN.test(buildCommitSha.trim()) ||
                          !SHA256_PATTERN.test(buildArtifactSha256.trim())
                        }
                        onClick={() => void registerAndLinkBuild()}
                        type="button"
                      >
                        登记并精确关联 Build
                      </button>
                      <small>source commit 不匹配时服务端必须拒绝</small>
                    </div>
                  </div>

                  <div className="workflow-step">
                    <strong>4 · 创建并开始人工验收</strong>
                    <label htmlFor="verification-criteria">验收标准</label>
                    <textarea
                      id="verification-criteria"
                      onChange={(event) => setVerificationCriteria(event.target.value)}
                      placeholder="描述在精确 Build 上需要确认的结果"
                      rows={3}
                      value={verificationCriteria}
                    />
                    <div className="workflow-step__controls">
                      <button
                        className="secondary-button"
                        disabled={
                          humanWorkflowState === "submitting" ||
                          selectedBug.state !== "ready_for_verification" ||
                          linkedBuild === null ||
                          verification !== null ||
                          verificationCriteria.trim().length === 0
                        }
                        onClick={() => void beginVerification()}
                        type="button"
                      >
                        创建并开始人工验收
                      </button>
                    </div>
                  </div>

                  <div className="workflow-step">
                    <strong>5 · 人工通过并关闭</strong>
                    <label htmlFor="verification-result">验收结果摘要</label>
                    <textarea
                      id="verification-result"
                      onChange={(event) => setVerificationResultSummary(event.target.value)}
                      placeholder="记录人工验收结论"
                      rows={3}
                      value={verificationResultSummary}
                    />
                    <div className="workflow-step__controls">
                      <button
                        className="primary-button"
                        disabled={
                          humanWorkflowState === "submitting" ||
                          verification?.status !== "in_progress" ||
                          verificationResultSummary.trim().length === 0
                        }
                        onClick={() => void passVerificationAndClose()}
                        type="button"
                      >
                        人工验收通过并关闭
                      </button>
                      <small>只有人工通过才可关闭，Relay 无此权限</small>
                    </div>
                  </div>
                </div>

                {humanWorkflowState === "success" && humanWorkflowMessage !== null && (
                  <p aria-live="polite" className="success-note">
                    {humanWorkflowMessage}
                  </p>
                )}
                {humanWorkflowState === "error" && humanWorkflowError !== null && (
                  <p aria-live="assertive" className="api-error">
                    人工修复/Build/验收操作失败：{mutationErrorMessage(humanWorkflowError)}
                  </p>
                )}
              </section>
            </article>

            <div className="timeline-block">
              <div className="subsection-heading">
                <h3>审计时间线</h3>
                <span>{timeline.length} 条 / limit 20</span>
              </div>
              {timeline.length === 0 ? (
                <p className="empty-state">当前 Bug 暂无时间线事件。</p>
              ) : (
                <ol className="timeline-list">
                  {timeline.map((event) => (
                    <li key={event.id}>
                      <div className="timeline-list__heading">
                        <strong>{event.type}</strong>
                        <span>#{event.sequence}</span>
                      </div>
                      <p>
                        aggregate={event.aggregate.type}:{event.aggregate.id.slice(0, 8)} ·{" "}
                        {new Date(event.occurredAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <form
              className="comment-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitComment();
              }}
            >
              <label htmlFor="comment-body">追加评论</label>
              <textarea
                id="comment-body"
                onChange={(event) => setCommentBody(event.target.value)}
                placeholder="写下可审计的处理备注"
                rows={3}
                value={commentBody}
              />
              <div className="comment-form__footer">
                <span>使用 clientSubmissionId + 匹配 Idempotency-Key</span>
                <button
                  className="primary-button"
                  disabled={commentState === "submitting" || commentBody.trim().length === 0}
                  type="submit"
                >
                  {commentState === "submitting" ? "提交中" : "提交评论"}
                </button>
              </div>
            </form>
            {commentState === "success" && commentId !== null && (
              <p aria-live="polite" className="success-note">
                Comment 已创建：{commentId}；时间线已重新读取并确认 comment.created。
              </p>
            )}
            {commentState === "error" && commentError !== null && (
              <p aria-live="assertive" className="api-error">
                Comment 请求失败：HTTP{" "}
                {commentError.status === 0 ? "网络不可达" : commentError.status}
                {commentError.code === null ? "" : ` · ${commentError.code}`}。
              </p>
            )}
          </>
        )}
      </section>

      <footer>
        <span>版本 {product.appVersion}</span>
        <span aria-hidden="true">·</span>
        <span>Contract {product.contractVersion}</span>
      </footer>
    </main>
  );
}
