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
  getHumanWorkflow,
  getRelayReceipt,
  getVerification,
  linkBuildRepair,
  listBugEvents,
  listBugs,
  listDuplicateCandidates,
  listProjectMembers,
  listProjectModules,
  listVisibleProjects,
  markBugDuplicate,
  QaHubApiError,
  recordVerificationPassed,
  registerManualBuild,
  startHumanRepairAttempt,
  startVerification,
  transitionBugReady,
  updateBugOwner,
  updateBugModule,
  type BugDetail,
  type BugEvent,
  type BugListFilters,
  type BugListItem,
  type BugListState,
  type BugSeverity,
  type DuplicateCandidate,
  type BuildRecord,
  type HumanRepairAttempt,
  type ProjectMember,
  type ProjectModule,
  type RelayReceipt,
  type VisibleProject,
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

interface BugSelection {
  readonly bugId: string;
  readonly generation: number;
}

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
  const [projectDraftId, setProjectDraftId] = useState(DEFAULT_PROJECT_ID);
  const [activeProjectId, setActiveProjectId] = useState(DEFAULT_PROJECT_ID);
  const [bugQuery, setBugQuery] = useState("");
  const [bugStateFilter, setBugStateFilter] = useState<BugListState | "">("");
  const [bugSeverityFilter, setBugSeverityFilter] = useState<BugSeverity | "">("");
  const [bugs, setBugs] = useState<readonly BugListItem[]>([]);
  const [snapshotSequence, setSnapshotSequence] = useState<number | null>(null);
  const [visibleProjects, setVisibleProjects] = useState<readonly VisibleProject[]>([]);
  const [projectMembers, setProjectMembers] = useState<readonly ProjectMember[]>([]);
  const [projectModules, setProjectModules] = useState<readonly ProjectModule[]>([]);
  const [settingsSnapshotSequence, setSettingsSnapshotSequence] = useState<number | null>(null);
  const [settingsState, setSettingsState] = useState<RequestState>("idle");
  const [settingsError, setSettingsError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
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
  const [moduleSelection, setModuleSelection] = useState("");
  const [assignmentState, setAssignmentState] = useState<MutationState>("idle");
  const [assignmentError, setAssignmentError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [moduleAssignmentState, setModuleAssignmentState] = useState<MutationState>("idle");
  const [moduleAssignmentError, setModuleAssignmentError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [transitionState, setTransitionState] = useState<MutationState>("idle");
  const [transitionError, setTransitionError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<readonly DuplicateCandidate[]>([]);
  const [duplicateCandidateState, setDuplicateCandidateState] = useState<RequestState>("idle");
  const [duplicateCandidateError, setDuplicateCandidateError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [duplicateCanonicalId, setDuplicateCanonicalId] = useState<string | null>(null);
  const [duplicateReason, setDuplicateReason] = useState("");
  const [duplicateMutationState, setDuplicateMutationState] = useState<MutationState>("idle");
  const [duplicateMutationError, setDuplicateMutationError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const [relayState, setRelayState] = useState<MutationState>("idle");
  const [relayReceipt, setRelayReceipt] = useState<RelayReceipt | null>(null);
  const [relayError, setRelayError] = useState<{
    readonly status: number;
    readonly code: string | null;
  } | null>(null);
  const [humanAttempt, setHumanAttempt] = useState<HumanRepairAttempt | null>(null);
  const [linkedBuild, setLinkedBuild] = useState<BuildRecord | null>(null);
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
  const settingsRequestSequence = useRef(0);
  const projectViewGenerationRef = useRef(0);
  const projectViewPendingGenerationRef = useRef<number | null>(null);
  const activeProjectIdRef = useRef(DEFAULT_PROJECT_ID);
  const initialProjectViewLoadedRef = useRef(false);
  const duplicateRequestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const selectedBugIdRef = useRef<string | null>(null);
  const selectionGenerationRef = useRef(0);

  const beginBugSelection = useCallback((bugId: string): BugSelection => {
    const generation = selectionGenerationRef.current + 1;
    selectionGenerationRef.current = generation;
    selectedBugIdRef.current = bugId;
    return { bugId, generation };
  }, []);

  const captureSelection = useCallback((bugId?: string): BugSelection | null => {
    const currentBugId = bugId ?? selectedBugIdRef.current;
    if (currentBugId === null || selectedBugIdRef.current !== currentBugId) return null;
    return { bugId: currentBugId, generation: selectionGenerationRef.current };
  }, []);

  const isCurrentSelection = useCallback((selection: BugSelection): boolean => {
    return (
      selectionGenerationRef.current === selection.generation &&
      selectedBugIdRef.current === selection.bugId
    );
  }, []);

  const loadProjectSettings = useCallback(async (nextProjectId: string): Promise<boolean> => {
    if (projectViewPendingGenerationRef.current !== null) return false;
    const viewGeneration = projectViewGenerationRef.current;
    const requestSequence = settingsRequestSequence.current + 1;
    settingsRequestSequence.current = requestSequence;
    const normalizedProjectId = nextProjectId.trim();
    setSettingsState("loading");
    setSettingsError(null);
    try {
      const [projects, members, modules] = await Promise.all([
        listVisibleProjects(),
        listProjectMembers(normalizedProjectId),
        listProjectModules(normalizedProjectId),
      ]);
      if (
        settingsRequestSequence.current !== requestSequence ||
        projectViewPendingGenerationRef.current !== null ||
        projectViewGenerationRef.current !== viewGeneration
      ) {
        return false;
      }
      if (!projects.items.some((project) => project.id === normalizedProjectId)) {
        throw new QaHubApiError(403, "PROJECT_NOT_VISIBLE");
      }
      setVisibleProjects(projects.items);
      setProjectMembers(members.items);
      setProjectModules(modules.items);
      setSettingsSnapshotSequence(Math.max(projects.snapshotSequence, members.snapshotSequence));
      setSettingsState("success");
      return true;
    } catch (cause: unknown) {
      if (
        settingsRequestSequence.current !== requestSequence ||
        projectViewPendingGenerationRef.current !== null ||
        projectViewGenerationRef.current !== viewGeneration
      ) {
        return false;
      }
      setVisibleProjects([]);
      setProjectMembers([]);
      setProjectModules([]);
      setSettingsSnapshotSequence(null);
      setSettingsState("error");
      setSettingsError(mutationError(cause));
      return false;
    }
  }, []);

  const loadBugList = useCallback(
    async (nextProjectId: string, filters: BugListFilters = {}): Promise<boolean> => {
      if (projectViewPendingGenerationRef.current !== null) return false;
      const viewGeneration = projectViewGenerationRef.current;
      const requestSequence = listRequestSequence.current + 1;
      listRequestSequence.current = requestSequence;
      const normalizedProjectId = nextProjectId.trim();
      setRequestState("loading");
      setError(null);
      try {
        const response = await listBugs(normalizedProjectId, filters);
        if (
          listRequestSequence.current !== requestSequence ||
          projectViewPendingGenerationRef.current !== null ||
          projectViewGenerationRef.current !== viewGeneration
        ) {
          return false;
        }
        setBugs(response.items);
        setSnapshotSequence(response.snapshotSequence);
        setRequestState("success");
        return true;
      } catch (cause: unknown) {
        if (
          listRequestSequence.current !== requestSequence ||
          projectViewPendingGenerationRef.current !== null ||
          projectViewGenerationRef.current !== viewGeneration
        ) {
          return false;
        }
        setBugs([]);
        setSnapshotSequence(null);
        setRequestState("error");
        if (cause instanceof QaHubApiError) {
          setError({ status: cause.status, code: cause.code });
        } else {
          setError({ status: 0, code: "NETWORK_ERROR" });
        }
        return false;
      }
    },
    [],
  );

  const refreshVisibleBugList = useCallback(async (): Promise<void> => {
    await loadBugList(activeProjectIdRef.current, {
      ...(bugQuery.trim().length === 0 ? {} : { q: bugQuery.trim() }),
      ...(bugStateFilter === "" ? {} : { state: bugStateFilter }),
      ...(bugSeverityFilter === "" ? {} : { severity: bugSeverityFilter }),
    });
  }, [bugQuery, bugSeverityFilter, bugStateFilter, loadBugList]);

  const applyProjectView = useCallback(async (): Promise<void> => {
    const normalizedProjectId = projectDraftId.trim().toLowerCase();
    const generation = projectViewGenerationRef.current + 1;
    projectViewGenerationRef.current = generation;
    projectViewPendingGenerationRef.current = generation;
    setRequestState("loading");
    setError(null);
    setSettingsState("loading");
    setSettingsError(null);
    try {
      const [bugResponse, projects, members, modules] = await Promise.all([
        listBugs(normalizedProjectId, {
          ...(bugQuery.trim().length === 0 ? {} : { q: bugQuery.trim() }),
          ...(bugStateFilter === "" ? {} : { state: bugStateFilter }),
          ...(bugSeverityFilter === "" ? {} : { severity: bugSeverityFilter }),
        }),
        listVisibleProjects(),
        listProjectMembers(normalizedProjectId),
        listProjectModules(normalizedProjectId),
      ]);
      if (
        projectViewGenerationRef.current !== generation ||
        projectViewPendingGenerationRef.current !== generation
      ) {
        return;
      }
      if (!projects.items.some((project) => project.id === normalizedProjectId)) {
        throw new QaHubApiError(403, "PROJECT_NOT_VISIBLE");
      }
      if (members.projectId !== normalizedProjectId || modules.projectId !== normalizedProjectId) {
        throw new QaHubApiError(200, "PROJECT_VIEW_SCOPE_MISMATCH");
      }

      const previousProjectId = activeProjectIdRef.current;
      projectViewPendingGenerationRef.current = null;
      activeProjectIdRef.current = normalizedProjectId;
      setActiveProjectId(normalizedProjectId);
      setBugs(bugResponse.items);
      setSnapshotSequence(bugResponse.snapshotSequence);
      setRequestState("success");
      setVisibleProjects(projects.items);
      setProjectMembers(members.items);
      setProjectModules(modules.items);
      setSettingsSnapshotSequence(Math.max(projects.snapshotSequence, members.snapshotSequence));
      setSettingsState("success");
      if (normalizedProjectId !== previousProjectId) {
        detailRequestSequence.current += 1;
        selectionGenerationRef.current += 1;
        selectedBugIdRef.current = null;
        setSelectedBugId(null);
        setSelectedBug(null);
        setTimeline([]);
        setDetailState("idle");
        setDetailError(null);
      }
    } catch (cause: unknown) {
      if (
        projectViewGenerationRef.current !== generation ||
        projectViewPendingGenerationRef.current !== generation
      ) {
        return;
      }
      projectViewPendingGenerationRef.current = null;
      const nextError = mutationError(cause);
      setRequestState("error");
      setError(nextError);
      setSettingsState("error");
      setSettingsError(nextError);
    }
  }, [bugQuery, bugSeverityFilter, bugStateFilter, projectDraftId]);

  const loadBugDetails = useCallback(
    async (
      bugId: string,
      preserveComment = false,
      preserveRelay = false,
      preserveHuman = false,
      internalSelection?: BugSelection,
    ): Promise<{ readonly bug: BugDetail; readonly events: readonly BugEvent[] } | null> => {
      if (internalSelection === undefined) {
        beginBugSelection(bugId);
      } else if (!isCurrentSelection(internalSelection) || internalSelection.bugId !== bugId) {
        return null;
      }
      const requestSequence = detailRequestSequence.current + 1;
      detailRequestSequence.current = requestSequence;
      selectedBugIdRef.current = bugId;
      setSelectedBugId(bugId);
      setSelectedBug(null);
      setTimeline([]);
      setDetailState("loading");
      setDetailError(null);
      duplicateRequestSequence.current += 1;
      setDuplicateCandidates([]);
      setDuplicateCandidateState("idle");
      setDuplicateCandidateError(null);
      setDuplicateCanonicalId(null);
      setDuplicateReason("");
      setDuplicateMutationState("idle");
      setDuplicateMutationError(null);
      setDuplicateMessage(null);
      setModuleAssignmentState("idle");
      setModuleAssignmentError(null);
      setAssignmentState("idle");
      setAssignmentError(null);
      setTransitionState("idle");
      setTransitionError(null);
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
        const [bug, events, humanWorkflow] = await Promise.all([
          getBug(bugId),
          listBugEvents(bugId),
          getHumanWorkflow(bugId),
        ]);
        if (
          detailRequestSequence.current !== requestSequence ||
          selectedBugIdRef.current !== bugId
        ) {
          return null;
        }
        setSelectedBug(bug);
        setOwnerSelection(bug.ownerId ?? "");
        setModuleSelection(bug.moduleId ?? "");
        setTimeline(events.items);
        setHumanAttempt(humanWorkflow.repairAttempt);
        setLinkedBuild(humanWorkflow.build);
        setVerification(humanWorkflow.verification);
        setRepairSummary(humanWorkflow.repairAttempt?.summary ?? "");
        setRepairBranch(humanWorkflow.repairAttempt?.branch ?? "");
        setRepairCommitSha(humanWorkflow.repairAttempt?.commitSha ?? "");
        setBuildExternalId(humanWorkflow.build?.externalId ?? "");
        setBuildVersion(humanWorkflow.build?.versionName ?? "0.1.0-debug");
        setBuildDownloadUrl(humanWorkflow.build?.downloadUrl ?? "");
        setBuildArtifactSha256(humanWorkflow.build?.artifactSha256 ?? "");
        setBuildCommitSha(humanWorkflow.build?.sourceCommitSha ?? "");
        setVerificationCriteria(humanWorkflow.verification?.criteriaSnapshot ?? "");
        setVerificationResultSummary(humanWorkflow.verification?.resultSummary ?? "");
        setDetailState("success");
        return { bug, events: events.items };
      } catch (cause: unknown) {
        if (
          detailRequestSequence.current !== requestSequence ||
          selectedBugIdRef.current !== bugId
        ) {
          return null;
        }
        setDetailState("error");
        if (cause instanceof QaHubApiError) {
          setDetailError({ status: cause.status, code: cause.code });
        } else {
          setDetailError({ status: 0, code: "NETWORK_ERROR" });
        }
        return null;
      }
    },
    [beginBugSelection, isCurrentSelection],
  );

  const assignOwner = useCallback(async (): Promise<void> => {
    if (selectedBug === null) return;
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    const nextOwnerId = ownerSelection.length === 0 ? null : ownerSelection;
    setAssignmentState("submitting");
    setAssignmentError(null);
    try {
      await updateBugOwner(selectedBug.id, selectedBug.version, nextOwnerId);
      if (!isCurrentSelection(selection)) return;
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection)) return;
      if (refreshed?.bug.ownerId === nextOwnerId) {
        setAssignmentState("success");
      } else {
        setAssignmentState("error");
        setAssignmentError({ status: 200, code: "OWNER_READBACK_MISMATCH" });
      }
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setAssignmentState("error");
      setAssignmentError(mutationError(cause));
    }
  }, [captureSelection, isCurrentSelection, loadBugDetails, ownerSelection, selectedBug]);

  const assignModule = useCallback(async (): Promise<void> => {
    if (selectedBug === null) return;
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    const nextModuleId = moduleSelection.length === 0 ? null : moduleSelection;
    setModuleAssignmentState("submitting");
    setModuleAssignmentError(null);
    try {
      await updateBugModule(selectedBug.id, selectedBug.version, nextModuleId);
      if (!isCurrentSelection(selection)) return;
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection)) return;
      if (refreshed?.bug.moduleId === nextModuleId) {
        setModuleAssignmentState("success");
        if (!isCurrentSelection(selection)) return;
        await refreshVisibleBugList();
      } else {
        setModuleAssignmentState("error");
        setModuleAssignmentError({ status: 200, code: "MODULE_READBACK_MISMATCH" });
      }
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setModuleAssignmentState("error");
      setModuleAssignmentError(mutationError(cause));
    }
  }, [
    captureSelection,
    isCurrentSelection,
    loadBugDetails,
    moduleSelection,
    refreshVisibleBugList,
    selectedBug,
  ]);

  const markReady = useCallback(async (): Promise<void> => {
    if (selectedBug === null || selectedBug.state !== "reported") return;
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    setTransitionState("submitting");
    setTransitionError(null);
    try {
      await transitionBugReady(selectedBug.id, selectedBug.version);
      if (!isCurrentSelection(selection)) return;
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection)) return;
      if (refreshed?.bug.state === "ready") {
        setTransitionState("success");
        if (!isCurrentSelection(selection)) return;
        await refreshVisibleBugList();
      } else {
        setTransitionState("error");
        setTransitionError({ status: 200, code: "STATE_READBACK_MISMATCH" });
      }
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setTransitionState("error");
      setTransitionError(mutationError(cause));
    }
  }, [captureSelection, isCurrentSelection, loadBugDetails, refreshVisibleBugList, selectedBug]);

  const loadCandidates = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      (selectedBug.state !== "reported" && selectedBug.state !== "ready")
    ) {
      return;
    }
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    const requestSequence = duplicateRequestSequence.current + 1;
    duplicateRequestSequence.current = requestSequence;
    setDuplicateCandidateState("loading");
    setDuplicateCandidateError(null);
    setDuplicateCandidates([]);
    setDuplicateCanonicalId(null);
    setDuplicateMutationState("idle");
    setDuplicateMutationError(null);
    setDuplicateMessage(null);
    try {
      const result = await listDuplicateCandidates(selectedBug.id);
      if (duplicateRequestSequence.current !== requestSequence || !isCurrentSelection(selection)) {
        return;
      }
      setDuplicateCandidates(result.candidates);
      setDuplicateCandidateState("success");
    } catch (cause: unknown) {
      if (duplicateRequestSequence.current !== requestSequence || !isCurrentSelection(selection)) {
        return;
      }
      setDuplicateCandidateState("error");
      setDuplicateCandidateError(mutationError(cause));
    }
  }, [captureSelection, isCurrentSelection, selectedBug]);

  const confirmDuplicate = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      duplicateCanonicalId === null ||
      duplicateReason.trim().length === 0 ||
      (selectedBug.state !== "reported" && selectedBug.state !== "ready")
    ) {
      return;
    }
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    const canonicalKey =
      duplicateCandidates.find((candidate) => candidate.bugId === duplicateCanonicalId)?.bugKey ??
      duplicateCanonicalId;
    setDuplicateMutationState("submitting");
    setDuplicateMutationError(null);
    setDuplicateMessage(null);
    try {
      const result = await markBugDuplicate(
        selectedBug.id,
        selectedBug.version,
        duplicateCanonicalId,
        duplicateReason.trim(),
      );
      if (!isCurrentSelection(selection)) return;
      if (result.state !== "duplicate" || result.duplicateOfBugId !== duplicateCanonicalId) {
        setDuplicateMutationState("error");
        setDuplicateMutationError({ status: 200, code: "DUPLICATE_READBACK_MISMATCH" });
        return;
      }
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection)) return;
      if (
        refreshed?.bug.state !== "duplicate" ||
        refreshed.bug.duplicateOfBugId !== duplicateCanonicalId ||
        !refreshed.events.some((event) => event.type === "bug.mark_duplicate")
      ) {
        setDuplicateMutationState("error");
        setDuplicateMutationError({ status: 200, code: "DUPLICATE_EVENT_MISSING" });
        return;
      }
      setDuplicateMutationState("success");
      setDuplicateMessage(`${refreshed.bug.key} 已由人工确认重复，canonical 为 ${canonicalKey}。`);
      if (!isCurrentSelection(selection)) return;
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setDuplicateMutationState("error");
      setDuplicateMutationError(mutationError(cause));
    }
  }, [
    duplicateCandidates,
    duplicateCanonicalId,
    duplicateReason,
    captureSelection,
    isCurrentSelection,
    loadBugDetails,
    refreshVisibleBugList,
    selectedBug,
  ]);

  const submitComment = useCallback(async (): Promise<void> => {
    if (selectedBugId === null || commentBody.trim().length === 0) return;
    const selection = captureSelection(selectedBugId);
    if (selection === null) return;
    const clientSubmissionId = globalThis.crypto.randomUUID();
    setCommentState("submitting");
    setCommentError(null);
    try {
      const result = await addBugComment(selectedBugId, commentBody.trim(), clientSubmissionId);
      if (!isCurrentSelection(selection)) return;
      setCommentBody("");
      setCommentId(result.comment.id);
      const refreshed = await loadBugDetails(selectedBugId, true, true, true, selection);
      if (!isCurrentSelection(selection)) return;
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
      if (!isCurrentSelection(selection)) return;
      setCommentState("error");
      if (cause instanceof QaHubApiError) {
        setCommentError({ status: cause.status, code: cause.code });
      } else {
        setCommentError({ status: 0, code: "NETWORK_ERROR" });
      }
    }
  }, [captureSelection, commentBody, isCurrentSelection, loadBugDetails, selectedBugId]);

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
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    setRelayState("submitting");
    setRelayReceipt(null);
    setRelayError(null);
    try {
      const attempt = await createRelayAttempt(selectedBug.id, selectedBug.version, MVP_OWNER_ID);
      const handoffId = globalThis.crypto.randomUUID();
      const accepted = await dispatchRelay(attempt.id, attempt.version, handoffId);
      const receipt = await readRelayReceipt(attempt.id);
      if (!isCurrentSelection(selection)) return;
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
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection) || refreshed === null) return;
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setRelayState("error");
      setRelayError(mutationError(cause));
    }
  }, [
    captureSelection,
    isCurrentSelection,
    loadBugDetails,
    readRelayReceipt,
    refreshVisibleBugList,
    selectedBug,
  ]);

  const refreshRelayReceipt = useCallback(async (): Promise<void> => {
    if (relayReceipt === null) return;
    const selection = captureSelection(relayReceipt.qaItem.id);
    if (selection === null) return;
    setRelayState("submitting");
    setRelayError(null);
    try {
      const receipt = await readRelayReceipt(relayReceipt.repairAttemptId);
      if (!isCurrentSelection(selection)) return;
      setRelayReceipt(receipt);
      setRelayState("success");
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setRelayState("error");
      setRelayError(mutationError(cause));
    }
  }, [captureSelection, isCurrentSelection, readRelayReceipt, relayReceipt]);

  const createHumanWorkflow = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      selectedBug.state !== "ready" ||
      repairSummary.trim().length === 0
    ) {
      return;
    }
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
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
      if (!isCurrentSelection(selection)) return;
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
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection) || refreshed === null) return;
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    captureSelection,
    isCurrentSelection,
    loadBugDetails,
    refreshVisibleBugList,
    repairSummary,
    selectedBug,
  ]);

  const deliverHumanWorkflow = useCallback(async (): Promise<void> => {
    if (
      selectedBug === null ||
      humanAttempt === null ||
      (humanAttempt.status !== "planned" && humanAttempt.status !== "running") ||
      repairSummary.trim().length === 0 ||
      repairBranch.trim().length === 0 ||
      !COMMIT_SHA_PATTERN.test(repairCommitSha.trim())
    ) {
      return;
    }
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    setHumanWorkflowState("submitting");
    setHumanWorkflowError(null);
    setHumanWorkflowMessage(null);
    try {
      const started =
        humanAttempt.status === "planned"
          ? await startHumanRepairAttempt(humanAttempt.id, humanAttempt.version)
          : humanAttempt;
      const delivered = await deliverHumanRepairAttempt(
        started.id,
        started.version,
        repairSummary.trim(),
        repairBranch.trim(),
        repairCommitSha.trim(),
      );
      const readback = await getHumanRepairAttempt(delivered.id);
      if (!isCurrentSelection(selection)) return;
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
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection) || refreshed === null) return;
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    captureSelection,
    humanAttempt,
    isCurrentSelection,
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
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
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
      if (!isCurrentSelection(selection)) return;
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
      if (!isCurrentSelection(selection)) return;
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
      setLinkedBuild(linked.build);
      setHumanWorkflowMessage(`Build 已精确关联：${linked.build.externalId}`);
      setHumanWorkflowState("success");
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection) || refreshed === null) return;
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    buildArtifactSha256,
    buildCommitSha,
    buildDownloadUrl,
    buildExternalId,
    buildVersion,
    captureSelection,
    humanAttempt,
    isCurrentSelection,
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
      (verification !== null && verification.status !== "requested") ||
      verificationCriteria.trim().length === 0
    ) {
      return;
    }
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
    setHumanWorkflowState("submitting");
    setHumanWorkflowError(null);
    setHumanWorkflowMessage(null);
    try {
      const requested =
        verification ??
        (await createVerification({
          bugId: selectedBug.id,
          expectedBugVersion: selectedBug.version,
          repairAttemptId: humanAttempt.id,
          buildId: linkedBuild.id,
          verifierId: MVP_OWNER_ID,
          criteria: verificationCriteria.trim(),
        }));
      const started = await startVerification(requested.id, requested.version);
      const readback = await getVerification(started.id);
      if (!isCurrentSelection(selection)) return;
      if (
        readback.status !== "in_progress" ||
        readback.bugId !== selectedBug.id ||
        readback.buildId !== linkedBuild.id
      ) {
        setHumanWorkflowState("error");
        setHumanWorkflowError({ status: 200, code: "VERIFICATION_READBACK_MISMATCH" });
        return;
      }
      setVerification(readback);
      setHumanWorkflowMessage(`人工验收已开始：${readback.id}`);
      setHumanWorkflowState("success");
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection) || refreshed === null) return;
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    captureSelection,
    humanAttempt,
    isCurrentSelection,
    linkedBuild,
    loadBugDetails,
    refreshVisibleBugList,
    selectedBug,
    verification,
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
    const selection = captureSelection(selectedBug.id);
    if (selection === null) return;
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
      if (!isCurrentSelection(selection)) return;
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
      const refreshed = await loadBugDetails(selectedBug.id, true, true, true, selection);
      if (!isCurrentSelection(selection) || refreshed === null) return;
      await refreshVisibleBugList();
    } catch (cause: unknown) {
      if (!isCurrentSelection(selection)) return;
      setHumanWorkflowState("error");
      setHumanWorkflowError(mutationError(cause));
    }
  }, [
    captureSelection,
    isCurrentSelection,
    loadBugDetails,
    refreshVisibleBugList,
    selectedBug,
    verification,
    verificationResultSummary,
  ]);

  useEffect(() => {
    if (initialProjectViewLoadedRef.current) return;
    initialProjectViewLoadedRef.current = true;
    void applyProjectView();
  }, [applyProjectView]);

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
            void applyProjectView();
          }}
        >
          <label htmlFor="project-id">项目 ID</label>
          <div className="project-form__controls">
            <input
              id="project-id"
              onChange={(event) => setProjectDraftId(event.target.value)}
              spellCheck={false}
              value={projectDraftId}
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
                void loadBugList(activeProjectIdRef.current);
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
          <p className="api-footnote" id="active-project-id">
            已应用项目：{activeProjectId}
          </p>
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
          <span>已完成：核心闭环、组合筛选、显式人工去重</span>
          <span>当前段：浏览器选择一致性；Windows 桌面打包统一后置</span>
        </div>
      </section>

      <section aria-labelledby="project-settings-title" className="workspace-card">
        <div className="section-heading">
          <div>
            <p className="card-kicker">同一 QA Hub 事实源</p>
            <h2 id="project-settings-title">项目、成员角色与模块</h2>
          </div>
          <span className={`status-dot status-dot--${settingsState}`}>
            {settingsState === "loading"
              ? "读取中"
              : settingsState === "error"
                ? "权限 / API 错误"
                : "配置可读"}
          </span>
        </div>

        <div className="settings-actions">
          <button
            className="secondary-button"
            disabled={settingsState === "loading"}
            id="project-settings-refresh"
            onClick={() => void loadProjectSettings(activeProjectIdRef.current)}
            type="button"
          >
            刷新当前项目配置
          </button>
          <button
            className="link-button"
            id="project-settings-forbidden"
            onClick={() => void loadProjectSettings(INVALID_PROJECT_ID)}
            type="button"
          >
            验证无权项目（应显示 403）
          </button>
        </div>

        {settingsState === "error" && settingsError !== null && (
          <p aria-live="assertive" className="api-error" id="project-settings-error">
            项目配置读取失败：{mutationErrorMessage(settingsError)}
          </p>
        )}

        {visibleProjects.length > 0 && (
          <>
            <div className="settings-grid">
              <article className="settings-panel">
                <h3>项目</h3>
                {visibleProjects.map((project) => (
                  <div className="settings-record" key={project.id}>
                    <strong>
                      {project.key} · {project.name}
                    </strong>
                    <small>{project.roles.join(" · ")}</small>
                    <span>{project.id === activeProjectId ? "当前项目" : "可见项目"}</span>
                  </div>
                ))}
              </article>

              <article className="settings-panel">
                <h3>成员 / 角色</h3>
                {projectMembers.map((member) => (
                  <div className="settings-record" key={member.userId}>
                    <strong>{member.displayName}</strong>
                    <small>{member.roles.join(" · ")}</small>
                    <span>{member.userId}</span>
                  </div>
                ))}
              </article>

              <article className="settings-panel">
                <h3>模块</h3>
                {projectModules.length === 0 ? (
                  <p className="empty-state">当前项目还没有模块。</p>
                ) : (
                  projectModules.map((module) => (
                    <div className="settings-record" key={module.id}>
                      <strong>{module.name}</strong>
                      <small>{module.active ? "active" : "inactive"}</small>
                      <span>{module.id}</span>
                    </div>
                  ))
                )}
              </article>
            </div>

            <div className="module-assignment">
              <div>
                <p className="card-kicker">必要设置首段</p>
                <h3>将当前 Bug 归入模块</h3>
                <p>复用受角色权限、版本锁与审计保护的 Bug 更新；不会在浏览器建立第二份配置事实。</p>
              </div>
              {selectedBug === null ? (
                <p className="empty-state">先从 Bug 列表选择一条记录。</p>
              ) : (
                <div className="module-assignment__controls">
                  <label htmlFor="bug-module">{selectedBug.key} 的模块</label>
                  <select
                    id="bug-module"
                    onChange={(event) => setModuleSelection(event.target.value)}
                    value={moduleSelection}
                  >
                    <option value="">未归类</option>
                    {projectModules
                      .filter((module) => module.active)
                      .map((module) => (
                        <option key={module.id} value={module.id}>
                          {module.name}
                        </option>
                      ))}
                  </select>
                  <button
                    className="primary-button"
                    disabled={moduleAssignmentState === "submitting"}
                    id="bug-module-save"
                    onClick={() => void assignModule()}
                    type="button"
                  >
                    {moduleAssignmentState === "submitting" ? "保存中" : "保存并回读"}
                  </button>
                </div>
              )}
              {moduleAssignmentState === "success" && selectedBug !== null && (
                <p aria-live="polite" className="success-note" id="bug-module-success">
                  {selectedBug.key} 的 moduleId 已由 QA Hub API/SQLite 回读确认。
                </p>
              )}
              {moduleAssignmentState === "error" && moduleAssignmentError !== null && (
                <p aria-live="assertive" className="api-error" id="bug-module-error">
                  模块归类失败：{mutationErrorMessage(moduleAssignmentError)}
                </p>
              )}
            </div>

            {settingsSnapshotSequence !== null && (
              <p className="api-footnote">
                项目目录已授权读取 · 最新 snapshot {settingsSnapshotSequence}
              </p>
            )}
          </>
        )}
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
                  <dt>模块</dt>
                  <dd>
                    {projectModules.find((module) => module.id === selectedBug.moduleId)?.name ??
                      selectedBug.moduleId ??
                      "未归类"}
                  </dd>
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
                      {projectMembers
                        .filter((member) =>
                          member.roles.some((role) =>
                            ["developer", "triager", "project_admin"].includes(role),
                          ),
                        )
                        .map((member) => (
                          <option key={member.userId} value={member.userId}>
                            {member.displayName}
                          </option>
                        ))}
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
                  <span className="bug-action__label">重复候选</span>
                  <div className="bug-action__controls">
                    <button
                      className="secondary-button"
                      disabled={
                        duplicateCandidateState === "loading" ||
                        (selectedBug.state !== "reported" && selectedBug.state !== "ready")
                      }
                      id="duplicate-candidates-load"
                      onClick={() => void loadCandidates()}
                      type="button"
                    >
                      {duplicateCandidateState === "loading" ? "读取中" : "读取重复候选"}
                    </button>
                    <span className="bug-action__hint">
                      只展示候选；必须由用户选择并确认，服务端不会自动合并
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
              {duplicateCandidateState === "error" && duplicateCandidateError !== null && (
                <p aria-live="assertive" className="api-error" id="duplicate-action-error">
                  重复候选读取失败：{mutationErrorMessage(duplicateCandidateError)}
                </p>
              )}
              {duplicateCandidateState === "success" && (
                <section aria-label="人工去重合并" className="duplicate-workflow">
                  <div className="subsection-heading">
                    <h3>人工确认重复</h3>
                    <span>{duplicateCandidates.length} 条候选</span>
                  </div>
                  {duplicateCandidates.length === 0 ? (
                    <p className="empty-state">没有匹配候选；Bug 保持原状态。</p>
                  ) : (
                    <div className="duplicate-candidate-list" id="duplicate-candidate-list">
                      {duplicateCandidates.map((candidate) => (
                        <label
                          className="duplicate-candidate"
                          htmlFor={`duplicate-candidate-${candidate.bugId}`}
                          key={candidate.bugId}
                        >
                          <input
                            checked={duplicateCanonicalId === candidate.bugId}
                            id={`duplicate-candidate-${candidate.bugId}`}
                            name="duplicate-canonical"
                            onChange={() => setDuplicateCanonicalId(candidate.bugId)}
                            type="radio"
                          />
                          <span>
                            <strong>{candidate.bugKey}</strong>
                            <small>
                              score {candidate.score} · {candidate.reasons.join("；")}
                            </small>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <label htmlFor="duplicate-mark-reason">人工确认原因</label>
                  <textarea
                    id="duplicate-mark-reason"
                    onChange={(event) => setDuplicateReason(event.target.value)}
                    placeholder="说明为何确认与所选 canonical Bug 重复"
                    rows={2}
                    value={duplicateReason}
                  />
                  <div className="workflow-step__controls">
                    <button
                      className="primary-button"
                      disabled={
                        duplicateMutationState === "submitting" ||
                        duplicateCanonicalId === null ||
                        duplicateReason.trim().length === 0
                      }
                      id="mark-duplicate"
                      onClick={() => void confirmDuplicate()}
                      type="button"
                    >
                      {duplicateMutationState === "submitting" ? "确认中" : "确认标记为重复"}
                    </button>
                    <small>该操作写入 QA Hub 事实与审计，但不是验收或关闭</small>
                  </div>
                </section>
              )}
              {duplicateMutationState === "success" && duplicateMessage !== null && (
                <p aria-live="polite" className="success-note" id="duplicate-action-success">
                  {duplicateMessage}
                </p>
              )}
              {duplicateMutationState === "error" && duplicateMutationError !== null && (
                <p aria-live="assertive" className="api-error" id="duplicate-action-error">
                  人工去重失败：{mutationErrorMessage(duplicateMutationError)}
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
                    <span>Build: {linkedBuild?.status ?? "未关联"}</span>
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
                          (humanAttempt?.status !== "planned" &&
                            humanAttempt?.status !== "running") ||
                          repairBranch.trim().length === 0 ||
                          !COMMIT_SHA_PATTERN.test(repairCommitSha.trim())
                        }
                        onClick={() => void deliverHumanWorkflow()}
                        type="button"
                      >
                        {humanAttempt?.status === "running"
                          ? "继续登记代码交付"
                          : "开始并登记代码交付"}
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
                          (verification !== null && verification.status !== "requested") ||
                          verificationCriteria.trim().length === 0
                        }
                        onClick={() => void beginVerification()}
                        type="button"
                      >
                        {verification?.status === "requested"
                          ? "继续开始人工验收"
                          : "创建并开始人工验收"}
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
