import {
  addBugComment,
  createBug,
  sha256Hex,
  uploadBugCreateAttachment,
  QaHubApiError,
  type BugSeverity,
  type CommentCreationResponse,
  type CreateBugInput,
  type CreateBugResponse,
  type UploadCheckpoint,
} from "./api";
import { assertProjectRequest, projectRequestSnapshot, projectStorageKey } from "./project-context";
import { updateProjectDraft } from "./project-drafts";

export interface SubmissionScope {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
}
export interface BugSubmissionDraft {
  readonly content: string;
  readonly title: string;
  readonly expectedBehavior: string;
  readonly severity: BugSeverity;
  readonly ownerId: string;
  readonly verificationOwnerId: string;
  readonly files: readonly File[];
}
interface EntryBase {
  readonly id: string;
  readonly scope: SubmissionScope;
  readonly fingerprint: string;
  readonly previousReceiptId?: string;
  readonly commitAttempts?: number;
  readonly rejection?: SubmissionRejection;
  readonly supersededBy?: string;
}
export interface SubmissionRejection {
  readonly id: string;
  readonly phase: "upload" | "commit";
  readonly status: number;
  readonly code: string;
  readonly recordedAt: string;
}
interface PendingBug extends EntryBase {
  readonly kind: "bug";
  readonly draft: BugSubmissionDraft;
  readonly input: CreateBugInput;
  readonly uploads: readonly UploadCheckpoint[];
  readonly requestBody?: string;
  readonly response?: CreateBugResponse;
}
interface PendingComment extends EntryBase {
  readonly kind: "comment";
  readonly bugId: string;
  readonly body: string;
  readonly requestBody: string;
  readonly response?: CommentCreationResponse;
}
type Entry = PendingBug | PendingComment;
export interface SubmissionJournal {
  readonly entries: readonly Entry[];
}
export type SubmissionStore = (
  key: string,
  update: (journal: SubmissionJournal | undefined) => SubmissionJournal,
) => Promise<SubmissionJournal>;
interface Transport {
  readonly create: typeof createBug;
  readonly comment: typeof addBugComment;
  readonly upload: typeof uploadBugCreateAttachment;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("原提交记录不完整，已停止请求并保留草稿。");
  return value;
}

function keyFor(scope: SubmissionScope, target: string): string {
  if (!scope.accountId || !scope.projectId || !scope.actorId)
    throw new Error("提交身份不完整，请重新登录。");
  return projectStorageKey(
    JSON.stringify(["pending-submission-v1", scope.accountId, target]),
    scope.projectId,
    scope.actorId,
  );
}
function mergeCheckpoint(old: UploadCheckpoint, next: UploadCheckpoint): UploadCheckpoint {
  if (old.clientAttachmentId !== next.clientAttachmentId || old.sha256 !== next.sha256)
    throw new Error("附件提交身份不一致，已保留原提交。");
  return {
    ...next,
    init: old.init ?? next.init,
    nextChunk: Math.max(old.nextChunk, next.nextChunk),
    version: Math.max(old.version ?? 0, next.version ?? 0) || undefined,
    finalized: old.finalized ?? next.finalized,
    bound: old.bound || next.bound,
  };
}

