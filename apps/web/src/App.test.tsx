import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App, {
  canActAsVerificationActor,
  canSaveBugDetailDraft,
  canCompleteDeliveredTask,
  canManuallyCompleteBug,
  canDirectCloseBug,
  canReturnCompletedBug,
  canSubmitVerificationOutcome,
  canSubmitNewBug,
  canTerminateRepairAttempt,
  collectClipboardImages,
  frozenVerificationResultMatchesScope,
  mergeCreateBugImages,
  mutationLabelForScope,
  repairAttemptAllowsNewWork,
  runRecoverableVerificationStep,
  selectableQingyuDefectIds,
  updateQingyuDefectSelection,
  verificationUploadCheckpointForReuse,
  workspaceChromeForDesktop,
} from "./App";
import {
  freezeVerificationResultRequest,
  QaHubApiError,
  type BugDetail,
  type RepairAttempt,
  type UploadCheckpoint,
} from "./api";
import { product } from "./product";

describe("Relay QA Hub browser workbench", () => {
  it("keeps manual completion available independently of executor and assignee", () => {
    for (const state of ["reported", "needs_info", "ready", "in_progress"] as const)
      expect(canManuallyCompleteBug(state)).toBe(true);
    for (const state of [
      "awaiting_build",
      "ready_for_verification",
      "closed",
      "duplicate",
      "rejected",
      "deferred",
    ] as const)
      expect(canManuallyCompleteBug(state)).toBe(false);
  });
  it("keeps exactly four task statuses and exposes the shared overview", () => {
    const markup = renderToStaticMarkup(
      <App
        onSignOut={() => undefined}
        onDraftChange={async () => undefined}
        principal={{
          accountId: "10000000-0000-4000-8000-000000000001",
          userId: "10000000-0000-4000-8000-000000000003",
          email: "luodongle@qa.local",
          displayName: "罗东乐",
          csrfToken: "test-csrf",
        }}
        signingOut={false}
      />,
    );

    expect(markup).not.toContain("统一事实源");
    expect(markup).toContain('aria-label="QA Hub 连接中"');
    expect(markup).toContain("工作台");
    expect(markup).toContain("总览");
    expect(markup).toContain("用户管理");
    expect(markup).not.toContain("打包下载");
    expect(markup).not.toContain("正在读取可下载文件");
    expect(markup).toContain("待处理");
    expect(markup).toContain("处理中");
    expect(markup).toContain("已完成待验收");
    expect(markup).toContain("关闭");
    expect(markup.match(/class="summary-label"/gu)).toHaveLength(4);
    expect(markup).not.toContain("等待构建");
    expect(markup).not.toContain("待构建");
    expect(markup).not.toContain("待关闭");
    expect(markup).not.toContain("提报人确认");
    expect(markup).not.toContain("全部 Bug · 表格视图");
    expect(markup).toContain("人员范围");
    expect(markup).toContain("新建 Bug");
    expect(markup).not.toContain("从轻语导入");
    expect(markup).not.toContain("验证无效项目错误");
    expect(markup.match(/class="nav-item is-active"/gu)).toHaveLength(1);
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
  });

  it("exposes the build and frozen contract versions", () => {
    expect(product.appVersion).toBe("1.0.0");
    expect(product.contractVersion).toBe("1.1.0");
  });

  it("keeps project switching and component history out of the desktop workspace", () => {
    expect(workspaceChromeForDesktop({} as Window["qaHubDesktop"])).toEqual({
      showProjectSwitcher: false,
      showComponentHistory: false,
    });
    expect(workspaceChromeForDesktop(undefined)).toEqual({
      showProjectSwitcher: true,
      showComponentHistory: true,
    });
  });

  it("collects supported clipboard images and gives them upload-safe names", () => {
    const png = new File([new Uint8Array([1, 2, 3])], "image.png", {
      type: "image/png",
      lastModified: 1,
    });
    const gif = new File([new Uint8Array([4])], "image.gif", {
      type: "image/gif",
      lastModified: 2,
    });
    const pasted = collectClipboardImages(
      [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "", getAsFile: () => png },
        { kind: "file", type: "image/gif", getAsFile: () => gif },
      ],
      1234,
    );

    expect(pasted).toHaveLength(1);
    expect(pasted[0]?.name).toBe("clipboard-1234-1.png");
    expect(pasted[0]?.type).toBe("image/png");
    expect(pasted[0]?.size).toBe(3);
  });

  it("appends supported images without duplicating the same selected file", () => {
    const png = new File([new Uint8Array([1])], "same.png", {
      type: "image/png",
      lastModified: 99,
    });
    const text = new File(["not an image"], "notes.txt", {
      type: "text/plain",
      lastModified: 100,
    });

    expect(mergeCreateBugImages([png], [png, text])).toEqual([png]);
  });

  it("allows creating a Bug without assigning a fixer", () => {
    expect(canSubmitNewBug(null, "verifier-id")).toBe(true);
    expect(canSubmitNewBug("正在提交", "verifier-id")).toBe(false);
    expect(canSubmitNewBug(null, "")).toBe(false);
  });

  it("keeps a slow mutation scoped to its own Bug", () => {
    const mutations = new Map([
      ["bug:bug-a", "正在保存 Bug A"],
      ["create-bug", "正在创建 Bug"],
    ]);

    expect(mutationLabelForScope(mutations, "bug:bug-a")).toBe("正在保存 Bug A");
    expect(mutationLabelForScope(mutations, "bug:bug-b")).toBeNull();
    expect(mutationLabelForScope(mutations, "create-bug")).toBe("正在创建 Bug");
  });

  it("supports selecting multiple eligible Qingyu defects without selecting imported or terminal ones", () => {
    const defects = [
      { id: "defect-1", actionable: true, importedBugId: null },
      { id: "defect-2", actionable: true, importedBugId: null },
      { id: "defect-3", actionable: false, importedBugId: null },
      { id: "defect-4", actionable: true, importedBugId: "bug-4" },
    ];

    expect(selectableQingyuDefectIds(defects)).toEqual(["defect-1", "defect-2"]);
    const first = updateQingyuDefectSelection([], "defect-1", true);
    const both = updateQingyuDefectSelection(first, "defect-2", true);
    expect(updateQingyuDefectSelection(both, "defect-2", true)).toEqual(["defect-1", "defect-2"]);
    expect(updateQingyuDefectSelection(both, "defect-1", false)).toEqual(["defect-2"]);
  });

  it("offers the same acceptance actions for both completed workflow stages", () => {
    for (const state of ["awaiting_build", "ready_for_verification"] as const) {
      for (const status of [null, "requested", "in_progress"] as const) {
        expect(canDirectCloseBug(state, true, status)).toBe(true);
        expect(canReturnCompletedBug(state, true, status)).toBe(true);
      }
      expect(canManuallyCompleteBug(state)).toBe(false);
      expect(canDirectCloseBug(state, false, null)).toBe(false);
      for (const status of ["passed", "failed", "blocked"] as const) {
        expect(canDirectCloseBug(state, true, status)).toBe(false);
        expect(canReturnCompletedBug(state, true, status)).toBe(false);
      }
    }
    expect(canDirectCloseBug("in_progress", true, null)).toBe(false);
    expect(canDirectCloseBug("closed", true, "passed")).toBe(false);
  });

  it("keeps lifecycle eligibility separate from verifier authorization", () => {
    expect(canReturnCompletedBug("awaiting_build", true, null)).toBe(true);
    expect(canReturnCompletedBug("ready_for_verification", true, null)).toBe(true);
    expect(canReturnCompletedBug("ready_for_verification", true, "requested")).toBe(true);
    expect(canReturnCompletedBug("ready_for_verification", true, "in_progress")).toBe(true);
    expect(canReturnCompletedBug("awaiting_build", false, null)).toBe(false);
    expect(canReturnCompletedBug("in_progress", true, null)).toBe(false);
  });

  it("requires an explicit reason for failed or blocked acceptance while allowing a pass", () => {
    expect(canSubmitVerificationOutcome("passed", "", null)).toBe(true);
    expect(canSubmitVerificationOutcome("failed", "", null)).toBe(false);
    expect(canSubmitVerificationOutcome("blocked", "  device unavailable  ", null)).toBe(true);
    expect(canSubmitVerificationOutcome("passed", "verified", "正在提交")).toBe(false);
  });

  it("offers terminal controls only for an active repair and allows new work after it ends", () => {
    const attempt: RepairAttempt = {
      id: "40000000-0000-4000-8000-000000000001",
      bugId: "20000000-0000-4000-8000-000000000001",
      sequence: 1,
      mode: "external",
      status: "planned",
      assigneeId: "10000000-0000-4000-8000-000000000003",
      parentAttemptId: null,
      summary: null,
      branch: null,
      commitSha: null,
      mergeRequestUrl: null,
      targetBuildId: null,
      version: 1,
    };

    for (const status of ["planned", "queued", "running", "needs_input", "blocked"] as const) {
      expect(canTerminateRepairAttempt({ ...attempt, status })).toBe(true);
      expect(repairAttemptAllowsNewWork({ ...attempt, status })).toBe(false);
    }
    for (const status of ["failed", "verification_failed", "cancelled", "superseded"] as const) {
      expect(canTerminateRepairAttempt({ ...attempt, status })).toBe(false);
      expect(repairAttemptAllowsNewWork({ ...attempt, status })).toBe(true);
    }
  });

  it("keeps finalized Verification attachment identity while leasing incomplete uploads", () => {
    const incomplete: UploadCheckpoint = {
      clientAttachmentId: "50000000-0000-4000-8000-000000000001",
      sha256: "a".repeat(64),
      init: { sessionId: "upload-1", chunkSize: 1024, version: 1 },
      nextChunk: 1,
      version: 2,
    };
    const finalized: UploadCheckpoint = {
      ...incomplete,
      finalized: {
        attachmentId: "50000000-0000-4000-8000-000000000002",
        readyToBind: true,
        version: 3,
      },
    };
    const bound: UploadCheckpoint = {
      ...finalized,
      binding: {
        bindingId: "50000000-0000-4000-8000-000000000003",
        attachmentId: "50000000-0000-4000-8000-000000000002",
        projectId: "30000000-0000-4000-8000-000000000001",
        clientSubmissionId: "70000000-0000-4000-8000-000000000001",
        clientAttachmentId: finalized.clientAttachmentId,
        leaseGeneration: 1,
        intent: "verification_result",
        targetQaItemId: "20000000-0000-4000-8000-000000000001",
        status: "reserved",
        expiresAt: new Date(1_200_000).toISOString(),
        version: 4,
        replayed: false,
      },
      bound: true,
    };
    const legacyBound: UploadCheckpoint = { ...finalized, bound: true };

    expect(
      verificationUploadCheckpointForReuse(
        { checkpoint: incomplete, updatedAt: 999_000 },
        1_000_000,
      ),
    ).toBe(incomplete);
    expect(
      verificationUploadCheckpointForReuse({ checkpoint: incomplete, updatedAt: 0 }, 1_000_000),
    ).toBeUndefined();
    expect(
      verificationUploadCheckpointForReuse(
        { checkpoint: incomplete, updatedAt: 1_000_001 },
        1_000_000,
      ),
    ).toBeUndefined();
    expect(
      verificationUploadCheckpointForReuse({ checkpoint: finalized, updatedAt: 0 }, 1_000_000),
    ).toBe(finalized);
    expect(
      verificationUploadCheckpointForReuse({ checkpoint: bound, updatedAt: 0 }, 1_000_000),
    ).toBe(bound);
    expect(
      verificationUploadCheckpointForReuse({ checkpoint: bound, updatedAt: 0 }, 1_000_000, 300_000),
    ).toBeUndefined();
    expect(
      verificationUploadCheckpointForReuse({ checkpoint: legacyBound, updatedAt: 0 }, 1_000_000),
    ).toBeUndefined();
    if (bound.binding === undefined) throw new Error("Bound checkpoint fixture is invalid");
    expect(
      verificationUploadCheckpointForReuse(
        {
          checkpoint: {
            ...bound,
            binding: { ...bound.binding, expiresAt: new Date(1_000_000).toISOString() },
          },
          updatedAt: 0,
        },
        1_000_000,
      ),
    ).toBeUndefined();
  });

  it("binds verification actions to current project visibility and the actual Verification actor", () => {
    const actorId = "10000000-0000-4000-8000-000000000011";
    const otherActorId = "10000000-0000-4000-8000-000000000012";
    const projectId = "30000000-0000-4000-8000-000000000001";
    const bugId = "20000000-0000-4000-8000-000000000001";
    const authority = { actorId, projectId, snapshotSequence: 17, bugIds: [bugId] };
    const scopedBug = { id: bugId, projectId };
    const ownVerification = { bugId, verifierId: actorId };
    const otherVerification = { bugId, verifierId: otherActorId };

    expect(canActAsVerificationActor(authority, actorId, scopedBug, 17, null)).toBe(true);
    expect(canActAsVerificationActor(authority, actorId, scopedBug, 17, ownVerification)).toBe(
      true,
    );
    expect(canActAsVerificationActor(authority, actorId, scopedBug, 17, otherVerification)).toBe(
      false,
    );
    expect(canActAsVerificationActor(authority, otherActorId, scopedBug, 17, null)).toBe(false);
    expect(canActAsVerificationActor(authority, actorId, scopedBug, 18, null)).toBe(false);
    expect(
      canActAsVerificationActor(
        authority,
        actorId,
        { ...scopedBug, projectId: "30000000-0000-4000-8000-000000000002" },
        17,
        null,
      ),
    ).toBe(false);
    expect(
      canActAsVerificationActor(
        authority,
        actorId,
        { ...scopedBug, id: "20000000-0000-4000-8000-000000000002" },
        17,
        null,
      ),
    ).toBe(false);
    expect(
      canActAsVerificationActor(authority, actorId, scopedBug, 17, {
        ...ownVerification,
        bugId: "20000000-0000-4000-8000-000000000002",
      }),
    ).toBe(false);
  });

  it("keeps a frozen Verification result scoped to project, actor, Bug, attempt, and draft", () => {
    const request = freezeVerificationResultRequest({
      verificationId: "50000000-0000-4000-8000-000000000010",
      expectedVersion: 3,
      resultSummary: "Frozen summary",
      clientSubmissionId: "70000000-0000-4000-8000-000000000010",
      status: "passed",
      attachmentIds: ["60000000-0000-4000-8000-000000000010"],
      captureBundleId: "80000000-0000-4000-8000-000000000010",
    });
    const scope = {
      projectId: "30000000-0000-4000-8000-000000000001",
      actorId: "10000000-0000-4000-8000-000000000003",
      bugId: "20000000-0000-4000-8000-000000000001",
      repairAttemptId: "40000000-0000-4000-8000-000000000001",
      draftKey: "20000000-0000-4000-8000-000000000001:40000000-0000-4000-8000-000000000001",
    };
    const frozen = { ...request, ...scope };

    expect(frozenVerificationResultMatchesScope(frozen, scope)).toBe(true);
    for (const [key, value] of Object.entries(scope)) {
      expect(
        frozenVerificationResultMatchesScope(frozen, {
          ...scope,
          [key]: `${value}-different`,
        }),
      ).toBe(false);
    }
  });

  it("reconciles a committed Verification write instead of surfacing a SQLite error", async () => {
    let attempts = 0;
    const result = await runRecoverableVerificationStep(
      async () => {
        attempts += 1;
        throw new QaHubApiError(500, "ERR_SQLITE_ERROR");
      },
      async () => ({ status: "committed", value: "already-written" }),
      async () => undefined,
    );

    expect(result).toBe("already-written");
    expect(attempts).toBe(1);
  });

  it("retries an uncommitted transient Verification write exactly once", async () => {
    let attempts = 0;
    const result = await runRecoverableVerificationStep(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new QaHubApiError(503, "STORAGE_WRITE_TEMPORARILY_UNAVAILABLE");
        return "written-after-retry";
      },
      async () => ({ status: "retry" }),
      async () => undefined,
    );

    expect(result).toBe("written-after-retry");
    expect(attempts).toBe(2);
  });

  it("replaces a repeated SQLite failure with a stable Verification error", async () => {
    await expect(
      runRecoverableVerificationStep(
        async () => {
          throw new QaHubApiError(500, "ERR_SQLITE_ERROR");
        },
        async () => ({ status: "retry" }),
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "VERIFICATION_WRITE_TEMPORARILY_UNAVAILABLE",
    });
  });

  it("offers completion for an existing delivered task that still awaits a Build", () => {
    expect(canCompleteDeliveredTask("awaiting_build", "delivered")).toBe(true);
    expect(canCompleteDeliveredTask("in_progress", "delivered")).toBe(false);
    expect(canCompleteDeliveredTask("awaiting_build", "running")).toBe(false);
  });

  it("only enables detail saving for a valid changed versioned draft", () => {
    const bug: BugDetail = {
      id: "20000000-0000-4000-8000-000000000001",
      projectId: "30000000-0000-4000-8000-000000000001",
      number: 1,
      key: "LOCAL-1",
      title: "原始标题",
      description: "原始问题描述",
      expectedBehavior: "原始预期行为",
      moduleId: null,
      state: "reported",
      severity: "S2",
      priority: "P2",
      reporterId: "10000000-0000-4000-8000-000000000001",
      ownerId: null,
      verificationOwnerId: "10000000-0000-4000-8000-000000000002",
      duplicateOfBugId: null,
      occurrenceCount: 1,
      reopenCount: 0,
      version: 7,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      closedAt: null,
    };
    const unchangedDraft = {
      expectedVersion: bug.version,
      title: bug.title,
      description: bug.description,
      expectedBehavior: bug.expectedBehavior,
      moduleId: bug.moduleId,
      severity: bug.severity,
      priority: bug.priority,
    };

    expect(canSaveBugDetailDraft(unchangedDraft, bug, null, false)).toBe(false);
    expect(canSaveBugDetailDraft(unchangedDraft, bug, null, false, 1)).toBe(true);
    expect(
      canSaveBugDetailDraft(
        { ...unchangedDraft, description: "补充后的问题描述" },
        bug,
        null,
        false,
      ),
    ).toBe(true);
    expect(
      canSaveBugDetailDraft(
        { ...unchangedDraft, description: "补充后的问题描述" },
        bug,
        null,
        true,
      ),
    ).toBe(false);
    expect(canSaveBugDetailDraft({ ...unchangedDraft, title: "   " }, bug, null, false)).toBe(
      false,
    );
  });
});
