import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Real HTTP caller supplied by the test or isolated-runtime evidence recorder. */
export async function exerciseGmBusinessLoop(call, { token, projectId, userId }) {
  const submission = randomUUID();
  const created = await call("non-member GM creates assigned Bug", "POST", "/api/v1/bugs", {
    token,
    projectId,
    expected: 201,
    key: `submission:${submission}:commit`,
    body: {
      submissionContractVersion: "1.1.0",
      projectId,
      clientSubmissionId: submission,
      title: "GM 非成员人工闭环验收",
      description: "GM 普通成员已撤销",
      expectedBehavior: "独立 GM 权限保留人工操作",
      severity: "S3",
      priority: "P3",
      ownerId: userId,
      verificationOwnerId: userId,
      occurrence: {
        observedAt: new Date().toISOString(),
        platform: "web",
        steps: ["不恢复 GM 的普通成员身份"],
        actualBehavior: "核验创建、编辑、评论及人工闭环",
      },
      attachmentIds: [],
    },
  });
  assert.ok(created.bug?.id);
  let bug = created.bug;
  const path = `/api/v1/bugs/${bug.id}`;
  bug = await call("non-member GM edits Bug with CAS", "PATCH", path, {
    token,
    projectId,
    key: `gm-test:${randomUUID()}`,
    body: { expectedVersion: bug.version, description: "非成员 GM 已实际修改描述" },
  });
  assert.equal(bug.description, "非成员 GM 已实际修改描述");
  const commentId = randomUUID();
  await call("non-member GM comments", "POST", `${path}/comments`, {
    token,
    projectId,
    expected: 201,
    key: `comment:${bug.id}:${commentId}`,
    body: { clientSubmissionId: commentId, body: "GM 非成员评论读回证明" },
  });
  const comments = await call("GM comment body reads back", "GET", `${path}/comments`, {
    token,
    projectId,
  });
  assert.ok(comments.items.some((item) => item.body === "GM 非成员评论读回证明"));
  const action = (label, body) =>
    call(label, "POST", `/api/v1/projects/${projectId}/bugs/${bug.id}/actions`, {
      token,
      projectId,
      key: `gm-test:${randomUUID()}`,
      body,
    });
  for (const status of ["failed", "passed"]) {
    const done = await action("non-member GM manually completes", {
      action: "manual_complete",
      expectedVersion: bug.version,
      note: "人工完成，继续本地验收",
    });
    bug = done.bug;
    assert.equal(bug.state, "ready_for_verification");
    const context = await call(
      "non-member GM reads human workflow",
      "GET",
      `${path}/human-workflow`,
      { token, projectId },
    );
    const verification = await action("non-member GM creates verification", {
      action: "create_verification",
      expectedVersion: bug.version,
      request: {
        repairAttemptId: context.repairAttempt.id,
        buildId: null,
        verifierId: userId,
        criteria: "GM 无普通成员也能人工验收",
      },
    });
    const started = await action("non-member GM starts verification", {
      action: "start_verification",
      verificationId: verification.result.id,
      expectedVersion: verification.result.version,
    });
    const result = await action(
      status === "failed"
        ? "non-member GM rejects verification"
        : "non-member GM accepts and closes",
      {
        action: status === "failed" ? "reject" : "close",
        verificationId: started.result.id,
        expectedVersion: started.result.version,
        request: {
          submissionContractVersion: "1.1.0",
          clientSubmissionId: randomUUID(),
          resultSummary: status === "failed" ? "第一次验收退回" : "第二次验收通过",
          ...(status === "failed" ? { failureReason: "仍需修改" } : {}),
          attachmentIds: [],
        },
      },
    );
    bug = result.bug;
    assert.equal(bug.state, status === "failed" ? "ready" : "closed");
  }
  const final = await call("closed GM Bug final readback", "GET", path, { token, projectId });
  const workflow = await call(
    "GM final acceptance history retained",
    "GET",
    `${path}/human-workflow`,
    { token, projectId },
  );
  assert.equal(final.state, "closed");
  assert.equal(workflow.latestVerification.status, "passed");
  return { bugId: final.id, bugKey: final.key, state: final.state, version: final.version };
}