/** Journal entries, including confirmed receipts, are retained. No effect precedes a durable claim. */
export function pendingSubmissions(
  store: SubmissionStore = updateProjectDraft,
  transport: Transport = {
    create: createBug,
    comment: addBugComment,
    upload: uploadBugCreateAttachment,
  },
) {
  const claim = async (
    key: string,
    candidate: Entry,
    previousReceiptId?: string,
    resumeOnly = false,
    replaceRejectedId?: string,
  ) => {
    let selectedId = candidate.id;
    const journal = await store(key, (old) => {
      const entries = old?.entries ?? [];
      const current = entries.at(-1);
      if (
        current &&
        (current.kind !== candidate.kind ||
          current.scope.accountId !== candidate.scope.accountId ||
          current.scope.projectId !== candidate.scope.projectId ||
          current.scope.actorId !== candidate.scope.actorId)
      )
        throw new Error("本地提交归属不一致，已停止请求。");
      if (replaceRejectedId !== undefined) {
        if (!current || current.id !== replaceRejectedId || !current.rejection || current.response)
          throw new Error("原拒绝记录已变化，当前草稿保留，请重新确认。");
        if (
          candidate.kind === "bug" &&
          (!candidate.draft.content.trim() || !candidate.draft.verificationOwnerId)
        )
          throw new Error("请填写 Bug 内容并选择关闭人。");
        if (candidate.kind === "comment" && !candidate.body) throw new Error("请填写处理记录。");
        return {
          entries: [
            ...entries.map((entry) =>
              entry.id === current.id ? { ...entry, supersededBy: candidate.id } : entry,
            ),
            { ...candidate, ...(previousReceiptId ? { previousReceiptId } : {}) },
          ],
        };
      }
      if (current && !current.response) {
        selectedId = current.id;
        return { entries };
      }
      const original = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.response !== undefined &&
            entry.fingerprint === candidate.fingerprint &&
            entry.previousReceiptId === previousReceiptId,
        );
      if (original) {
        selectedId = original.id;
        return { entries };
      }
      if (current && previousReceiptId !== current.id) {
        selectedId = current.id;
        return { entries };
      }
      // Even an edited form must resolve an uncertain original first. A stale restored
      // form returns its confirmed receipt until the UI acknowledges that receipt.
      if (resumeOnly) throw new Error("没有待确认的提交；当前草稿已保留。");
      if (
        candidate.kind === "bug" &&
        (!candidate.draft.content.trim() || !candidate.draft.verificationOwnerId)
      )
        throw new Error("请填写 Bug 内容并选择关闭人。");
      if (candidate.kind === "comment" && !candidate.body) throw new Error("请填写处理记录。");
      return {
        entries: [
          ...entries,
          { ...candidate, ...(previousReceiptId ? { previousReceiptId } : {}) },
        ],
      };
    });
    return required(journal.entries.find((entry) => entry.id === selectedId));
  };
  const update = async (key: string, id: string, change: (entry: Entry) => Entry) => {
    const journal = await store(key, (old) => {
      if (!old?.entries.some((entry) => entry.id === id))
        throw new Error("原提交记录不可用，已停止请求。");
      return { entries: old.entries.map((entry) => (entry.id === id ? change(entry) : entry)) };
    });
    return required(journal.entries.find((entry) => entry.id === id));
  };
  const rejectIfDefinite = async (
    key: string,
    id: string,
    cause: unknown,
    phase: SubmissionRejection["phase"],
    attempt?: number,
  ) => {
    if (
      !(cause instanceof QaHubApiError) ||
      cause.status !== 400 ||
      !(phase === "upload"
        ? ["UPLOAD_CONTENT_INVALID", "INVALID_REQUEST"].includes(cause.code ?? "")
        : cause.code === "INVALID_REQUEST")
    )
      return;
    await update(key, id, (current) => {
      // Before core POST an upload rejection cannot have created a Bug. For core
      // parsing rejection, ONLY the first uncontended response can prove no effect.
      // A crash or lost response left a durable previous attempt and is sticky.
      if (
        current.response ||
        (phase === "upload"
          ? (current.commitAttempts ?? 0) !== 0
          : attempt !== 1 || current.commitAttempts !== 1)
      )
        return current;
      return {
        ...current,
        rejection: {
          id,
          phase,
          status: cause.status,
          code: cause.code ?? "INVALID_REQUEST",
          recordedAt: new Date().toISOString(),
        },
      };
    });
  };
  const prepareCommit = async (key: string, entry: Entry) =>
    await update(key, entry.id, (current) => {
      if (current.rejection) throw new Error("上次提交已被明确拒绝；请保留记录并提交修改稿。");
      if (current.response) return current;
      return { ...current, commitAttempts: (current.commitAttempts ?? 0) + 1 };
    });
  return {
    async rejection(scope: SubmissionScope, bugId?: string) {
      const journal = await store(
        keyFor(scope, bugId ? `comment:${bugId}` : "bug"),
        (old) => old ?? { entries: [] },
      );
      return journal.entries.at(-1)?.rejection;
    },
    async recoverBug(scope: SubmissionScope, previousReceiptId?: string) {
      const journal = await store(keyFor(scope, "bug"), (old) => old ?? { entries: [] });
      const entry = journal.entries.at(-1);
      return entry?.kind === "bug" && (!entry.response || entry.id !== previousReceiptId)
        ? entry.draft
        : undefined;
    },
    async recoverComment(scope: SubmissionScope, bugId: string, previousReceiptId?: string) {
      const journal = await store(
        keyFor(scope, `comment:${bugId}`),
        (old) => old ?? { entries: [] },
      );
      const entry = journal.entries.at(-1);
      return entry?.kind === "comment" && (!entry.response || entry.id !== previousReceiptId)
        ? entry.body
        : undefined;
    },
    async bug(
      scope: SubmissionScope,
      draft: BugSubmissionDraft,
      previousReceiptId?: string,
      resumeOnly = false,
      replaceRejectedId?: string,
    ) {
      const requestScope = projectRequestSnapshot({}, scope.projectId);
      const key = keyFor(scope, "bug");
      const uploads = await Promise.all(
        draft.files.map(async (file) => ({
          clientAttachmentId: crypto.randomUUID(),
          sha256: await sha256Hex(file),
          nextChunk: 0,
        })),
      );
      const fingerprint = await sha256Hex(
        new Blob([
          JSON.stringify({
            ...draft,
            files: draft.files.map((file, i) => ({
              name: file.name,
              type: file.type,
              size: file.size,
              lastModified: file.lastModified,
              sha256: required(uploads[i]).sha256,
            })),
          }),
        ]),
      );
      assertProjectRequest(requestScope);
      const id = crypto.randomUUID();
      const candidate: PendingBug = {
        id,
        kind: "bug",
        scope: { ...scope },
        fingerprint,
        draft,
        uploads,
        input: {
          projectId: scope.projectId,
          clientSubmissionId: id,
          title: draft.title,
          description: draft.content.trim(),
          expectedBehavior: draft.expectedBehavior,
          severity: draft.severity,
          priority: `P${draft.severity.slice(1)}` as CreateBugInput["priority"],
          ownerId: draft.ownerId || null,
          verificationOwnerId: draft.verificationOwnerId,
          attachmentIds: [],
          occurrence: {
            observedAt: new Date().toISOString(),
            platform: "web",
            deviceModel: navigator.userAgent.slice(0, 200),
            osVersion: navigator.platform.slice(0, 100),
            steps: ["从 Relay QA Hub Web 管理台提交"],
            actualBehavior: draft.content.trim(),
          },
        },
      };
      let entry = (await claim(
        key,
        candidate,
        previousReceiptId,
        resumeOnly,
        replaceRejectedId,
      )) as PendingBug;
      assertProjectRequest(requestScope);
      if (entry.rejection) throw new Error("上次提交已被明确拒绝；请保留记录并提交修改稿。");
      if (!entry.response) {
        const attachmentIds: string[] = [];
        for (let index = 0; index < entry.draft.files.length; index++) {
          try {
            attachmentIds.push(
              await transport.upload({
                projectId: scope.projectId,
                clientSubmissionId: entry.id,
                file: required(entry.draft.files[index]),
                scope: requestScope,
                checkpoint: required(entry.uploads[index]),
                saveCheckpoint: async (checkpoint) => {
                  entry = (await update(key, entry.id, (current) => {
                    if (current.kind !== "bug") throw new Error("提交类型不一致。");
                    return {
                      ...current,
                      uploads: current.uploads.map((old, i) =>
                        i === index ? mergeCheckpoint(old, checkpoint) : old,
                      ),
                    };
                  })) as PendingBug;
                },
              }),
            );
          } catch (cause) {
            await rejectIfDefinite(key, entry.id, cause, "upload");
            throw cause;
          }
          assertProjectRequest(requestScope);
        }
        // This exact body is durable before the first commit request (and any replay).
        entry = (await update(key, entry.id, (current) => {
          if (current.kind !== "bug") throw new Error("提交类型不一致。");
          const input = { ...current.input, attachmentIds };
          return {
            ...current,
            input,
            requestBody:
              current.requestBody ??
              JSON.stringify({
                submissionContractVersion: "1.1.0",
                ...input,
                captureBundleId: null,
              }),
          };
        })) as PendingBug;
        assertProjectRequest(requestScope);
        entry = (await prepareCommit(key, entry)) as PendingBug;
        assertProjectRequest(requestScope);
        const response =
          entry.response ??
          (await transport
            .create(entry.input, requestScope, required(entry.requestBody))
            .catch(async (cause: unknown) => {
              await rejectIfDefinite(key, entry.id, cause, "commit", entry.commitAttempts);
              throw cause;
            }));
        if (
          response.clientSubmissionId !== entry.id ||
          response.bug.projectId !== scope.projectId ||
          response.bug.reporterId !== scope.actorId ||
          response.qaItem.id !== response.bug.id
        )
          throw new Error("服务返回的提交归属不一致，原提交仍保留待确认。");
        entry = (await update(
          key,
          entry.id,
          (current) => ({ ...current, response: current.response ?? response }) as PendingBug,
        )) as PendingBug;
      }
      assertProjectRequest(requestScope);
      return {
        response: required(entry.response),
        receiptId: entry.id,
        matchesDraft: entry.fingerprint === fingerprint,
      };
    },
    async comment(
      scope: SubmissionScope,
      bugId: string,
      body: string,
      previousReceiptId?: string,
      resumeOnly = false,
      replaceRejectedId?: string,
    ) {
      const requestScope = projectRequestSnapshot({}, scope.projectId);
      const key = keyFor(scope, `comment:${bugId}`);
      const fingerprint = body;
      const id = crypto.randomUUID();
      const candidate: PendingComment = {
        kind: "comment",
        id,
        scope: { ...scope },
        fingerprint,
        bugId,
        body: body.trim(),
        requestBody: JSON.stringify({ clientSubmissionId: id, body: body.trim() }),
      };
      let entry = (await claim(
        key,
        candidate,
        previousReceiptId,
        resumeOnly,
        replaceRejectedId,
      )) as PendingComment;
      assertProjectRequest(requestScope);
      if (entry.rejection) throw new Error("上次处理记录已被明确拒绝；请保留记录并提交修改稿。");
      if (!entry.response) {
        entry = (await prepareCommit(key, entry)) as PendingComment;
        assertProjectRequest(requestScope);
        const response =
          entry.response ??
          (await transport
            .comment(entry.bugId, entry.body, entry.id, requestScope, entry.requestBody)
            .catch(async (cause: unknown) => {
              await rejectIfDefinite(key, entry.id, cause, "commit", entry.commitAttempts);
              throw cause;
            }));
        if (
          response.comment.clientSubmissionId !== entry.id ||
          response.correlationId !== entry.id ||
          response.comment.bugId !== bugId ||
          response.comment.authorId !== scope.actorId ||
          response.comment.body !== entry.body
        )
          throw new Error("服务返回的处理记录归属不一致，原提交仍保留待确认。");
        entry = (await update(
          key,
          entry.id,
          (current) => ({ ...current, response: current.response ?? response }) as PendingComment,
        )) as PendingComment;
      }
      assertProjectRequest(requestScope);
      return {
        response: required(entry.response),
        receiptId: entry.id,
        matchesDraft: entry.fingerprint === fingerprint,
      };
    },
  };
}

export const durableSubmissions = pendingSubmissions();
