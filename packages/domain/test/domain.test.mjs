import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { evaluateAppFirstBehavior } from "../../contracts/versions/1.1.0/src/evaluate-app-first-behavior.mjs";
import * as domain from "../dist/index.js";

const {
  BUG_STATES,
  CONTRACT_VERSION,
  RELAY_AUTOMATION_TARGET_STATES,
  isBugState,
  isRelayAutomationTargetState,
  isRepairStatus,
  isTerminalBugState,
} = domain;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REQUEST_DIGEST = "d".repeat(64);
const LINEAGE_ID = "80000000-0000-4000-8000-000000000001";
const FROZEN_EVENT_AGGREGATE_TYPES = new Set([
  "bug",
  "repair_attempt",
  "build",
  "verification",
  "upload",
  "notification",
  "integration",
]);
const FROZEN_DURABLE_PAYLOAD_KEYS = new Set([
  "summary",
  "reason",
  "status",
  "relatedBugId",
  "repairAttemptId",
  "buildId",
  "verificationId",
  "attachmentId",
  "captureId",
  "handoffId",
  "commentId",
  "occurrenceId",
  "commitSha",
  "attachmentCount",
  "fromVersion",
  "toVersion",
]);
function contextId(sequence) {
  return `90000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function entityId(label) {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function defaultProjectActorFacts() {
  return [
    {
      accountId: "account-1",
      userId: "user-triager",
      projectId: "project-1",
      currentActive: true,
      assignable: true,
      canVerify: true,
      authorizedRoles: ["triager", "developer", "verifier", "release_manager"],
    },
    {
      accountId: "account-1",
      userId: "user-developer",
      projectId: "project-1",
      currentActive: true,
      assignable: true,
      canVerify: true,
      authorizedRoles: ["developer", "verifier"],
    },
    {
      accountId: "account-1",
      userId: "user-developer-2",
      projectId: "project-1",
      currentActive: true,
      assignable: true,
      canVerify: false,
      authorizedRoles: ["developer"],
    },
    {
      accountId: "account-1",
      userId: "user-verifier",
      projectId: "project-1",
      currentActive: true,
      assignable: false,
      canVerify: true,
      authorizedRoles: ["verifier"],
    },
    {
      accountId: "account-1",
      userId: "user-release-manager",
      projectId: "project-1",
      currentActive: true,
      assignable: true,
      canVerify: false,
      authorizedRoles: ["developer", "release_manager"],
    },
    {
      accountId: "account-1",
      userId: "user-other",
      projectId: "project-1",
      currentActive: true,
      assignable: false,
      canVerify: false,
      authorizedRoles: [],
    },
  ];
}

function baseContext(overrides = {}) {
  return {
    actor: {
      type: "user",
      id: "user-triager",
      roles: ["triager", "developer", "verifier", "release_manager"],
    },
    now: "2026-08-25T00:00:00.000Z",
    eventId: contextId(13),
    outboxMessageId: contextId(1_013),
    requestDigest: REQUEST_DIGEST,
    correlationId: contextId(2_013),
    causationId: null,
    idempotencyKey: "idempotency-13",
    projectPolicy: {
      separationRequiredSeverities: ["S0", "S1"],
      codeDeliveryRequiresBuild: true,
    },
    projectActorFacts: defaultProjectActorFacts(),
    ...overrides,
  };
}

function baseSnapshot(overrides = {}) {
  const bugOverrides = overrides.bug ?? {};
  return {
    accountId: "account-1",
    projectId: "project-1",
    bug: {
      id: entityId("bug-1"),
      projectId: "project-1",
      severity: "S1",
      state: "reported",
      version: 4,
      reopenCount: 0,
      activeRepairAttemptId: null,
      activeVerificationId: null,
      duplicateOfBugId: null,
      ...bugOverrides,
    },
    repairAttempts: overrides.repairAttempts ?? [],
    buildRequirements: overrides.buildRequirements ?? [],
    builds: overrides.builds ?? [],
    buildLinks: overrides.buildLinks ?? [],
    verifications: overrides.verifications ?? [],
    duplicateFacts: overrides.duplicateFacts ?? [],
    closureAcceptanceFact: overrides.closureAcceptanceFact ?? null,
    occurrenceFacts: overrides.occurrenceFacts ?? [],
    occurrenceBuildLineageFacts: overrides.occurrenceBuildLineageFacts ?? [],
    buildLineageEntries: overrides.buildLineageEntries ?? [],
    eventSequence: overrides.eventSequence ?? 12,
  };
}

function runningAttempt(overrides = {}) {
  return {
    id: entityId("attempt-1"),
    bugId: entityId("bug-1"),
    sequence: 1,
    mode: "human",
    status: "running",
    assigneeId: "user-developer",
    parentAttemptId: null,
    summary: null,
    branch: null,
    commitSha: null,
    mergeRequestUrl: null,
    patchUrl: null,
    noCodeReason: null,
    targetBuildId: null,
    version: 2,
    ...overrides,
  };
}

function deliveredAttempt(overrides = {}) {
  return runningAttempt({
    status: "delivered",
    summary: "Fix delivered",
    branch: "fix/bug-1",
    commitSha: SHA_A,
    version: 3,
    ...overrides,
  });
}

function requiredBuildRequirement(overrides = {}) {
  return {
    id: "requirement-1",
    projectId: "project-1",
    bugId: entityId("bug-1"),
    repairAttemptId: entityId("attempt-1"),
    sourceDeliveryVersion: 3,
    deliveredCommitSha: SHA_A,
    requirement: "required",
    decisionBasis: "code_requires_build",
    decisionReason: null,
    decisionActorId: "user-developer",
    decisionAuditEventId: "event-delivery",
    deliveryRequestDigest: REQUEST_DIGEST,
    linkedBuildId: null,
    linkId: null,
    policyVersion: "1.0.0",
    bugVersionAtDelivery: 7,
    version: 1,
    ...overrides,
  };
}

function noBuildRequirement(overrides = {}) {
  return requiredBuildRequirement({
    deliveredCommitSha: null,
    requirement: "not_required",
    decisionBasis: "no_code_delivery",
    decisionReason: "Configuration-only correction",
    linkedBuildId: null,
    linkId: null,
    version: 1,
    ...overrides,
  });
}

function readyBuild(overrides = {}) {
  return {
    id: entityId("build-1"),
    projectId: "project-1",
    provider: "ozdqp",
    externalId: "job-1",
    status: "ready",
    branch: "fix/bug-1",
    sourceCommitSha: SHA_A,
    manifestCommitShas: [SHA_A],
    version: 2,
    ...overrides,
  };
}

function linkedBuildLink(overrides = {}) {
  return {
    id: entityId("build-link-1"),
    projectId: "project-1",
    bugId: entityId("bug-1"),
    buildId: entityId("build-1"),
    repairAttemptId: entityId("attempt-1"),
    buildRequirementId: "requirement-1",
    buildRequirementVersion: 2,
    deliveredCommitSha: SHA_A,
    evidenceType: "manifest",
    evidenceDecision: "manifest_verified",
    overrideReason: null,
    evidenceActorId: "user-release-manager",
    evidenceAuditEventId: "event-build-link",
    evidencePolicyVersion: "1.0.0",
    linkedAt: "2026-08-25T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function requestedVerification(overrides = {}) {
  return {
    id: entityId("verification-1"),
    bugId: entityId("bug-1"),
    repairAttemptId: entityId("attempt-1"),
    buildId: null,
    status: "requested",
    verifierId: "user-verifier",
    criteriaSnapshot: "Regression no longer reproduces",
    resultSummary: null,
    version: 1,
    ...overrides,
  };
}

function closureAcceptanceFact(overrides = {}) {
  return {
    accountId: "account-1",
    projectId: "project-1",
    bugId: entityId("bug-1"),
    verificationId: entityId("verification-1"),
    closeEventId: contextId(8_001),
    closeEventType: "verification.result_recorded",
    closeEventPosition: 100,
    actorUserId: "user-verifier",
    closedAt: "2026-08-25T00:10:00.000Z",
    closureGeneration: 2,
    closedBugVersion: 9,
    baselineKind: "verified_build",
    baselineBuildId: entityId("build-1"),
    baselineLineageId: LINEAGE_ID,
    baselineOrdinal: 4,
    ...overrides,
  };
}

function occurrenceFact(overrides = {}) {
  return {
    id: entityId("occurrence-new"),
    accountId: "account-1",
    projectId: "project-1",
    bugId: entityId("bug-1"),
    appendEventId: contextId(8_002),
    appendEventType: "occurrence.appended",
    appendEventPosition: 102,
    buildId: entityId("build-2"),
    createdAt: "2026-08-25T00:11:00.000Z",
    ...overrides,
  };
}

function buildLineageEntryFact(overrides = {}) {
  return {
    accountId: "account-1",
    projectId: "project-1",
    lineageId: LINEAGE_ID,
    buildId: entityId("build-1"),
    ordinal: 4,
    predecessorBuildId: entityId("build-0"),
    evidenceEventId: contextId(8_010),
    evidenceEventType: "build.lineage_entry_recorded",
    evidenceEventPosition: 99,
    policyVersion: "1.0.0",
    ...overrides,
  };
}

function occurrenceBuildLineageFact(overrides = {}) {
  return {
    accountId: "account-1",
    projectId: "project-1",
    bugId: entityId("bug-1"),
    occurrenceId: entityId("occurrence-new"),
    buildId: entityId("build-2"),
    lineageId: LINEAGE_ID,
    ordinal: 5,
    appendEventId: contextId(8_002),
    appendEventPosition: 102,
    ...overrides,
  };
}

function decide(snapshot, command, context = baseContext()) {
  assert.equal(
    typeof domain.decideDomainCommand,
    "function",
    "P1.2 requires decideDomainCommand(snapshot, command, context)",
  );
  return domain.decideDomainCommand(snapshot, command, context);
}

function assertDecisionError(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function assertFrozenTypedEvent(event) {
  assert.equal(FROZEN_EVENT_AGGREGATE_TYPES.has(event.aggregateType), true);
  assert.equal(event.payload !== null && typeof event.payload === "object", true);
  assert.equal(Array.isArray(event.payload), false);
  assert.equal(Buffer.byteLength(JSON.stringify(event.payload), "utf8") <= 4_096, true);
  assert.equal(
    Object.keys(event.payload).every((key) => FROZEN_DURABLE_PAYLOAD_KEYS.has(key)),
    true,
  );
  assert.equal(
    Object.values(event.payload).every(
      (value) => value === null || ["string", "number", "boolean"].includes(typeof value),
    ),
    true,
  );
  assert.equal(
    evaluateAppFirstBehavior("audit-payload", { payload: event.payload }),
    "valid",
    "Domain's actual durable payload must satisfy the frozen 1.1 audit evaluator",
  );
}

test("exports the frozen contract vocabulary", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
  assert.equal(BUG_STATES.length, 10);
  assert.equal(isBugState("ready_for_verification"), true);
  assert.equal(isBugState("fixed"), false);
  assert.equal(isRepairStatus("verification_failed"), true);
  assert.deepEqual(domain.DOMAIN_EVENT_UUID_PAYLOAD_KEYS, [
    "relatedBugId",
    "repairAttemptId",
    "buildId",
    "verificationId",
    "attachmentId",
    "captureId",
    "handoffId",
    "commentId",
    "occurrenceId",
  ]);
});

test("keeps acceptance and closure human-owned", () => {
  assert.deepEqual(RELAY_AUTOMATION_TARGET_STATES, [
    "ready",
    "in_progress",
    "awaiting_build",
    "ready_for_verification",
  ]);
  assert.equal(isRelayAutomationTargetState("closed"), false);
  assert.equal(isRelayAutomationTargetState("rejected"), false);
  assert.equal(isRelayAutomationTargetState("duplicate"), false);
  assert.equal(isTerminalBugState("closed"), true);
  assert.equal(isTerminalBugState("ready_for_verification"), false);
});

test("runtime consumers cannot mutate Relay authority into acceptance", () => {
  assert.equal(Object.isFrozen(RELAY_AUTOMATION_TARGET_STATES), true);
  assert.throws(() => RELAY_AUTOMATION_TARGET_STATES.push("closed"), TypeError);
  assert.throws(() => {
    RELAY_AUTOMATION_TARGET_STATES[0] = "closed";
  }, TypeError);
  assert.equal(isRelayAutomationTargetState("closed"), false);
});

test("exports the pure P1.2 decision API", () => {
  assert.equal(typeof domain.decideDomainCommand, "function");
  assert.equal(typeof domain.DomainDecisionError, "function");
});

test("triages reported Bug to ready with one monotonic version and append plans", () => {
  const snapshot = baseSnapshot();
  const original = structuredClone(snapshot);
  const result = decide(snapshot, {
    type: "transitionBug",
    toState: "ready",
    expectedVersion: 4,
    triage: { requiredFieldsComplete: true },
  });

  assert.deepEqual(snapshot, original, "the pure decision must not mutate its input");
  assert.equal(result.nextSnapshot.bug.id, entityId("bug-1"));
  assert.equal(result.nextSnapshot.bug.projectId, "project-1");
  assert.equal(result.nextSnapshot.bug.state, "ready");
  assert.equal(result.nextSnapshot.bug.version, 5);
  assert.equal(result.nextSnapshot.eventSequence, 13);
  assert.deepEqual(result.event, {
    operation: "append",
    schemaVersion: "1.0",
    projectionVersion: "1.1.0",
    redactionPolicyVersion: "1.0.0",
    id: contextId(13),
    source: "qa_hub",
    accountId: "account-1",
    projectId: "project-1",
    bugId: entityId("bug-1"),
    sequence: 13,
    type: "bug.triage.ready",
    aggregateType: "bug",
    aggregateId: entityId("bug-1"),
    aggregateVersion: 5,
    resourceType: "bug",
    resourceId: entityId("bug-1"),
    resourceVersionAfter: 5,
    actorType: "user",
    actorId: "user-triager",
    requestDigest: REQUEST_DIGEST,
    correlationId: contextId(2_013),
    causationId: null,
    idempotencyKey: "idempotency-13",
    fromState: "reported",
    toState: "ready",
    occurredAt: "2026-08-25T00:00:00.000Z",
    payload: {
      status: "ready",
      fromVersion: 4,
      toVersion: 5,
    },
  });
  assert.deepEqual(result.outbox, [
    {
      operation: "append",
      id: contextId(1_013),
      type: "notification.requested",
      aggregateType: "bug",
      aggregateId: entityId("bug-1"),
      aggregateVersion: 5,
      causationEventId: contextId(13),
      recipientUserIds: [],
    },
  ]);
});

test("rejects illegal Bug transitions without mutating the snapshot", () => {
  const snapshot = baseSnapshot({ bug: { state: "reported" } });
  const original = structuredClone(snapshot);

  assertDecisionError("INVALID_TRANSITION", () =>
    decide(snapshot, {
      type: "transitionBug",
      toState: "awaiting_build",
      expectedVersion: 4,
    }),
  );
  assert.deepEqual(snapshot, original);
});

test("needs-info resolves one current same-project responsible member into the Outbox plan", () => {
  const command = {
    type: "transitionBug",
    toState: "needs_info",
    expectedVersion: 4,
    reason: "Please provide a current capture",
    responsibleUserId: "user-developer",
  };
  const result = decide(baseSnapshot(), command);
  assert.equal(result.nextSnapshot.bug.state, "needs_info");
  assert.deepEqual(result.outbox[0].recipientUserIds, ["user-developer"]);

  for (const fact of [
    {
      accountId: "account-1",
      projectId: "project-2",
      userId: "user-developer",
      currentActive: true,
      assignable: true,
      canVerify: false,
    },
    {
      accountId: "account-1",
      projectId: "project-1",
      userId: "user-developer",
      currentActive: false,
      assignable: true,
      canVerify: false,
    },
  ]) {
    assertDecisionError("GUARD_FAILED", () =>
      decide(baseSnapshot(), command, baseContext({ projectActorFacts: [fact] })),
    );
  }
});

test("requires exact expectedVersion and never accepts future or stale versions", () => {
  for (const expectedVersion of [3, 5]) {
    const snapshot = baseSnapshot();
    const original = structuredClone(snapshot);
    assertDecisionError("VERSION_CONFLICT", () =>
      decide(snapshot, {
        type: "transitionBug",
        toState: "ready",
        expectedVersion,
        triage: { requiredFieldsComplete: true },
      }),
    );
    assert.deepEqual(snapshot, original);
  }
});

test("marks a same-project canonical Bug duplicate while rejecting self, cross-project, and cycles", () => {
  const eligible = baseSnapshot({
    bug: { state: "ready" },
    duplicateFacts: [{ id: entityId("bug-2"), projectId: "project-1", duplicateOfBugId: null }],
  });
  const result = decide(eligible, {
    type: "markBugDuplicate",
    canonicalBugId: entityId("bug-2"),
    reason: "Same underlying defect",
    expectedVersion: 4,
  });
  assert.equal(result.nextSnapshot.bug.state, "duplicate");
  assert.equal(result.nextSnapshot.bug.duplicateOfBugId, entityId("bug-2"));
  assert.equal(result.nextSnapshot.bug.version, 5);
  assert.equal(result.event.type, "bug.mark_duplicate");

  assertDecisionError("INVALID_REQUEST", () =>
    decide(eligible, {
      type: "markBugDuplicate",
      canonicalBugId: entityId("bug-2"),
      reason: "",
      expectedVersion: 4,
    }),
  );

  assertDecisionError("GUARD_FAILED", () =>
    decide(baseSnapshot({ bug: { state: "ready" } }), {
      type: "markBugDuplicate",
      canonicalBugId: entityId("bug-1"),
      reason: "Self relation is invalid",
      expectedVersion: 4,
    }),
  );
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      baseSnapshot({
        bug: { state: "ready" },
        duplicateFacts: [{ id: entityId("bug-2"), projectId: "project-2", duplicateOfBugId: null }],
      }),
      {
        type: "markBugDuplicate",
        canonicalBugId: entityId("bug-2"),
        reason: "Cross-project relation is invalid",
        expectedVersion: 4,
      },
    ),
  );
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      baseSnapshot({
        bug: { state: "ready" },
        duplicateFacts: [
          { id: entityId("bug-2"), projectId: "project-1", duplicateOfBugId: entityId("bug-3") },
          { id: entityId("bug-3"), projectId: "project-1", duplicateOfBugId: entityId("bug-1") },
        ],
      }),
      {
        type: "markBugDuplicate",
        canonicalBugId: entityId("bug-2"),
        reason: "Cyclic relation is invalid",
        expectedVersion: 4,
      },
    ),
  );
});

test("accepts planned UUIDv7 references and rejects non-RFC9562 durable references", () => {
  const uuidV7 = "11111111-1111-7111-8111-111111111111";
  const validSnapshot = baseSnapshot({
    bug: { state: "ready" },
    duplicateFacts: [{ id: uuidV7, projectId: "project-1", duplicateOfBugId: null }],
  });
  const valid = decide(validSnapshot, {
    type: "markBugDuplicate",
    canonicalBugId: uuidV7,
    reason: "Same underlying defect",
    expectedVersion: 4,
  });
  assert.equal(valid.event.payload.relatedBugId, uuidV7);
  assertFrozenTypedEvent(valid.event);

  for (const invalidCanonicalId of [
    "not-a-uuid",
    "11111111-1111-0111-8111-111111111111",
    "11111111-1111-9111-8111-111111111111",
    "11111111-1111-7111-7111-111111111111",
  ]) {
    const snapshot = baseSnapshot({
      bug: { state: "ready" },
      duplicateFacts: [{ id: invalidCanonicalId, projectId: "project-1", duplicateOfBugId: null }],
    });
    const original = structuredClone(snapshot);
    assertDecisionError("INVALID_REQUEST", () =>
      decide(snapshot, {
        type: "markBugDuplicate",
        canonicalBugId: invalidCanonicalId,
        reason: "Same underlying defect",
        expectedVersion: 4,
      }),
    );
    assert.deepEqual(snapshot, original);
  }
});

test("reopens a closed Bug only for a later server-ranked Build occurrence", () => {
  const closed = baseSnapshot({
    bug: {
      state: "closed",
      version: 10,
      reopenCount: 2,
      closedAt: "2026-08-25T00:10:00.000Z",
    },
    repairAttempts: [deliveredAttempt()],
    builds: [readyBuild(), readyBuild({ id: entityId("build-2"), sourceCommitSha: SHA_B })],
    verifications: [
      requestedVerification({ buildId: entityId("build-1"), status: "passed", version: 3 }),
    ],
    closureAcceptanceFact: closureAcceptanceFact(),
    buildLineageEntries: [
      buildLineageEntryFact(),
      buildLineageEntryFact({
        buildId: entityId("build-2"),
        ordinal: 5,
        predecessorBuildId: entityId("build-1"),
        evidenceEventId: contextId(8_011),
        evidenceEventPosition: 101,
      }),
    ],
    occurrenceFacts: [
      occurrenceFact(),
      occurrenceFact({
        id: entityId("occurrence-stale"),
        appendEventId: contextId(8_003),
        appendEventPosition: 103,
        buildId: entityId("build-1"),
      }),
    ],
    occurrenceBuildLineageFacts: [
      occurrenceBuildLineageFact(),
      occurrenceBuildLineageFact({
        occurrenceId: entityId("occurrence-stale"),
        buildId: entityId("build-1"),
        ordinal: 4,
        appendEventId: contextId(8_003),
        appendEventPosition: 103,
      }),
    ],
  });
  const result = decide(closed, {
    type: "reopenBug",
    expectedVersion: 10,
    occurrenceId: entityId("occurrence-new"),
  });
  assert.equal(result.nextSnapshot.bug.state, "ready");
  assert.equal(result.nextSnapshot.bug.version, 11);
  assert.equal(result.nextSnapshot.bug.reopenCount, 3);
  assert.equal(result.event.type, "bug.reopen.newer_occurrence");

  assertDecisionError("GUARD_FAILED", () =>
    decide(closed, {
      type: "reopenBug",
      expectedVersion: 10,
      occurrenceId: entityId("occurrence-stale"),
    }),
  );

  for (const createdAt of ["2026-08-25T00:10:00.000Z", "2026-08-25T00:09:59.999Z"]) {
    assertDecisionError("GUARD_FAILED", () =>
      decide(
        {
          ...closed,
          occurrenceFacts: closed.occurrenceFacts.map((occurrence) =>
            occurrence.id === entityId("occurrence-new")
              ? { ...occurrence, createdAt }
              : occurrence,
          ),
        },
        {
          type: "reopenBug",
          expectedVersion: 10,
          occurrenceId: entityId("occurrence-new"),
        },
      ),
    );
  }

  assertDecisionError("GUARD_FAILED", () =>
    decide(
      {
        ...closed,
        buildLineageEntries: [],
        occurrenceBuildLineageFacts: [],
      },
      {
        type: "reopenBug",
        expectedVersion: 10,
        occurrenceId: entityId("occurrence-new"),
      },
    ),
  );

  assertDecisionError("GUARD_FAILED", () =>
    decide(
      {
        ...closed,
        closureAcceptanceFact: closureAcceptanceFact({
          baselineKind: "no_build",
          baselineBuildId: null,
          baselineLineageId: null,
          baselineOrdinal: null,
        }),
        verifications: [requestedVerification({ status: "passed", version: 3 })],
      },
      {
        type: "reopenBug",
        expectedVersion: 10,
        occurrenceId: entityId("occurrence-new"),
      },
    ),
  );
});

test("creates and starts one RepairAttempt with exact identity and monotonic versions", () => {
  const ready = baseSnapshot({ bug: { state: "ready" } });
  const created = decide(ready, {
    type: "createRepairAttempt",
    expectedVersion: 4,
    attemptId: entityId("attempt-1"),
    mode: "human",
    assigneeId: "user-developer",
    parentAttemptId: null,
    summary: null,
  });
  assert.equal(created.nextSnapshot.bug.id, entityId("bug-1"));
  assert.equal(created.nextSnapshot.bug.state, "in_progress");
  assert.equal(created.nextSnapshot.bug.version, 5);
  assert.equal(created.nextSnapshot.bug.activeRepairAttemptId, entityId("attempt-1"));
  assert.deepEqual(created.nextSnapshot.repairAttempts, [
    {
      id: entityId("attempt-1"),
      bugId: entityId("bug-1"),
      sequence: 1,
      mode: "human",
      status: "planned",
      assigneeId: "user-developer",
      parentAttemptId: null,
      summary: null,
      branch: null,
      commitSha: null,
      mergeRequestUrl: null,
      patchUrl: null,
      noCodeReason: null,
      targetBuildId: null,
      version: 1,
    },
  ]);
  assert.equal(created.event.type, "repair_attempt.created");
  assert.equal(created.event.aggregateType, "repair_attempt");
  assert.equal(created.event.aggregateId, entityId("attempt-1"));
  assert.equal(created.event.aggregateVersion, 1);

  const started = decide(
    created.nextSnapshot,
    {
      type: "startRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 1,
    },
    baseContext({ eventId: contextId(14), outboxMessageId: contextId(1_014) }),
  );
  assert.equal(started.nextSnapshot.bug.version, 5, "starting the Attempt does not rewrite Bug");
  assert.equal(started.nextSnapshot.repairAttempts[0].id, entityId("attempt-1"));
  assert.equal(started.nextSnapshot.repairAttempts[0].status, "running");
  assert.equal(started.nextSnapshot.repairAttempts[0].version, 2);
  assert.equal(started.event.type, "repair_attempt.started");
  assert.equal(started.event.aggregateType, "repair_attempt");
  assert.equal(started.event.aggregateVersion, 2);
});

test("create RepairAttempt resolves a complete same-Bug acyclic parent chain", () => {
  const parent = runningAttempt({ status: "superseded", version: 3 });
  const eligible = baseSnapshot({
    bug: { state: "ready" },
    repairAttempts: [parent],
  });
  const baseCommand = {
    type: "createRepairAttempt",
    expectedVersion: 4,
    attemptId: entityId("attempt-2"),
    mode: "human",
    assigneeId: "user-developer",
    parentAttemptId: entityId("attempt-1"),
    summary: "Continue from the prior attempt",
  };
  const created = decide(eligible, baseCommand);
  assert.equal(created.nextSnapshot.repairAttempts.at(-1).parentAttemptId, entityId("attempt-1"));

  assertDecisionError("GUARD_FAILED", () =>
    decide(eligible, {
      ...baseCommand,
      parentAttemptId: null,
    }),
  );
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      baseSnapshot({
        bug: { state: "ready" },
        repairAttempts: [
          parent,
          runningAttempt({
            id: entityId("attempt-terminal-2"),
            sequence: 2,
            status: "failed",
            parentAttemptId: entityId("attempt-1"),
          }),
        ],
      }),
      baseCommand,
    ),
  );

  assertDecisionError("GUARD_FAILED", () =>
    decide(baseSnapshot({ bug: { state: "ready" } }), {
      ...baseCommand,
      parentAttemptId: entityId("attempt-2"),
    }),
  );
  assertDecisionError("GUARD_FAILED", () =>
    decide(baseSnapshot({ bug: { state: "ready" } }), baseCommand),
  );
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      baseSnapshot({
        bug: { state: "ready" },
        repairAttempts: [
          parent,
          runningAttempt({ id: entityId("attempt-foreign"), bugId: entityId("bug-2") }),
        ],
      }),
      { ...baseCommand, parentAttemptId: entityId("attempt-foreign") },
    ),
  );
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      baseSnapshot({
        bug: { state: "ready" },
        repairAttempts: [
          runningAttempt({ status: "superseded", parentAttemptId: entityId("attempt-cycle") }),
          runningAttempt({
            id: entityId("attempt-cycle"),
            sequence: 2,
            status: "superseded",
            parentAttemptId: entityId("attempt-1"),
          }),
        ],
      }),
      baseCommand,
    ),
  );
});

test("rejects a second active RepairAttempt and an already-corrupt double-active snapshot", () => {
  const oneActive = baseSnapshot({
    bug: { state: "in_progress", activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  assertDecisionError("ACTIVE_REPAIR_EXISTS", () =>
    decide(oneActive, {
      type: "createRepairAttempt",
      expectedVersion: 4,
      attemptId: entityId("attempt-2"),
      mode: "relay",
      assigneeId: "user-developer-2",
      parentAttemptId: entityId("attempt-1"),
      summary: null,
    }),
  );

  const twoActive = baseSnapshot({
    bug: { state: "in_progress", activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [
      runningAttempt(),
      runningAttempt({ id: entityId("attempt-2"), sequence: 2, mode: "relay", status: "queued" }),
    ],
  });
  assertDecisionError("ACTIVE_REPAIR_EXISTS", () =>
    decide(twoActive, {
      type: "startRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
    }),
  );
});

test("rejects illegal RepairAttempt status transitions and stale Attempt CAS", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt({ status: "planned", version: 1 })],
  });
  assertDecisionError("INVALID_TRANSITION", () =>
    decide(snapshot, {
      type: "deliverRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 1,
      summary: "Cannot deliver before start",
      deliveryKind: "code",
      branch: "fix/bug-1",
      commitSha: SHA_A,
      buildRequirementId: "requirement-1",
    }),
  );
  assertDecisionError("VERSION_CONFLICT", () =>
    decide(snapshot, {
      type: "startRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
    }),
  );
});

test("failing an active RepairAttempt preserves history and returns the Bug to ready", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const result = decide(snapshot, {
    type: "failRepairAttempt",
    attemptId: entityId("attempt-1"),
    expectedVersion: 2,
    reason: "The approach did not solve the defect",
  });
  assert.equal(result.nextSnapshot.bug.state, "ready");
  assert.equal(result.nextSnapshot.bug.version, 6);
  assert.equal(result.nextSnapshot.bug.activeRepairAttemptId, null);
  assert.equal(result.nextSnapshot.repairAttempts[0].id, entityId("attempt-1"));
  assert.equal(result.nextSnapshot.repairAttempts[0].status, "failed");
  assert.equal(result.nextSnapshot.repairAttempts[0].version, 3);
  assert.equal(result.event.type, "repair_attempt.failed");
  assert.deepEqual([result.event.fromState, result.event.toState], ["in_progress", "ready"]);
  assertFrozenTypedEvent(result.event);
  assert.equal(result.event.payload.status, "failed");
  assert.equal(result.event.payload.reason, "The approach did not solve the defect");
  assert.equal(result.event.payload.repairAttemptId, entityId("attempt-1"));
  assert.equal(result.event.payload.fromVersion, 2);
  assert.equal(result.event.payload.toVersion, 3);
});

test("preserves a legal long failure reason while bounding the durable Event projection", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const reason = "证".repeat(1_500);
  const result = decide(snapshot, {
    type: "failRepairAttempt",
    attemptId: entityId("attempt-1"),
    expectedVersion: 2,
    reason,
  });
  assert.equal(result.nextSnapshot.repairAttempts[0].failureReason, reason);
  assert.notEqual(result.event.payload.reason, reason);
  assert.match(result.event.payload.reason, /…$/u);
  assertFrozenTypedEvent(result.event);

  const original = structuredClone(snapshot);
  assertDecisionError("INVALID_REQUEST", () =>
    decide(snapshot, {
      type: "failRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
      reason: "F".repeat(5_001),
    }),
  );
  assert.deepEqual(snapshot, original);
});

test("redacts credential-like human text from the durable Event without changing aggregate truth", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  for (const reason of [
    "Authorization: Bearer secret-token",
    "Coo\u200Bkie： session=abc",
    "password = hunter2",
    "https://user:pass@example.invalid/private",
    "eyJabcdefgh.abcdef.abcdef",
    "Aut\u200ehorization: Be\u200earer super-secret-token",
    "credential: abcdef",
    String.raw`C:\Users\lin0\token.txt`,
    String.raw`\\server\share\private.txt`,
    String.raw`Regex \d is still redacted at the audit boundary`,
  ]) {
    const result = decide(snapshot, {
      type: "failRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
      reason,
    });
    assert.equal(result.nextSnapshot.repairAttempts[0].failureReason, reason);
    assert.equal(result.event.payload.reason, "[REDACTED]");
    assertFrozenTypedEvent(result.event);
  }
});

test("supersedes an active Attempt by atomically creating exactly one child successor", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const result = decide(snapshot, {
    type: "supersedeRepairAttempt",
    attemptId: entityId("attempt-1"),
    expectedVersion: 2,
    reason: "Continue with Relay",
    representation: "vendor-1.1",
    successor: {
      id: entityId("attempt-2"),
      mode: "relay",
      assigneeId: "user-developer-2",
    },
  });
  assert.equal(result.nextSnapshot.bug.state, "in_progress");
  assert.equal(result.nextSnapshot.bug.version, 6);
  assert.equal(result.nextSnapshot.bug.activeRepairAttemptId, entityId("attempt-2"));
  assert.deepEqual(
    result.nextSnapshot.repairAttempts.map(
      ({ id, sequence, status, parentAttemptId, version }) => ({
        id,
        sequence,
        status,
        parentAttemptId,
        version,
      }),
    ),
    [
      {
        id: entityId("attempt-1"),
        sequence: 1,
        status: "superseded",
        parentAttemptId: null,
        version: 3,
      },
      {
        id: entityId("attempt-2"),
        sequence: 2,
        status: "planned",
        parentAttemptId: entityId("attempt-1"),
        version: 1,
      },
    ],
  );
  assert.equal(result.event.type, "repair_attempt.superseded");
  assertFrozenTypedEvent(result.event);
  assert.equal(result.event.payload.status, "superseded");
  assert.equal(result.event.payload.reason, "Continue with Relay");
  assert.equal(result.event.payload.repairAttemptId, entityId("attempt-1"));
  assert.equal(result.event.payload.successorAttemptId, undefined);
  assert.equal(result.event.payload.replacementMode, undefined);
  assert.equal(result.event.payload.fromVersion, 2);
  assert.equal(result.event.payload.toVersion, 3);
  assert.equal(result.nextSnapshot.repairAttempts[1].summary, null);
});

test("code delivery freezes a required BuildRequirement and moves the Bug to awaiting_build", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const result = decide(
    snapshot,
    {
      type: "deliverRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
      summary: "Fix delivered",
      deliveryKind: "code",
      branch: "fix/bug-1",
      commitSha: SHA_A,
      buildRequirementId: "requirement-1",
    },
    baseContext({
      actor: { type: "user", id: "user-developer", roles: ["developer"] },
      eventId: contextId(100),
      outboxMessageId: contextId(1_100),
    }),
  );

  assert.equal(result.nextSnapshot.bug.state, "awaiting_build");
  assert.equal(result.nextSnapshot.bug.version, 6);
  assert.equal(result.nextSnapshot.repairAttempts[0].status, "delivered");
  assert.equal(result.nextSnapshot.repairAttempts[0].version, 3);
  assert.equal(result.nextSnapshot.repairAttempts[0].commitSha, SHA_A);
  assert.deepEqual(result.nextSnapshot.buildRequirements, [
    {
      id: "requirement-1",
      projectId: "project-1",
      bugId: entityId("bug-1"),
      repairAttemptId: entityId("attempt-1"),
      sourceDeliveryVersion: 3,
      deliveredCommitSha: SHA_A,
      requirement: "required",
      decisionBasis: "code_requires_build",
      decisionReason: null,
      decisionActorId: "user-developer",
      decisionAuditEventId: contextId(100),
      deliveryRequestDigest: REQUEST_DIGEST,
      linkedBuildId: null,
      linkId: null,
      policyVersion: "1.0.0",
      bugVersionAtDelivery: 6,
      version: 1,
    },
  ]);
  assert.equal(result.event.type, "repair_attempt.delivered");
  assert.deepEqual(
    [result.event.fromState, result.event.toState],
    ["in_progress", "awaiting_build"],
  );
  assertFrozenTypedEvent(result.event);
  assert.equal(result.event.payload.status, "delivered");
  assert.equal(result.event.payload.summary, "Fix delivered");
  assert.equal(result.event.payload.repairAttemptId, entityId("attempt-1"));
  assert.equal(result.event.payload.commitSha, SHA_A);
  assert.equal(result.event.payload.buildRequirementId, undefined);
  assert.equal(result.event.payload.requirement, undefined);
  assert.equal(result.event.payload.reason, undefined);
  assert.equal(result.event.payload.fromVersion, 2);
  assert.equal(result.event.payload.toVersion, 3);
  assert.deepEqual(
    [result.event.resourceType, result.event.resourceId, result.event.resourceVersionAfter],
    ["build_requirement", "requirement-1", 1],
  );
  assert.equal(result.outbox[0].causationEventId, result.event.id);
  assert.equal(result.outbox[0].aggregateVersion, 6);
});

test("code delivery resolves MR-only wire evidence into exact persisted branch and commit facts", () => {
  const mergeRequestUrl = "https://git.example.invalid/project/merge_requests/42";
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const result = decide(
    snapshot,
    {
      type: "deliverRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
      summary: "Resolved merge request delivery",
      deliveryKind: "code",
      mergeRequestUrl,
      buildRequirementId: "requirement-mr",
    },
    baseContext({
      actor: { type: "user", id: "user-developer", roles: ["developer"] },
      resolvedDeliveryEvidence: {
        branch: "fix/from-merge-request",
        commitSha: SHA_A,
        mergeRequestUrl,
        patchUrl: null,
      },
    }),
  );
  const attempt = result.nextSnapshot.repairAttempts[0];
  assert.equal(attempt.branch, "fix/from-merge-request");
  assert.equal(attempt.commitSha, SHA_A);
  assert.equal(attempt.mergeRequestUrl, mergeRequestUrl);
  assert.equal(attempt.patchUrl, null);
  assert.equal(result.nextSnapshot.buildRequirements[0].deliveredCommitSha, SHA_A);
});

test("an authorized code no-build exception is audited and reaches ready_for_verification", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const result = decide(
    snapshot,
    {
      type: "deliverRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
      summary: "Server-only configuration correction",
      deliveryKind: "code",
      branch: "fix/bug-1",
      commitSha: SHA_A,
      buildRequirementId: "requirement-1",
    },
    baseContext({
      actor: {
        type: "user",
        id: "user-release-manager",
        roles: ["developer", "release_manager"],
      },
      eventId: contextId(101),
      outboxMessageId: contextId(1_101),
      projectPolicy: {
        separationRequiredSeverities: ["S0", "S1"],
        codeDeliveryRequiresBuild: true,
        noBuildExemption: {
          authorized: true,
          reason: "No distributable artifact changes",
          policyVersion: "1.0.0",
        },
      },
    }),
  );

  assert.equal(result.nextSnapshot.bug.state, "ready_for_verification");
  assert.equal(result.nextSnapshot.bug.version, 6);
  assert.deepEqual(result.nextSnapshot.buildRequirements[0], {
    id: "requirement-1",
    projectId: "project-1",
    bugId: entityId("bug-1"),
    repairAttemptId: entityId("attempt-1"),
    sourceDeliveryVersion: 3,
    deliveredCommitSha: SHA_A,
    requirement: "not_required",
    decisionBasis: "authorized_no_build_exemption",
    decisionReason: "No distributable artifact changes",
    decisionActorId: "user-release-manager",
    decisionAuditEventId: contextId(101),
    deliveryRequestDigest: REQUEST_DIGEST,
    linkedBuildId: null,
    linkId: null,
    policyVersion: "1.0.0",
    bugVersionAtDelivery: 6,
    version: 1,
  });
});

test("no-code delivery records its reason and never fabricates a Build link", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt({ targetBuildId: "stale-build" })],
  });
  const result = decide(
    snapshot,
    {
      type: "deliverRepairAttempt",
      attemptId: entityId("attempt-1"),
      expectedVersion: 2,
      summary: "Updated the server-side test fixture",
      deliveryKind: "no_code",
      noCodeReason: "No app or game binary changed",
      buildRequirementId: "requirement-1",
    },
    baseContext({
      actor: { type: "user", id: "user-developer", roles: ["developer"] },
      eventId: contextId(102),
      outboxMessageId: contextId(1_102),
    }),
  );
  const requirement = result.nextSnapshot.buildRequirements[0];
  assert.equal(result.nextSnapshot.bug.state, "ready_for_verification");
  assert.equal(requirement.requirement, "not_required");
  assert.equal(requirement.decisionBasis, "no_code_delivery");
  assert.equal(requirement.decisionReason, "No app or game binary changed");
  assert.equal(requirement.deliveredCommitSha, null);
  assert.equal(requirement.linkedBuildId, null);
  assert.equal(requirement.linkId, null);
  assert.equal(result.nextSnapshot.repairAttempts[0].targetBuildId, null);
  assert.equal(result.nextSnapshot.repairAttempts[0].noCodeReason, "No app or game binary changed");
});

test("rejects an unauthorised attempt to exempt code delivery from a required Build", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      snapshot,
      {
        type: "deliverRepairAttempt",
        attemptId: entityId("attempt-1"),
        expectedVersion: 2,
        summary: "Try to skip the Build",
        deliveryKind: "code",
        branch: "fix/bug-1",
        commitSha: SHA_A,
        buildRequirementId: "requirement-1",
      },
      baseContext({
        actor: { type: "user", id: "user-developer", roles: ["developer"] },
        projectPolicy: {
          separationRequiredSeverities: ["S0", "S1"],
          codeDeliveryRequiresBuild: true,
          noBuildExemption: {
            authorized: false,
            reason: "Developer cannot approve their own exception",
            policyVersion: "1.0.0",
          },
        },
      }),
    ),
  );
});

test("links only a ready Build containing the exact delivered commit", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "awaiting_build",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [requiredBuildRequirement()],
    builds: [readyBuild()],
  });
  const result = decide(
    snapshot,
    {
      type: "linkBuildRepair",
      buildId: entityId("build-1"),
      repairAttemptId: entityId("attempt-1"),
      deliveredCommitSha: SHA_A,
      expectedVersion: 2,
      expectedBugVersion: 7,
      expectedBuildRequirementVersion: 1,
      evidenceType: "manifest",
      linkId: entityId("build-link-1"),
    },
    baseContext({
      actor: { type: "user", id: "user-release-manager", roles: ["release_manager"] },
      eventId: contextId(103),
      outboxMessageId: contextId(1_103),
    }),
  );
  assert.equal(result.nextSnapshot.bug.state, "ready_for_verification");
  assert.equal(result.nextSnapshot.bug.version, 8);
  assert.equal(result.nextSnapshot.builds[0].id, entityId("build-1"));
  assert.equal(result.nextSnapshot.builds[0].version, 3);
  assert.equal(result.nextSnapshot.buildRequirements[0].version, 2);
  assert.equal(result.nextSnapshot.buildRequirements[0].linkedBuildId, entityId("build-1"));
  assert.equal(result.nextSnapshot.buildRequirements[0].linkId, entityId("build-link-1"));
  assert.deepEqual(result.nextSnapshot.buildLinks, [
    linkedBuildLink({ evidenceAuditEventId: contextId(103) }),
  ]);
  assert.equal(result.event.type, "build.repair_linked");
  assert.equal(result.event.aggregateType, "repair_attempt");
  assert.equal(result.event.aggregateId, entityId("attempt-1"));
  assert.equal(result.event.aggregateVersion, 3);
  assert.deepEqual(
    [result.event.resourceType, result.event.resourceId, result.event.resourceVersionAfter],
    ["build_repair_link", entityId("build-link-1"), 1],
  );
  assertFrozenTypedEvent(result.event);
  assert.equal(result.event.payload.buildId, entityId("build-1"));
  assert.equal(result.event.payload.repairAttemptId, entityId("attempt-1"));
  assert.equal(result.event.payload.buildRequirementId, undefined);
  assert.equal(result.event.payload.linkId, undefined);
  assert.equal(result.event.payload.reason, undefined);
  assert.equal(result.outbox[0].causationEventId, contextId(103));
});

test("release-manager Build override requires an exact reason-bound operation authority fact", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "awaiting_build",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [requiredBuildRequirement()],
    builds: [readyBuild({ manifestCommitShas: [SHA_B] })],
  });
  const overrideReason = "Trusted canary provenance was reviewed";
  const command = {
    type: "linkBuildRepair",
    buildId: entityId("build-1"),
    repairAttemptId: entityId("attempt-1"),
    deliveredCommitSha: SHA_A,
    expectedVersion: 2,
    expectedBugVersion: 7,
    expectedBuildRequirementVersion: 1,
    evidenceType: "release_manager_override",
    overrideReason,
    linkId: entityId("build-link-1"),
  };
  const validAuthority = {
    accountId: "account-1",
    projectId: "project-1",
    actorId: "user-release-manager",
    canOverrideBuildEvidence: true,
    reason: overrideReason,
  };
  const originalSnapshot = structuredClone(snapshot);
  const releaseContext = (overrideAuthorityFact) =>
    baseContext({
      actor: { type: "user", id: "user-release-manager", roles: ["release_manager"] },
      eventId: contextId(104),
      outboxMessageId: contextId(1_104),
      ...(overrideAuthorityFact === undefined ? {} : { overrideAuthorityFact }),
    });

  for (const forged of [
    undefined,
    { ...validAuthority, canOverrideBuildEvidence: false },
    { ...validAuthority, accountId: "account-foreign" },
    { ...validAuthority, projectId: "project-foreign" },
    { ...validAuthority, actorId: "user-other" },
    { ...validAuthority, reason: "Different approved reason" },
  ]) {
    assertDecisionError("FORBIDDEN", () => decide(snapshot, command, releaseContext(forged)));
    assert.deepEqual(snapshot, originalSnapshot);
  }

  const result = decide(snapshot, command, releaseContext(validAuthority));
  assert.equal(result.nextSnapshot.bug.state, "ready_for_verification");
  assert.deepEqual(result.nextSnapshot.buildLinks, [
    linkedBuildLink({
      evidenceType: "release_manager_override",
      evidenceDecision: "release_manager_authorized",
      overrideReason,
      evidenceAuditEventId: contextId(104),
    }),
  ]);
  assert.equal(result.event.payload.reason, overrideReason);
  assertFrozenTypedEvent(result.event);
});

test("Build link uses exact Bug, Build, and BuildRequirement CAS", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "awaiting_build",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [requiredBuildRequirement()],
    builds: [readyBuild()],
  });
  const command = {
    type: "linkBuildRepair",
    buildId: entityId("build-1"),
    repairAttemptId: entityId("attempt-1"),
    deliveredCommitSha: SHA_A,
    expectedVersion: 2,
    expectedBugVersion: 7,
    expectedBuildRequirementVersion: 1,
    evidenceType: "manifest",
    linkId: entityId("build-link-1"),
  };

  for (const stale of [
    { expectedVersion: 1 },
    { expectedBugVersion: 6 },
    { expectedBuildRequirementVersion: 2 },
  ]) {
    assertDecisionError("VERSION_CONFLICT", () => decide(snapshot, { ...command, ...stale }));
  }
});

test("Build link rejects a forged or ambiguous frozen delivery decision", () => {
  const command = {
    type: "linkBuildRepair",
    buildId: entityId("build-1"),
    repairAttemptId: entityId("attempt-1"),
    deliveredCommitSha: SHA_A,
    expectedVersion: 2,
    expectedBugVersion: 7,
    expectedBuildRequirementVersion: 1,
    evidenceType: "manifest",
    linkId: entityId("build-link-1"),
  };
  const makeSnapshot = (requirements) =>
    baseSnapshot({
      bug: { state: "awaiting_build", version: 7, activeRepairAttemptId: entityId("attempt-1") },
      repairAttempts: [deliveredAttempt()],
      buildRequirements: requirements,
      builds: [readyBuild()],
    });
  for (const forged of [
    { projectId: "project-foreign" },
    { bugId: entityId("bug-foreign") },
    { sourceDeliveryVersion: 999 },
    { decisionBasis: "authorized_no_build_exemption" },
    { decisionActorId: "" },
    { decisionAuditEventId: "" },
    { deliveryRequestDigest: "bad" },
    { policyVersion: "0.0.0" },
  ]) {
    assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
      decide(makeSnapshot([requiredBuildRequirement(forged)]), command),
    );
  }
  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(
      makeSnapshot([
        requiredBuildRequirement(),
        requiredBuildRequirement({ id: "requirement-ambiguous" }),
      ]),
      command,
    ),
  );
});

test("rejects a wrong delivered SHA, non-ready Build, or manifest without the exact commit", () => {
  const makeSnapshot = (buildOverrides = {}) =>
    baseSnapshot({
      bug: {
        state: "awaiting_build",
        version: 7,
        activeRepairAttemptId: entityId("attempt-1"),
      },
      repairAttempts: [deliveredAttempt()],
      buildRequirements: [requiredBuildRequirement()],
      builds: [readyBuild(buildOverrides)],
    });
  const command = {
    type: "linkBuildRepair",
    buildId: entityId("build-1"),
    repairAttemptId: entityId("attempt-1"),
    deliveredCommitSha: SHA_A,
    expectedVersion: 2,
    expectedBugVersion: 7,
    expectedBuildRequirementVersion: 1,
    evidenceType: "manifest",
    linkId: entityId("build-link-1"),
  };

  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(makeSnapshot(), { ...command, deliveredCommitSha: SHA_B }),
  );
  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(makeSnapshot({ status: "failed" }), command),
  );
  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(makeSnapshot({ manifestCommitShas: [SHA_B] }), command),
  );
});

test("creates a Verification only for the latest delivered Attempt and committed no-build decision", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: null,
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
  });
  const result = decide(
    snapshot,
    {
      type: "createVerification",
      expectedVersion: 7,
      verificationId: entityId("verification-1"),
      repairAttemptId: entityId("attempt-1"),
      buildId: null,
      verifierId: "user-verifier",
      criteria: "Regression no longer reproduces",
    },
    baseContext({
      actor: { type: "user", id: "user-triager", roles: ["verifier"] },
      eventId: contextId(104),
      outboxMessageId: contextId(1_104),
    }),
  );
  assert.equal(result.nextSnapshot.bug.id, entityId("bug-1"));
  assert.equal(result.nextSnapshot.bug.version, 8);
  assert.equal(result.nextSnapshot.bug.activeVerificationId, entityId("verification-1"));
  assert.deepEqual(result.nextSnapshot.verifications, [requestedVerification()]);
  assert.equal(result.event.type, "verification.created");
  assert.equal(result.event.aggregateType, "verification");
  assert.equal(result.event.aggregateVersion, 1);
  assert.equal(result.event.actorId, "user-triager");
  assert.equal(result.nextSnapshot.verifications[0].verifierId, "user-verifier");
  assertFrozenTypedEvent(result.event);
  assert.equal(result.event.payload.status, "requested");
  assert.equal(result.event.payload.verificationId, entityId("verification-1"));
  assert.equal(result.event.payload.repairAttemptId, entityId("attempt-1"));
  assert.equal(result.event.payload.toVersion, 1);
});

test("requires the exact committed Build link before creating a required-build Verification", () => {
  const unlinked = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [requiredBuildRequirement()],
    builds: [readyBuild()],
  });
  const command = {
    type: "createVerification",
    expectedVersion: 7,
    verificationId: entityId("verification-1"),
    repairAttemptId: entityId("attempt-1"),
    buildId: entityId("build-1"),
    verifierId: "user-verifier",
    criteria: "Regression no longer reproduces",
  };
  assertDecisionError("BUILD_IDENTITY_MISMATCH", () => decide(unlinked, command));

  const linked = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [
      requiredBuildRequirement({
        linkedBuildId: entityId("build-1"),
        linkId: entityId("build-link-1"),
        version: 2,
      }),
    ],
    builds: [readyBuild({ version: 3 })],
    buildLinks: [linkedBuildLink()],
  });
  const result = decide(linked, { ...command, expectedVersion: 8 });
  assert.equal(result.nextSnapshot.verifications[0].buildId, entityId("build-1"));
  assert.equal(result.nextSnapshot.bug.version, 9);
});

test("S0 and S1 repairers cannot be assigned to verify their own Attempt", () => {
  for (const severity of ["S0", "S1"]) {
    const snapshot = baseSnapshot({
      bug: {
        severity,
        state: "ready_for_verification",
        version: 7,
        activeRepairAttemptId: entityId("attempt-1"),
      },
      repairAttempts: [
        deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
      ],
      buildRequirements: [noBuildRequirement()],
    });
    assertDecisionError("GUARD_FAILED", () =>
      decide(
        snapshot,
        {
          type: "createVerification",
          expectedVersion: 7,
          verificationId: `verification-${severity}`,
          repairAttemptId: entityId("attempt-1"),
          buildId: null,
          verifierId: "user-developer",
          criteria: "Self verification is forbidden",
        },
        baseContext({
          actor: { type: "user", id: "user-developer", roles: ["developer", "verifier"] },
        }),
      ),
    );
  }
});

test("separation of duties follows the project severity policy instead of blocking every severity", () => {
  const selfVerifiedS2 = baseSnapshot({
    bug: {
      severity: "S2",
      state: "ready_for_verification",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: null,
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-verifier" }),
    ],
    buildRequirements: [noBuildRequirement()],
  });
  const context = baseContext({
    actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
    projectPolicy: {
      separationRequiredSeverities: ["S0", "S1"],
      codeDeliveryRequiresBuild: true,
    },
  });
  const created = decide(
    selfVerifiedS2,
    {
      type: "createVerification",
      expectedVersion: 7,
      verificationId: entityId("verification-1"),
      repairAttemptId: entityId("attempt-1"),
      buildId: null,
      verifierId: "user-verifier",
      criteria: "S2 project policy permits the same verifier",
    },
    context,
  );
  const started = decide(
    created.nextSnapshot,
    { type: "startVerification", verificationId: entityId("verification-1"), expectedVersion: 1 },
    baseContext({
      ...context,
      eventId: contextId(105),
      outboxMessageId: contextId(1_105),
    }),
  );
  const passed = decide(
    started.nextSnapshot,
    {
      type: "recordVerificationResult",
      verificationId: entityId("verification-1"),
      expectedVersion: 2,
      status: "passed",
      resultSummary: "Policy-authorized verification passed",
    },
    baseContext({
      ...context,
      eventId: contextId(106),
      outboxMessageId: contextId(1_106),
    }),
  );
  assert.equal(passed.nextSnapshot.bug.state, "closed");

  assertDecisionError("GUARD_FAILED", () =>
    decide(
      selfVerifiedS2,
      {
        type: "createVerification",
        expectedVersion: 7,
        verificationId: entityId("verification-2"),
        repairAttemptId: entityId("attempt-1"),
        buildId: null,
        verifierId: "user-verifier",
        criteria: "S2 is now configured for separation",
      },
      baseContext({
        ...context,
        projectPolicy: {
          separationRequiredSeverities: ["S0", "S1", "S2"],
          codeDeliveryRequiresBuild: true,
        },
      }),
    ),
  );
});

test("Verification result rechecks every policy-required severity even for forged in-progress records", () => {
  for (const { severity, separationRequiredSeverities } of [
    { severity: "S0", separationRequiredSeverities: ["S0", "S1"] },
    { severity: "S1", separationRequiredSeverities: ["S0", "S1"] },
    { severity: "S2", separationRequiredSeverities: ["S0", "S1", "S2"] },
  ]) {
    const forged = baseSnapshot({
      bug: {
        severity,
        state: "ready_for_verification",
        version: 8,
        activeRepairAttemptId: entityId("attempt-1"),
        activeVerificationId: entityId("verification-1"),
      },
      repairAttempts: [
        deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-verifier" }),
      ],
      buildRequirements: [noBuildRequirement()],
      verifications: [requestedVerification({ status: "in_progress", version: 2 })],
    });
    assertDecisionError("GUARD_FAILED", () =>
      decide(
        forged,
        {
          type: "recordVerificationResult",
          verificationId: entityId("verification-1"),
          expectedVersion: 2,
          status: "passed",
          resultSummary: "Forged self-verification must not close the Bug",
        },
        baseContext({
          actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
          projectPolicy: {
            separationRequiredSeverities,
            codeDeliveryRequiresBuild: true,
          },
        }),
      ),
    );
  }
});

test("starts only the assigned requested Verification and increments only its version", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification()],
  });
  const result = decide(
    snapshot,
    {
      type: "startVerification",
      verificationId: entityId("verification-1"),
      expectedVersion: 1,
    },
    baseContext({
      actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
    }),
  );
  assert.equal(result.nextSnapshot.bug.version, 8);
  assert.equal(result.nextSnapshot.verifications[0].id, entityId("verification-1"));
  assert.equal(result.nextSnapshot.verifications[0].status, "in_progress");
  assert.equal(result.nextSnapshot.verifications[0].version, 2);
  assert.equal(result.event.type, "verification.started");

  assertDecisionError("FORBIDDEN", () =>
    decide(
      snapshot,
      {
        type: "startVerification",
        verificationId: entityId("verification-1"),
        expectedVersion: 1,
      },
      baseContext({ actor: { type: "user", id: "user-other", roles: ["verifier"] } }),
    ),
  );
  assertDecisionError("INVALID_TRANSITION", () =>
    decide(
      baseSnapshot({
        bug: {
          state: "ready_for_verification",
          version: 8,
          activeRepairAttemptId: entityId("attempt-1"),
          activeVerificationId: entityId("verification-1"),
        },
        repairAttempts: [deliveredAttempt()],
        buildRequirements: [noBuildRequirement()],
        verifications: [requestedVerification({ status: "passed", version: 3 })],
      }),
      {
        type: "startVerification",
        verificationId: entityId("verification-1"),
        expectedVersion: 3,
      },
      baseContext({
        actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
      }),
    ),
  );
});

test("a human pass atomically records Verification and closes the Bug", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  const result = decide(
    snapshot,
    {
      type: "recordVerificationResult",
      verificationId: entityId("verification-1"),
      expectedVersion: 2,
      status: "passed",
      resultSummary: "Verified on the target device",
    },
    baseContext({
      actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
      eventId: contextId(107),
      outboxMessageId: contextId(1_107),
    }),
  );
  assert.equal(result.nextSnapshot.bug.id, entityId("bug-1"));
  assert.equal(result.nextSnapshot.bug.state, "closed");
  assert.equal(result.nextSnapshot.bug.version, 9);
  assert.equal(result.nextSnapshot.bug.activeRepairAttemptId, null);
  assert.equal(result.nextSnapshot.bug.activeVerificationId, null);
  assert.equal(result.nextSnapshot.verifications[0].id, entityId("verification-1"));
  assert.equal(result.nextSnapshot.verifications[0].status, "passed");
  assert.equal(result.nextSnapshot.verifications[0].version, 3);
  assert.equal(result.nextSnapshot.repairAttempts[0].status, "delivered");
  assert.equal(result.nextSnapshot.repairAttempts[0].version, 3);
  assert.deepEqual(result.nextSnapshot.closureAcceptanceFact, {
    accountId: "account-1",
    projectId: "project-1",
    bugId: entityId("bug-1"),
    verificationId: entityId("verification-1"),
    closeEventId: contextId(107),
    closeEventType: "verification.result_recorded",
    closeEventPosition: 13,
    actorUserId: "user-verifier",
    closedAt: "2026-08-25T00:00:00.000Z",
    closureGeneration: 0,
    closedBugVersion: 9,
    baselineKind: "no_build",
    baselineBuildId: null,
    baselineLineageId: null,
    baselineOrdinal: null,
  });
  assert.deepEqual(result.closureAcceptanceFactAppend, result.nextSnapshot.closureAcceptanceFact);
  assert.equal(result.event.type, "verification.result_recorded");
  assert.equal(result.event.actorType, "user");
  assert.equal(result.outbox[0].causationEventId, result.event.id);
});

test("a failed Verification preserves history, fails the Attempt, and returns the Bug to ready", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  const result = decide(
    snapshot,
    {
      type: "recordVerificationResult",
      verificationId: entityId("verification-1"),
      expectedVersion: 2,
      status: "failed",
      resultSummary: "Still reproduces",
      failureReason: "The original crash remains",
    },
    baseContext({
      actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
    }),
  );
  assert.equal(result.nextSnapshot.bug.state, "ready");
  assert.equal(result.nextSnapshot.bug.version, 9);
  assert.equal(result.nextSnapshot.bug.activeRepairAttemptId, null);
  assert.equal(result.nextSnapshot.bug.activeVerificationId, null);
  assert.equal(result.nextSnapshot.verifications[0].status, "failed");
  assert.equal(result.nextSnapshot.verifications[0].version, 3);
  assert.equal(result.nextSnapshot.repairAttempts[0].status, "verification_failed");
  assert.equal(result.nextSnapshot.repairAttempts[0].version, 4);
});

test("a blocked Verification is legal but cannot close or fail the delivered Attempt", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  const result = decide(
    snapshot,
    {
      type: "recordVerificationResult",
      verificationId: entityId("verification-1"),
      expectedVersion: 2,
      status: "blocked",
      resultSummary: "Environment unavailable",
      blockedReason: "The target account is unavailable",
    },
    baseContext({
      actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
    }),
  );
  assert.equal(result.nextSnapshot.bug.state, "ready_for_verification");
  assert.equal(result.nextSnapshot.bug.version, 9);
  assert.equal(result.nextSnapshot.bug.activeRepairAttemptId, entityId("attempt-1"));
  assert.equal(result.nextSnapshot.bug.activeVerificationId, null);
  assert.equal(result.nextSnapshot.repairAttempts[0].status, "delivered");
  assert.equal(result.nextSnapshot.verifications[0].status, "blocked");
});

test("rejects result recording before Verification start and with stale Verification CAS", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification()],
  });
  const command = {
    type: "recordVerificationResult",
    verificationId: entityId("verification-1"),
    expectedVersion: 1,
    status: "passed",
    resultSummary: "Cannot pass before start",
  };
  assertDecisionError("INVALID_TRANSITION", () => decide(snapshot, command));

  const inProgress = baseSnapshot({
    ...snapshot,
    bug: snapshot.bug,
    repairAttempts: snapshot.repairAttempts,
    buildRequirements: snapshot.buildRequirements,
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  assertDecisionError("VERSION_CONFLICT", () => decide(inProgress, command));
});

test("runtime command discriminants fail closed before an internal caller can persist them", () => {
  assertDecisionError("INVALID_REQUEST", () =>
    decide(baseSnapshot({ bug: { state: "ready" } }), {
      type: "createRepairAttempt",
      expectedVersion: 4,
      attemptId: entityId("attempt-invalid-mode"),
      mode: "automatic",
      assigneeId: "user-developer",
      parentAttemptId: null,
      summary: null,
    }),
  );

  assertDecisionError("INVALID_REQUEST", () =>
    decide(
      baseSnapshot({
        bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
        repairAttempts: [runningAttempt()],
      }),
      {
        type: "supersedeRepairAttempt",
        attemptId: entityId("attempt-1"),
        expectedVersion: 2,
        reason: "Unsupported representation",
        representation: "internal-2.0",
      },
    ),
  );

  assertDecisionError("INVALID_REQUEST", () =>
    decide(
      baseSnapshot({
        bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
        repairAttempts: [runningAttempt()],
      }),
      {
        type: "deliverRepairAttempt",
        attemptId: entityId("attempt-1"),
        expectedVersion: 2,
        summary: "Unsupported delivery kind",
        deliveryKind: "artifact_only",
        buildRequirementId: "requirement-invalid-kind",
      },
    ),
  );

  assertDecisionError("INVALID_REQUEST", () =>
    decide(
      baseSnapshot(),
      {
        type: "linkBuildRepair",
        buildId: entityId("build-1"),
        repairAttemptId: entityId("attempt-1"),
        deliveredCommitSha: SHA_A,
        expectedVersion: 2,
        expectedBugVersion: 7,
        expectedBuildRequirementVersion: 1,
        evidenceType: "untyped_override",
        linkId: entityId("build-link-invalid-evidence"),
      },
      baseContext({
        actor: { type: "user", id: "user-release-manager", roles: ["release_manager"] },
      }),
    ),
  );

  const inProgress = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  assertDecisionError("INVALID_REQUEST", () =>
    decide(
      inProgress,
      {
        type: "recordVerificationResult",
        verificationId: entityId("verification-1"),
        expectedVersion: 2,
        status: "cancelled",
        resultSummary: "Not a record-result operation",
      },
      baseContext({
        actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
      }),
    ),
  );

  assertDecisionError("INVALID_REQUEST", () =>
    decide(baseSnapshot(), { type: "internalMutation", expectedVersion: 4 }),
  );
});

test("closing requires the latest passed human Verification bound to the active Attempt", () => {
  const noPass = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      noPass,
      {
        type: "transitionBug",
        toState: "closed",
        expectedVersion: 8,
        verificationId: entityId("verification-1"),
      },
      baseContext({
        actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
      }),
    ),
  );

  const oldPassIsNotLatest = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-2"),
    },
    repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
    buildRequirements: [noBuildRequirement()],
    verifications: [
      requestedVerification({ status: "passed", version: 3 }),
      requestedVerification({
        id: entityId("verification-2"),
        status: "in_progress",
        version: 2,
      }),
    ],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      oldPassIsNotLatest,
      {
        type: "transitionBug",
        toState: "closed",
        expectedVersion: 8,
        verificationId: entityId("verification-1"),
      },
      baseContext({
        actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
      }),
    ),
  );

  const latestPassed = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "passed", version: 3 })],
  });
  const closed = decide(
    latestPassed,
    {
      type: "transitionBug",
      toState: "closed",
      expectedVersion: 8,
      verificationId: entityId("verification-1"),
    },
    baseContext({
      actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
    }),
  );
  assert.equal(closed.nextSnapshot.bug.state, "closed");
  assert.equal(closed.nextSnapshot.bug.version, 9);
  assert.equal(closed.event.type, "bug.verification.passed");
});

test("Relay and every service principal are forbidden from accepting or closing a QA Bug", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  const serviceContext = baseContext({
    actor: {
      type: "service",
      id: "relay-service",
      roles: ["integration_service"],
    },
  });

  assertDecisionError("INTEGRATION_AUTOMATION_FORBIDDEN", () =>
    decide(
      snapshot,
      {
        type: "recordVerificationResult",
        verificationId: entityId("verification-1"),
        expectedVersion: 2,
        status: "passed",
        resultSummary: "Relay claims the fix is good",
      },
      serviceContext,
    ),
  );
  assertDecisionError("INTEGRATION_AUTOMATION_FORBIDDEN", () =>
    decide(
      baseSnapshot({
        bug: {
          state: "ready_for_verification",
          version: 8,
          activeRepairAttemptId: entityId("attempt-1"),
          activeVerificationId: entityId("verification-1"),
        },
        repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
        buildRequirements: [noBuildRequirement()],
        verifications: [requestedVerification({ status: "passed", version: 3 })],
      }),
      {
        type: "transitionBug",
        toState: "closed",
        expectedVersion: 8,
        verificationId: entityId("verification-1"),
      },
      serviceContext,
    ),
  );
});

test("generic close revalidates assigned verifier, separation, and Build eligibility", () => {
  const eligible = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "passed", version: 3 })],
  });
  const command = {
    type: "transitionBug",
    toState: "closed",
    expectedVersion: 8,
    verificationId: entityId("verification-1"),
  };

  assertDecisionError("FORBIDDEN", () =>
    decide(
      eligible,
      command,
      baseContext({ actor: { type: "user", id: "user-other", roles: ["verifier"] } }),
    ),
  );

  const selfVerified = baseSnapshot({
    ...eligible,
    bug: eligible.bug,
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-verifier" }),
    ],
    buildRequirements: eligible.buildRequirements,
    verifications: eligible.verifications,
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      selfVerified,
      command,
      baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
    ),
  );

  const missingBuildProof = baseSnapshot({
    bug: eligible.bug,
    repairAttempts: [deliveredAttempt({ assigneeId: "user-developer" })],
    buildRequirements: [],
    builds: [],
    buildLinks: [],
    verifications: [
      requestedVerification({
        status: "passed",
        version: 3,
        buildId: "missing-build",
      }),
    ],
  });
  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(
      missingBuildProof,
      command,
      baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
    ),
  );

  const reversedArrayWithActiveVerification = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-current"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [
      requestedVerification({
        id: entityId("verification-current"),
        status: "in_progress",
        version: 2,
      }),
      requestedVerification({ status: "passed", version: 3 }),
    ],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      reversedArrayWithActiveVerification,
      command,
      baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
    ),
  );
});

test("rejects forged release-manager override evidence at Verification result", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [
      requiredBuildRequirement({
        linkedBuildId: entityId("build-1"),
        linkId: entityId("build-link-1"),
        version: 2,
      }),
    ],
    builds: [readyBuild({ version: 3 })],
    buildLinks: [
      linkedBuildLink({
        evidenceType: "release_manager_override",
        evidenceDecision: "manifest_verified",
        overrideReason: null,
        evidenceActorId: "",
        evidenceAuditEventId: "",
      }),
    ],
    verifications: [
      requestedVerification({ status: "in_progress", version: 2, buildId: entityId("build-1") }),
    ],
  });

  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(
      snapshot,
      {
        type: "recordVerificationResult",
        verificationId: entityId("verification-1"),
        expectedVersion: 2,
        status: "passed",
        resultSummary: "Forged evidence must not close the Bug",
      },
      baseContext({
        actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
      }),
    ),
  );
});

test("rejects a code Attempt paired with a forged no-code BuildRequirement", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: null,
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [noBuildRequirement()],
  });
  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(
      snapshot,
      {
        type: "createVerification",
        expectedVersion: 7,
        verificationId: entityId("verification-1"),
        repairAttemptId: entityId("attempt-1"),
        buildId: null,
        verifierId: "user-verifier",
        criteria: "Forged no-code decision must fail closed",
      },
      baseContext({
        actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
      }),
    ),
  );
});

test("rejects a duplicate chain that leaves the resolved project", () => {
  const snapshot = baseSnapshot({
    bug: { state: "ready" },
    duplicateFacts: [
      { id: entityId("bug-2"), projectId: "project-1", duplicateOfBugId: entityId("bug-3") },
      { id: entityId("bug-3"), projectId: "project-2", duplicateOfBugId: null },
    ],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(snapshot, {
      type: "markBugDuplicate",
      canonicalBugId: entityId("bug-2"),
      reason: "Cross-project chain is invalid",
      expectedVersion: 4,
    }),
  );
});

test("snapshot binds duplicate state to exactly one canonical Bug identity", () => {
  const command = {
    type: "transitionBug",
    toState: "deferred",
    expectedVersion: 4,
    reason: "Do not preserve an invalid canonical pointer",
  };
  assertDecisionError("GUARD_FAILED", () =>
    decide(baseSnapshot({ bug: { state: "ready", duplicateOfBugId: entityId("bug-2") } }), command),
  );
  assertDecisionError("GUARD_FAILED", () =>
    decide(baseSnapshot({ bug: { state: "duplicate", duplicateOfBugId: null } }), command),
  );
});

test("a no-Build closure preserves delivered history but cannot claim a newer Build reopen", () => {
  const awaitingResult = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [
      deliveredAttempt({ branch: null, commitSha: null, assigneeId: "user-developer" }),
    ],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification({ status: "in_progress", version: 2 })],
  });
  const closed = decide(
    awaitingResult,
    {
      type: "recordVerificationResult",
      verificationId: entityId("verification-1"),
      expectedVersion: 2,
      status: "passed",
      resultSummary: "Verified",
    },
    baseContext({
      actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
    }),
  ).nextSnapshot;

  const hydratedClosed = {
    ...closed,
    closureAcceptanceFact: closureAcceptanceFact({
      closedAt: closed.bug.closedAt,
      closureGeneration: 0,
      closedBugVersion: 9,
      baselineKind: "no_build",
      baselineBuildId: null,
      baselineLineageId: null,
      baselineOrdinal: null,
    }),
    occurrenceFacts: [occurrenceFact()],
  };
  assertDecisionError("GUARD_FAILED", () =>
    decide(hydratedClosed, {
      type: "reopenBug",
      expectedVersion: 9,
      occurrenceId: entityId("occurrence-new"),
    }),
  );
  assert.equal(hydratedClosed.repairAttempts[0].status, "delivered");
});

test("legacy 1.0 supersede is explicit and does not invent an atomic successor", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const result = decide(snapshot, {
    type: "supersedeRepairAttempt",
    representation: "legacy-1.0",
    attemptId: entityId("attempt-1"),
    expectedVersion: 2,
    reason: "Legacy two-step mode change",
  });
  assert.equal(result.nextSnapshot.bug.state, "ready");
  assert.equal(result.nextSnapshot.bug.activeRepairAttemptId, null);
  assert.equal(result.nextSnapshot.bug.version, 6);
  assert.equal(result.nextSnapshot.repairAttempts.length, 1);
  assert.equal(result.nextSnapshot.repairAttempts[0].status, "superseded");
  assert.equal(result.event.type, "repair_attempt.superseded");
  assert.deepEqual([result.event.fromState, result.event.toState], ["in_progress", "ready"]);
  assert.equal(result.event.payload.successorAttemptId, undefined);
  assert.equal(result.event.payload.replacementMode, undefined);
});

test("a triager without developer role can create a RepairAttempt for an eligible assignee", () => {
  const snapshot = baseSnapshot({ bug: { state: "ready" } });
  const result = decide(
    snapshot,
    {
      type: "createRepairAttempt",
      expectedVersion: 4,
      attemptId: entityId("attempt-triaged"),
      mode: "human",
      assigneeId: "user-developer",
      parentAttemptId: null,
      summary: "Assigned during triage",
    },
    baseContext({
      actor: { type: "user", id: "user-triager", roles: ["triager"] },
    }),
  );
  assert.equal(result.nextSnapshot.bug.state, "in_progress");
  assert.equal(result.nextSnapshot.bug.activeRepairAttemptId, entityId("attempt-triaged"));
  assert.equal(result.nextSnapshot.repairAttempts[0].assigneeId, "user-developer");
});

test("create RepairAttempt requires a same-project active assignable assignee fact", () => {
  const snapshot = baseSnapshot({ bug: { state: "ready" } });
  const command = {
    type: "createRepairAttempt",
    expectedVersion: 4,
    attemptId: entityId("attempt-1"),
    mode: "human",
    assigneeId: "user-developer",
    parentAttemptId: null,
    summary: null,
  };
  const actor = { type: "user", id: "user-triager", roles: ["triager"] };
  const actorFact = defaultProjectActorFacts().find((fact) => fact.userId === actor.id);
  assert.ok(actorFact);

  const valid = decide(snapshot, command, baseContext({ actor }));
  assert.equal(valid.nextSnapshot.repairAttempts[0].assigneeId, "user-developer");

  assertDecisionError("GUARD_FAILED", () =>
    decide(
      snapshot,
      command,
      baseContext({
        actor,
        projectActorFacts: [
          actorFact,
          {
            accountId: "account-1",
            projectId: "project-2",
            userId: "user-developer",
            currentActive: true,
            assignable: true,
            canVerify: false,
            authorizedRoles: ["developer"],
          },
        ],
      }),
    ),
  );
  for (const eligibility of [
    { currentActive: false, assignable: true, authorizedRoles: ["developer"] },
    { currentActive: true, assignable: false, authorizedRoles: ["developer"] },
    { currentActive: true, assignable: true, authorizedRoles: [] },
    { currentActive: true, assignable: true, authorizedRoles: ["verifier"] },
  ]) {
    assertDecisionError("GUARD_FAILED", () =>
      decide(
        snapshot,
        command,
        baseContext({
          actor,
          projectActorFacts: [
            actorFact,
            {
              accountId: "account-1",
              projectId: "project-1",
              userId: "user-developer",
              canVerify: false,
              ...eligibility,
            },
          ],
        }),
      ),
    );
  }
});

test("vendor successor requires a same-project active assignable assignee fact", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  const command = {
    type: "supersedeRepairAttempt",
    representation: "vendor-1.1",
    attemptId: entityId("attempt-1"),
    expectedVersion: 2,
    reason: "Move to a successor",
    successor: {
      id: entityId("attempt-2"),
      mode: "relay",
      assigneeId: "user-developer-2",
      summary: "Continue the investigation",
    },
  };
  const actor = { type: "user", id: "user-developer", roles: ["developer"] };
  const actorFact = defaultProjectActorFacts().find((fact) => fact.userId === actor.id);
  assert.ok(actorFact);

  const valid = decide(snapshot, command, baseContext({ actor }));
  assert.equal(valid.nextSnapshot.repairAttempts.at(-1).assigneeId, "user-developer-2");

  assertDecisionError("GUARD_FAILED", () =>
    decide(
      snapshot,
      command,
      baseContext({
        actor,
        projectActorFacts: [
          actorFact,
          {
            accountId: "account-1",
            projectId: "project-2",
            userId: "user-developer-2",
            currentActive: true,
            assignable: true,
            canVerify: false,
            authorizedRoles: ["developer"],
          },
        ],
      }),
    ),
  );
  for (const eligibility of [
    { currentActive: false, assignable: true, authorizedRoles: ["developer"] },
    { currentActive: true, assignable: false, authorizedRoles: ["developer"] },
    { currentActive: true, assignable: true, authorizedRoles: [] },
    { currentActive: true, assignable: true, authorizedRoles: ["verifier"] },
  ]) {
    assertDecisionError("GUARD_FAILED", () =>
      decide(
        snapshot,
        command,
        baseContext({
          actor,
          projectActorFacts: [
            actorFact,
            {
              accountId: "account-1",
              projectId: "project-1",
              userId: "user-developer-2",
              canVerify: false,
              ...eligibility,
            },
          ],
        }),
      ),
    );
  }
});

test("create Verification requires a same-project active member with verify capability", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 7,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: null,
    },
    repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
    buildRequirements: [noBuildRequirement()],
  });
  const command = {
    type: "createVerification",
    expectedVersion: 7,
    verificationId: entityId("verification-1"),
    repairAttemptId: entityId("attempt-1"),
    buildId: null,
    verifierId: "user-verifier",
    criteria: "Verify on the target device",
  };
  const actor = { type: "user", id: "user-triager", roles: ["verifier"] };
  const creatorFact = defaultProjectActorFacts().find((fact) => fact.userId === actor.id);
  assert.ok(creatorFact);

  assertDecisionError("GUARD_FAILED", () =>
    decide(
      snapshot,
      command,
      baseContext({
        actor,
        projectActorFacts: [
          creatorFact,
          {
            accountId: "account-1",
            projectId: "project-2",
            userId: "user-verifier",
            currentActive: true,
            assignable: true,
            canVerify: true,
            authorizedRoles: ["verifier"],
          },
        ],
      }),
    ),
  );
  for (const eligibility of [
    { currentActive: false, canVerify: true, authorizedRoles: ["verifier"] },
    { currentActive: true, canVerify: false, authorizedRoles: ["verifier"] },
    { currentActive: true, canVerify: true, authorizedRoles: [] },
  ]) {
    assertDecisionError("GUARD_FAILED", () =>
      decide(
        snapshot,
        command,
        baseContext({
          actor,
          projectActorFacts: [
            creatorFact,
            {
              accountId: "account-1",
              projectId: "project-1",
              userId: "user-verifier",
              assignable: true,
              ...eligibility,
            },
          ],
        }),
      ),
    );
  }
});

test("rejects a manifest Build link request that smuggles an override reason", () => {
  const snapshot = baseSnapshot({
    bug: { state: "awaiting_build", version: 7, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [requiredBuildRequirement()],
    builds: [readyBuild()],
  });
  assertDecisionError("INVALID_REQUEST", () =>
    decide(
      snapshot,
      {
        type: "linkBuildRepair",
        buildId: entityId("build-1"),
        repairAttemptId: entityId("attempt-1"),
        deliveredCommitSha: SHA_A,
        expectedVersion: 2,
        expectedBugVersion: 7,
        expectedBuildRequirementVersion: 1,
        evidenceType: "manifest",
        overrideReason: "must not be accepted on the manifest path",
        linkId: entityId("build-link-1"),
      },
      baseContext({
        actor: { type: "user", id: "user-release-manager", roles: ["release_manager"] },
      }),
    ),
  );
});

test("Verification rejects a BuildRepairLink whose frozen relation version is not one", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: null,
    },
    repairAttempts: [deliveredAttempt()],
    buildRequirements: [
      requiredBuildRequirement({
        linkedBuildId: entityId("build-1"),
        linkId: entityId("build-link-1"),
        version: 2,
      }),
    ],
    builds: [readyBuild({ version: 3 })],
    buildLinks: [linkedBuildLink({ version: 2 })],
  });
  assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
    decide(
      snapshot,
      {
        type: "createVerification",
        expectedVersion: 8,
        verificationId: entityId("verification-new"),
        repairAttemptId: entityId("attempt-1"),
        buildId: entityId("build-1"),
        verifierId: "user-verifier",
        criteria: "Verify the exact committed artifact",
      },
      baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
    ),
  );
});

test("Verification rejects a BuildRequirement outside the exact Bug and delivery version chain", () => {
  for (const requirementOverride of [{ bugId: "foreign-bug" }, { bugVersionAtDelivery: 999 }]) {
    const snapshot = baseSnapshot({
      bug: {
        state: "ready_for_verification",
        version: 7,
        activeRepairAttemptId: entityId("attempt-1"),
        activeVerificationId: null,
      },
      repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
      buildRequirements: [noBuildRequirement(requirementOverride)],
    });
    assertDecisionError("BUILD_IDENTITY_MISMATCH", () =>
      decide(
        snapshot,
        {
          type: "createVerification",
          expectedVersion: 7,
          verificationId: entityId("verification-new"),
          repairAttemptId: entityId("attempt-1"),
          buildId: null,
          verifierId: "user-verifier",
          criteria: "Verify exact Bug-scoped delivery evidence",
        },
        baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
      ),
    );
  }
});

test("code no-Build exemption rejects an unknown runtime policy version", () => {
  const snapshot = baseSnapshot({
    bug: { state: "in_progress", version: 5, activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt()],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      snapshot,
      {
        type: "deliverRepairAttempt",
        attemptId: entityId("attempt-1"),
        expectedVersion: 2,
        summary: "A policy-bound exception",
        deliveryKind: "code",
        branch: "fix/bug-1",
        commitSha: SHA_A,
        buildRequirementId: "requirement-policy",
      },
      baseContext({
        actor: {
          type: "user",
          id: "user-release-manager",
          roles: ["developer", "release_manager"],
        },
        projectPolicy: {
          separationRequiredSeverities: ["S0", "S1"],
          codeDeliveryRequiresBuild: true,
          noBuildExemption: {
            authorized: true,
            reason: "Explicit exception",
            policyVersion: "2.0.0",
          },
        },
      }),
    ),
  );
});

test("snapshot rejects an unpointed or multiply-active Verification", () => {
  const unpointed = baseSnapshot({
    verifications: [requestedVerification()],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(unpointed, {
      type: "transitionBug",
      toState: "ready",
      expectedVersion: 4,
      triage: { requiredFieldsComplete: true },
    }),
  );

  const multiple = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
    buildRequirements: [noBuildRequirement()],
    verifications: [
      requestedVerification(),
      requestedVerification({ id: entityId("verification-2") }),
    ],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      multiple,
      {
        type: "startVerification",
        verificationId: entityId("verification-1"),
        expectedVersion: 1,
      },
      baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
    ),
  );
});

test("snapshot rejects Bug states that retain incompatible active workflow pointers", () => {
  const activeAttemptOutsideWorkState = baseSnapshot({
    bug: { state: "ready", activeRepairAttemptId: entityId("attempt-1") },
    repairAttempts: [runningAttempt({ status: "planned" })],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(activeAttemptOutsideWorkState, {
      type: "transitionBug",
      toState: "deferred",
      expectedVersion: 4,
      reason: "This prestate must fail before transition dispatch",
    }),
  );

  const verificationOutsideVerificationState = baseSnapshot({
    bug: {
      state: "in_progress",
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [deliveredAttempt()],
    verifications: [requestedVerification()],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      verificationOutsideVerificationState,
      {
        type: "startVerification",
        verificationId: entityId("verification-1"),
        expectedVersion: 1,
      },
      baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
    ),
  );

  const cyclicAttemptHistory = baseSnapshot({
    bug: { state: "ready" },
    repairAttempts: [
      runningAttempt({
        id: entityId("attempt-a"),
        sequence: 1,
        status: "failed",
        parentAttemptId: entityId("attempt-b"),
      }),
      runningAttempt({
        id: entityId("attempt-b"),
        sequence: 2,
        status: "failed",
        parentAttemptId: entityId("attempt-a"),
      }),
    ],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(cyclicAttemptHistory, {
      type: "transitionBug",
      toState: "deferred",
      expectedVersion: 4,
      reason: "Cyclic persisted history must fail closed",
    }),
  );
});

test("decision context rejects Event and Outbox envelope values that cannot be persisted", () => {
  const command = {
    type: "transitionBug",
    toState: "ready",
    expectedVersion: 4,
    triage: { requiredFieldsComplete: true },
  };
  for (const invalid of [
    { eventId: "" },
    { outboxMessageId: "not-a-uuid" },
    { correlationId: "not-a-uuid" },
    { causationId: "not-a-uuid" },
    { now: "not-a-date-time" },
    { now: "Tue, 25 Aug 2026 00:00:00 GMT" },
    { idempotencyKey: "" },
    { idempotencyKey: "x".repeat(201) },
    { idempotencyKey: 123 },
  ]) {
    assertDecisionError("INVALID_REQUEST", () =>
      decide(baseSnapshot(), command, baseContext(invalid)),
    );
  }
  for (const eventSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertDecisionError("GUARD_FAILED", () => decide(baseSnapshot({ eventSequence }), command));
  }
});

test("every human command requires one current same-project actor membership fact", () => {
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      baseSnapshot(),
      {
        type: "transitionBug",
        toState: "ready",
        expectedVersion: 4,
        triage: { requiredFieldsComplete: true },
      },
      baseContext({
        actor: { type: "user", id: "user-foreign", roles: ["triager"] },
        projectActorFacts: [],
      }),
    ),
  );
});

test("Verification authority is bound to the current same-project capability fact", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-1"),
      activeVerificationId: entityId("verification-1"),
    },
    repairAttempts: [deliveredAttempt({ branch: null, commitSha: null })],
    buildRequirements: [noBuildRequirement()],
    verifications: [requestedVerification()],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      snapshot,
      {
        type: "startVerification",
        verificationId: entityId("verification-1"),
        expectedVersion: 1,
      },
      baseContext({
        actor: { type: "user", id: "user-verifier", roles: ["verifier"] },
        projectActorFacts: [
          {
            accountId: "account-1",
            projectId: "project-1",
            userId: "user-verifier",
            currentActive: true,
            assignable: true,
            canVerify: false,
            authorizedRoles: ["verifier"],
          },
        ],
      }),
    ),
  );
});

test("Verification binds only the highest-sequence eligible delivered Attempt", () => {
  const snapshot = baseSnapshot({
    bug: {
      state: "ready_for_verification",
      version: 8,
      activeRepairAttemptId: entityId("attempt-old"),
      activeVerificationId: null,
    },
    repairAttempts: [
      deliveredAttempt({
        id: entityId("attempt-old"),
        sequence: 1,
        branch: null,
        commitSha: null,
      }),
      deliveredAttempt({
        id: entityId("attempt-new"),
        sequence: 2,
        branch: null,
        commitSha: null,
      }),
    ],
    buildRequirements: [
      noBuildRequirement({
        id: "requirement-old",
        repairAttemptId: entityId("attempt-old"),
      }),
    ],
  });
  assertDecisionError("GUARD_FAILED", () =>
    decide(
      snapshot,
      {
        type: "createVerification",
        expectedVersion: 8,
        verificationId: entityId("verification-new"),
        repairAttemptId: entityId("attempt-old"),
        buildId: null,
        verifierId: "user-verifier",
        criteria: "Do not bind stale delivered history",
      },
      baseContext({ actor: { type: "user", id: "user-verifier", roles: ["verifier"] } }),
    ),
  );
});

test("reopen rejects forged closure event vocabulary and cross-scope occurrence facts", () => {
  const closedBug = {
    state: "closed",
    version: 9,
    reopenCount: 0,
    closedAt: "2026-08-25T00:10:00.000Z",
  };
  const common = {
    bug: closedBug,
    repairAttempts: [deliveredAttempt()],
    verifications: [requestedVerification({ status: "passed", version: 3 })],
  };
  for (const overrides of [
    {
      closureAcceptanceFact: closureAcceptanceFact({ closeEventType: "bug.closed" }),
      occurrenceFacts: [occurrenceFact()],
    },
    {
      closureAcceptanceFact: closureAcceptanceFact(),
      occurrenceFacts: [occurrenceFact({ accountId: "foreign-account" })],
    },
    {
      closureAcceptanceFact: closureAcceptanceFact(),
      occurrenceFacts: [occurrenceFact({ projectId: "foreign-project" })],
    },
    {
      closureAcceptanceFact: closureAcceptanceFact(),
      occurrenceFacts: [occurrenceFact({ bugId: "foreign-bug" })],
    },
    {
      closureAcceptanceFact: closureAcceptanceFact({ closeEventPosition: 102 }),
      occurrenceFacts: [occurrenceFact()],
    },
    {
      closureAcceptanceFact: null,
      occurrenceFacts: [occurrenceFact()],
    },
  ]) {
    assertDecisionError("GUARD_FAILED", () =>
      decide(baseSnapshot({ ...common, ...overrides }), {
        type: "reopenBug",
        expectedVersion: 9,
        occurrenceId: entityId("occurrence-new"),
      }),
    );
  }
});
