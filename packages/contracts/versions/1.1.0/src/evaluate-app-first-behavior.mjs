import { createHash, createHmac } from "node:crypto";

export const ALLOWED_MACHINE_PROJECTION_ACTIONS = Object.freeze([
  "repair.queued",
  "repair.submitted",
  "repair.running",
  "repair.needs_input",
  "repair.blocked",
  "repair.failed",
  "repair.fix_delivered",
  "repair.awaiting_build",
  "repair.awaiting_verification",
  "build.pending",
  "build.exact_commit_eligible",
]);
const allowedMachineProjectionActions = new Set(ALLOWED_MACHINE_PROJECTION_ACTIONS);

const relayProjectionStates = new Set([
  "queued",
  "submitted",
  "running",
  "needs_input",
  "blocked",
  "failed",
  "fix_delivered",
  "awaiting_build",
  "awaiting_verification",
]);

const pocoMethods = new Set([
  "GetSDKVersion",
  "Screenshot",
  "Dump",
  "GetScreenSize",
  "GetDebugProfilingData",
  "qa.snapshot",
]);

const pocoArtifactByMethod = new Map([
  ["Screenshot", "poco_screenshot"],
  ["Dump", "poco_hierarchy"],
  ["GetDebugProfilingData", "poco_profiling"],
  ["qa.snapshot", "poco_snapshot"],
]);
const pocoResponseKindByMethod = new Map([
  ["GetSDKVersion", "metadata"],
  ["Screenshot", "artifact"],
  ["Dump", "hierarchy"],
  ["GetScreenSize", "metadata"],
  ["GetDebugProfilingData", "profiling"],
  ["qa.snapshot", "snapshot"],
]);

export const ARTIFACT_MEDIA_TYPES = Object.freeze({
  system_screenshot: Object.freeze(["image/png", "image/jpeg", "image/webp"]),
  system_recording: Object.freeze(["video/mp4", "video/webm"]),
  poco_screenshot: Object.freeze(["image/png", "image/jpeg", "image/webp"]),
  poco_hierarchy: Object.freeze(["application/json", "application/gzip"]),
  poco_profiling: Object.freeze(["application/json", "application/gzip"]),
  poco_snapshot: Object.freeze(["application/json", "application/gzip"]),
});
const artifactMediaTypes = new Map(
  Object.entries(ARTIFACT_MEDIA_TYPES).map(([kind, mediaTypes]) => [kind, new Set(mediaTypes)]),
);
const pocoCoreMethods = new Set(["GetSDKVersion", "Screenshot", "Dump"]);

export const APP_FIRST_LIMITS = Object.freeze({
  maxFrameBytes: 29_360_128,
  maxDecodedArtifactBytes: 20_971_520,
  maxDecodedHierarchyBytes: 1_048_576,
  maxSnapshotSerializedBytes: 262_144,
  maxRecentErrorCount: 20,
  maxRecentErrorUtf8Bytes: 32_768,
  maxCustomFieldCount: 30,
  maxCaptureStartSkewMs: 5_000,
  captureTimestampToleranceMs: 1,
  maxScreenshotDurationMs: 5_000,
  maxRecordingDurationMs: 120_000,
  minPocoDeadlineMs: 50,
  maxPocoDeadlineMs: 5_000,
  notificationTokenMaxFutureSkewMs: 300_000,
  refreshReplayRetentionMs: 300_000,
  accessTokenMaxTtlMs: 900_000,
  sharedDeviceIdleMaxTtlMs: 1_800_000,
  sharedDeviceAbsoluteMaxTtlMs: 28_800_000,
  personalRefreshMaxTtlMs: 2_592_000_000,
  uploadSessionMaxTtlMs: 3_600_000,
  bindingLeaseMaxTtlMs: 86_400_000,
  maxOccurrenceEnvironmentUtf8Bytes: 256,
  maxAuditPayloadUtf8Bytes: 4_096,
  maxSseEventUtf8Bytes: 65_536,
  maxAttachmentAuthorizationSkewMs: 5_000,
  supportedPocoSnapshotSchemaVersions: Object.freeze(["1.0.0"]),
});
const pocoPrivacyPolicyVersion = "1.0.0";
const sensitiveCustomFieldKey =
  /(?:password|passwd|secret|token|authorization|cookie|credential|email|phone|session)/i;
const sensitiveLogAssignment =
  /(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|authorization|cookie|credential)\s*[:=]/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const occurrenceEnvironmentKeys = new Set([
  "qaAppVersion",
  "testSessionId",
  "buildId",
  "networkType",
  "networkMetered",
  "orientation",
]);
const occurrenceNetworkTypes = new Set([
  "wifi",
  "cellular",
  "ethernet",
  "vpn",
  "offline",
  "other",
  "unknown",
]);
const occurrenceOrientations = new Set(["portrait", "landscape", "square", "unknown"]);
const qaAppVersionPattern =
  /^[0-9]+(?:\.[0-9]+){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/;
const nativeAuditPayloadKeys = new Set([
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
const nativeAuditUuidPayloadKeys = [
  "relatedBugId",
  "repairAttemptId",
  "buildId",
  "verificationId",
  "attachmentId",
  "captureId",
  "handoffId",
  "commentId",
  "occurrenceId",
];
const nativeAuditEntityTypeByPayloadField = new Map([
  ["relatedBugId", "bug"],
  ["repairAttemptId", "repair_attempt"],
  ["buildId", "build"],
  ["verificationId", "verification"],
  ["attachmentId", "attachment"],
  ["captureId", "capture"],
  ["handoffId", "handoff"],
  ["commentId", "comment"],
  ["occurrenceId", "occurrence"],
]);
const nativeAuditMachineSources = new Set(["relay", "build"]);
const nativeAuditVerificationEventTypes = new Set([
  "verification.created",
  "verification.started",
  "verification.result_recorded",
]);
const nativeAuditHumanAuthorityStatuses = new Set([
  "accepted",
  "verified",
  "closed",
  "passed",
  "rejected",
]);
const sensitiveAuditText =
  /(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|api[_-]?key|x-api-key|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?\S|\bbearer\s+[A-Za-z0-9._~+/-]+|(?:^|\s)[A-Za-z]:\\|\\\\[^\\\s]+\\/i;

function serializedUtf8Bytes(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function isNativeOccurrenceEnvironment(value, { allowAbsent = true, allowNull = true } = {}) {
  if (value === undefined) return allowAbsent;
  if (value === null) return allowNull;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const byteLength = serializedUtf8Bytes(value);
  if (
    keys.length > occurrenceEnvironmentKeys.size ||
    keys.some((key) => !occurrenceEnvironmentKeys.has(key)) ||
    !Number.isInteger(byteLength) ||
    byteLength > APP_FIRST_LIMITS.maxOccurrenceEnvironmentUtf8Bytes
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, "qaAppVersion") &&
    (typeof value.qaAppVersion !== "string" ||
      value.qaAppVersion.length < 1 ||
      value.qaAppVersion.length > 100 ||
      !qaAppVersionPattern.test(value.qaAppVersion))
  ) {
    return false;
  }
  for (const field of ["testSessionId", "buildId"]) {
    if (
      Object.hasOwn(value, field) &&
      value[field] !== null &&
      (typeof value[field] !== "string" || !uuidPattern.test(value[field]))
    ) {
      return false;
    }
  }
  if (
    Object.hasOwn(value, "networkType") &&
    !occurrenceNetworkTypes.has(value.networkType)
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, "networkMetered") &&
    value.networkMetered !== null &&
    typeof value.networkMetered !== "boolean"
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, "orientation") &&
    !occurrenceOrientations.has(value.orientation)
  ) {
    return false;
  }
  return true;
}

function isNativeAuditPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  const byteLength = serializedUtf8Bytes(payload);
  if (
    keys.length > nativeAuditPayloadKeys.size ||
    keys.some((key) => !nativeAuditPayloadKeys.has(key)) ||
    !Number.isInteger(byteLength) ||
    byteLength > APP_FIRST_LIMITS.maxAuditPayloadUtf8Bytes
  ) {
    return false;
  }
  for (const field of ["summary", "reason"]) {
    if (
      Object.hasOwn(payload, field) &&
      (typeof payload[field] !== "string" ||
        payload[field].length < 1 ||
        payload[field].length > 2_000 ||
        sensitiveAuditText.test(payload[field]))
    ) {
      return false;
    }
  }
  if (
    Object.hasOwn(payload, "status") &&
    (typeof payload.status !== "string" ||
      payload.status.length > 100 ||
      !/^[a-z][a-z0-9_]*$/.test(payload.status))
  ) {
    return false;
  }
  for (const field of nativeAuditUuidPayloadKeys) {
    if (
      Object.hasOwn(payload, field) &&
      (typeof payload[field] !== "string" || !uuidPattern.test(payload[field]))
    ) {
      return false;
    }
  }
  if (
    Object.hasOwn(payload, "commitSha") &&
    (typeof payload.commitSha !== "string" || !/^[0-9a-f]{40}$/.test(payload.commitSha))
  ) {
    return false;
  }
  if (
    Object.hasOwn(payload, "attachmentCount") &&
    (!Number.isInteger(payload.attachmentCount) ||
      payload.attachmentCount < 0 ||
      payload.attachmentCount > 20)
  ) {
    return false;
  }
  for (const field of ["fromVersion", "toVersion"]) {
    if (Object.hasOwn(payload, field) && (!Number.isInteger(payload[field]) || payload[field] < 1)) {
      return false;
    }
  }
  return true;
}

function auditPayloadReferenceFactsMatch(event, fact, { accountId, projectId, bugId }) {
  const references = nativeAuditUuidPayloadKeys
    .filter((field) => Object.hasOwn(event.payload, field))
    .map((field) => ({
      entityId: event.payload[field],
      entityType: nativeAuditEntityTypeByPayloadField.get(field),
      payloadField: field,
    }));
  if (
    !Array.isArray(fact.payloadReferenceFacts) ||
    fact.payloadReferenceFacts.length !== references.length ||
    new Set(fact.payloadReferenceFacts.map((entry) => entry.payloadField)).size !==
      fact.payloadReferenceFacts.length
  ) {
    return false;
  }
  return references.every((reference) => {
    const relation = fact.payloadReferenceFacts.find(
      (entry) => entry.payloadField === reference.payloadField,
    );
    return Boolean(
      relation &&
        relation.entityId === reference.entityId &&
        relation.entityType === reference.entityType &&
        relation.accountId === accountId &&
        relation.projectId === projectId &&
        relation.ownerBugId === bugId &&
        relation.relationValidated === true,
    );
  });
}

function auditEventAuthorityMatches(event, fact, { accountId, projectId, bugId }) {
  const hasTransition = event.fromState != null || event.toState != null;
  const closesBug = event.type === "bug.closed" || event.toState === "closed";
  const hasHumanAuthorityStatus = nativeAuditHumanAuthorityStatuses.has(event.payload?.status);
  if (
    /^verification\./.test(event.type ?? "") &&
    !nativeAuditVerificationEventTypes.has(event.type)
  ) {
    return false;
  }
  const isVerificationResult = event.type === "verification.result_recorded";
  const verificationId = event.payload?.verificationId;
  const projectedAuthorityStatus = closesBug ? "closed" : event.payload?.status;
  const requiresVerificationProof = closesBug || isVerificationResult || hasHumanAuthorityStatus;
  const machineSource = nativeAuditMachineSources.has(event.source);
  const expectedMachinePrefix = event.source === "relay" ? "repair." : "build.";
  const expectedMachineStatus = event.type?.slice(expectedMachinePrefix.length);
  if (
    machineSource &&
    (!allowedMachineProjectionActions.has(event.type) ||
      !event.type.startsWith(expectedMachinePrefix) ||
      (event.payload?.status != null && event.payload.status !== expectedMachineStatus))
  ) {
    return false;
  }
  const isHumanQaAction =
    hasTransition || /^(?:bug|verification)\./.test(event.type ?? "") || hasHumanAuthorityStatus;
  const actorIdentityValid =
    (event.actor?.type === "system" && event.actor.id === null) ||
    (["user", "service"].includes(event.actor?.type) &&
      typeof event.actor.id === "string" &&
      uuidPattern.test(event.actor.id));

  if (
    !actorIdentityValid ||
    (machineSource &&
      (hasTransition ||
        /^(?:bug|verification)\./.test(event.type ?? "") ||
        hasHumanAuthorityStatus)) ||
    (isHumanQaAction && (event.source !== "qa_hub" || event.actor?.type !== "user")) ||
    fact.authorityKind !== (isHumanQaAction ? "human_qa_action" : "non_bug_projection") ||
    fact.humanActionAuthorized !== isHumanQaAction
  ) {
    return false;
  }

  const proof = fact.humanVerificationAuthorityProof;
  if (!requiresVerificationProof) return proof == null;
  if (
    typeof verificationId !== "string" ||
    !uuidPattern.test(verificationId) ||
    (isVerificationResult &&
      !["passed", "failed", "blocked", "cancelled"].includes(event.payload?.status))
  ) {
    return false;
  }
  const allowedVerificationStatuses = closesBug
    ? new Set(["passed"])
    : ["accepted", "verified", "closed", "passed"].includes(event.payload?.status)
      ? new Set(["passed"])
      : event.payload?.status === "rejected"
        ? new Set(["failed", "blocked"])
        : new Set([event.payload?.status]);
  return Boolean(
    proof &&
      verificationId === proof.verificationId &&
      proof.accountId === accountId &&
      proof.projectId === projectId &&
      proof.bugId === bugId &&
      proof.projectedStatus === projectedAuthorityStatus &&
      allowedVerificationStatuses.has(proof.verificationStatus) &&
      proof.verifierActorType === "user" &&
      proof.verifierActorId === event.actor.id &&
      proof.assignedVerifierId === event.actor.id &&
      proof.resultRecordedByHuman === true &&
      proof.relationValidated === true &&
      proof.closeAuthorized === closesBug,
  );
}

function auditEventFactMatches(event, fact, { accountId, projectId, bugId }) {
  return Boolean(
    fact &&
      fact.accountId === accountId &&
      fact.projectId === projectId &&
      fact.bugId === bugId &&
      fact.eventId === event.id &&
      fact.projectionSource === "typed_facts" &&
      fact.projectionRuleVersion === "1.0.0" &&
      fact.rawDurablePayloadUsed === false &&
      fact.payloadRedactionApplied === true &&
      fact.sensitiveValueScanPassed === true &&
      event.projectId === projectId &&
      event.bugId === bugId &&
      event.redactionPolicyVersion === "1.0.0" &&
      isNativeAuditPayload(event.payload) &&
      canonicalString(event) === canonicalString(fact.event) &&
      fact.aggregateFact?.accountId === accountId &&
      fact.aggregateFact?.projectId === projectId &&
      fact.aggregateFact?.bugId === bugId &&
      fact.aggregateFact?.aggregateType === event.aggregate?.type &&
      fact.aggregateFact?.aggregateId === event.aggregate?.id &&
      fact.aggregateFact?.aggregateVersion === event.aggregate?.version &&
      fact.aggregateFact?.relationValidated === true &&
      fact.actorFact?.accountId === accountId &&
      fact.actorFact?.projectId === projectId &&
      fact.actorFact?.actorType === event.actor?.type &&
      fact.actorFact?.actorId === event.actor?.id &&
      fact.actorFact?.relationValidated === true &&
      auditPayloadReferenceFactsMatch(event, fact, { accountId, projectId, bugId }) &&
      auditEventAuthorityMatches(event, fact, { accountId, projectId, bugId }),
  );
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUniqueArray(values) {
  return Array.isArray(values) && new Set(values).size === values.length;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalReplayDigest(
  operationId,
  scope,
  request,
  idempotencyKey,
  serverPepper,
) {
  if (typeof serverPepper !== "string" || serverPepper.length < 32) return undefined;
  return createHmac("sha256", serverPepper)
    .update(canonicalString({ idempotencyKey, operationId, request, scope }))
    .digest("hex");
}

export function canonicalNonSecretRequestDigest(operationId, scope, request, idempotencyKey) {
  return sha256Hex(canonicalString({ idempotencyKey, operationId, request, scope }));
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length > 0 && decoded.toString("base64") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function toEpoch(value) {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : undefined;
}

export function deriveEnrichmentStatus(input) {
  const negotiatedMethods = input.negotiatedMethods ?? [];
  const succeededMethods = input.succeededMethods ?? [];
  if (!isUniqueArray(negotiatedMethods) || !isUniqueArray(succeededMethods)) return "invalid";
  if (
    negotiatedMethods.some((method) => !pocoMethods.has(method)) ||
    succeededMethods.some((method) => !pocoMethods.has(method))
  ) {
    return "invalid";
  }

  const negotiated = new Set(negotiatedMethods);
  const succeeded = new Set(succeededMethods);
  if ([...succeeded].some((method) => !negotiated.has(method))) return "invalid";
  if ([...negotiated].some((method) => method !== "GetSDKVersion") && !succeeded.has("GetSDKVersion")) {
    return "invalid";
  }

  if (!input.attempted) {
    if (negotiated.size > 0 || succeeded.size > 0) return "invalid";
    if (hasOwn(input, "connectedPort") && input.connectedPort !== null) return "invalid";
    if (hasOwn(input, "sdkVersion") && input.sdkVersion !== null) return "invalid";
    if (hasOwn(input, "screenSize") && input.screenSize !== null) return "invalid";
    if (hasOwn(input, "snapshotCapability") && input.snapshotCapability !== "not_probed") {
      return "invalid";
    }
    if (hasOwn(input, "failureReason") && input.failureReason !== null) return "invalid";
    return "unavailable";
  }

  if (succeeded.size > 0 && !succeeded.has("GetSDKVersion")) return "invalid";
  if (succeeded.size > 0 && !negotiated.has("GetSDKVersion")) return "invalid";
  if (hasOwn(input, "connectedPort")) {
    const connected = Number.isInteger(input.connectedPort) && input.connectedPort > 0;
    if (connected !== succeeded.has("GetSDKVersion")) return "invalid";
  }
  if (hasOwn(input, "sdkVersion")) {
    const hasSdkVersion = typeof input.sdkVersion === "string" && input.sdkVersion.length > 0;
    if (hasSdkVersion !== succeeded.has("GetSDKVersion")) return "invalid";
  }
  if (hasOwn(input, "screenSize")) {
    const hasScreenSize =
      input.screenSize !== null &&
      Number.isInteger(input.screenSize?.width) &&
      input.screenSize.width > 0 &&
      Number.isInteger(input.screenSize?.height) &&
      input.screenSize.height > 0;
    if (hasScreenSize !== succeeded.has("GetScreenSize")) return "invalid";
  }
  if (hasOwn(input, "snapshotCapability")) {
    if (
      (input.snapshotCapability === "qa_snapshot_available") !==
      negotiated.has("qa.snapshot")
    ) {
      return "invalid";
    }
    if (input.snapshotCapability === "standard_only" && !succeeded.has("GetSDKVersion")) {
      return "invalid";
    }
    if (input.snapshotCapability === "not_probed" && succeeded.has("GetSDKVersion")) {
      return "invalid";
    }
  }

  if (succeeded.size === 0) return "unavailable";
  if (
    sameSet(negotiated, succeeded) &&
    hasOwn(input, "failureReason") &&
    input.failureReason !== null
  ) {
    return "invalid";
  }
  const complete =
    sameSet(negotiated, succeeded) &&
    [...pocoCoreMethods].every((method) => succeeded.has(method));
  return complete ? "complete" : "partial";
}

function canonicalStageKey(input) {
  const prefix = `submission:${input.clientSubmissionId}`;
  if (input.stage === "commit") return `${prefix}:commit`;
  const attachmentPrefix = `${prefix}:attachment:${input.clientAttachmentId}`;
  if (input.stage === "bind") return `${attachmentPrefix}:bind:${input.leaseGeneration}`;
  const uploadPrefix = `${attachmentPrefix}:upload:${input.uploadAttempt}`;
  if (input.stage === "chunk") return `${uploadPrefix}:chunk:${input.chunkNumber}`;
  return `${uploadPrefix}:${input.stage}`;
}

function evaluatePipeline(input) {
  const entityKeys = ["sessionId", "attachmentId", "bindingId", "qaItemId", "occurrenceId"];
  for (const key of entityKeys) {
    const values = input.attempts.map((attempt) => attempt[key]).filter((value) => value !== null);
    if (new Set(values).size > 1) return "IDEMPOTENCY_PAYLOAD_MISMATCH";
  }
  return Object.values(input.entityCounts).every((count) => count === 1)
    ? "converged"
    : "duplicate_entities";
}

function pipelineLogicalKey(action) {
  const prefix = `${action.clientSubmissionId}:${action.clientAttachmentId ?? "-"}`;
  if (action.stage === "commit") return `commit:${action.clientSubmissionId}`;
  if (action.stage === "bind" || action.stage === "binding-expired") {
    return `${action.stage}:${prefix}:${action.leaseGeneration}`;
  }
  if (action.stage === "chunk") {
    return `${action.stage}:${prefix}:${action.uploadAttempt}:${action.chunkNumber}`;
  }
  return `${action.stage}:${prefix}:${action.uploadAttempt}`;
}

function pipelineFingerprint(action) {
  const normalized = structuredClone(action);
  delete normalized.replayed;
  if (normalized.claimedClientAttachmentIds) {
    normalized.claimedClientAttachmentIds = sortedUnique(normalized.claimedClientAttachmentIds);
  }
  if (normalized.confirmedChunks) normalized.confirmedChunks = sortedUnique(normalized.confirmedChunks);
  return canonicalString(normalized);
}

function validateAtomicAttachmentCommit(input) {
  const { action, states, scope } = input;
  if (
    !Array.isArray(states) ||
    [scope.accountId, scope.actorId, scope.projectId, action.clientSubmissionId].some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    return { outcome: "NOT_FOUND", claimedClientAttachmentIds: [] };
  }
  const claims = sortedUnique(action.claimedClientAttachmentIds ?? []);
  if (claims.length !== (action.claimedClientAttachmentIds ?? []).length) {
    return { outcome: "ATTACHMENT_BINDING_CONFLICT", claimedClientAttachmentIds: [] };
  }
  if (canonicalString(claims) !== canonicalString(states.map((state) => state.clientAttachmentId).sort())) {
    return { outcome: "orphan_or_unclaimed_attachment", claimedClientAttachmentIds: [] };
  }
  const facts = action.attachmentFacts;
  if (
    !Array.isArray(facts) ||
    facts.length !== claims.length ||
    new Set(facts.map((fact) => fact?.clientAttachmentId)).size !== facts.length
  ) {
    return { outcome: "ATTACHMENT_BINDING_CONFLICT", claimedClientAttachmentIds: [] };
  }

  const commitIntent = action.commitIntent;
  const commitTargetQaItemId = action.targetQaItemId ?? null;
  const commitNow = toEpoch(action.now);
  const validated = [];
  for (const clientAttachmentId of claims) {
    const state = states.find((candidate) => candidate.clientAttachmentId === clientAttachmentId);
    if (!state?.attachmentId || state.bindingStatus !== "reserved") {
      return { outcome: "pipeline_order_invalid", claimedClientAttachmentIds: [] };
    }
    const bindingExpiresAt = toEpoch(state.bindingExpiresAt);
    if (
      commitNow === undefined ||
      bindingExpiresAt === undefined ||
      commitNow < state.bindingReservedAt ||
      commitNow < state.lastServerTime ||
      commitNow >= bindingExpiresAt
    ) {
      return { outcome: "ATTACHMENT_BINDING_CONFLICT", claimedClientAttachmentIds: [] };
    }
    if (state.intent !== commitIntent || (state.targetQaItemId ?? null) !== commitTargetQaItemId) {
      return { outcome: "ATTACHMENT_BINDING_CONFLICT", claimedClientAttachmentIds: [] };
    }
    const fact = facts.find((candidate) => candidate.clientAttachmentId === clientAttachmentId);
    if (
      !fact ||
      [
        state.clientAttachmentId,
        state.attachmentId,
        state.bindingId,
        state.contentHash,
        state.persistedObjectHash,
        fact.accountId,
        fact.actorId,
        fact.projectId,
        fact.clientSubmissionId,
        fact.clientAttachmentId,
        fact.attachmentId,
        fact.bindingId,
        fact.contentHash,
        fact.persistedObjectHash,
      ].some((value) => typeof value !== "string" || value.length === 0) ||
      !/^[0-9a-f]{64}$/.test(state.contentHash) ||
      !/^[0-9a-f]{64}$/.test(state.persistedObjectHash) ||
      !Number.isInteger(state.version) ||
      state.version < 1 ||
      !Number.isInteger(state.expectedSize) ||
      state.expectedSize < 1 ||
      !Number.isInteger(state.leaseGeneration) ||
      state.leaseGeneration < 1 ||
      !Number.isInteger(fact.version) ||
      !Number.isInteger(fact.storedBytes) ||
      !Number.isInteger(fact.leaseGeneration) ||
      state.scanStatus !== "clean" ||
      state.readyToBind !== true ||
      state.durablyReadable !== true ||
      fact.accountId !== scope.accountId ||
      fact.actorId !== scope.actorId ||
      fact.projectId !== scope.projectId ||
      fact.clientSubmissionId !== action.clientSubmissionId ||
      fact.attachmentId !== state.attachmentId ||
      fact.version !== state.version ||
      fact.contentHash !== state.contentHash ||
      fact.storedBytes !== state.expectedSize ||
      fact.persistedObjectHash !== state.persistedObjectHash ||
      fact.scanStatus !== "clean" ||
      fact.readyToBind !== true ||
      fact.durablyReadable !== true ||
      fact.bindingStatus !== "reserved" ||
      fact.bindingId !== state.bindingId ||
      fact.leaseGeneration !== state.leaseGeneration ||
      fact.intent !== state.intent ||
      (fact.targetQaItemId ?? null) !== (state.targetQaItemId ?? null) ||
      toEpoch(fact.reservedAt) !== state.bindingReservedAt ||
      fact.expiresAt !== state.bindingExpiresAt
    ) {
      return { outcome: "ATTACHMENT_BINDING_CONFLICT", claimedClientAttachmentIds: [] };
    }
    validated.push(clientAttachmentId);
  }
  return { outcome: "claimed", claimedClientAttachmentIds: validated };
}

function evaluateAtomicAttachmentCommit(input) {
  const states = structuredClone(input.states ?? []);
  const result = validateAtomicAttachmentCommit({
    action: input.action ?? {},
    states,
    scope: input.scope ?? {},
  });
  if (result.outcome === "claimed") {
    for (const clientAttachmentId of result.claimedClientAttachmentIds) {
      states.find((state) => state.clientAttachmentId === clientAttachmentId).bindingStatus = "claimed";
    }
  }
  return {
    outcome: result.outcome,
    claimedCount: states.filter((state) => state.bindingStatus === "claimed").length,
  };
}

function evaluatePipelineTrace(input) {
  const scope = { accountId: input.accountId, actorId: input.actorId, projectId: input.projectId };
  if (Object.values(scope).some((value) => typeof value !== "string" || value.length === 0)) {
    return "NOT_FOUND";
  }
  const seenActions = new Map();
  const attachments = new Map();
  const resourceSets = {
    sessions: new Set(),
    attachments: new Set(),
    bindings: new Set(),
    bugs: new Set(),
    occurrences: new Set(),
  };
  const resourceOwners = {
    sessions: new Map(),
    attachments: new Map(),
    bindings: new Map(),
  };
  let acceptedSessionCount = 0;
  let committedIntent;
  let committedClaims;

  function claimResource(kind, resourceId, clientAttachmentId) {
    if (typeof resourceId !== "string" || resourceId.length === 0) return false;
    const owner = resourceOwners[kind].get(resourceId);
    if (owner !== undefined && owner !== clientAttachmentId) return false;
    resourceOwners[kind].set(resourceId, clientAttachmentId);
    resourceSets[kind].add(resourceId);
    return true;
  }

  for (const action of input.trace) {
    if (
      action.accountId !== scope.accountId ||
      action.actorId !== scope.actorId ||
      action.projectId !== scope.projectId
    ) {
      return "NOT_FOUND";
    }
    if (action.clientSubmissionId !== input.clientSubmissionId) {
      return "CLIENT_SUBMISSION_ID_MISMATCH";
    }
    // Reconcile is a mutable GET projection: the same upload attempt can be
    // observed after every accepted chunk. It is deliberately excluded from
    // the write-idempotency map.
    if (!["reconcile", "scan-observed"].includes(action.stage)) {
      const logicalKey = pipelineLogicalKey(action);
      const fingerprint = pipelineFingerprint(action);
      const seen = seenActions.get(logicalKey);
      if (seen) {
        if (seen !== fingerprint) return "IDEMPOTENCY_PAYLOAD_MISMATCH";
        if (action.replayed !== true) return "IDEMPOTENCY_PAYLOAD_MISMATCH";
        continue;
      }
      if (action.replayed === true) return "IDEMPOTENCY_PAYLOAD_MISMATCH";
      seenActions.set(logicalKey, fingerprint);
    }

    if (action.stage === "commit") {
      const commitIntent = action.commitIntent;
      const commitTargetQaItemId = action.targetQaItemId ?? null;
      const occurrenceRequired = ["bug_create", "occurrence_append"].includes(commitIntent);
      if (
        !["bug_create", "occurrence_append", "comment_append", "verification_result"].includes(
          commitIntent,
        ) ||
        typeof action.qaItemId !== "string" ||
        action.qaItemId.length === 0 ||
        (occurrenceRequired !==
          (typeof action.occurrenceId === "string" && action.occurrenceId.length > 0)) ||
        (commitIntent === "bug_create"
          ? commitTargetQaItemId !== null
          : commitTargetQaItemId !== action.qaItemId)
      ) {
        return "pipeline_order_invalid";
      }
      const commitResult = validateAtomicAttachmentCommit({
        action,
        states: [...attachments.values()],
        scope,
      });
      if (commitResult.outcome !== "claimed") return commitResult.outcome;
      for (const clientAttachmentId of commitResult.claimedClientAttachmentIds) {
        attachments.get(clientAttachmentId).bindingStatus = "claimed";
      }
      const claims = commitResult.claimedClientAttachmentIds;
      committedClaims = new Set(claims);
      committedIntent = commitIntent;
      resourceSets.bugs.add(action.qaItemId);
      if (occurrenceRequired) resourceSets.occurrences.add(action.occurrenceId);
      continue;
    }

    const clientAttachmentId = action.clientAttachmentId;
    if (!clientAttachmentId) return "CLIENT_SUBMISSION_ID_MISMATCH";
    let state = attachments.get(clientAttachmentId);

    if (action.stage === "init") {
      if (!Number.isInteger(action.uploadAttempt) || action.uploadAttempt < 1) {
        return "UPLOAD_INVALID";
      }
      const uploadIssuedAt = toEpoch(action.serverNow ?? input.serverNow);
      const uploadExpiresAt = toEpoch(action.expiresAt ?? input.uploadExpiresAt);
      if (
        uploadIssuedAt === undefined ||
        uploadExpiresAt === undefined ||
        uploadExpiresAt <= uploadIssuedAt ||
        uploadExpiresAt - uploadIssuedAt > APP_FIRST_LIMITS.uploadSessionMaxTtlMs
      ) {
        return "UPLOAD_INVALID";
      }
      if (!state) {
        if (action.uploadAttempt !== 1 || action.restartOfSessionId != null) {
          return "UPLOAD_INVALID";
        }
        state = { clientAttachmentId };
        attachments.set(clientAttachmentId, state);
      } else if (
        state.uploadStatus !== "expired" ||
        action.uploadAttempt !== state.uploadAttempt + 1 ||
        action.restartOfSessionId !== state.sessionId ||
        action.contentHash !== state.contentHash ||
        action.expectedSize !== state.expectedSize ||
        uploadIssuedAt === undefined ||
        uploadExpiresAt === undefined ||
        uploadIssuedAt < state.uploadExpiredAt
      ) {
        return "UPLOAD_INVALID";
      }
      if (
        !action.resourceId ||
        action.version !== 1 ||
        !Number.isInteger(action.expectedSize) ||
        !Number.isInteger(action.chunkSize) ||
        action.expectedSize < 1 ||
        action.chunkSize < 1 ||
        !/^[0-9a-f]{64}$/.test(action.contentHash ?? "")
      ) {
        return "UPLOAD_INVALID";
      }
      Object.assign(state, {
        uploadAttempt: action.uploadAttempt,
        sessionId: action.resourceId,
        uploadStatus: "open",
        version: action.version,
        expectedSize: action.expectedSize,
        chunkSize: action.chunkSize,
        contentHash: action.contentHash,
        chunks: new Map(),
        attachmentId: undefined,
        uploadExpiresAt: action.expiresAt ?? input.uploadExpiresAt,
        lastUploadServerTime: uploadIssuedAt,
        uploadExpiredAt: undefined,
      });
      if (!claimResource("sessions", action.resourceId, clientAttachmentId)) {
        return "duplicate_entities";
      }
      acceptedSessionCount += 1;
      continue;
    }

    if (!state || action.uploadAttempt !== state.uploadAttempt) return "pipeline_order_invalid";
    if (
      action.resourceId &&
      ["chunk", "reconcile", "upload-expired"].includes(action.stage) &&
      action.resourceId !== state.sessionId
    ) {
      return "NOT_FOUND";
    }

    if (["chunk", "reconcile", "finalize"].includes(action.stage)) {
      const serverNow = toEpoch(action.serverNow ?? input.serverNow);
      const uploadExpiresAt = toEpoch(state.uploadExpiresAt);
      if (
        serverNow === undefined ||
        uploadExpiresAt === undefined ||
        serverNow < state.lastUploadServerTime ||
        serverNow >= uploadExpiresAt
      ) {
        return "UPLOAD_INVALID";
      }
      state.lastUploadServerTime = serverNow;
    }

    if (action.stage === "upload-expired") {
      const observedAt = toEpoch(action.observedAt);
      const uploadExpiresAt = toEpoch(state.uploadExpiresAt);
      if (
        state.uploadStatus !== "open" ||
        observedAt === undefined ||
        uploadExpiresAt === undefined ||
        observedAt < uploadExpiresAt ||
        (state.lastUploadServerTime !== undefined && observedAt < state.lastUploadServerTime)
      ) {
        return "UPLOAD_INVALID";
      }
      state.uploadStatus = "expired";
      state.uploadExpiredAt = observedAt;
      state.lastUploadServerTime = observedAt;
      continue;
    }

    if (action.stage === "chunk") {
      if (state.uploadStatus !== "open") return "pipeline_order_invalid";
      const chunkCount = Math.ceil(state.expectedSize / state.chunkSize);
      if (
        !Number.isInteger(action.chunkNumber) ||
        action.chunkNumber < 0 ||
        action.chunkNumber >= chunkCount ||
        action.expectedVersion !== state.version
      ) {
        return action.expectedVersion !== state.version ? "VERSION_CONFLICT" : "UPLOAD_INVALID";
      }
      if (action.responseVersion !== action.expectedVersion + 1 || !action.chunkHash) {
        return "UPLOAD_INVALID";
      }
      const contentBytes = decodeCanonicalBase64(action.contentBytesBase64);
      const expectedChunkLength =
        action.chunkNumber === chunkCount - 1
          ? state.expectedSize - state.chunkSize * (chunkCount - 1)
          : state.chunkSize;
      if (
        !Number.isInteger(action.contentLength) ||
        action.contentLength !== expectedChunkLength ||
        action.contentLength < 1 ||
        !contentBytes ||
        contentBytes.length !== action.contentLength ||
        !/^[0-9a-f]{64}$/.test(action.chunkHash) ||
        action.chunkHash !== sha256Hex(contentBytes) ||
        action.persistedChunkHash !== action.chunkHash
      ) {
        return "UPLOAD_INVALID";
      }
      state.chunks.set(action.chunkNumber, {
        hash: action.chunkHash,
        contentLength: action.contentLength,
        contentBytes,
      });
      state.version = action.responseVersion;
      continue;
    }

    if (action.stage === "reconcile") {
      if (action.version !== state.version) return "VERSION_CONFLICT";
      const confirmed = sortedUnique(action.confirmedChunks ?? []);
      if (
        canonicalString(confirmed) !== canonicalString([...state.chunks.keys()].sort((a, b) => a - b))
      ) {
        return "UPLOAD_INVALID";
      }
      continue;
    }

    if (action.stage === "finalize") {
      if (state.uploadStatus !== "open") return "pipeline_order_invalid";
      if (action.sessionId !== state.sessionId) return "NOT_FOUND";
      if (action.expectedVersion !== state.version) return "VERSION_CONFLICT";
      const chunkCount = Math.ceil(state.expectedSize / state.chunkSize);
      const requiredChunks = Array.from({ length: chunkCount }, (_, index) => index);
      const reconstructed = Buffer.concat(
        requiredChunks.map((chunkNumber) => state.chunks.get(chunkNumber)?.contentBytes ?? Buffer.alloc(0)),
      );
      const reconstructedHash = sha256Hex(reconstructed);
      if (
        canonicalString([...state.chunks.keys()].sort((a, b) => a - b)) !== canonicalString(requiredChunks) ||
        action.totalBytes !== state.expectedSize ||
        [...state.chunks.values()].reduce((sum, chunk) => sum + chunk.contentLength, 0) !==
          state.expectedSize ||
        reconstructed.length !== state.expectedSize ||
        reconstructedHash !== state.contentHash ||
        action.aggregateHash !== reconstructedHash ||
        action.persistedObjectHash !== reconstructedHash ||
        action.persistedObjectSize !== state.expectedSize ||
        action.durablyReadable !== true ||
        !["pending", "clean", "rejected", "unavailable"].includes(action.scanStatus) ||
        action.readyToBind !== (action.scanStatus === "clean") ||
        action.bindingStatus !== "unbound" ||
        action.responseVersion !== state.version + 1
      ) {
        return "UPLOAD_INVALID";
      }
      state.uploadStatus = "finalized";
      state.version = action.responseVersion;
      state.attachmentId = action.resourceId;
      state.scanStatus = action.scanStatus;
      state.readyToBind = action.readyToBind;
      state.persistedObjectHash = action.persistedObjectHash;
      state.durablyReadable = action.durablyReadable;
      if (!claimResource("attachments", action.resourceId, clientAttachmentId)) {
        return "duplicate_entities";
      }
      continue;
    }

    if (action.stage === "scan-observed") {
      if (
        state.uploadStatus !== "finalized" ||
        action.attachmentId !== state.attachmentId ||
        !["pending", "clean", "rejected", "unavailable"].includes(action.scanStatus) ||
        action.readyToBind !== (action.scanStatus === "clean") ||
        !Number.isInteger(action.version) ||
        action.version < state.version ||
        action.version > state.version + 1 ||
        (["clean", "rejected"].includes(state.scanStatus) && action.scanStatus !== state.scanStatus) ||
        (action.version === state.version &&
          (action.scanStatus !== state.scanStatus || action.readyToBind !== state.readyToBind))
      ) {
        return "UPLOAD_INVALID";
      }
      state.scanStatus = action.scanStatus;
      state.readyToBind = action.readyToBind;
      state.version = action.version;
      continue;
    }

    if (action.stage === "bind") {
      if (
        state.uploadStatus !== "finalized" ||
        state.scanStatus !== "clean" ||
        !state.readyToBind ||
        state.durablyReadable !== true ||
        action.attachmentId !== state.attachmentId
      ) {
        return "pipeline_order_invalid";
      }
      const serverNow = toEpoch(action.serverNow);
      const expiresAt = toEpoch(action.expiresAt);
      if (
        action.expectedVersion !== state.version ||
        action.responseVersion !== state.version + 1 ||
        serverNow === undefined ||
        expiresAt === undefined ||
        expiresAt <= serverNow ||
        expiresAt - serverNow > APP_FIRST_LIMITS.bindingLeaseMaxTtlMs
      ) {
        return action.expectedVersion !== state.version
          ? "VERSION_CONFLICT"
          : "ATTACHMENT_BINDING_CONFLICT";
      }
      if (
        state.bindingId &&
        (serverNow < toEpoch(state.bindingExpiresAt) || serverNow < state.lastServerTime)
      ) {
        return "ATTACHMENT_BINDING_CONFLICT";
      }
      if (!state.bindingId) {
        if (action.leaseGeneration !== 1 || !action.resourceId) {
          return "ATTACHMENT_BINDING_CONFLICT";
        }
        state.bindingId = action.resourceId;
      } else if (
        state.bindingStatus !== "expired" ||
        action.leaseGeneration !== state.leaseGeneration + 1 ||
        action.resourceId !== state.bindingId ||
        action.intent !== state.intent ||
        (action.targetQaItemId ?? null) !== (state.targetQaItemId ?? null)
      ) {
        return "ATTACHMENT_BINDING_CONFLICT";
      }
      state.leaseGeneration = action.leaseGeneration;
      state.bindingStatus = "reserved";
      state.bindingExpiresAt = action.expiresAt;
      state.bindingReservedAt = serverNow;
      state.lastServerTime = serverNow;
      state.intent = action.intent;
      state.targetQaItemId = action.targetQaItemId ?? null;
      state.version = action.responseVersion;
      if (!claimResource("bindings", action.resourceId, clientAttachmentId)) {
        return "duplicate_entities";
      }
      continue;
    }

    if (action.stage === "binding-expired") {
      const observedAt = toEpoch(action.observedAt);
      const expiresAt = toEpoch(state?.bindingExpiresAt);
      if (
        state.bindingStatus !== "reserved" ||
        action.leaseGeneration !== state.leaseGeneration ||
        action.resourceId !== state.bindingId ||
        observedAt === undefined ||
        expiresAt === undefined ||
        observedAt < expiresAt ||
        observedAt < state.lastServerTime
      ) {
        return "ATTACHMENT_BINDING_CONFLICT";
      }
      state.bindingStatus = "expired";
      state.lastServerTime = observedAt;
      continue;
    }

    return "pipeline_order_invalid";
  }

  if (!committedClaims || committedClaims.size !== attachments.size) {
    return "orphan_or_unclaimed_attachment";
  }
  for (const [clientAttachmentId, state] of attachments) {
    if (state.bindingStatus !== "claimed" || !committedClaims.has(clientAttachmentId)) {
      return "orphan_or_unclaimed_attachment";
    }
  }
  const expectedOccurrenceCount = ["bug_create", "occurrence_append"].includes(committedIntent)
    ? 1
    : 0;
  const actualEntityCounts = {
    sessions: resourceSets.sessions.size,
    attachments: resourceSets.attachments.size,
    bindings: resourceSets.bindings.size,
    bugs: resourceSets.bugs.size,
    occurrences: resourceSets.occurrences.size,
  };
  return resourceSets.sessions.size === acceptedSessionCount &&
    resourceSets.attachments.size === attachments.size &&
    resourceSets.bindings.size === attachments.size &&
    resourceSets.bugs.size === 1 &&
    resourceSets.occurrences.size === expectedOccurrenceCount &&
    canonicalString(actualEntityCounts) === canonicalString(input.expectedEntityCounts)
    ? "converged"
    : "duplicate_entities";
}

function evaluateCapture(input) {
  const capture = input.capture;
  if (
    capture.projectId !== input.projectId ||
    capture.clientSubmissionId !== input.clientSubmissionId ||
    capture.artifacts.some((artifact) => artifact.captureId !== capture.captureId)
  ) {
    return "CAPTURE_BUNDLE_INVALID";
  }
  const capturedAt = toEpoch(capture.capturedAt);
  if (capturedAt === undefined) return "CAPTURE_BUNDLE_INVALID";

  const succeededAttachmentIds = new Set();
  const succeededClientAttachmentIds = new Set();
  const attachmentFacts = new Map();
  if (!Array.isArray(input.attachmentFacts)) return "CAPTURE_BUNDLE_INVALID";
  for (const fact of input.attachmentFacts) {
    if (!fact?.attachmentId || attachmentFacts.has(fact.attachmentId)) {
      return "CAPTURE_BUNDLE_INVALID";
    }
    attachmentFacts.set(fact.attachmentId, fact);
  }
  let succeededArtifactCount = 0;

  for (const artifact of capture.artifacts) {
    const startedAt = toEpoch(artifact.startedAt);
    const endedAt = toEpoch(artifact.endedAt);
    if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) {
      return "CAPTURE_BUNDLE_INVALID";
    }
    const actualSkew = Math.abs(startedAt - capturedAt);
    if (
      !Number.isInteger(artifact.skewMs) ||
      artifact.skewMs > APP_FIRST_LIMITS.maxCaptureStartSkewMs ||
      Math.abs(artifact.skewMs - actualSkew) > APP_FIRST_LIMITS.captureTimestampToleranceMs
    ) {
      return "CAPTURE_BUNDLE_INVALID";
    }
    const duration = endedAt - startedAt;
    const maxDuration =
      artifact.kind === "system_recording"
        ? APP_FIRST_LIMITS.maxRecordingDurationMs
        : APP_FIRST_LIMITS.maxScreenshotDurationMs;
    if (duration > maxDuration) return "CAPTURE_BUNDLE_INVALID";
    if (artifact.status === "succeeded") {
      if (!artifact.attachmentId || !artifact.clientAttachmentId || artifact.failureReason !== null) {
        return "CAPTURE_BUNDLE_INVALID";
      }
      if (
        succeededAttachmentIds.has(artifact.attachmentId) ||
        succeededClientAttachmentIds.has(artifact.clientAttachmentId)
      ) {
        return "CAPTURE_BUNDLE_INVALID";
      }
      succeededAttachmentIds.add(artifact.attachmentId);
      succeededClientAttachmentIds.add(artifact.clientAttachmentId);
      succeededArtifactCount += 1;
      const fact = attachmentFacts.get(artifact.attachmentId);
      const sizeLimit =
        artifact.kind === "poco_hierarchy"
          ? APP_FIRST_LIMITS.maxDecodedHierarchyBytes
          : artifact.kind === "poco_snapshot"
            ? APP_FIRST_LIMITS.maxSnapshotSerializedBytes
            : APP_FIRST_LIMITS.maxDecodedArtifactBytes;
      if (
        !fact ||
        fact.accountId !== input.accountId ||
        fact.actorId !== input.actorId ||
        fact.projectId !== input.projectId ||
        fact.clientSubmissionId !== input.clientSubmissionId ||
        fact.clientAttachmentId !== artifact.clientAttachmentId ||
        fact.captureId !== capture.captureId ||
        fact.validatedArtifactKind !== artifact.kind ||
        !artifactMediaTypes.get(artifact.kind)?.has(fact.mediaType) ||
        fact.scanStatus !== "clean" ||
        fact.readyToBind !== true ||
        !["reserved", "claimed"].includes(fact.bindingStatus) ||
        fact.durablyReadable !== true ||
        !Number.isInteger(fact.storedBytes) ||
        fact.storedBytes < 1 ||
        fact.storedBytes > APP_FIRST_LIMITS.maxDecodedArtifactBytes ||
        !Number.isInteger(fact.decodedBytes) ||
        fact.decodedBytes < 1 ||
        fact.decodedBytes > sizeLimit
      ) {
        return "CAPTURE_BUNDLE_INVALID";
      }
    } else if (
      artifact.attachmentId !== null ||
      artifact.clientAttachmentId !== null ||
      (artifact.status === "failed" && !artifact.failureReason)
    ) {
      return "CAPTURE_BUNDLE_INVALID";
    }
  }
  if (attachmentFacts.size !== succeededArtifactCount) return "CAPTURE_BUNDLE_INVALID";

  const primary = capture.artifacts.find(
    (artifact) =>
      artifact.attachmentId === capture.primaryEvidenceAttachmentId &&
      artifact.clientAttachmentId === capture.primaryEvidenceClientAttachmentId,
  );
  if (
    !primary ||
    primary.status !== "succeeded" ||
    !["system_screenshot", "system_recording"].includes(primary.kind)
  ) {
    return "CAPTURE_BUNDLE_INVALID";
  }

  const enrichmentStatus = deriveEnrichmentStatus(capture.poco);
  if (enrichmentStatus === "invalid") return "CAPTURE_BUNDLE_INVALID";
  if (
    (hasOwn(capture, "enrichmentStatus") && capture.enrichmentStatus !== enrichmentStatus) ||
    (hasOwn(capture.poco, "status") && capture.poco.status !== enrichmentStatus)
  ) {
    return "CAPTURE_BUNDLE_INVALID";
  }

  const succeededPocoKinds = new Set(
    capture.artifacts
      .filter((artifact) => artifact.status === "succeeded" && artifact.kind.startsWith("poco_"))
      .map((artifact) => artifact.kind),
  );
  const succeededMethods = new Set(capture.poco.succeededMethods);
  for (const [method, artifactKind] of pocoArtifactByMethod) {
    if (succeededMethods.has(method) !== succeededPocoKinds.has(artifactKind)) {
      return "CAPTURE_BUNDLE_INVALID";
    }
  }
  return `accepted:${enrichmentStatus}`;
}

function evaluateRefresh(input) {
  if (!input.tokenSignatureValid || !input.familyFound || !input.installationMatches) {
    return "REAUTHENTICATION_REQUIRED";
  }
  if (["expired", "revoked"].includes(input.tokenState)) return "REAUTHENTICATION_REQUIRED";
  if (input.tokenState === "active") return "rotate_and_issue";
  if (input.tokenState !== "consumed") return "REAUTHENTICATION_REQUIRED";
  const now = toEpoch(input.now);
  const consumedAt = toEpoch(input.consumedAt);
  const snapshotExpiresAt = toEpoch(input.snapshotExpiresAt);
  if (
    input.sameOperation &&
    input.sameKey &&
    input.samePayload &&
    input.snapshotExists &&
    now !== undefined &&
    consumedAt !== undefined &&
    snapshotExpiresAt !== undefined &&
    snapshotExpiresAt >= consumedAt &&
    snapshotExpiresAt - consumedAt <= APP_FIRST_LIMITS.refreshReplayRetentionMs &&
    now >= consumedAt &&
    now <= snapshotExpiresAt
  ) {
    return "encrypted_secret_replay";
  }
  return "family_revoked_reauthentication_required";
}

function evaluateNativeSessionTiming(tokens, principal) {
  const issuedAt = toEpoch(tokens?.issuedAt);
  const accessExpiresAt = toEpoch(tokens?.accessExpiresAt);
  const refreshExpiresAt = toEpoch(tokens?.refreshExpiresAt);
  const idleExpiresAt = toEpoch(tokens?.session?.idleExpiresAt);
  const absoluteExpiresAt = toEpoch(tokens?.session?.absoluteExpiresAt);
  const sessionCreatedAt = toEpoch(principal?.sessionCreatedAt);
  const originalAbsoluteExpiresAt = toEpoch(principal?.originalAbsoluteExpiresAt);
  const refreshFamilyIssuedAt = toEpoch(principal?.refreshFamilyIssuedAt);
  const refreshFamilyExpiresAt = toEpoch(principal?.refreshFamilyExpiresAt);
  if (
    [
      issuedAt,
      accessExpiresAt,
      refreshExpiresAt,
      idleExpiresAt,
      absoluteExpiresAt,
      sessionCreatedAt,
      originalAbsoluteExpiresAt,
      refreshFamilyIssuedAt,
      refreshFamilyExpiresAt,
    ].some((value) => value === undefined) ||
    issuedAt < sessionCreatedAt ||
    absoluteExpiresAt !== originalAbsoluteExpiresAt ||
    refreshFamilyIssuedAt < sessionCreatedAt ||
    refreshFamilyExpiresAt > originalAbsoluteExpiresAt ||
    refreshExpiresAt > refreshFamilyExpiresAt ||
    accessExpiresAt <= issuedAt ||
    accessExpiresAt - issuedAt > APP_FIRST_LIMITS.accessTokenMaxTtlMs ||
    idleExpiresAt < accessExpiresAt ||
    absoluteExpiresAt < idleExpiresAt ||
    refreshExpiresAt < accessExpiresAt ||
    refreshExpiresAt > absoluteExpiresAt
  ) {
    return "invalid";
  }
  if (tokens.session.sharedDevice) {
    if (
      idleExpiresAt - issuedAt > APP_FIRST_LIMITS.sharedDeviceIdleMaxTtlMs ||
      originalAbsoluteExpiresAt - sessionCreatedAt >
        APP_FIRST_LIMITS.sharedDeviceAbsoluteMaxTtlMs
    ) {
      return "invalid";
    }
  } else if (
    refreshFamilyExpiresAt - refreshFamilyIssuedAt >
    APP_FIRST_LIMITS.personalRefreshMaxTtlMs
  ) {
    return "invalid";
  }
  return "valid";
}

function normalizeProjectMemberships(projects) {
  if (!Array.isArray(projects)) return undefined;
  const normalized = projects.map((project) => ({
    id: project?.id,
    key: project?.key,
    name: project?.name,
    roles: Array.isArray(project?.roles) ? [...project.roles].sort() : project?.roles,
  }));
  if (
    normalized.some(
      (project) =>
        typeof project.id !== "string" ||
        typeof project.key !== "string" ||
        typeof project.name !== "string" ||
        !isUniqueArray(project.roles),
    ) ||
    new Set(normalized.map((project) => project.id)).size !== normalized.length
  ) {
    return undefined;
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function nativeSessionIdentityMatches(session, principal, expectedSharedDevice) {
  if (
    !session ||
    !principal ||
    session.id !== principal.sessionId ||
    session.installationId !== principal.installationId ||
    session.accountId !== principal.accountId ||
    session.user?.id !== principal.userId ||
    session.sharedDevice !== expectedSharedDevice ||
    session.pushAllowed !== !expectedSharedDevice
  ) {
    return false;
  }
  const actualProjects = normalizeProjectMemberships(session.projects);
  const authorizedProjects = normalizeProjectMemberships(principal.authorizedProjects);
  return Boolean(
    actualProjects &&
      authorizedProjects &&
      canonicalString(actualProjects) === canonicalString(authorizedProjects),
  );
}

function validEncryptedReplaySnapshot(input, expectedMutationCount) {
  const snapshotCreatedAt = toEpoch(input.snapshotCreatedAt);
  const snapshotExpiresAt = toEpoch(input.snapshotExpiresAt);
  const serverNow = toEpoch(input.serverNow);
  return Boolean(
    input.encryptedSnapshotPersisted === true &&
      Number.isInteger(input.encryptionKeyVersion) &&
      input.encryptionKeyVersion >= 1 &&
      input.rawSecretAbsent === true &&
      input.requestDigestAlgorithm === "HMAC-SHA-256" &&
      input.serverPepperProtected === true &&
      typeof input.idempotencyKey === "string" &&
      input.idempotencyKey.length > 0 &&
      input.idempotencyKey === input.persistedIdempotencyKey &&
      typeof input.canonicalRequestDigest === "string" &&
      input.canonicalRequestDigest.length >= 16 &&
      input.canonicalRequestDigest === input.persistedRequestDigest &&
      input.originalEffectCommitted === true &&
      input.mutationCount === expectedMutationCount &&
      snapshotCreatedAt !== undefined &&
      snapshotExpiresAt !== undefined &&
      serverNow !== undefined &&
      snapshotCreatedAt <= serverNow &&
      serverNow <= snapshotExpiresAt &&
      snapshotExpiresAt - snapshotCreatedAt <= APP_FIRST_LIMITS.refreshReplayRetentionMs,
  );
}

function validEncryptedResponseSnapshot(input, response, expectedDigest, expectedMutationCount) {
  if (!input.persistedResponse) return false;
  const responseWithoutReplay = structuredClone(response);
  const persistedWithoutReplay = structuredClone(input.persistedResponse);
  delete responseWithoutReplay.replayed;
  delete persistedWithoutReplay.replayed;
  return Boolean(
    validEncryptedReplaySnapshot(input, expectedMutationCount) &&
      input.canonicalRequestDigest === expectedDigest &&
      canonicalString(responseWithoutReplay) === canonicalString(persistedWithoutReplay) &&
      typeof input.responseSecretDigest === "string" &&
      input.responseSecretDigest.length >= 16 &&
      input.responseSecretDigest === input.persistedResponseSecretDigest,
  );
}

function evaluateNativeSessionReceipt(input) {
  const { request, response, principal } = input;
  const session = response?.session;
  if (!request || !session || !principal) return "invalid";
  const expectedSharedDevice =
    input.operation === "login" ? request.sharedDevice : principal.sharedDevice;
  if (
    !["login", "refresh"].includes(input.operation) ||
    request.installationId !== principal.installationId ||
    !nativeSessionIdentityMatches(session, principal, expectedSharedDevice)
  ) {
    return "invalid";
  }
  if (evaluateNativeSessionTiming(response, principal) !== "valid") return "invalid";
  if (input.operation === "login") {
    const expectedDigest = canonicalReplayDigest(
      "createNativeSession",
      {
        accountId: principal.accountId,
        actorId: principal.userId,
        installationId: principal.installationId,
      },
      request,
      input.idempotencyKey,
      input.serverPepper,
    );
    if (input.loginState === "exact_replay") {
      return response.replayed === true &&
        input.replayAuthorized === true &&
        validEncryptedResponseSnapshot(input, response, expectedDigest, 0)
        ? "valid"
        : "invalid";
    }
    return input.credentialsVerified === true &&
      response.replayed === false &&
      validEncryptedResponseSnapshot(input, response, expectedDigest, 1)
      ? "valid"
      : "invalid";
  }
  if (input.refreshState === "active") {
    const expectedDigest = canonicalReplayDigest(
      "refreshNativeSession",
      {
        accountId: principal.accountId,
        actorId: principal.userId,
        installationId: principal.installationId,
      },
      request,
      input.idempotencyKey,
      input.serverPepper,
    );
    return response.replayed === false &&
      validEncryptedResponseSnapshot(input, response, expectedDigest, 1) &&
      typeof input.requestRefreshTokenHmac === "string" &&
      input.requestRefreshTokenHmac.length >= 16 &&
      input.requestRefreshTokenHmac === input.activeRefreshTokenHmac &&
      input.priorRefreshTokenDisabled === true &&
      typeof input.persistedNewRefreshTokenHmac === "string" &&
      input.persistedNewRefreshTokenHmac.length >= 16 &&
      input.persistedNewRefreshTokenHmac === input.responseRefreshTokenHmac &&
      input.persistedNewRefreshTokenHmac !== input.activeRefreshTokenHmac &&
      Number.isInteger(input.tokenFamilyGenerationBefore) &&
      input.tokenFamilyGenerationAfter === input.tokenFamilyGenerationBefore + 1 &&
      Number.isInteger(principal.sessionVersion) &&
      response.session.version === principal.sessionVersion + 1
      ? "valid"
      : "invalid";
  }
  if (input.refreshState === "consumed_exact_replay") {
    if (!input.persistedResponse) return "invalid";
    const consumedAt = toEpoch(input.consumedAt);
    const snapshotCreatedAt = toEpoch(input.snapshotCreatedAt);
    const snapshotExpiresAt = toEpoch(input.snapshotExpiresAt);
    const expectedDigest = canonicalReplayDigest(
      "refreshNativeSession",
      {
        accountId: principal.accountId,
        actorId: principal.userId,
        installationId: principal.installationId,
      },
      request,
      input.idempotencyKey,
      input.serverPepper,
    );
    return response.replayed === true &&
      input.replayAuthorized === true &&
      validEncryptedResponseSnapshot(input, response, expectedDigest, 0) &&
      consumedAt !== undefined &&
      snapshotCreatedAt === consumedAt &&
      snapshotExpiresAt - consumedAt <= APP_FIRST_LIMITS.refreshReplayRetentionMs &&
      Number.isInteger(input.tokenFamilyGenerationBefore) &&
      input.tokenFamilyGenerationAfter === input.tokenFamilyGenerationBefore
      ? "valid"
      : "invalid";
  }
  return "invalid";
}

function evaluateNotificationRegistration(input) {
  if (
    input.session.sharedDevice ||
    !input.session.pushAllowed ||
    input.request.installationId !== input.session.installationId
  ) {
    return "FORBIDDEN";
  }
  const now = toEpoch(input.now);
  const tokenIssuedAt = toEpoch(input.request.tokenIssuedAt);
  if (
    now === undefined ||
    tokenIssuedAt === undefined ||
    tokenIssuedAt - now > APP_FIRST_LIMITS.notificationTokenMaxFutureSkewMs
  ) {
    return "INVALID_REQUEST";
  }
  if (
    input.existing &&
    (input.existing.accountId !== input.session.accountId ||
      input.existing.userId !== input.session.user?.id ||
      input.existing.installationId !== input.session.installationId)
  ) {
    return "NOT_FOUND";
  }
  if (input.exactReplay) return `replay:${input.existing?.version ?? 1}`;
  if (!input.existing) {
    return input.request.expectedVersion === null ? "created:1" : "VERSION_CONFLICT";
  }
  if (input.request.expectedVersion !== input.existing.version) return "VERSION_CONFLICT";
  return `rotated:${input.existing.version + 1}`;
}

function evaluateNotificationRevoke(input) {
  if (
    input.session.sharedDevice ||
    input.resourceAccountId !== input.session.accountId ||
    input.request.installationId !== input.session.installationId ||
    input.pathDeviceId !== input.resourceDeviceId ||
    input.resourceInstallationId !== input.session.installationId ||
    input.resourceUserId !== input.session.user?.id
  ) {
    return "NOT_FOUND";
  }
  if (input.exactReplay) return "replay";
  return input.request.expectedVersion === input.resourceVersion ? "revoked" : "VERSION_CONFLICT";
}

function evaluateNotificationRevokeReceipt(input) {
  const outcome = evaluateNotificationRevoke(input);
  if (outcome === "NOT_FOUND" || outcome === "VERSION_CONFLICT") return outcome;
  if (outcome === "replay") {
    return input.replayAuthorized === true &&
      input.idempotencyKey === input.persistedIdempotencyKey &&
      input.canonicalRequestDigest === input.persistedRequestDigest &&
      input.originalEffectCommitted === true &&
      input.mutationCount === 0
      ? "replayed"
      : "ambiguous";
  }
  return input.deviceDisabled === true &&
    input.encryptedTokenCleared === true &&
    input.rawTokenAbsent === true &&
    input.activeTokenIndexRemoved === true &&
    input.tombstoneCommitted === true &&
    input.versionAfter === input.resourceVersion + 1
    ? "revoked"
    : "ambiguous";
}

function evaluateNativeSessionRevoke(input) {
  const { request, session } = input;
  if (
    !request ||
    !session ||
    request.installationId !== session.installationId ||
    input.accountId !== session.accountId ||
    input.actorId !== session.user?.id
  ) {
    return "NOT_FOUND";
  }
  if (input.exactReplay) {
    return input.replayAuthorized === true &&
      input.idempotencyKey === input.persistedIdempotencyKey &&
      input.canonicalRequestDigest === input.persistedRequestDigest &&
      input.originalEffectCommitted === true &&
      input.mutationCount === 0
      ? "replayed"
      : "ambiguous";
  }
  if (request.expectedVersion !== session.version) return "VERSION_CONFLICT";
  return request.clearNotificationDevice === true &&
    input.sessionRevoked === true &&
    input.accessTokensRejected === true &&
    input.refreshFamilyDisabled === true &&
    input.refreshSecretsCleared === true &&
    input.notificationBindingCleared === true &&
    input.auditCommitted === true &&
    input.versionAfter === session.version + 1
    ? "revoked"
    : "ambiguous";
}

function evaluatePocoCorrelation(input) {
  const decodedLimitByKind = {
    artifact: APP_FIRST_LIMITS.maxDecodedArtifactBytes,
    profiling: APP_FIRST_LIMITS.maxDecodedArtifactBytes,
    hierarchy: APP_FIRST_LIMITS.maxDecodedHierarchyBytes,
    snapshot: APP_FIRST_LIMITS.maxSnapshotSerializedBytes,
    metadata: APP_FIRST_LIMITS.maxSnapshotSerializedBytes,
  };
  const decodedLimit = decodedLimitByKind[input.responseKind];
  let snapshotPayloadValid = true;
  if (input.request.method === "qa.snapshot") {
    const payload = input.decodedPayload;
    const recentErrors = payload?.snapshot?.recentErrors ?? [];
    const customFields = payload?.snapshot?.customFields ?? {};
    const serializedBytes = payload
      ? Buffer.byteLength(JSON.stringify(payload), "utf8")
      : undefined;
    const recentErrorUtf8Bytes = Array.isArray(recentErrors)
      ? recentErrors.reduce((total, entry) => total + Buffer.byteLength(entry, "utf8"), 0)
      : undefined;
    snapshotPayloadValid = Boolean(
      payload &&
        payload.captureId === input.response.captureId &&
        payload.nonce === input.response.nonce &&
        payload.schemaVersion === input.response.schemaVersion &&
        toEpoch(payload.generatedAt) !== undefined &&
        payload.redactionPolicyVersion === pocoPrivacyPolicyVersion &&
        payload.sensitiveFieldsOmitted === true &&
        input.redactionApplied === true &&
        input.sensitiveValueScanPassed === true &&
        Number.isInteger(serializedBytes) &&
        serializedBytes === input.decodedBytes &&
        serializedBytes === input.snapshotSerializedBytes &&
        serializedBytes <= APP_FIRST_LIMITS.maxSnapshotSerializedBytes &&
        Array.isArray(recentErrors) &&
        recentErrors.length === input.recentErrorCount &&
        Number.isInteger(recentErrorUtf8Bytes) &&
        recentErrorUtf8Bytes === input.recentErrorUtf8Bytes &&
        recentErrorUtf8Bytes <= APP_FIRST_LIMITS.maxRecentErrorUtf8Bytes &&
        recentErrors.every(
          (entry) => typeof entry === "string" && !sensitiveLogAssignment.test(entry),
        ) &&
        customFields &&
        typeof customFields === "object" &&
        !Array.isArray(customFields) &&
        Object.keys(customFields).length === input.customFieldCount &&
        Object.keys(customFields).every((key) => !sensitiveCustomFieldKey.test(key)) &&
        (payload.snapshot.pseudonymousTestUserId == null ||
          !/@/.test(payload.snapshot.pseudonymousTestUserId)),
    );
  }
  return typeof input.request.rpcRequestId === "string" &&
    input.request.rpcRequestId.length > 0 &&
    input.request.rpcRequestId === input.response.rpcResponseId &&
    pocoMethods.has(input.request.method) &&
    input.request.method === input.response.method &&
    pocoResponseKindByMethod.get(input.request.method) === input.responseKind &&
    input.request.captureId === input.response.captureId &&
    input.request.nonce === input.response.nonce &&
    input.request.schemaVersion === input.response.schemaVersion &&
    APP_FIRST_LIMITS.supportedPocoSnapshotSchemaVersions.includes(input.response.schemaVersion) &&
    Number.isInteger(input.request.deadlineMs) &&
    input.request.deadlineMs >= APP_FIRST_LIMITS.minPocoDeadlineMs &&
    input.request.deadlineMs <= APP_FIRST_LIMITS.maxPocoDeadlineMs &&
    Number.isInteger(input.elapsedMs) &&
    input.elapsedMs >= 0 &&
    input.elapsedMs <= input.request.deadlineMs &&
    input.cancelled === false &&
    Number.isInteger(input.frameLength) &&
    input.frameLength > 0 &&
    input.frameLength <= APP_FIRST_LIMITS.maxFrameBytes &&
    input.frameBytesReceived === input.frameLength &&
    Number.isInteger(input.decodedBytes) &&
    input.decodedBytes > 0 &&
    decodedLimit !== undefined &&
    input.decodedBytes <= decodedLimit &&
    Number.isInteger(input.snapshotSerializedBytes) &&
    input.snapshotSerializedBytes >= 0 &&
    input.snapshotSerializedBytes <= APP_FIRST_LIMITS.maxSnapshotSerializedBytes &&
    Number.isInteger(input.recentErrorCount) &&
    input.recentErrorCount >= 0 &&
    input.recentErrorCount <= APP_FIRST_LIMITS.maxRecentErrorCount &&
    Number.isInteger(input.customFieldCount) &&
    input.customFieldCount >= 0 &&
    input.customFieldCount <= APP_FIRST_LIMITS.maxCustomFieldCount &&
    snapshotPayloadValid
    ? "accepted"
    : "CAPTURE_BUNDLE_INVALID";
}

function evaluateEvidenceResourceTuple(input) {
  if (
    input.actorAccountId !== input.resourceAccountId ||
    input.actorId !== input.resourceActorId ||
    input.actorProjectId !== input.resourceProjectId ||
    input.pathResourceId !== input.resourceId
  ) {
    return "NOT_FOUND";
  }
  if (
    input.requestClientSubmissionId !== input.resourceClientSubmissionId ||
    input.requestClientAttachmentId !== input.resourceClientAttachmentId ||
    input.requestIntent !== input.resourceIntent ||
    (input.requestTargetQaItemId ?? null) !== (input.resourceTargetQaItemId ?? null)
  ) {
    return "ATTACHMENT_BINDING_CONFLICT";
  }
  return "allowed";
}

function evaluateQaItemIdentity(input) {
  const response = input.response;
  if (response.qaItem?.type !== "bug") return "ambiguous";
  if (input.operation === "create") {
    return response.qaItem.id === response.bug?.id && response.qaItem.key === response.bug?.key
      ? "unambiguous"
      : "ambiguous";
  }
  if (input.operation === "append") {
    return response.qaItem.id === response.bugId &&
      response.qaItem.key === response.bugKey &&
      response.qaItem.id === input.targetQaItemId &&
      response.qaItem.key === input.targetQaItemKey
      ? "unambiguous"
      : "ambiguous";
  }
  if (input.operation === "comment") {
    return response.qaItem.id === response.comment?.bugId &&
      response.qaItem.id === input.targetQaItemId &&
      response.qaItem.key === input.targetQaItemKey
      ? "unambiguous"
      : "ambiguous";
  }
  if (input.operation === "verification") {
    return response.qaItem.id === response.bug?.id &&
      response.qaItem.key === response.bug?.key &&
      response.qaItem.id === response.verification?.bugId &&
      response.qaItem.id === input.targetQaItemId &&
      response.qaItem.key === input.targetQaItemKey &&
      response.verification?.id === input.targetVerificationId
      ? "unambiguous"
      : "ambiguous";
  }
  return "ambiguous";
}

function sameExactStringSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === new Set(left).size &&
    right.length === new Set(right).size &&
    canonicalString([...left].sort()) === canonicalString([...right].sort())
  );
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

function resourceScopeMatches(input, resource, projectId = resource?.projectId) {
  return Boolean(
    resource &&
      input.accountId === resource.accountId &&
      input.actorId === resource.actorId &&
      projectId === resource.projectId &&
      input.authorizedProjectIds?.includes(projectId),
  );
}

const maximumDateEpoch = 8_640_000_000_000_000;

function ascendingDateSortKey(value) {
  const epoch = toEpoch(value);
  return epoch === undefined ? null : String(epoch).padStart(16, "0");
}

function descendingDateSortKey(value) {
  const epoch = toEpoch(value);
  return epoch === undefined
    ? null
    : String(maximumDateEpoch - epoch).padStart(16, "0");
}

function nativeBugSortKey(bug, sort) {
  if (sort === "updated_desc") {
    const time = descendingDateSortKey(bug.updatedAt);
    return time == null ? null : `${time}:${bug.id}`;
  }
  if (sort === "created_desc") {
    const time = descendingDateSortKey(bug.createdAt);
    return time == null ? null : `${time}:${bug.id}`;
  }
  if (sort === "priority_desc") {
    const priorityRank = new Map([
      ["P0", "0"],
      ["P1", "1"],
      ["P2", "2"],
      ["P3", "3"],
      ["P4", "4"],
    ]).get(bug.priority);
    const time = descendingDateSortKey(bug.updatedAt);
    return priorityRank == null || time == null
      ? null
      : `${priorityRank}:${time}:${bug.id}`;
  }
  return null;
}

function signedPageReceiptMatches(
  input,
  {
    operationId,
    query,
    response,
    normalizedFilters,
    orderedItemIds,
    orderedSortKeys,
    scope,
    limit,
    maxItemCount = limit,
  },
) {
  const authorizedProjectIds = Array.isArray(input.authorizedProjectIds)
    ? [...input.authorizedProjectIds].sort()
    : [];
  const authorizationFacts = input.pageAuthorizationFacts;
  if (
    typeof input.accountId !== "string" ||
    input.accountId.length === 0 ||
    typeof input.actorId !== "string" ||
    input.actorId.length === 0 ||
    typeof input.membershipRevision !== "string" ||
    input.membershipRevision.length === 0 ||
    !Array.isArray(input.authorizedProjectIds) ||
    !isUniqueArray(input.authorizedProjectIds) ||
    !Array.isArray(authorizationFacts) ||
    authorizationFacts.length !== authorizedProjectIds.length ||
    new Set(authorizationFacts.map((fact) => fact.projectId)).size !==
      authorizationFacts.length ||
    authorizedProjectIds.some((projectId) => {
      const fact = authorizationFacts.find((candidate) => candidate.projectId === projectId);
      return (
        !fact ||
        fact.accountId !== input.accountId ||
        fact.actorId !== input.actorId ||
        fact.membershipRevision !== input.membershipRevision ||
        fact.currentActive !== true
      );
    }) ||
    !query ||
    !response ||
    !Array.isArray(orderedItemIds) ||
    !Array.isArray(orderedSortKeys) ||
    orderedSortKeys.length !== orderedItemIds.length ||
    orderedSortKeys.some(
      (sortKey, index) =>
        typeof sortKey !== "string" ||
        sortKey.length === 0 ||
        (index > 0 && sortKey <= orderedSortKeys[index - 1]),
    ) ||
    new Set(orderedItemIds).size !== orderedItemIds.length ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(maxItemCount) ||
    maxItemCount < 0 ||
    orderedItemIds.length > maxItemCount ||
    !Number.isInteger(response.snapshotSequence) ||
    response.snapshotSequence < 0 ||
    (query.cursor != null &&
      (typeof query.cursor !== "string" || query.cursor.length < 1 || query.cursor.length > 500)) ||
    (response.nextCursor != null &&
      (typeof response.nextCursor !== "string" ||
        response.nextCursor.length < 1 ||
        response.nextCursor.length > 500)) ||
    (orderedItemIds.length === 0 && response.nextCursor != null)
  ) {
    return false;
  }
  const membershipSetDigest = canonicalNonSecretRequestDigest(
    `${operationId}:membership-set`,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision: input.membershipRevision,
    },
    authorizedProjectIds,
    "membership",
  );
  const filterDigest = canonicalNonSecretRequestDigest(
    `${operationId}:filters`,
    { accountId: input.accountId, actorId: input.actorId, ...scope },
    normalizedFilters,
    "filters",
  );
  const cursorScopeDigest = canonicalNonSecretRequestDigest(
    `${operationId}:cursor-scope`,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision: input.membershipRevision,
      membershipSetDigest,
      filterDigest,
      snapshotSequence: response.snapshotSequence,
      ...scope,
    },
    { limit },
    "cursor",
  );
  const queryDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision: input.membershipRevision,
      membershipSetDigest,
      ...scope,
    },
    query,
    "query",
  );
  const cursorMatches =
    query.cursor == null
      ? input.cursorFact == null
      : input.cursorFact?.token === query.cursor &&
        input.cursorFact?.signatureValid === true &&
        input.cursorFact?.accountId === input.accountId &&
        input.cursorFact?.actorId === input.actorId &&
        input.cursorFact?.membershipRevision === input.membershipRevision &&
        input.cursorFact?.membershipSetDigest === membershipSetDigest &&
        input.cursorFact?.filterDigest === filterDigest &&
        input.cursorFact?.snapshotSequence === response.snapshotSequence &&
        input.cursorFact?.cursorScopeDigest === cursorScopeDigest &&
        typeof input.cursorFact?.lastSortKey === "string" &&
        input.cursorFact.lastSortKey.length > 0 &&
        input.cursorFact.applied === true &&
        orderedSortKeys.every((sortKey) => sortKey > input.cursorFact.lastSortKey);
  const pageLastSortKey =
    orderedSortKeys.length === 0 ? null : orderedSortKeys[orderedSortKeys.length - 1];
  const nextCursorMatches =
    response.nextCursor == null
      ? input.nextCursorFact == null
      : input.nextCursorFact?.token === response.nextCursor &&
        input.nextCursorFact?.signatureValid === true &&
        input.nextCursorFact?.accountId === input.accountId &&
        input.nextCursorFact?.actorId === input.actorId &&
        input.nextCursorFact?.membershipRevision === input.membershipRevision &&
        input.nextCursorFact?.membershipSetDigest === membershipSetDigest &&
        input.nextCursorFact?.filterDigest === filterDigest &&
        input.nextCursorFact?.snapshotSequence === response.snapshotSequence &&
        input.nextCursorFact?.cursorScopeDigest === cursorScopeDigest &&
        input.nextCursorFact?.lastSortKey === pageLastSortKey &&
        input.nextCursorFact?.progress === true;
  return Boolean(
    cursorMatches &&
      nextCursorMatches &&
      input.pageFact?.operationId === operationId &&
      input.pageFact?.accountId === input.accountId &&
      input.pageFact?.actorId === input.actorId &&
      input.pageFact?.membershipRevision === input.membershipRevision &&
      input.pageFact?.membershipSetDigest === membershipSetDigest &&
      input.pageFact?.filterDigest === filterDigest &&
      input.pageFact?.cursorScopeDigest === cursorScopeDigest &&
      input.pageFact?.queryDigest === queryDigest &&
      input.pageFact?.snapshotSequence === response.snapshotSequence &&
      input.pageFact?.limit === limit &&
      input.pageFact?.cursorApplied === (query.cursor != null) &&
      input.pageFact?.lastSortKey === pageLastSortKey &&
      sameNullable(input.pageFact?.cursor, query.cursor) &&
      sameNullable(input.pageFact?.nextCursor, response.nextCursor) &&
      canonicalString(input.pageFact?.orderedItemIds) === canonicalString(orderedItemIds) &&
      canonicalString(input.pageFact?.orderedSortKeys) === canonicalString(orderedSortKeys),
  );
}

function workflowPageReceiptMatches(input, { query, response, collections, scope, limit }) {
  const operationId = "getBugWorkflowProjection";
  const authorizedProjectIds = Array.isArray(input.authorizedProjectIds)
    ? [...input.authorizedProjectIds].sort()
    : [];
  const authorizationFacts = input.pageAuthorizationFacts;
  const collectionNames = collections.map(([name]) => name);
  const orderedItemIdsByCollection = Object.fromEntries(
    collections.map(([name, items, identity]) => [name, items.map(identity)]),
  );
  const orderedSortKeysByCollection = structuredClone(orderedItemIdsByCollection);
  const exactCollectionKeys = (value) =>
    value &&
    !Array.isArray(value) &&
    canonicalString(Object.keys(value).sort()) === canonicalString([...collectionNames].sort());
  if (
    typeof input.accountId !== "string" ||
    input.accountId.length === 0 ||
    typeof input.actorId !== "string" ||
    input.actorId.length === 0 ||
    typeof input.membershipRevision !== "string" ||
    input.membershipRevision.length === 0 ||
    !Array.isArray(input.authorizedProjectIds) ||
    !isUniqueArray(input.authorizedProjectIds) ||
    !Array.isArray(authorizationFacts) ||
    authorizationFacts.length !== authorizedProjectIds.length ||
    new Set(authorizationFacts.map((fact) => fact.projectId)).size !==
      authorizationFacts.length ||
    authorizedProjectIds.some((projectId) => {
      const fact = authorizationFacts.find((candidate) => candidate.projectId === projectId);
      return (
        !fact ||
        fact.accountId !== input.accountId ||
        fact.actorId !== input.actorId ||
        fact.membershipRevision !== input.membershipRevision ||
        fact.currentActive !== true
      );
    }) ||
    !query ||
    !response ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(response.snapshotSequence) ||
    response.snapshotSequence < 0 ||
    collections.some(([, items]) => items.length > limit) ||
    Object.values(orderedSortKeysByCollection).some(
      (keys) =>
        new Set(keys).size !== keys.length ||
        keys.some(
          (key, index) =>
            typeof key !== "string" ||
            key.length === 0 ||
            (index > 0 && key <= keys[index - 1]),
        ),
    ) ||
    (query.cursor != null &&
      (typeof query.cursor !== "string" || query.cursor.length < 1 || query.cursor.length > 500)) ||
    (response.nextCursor != null &&
      (typeof response.nextCursor !== "string" ||
        response.nextCursor.length < 1 ||
        response.nextCursor.length > 500)) ||
    !exactCollectionKeys(input.collectionHasMoreFact) ||
    Object.values(input.collectionHasMoreFact).some((value) => typeof value !== "boolean")
  ) {
    return false;
  }
  const membershipSetDigest = canonicalNonSecretRequestDigest(
    `${operationId}:membership-set`,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision: input.membershipRevision,
    },
    authorizedProjectIds,
    "membership",
  );
  const filterDigest = canonicalNonSecretRequestDigest(
    `${operationId}:filters`,
    { accountId: input.accountId, actorId: input.actorId, ...scope },
    {},
    "filters",
  );
  const cursorScopeDigest = canonicalNonSecretRequestDigest(
    `${operationId}:cursor-scope`,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision: input.membershipRevision,
      membershipSetDigest,
      filterDigest,
      snapshotSequence: response.snapshotSequence,
      ...scope,
    },
    { collectionNames, limit },
    "cursor",
  );
  const queryDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision: input.membershipRevision,
      membershipSetDigest,
      ...scope,
    },
    query,
    "query",
  );
  const initialWatermarks = Object.fromEntries(collectionNames.map((name) => [name, null]));
  const cursorMatches =
    query.cursor == null
      ? input.cursorFact == null
      : input.cursorFact?.token === query.cursor &&
        input.cursorFact?.signatureValid === true &&
        input.cursorFact?.accountId === input.accountId &&
        input.cursorFact?.actorId === input.actorId &&
        input.cursorFact?.membershipRevision === input.membershipRevision &&
        input.cursorFact?.membershipSetDigest === membershipSetDigest &&
        input.cursorFact?.filterDigest === filterDigest &&
        input.cursorFact?.snapshotSequence === response.snapshotSequence &&
        input.cursorFact?.cursorScopeDigest === cursorScopeDigest &&
        exactCollectionKeys(input.cursorFact?.lastSortKeys) &&
        exactCollectionKeys(input.cursorFact?.hasMore) &&
        Object.values(input.cursorFact.hasMore).every((value) => typeof value === "boolean") &&
        input.cursorFact.applied === true;
  if (!cursorMatches) return false;
  const previousWatermarks =
    query.cursor == null ? initialWatermarks : input.cursorFact.lastSortKeys;
  const previousHasMore =
    query.cursor == null
      ? Object.fromEntries(collectionNames.map((name) => [name, true]))
      : input.cursorFact.hasMore;
  if (
    Object.values(previousWatermarks).some(
      (value) => value != null && (typeof value !== "string" || value.length === 0),
    ) ||
    collectionNames.some((name) =>
      orderedSortKeysByCollection[name].some(
        (key) => previousWatermarks[name] != null && key <= previousWatermarks[name],
      ),
    ) ||
    (query.cursor != null &&
      collectionNames.some(
        (name) =>
          (previousHasMore[name] === false &&
            (orderedSortKeysByCollection[name].length !== 0 ||
              input.collectionHasMoreFact[name] !== false)) ||
          (previousHasMore[name] === true && orderedSortKeysByCollection[name].length === 0),
      )) ||
    collectionNames.some(
      (name) =>
        input.collectionHasMoreFact[name] === true &&
        orderedSortKeysByCollection[name].length !== limit,
    )
  ) {
    return false;
  }
  if (
    !exactCollectionKeys(input.collectionPageFacts) ||
    collectionNames.some((name) => {
      const fact = input.collectionPageFacts[name];
      return (
        fact?.accountId !== input.accountId ||
        fact?.actorId !== input.actorId ||
        fact?.projectId !== scope.projectId ||
        fact?.bugId !== scope.bugId ||
        fact?.snapshotSequence !== response.snapshotSequence ||
        !sameNullable(fact?.afterSortKey, previousWatermarks[name]) ||
        canonicalString(fact?.returnedItemIds) !==
          canonicalString(orderedItemIdsByCollection[name]) ||
        fact?.hasMore !== input.collectionHasMoreFact[name] ||
        fact?.queryExecuted !== true
      );
    })
  ) {
    return false;
  }
  const nextWatermarks = Object.fromEntries(
    collectionNames.map((name) => [
      name,
      orderedSortKeysByCollection[name].at(-1) ?? previousWatermarks[name],
    ]),
  );
  const hasMore = Object.values(input.collectionHasMoreFact).some(Boolean);
  const emittedAnyItem = Object.values(orderedItemIdsByCollection).some((ids) => ids.length > 0);
  if (
    response.truncated !== hasMore ||
    (response.nextCursor != null) !== hasMore ||
    (hasMore && !emittedAnyItem)
  ) {
    return false;
  }
  const nextCursorMatches =
    response.nextCursor == null
      ? input.nextCursorFact == null
      : input.nextCursorFact?.token === response.nextCursor &&
        input.nextCursorFact?.signatureValid === true &&
        input.nextCursorFact?.accountId === input.accountId &&
        input.nextCursorFact?.actorId === input.actorId &&
        input.nextCursorFact?.membershipRevision === input.membershipRevision &&
        input.nextCursorFact?.membershipSetDigest === membershipSetDigest &&
        input.nextCursorFact?.filterDigest === filterDigest &&
        input.nextCursorFact?.snapshotSequence === response.snapshotSequence &&
        input.nextCursorFact?.cursorScopeDigest === cursorScopeDigest &&
        canonicalString(input.nextCursorFact?.lastSortKeys) === canonicalString(nextWatermarks) &&
        canonicalString(input.nextCursorFact?.hasMore) ===
          canonicalString(input.collectionHasMoreFact) &&
        input.nextCursorFact?.progress === true;
  return Boolean(
    nextCursorMatches &&
      input.pageFact?.operationId === operationId &&
      input.pageFact?.accountId === input.accountId &&
      input.pageFact?.actorId === input.actorId &&
      input.pageFact?.membershipRevision === input.membershipRevision &&
      input.pageFact?.membershipSetDigest === membershipSetDigest &&
      input.pageFact?.filterDigest === filterDigest &&
      input.pageFact?.cursorScopeDigest === cursorScopeDigest &&
      input.pageFact?.queryDigest === queryDigest &&
      input.pageFact?.snapshotSequence === response.snapshotSequence &&
      input.pageFact?.limitPerCollection === limit &&
      input.pageFact?.cursorApplied === (query.cursor != null) &&
      sameNullable(input.pageFact?.cursor, query.cursor) &&
      sameNullable(input.pageFact?.nextCursor, response.nextCursor) &&
      canonicalString(input.pageFact?.orderedItemIdsByCollection) ===
        canonicalString(orderedItemIdsByCollection) &&
      canonicalString(input.pageFact?.orderedSortKeysByCollection) ===
        canonicalString(orderedSortKeysByCollection) &&
      canonicalString(input.pageFact?.lastSortKeys) === canonicalString(nextWatermarks) &&
      canonicalString(input.pageFact?.hasMore) === canonicalString(input.collectionHasMoreFact)
  );
}

function responseBodyWithoutReplayMarker(response) {
  if (response == null) return null;
  const body = structuredClone(response);
  if (body && typeof body === "object" && !Array.isArray(body)) delete body.replayed;
  return body;
}

function evaluateNonSecretWriteReceiptInvariant(
  input,
  {
    operationId,
    scope,
    requestForDigest,
    expectedIdempotencyKey,
    expectedHttpStatus,
    response,
    responseHasReplayMarker = true,
  },
) {
  const expectedDigest = canonicalNonSecretRequestDigest(
    operationId,
    scope,
    requestForDigest,
    input.idempotencyKey,
  );
  const currentHttpReceipt = {
    status: input.httpStatus,
    headers: structuredClone(input.responseHeaders ?? {}),
    body: responseBodyWithoutReplayMarker(response),
  };
  return (
    typeof expectedIdempotencyKey === "string" &&
    input.idempotencyKey === expectedIdempotencyKey &&
    input.persistedIdempotencyKey === expectedIdempotencyKey &&
    input.canonicalRequestDigest === expectedDigest &&
    input.persistedRequestDigest === expectedDigest &&
    input.authorizationCheckedBeforeIdempotency === true &&
    input.idempotencyRecordCommitted === true &&
    input.originalEffectCommitted === true &&
    input.atomicReceiptAndEffectCommitted === true &&
    input.mutationCount === (input.exactReplay ? 0 : 1) &&
    (!input.exactReplay || input.replayAuthorized === true) &&
    input.httpStatus === expectedHttpStatus &&
    input.persistedHttpReceipt?.status === expectedHttpStatus &&
    !Object.hasOwn(input.persistedHttpReceipt?.body ?? {}, "replayed") &&
    canonicalString(currentHttpReceipt) === canonicalString(input.persistedHttpReceipt) &&
    (!responseHasReplayMarker || response?.replayed === input.exactReplay)
  );
}

export function canonicalChunkRequestEnvelope(input) {
  const bytes = decodeCanonicalBase64(input.contentBytesBase64);
  if (!bytes) return undefined;
  return {
    sessionId: input.pathSessionId,
    chunkNumber: input.pathChunkNumber,
    uploadAttempt: input.resource?.uploadAttempt,
    ifMatch: input.ifMatch,
    contentLength: input.contentLength,
    xChunkSha256: input.xChunkSha256,
    xClientSubmissionId: input.xClientSubmissionId,
    xClientAttachmentId: input.xClientAttachmentId,
    bodySha256: sha256Hex(bytes),
  };
}

function evaluateUploadReceipt(input) {
  const { mode, request, response, resource } = input;
  if (!resourceScopeMatches(input, resource)) return "ambiguous";

  if (mode === "init") {
    const serverNow = toEpoch(input.serverNow);
    const expiresAt = toEpoch(response?.expiresAt);
    const identityMatches = Boolean(
      request &&
      response &&
      request.projectId === resource.projectId &&
      request.projectId === response.projectId &&
      request.clientSubmissionId === resource.clientSubmissionId &&
      request.clientSubmissionId === response.clientSubmissionId &&
      request.clientAttachmentId === resource.clientAttachmentId &&
      request.clientAttachmentId === response.clientAttachmentId &&
      request.uploadAttempt === resource.uploadAttempt &&
      request.uploadAttempt === response.uploadAttempt &&
      request.expectedSize === resource.expectedSize &&
      response.expectedSize === resource.expectedSize &&
      request.filename === resource.filename &&
      response.filename === resource.filename &&
      request.mediaType === resource.mediaType &&
      response.mediaType === resource.mediaType &&
      sameNullable(request.captureId, resource.captureId) &&
      sameNullable(response.captureId, resource.captureId) &&
      request.sha256 === resource.sha256 &&
      response.sha256 === resource.sha256 &&
      response.sessionId === resource.sessionId &&
      response.status === "open" &&
      response.chunkSize === resource.chunkSize &&
      response.expectedChunkCount === Math.ceil(resource.expectedSize / resource.chunkSize) &&
      response.receivedBytes === 0 &&
      response.attachmentId === null &&
      response.expiresAt === resource.expiresAt &&
      response.version === 1 &&
      Array.isArray(response.confirmedChunks) &&
      response.confirmedChunks.length === 0,
    );
    if (!identityMatches) return "ambiguous";
    const expectedIdempotencyKey =
      `submission:${request.clientSubmissionId}:attachment:${request.clientAttachmentId}` +
      `:upload:${request.uploadAttempt}:init`;
    if (
      !evaluateNonSecretWriteReceiptInvariant(input, {
        operationId: "initUpload",
        scope: {
          accountId: input.accountId,
          actorId: input.actorId,
          projectId: resource.projectId,
        },
        requestForDigest: request,
        expectedIdempotencyKey,
        expectedHttpStatus: 201,
        response,
      }) ||
      input.effectFact?.operationId !== "initUpload" ||
      input.effectFact?.accountId !== input.accountId ||
      input.effectFact?.actorId !== input.actorId ||
      input.effectFact?.projectId !== resource.projectId ||
      input.effectFact?.sessionId !== resource.sessionId ||
      input.effectFact?.clientSubmissionId !== resource.clientSubmissionId ||
      input.effectFact?.clientAttachmentId !== resource.clientAttachmentId ||
      input.effectFact?.uploadAttempt !== resource.uploadAttempt ||
      input.effectFact?.version !== 1 ||
      input.effectFact?.uploadSessionCommitted !== true
    ) {
      return "ambiguous";
    }
    if (input.exactReplay) return "unambiguous";
    return (
      resource.version === 1 &&
      serverNow !== undefined &&
      expiresAt !== undefined &&
      expiresAt > serverNow &&
      expiresAt - serverNow <= APP_FIRST_LIMITS.uploadSessionMaxTtlMs
      ? "unambiguous"
      : "ambiguous"
    );
  }

  if (mode === "finalize") {
    const identityMatches = Boolean(
      request &&
      response &&
      input.pathSessionId === resource.sessionId &&
      response.sessionId === resource.sessionId &&
      response.projectId === resource.projectId &&
      request.clientSubmissionId === resource.clientSubmissionId &&
      response.clientSubmissionId === resource.clientSubmissionId &&
      request.clientAttachmentId === resource.clientAttachmentId &&
      response.clientAttachmentId === resource.clientAttachmentId &&
      request.uploadAttempt === resource.uploadAttempt &&
      response.uploadAttempt === resource.uploadAttempt &&
      response.filename === resource.filename &&
      response.mediaType === resource.mediaType &&
      sameNullable(response.captureId, resource.captureId) &&
      request.sha256 === resource.sha256 &&
      response.sha256 === resource.sha256 &&
      request.expectedSize === resource.expectedSize &&
      response.size === resource.expectedSize &&
      response.attachmentId === resource.attachmentId &&
      request.expectedVersion === resource.versionBefore &&
      response.version === request.expectedVersion + 1 &&
      response.bindingStatus === "unbound" &&
      response.readyToBind === (response.scanStatus === "clean") &&
      resource.persistedSha256 === resource.sha256 &&
      resource.persistedSize === resource.expectedSize &&
      resource.durablyReadable === true,
    );
    if (!identityMatches) return "ambiguous";
    const expectedIdempotencyKey =
      `submission:${request.clientSubmissionId}:attachment:${request.clientAttachmentId}` +
      `:upload:${request.uploadAttempt}:finalize`;
    if (
      !evaluateNonSecretWriteReceiptInvariant(input, {
        operationId: "finalizeUpload",
        scope: {
          accountId: input.accountId,
          actorId: input.actorId,
          projectId: resource.projectId,
          sessionId: resource.sessionId,
        },
        requestForDigest: request,
        expectedIdempotencyKey,
        expectedHttpStatus: 200,
        response,
      }) ||
      input.effectFact?.operationId !== "finalizeUpload" ||
      input.effectFact?.accountId !== input.accountId ||
      input.effectFact?.actorId !== input.actorId ||
      input.effectFact?.projectId !== resource.projectId ||
      input.effectFact?.sessionId !== resource.sessionId ||
      input.effectFact?.attachmentId !== resource.attachmentId ||
      input.effectFact?.persistedObjectSha256 !== resource.persistedSha256 ||
      input.effectFact?.persistedObjectSize !== resource.persistedSize ||
      input.effectFact?.uploadSessionFinalized !== true ||
      input.effectFact?.attachmentCreated !== true ||
      input.effectFact?.scanOutboxCommitted !== true
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }

  if (mode === "chunk") {
    const bytes = decodeCanonicalBase64(input.contentBytesBase64);
    const chunkCount = Math.ceil(resource.expectedSize / resource.chunkSize);
    const expectedChunkLength =
      input.pathChunkNumber === chunkCount - 1
        ? resource.expectedSize - resource.chunkSize * (chunkCount - 1)
        : resource.chunkSize;
    const expectedVersion = resource.versionBefore;
    const responseVersion = expectedVersion + 1;
    const chunkEnvelope = canonicalChunkRequestEnvelope(input);
    const expectedIdempotencyKey =
      `submission:${resource.clientSubmissionId}:attachment:${resource.clientAttachmentId}` +
      `:upload:${resource.uploadAttempt}:chunk:${input.pathChunkNumber}`;
    const confirmedBefore = resource.confirmedChunksBefore;
    const confirmedAfter = input.aggregateFact?.confirmedChunks;
    if (
      !bytes ||
      !chunkEnvelope ||
      input.pathSessionId !== resource.sessionId ||
      !Number.isInteger(input.pathChunkNumber) ||
      input.pathChunkNumber < 0 ||
      input.pathChunkNumber >= chunkCount ||
      resource.status !== "open" ||
      input.ifMatch !== `"${expectedVersion}"` ||
      input.contentLength !== bytes.length ||
      input.contentLength !== expectedChunkLength ||
      input.xChunkSha256 !== sha256Hex(bytes) ||
      input.xClientSubmissionId !== resource.clientSubmissionId ||
      input.xClientAttachmentId !== resource.clientAttachmentId ||
      !Array.isArray(confirmedBefore) ||
      confirmedBefore.includes(input.pathChunkNumber) ||
      !isUniqueArray(confirmedBefore) ||
      input.chunkFact?.accountId !== input.accountId ||
      input.chunkFact?.actorId !== input.actorId ||
      input.chunkFact?.projectId !== resource.projectId ||
      input.chunkFact?.sessionId !== resource.sessionId ||
      input.chunkFact?.chunkNumber !== input.pathChunkNumber ||
      input.chunkFact?.contentBytesBase64 !== input.contentBytesBase64 ||
      input.chunkFact?.contentLength !== bytes.length ||
      input.chunkFact?.sha256 !== input.xChunkSha256 ||
      input.chunkFact?.durablyPersisted !== true ||
      input.aggregateFact?.sessionId !== resource.sessionId ||
      input.aggregateFact?.version !== responseVersion ||
      input.aggregateFact?.receivedBytes !== resource.receivedBytesBefore + bytes.length ||
      !isUniqueArray(confirmedAfter) ||
      canonicalString([...confirmedAfter].sort((a, b) => a - b)) !==
        canonicalString([...confirmedBefore, input.pathChunkNumber].sort((a, b) => a - b)) ||
      canonicalString(input.responseHeaders) !==
        canonicalString({ ETag: `"${responseVersion}"`, "X-Upload-Version": responseVersion }) ||
      !evaluateNonSecretWriteReceiptInvariant(input, {
        operationId: "putUploadChunk",
        scope: {
          accountId: input.accountId,
          actorId: input.actorId,
          projectId: resource.projectId,
          sessionId: resource.sessionId,
          chunkNumber: input.pathChunkNumber,
        },
        requestForDigest: chunkEnvelope,
        expectedIdempotencyKey,
        expectedHttpStatus: 204,
        response: null,
        responseHasReplayMarker: false,
      })
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }

  if (mode === "session") {
    if (
      !response ||
      input.pathSessionId !== resource.sessionId ||
      response.sessionId !== resource.sessionId ||
      response.projectId !== resource.projectId ||
      response.clientSubmissionId !== resource.clientSubmissionId ||
      response.clientAttachmentId !== resource.clientAttachmentId ||
      response.uploadAttempt !== resource.uploadAttempt ||
      response.status !== resource.status ||
      response.filename !== resource.filename ||
      response.mediaType !== resource.mediaType ||
      !sameNullable(response.captureId, resource.captureId) ||
      response.expectedSize !== resource.expectedSize ||
      response.chunkSize !== resource.chunkSize ||
      response.sha256 !== resource.sha256 ||
      response.version !== resource.version ||
      response.expiresAt !== resource.expiresAt ||
      !sameNullable(response.attachmentId, resource.attachmentId) ||
      canonicalString([...(response.confirmedChunks ?? [])].sort((a, b) => a - b)) !==
        canonicalString([...(resource.confirmedChunks ?? [])].sort((a, b) => a - b))
    ) {
      return "ambiguous";
    }
    const expectedChunkCount = Math.ceil(response.expectedSize / response.chunkSize);
    const confirmed = response.confirmedChunks;
    if (
      response.expectedChunkCount !== expectedChunkCount ||
      !isUniqueArray(confirmed) ||
      confirmed.some((index) => !Number.isInteger(index) || index < 0 || index >= expectedChunkCount) ||
      response.receivedBytes !== resource.receivedBytes ||
      response.receivedBytes < 0 ||
      response.receivedBytes > response.expectedSize
    ) {
      return "ambiguous";
    }
    const receivedBytesFromConfirmed = confirmed.reduce((sum, chunkNumber) => {
      const isFinal = chunkNumber === expectedChunkCount - 1;
      return (
        sum +
        (isFinal
          ? response.expectedSize - response.chunkSize * (expectedChunkCount - 1)
          : response.chunkSize)
      );
    }, 0);
    if (response.receivedBytes !== receivedBytesFromConfirmed) return "ambiguous";
    const terminal = ["finalized", "rejected"].includes(response.status);
    if (
      terminal !== (response.attachmentId !== null) ||
      (terminal &&
        (response.receivedBytes !== response.expectedSize ||
          canonicalString([...confirmed].sort((a, b) => a - b)) !==
            canonicalString(Array.from({ length: expectedChunkCount }, (_, index) => index))))
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }

  if (mode === "metadata") {
    return response &&
      input.pathAttachmentId === resource.attachmentId &&
      response.attachmentId === resource.attachmentId &&
      response.projectId === resource.projectId &&
      response.clientSubmissionId === resource.clientSubmissionId &&
      response.clientAttachmentId === resource.clientAttachmentId &&
      sameNullable(response.captureId, resource.captureId) &&
      response.filename === resource.filename &&
      response.mediaType === resource.mediaType &&
      response.sha256 === resource.sha256 &&
      response.size === resource.size &&
      response.version === resource.version &&
      response.scanStatus === resource.scanStatus &&
      response.readyToBind === resource.readyToBind &&
      response.bindingStatus === resource.bindingStatus &&
      response.readyToBind === (response.scanStatus === "clean")
      ? "unambiguous"
      : "ambiguous";
  }

  if (mode === "bind") {
    const serverNow = toEpoch(input.serverNow);
    const expiresAt = toEpoch(response?.expiresAt);
    const priorExpiresAt = toEpoch(resource.priorExpiresAt);
    const identityMatches = Boolean(
      request &&
      response &&
      input.pathAttachmentId === resource.attachmentId &&
      response.attachmentId === resource.attachmentId &&
      request.projectId === resource.projectId &&
      response.projectId === resource.projectId &&
      request.clientSubmissionId === resource.clientSubmissionId &&
      response.clientSubmissionId === resource.clientSubmissionId &&
      request.clientAttachmentId === resource.clientAttachmentId &&
      response.clientAttachmentId === resource.clientAttachmentId &&
      request.leaseGeneration === resource.leaseGeneration &&
      response.leaseGeneration === resource.leaseGeneration &&
      request.intent === resource.intent &&
      response.intent === resource.intent &&
      sameNullable(request.targetQaItemId, resource.targetQaItemId) &&
      sameNullable(response.targetQaItemId, resource.targetQaItemId) &&
      response.bindingId === resource.bindingId &&
      response.expiresAt === resource.expiresAt &&
      request.expectedVersion === resource.versionBefore &&
      response.version === request.expectedVersion + 1 &&
      response.status === "reserved" &&
      resource.scanStatus === "clean" &&
      resource.readyToBind === true &&
      resource.durablyReadable === true,
    );
    if (!identityMatches) return "ambiguous";
    const expectedIdempotencyKey =
      `submission:${request.clientSubmissionId}:attachment:${request.clientAttachmentId}` +
      `:bind:${request.leaseGeneration}`;
    if (
      !evaluateNonSecretWriteReceiptInvariant(input, {
        operationId: "bindAttachmentReservation",
        scope: {
          accountId: input.accountId,
          actorId: input.actorId,
          attachmentId: resource.attachmentId,
          projectId: resource.projectId,
        },
        requestForDigest: request,
        expectedIdempotencyKey,
        expectedHttpStatus: 200,
        response,
      }) ||
      input.effectFact?.operationId !== "bindAttachmentReservation" ||
      input.effectFact?.accountId !== input.accountId ||
      input.effectFact?.actorId !== input.actorId ||
      input.effectFact?.projectId !== resource.projectId ||
      input.effectFact?.attachmentId !== resource.attachmentId ||
      input.effectFact?.bindingId !== resource.bindingId ||
      input.effectFact?.leaseGeneration !== resource.leaseGeneration ||
      input.effectFact?.version !== response.version ||
      input.effectFact?.expiresAt !== response.expiresAt ||
      input.effectFact?.reservationCommitted !== true
    ) {
      return "ambiguous";
    }
    if (input.exactReplay) return "unambiguous";
    const isFirstLease =
      request.leaseGeneration === 1 &&
      resource.priorBindingStatus === "unbound" &&
      resource.priorLeaseGeneration === 0 &&
      resource.priorBindingId === null;
    const isExpiredRenewal =
      request.leaseGeneration > 1 &&
      resource.priorBindingStatus === "expired" &&
      request.leaseGeneration === resource.priorLeaseGeneration + 1 &&
      response.bindingId === resource.priorBindingId &&
      priorExpiresAt !== undefined &&
      serverNow !== undefined &&
      serverNow >= priorExpiresAt;
    return (isFirstLease || isExpiredRenewal) &&
      resource.scanStatus === "clean" &&
      resource.readyToBind === true &&
      resource.durablyReadable === true &&
      serverNow !== undefined &&
      expiresAt !== undefined &&
      expiresAt > serverNow &&
      expiresAt - serverNow <= APP_FIRST_LIMITS.bindingLeaseMaxTtlMs
      ? "unambiguous"
      : "ambiguous";
  }
  return "ambiguous";
}

function captureWireShape(capture) {
  const normalized = structuredClone(capture);
  delete normalized.enrichmentStatus;
  if (normalized.poco) delete normalized.poco.status;
  return normalized;
}

function evaluateCaptureReceipt(input) {
  if (input.mode === "create") {
    const request = input.request;
    const response = input.response;
    const capture = response?.captureBundle;
    const captureFact = input.captureFact;
    const buildId = request?.capture?.deviceMetadata?.buildId ?? null;
    const buildReferenceValid =
      buildId === null
        ? input.captureBuildFact == null
        : input.captureBuildFact?.accountId === input.accountId &&
          input.captureBuildFact?.projectId === input.authorizedProjectId &&
          input.captureBuildFact?.buildId === buildId &&
          input.captureBuildFact?.relationValidated === true;
    const expectedDigest = canonicalNonSecretRequestDigest(
      "createCaptureBundle",
      {
        accountId: input.accountId,
        actorId: input.actorId,
        captureId: request?.capture?.captureId,
        projectId: input.authorizedProjectId,
      },
      request,
      input.idempotencyKey,
    );
    return request &&
      capture &&
      typeof input.accountId === "string" &&
      input.accountId.length > 0 &&
      typeof input.actorId === "string" &&
      input.actorId.length > 0 &&
      request.projectId === input.authorizedProjectId &&
      request.projectId === request.capture?.projectId &&
      request.clientSubmissionId === request.capture?.clientSubmissionId &&
      capture.captureId === request.capture.captureId &&
      capture.projectId === input.authorizedProjectId &&
      capture.clientSubmissionId === request.clientSubmissionId &&
      canonicalString(captureWireShape(capture)) === canonicalString(request.capture) &&
      capture.enrichmentStatus === deriveEnrichmentStatus(capture.poco) &&
      capture.poco.status === capture.enrichmentStatus &&
      captureFact?.accountId === input.accountId &&
      captureFact?.actorId === input.actorId &&
      captureFact?.projectId === input.authorizedProjectId &&
      captureFact?.captureId === capture.captureId &&
      captureFact?.clientSubmissionId === request.clientSubmissionId &&
      canonicalString(captureFact?.capture) === canonicalString(capture) &&
      buildReferenceValid &&
      typeof input.idempotencyKey === "string" &&
      input.idempotencyKey.length > 0 &&
      input.idempotencyKey === input.persistedIdempotencyKey &&
      input.canonicalRequestDigest === expectedDigest &&
      input.canonicalRequestDigest === input.persistedRequestDigest &&
      input.idempotencyRecordCommitted === true &&
      input.originalEffectCommitted === true &&
      response.replayed === input.exactReplay &&
      input.mutationCount === (input.exactReplay ? 0 : 1) &&
      (!input.exactReplay || input.replayAuthorized === true) &&
      canonicalString(response) === canonicalString(input.persistedResponse)
      ? "unambiguous"
      : "ambiguous";
  }
  if (input.mode === "get") {
    return input.pathCaptureId === input.resource?.captureId &&
      input.response?.captureId === input.resource?.captureId &&
      input.response?.projectId === input.resource?.projectId &&
      input.response?.clientSubmissionId === input.resource?.clientSubmissionId &&
      canonicalString(input.response) === canonicalString(input.resource?.capture) &&
      resourceScopeMatches(input, input.resource)
      ? "unambiguous"
      : "ambiguous";
  }
  return "ambiguous";
}

function parseSingleByteRange(rangeHeader, size) {
  if (rangeHeader == null) return { kind: "full", start: 0, end: size - 1 };
  if (typeof rangeHeader !== "string" || rangeHeader.length > 200 || rangeHeader.includes(",")) {
    return { kind: "unsatisfiable" };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (match[1] === "" && match[2] === "")) {
    return { kind: "unsatisfiable" };
  }
  const parseBound = (value) => {
    if (value === "") return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const first = parseBound(match[1]);
  const second = parseBound(match[2]);
  if ((match[1] !== "" && first === undefined) || (match[2] !== "" && second === undefined)) {
    return { kind: "unsatisfiable" };
  }
  if (first === undefined) {
    if (second === 0) return { kind: "unsatisfiable" };
    return {
      kind: "range",
      start: Math.max(size - second, 0),
      end: size - 1,
    };
  }
  if (first >= size) return { kind: "unsatisfiable" };
  const end = second === undefined ? size - 1 : Math.min(second, size - 1);
  if (first > end) return { kind: "unsatisfiable" };
  return { kind: "range", start: first, end };
}

function evaluateAttachmentDownloadReceipt(input) {
  const { attachmentFact, authorizationFact, blobFact, response } = input;
  const serverNow = toEpoch(input.serverNow);
  const decidedAt = toEpoch(authorizationFact?.decidedAt);
  const openedAt = toEpoch(blobFact?.openedAt);
  const blobBytes = decodeCanonicalBase64(blobFact?.bytesBase64);
  if (
    typeof input.accountId !== "string" ||
    input.accountId.length === 0 ||
    typeof input.actorId !== "string" ||
    input.actorId.length === 0 ||
    input.request?.delivery !== "proxy" ||
    input.redirectFact != null ||
    typeof input.currentMembershipRevision !== "string" ||
    input.currentMembershipRevision.length === 0 ||
    !Array.isArray(input.authorizedProjectIds) ||
    !isUniqueArray(input.authorizedProjectIds) ||
    !attachmentFact ||
    input.pathAttachmentId !== attachmentFact.attachmentId ||
    attachmentFact.accountId !== input.accountId ||
    !input.authorizedProjectIds.includes(attachmentFact.projectId) ||
    !Number.isInteger(attachmentFact.version) ||
    attachmentFact.version < 1 ||
    typeof attachmentFact.immutableBlobVersion !== "string" ||
    attachmentFact.immutableBlobVersion.length === 0 ||
    !Number.isInteger(attachmentFact.size) ||
    attachmentFact.size < 1 ||
    !/^[0-9a-f]{64}$/.test(attachmentFact.sha256 ?? "") ||
    typeof attachmentFact.mediaType !== "string" ||
    attachmentFact.mediaType.length === 0 ||
    typeof attachmentFact.safeFilename !== "string" ||
    attachmentFact.safeFilename.length < 1 ||
    attachmentFact.safeFilename.length > 200 ||
    [...attachmentFact.safeFilename].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        character === "\\" ||
        character === "/" ||
        character === '"'
      );
    }) ||
    [".", ".."].includes(attachmentFact.safeFilename) ||
    attachmentFact.scanStatus !== "clean" ||
    attachmentFact.readyToBind !== true ||
    attachmentFact.durablyReadable !== true ||
    !authorizationFact ||
    typeof authorizationFact.decisionId !== "string" ||
    authorizationFact.decisionId.length === 0 ||
    authorizationFact.accountId !== input.accountId ||
    authorizationFact.actorId !== input.actorId ||
    authorizationFact.projectId !== attachmentFact.projectId ||
    authorizationFact.attachmentId !== attachmentFact.attachmentId ||
    authorizationFact.attachmentVersion !== attachmentFact.version ||
    authorizationFact.currentReadMembershipActive !== true ||
    authorizationFact.membershipRevision !== input.currentMembershipRevision ||
    typeof authorizationFact.readSnapshotId !== "string" ||
    authorizationFact.readSnapshotId.length === 0 ||
    serverNow === undefined ||
    decidedAt === undefined ||
    decidedAt > serverNow ||
    serverNow - decidedAt > APP_FIRST_LIMITS.maxAttachmentAuthorizationSkewMs ||
    !blobFact ||
    blobFact.decisionId !== authorizationFact.decisionId ||
    blobFact.accountId !== input.accountId ||
    blobFact.projectId !== attachmentFact.projectId ||
    blobFact.attachmentId !== attachmentFact.attachmentId ||
    blobFact.attachmentVersion !== attachmentFact.version ||
    blobFact.immutableBlobVersion !== attachmentFact.immutableBlobVersion ||
    blobFact.readSnapshotId !== authorizationFact.readSnapshotId ||
    blobFact.authorizationBeforeBlobOpen !== true ||
    openedAt === undefined ||
    openedAt < decidedAt ||
    openedAt > serverNow ||
    blobFact.size !== attachmentFact.size ||
    blobFact.sha256 !== attachmentFact.sha256 ||
    blobFact.validatedMediaType !== attachmentFact.mediaType ||
    blobFact.magicValidated !== true ||
    blobFact.scanStatus !== "clean" ||
    blobFact.durablyReadable !== true ||
    !blobBytes ||
    blobBytes.length !== attachmentFact.size ||
    sha256Hex(blobBytes) !== attachmentFact.sha256
  ) {
    return "ambiguous";
  }

  const claimed = attachmentFact.bindingStatus === "claimed";
  const reserved = attachmentFact.bindingStatus === "reserved";
  if (claimed === reserved) return "ambiguous";
  if (claimed) {
    if (
      input.reservationFact != null ||
      input.claimFact?.accountId !== input.accountId ||
      input.claimFact?.projectId !== attachmentFact.projectId ||
      input.claimFact?.attachmentId !== attachmentFact.attachmentId ||
      input.claimFact?.attachmentVersion !== attachmentFact.version ||
      typeof input.claimFact?.owningBugId !== "string" ||
      input.claimFact.owningBugId.length === 0 ||
      input.claimFact?.bugVisibleToActor !== true ||
      input.claimFact?.currentClaim !== true ||
      input.claimFact?.relationValidated !== true
    ) {
      return "ambiguous";
    }
  } else {
    const reservedAt = toEpoch(input.reservationFact?.reservedAt);
    const expiresAt = toEpoch(input.reservationFact?.expiresAt);
    if (
      input.claimFact != null ||
      typeof attachmentFact.bindingId !== "string" ||
      !uuidPattern.test(attachmentFact.bindingId) ||
      typeof attachmentFact.clientSubmissionId !== "string" ||
      !uuidPattern.test(attachmentFact.clientSubmissionId) ||
      typeof attachmentFact.clientAttachmentId !== "string" ||
      !uuidPattern.test(attachmentFact.clientAttachmentId) ||
      !["bug_create", "occurrence_append", "comment_append", "verification_result"].includes(
        attachmentFact.claimIntent,
      ) ||
      (attachmentFact.claimIntent === "bug_create" &&
        attachmentFact.reservationTargetQaItemId != null) ||
      (attachmentFact.claimIntent !== "bug_create" &&
        (typeof attachmentFact.reservationTargetQaItemId !== "string" ||
          !uuidPattern.test(attachmentFact.reservationTargetQaItemId))) ||
      !Number.isInteger(attachmentFact.leaseGeneration) ||
      attachmentFact.leaseGeneration < 1 ||
      input.reservationFact?.accountId !== input.accountId ||
      input.reservationFact?.projectId !== attachmentFact.projectId ||
      input.reservationFact?.attachmentId !== attachmentFact.attachmentId ||
      input.reservationFact?.attachmentVersion !== attachmentFact.version ||
      input.reservationFact?.ownerActorId !== input.actorId ||
      input.reservationFact?.status !== "reserved" ||
      input.reservationFact?.bindingId !== attachmentFact.bindingId ||
      input.reservationFact?.leaseGeneration !== attachmentFact.leaseGeneration ||
      input.reservationFact?.clientSubmissionId !== attachmentFact.clientSubmissionId ||
      input.reservationFact?.clientAttachmentId !== attachmentFact.clientAttachmentId ||
      input.reservationFact?.claimIntent !== attachmentFact.claimIntent ||
      !sameNullable(
        input.reservationFact?.reservationTargetQaItemId,
        attachmentFact.reservationTargetQaItemId,
      ) ||
      input.reservationFact?.currentReservation !== true ||
      input.reservationFact?.relationValidated !== true ||
      !Number.isInteger(input.reservationFact?.leaseGeneration) ||
      input.reservationFact.leaseGeneration < 1 ||
      reservedAt === undefined ||
      expiresAt === undefined ||
      expiresAt - reservedAt > APP_FIRST_LIMITS.bindingLeaseMaxTtlMs ||
      reservedAt > serverNow ||
      serverNow >= expiresAt
    ) {
      return "ambiguous";
    }
  }

  const range = parseSingleByteRange(input.request?.range ?? null, attachmentFact.size);
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${attachmentFact.safeFilename}"`,
    "Content-Type": "application/octet-stream",
    ETag: `"sha256-${attachmentFact.sha256}"`,
    "X-Content-Type-Options": "nosniff",
  };
  if (range.kind === "unsatisfiable") {
    return response?.statusCode === 416 &&
      response.bodyBytesBase64 == null &&
      canonicalString(response.headers) ===
        canonicalString({
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Content-Range": `bytes */${attachmentFact.size}`,
          "X-Content-Type-Options": "nosniff",
        })
      ? "unambiguous"
      : "ambiguous";
  }
  const expectedBytes = blobBytes.subarray(range.start, range.end + 1);
  const expectedHeaders = {
    ...commonHeaders,
    "Content-Length": expectedBytes.length,
    ...(range.kind === "range"
      ? { "Content-Range": `bytes ${range.start}-${range.end}/${attachmentFact.size}` }
      : {}),
  };
  const responseBytes = decodeCanonicalBase64(response?.bodyBytesBase64);
  return response?.statusCode === (range.kind === "range" ? 206 : 200) &&
    canonicalString(response.headers) === canonicalString(expectedHeaders) &&
    responseBytes &&
    responseBytes.equals(expectedBytes)
    ? "unambiguous"
    : "ambiguous";
}

function evaluateNotificationRegistrationReceipt(input) {
  const outcome = evaluateNotificationRegistration(input);
  const { request, response, session, existing } = input;
  const serverReceivedAt = toEpoch(response?.serverReceivedAt);
  const createdAt = toEpoch(response?.createdAt);
  const tokenIssuedAt = toEpoch(request?.tokenIssuedAt);
  const serverNow = toEpoch(input.now);
  const outcomeMatch = /^(created|rotated|replay):([1-9][0-9]*)$/.exec(outcome);
  const expectedRequestDigest = canonicalReplayDigest(
    "registerAndroidNotificationDevice",
    {
      accountId: session?.accountId,
      actorId: session?.user?.id,
      installationId: session?.installationId,
    },
    request,
    input.idempotencyKey,
    input.serverPepper,
  );
  if (
    !response ||
    !outcomeMatch ||
    typeof input.requestTokenHmac !== "string" ||
    input.requestTokenHmac.length < 16 ||
    input.persistedEncryptedTokenHmac !== input.requestTokenHmac ||
    input.encryptedTokenPersisted !== true ||
    !Number.isInteger(input.encryptionKeyVersion) ||
    input.encryptionKeyVersion < 1 ||
    input.rawTokenAbsent !== true ||
    input.tokenUniqueLookupPerformed !== true ||
    input.requestDigestAlgorithm !== "HMAC-SHA-256" ||
    input.serverPepperProtected !== true ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey !== input.persistedIdempotencyKey ||
    input.canonicalRequestDigest !== expectedRequestDigest ||
    input.canonicalRequestDigest !== input.persistedRequestDigest ||
    input.idempotencyRecordCommitted !== true ||
    input.encryptedReceiptSnapshotPersisted !== true ||
    !Number.isInteger(input.receiptEncryptionKeyVersion) ||
    input.receiptEncryptionKeyVersion < 1 ||
    input.rawReceiptSecretsAbsent !== true ||
    input.originalEffectCommitted !== true ||
    input.mutationCount !== (input.exactReplay ? 0 : 1) ||
    canonicalString(response) !== canonicalString(input.persistedResponse) ||
    (input.tokenOwnerFact &&
      (input.tokenOwnerFact.accountId !== session.accountId ||
        input.tokenOwnerFact.userId !== session.user?.id ||
        input.tokenOwnerFact.installationId !== session.installationId)) ||
    hasOwn(response, "token") ||
    response.accountId !== session.accountId ||
    response.userId !== session.user?.id ||
    response.installationId !== session.installationId ||
    response.installationId !== request.installationId ||
    response.provider !== request.provider ||
    response.platform !== request.platform ||
    response.sharedDevice !== false ||
    response.tokenIssuedAt !== request.tokenIssuedAt ||
    serverReceivedAt === undefined ||
    createdAt === undefined ||
    tokenIssuedAt === undefined ||
    serverNow === undefined ||
    (input.exactReplay ? serverReceivedAt > serverNow : serverReceivedAt !== serverNow) ||
    createdAt > serverReceivedAt
  ) {
    return "ambiguous";
  }
  const outcomeVersion = Number(outcomeMatch[2]);
  if (outcomeMatch[1] === "created") {
    return input.existingTokenHmac === null &&
      response.version === 1 &&
      response.replayed === false &&
      createdAt === serverReceivedAt
      ? "unambiguous"
      : "ambiguous";
  }
  if (!existing || response.id !== existing.id || createdAt !== toEpoch(existing.createdAt)) {
    return "ambiguous";
  }
  if (outcomeMatch[1] === "replay") {
    return response.version === existing.version &&
      outcomeVersion === existing.version &&
      response.replayed === true &&
      input.replayAuthorized === true &&
      input.requestTokenHmac === input.existingTokenHmac &&
      input.replayAuthorized === true
      ? "unambiguous"
      : "ambiguous";
  }
  return outcomeVersion === existing.version + 1 &&
    response.version === existing.version + 1 &&
    response.replayed === false &&
    typeof input.existingTokenHmac === "string" &&
    input.existingTokenHmac.length >= 16 &&
    input.existingTokenHmac !== input.persistedEncryptedTokenHmac &&
    input.oldTokenReplaced === true &&
    input.tokenOwnerFact?.deviceId === existing.id
    ? "unambiguous"
    : "ambiguous";
}

function evaluateNotificationInbox(input) {
  const { session, response } = input;
  if (!session || !response) return "ambiguous";
  const activeSessionProjects = (session.projects ?? []).filter(
    (project) => project?.active === true,
  );
  const authorizedProjects = new Set(activeSessionProjects.map((project) => project.id));
  if (input.mode === "list") {
    const query = {
      cursor: input.queryCursor ?? null,
      limit: input.queryLimit ?? 50,
      projectId: input.queryProjectId ?? null,
      unreadOnly: input.queryUnreadOnly === true,
    };
    const facts = input.notificationFacts;
    const pageFact = input.pageFact;
    const expectedAuthorizedProjectIds = [...authorizedProjects].sort();
    const orderedItemIds = response.items.map((item) => item.id);
    const orderedSortKeys = response.items.map((item) => {
      const createdAt = descendingDateSortKey(item.createdAt);
      return createdAt == null ? null : `${createdAt}:${item.id}`;
    });
    if (
      input.accountId !== session.accountId ||
      input.actorId !== session.user?.id ||
      canonicalString([...(input.authorizedProjectIds ?? [])].sort()) !==
        canonicalString(expectedAuthorizedProjectIds) ||
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      response.items.length > query.limit ||
      (query.unreadOnly && response.items.some((item) => item.readAt !== null)) ||
      input.queryProjectId &&
      (!authorizedProjects.has(input.queryProjectId) ||
        response.items.some((item) => item.projectId !== input.queryProjectId))
    ) {
      return "ambiguous";
    }
    if (
      !Array.isArray(facts) ||
      facts.length !== response.items.length ||
      new Set(response.items.map((item) => item.id)).size !== response.items.length ||
      response.items.some(
        (item) =>
          item.accountId !== session.accountId ||
          item.userId !== session.user?.id ||
          !authorizedProjects.has(item.projectId) ||
          canonicalString(item) !==
            canonicalString(facts.find((fact) => fact.id === item.id)),
      ) ||
      response.unreadCount !== input.authorizedUnreadCount ||
      response.items.filter((item) => item.readAt === null).length > response.unreadCount ||
      pageFact?.authorizedUnreadCount !== response.unreadCount ||
      !signedPageReceiptMatches(input, {
        operationId: "listNotifications",
        query,
        response,
        normalizedFilters: {
          projectId: query.projectId,
          unreadOnly: query.unreadOnly,
        },
        orderedItemIds,
        orderedSortKeys,
        scope: { userId: session.user?.id },
        limit: query.limit,
      })
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }
  if (input.mode === "read") {
    const resource = input.resource;
    const readAt = toEpoch(response.readAt);
    const createdAt = toEpoch(resource?.createdAt);
    const serverNow = toEpoch(input.serverNow);
    if (
      !resource ||
      input.pathNotificationId !== resource.id ||
      response.id !== resource.id ||
      resource.accountId !== session.accountId ||
      resource.userId !== session.user?.id ||
      !authorizedProjects.has(resource.projectId) ||
      typeof input.membershipRevision !== "string" ||
      input.membershipRevision.length === 0 ||
      input.membershipFact?.accountId !== session.accountId ||
      input.membershipFact?.actorId !== session.user?.id ||
      input.membershipFact?.projectId !== resource.projectId ||
      input.membershipFact?.membershipRevision !== input.membershipRevision ||
      input.membershipFact?.currentActive !== true ||
      response.accountId !== resource.accountId ||
      response.userId !== resource.userId ||
      response.projectId !== resource.projectId ||
      response.type !== resource.type ||
      response.title !== resource.title ||
      !sameNullable(response.bugId, resource.bugId) ||
      response.createdAt !== resource.createdAt
    ) {
      return "ambiguous";
    }
    if (input.exactReplay) {
      const expectedDigest = canonicalReplayDigest(
        "markNotificationRead",
        {
          accountId: session.accountId,
          actorId: session.user?.id,
          notificationId: resource.id,
          projectId: resource.projectId,
        },
        input.request,
        input.idempotencyKey,
        input.serverPepper,
      );
      return input.replayAuthorized === true &&
        input.requestDigestAlgorithm === "HMAC-SHA-256" &&
        input.serverPepperProtected === true &&
        input.idempotencyKey === input.persistedIdempotencyKey &&
        input.canonicalRequestDigest === expectedDigest &&
        input.canonicalRequestDigest === input.persistedRequestDigest &&
        input.originalEffectCommitted === true &&
        input.mutationCount === 0 &&
        canonicalString(response) === canonicalString(input.persistedResponse)
        ? "unambiguous"
        : "ambiguous";
    }
    if (
      input.request?.expectedVersion !== resource.version ||
      response.version !== resource.version + 1 ||
      readAt === undefined ||
      createdAt === undefined ||
      serverNow === undefined ||
      readAt < createdAt ||
      readAt > serverNow
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }
  return "ambiguous";
}

function evaluateRelayReceiptIdentity(input) {
  const { response, resource } = input;
  if (
    !response ||
    !resource ||
    !resourceScopeMatches(input, resource) ||
    input.pathAttemptId !== resource.attemptId ||
    response.repairAttemptId !== resource.attemptId ||
    response.handoffId !== resource.handoffId ||
    response.relayInstanceId !== resource.relayInstanceId ||
    response.qaItem?.type !== "bug" ||
    response.qaItem.id !== resource.bugId ||
    response.qaItem.key !== resource.bugKey ||
    canonicalString(response) !== canonicalString(input.receiptFact)
  ) {
    return "ambiguous";
  }
  if (input.mode === "dispatch") {
    const expectedDigest = canonicalNonSecretRequestDigest(
      "dispatchRepairAttemptToRelay",
      {
        accountId: resource.accountId,
        actorId: resource.actorId,
        attemptId: resource.attemptId,
        projectId: resource.projectId,
      },
      input.request,
      input.idempotencyKey,
    );
    if (
      input.request?.handoffId !== resource.handoffId ||
      input.request?.expectedVersion !== resource.attemptVersion ||
      response.status !== "queued" ||
      response.replayed !== input.exactReplay ||
      typeof response.outboxMessageId !== "string" ||
      response.outboxMessageId.length === 0 ||
      response.outboxMessageId !== resource.outboxMessageId ||
      typeof response.requestId !== "string" ||
      response.requestId.length === 0 ||
      response.requestId !== resource.requestId ||
      input.outboxCommitted !== true ||
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey !== input.persistedIdempotencyKey ||
      input.canonicalRequestDigest !== expectedDigest ||
      input.canonicalRequestDigest !== input.persistedRequestDigest ||
      input.idempotencyRecordCommitted !== true ||
      (input.exactReplay &&
        (input.originalEffectCommitted !== true ||
          canonicalString(response) !== canonicalString(input.persistedResponse))) ||
      input.mutationCount !== (input.exactReplay ? 0 : 1) ||
      !sameExactStringSet(
        input.request?.selectedAttachmentIds ?? [],
        resource.selectedAttachmentIds ?? [],
      ) ||
      !Array.isArray(resource.selectedAttachmentFacts) ||
      !sameExactStringSet(
        resource.selectedAttachmentFacts.map((fact) => fact.attachmentId),
        resource.selectedAttachmentIds ?? [],
      ) ||
      resource.selectedAttachmentFacts.some(
        (fact) =>
          fact.accountId !== resource.accountId ||
          fact.projectId !== resource.projectId ||
          fact.bugId !== resource.bugId ||
          fact.scanStatus !== "clean" ||
          fact.bindingStatus !== "claimed" ||
          fact.durablyReadable !== true,
      )
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }
  if (input.mode !== "receipt") return "ambiguous";
  const buildRequiresIdentity = response.buildEvidenceStatus === "exact_commit_eligible";
  if (
    response.requiresHumanVerification !== true ||
    response.automationAuthority !== "delivery_build_projection_only" ||
    !relayProjectionStates.has(response.handoffStatus) ||
    !["required", "not_required"].includes(response.buildRequirement) ||
    !["pending", "exact_commit_eligible", "not_required"].includes(
      response.buildEvidenceStatus,
    ) ||
    !Number.isInteger(response.externalRevision) ||
    response.externalRevision < 0 ||
    !Number.isInteger(response.version) ||
    response.version < 1 ||
    response.handoffStatus !== resource.handoffStatus ||
    response.buildRequirement !== resource.buildRequirement ||
    response.buildEvidenceStatus !== resource.buildEvidenceStatus ||
    response.externalRevision !== resource.externalRevision ||
    response.version !== resource.receiptVersion ||
    !sameNullable(response.deliveredCommitSha, resource.deliveredCommitSha) ||
    !sameNullable(response.buildId, resource.buildId) ||
    !sameNullable(response.relayTaskId, resource.relayTaskId) ||
    response.lastEventAt !== resource.lastEventAt ||
    !sameNullable(response.failureSummary, resource.failureSummary) ||
    (response.buildRequirement === "not_required" &&
      (response.buildEvidenceStatus !== "not_required" || response.buildId !== null)) ||
    (response.buildRequirement === "required" &&
      !["pending", "exact_commit_eligible"].includes(response.buildEvidenceStatus)) ||
    (buildRequiresIdentity &&
      (typeof response.buildId !== "string" ||
        response.buildId.length === 0 ||
        input.buildFact?.buildId !== response.buildId ||
        input.buildFact?.attemptId !== resource.attemptId ||
        input.buildFact?.bugId !== resource.bugId ||
        input.buildFact?.projectId !== resource.projectId ||
        input.buildFact?.status !== "ready" ||
        input.buildFact?.sourceCommitSha !== response.deliveredCommitSha ||
        !Array.isArray(input.buildFact?.manifestCommitShas) ||
        !input.buildFact.manifestCommitShas.includes(response.deliveredCommitSha)))
  ) {
    return "ambiguous";
  }
  return "unambiguous";
}

const bugTransitionSpecs = Object.freeze([
  { id: "bug.triage.ready", from: ["reported", "needs_info"], to: "ready" },
  { id: "bug.triage.needs_info", from: ["reported", "ready"], to: "needs_info" },
  { id: "bug.mark_duplicate", from: ["reported", "ready"], to: "duplicate" },
  { id: "bug.start_repair", from: ["ready"], to: "in_progress" },
  { id: "bug.repair_delivered.awaiting_build", from: ["in_progress"], to: "awaiting_build" },
  {
    id: "bug.repair_delivered.ready_for_verification",
    from: ["in_progress"],
    to: "ready_for_verification",
  },
  { id: "bug.build_ready", from: ["awaiting_build"], to: "ready_for_verification" },
  { id: "bug.verification.passed", from: ["ready_for_verification"], to: "closed" },
  { id: "bug.verification.failed", from: ["ready_for_verification"], to: "ready" },
  { id: "bug.defer", from: ["reported", "needs_info", "ready"], to: "deferred" },
  { id: "bug.reject", from: ["reported", "needs_info", "ready"], to: "rejected" },
  { id: "bug.reopen.newer_occurrence", from: ["closed"], to: "ready" },
]);

function evaluateBugOperationReceipt(input) {
  const { mode, query = {}, request, response, resource } = input;
  if (!response) return "ambiguous";
  if (mode === "list") {
    const limit = query.limit ?? 50;
    const facts = input.itemFacts;
    const pageFact = input.pageFact;
    const normalizedFilters = {
      projectId: query.projectId ?? null,
      state: Array.isArray(query.state) ? [...query.state].sort() : [],
      ownerId: query.ownerId ?? null,
      verificationOwnerId: query.verificationOwnerId ?? null,
      reporterId: query.reporterId ?? null,
      moduleId: query.moduleId ?? null,
      severity: query.severity ?? null,
      priority: query.priority ?? null,
      q: query.q ?? null,
      updatedAfter: query.updatedAfter ?? null,
      sort: query.sort ?? "updated_desc",
    };
    const orderedSortKeys = response.items.map((bug) =>
      nativeBugSortKey(bug, normalizedFilters.sort),
    );
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Array.isArray(facts) ||
      response.items.length > limit ||
      facts.length !== response.items.length ||
      new Set(response.items.map((bug) => bug.id)).size !== response.items.length ||
      response.items.some((bug) => {
        const fact = facts.find((candidate) => candidate.bug?.id === bug.id);
        return (
          !fact ||
          fact.accountId !== input.accountId ||
          fact.actorId !== input.actorId ||
          !input.authorizedProjectIds?.includes(bug.projectId) ||
          fact.projectId !== bug.projectId ||
          canonicalString(fact.bug) !== canonicalString(bug) ||
          (query.projectId && bug.projectId !== query.projectId) ||
          (query.state && !query.state.includes(bug.state)) ||
          (query.ownerId && bug.ownerId !== query.ownerId) ||
          (query.verificationOwnerId && bug.verificationOwnerId !== query.verificationOwnerId) ||
          (query.reporterId && bug.reporterId !== query.reporterId) ||
          (query.moduleId && bug.moduleId !== query.moduleId) ||
          (query.severity && bug.severity !== query.severity) ||
          (query.priority && bug.priority !== query.priority) ||
          (query.updatedAfter && toEpoch(bug.updatedAt) <= toEpoch(query.updatedAfter))
        );
      }) ||
      pageFact?.filtersApplied !== true ||
      pageFact?.sortApplied !== true ||
      (normalizedFilters.q != null && pageFact?.fullTextSearchApplied !== true) ||
      !signedPageReceiptMatches(input, {
        operationId: "listBugs",
        query: { ...query, limit },
        response,
        normalizedFilters,
        orderedItemIds: response.items.map((bug) => bug.id),
        orderedSortKeys,
        scope: {},
        limit,
      })
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }

  if (
    !resourceScopeMatches(input, resource) ||
    input.pathBugId !== resource.bugId ||
    response.id !== resource.bugId ||
    response.projectId !== resource.projectId ||
    canonicalString(response) !== canonicalString(input.committedBugFact?.bug)
  ) {
    return "ambiguous";
  }
  if (mode === "get") {
    return canonicalString(response) === canonicalString(resource.bug)
      ? "unambiguous"
      : "ambiguous";
  }
  if (!request || request.expectedVersion !== resource.bug?.version) return "ambiguous";
  const operationId =
    mode === "update"
      ? "updateBug"
      : mode === "transition"
        ? "transitionBug"
        : mode === "duplicate"
          ? "markBugDuplicate"
          : undefined;
  const expectedDigest = canonicalNonSecretRequestDigest(
    operationId,
    {
      accountId: input.accountId,
      actorId: input.actorId,
      bugId: resource.bugId,
      projectId: resource.projectId,
    },
    request,
    input.idempotencyKey,
  );
  if (
    !operationId ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey !== input.persistedIdempotencyKey ||
    input.canonicalRequestDigest !== expectedDigest ||
    input.canonicalRequestDigest !== input.persistedRequestDigest ||
    input.idempotencyRecordCommitted !== true ||
    (input.exactReplay
      ? input.replayAuthorized !== true ||
        input.originalEffectCommitted !== true ||
        input.mutationCount !== 0 ||
        canonicalString(response) !== canonicalString(input.persistedResponse)
      : input.mutationCount !== 1)
  ) {
    return "ambiguous";
  }
  if (
    input.committedBugFact?.accountId !== input.accountId ||
    input.committedBugFact?.projectId !== resource.projectId ||
    response.version !== resource.bug.version + 1 ||
    toEpoch(response.updatedAt) === undefined ||
    toEpoch(response.updatedAt) < toEpoch(resource.bug.updatedAt)
  ) {
    return "ambiguous";
  }

  if (mode === "update") {
    const mutableFields = [
      "title",
      "description",
      "expectedBehavior",
      "moduleId",
      "severity",
      "priority",
      "ownerId",
      "verificationOwnerId",
    ];
    if (
      mutableFields.some((field) =>
        hasOwn(request, field)
          ? !sameNullable(response[field], request[field])
          : !sameNullable(response[field], resource.bug[field]),
      ) ||
      [
        "id",
        "projectId",
        "number",
        "key",
        "state",
        "reporterId",
        "duplicateOfBugId",
        "occurrenceCount",
        "reopenCount",
        "createdAt",
        "closedAt",
      ].some((field) => !sameNullable(response[field], resource.bug[field])) ||
      (hasOwn(request, "moduleId") &&
        request.moduleId !== null &&
        (input.moduleFact?.id !== request.moduleId ||
          input.moduleFact?.projectId !== resource.projectId ||
          input.moduleFact?.active !== true)) ||
      (hasOwn(request, "ownerId") &&
        request.ownerId !== null &&
        (input.ownerMemberFact?.userId !== request.ownerId ||
          input.ownerMemberFact?.projectId !== resource.projectId ||
          input.ownerMemberFact?.assignable !== true)) ||
      (hasOwn(request, "verificationOwnerId") &&
        request.verificationOwnerId !== null &&
        (input.verificationOwnerMemberFact?.userId !== request.verificationOwnerId ||
          input.verificationOwnerMemberFact?.projectId !== resource.projectId ||
          input.verificationOwnerMemberFact?.assignable !== true)) ||
      input.auditCommitted !== true
    ) {
      return "ambiguous";
    }
    return "unambiguous";
  }

  if (!["transition", "duplicate"].includes(mode)) return "ambiguous";
  const transition = input.transitionFact;
  const spec = bugTransitionSpecs.find(
    (candidate) =>
      candidate.id === transition?.transitionId &&
      candidate.to === request.toState &&
      candidate.from.includes(resource.bug.state),
  );
  if (
    !spec ||
    response.state !== request.toState ||
    transition.accountId !== input.accountId ||
    transition.projectId !== resource.projectId ||
    transition.bugId !== resource.bugId ||
    transition.actorId !== input.actorId ||
    transition.actorType !== "user" ||
    transition.fromState !== resource.bug.state ||
    transition.toState !== request.toState ||
    transition.versionBefore !== resource.bug.version ||
    transition.versionAfter !== response.version ||
    transition.allGuardsPassed !== true ||
    transition.eventCommitted !== true
  ) {
    return "ambiguous";
  }
  if (
    [
      "id",
      "projectId",
      "number",
      "key",
      "title",
      "description",
      "expectedBehavior",
      "moduleId",
      "severity",
      "priority",
      "reporterId",
      "ownerId",
      "verificationOwnerId",
      "occurrenceCount",
      "createdAt",
    ].some((field) => !sameNullable(response[field], resource.bug[field])) ||
    (spec.id === "bug.reopen.newer_occurrence"
      ? response.reopenCount !== resource.bug.reopenCount + 1
      : response.reopenCount !== resource.bug.reopenCount) ||
    (request.toState === "closed" && toEpoch(response.closedAt) === undefined)
  ) {
    return "ambiguous";
  }
  if (
    (mode === "transition" &&
      !sameNullable(response.duplicateOfBugId, resource.bug.duplicateOfBugId)) ||
    (mode === "duplicate" && response.duplicateOfBugId !== request.canonicalBugId)
  ) {
    return "ambiguous";
  }
  if (request.toState === "closed") {
    const verification = input.verificationFact;
    if (
      verification?.accountId !== input.accountId ||
      verification?.projectId !== resource.projectId ||
      verification?.bugId !== resource.bugId ||
      verification?.id !== request.verificationId ||
      verification?.status !== "passed" ||
      verification?.verifierId !== input.actorId ||
      verification?.humanVerified !== true ||
      verification?.latestNonSupersededAttempt !== true ||
      verification?.eligibleBuildEvidence !== true ||
      verification?.separationOfDutiesPassed !== true
    ) {
      return "ambiguous";
    }
  }
  if (
    request.toState === "needs_info" &&
    (input.responsibleMemberFact?.projectId !== resource.projectId ||
      input.responsibleMemberFact?.userId !== request.responsibleUserId ||
      input.responsibleMemberFact?.active !== true)
  ) {
    return "ambiguous";
  }
  if (spec.id === "bug.build_ready") {
    const attempt = input.repairAttemptFact?.attempt;
    const build = input.buildFact?.build;
    const requirement = input.buildRequirementFact?.buildRequirement;
    const relationValid = buildRepairRelationMatches(input.linkRelationFact, {
      accountId: input.accountId,
      projectId: resource.projectId,
      bugId: resource.bugId,
      attemptId: attempt?.id,
      buildId: build?.id,
      commitSha: attempt?.commitSha,
      requirementId: requirement?.id,
      requirementVersion: requirement?.version,
    });
    if (
      input.repairAttemptFact?.accountId !== input.accountId ||
      input.repairAttemptFact?.projectId !== resource.projectId ||
      input.repairAttemptFact?.bugId !== resource.bugId ||
      input.repairAttemptFact?.latestNonSuperseded !== true ||
      input.repairAttemptFact?.activeForBug !== true ||
      attempt?.status !== "delivered" ||
      !buildRequirementFactMatches(input.buildRequirementFact, {
        accountId: input.accountId,
        projectId: resource.projectId,
        bugId: resource.bugId,
        repairAttemptId: attempt?.id,
        sourceDeliveryVersion: attempt?.version,
        deliveredCommitSha: attempt?.commitSha,
        requirement: "required",
        linkedBuildId: build?.id,
        linkId: input.linkRelationFact?.link?.id,
        bugVersionAtDelivery: resource.bug.version,
        version: 2,
      }) ||
      input.buildRequirementFact?.current !== true ||
      input.buildFact?.accountId !== input.accountId ||
      input.buildFact?.projectId !== resource.projectId ||
      build?.projectId !== resource.projectId ||
      build?.status !== "ready" ||
      !linkedBuildEvidenceEligible({
        link: input.linkRelationFact?.link,
        build,
        deliveredCommitSha: attempt?.commitSha,
        exactManifestEligible: input.buildFact?.exactDeliveredCommitEligible,
      }) ||
      !relationValid ||
      input.linkRelationFact?.atomicWithBuildRequirement !== true ||
      input.linkRelationFact?.atomicWithBugTransition !== true ||
      transition.sourceOperationId !== "linkBuildRepair" ||
      transition.buildLinkEffectCommittedAtomically !== true
    ) {
      return "ambiguous";
    }
  }
  if (mode === "transition") {
    return request.toState !== "duplicate" ? "unambiguous" : "ambiguous";
  }
  const canonical = input.canonicalBugFact;
  return request.toState === "duplicate" &&
    request.canonicalBugId === canonical?.bugId &&
    typeof request.reason === "string" &&
    request.reason.length > 0 &&
    spec.id === "bug.mark_duplicate" &&
    canonical.accountId === input.accountId &&
    canonical.projectId === resource.projectId &&
    canonical.bugId !== resource.bugId &&
    response.duplicateOfBugId === canonical.bugId &&
    canonical.exists === true &&
    input.duplicateCycleCheckPassed === true
    ? "unambiguous"
    : "ambiguous";
}

function evaluateDuplicateCandidatesReceipt(input) {
  const { response, sourceBug, corpusFact } = input;
  const candidates = response?.candidates;
  if (
    !resourceScopeMatches(input, sourceBug) ||
    input.pathBugId !== sourceBug?.bugId ||
    !Array.isArray(candidates) ||
    candidates.length > 5 ||
    new Set(candidates.map((candidate) => candidate.bugId)).size !== candidates.length ||
    candidates.some((candidate) => candidate.bugId === sourceBug.bugId) ||
    candidates.some((candidate, index) => index > 0 && candidate.score > candidates[index - 1].score) ||
    !Array.isArray(input.candidateFacts) ||
    input.candidateFacts.length !== candidates.length ||
    candidates.some((candidate) => {
      const fact = input.candidateFacts.find((entry) => entry.bugId === candidate.bugId);
      return (
        !fact ||
        fact.accountId !== input.accountId ||
        fact.projectId !== sourceBug.projectId ||
        fact.visibleToActor !== true ||
        fact.eligible !== true ||
        fact.bugKey !== candidate.bugKey ||
        fact.score !== candidate.score ||
        canonicalString(fact.reasons) !== canonicalString(candidate.reasons) ||
        !isUniqueArray(candidate.reasons)
      );
    }) ||
    corpusFact?.accountId !== input.accountId ||
    corpusFact?.actorId !== input.actorId ||
    corpusFact?.projectId !== sourceBug.projectId ||
    corpusFact?.sourceBugId !== sourceBug.bugId ||
    typeof corpusFact?.corpusVersion !== "string" ||
    corpusFact.corpusVersion.length === 0 ||
    !Number.isInteger(corpusFact?.snapshotSequence) ||
    corpusFact.snapshotSequence < 0 ||
    corpusFact.scoringCompleted !== true ||
    canonicalString(corpusFact.orderedCandidateIds) !==
      canonicalString(candidates.map((candidate) => candidate.bugId))
  ) {
    return "ambiguous";
  }
  return "unambiguous";
}

function evaluateReadModelReceipt(input) {
  const { operation, response } = input;
  if (!response) return "ambiguous";
  if (operation === "projects") {
    const { query, session } = input;
    if (
      !query ||
      input.accountId !== session?.accountId ||
      input.actorId !== session?.user?.id ||
      !Array.isArray(session?.projects) ||
      !Array.isArray(response.items) ||
      !Number.isInteger(response.snapshotSequence) ||
      response.snapshotSequence < 0 ||
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      response.items.length > query.limit ||
      new Set(response.items.map((item) => item.id)).size !== response.items.length ||
      !Array.isArray(input.membershipFacts) ||
      input.membershipFacts.length !== response.items.length ||
      response.items.some((item) => {
        const sessionProject = session.projects.find((project) => project.id === item.id);
        const fact = input.membershipFacts.find((candidate) => candidate.projectId === item.id);
        return (
          item.active !== true ||
          !isUniqueArray(item.roles) ||
          !sessionProject ||
          sessionProject.active !== true ||
          sessionProject.key !== item.key ||
          sessionProject.name !== item.name ||
          canonicalString(sessionProject.roles) !== canonicalString(item.roles) ||
          !fact ||
          fact.accountId !== input.accountId ||
          fact.userId !== input.actorId ||
          fact.projectId !== item.id ||
          fact.active !== true ||
          fact.currentMembership !== true ||
          canonicalString(fact.project) !== canonicalString(item)
        );
      })
    ) {
      return "ambiguous";
    }
    return signedPageReceiptMatches(input, {
      operationId: "listVisibleProjects",
      query,
      response,
      normalizedFilters: {},
      orderedItemIds: response.items.map((item) => item.id),
      orderedSortKeys: response.items.map((item) => `${item.key}:${item.id}`),
      scope: { userId: input.actorId },
      limit: query.limit,
    })
      ? "unambiguous"
      : "ambiguous";
  }
  if (["members", "modules"].includes(operation)) {
    if (
      input.pathProjectId !== input.authorizedProjectId ||
      response.projectId !== input.pathProjectId ||
      input.accountId !== input.projectAuthorizationFact?.accountId ||
      input.actorId !== input.projectAuthorizationFact?.actorId ||
      input.pathProjectId !== input.projectAuthorizationFact?.projectId ||
      input.membershipRevision !== input.projectAuthorizationFact?.membershipRevision ||
      input.projectAuthorizationFact?.currentActive !== true
    ) {
      return "ambiguous";
    }
    const identityField = operation === "members" ? "userId" : "id";
    const facts = input.itemFacts;
    if (
      !Array.isArray(facts) ||
      facts.length !== response.items.length ||
      new Set(response.items.map((item) => item[identityField])).size !== response.items.length ||
      response.items.some((item) => {
        const fact = facts.find(
          (candidate) =>
            candidate[operation === "members" ? "userId" : "moduleId"] ===
            item[identityField],
        );
        return (
          item.projectId !== input.pathProjectId ||
          !fact ||
          fact.accountId !== input.accountId ||
          fact.projectId !== input.pathProjectId ||
          (operation === "members" &&
            (item.active !== true ||
              fact.userId !== item.userId ||
              fact.currentMembership !== true ||
              fact.active !== true ||
              fact.sameAccountUser !== true ||
              fact.displayNameProjection !== item.displayName ||
              canonicalString(fact.currentRoles) !== canonicalString(item.roles))) ||
          (operation === "modules" &&
            (fact.moduleId !== item.id || fact.currentActive !== item.active)) ||
          canonicalString(item) !== canonicalString(fact.item)
        );
      })
    ) {
      return "ambiguous";
    }
    if (operation === "modules") return "unambiguous";
    return signedPageReceiptMatches(input, {
      operationId: "listProjectMembers",
      query: input.query,
      response,
      normalizedFilters: {},
      orderedItemIds: response.items.map((item) => item.userId),
      orderedSortKeys: response.items.map(
        (item) => `${item.displayName.toLowerCase()}:${item.userId}`,
      ),
      scope: { projectId: input.pathProjectId },
      limit: input.query?.limit,
    })
      ? "unambiguous"
      : "ambiguous";
  }
  if (["comments", "attachments"].includes(operation)) {
    const bugResource = input.bugResource;
    if (
      !resourceScopeMatches(input, bugResource) ||
      input.pathBugId !== bugResource?.bugId ||
      response.bugId !== bugResource?.bugId ||
      response.projectId !== bugResource?.projectId
    ) {
      return "ambiguous";
    }
    let orderedItemIds;
    let orderedSortKeys;
    if (operation === "comments") {
      const facts = input.commentFacts;
      if (
        !Array.isArray(facts) ||
        facts.length !== response.items.length ||
        new Set(response.items.map((item) => item.id)).size !== response.items.length ||
        response.items.some((item) => {
        const fact = facts.find((candidate) => candidate.commentId === item.id);
          return (
            item.bugId !== bugResource.bugId ||
            item.projectId !== bugResource.projectId ||
            !fact ||
            fact.accountId !== input.accountId ||
            fact.projectId !== bugResource.projectId ||
            fact.bugId !== bugResource.bugId ||
            fact.commentId !== item.id ||
            fact.relationValidated !== true ||
            fact.authorFact?.accountId !== input.accountId ||
            fact.authorFact?.projectId !== bugResource.projectId ||
            fact.authorFact?.userId !== item.authorId ||
            fact.authorFact?.sameAccountUser !== true ||
            fact.authorFact?.identityValidated !== true ||
            !Array.isArray(fact.attachmentFacts) ||
            fact.attachmentFacts.length !== item.attachmentIds.length ||
            new Set(fact.attachmentFacts.map((entry) => entry.attachmentId)).size !==
              fact.attachmentFacts.length ||
            item.attachmentIds.some((attachmentId) => {
              const attachmentFact = fact.attachmentFacts.find(
                (entry) => entry.attachmentId === attachmentId,
              );
              return (
                !attachmentFact ||
                attachmentFact.accountId !== input.accountId ||
                attachmentFact.projectId !== bugResource.projectId ||
                attachmentFact.bugId !== bugResource.bugId ||
                attachmentFact.claimedByBug !== true ||
                attachmentFact.visibleToActor !== true ||
                attachmentFact.relationValidated !== true
              );
            }) ||
            canonicalString(item) !== canonicalString(fact.item)
          );
        })
      ) {
        return "ambiguous";
      }
      orderedItemIds = response.items.map((item) => item.id);
      orderedSortKeys = response.items.map((item) => {
        const createdAt = ascendingDateSortKey(item.createdAt);
        return createdAt == null ? null : `${createdAt}:${item.id}`;
      });
    } else {
      if (
        !Array.isArray(input.attachmentFacts) ||
        input.attachmentFacts.length !== response.items.length ||
        new Set(response.items.map((item) => item.attachmentId)).size !==
          response.items.length ||
        response.items.some((item) => {
          const fact = input.attachmentFacts?.find(
            (candidate) => candidate.attachmentId === item.attachmentId,
          );
          return (
            !fact ||
            fact.accountId !== input.accountId ||
            fact.bugId !== bugResource.bugId ||
            fact.projectId !== bugResource.projectId ||
            item.projectId !== fact.projectId ||
            item.bindingStatus !== "claimed" ||
            item.scanStatus !== "clean" ||
            item.readyToBind !== true ||
            typeof fact.claimId !== "string" ||
            !uuidPattern.test(fact.claimId) ||
            fact.claimRelationValidated !== true ||
            fact.currentVisible !== true ||
            fact.durablyReadable !== true ||
            canonicalString(item) !== canonicalString(fact.item)
          );
        })
      ) {
        return "ambiguous";
      }
      orderedItemIds = response.items.map((item) => item.attachmentId);
      orderedSortKeys = [...orderedItemIds];
    }
    return signedPageReceiptMatches(input, {
      operationId: operation === "comments" ? "listBugComments" : "listBugAttachments",
      query: input.query,
      response,
      normalizedFilters: {},
      orderedItemIds,
      orderedSortKeys,
      scope: { bugId: bugResource.bugId, projectId: bugResource.projectId },
      limit: input.query?.limit,
    })
      ? "unambiguous"
      : "ambiguous";
  }
  if (operation === "builds") {
    const query = input.query;
    const limit = query?.limit ?? 50;
    if (
      !query ||
      input.pathProjectId !== input.authorizedProjectId ||
      !input.authorizedProjectIds?.includes(input.pathProjectId) ||
      response.projectId !== input.pathProjectId ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Array.isArray(response.items) ||
      response.items.length > limit ||
      !Array.isArray(input.itemFacts) ||
      input.itemFacts.length !== response.items.length ||
      new Set(response.items.map((item) => item.id)).size !== response.items.length ||
      response.items.some((item) => {
        const fact = input.itemFacts.find((candidate) => candidate.buildId === item.id);
        return (
          item.projectId !== input.pathProjectId ||
          (query.status != null && item.status !== query.status) ||
          !fact ||
          fact.accountId !== input.accountId ||
          fact.projectId !== input.pathProjectId ||
          canonicalString(fact.build) !== canonicalString(item)
        );
      })
    ) {
      return "ambiguous";
    }
    const orderedItemIds = response.items.map((item) => item.id);
    return signedPageReceiptMatches(input, {
      operationId: "listProjectBuilds",
      query: { ...query, limit },
      response,
      normalizedFilters: { status: query.status ?? null },
      orderedItemIds,
      orderedSortKeys: [...orderedItemIds],
      scope: { projectId: input.pathProjectId },
      limit,
    })
      ? "unambiguous"
      : "ambiguous";
  }
  if (operation === "workflow") {
    const bugResource = input.bugResource;
    if (!resourceScopeMatches(input, bugResource)) return "ambiguous";
    const bugId = bugResource.bugId;
    if (input.pathBugId !== bugId || response.bugId !== bugId) return "ambiguous";
    if (canonicalString(response) !== canonicalString(input.workflowFact)) return "ambiguous";
    if (
      !Array.isArray(response.occurrences) ||
      !Array.isArray(response.repairAttempts) ||
      !Array.isArray(response.verifications) ||
      !Array.isArray(response.builds) ||
      !Array.isArray(response.relayReceipts) ||
      new Set(response.occurrences.map((item) => item.id)).size !== response.occurrences.length ||
      new Set(response.repairAttempts.map((item) => item.id)).size !==
        response.repairAttempts.length ||
      new Set(response.verifications.map((item) => item.id)).size !==
        response.verifications.length ||
      new Set(response.builds.map((item) => item.id)).size !== response.builds.length ||
      new Set(response.relayReceipts.map((item) => item.repairAttemptId)).size !==
        response.relayReceipts.length ||
      new Set(response.relayReceipts.map((item) => item.handoffId)).size !==
        response.relayReceipts.length ||
      response.occurrences.some((item) => item.bugId !== bugId) ||
      response.occurrences.some(
        (item) =>
          !isNativeOccurrenceEnvironment(item.environment, {
            allowAbsent: false,
            allowNull: true,
          }),
      ) ||
      response.repairAttempts.some((item) => item.bugId !== bugId) ||
      response.verifications.some((item) => item.bugId !== bugId) ||
      response.relayReceipts.some((item) => item.qaItem?.id !== bugId)
    ) {
      return "ambiguous";
    }
    const workflowRelations = [
      ...response.occurrences.flatMap((item) => [
        {
          referrerType: "occurrence",
          referrerId: item.id,
          relationType: "reporter_user",
          entityId: item.reporterId,
        },
        ...item.attachmentIds.map((attachmentId) => ({
          referrerType: "occurrence",
          referrerId: item.id,
          relationType: "attachment",
          entityId: attachmentId,
        })),
        ...(item.captureBundleId == null
          ? []
          : [{
              referrerType: "occurrence",
              referrerId: item.id,
              relationType: "capture_bundle",
              entityId: item.captureBundleId,
            }]),
      ]),
      ...response.repairAttempts.flatMap((item) => [
        {
          referrerType: "repair_attempt",
          referrerId: item.id,
          relationType: "assignee_user",
          entityId: item.assigneeId,
        },
        ...(item.parentAttemptId == null
          ? []
          : [{
              referrerType: "repair_attempt",
              referrerId: item.id,
              relationType: "parent_repair_attempt",
              entityId: item.parentAttemptId,
            }]),
      ]),
      ...response.verifications.flatMap((item) => [
        {
          referrerType: "verification",
          referrerId: item.id,
          relationType: "repair_attempt",
          entityId: item.repairAttemptId,
        },
        {
          referrerType: "verification",
          referrerId: item.id,
          relationType: "verifier_user",
          entityId: item.verifierId,
        },
      ]),
      ...response.relayReceipts.map((item) => ({
        referrerType: "relay_receipt",
        referrerId: `${item.repairAttemptId}:${item.handoffId}`,
        relationType: "repair_attempt",
        entityId: item.repairAttemptId,
      })),
    ];
    const userRelationTypes = new Set(["reporter_user", "assignee_user", "verifier_user"]);
    if (
      !Array.isArray(input.workflowRelationFacts) ||
      input.workflowRelationFacts.length !== workflowRelations.length ||
      new Set(
        input.workflowRelationFacts.map(
          (fact) =>
            `${fact.referrerType}:${fact.referrerId}:${fact.relationType}:${fact.entityId}`,
        ),
      ).size !== input.workflowRelationFacts.length ||
      workflowRelations.some((reference) => {
        const fact = input.workflowRelationFacts.find(
          (candidate) =>
            candidate.referrerType === reference.referrerType &&
            candidate.referrerId === reference.referrerId &&
            candidate.relationType === reference.relationType &&
            candidate.entityId === reference.entityId,
        );
        return (
          !fact ||
          fact.accountId !== input.accountId ||
          fact.projectId !== bugResource.projectId ||
          fact.bugId !== bugId ||
          fact.relationValidated !== true ||
          (userRelationTypes.has(reference.relationType) &&
            (fact.sameAccountUser !== true || fact.projectIdentityValidated !== true)) ||
          (reference.relationType === "attachment" &&
            (fact.claimedByBug !== true || fact.visibleToActor !== true)) ||
          (reference.relationType === "capture_bundle" &&
            (fact.ownedByBug !== true || fact.visibleToActor !== true)) ||
          (["parent_repair_attempt", "repair_attempt"].includes(reference.relationType) &&
            fact.sameBug !== true)
        );
      })
    ) {
      return "ambiguous";
    }
    const buildReferences = [
      ...response.occurrences
        .filter((item) => item.environment?.buildId != null)
        .map((item) => ({
          referrerType: "occurrence",
          referrerId: item.id,
          repairAttemptId: null,
          buildId: item.environment.buildId,
        })),
      ...response.repairAttempts
        .filter((item) => item.targetBuildId != null)
        .map((item) => ({
          referrerType: "repair_attempt",
          referrerId: item.id,
          repairAttemptId: item.id,
          buildId: item.targetBuildId,
        })),
      ...response.verifications
        .filter((item) => item.buildId != null)
        .map((item) => ({
          referrerType: "verification",
          referrerId: item.id,
          repairAttemptId: item.repairAttemptId,
          buildId: item.buildId,
        })),
      ...response.relayReceipts
        .filter((item) => item.buildId != null)
        .map((item) => ({
          referrerType: "relay_receipt",
          referrerId: `${item.repairAttemptId}:${item.handoffId}`,
          repairAttemptId: item.repairAttemptId,
          buildId: item.buildId,
        })),
    ];
    if (
      !Array.isArray(input.buildReferenceFacts) ||
      input.buildReferenceFacts.length !== buildReferences.length ||
      new Set(
        input.buildReferenceFacts.map(
          (fact) => `${fact.referrerType}:${fact.referrerId}:${fact.buildId}`,
        ),
      ).size !== input.buildReferenceFacts.length ||
      buildReferences.some((reference) => {
        const fact = input.buildReferenceFacts.find(
          (candidate) =>
            candidate.referrerType === reference.referrerType &&
            candidate.referrerId === reference.referrerId &&
            candidate.buildId === reference.buildId,
        );
        return (
          !fact ||
          fact.accountId !== input.accountId ||
          fact.projectId !== bugResource.projectId ||
          fact.bugId !== bugId ||
          !sameNullable(fact.repairAttemptId, reference.repairAttemptId) ||
          fact.relationValidated !== true
        );
      }) ||
      !Array.isArray(input.buildFacts) ||
      input.buildFacts.length !== response.builds.length ||
      new Set(input.buildFacts.map((fact) => fact.buildId)).size !== input.buildFacts.length ||
      response.builds.some((item) => {
        const fact = input.buildFacts?.find((candidate) => candidate.buildId === item.id);
        return (
          item.projectId !== bugResource.projectId ||
          !fact ||
          fact.accountId !== input.accountId ||
          fact.projectId !== bugResource.projectId ||
          fact.bugId !== bugId ||
          fact.relationValidated !== true ||
          canonicalString(fact.build) !== canonicalString(item)
        );
      })
    ) {
      return "ambiguous";
    }
    const limitPerCollection = input.query?.limitPerCollection;
    const collections = [
      ["occurrences", response.occurrences, (item) => item.id],
      ["repairAttempts", response.repairAttempts, (item) => item.id],
      ["verifications", response.verifications, (item) => item.id],
      ["builds", response.builds, (item) => item.id],
      ["relayReceipts", response.relayReceipts, (item) => `${item.repairAttemptId}:${item.handoffId}`],
    ];
    if (
      !Number.isInteger(limitPerCollection) ||
      limitPerCollection < 1 ||
      limitPerCollection > 100 ||
      collections.some(([, items]) => items.length > limitPerCollection)
    ) {
      return "ambiguous";
    }
    return workflowPageReceiptMatches(input, {
      query: input.query,
      response,
      collections,
      scope: { bugId, projectId: bugResource.projectId },
      limit: limitPerCollection,
    })
      ? "unambiguous"
      : "ambiguous";
  }
  return "ambiguous";
}

function evaluateAuditListReceipt(input) {
  const { query, response, bugResource, pageFact } = input;
  const effectiveAnchorAfterSequence =
    query?.cursor == null ? query?.afterSequence : input.cursorFact?.anchorAfterSequence;
  if (
    !query ||
    !response ||
    !resourceScopeMatches(input, bugResource) ||
    input.pathBugId !== bugResource?.bugId ||
    response.bugId !== bugResource?.bugId ||
    response.projectId !== bugResource?.projectId ||
    !Number.isInteger(response.snapshotSequence) ||
    response.snapshotSequence < 0 ||
    !Array.isArray(response.items) ||
    typeof query.afterSequence !== "number" ||
    !Number.isInteger(query.afterSequence) ||
    query.afterSequence < 0 ||
    (query.cursor != null && query.afterSequence !== 0) ||
    !Number.isInteger(effectiveAnchorAfterSequence) ||
    effectiveAnchorAfterSequence < 0 ||
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100 ||
    response.items.length > query.limit
  ) {
    return "ambiguous";
  }
  const eventIds = response.items.map((event) => event.id);
  const sequences = response.items.map((event) => event.sequence);
  if (
    new Set(eventIds).size !== eventIds.length ||
    sequences.some(
      (sequence, index) =>
        !Number.isInteger(sequence) ||
        sequence <= effectiveAnchorAfterSequence ||
        sequence > response.snapshotSequence ||
        (index > 0 && sequence <= sequences[index - 1]),
    )
  ) {
    return "ambiguous";
  }
  if (
    !Array.isArray(input.eventFacts) ||
    input.eventFacts.length !== response.items.length ||
    response.items.some((event) => {
      const fact = input.eventFacts.find((candidate) => candidate.eventId === event.id);
      return !auditEventFactMatches(event, fact, {
        accountId: input.accountId,
        projectId: bugResource.projectId,
        bugId: bugResource.bugId,
      });
    })
  ) {
    return "ambiguous";
  }
  const orderedSortKeys = response.items.map(
    (event) => `${String(event.sequence).padStart(16, "0")}:${event.id}`,
  );
  if (
    pageFact?.anchorAfterSequence !== effectiveAnchorAfterSequence ||
    (query.cursor != null &&
      input.cursorFact?.anchorAfterSequence !== effectiveAnchorAfterSequence) ||
    (response.nextCursor != null &&
      input.nextCursorFact?.anchorAfterSequence !== effectiveAnchorAfterSequence)
  ) {
    return "ambiguous";
  }
  return signedPageReceiptMatches(input, {
    operationId: "listBugEvents",
    query,
    response,
    normalizedFilters: { afterSequence: effectiveAnchorAfterSequence },
    orderedItemIds: eventIds,
    orderedSortKeys,
    scope: { bugId: bugResource.bugId, projectId: bugResource.projectId },
    limit: query.limit,
  })
    ? "unambiguous"
    : "ambiguous";
}

function evaluateAuditStreamReceipt(input) {
  const { subscription, frames, resumeFact, streamFact } = input;
  const filters = {
    projectId: subscription?.projectId ?? null,
    eventTypes: Array.isArray(subscription?.eventTypes)
      ? [...subscription.eventTypes].sort()
      : [],
  };
  const authorizedProjectIds = Array.isArray(input.authorizedProjectIds)
    ? [...input.authorizedProjectIds].sort()
    : [];
  const suppliedResumeValues = [
    subscription?.afterDeliverySequence,
    subscription?.cursor,
    subscription?.lastEventId,
  ].filter((value) => value != null);
  if (
    !subscription ||
    !Array.isArray(frames) ||
    frames.length > 100 ||
    typeof input.accountId !== "string" ||
    input.accountId.length === 0 ||
    typeof input.actorId !== "string" ||
    input.actorId.length === 0 ||
    !Array.isArray(input.authorizedProjectIds) ||
    !isUniqueArray(input.authorizedProjectIds) ||
    typeof input.membershipRevision !== "string" ||
    input.membershipRevision.length === 0 ||
    suppliedResumeValues.length > 1 ||
    (subscription.afterDeliverySequence != null &&
      (!Number.isInteger(subscription.afterDeliverySequence) ||
        subscription.afterDeliverySequence < 0)) ||
    (subscription.cursor != null &&
      (typeof subscription.cursor !== "string" ||
        subscription.cursor.length === 0 ||
        subscription.cursor.length > 500)) ||
    (subscription.lastEventId != null &&
      (typeof subscription.lastEventId !== "string" ||
        subscription.lastEventId.length === 0 ||
        subscription.lastEventId.length > 500)) ||
    !Array.isArray(subscription.eventTypes) ||
    !isUniqueArray(subscription.eventTypes) ||
    subscription.eventTypes.length > 20 ||
    (subscription.projectId != null &&
      !input.authorizedProjectIds.includes(subscription.projectId))
  ) {
    return "ambiguous";
  }
  const filterDigest = canonicalNonSecretRequestDigest(
    "streamEvents:filters",
    {
      accountId: input.accountId,
      actorId: input.actorId,
    },
    filters,
    "filters",
  );
  const membershipSetDigest = canonicalNonSecretRequestDigest(
    "streamEvents:membership-set",
    {
      accountId: input.accountId,
      actorId: input.actorId,
      membershipRevision: input.membershipRevision,
    },
    authorizedProjectIds,
    "membership",
  );
  const directStart = subscription.afterDeliverySequence ?? 0;
  if (
    !resumeFact ||
    resumeFact.accountId !== input.accountId ||
    resumeFact.actorId !== input.actorId ||
    resumeFact.membershipRevision !== input.membershipRevision ||
    resumeFact.membershipSetDigest !== membershipSetDigest ||
    !sameNullable(resumeFact.cursor, subscription.cursor) ||
    !sameNullable(resumeFact.lastEventId, subscription.lastEventId) ||
    resumeFact.filterDigest !== filterDigest ||
    resumeFact.signatureValid !== true ||
    !Number.isInteger(resumeFact.lastDeliverySequence) ||
    resumeFact.lastDeliverySequence < 0 ||
    !Number.isInteger(resumeFact.retentionFloorDeliverySequence) ||
    !Number.isInteger(resumeFact.currentHighWaterDeliverySequence) ||
    resumeFact.retentionFloorDeliverySequence < 0 ||
    resumeFact.currentHighWaterDeliverySequence < resumeFact.retentionFloorDeliverySequence ||
    resumeFact.lastDeliverySequence < resumeFact.retentionFloorDeliverySequence ||
    resumeFact.lastDeliverySequence > resumeFact.currentHighWaterDeliverySequence ||
    (subscription.cursor == null &&
      subscription.lastEventId == null &&
      resumeFact.lastDeliverySequence !== directStart) ||
    !streamFact ||
    streamFact.accountId !== input.accountId ||
    streamFact.actorId !== input.actorId ||
    streamFact.membershipRevision !== input.membershipRevision ||
    streamFact.membershipSetDigest !== membershipSetDigest ||
    streamFact.filterDigest !== filterDigest ||
    streamFact.retentionFloorDeliverySequence !==
      resumeFact.retentionFloorDeliverySequence ||
    streamFact.currentHighWaterDeliverySequence !==
      resumeFact.currentHighWaterDeliverySequence ||
    streamFact.authorizationCheckedAtOpen !== true ||
    streamFact.membershipRecheckedPerFrame !== true
  ) {
    return "ambiguous";
  }
  if (
    !Array.isArray(input.heartbeatFrames) ||
    input.heartbeatFrames.some(
      (heartbeat) =>
        canonicalString(Object.keys(heartbeat).sort()) !==
          canonicalString(["comment", "deliverySequence", "id", "type"]) ||
        heartbeat.type !== "comment" ||
        heartbeat.id != null ||
        heartbeat.deliverySequence != null ||
        typeof heartbeat.comment !== "string" ||
        heartbeat.comment.length < 1 ||
        heartbeat.comment.length > 200 ||
        /[\r\n]/.test(heartbeat.comment),
    )
  ) {
    return "ambiguous";
  }

  const eventIds = frames.map((frame) => frame.data?.id);
  const deliverySequences = frames.map((frame) => frame.deliverySequence);
  const frameTokens = frames.map((frame) => frame.id);
  if (
    new Set(eventIds).size !== eventIds.length ||
    new Set(frameTokens).size !== frameTokens.length ||
    deliverySequences.some(
      (sequence, index) =>
        !Number.isInteger(sequence) ||
        sequence <= resumeFact.lastDeliverySequence ||
        sequence > resumeFact.currentHighWaterDeliverySequence ||
        (index > 0 && sequence <= deliverySequences[index - 1]),
    ) ||
    canonicalString(streamFact.orderedEventIds) !== canonicalString(eventIds) ||
    canonicalString(streamFact.orderedFrameTokens) !== canonicalString(frameTokens) ||
    canonicalString(streamFact.deliverySequences) !== canonicalString(deliverySequences) ||
    !Array.isArray(input.eventFacts) ||
    input.eventFacts.length !== frames.length ||
    !Array.isArray(input.frameAuthorizationFacts) ||
    input.frameAuthorizationFacts.length !== frames.length
  ) {
    return "ambiguous";
  }

  for (const frame of frames) {
    const event = frame.data;
    const eventFact = input.eventFacts.find((fact) => fact.eventId === event?.id);
    const authorizationFact = input.frameAuthorizationFacts.find(
      (fact) =>
        fact.eventId === event?.id && fact.deliverySequence === frame.deliverySequence,
    );
    if (
      canonicalString(Object.keys(frame).sort()) !==
        canonicalString(["data", "deliverySequence", "eventName", "id", "serializedData"]) ||
      !input.authorizedProjectIds.includes(event?.projectId) ||
      (subscription.projectId != null && event.projectId !== subscription.projectId) ||
      (subscription.eventTypes.length > 0 &&
        !subscription.eventTypes.includes(event.type)) ||
      !authorizationFact ||
      frame.id !== authorizationFact.frameToken ||
      typeof frame.id !== "string" ||
      frame.id.length === 0 ||
      frame.id.length > 500 ||
      frame.eventName !== "qa.audit" ||
      frame.serializedData !== canonicalString(event) ||
      /[\r\n]/.test(frame.serializedData) ||
      Buffer.byteLength(frame.serializedData, "utf8") > APP_FIRST_LIMITS.maxSseEventUtf8Bytes ||
      authorizationFact.frameCursorSignatureValid !== true ||
      authorizationFact.accountId !== input.accountId ||
      authorizationFact.actorId !== input.actorId ||
      authorizationFact.membershipRevision !== input.membershipRevision ||
      authorizationFact.membershipSetDigest !== membershipSetDigest ||
      authorizationFact.filterDigest !== filterDigest ||
      authorizationFact.projectId !== event.projectId ||
      authorizationFact.bugId !== event.bugId ||
      authorizationFact.currentMembershipActive !== true ||
      authorizationFact.visibleToActor !== true ||
      authorizationFact.membershipCheckedAtEmit !== true ||
      !auditEventFactMatches(event, eventFact, {
        accountId: input.accountId,
        projectId: event.projectId,
        bugId: event.bugId,
      })
    ) {
      return "ambiguous";
    }
  }
  return "unambiguous";
}

function sameObjectExcept(left, right, ignoredFields) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftCopy = structuredClone(left);
  const rightCopy = structuredClone(right);
  for (const field of ignoredFields) {
    delete leftCopy[field];
    delete rightCopy[field];
  }
  return canonicalString(leftCopy) === canonicalString(rightCopy);
}

function humanWriteAuthorityMatches(input, operationId, projectId) {
  return Boolean(
    typeof input.accountId === "string" &&
      typeof input.actorId === "string" &&
      input.authorizedProjectIds?.includes(projectId) &&
      input.membershipFact?.accountId === input.accountId &&
      input.membershipFact?.actorId === input.actorId &&
      input.membershipFact?.projectId === projectId &&
      input.membershipFact?.currentActive === true &&
      input.authorizationFact?.operationId === operationId &&
      input.authorizationFact?.accountId === input.accountId &&
      input.authorizationFact?.actorId === input.actorId &&
      input.authorizationFact?.projectId === projectId &&
      input.authorizationFact?.authorizedHuman === true &&
      input.authorizationFact?.capabilityGranted === true &&
      input.authorizationFact?.resolvedCurrentResourceBeforeIdempotency === true,
  );
}

function buildRequirementFactMatches(
  fact,
  {
    accountId,
    projectId,
    bugId,
    repairAttemptId,
    sourceDeliveryVersion,
    deliveredCommitSha,
    requirement,
    linkedBuildId,
    linkId,
    bugVersionAtDelivery,
    version,
  },
) {
  const record = fact?.buildRequirement;
  const deliveryAudit = fact?.deliveryDecisionAuditFact;
  const createdAt = toEpoch(record?.createdAt);
  const updatedAt = toEpoch(record?.updatedAt);
  const decisionValid =
    (record?.requirement === "required" &&
      typeof record?.deliveredCommitSha === "string" &&
      record?.decisionBasis === "code_requires_build" &&
      record?.decisionReason === null &&
      typeof record?.decisionActorId === "string" &&
      record.decisionActorId.length > 0) ||
    (record?.requirement === "not_required" &&
      record?.deliveredCommitSha === null &&
      record?.decisionBasis === "no_code_delivery" &&
      typeof record?.decisionReason === "string" &&
      record.decisionReason.length > 0 &&
      typeof record?.decisionActorId === "string" &&
      record.decisionActorId.length > 0) ||
    (record?.requirement === "not_required" &&
      typeof record?.deliveredCommitSha === "string" &&
      record?.decisionBasis === "authorized_no_build_exemption" &&
      typeof record?.decisionReason === "string" &&
      record.decisionReason.length > 0 &&
      typeof record?.decisionActorId === "string" &&
      record.decisionActorId.length > 0);
  return Boolean(
    fact?.accountId === accountId &&
      fact?.projectId === projectId &&
      fact?.bugId === bugId &&
      record?.projectId === projectId &&
      record?.bugId === bugId &&
      record?.repairAttemptId === repairAttemptId &&
      record?.sourceDeliveryVersion === sourceDeliveryVersion &&
      sameNullable(record?.deliveredCommitSha, deliveredCommitSha) &&
      record?.requirement === requirement &&
      sameNullable(record?.linkedBuildId, linkedBuildId) &&
      sameNullable(record?.linkId, linkId) &&
      record?.policyVersion === "1.0.0" &&
      record?.bugVersionAtDelivery === bugVersionAtDelivery &&
      record?.version === version &&
      decisionValid &&
      typeof record?.decisionAuditEventId === "string" &&
      record.decisionAuditEventId.length > 0 &&
      deliveryAudit?.id === record.decisionAuditEventId &&
      deliveryAudit?.accountId === accountId &&
      deliveryAudit?.projectId === projectId &&
      deliveryAudit?.bugId === bugId &&
      deliveryAudit?.repairAttemptId === repairAttemptId &&
      deliveryAudit?.buildRequirementId === record.id &&
      deliveryAudit?.sourceDeliveryVersion === sourceDeliveryVersion &&
      sameNullable(deliveryAudit?.deliveredCommitSha, deliveredCommitSha) &&
      deliveryAudit?.requirement === requirement &&
      deliveryAudit?.decisionBasis === record.decisionBasis &&
      sameNullable(deliveryAudit?.decisionReason, record.decisionReason) &&
      deliveryAudit?.actorId === record.decisionActorId &&
      deliveryAudit?.deliveryRequestDigest === fact?.deliveryRequestDigest &&
      deliveryAudit?.policyVersion === record.policyVersion &&
      deliveryAudit?.serverPolicyEvaluatedAtDelivery === true &&
      deliveryAudit?.authorizedNoBuildExemptionAtDelivery ===
        (record.decisionBasis === "authorized_no_build_exemption") &&
      deliveryAudit?.noCodeDecisionValidatedAtDelivery ===
        (record.decisionBasis === "no_code_delivery") &&
      deliveryAudit?.committed === true &&
      deliveryAudit?.atomicWithDelivery === true &&
      typeof record?.id === "string" &&
      record.id.length > 0 &&
      createdAt !== undefined &&
      updatedAt !== undefined &&
      updatedAt >= createdAt,
  );
}

function buildRepairRelationMatches(
  fact,
  { accountId, projectId, bugId, attemptId, buildId, commitSha, requirementId, requirementVersion },
) {
  const link = fact?.link;
  const evidenceAudit = fact?.evidenceAuditFact;
  const evidenceDecisionValid =
    (link?.evidenceType === "manifest" &&
      link?.evidenceDecision === "manifest_verified" &&
      link?.overrideReason === null) ||
    (link?.evidenceType === "release_manager_override" &&
      link?.evidenceDecision === "release_manager_authorized" &&
      typeof link?.overrideReason === "string" &&
      link.overrideReason.length > 0);
  return Boolean(
    fact?.accountId === accountId &&
      fact?.projectId === projectId &&
      link?.projectId === projectId &&
      link?.bugId === bugId &&
      link?.repairAttemptId === attemptId &&
      link?.buildId === buildId &&
      link?.deliveredCommitSha === commitSha &&
      link?.buildRequirementId === requirementId &&
      link?.buildRequirementVersion === requirementVersion &&
      evidenceDecisionValid &&
      typeof link?.evidenceActorId === "string" &&
      link.evidenceActorId.length > 0 &&
      typeof link?.evidenceAuditEventId === "string" &&
      link.evidenceAuditEventId.length > 0 &&
      link?.evidencePolicyVersion === "1.0.0" &&
      evidenceAudit?.id === link?.evidenceAuditEventId &&
      evidenceAudit?.accountId === accountId &&
      evidenceAudit?.projectId === projectId &&
      evidenceAudit?.bugId === bugId &&
      evidenceAudit?.repairAttemptId === attemptId &&
      evidenceAudit?.buildId === buildId &&
      evidenceAudit?.linkId === link?.id &&
      evidenceAudit?.actorId === link?.evidenceActorId &&
      evidenceAudit?.deliveredCommitSha === commitSha &&
      evidenceAudit?.evidenceType === link?.evidenceType &&
      evidenceAudit?.evidenceDecision === link?.evidenceDecision &&
      sameNullable(evidenceAudit?.overrideReason, link?.overrideReason) &&
      evidenceAudit?.policyVersion === link?.evidencePolicyVersion &&
      evidenceAudit?.manifestVerifiedAtLink === (link?.evidenceType === "manifest") &&
      evidenceAudit?.releaseManagerAuthorizedAtLink ===
        (link?.evidenceType === "release_manager_override") &&
      evidenceAudit?.committed === true &&
      evidenceAudit?.atomicWithLink === true &&
      link?.version === 1 &&
      toEpoch(link?.linkedAt) !== undefined &&
      typeof link?.id === "string" &&
      link.id.length > 0 &&
      fact?.relationCommitted === true,
  );
}

function linkedBuildEvidenceEligible({ link, build, deliveredCommitSha, exactManifestEligible }) {
  if (link?.evidenceType === "manifest") {
    return Boolean(
      link.evidenceDecision === "manifest_verified" &&
        link.overrideReason === null &&
        build?.manifest?.commitShas?.includes(deliveredCommitSha) &&
        exactManifestEligible === true,
    );
  }
  return Boolean(
    link?.evidenceType === "release_manager_override" &&
      link.evidenceDecision === "release_manager_authorized" &&
      typeof link.overrideReason === "string" &&
      link.overrideReason.length > 0,
  );
}

function canonicalWriteAuditDetails(input, operationId) {
  const request = input.request;
  const response =
    operationId === "supersedeRepairAttempt" && input.representation !== "legacy"
      ? input.response?.supersededAttempt
      : input.response;
  const build = operationId === "linkBuildRepair" && input.representation !== "legacy"
    ? response?.build
    : response;
  switch (operationId) {
    case "createRepairAttempt":
      return {
        bugId: input.pathBugId,
        repairAttemptId: response?.id,
        mode: request?.mode,
        assigneeId: request?.assigneeId,
        parentAttemptId: request?.parentAttemptId ?? null,
      };
    case "startRepairAttempt":
      return { repairAttemptId: response?.id, fromStatus: "planned", toStatus: "running" };
    case "deliverRepairAttempt":
      return {
        repairAttemptId: response?.id,
        deliveryKind: request?.deliveryKind,
        commitSha: response?.commitSha ?? null,
        buildRequirement: input.effectFact?.buildRequirement,
      };
    case "failRepairAttempt":
      return { repairAttemptId: response?.id, reason: request?.reason };
    case "supersedeRepairAttempt":
      return {
        repairAttemptId: response?.id,
        successorAttemptId:
          request?.successor?.id ?? input.successorAttemptFact?.attempt?.id ?? null,
        replacementMode: input.representation === "legacy" ? "legacy_two_step" : "atomic_successor",
        reason: request?.reason,
      };
    case "createVerification":
      return {
        bugId: input.pathBugId,
        verificationId: response?.id,
        repairAttemptId: request?.repairAttemptId,
        buildId: request?.buildId ?? null,
        verifierId: request?.verifierId,
      };
    case "startVerification":
      return { verificationId: response?.id, fromStatus: "requested", toStatus: "in_progress" };
    case "registerBuild":
      return {
        buildId: build?.id,
        provider: request?.provider,
        externalId: request?.externalId,
        sourceCommitSha: request?.sourceCommitSha,
        status: request?.status,
      };
    case "linkBuildRepair":
      return {
        buildId: build?.id,
        repairAttemptId: request?.repairAttemptId,
        bugId: input.repairAttemptFact?.attempt?.bugId,
        linkId: input.linkRelationFact?.link?.id ?? null,
        buildRequirementId:
          input.committedBuildRequirementFact?.buildRequirement?.id ?? null,
        buildRequirementVersion:
          input.committedBuildRequirementFact?.buildRequirement?.version ?? null,
        bugVersionBefore: input.effectFact?.bugVersionBefore ?? null,
        bugVersionAfter: input.effectFact?.bugVersionAfter ?? null,
        deliveredCommitSha: request?.deliveredCommitSha,
        evidenceType: request?.evidenceType,
        overrideReason: request?.overrideReason ?? null,
      };
    default:
      return undefined;
  }
}

function atomicWriteEffectMatches(input, operationId, projectId, bugId, resourceType, resourceId) {
  const effect = input.effectFact;
  const event = input.auditEventFact;
  const outbox = input.notificationOutboxFact;
  const expectedEventType = {
    createRepairAttempt: "repair_attempt.created",
    startRepairAttempt: "repair_attempt.started",
    deliverRepairAttempt: "repair_attempt.delivered",
    failRepairAttempt: "repair_attempt.failed",
    supersedeRepairAttempt: "repair_attempt.superseded",
    createVerification: "verification.created",
    startVerification: "verification.started",
    registerBuild: "build.registered",
    linkBuildRepair: "build.repair_linked",
  }[operationId];
  return Boolean(
    effect?.operationId === operationId &&
      effect?.accountId === input.accountId &&
      effect?.actorId === input.actorId &&
      effect?.projectId === projectId &&
      sameNullable(effect?.bugId, bugId) &&
      effect?.resourceType === resourceType &&
      effect?.resourceId === resourceId &&
      effect?.domainMutationCommitted === true &&
      effect?.auditEventCommitted === true &&
      effect?.auditEventCount === 1 &&
      effect?.notificationOutboxCommitted === true &&
      effect?.idempotencyRecordCommitted === true &&
      effect?.atomicWithReceipt === true &&
      typeof effect?.auditEventId === "string" &&
      effect.auditEventId.length > 0 &&
      isUniqueArray(effect?.notificationMessageIds) &&
      effect.notificationMessageIds.length > 0 &&
      event?.id === effect.auditEventId &&
      event?.type === expectedEventType &&
      event?.source === "qa_hub" &&
      event?.actorType === "user" &&
      event?.accountId === input.accountId &&
      event?.actorId === input.actorId &&
      event?.projectId === projectId &&
      sameNullable(event?.bugId, bugId) &&
      event?.resourceType === resourceType &&
      event?.resourceId === resourceId &&
      event?.resourceVersionAfter === effect.resourceVersionAfter &&
      sameNullable(event?.fromStatus, effect.fromStatus ?? null) &&
      sameNullable(event?.toStatus, effect.toStatus ?? null) &&
      event?.requestDigest === input.persistedRequestDigest &&
      !hasOwn(event, "payload") &&
      canonicalString(event?.details) ===
        canonicalString(canonicalWriteAuditDetails(input, operationId)) &&
      event?.typedRelationsValidated === true &&
      event?.committed === true &&
      outbox?.accountId === input.accountId &&
      outbox?.projectId === projectId &&
      sameNullable(outbox?.bugId, bugId) &&
      outbox?.sourceOperationId === operationId &&
      outbox?.eventId === event.id &&
      canonicalString(outbox?.messageIds) === canonicalString(effect.notificationMessageIds) &&
      outbox?.recipientsEvaluatedFromCurrentMembership === true &&
      outbox?.committed === true &&
      outbox?.atomicWithEffect === true,
  );
}

function authorizedReplaySnapshotMatches(
  input,
  { operationId, actorId, projectId, bugId, resourceType, resourceId, responseVersion },
) {
  if (!input.exactReplay) return true;
  const current = input.replayCurrentResourceFact;
  const precondition = input.persistedPreconditionFact;
  return Boolean(
    current?.operationId === operationId &&
      current?.accountId === input.accountId &&
      current?.actorId === actorId &&
      current?.projectId === projectId &&
      sameNullable(current?.bugId, bugId) &&
      current?.resourceType === resourceType &&
      current?.resourceId === resourceId &&
      Number.isInteger(current?.currentVersion) &&
      current.currentVersion >= responseVersion &&
      current?.currentlyVisible === true &&
      current?.currentMembershipActive === true &&
      current?.authorizationRecheckedBeforeReplay === true &&
      precondition?.operationId === operationId &&
      precondition?.accountId === input.accountId &&
      precondition?.actorId === actorId &&
      precondition?.projectId === projectId &&
      sameNullable(precondition?.bugId, bugId) &&
      precondition?.resourceType === resourceType &&
      precondition?.resourceId === resourceId &&
      precondition?.requestDigest === input.persistedRequestDigest &&
      precondition?.auditEventId ===
        (input.effectFact?.auditEventId ?? input.multiAggregateEffectFact?.auditEventId) &&
      precondition?.snapshotCommitted === true &&
      precondition?.atomicWithReceipt === true,
  );
}

function workflowBugEffectMatches(input, operationId, bugId) {
  const before = input.bugResource?.bug;
  const after = input.committedBugFact?.bug;
  const effect = input.effectFact;
  const mutatesBug = !["startRepairAttempt", "startVerification"].includes(operationId);
  const expectedVersionAfter = before?.version + (mutatesBug ? 1 : 0);
  const expectedStateAfter = effect?.bugStateAfter ?? before?.state;
  return Boolean(
    input.bugResource?.accountId === input.accountId &&
      input.bugResource?.projectId === input.projectId &&
      input.bugResource?.bugId === bugId &&
      before?.id === bugId &&
      before?.projectId === input.projectId &&
      before?.state === input.bugResource.state &&
      before?.version === input.bugResource.version &&
      input.committedBugFact?.accountId === input.accountId &&
      input.committedBugFact?.projectId === input.projectId &&
      input.committedBugFact?.bugId === bugId &&
      input.committedBugFact?.committed === true &&
      input.committedBugFact?.atomicWithWrite === true &&
      after?.id === bugId &&
      after?.projectId === input.projectId &&
      after?.state === expectedStateAfter &&
      after?.version === expectedVersionAfter &&
      after?.reopenCount === before.reopenCount &&
      (mutatesBug
        ? sameObjectExcept(before, after, ["state", "version", "updatedAt"])
        : canonicalString(before) === canonicalString(after)) &&
      effect?.bugStateBefore === before.state &&
      effect?.bugStateAfter === expectedStateAfter &&
      effect?.bugVersionBefore === before.version &&
      effect?.bugVersionAfter === expectedVersionAfter &&
      effect?.bugMutationCount === (mutatesBug ? 1 : 0) &&
      input.committedBugFact?.activeAttemptId ===
        (hasOwn(effect, "activeAttemptIdAfter")
          ? effect.activeAttemptIdAfter
          : input.bugResource.activeAttemptId ?? null) &&
      input.committedBugFact?.activeVerificationId ===
        (hasOwn(effect, "activeVerificationIdAfter")
          ? effect.activeVerificationIdAfter
          : input.bugResource.activeVerificationId ?? null),
  );
}

function workflowReceiptScope(input, projectId, bugId) {
  return {
    accountId: input.accountId,
    actorId: input.actorId,
    projectId,
    bugId,
    attemptId: input.pathAttemptId ?? null,
    verificationId: input.pathVerificationId ?? null,
  };
}

function workflowReceiptKey(operationId, input) {
  const expectedVersion = input.request?.expectedVersion;
  switch (operationId) {
    case "createRepairAttempt":
      return `workflow:createRepairAttempt:bug:${input.pathBugId}:v${expectedVersion}`;
    case "startRepairAttempt":
    case "deliverRepairAttempt":
    case "failRepairAttempt":
      return `workflow:${operationId}:attempt:${input.pathAttemptId}:v${expectedVersion}`;
    case "supersedeRepairAttempt":
      return `workflow:supersedeRepairAttempt:attempt:${input.pathAttemptId}:v${expectedVersion}`;
    case "createVerification":
      return `workflow:createVerification:bug:${input.pathBugId}:attempt:${input.request?.repairAttemptId}:v${expectedVersion}`;
    case "startVerification":
      return `workflow:startVerification:verification:${input.pathVerificationId}:v${expectedVersion}`;
    default:
      return undefined;
  }
}

function workflowAttemptScopeMatches(input, attempt, projectId, bugId) {
  return Boolean(
    attempt &&
      input.attemptResource?.accountId === input.accountId &&
      input.attemptResource?.projectId === projectId &&
      input.attemptResource?.bugId === bugId &&
      canonicalString(input.attemptResource?.attempt) === canonicalString(attempt),
  );
}

function evaluateWorkflowWriteReceipt(input) {
  const { operationId, request } = input;
  const representation = input.representation ?? "vendor";
  const httpResponse = input.response;
  const response =
    operationId === "supersedeRepairAttempt" && representation === "vendor"
      ? httpResponse?.supersededAttempt
      : httpResponse;
  if (
    !request ||
    !response ||
    !["vendor", "legacy"].includes(representation) ||
    !workflowReceiptKey(operationId, input)
  ) {
    return "ambiguous";
  }
  const isAttemptOperation = [
    "startRepairAttempt",
    "deliverRepairAttempt",
    "failRepairAttempt",
    "supersedeRepairAttempt",
  ].includes(operationId);
  const isVerificationOperation = ["createVerification", "startVerification"].includes(
    operationId,
  );
  const bugId =
    input.pathBugId ??
    input.attemptResource?.bugId ??
    input.verificationResource?.bugId ??
    response.bugId;
  const projectId = input.projectId;
  const resourceType = isVerificationOperation ? "verification" : "repair_attempt";
  const resourceId = response.id;
  const expectedStatus = ["createRepairAttempt", "createVerification"].includes(operationId)
    ? 201
    : 200;
  if (
    !humanWriteAuthorityMatches(input, operationId, projectId) ||
    !atomicWriteEffectMatches(input, operationId, projectId, bugId, resourceType, resourceId) ||
    !evaluateNonSecretWriteReceiptInvariant(input, {
      operationId,
      scope: workflowReceiptScope(input, projectId, bugId),
      requestForDigest: request,
      expectedIdempotencyKey: workflowReceiptKey(operationId, input),
      expectedHttpStatus: expectedStatus,
      response: httpResponse,
      responseHasReplayMarker:
        operationId === "supersedeRepairAttempt" && representation === "vendor",
    }) ||
    input.committedResourceFact?.accountId !== input.accountId ||
    input.committedResourceFact?.projectId !== projectId ||
    input.committedResourceFact?.resourceType !== resourceType ||
    input.committedResourceFact?.resourceId !== resourceId ||
    canonicalString(input.committedResourceFact?.resource) !== canonicalString(response) ||
    !authorizedReplaySnapshotMatches(input, {
      operationId,
      actorId: input.actorId,
      projectId,
      bugId,
      resourceType,
      resourceId,
      responseVersion: response.version,
    })
  ) {
    return "ambiguous";
  }
  if (input.exactReplay) {
    input = { ...input, ...input.persistedPreconditionFact };
  }
  if (!workflowBugEffectMatches(input, operationId, bugId)) return "ambiguous";

  if (operationId === "createRepairAttempt") {
    const parentId = request.parentAttemptId ?? null;
    return input.pathBugId === bugId &&
      input.bugResource?.accountId === input.accountId &&
      input.bugResource?.projectId === projectId &&
      input.bugResource?.bugId === bugId &&
      input.bugResource?.state === "ready" &&
      input.bugResource?.version === request.expectedVersion &&
      input.bugResource?.activeAttemptId === null &&
      input.bugResource?.noActiveRepairAttempt === true &&
      input.bugResource?.nextAttemptSequence === response.sequence &&
      response.id !== parentId &&
      response.bugId === bugId &&
      response.mode === request.mode &&
      response.assigneeId === request.assigneeId &&
      sameNullable(response.parentAttemptId, parentId) &&
      sameNullable(response.summary, request.summary ?? null) &&
      response.status === "planned" &&
      response.version === 1 &&
      input.assigneeFact?.accountId === input.accountId &&
      input.assigneeFact?.projectId === projectId &&
      input.assigneeFact?.userId === request.assigneeId &&
      input.assigneeFact?.currentActive === true &&
      input.assigneeFact?.assignable === true &&
      (parentId === null ||
        (input.parentAttemptFact?.accountId === input.accountId &&
          input.parentAttemptFact?.projectId === projectId &&
          input.parentAttemptFact?.bugId === bugId &&
          input.parentAttemptFact?.attemptId === parentId &&
          input.parentAttemptFact?.ancestryExcludesNewAttempt === true &&
          input.parentAttemptFact?.parentCanAcceptChild === true)) &&
      input.effectFact?.fromStatus === "ready" &&
      input.effectFact?.toStatus === "in_progress" &&
      input.effectFact?.bugVersionBefore === request.expectedVersion &&
      input.effectFact?.bugVersionAfter === request.expectedVersion + 1 &&
      input.effectFact?.activeAttemptIdBefore === null &&
      input.effectFact?.activeAttemptIdAfter === response.id &&
      input.effectFact?.resourceVersionBefore === 0 &&
      input.effectFact?.resourceVersionAfter === 1
      ? "unambiguous"
      : "ambiguous";
  }

  if (isAttemptOperation) {
    const current = input.attemptResource?.attempt;
    if (
      input.pathAttemptId !== response.id ||
      input.pathAttemptId !== current?.id ||
      current?.bugId !== bugId ||
      !workflowAttemptScopeMatches(input, current, projectId, bugId) ||
      current.version !== request.expectedVersion ||
      response.version !== request.expectedVersion + 1 ||
      input.bugResource?.accountId !== input.accountId ||
      input.bugResource?.projectId !== projectId ||
      input.bugResource?.bugId !== bugId ||
      input.bugResource?.state !== "in_progress" ||
      input.bugResource?.activeAttemptId !== current.id ||
      input.effectFact?.resourceVersionBefore !== request.expectedVersion ||
      input.effectFact?.resourceVersionAfter !== response.version
    ) {
      return "ambiguous";
    }

    if (operationId === "startRepairAttempt") {
      return current.status === "planned" &&
        response.status === "running" &&
        sameObjectExcept(current, response, ["status", "version"]) &&
        input.bugResource.state === "in_progress" &&
        input.bugResource.activeAttemptId === response.id &&
        input.effectFact?.fromStatus === "planned" &&
        input.effectFact?.toStatus === "running" &&
        input.effectFact?.resourceVersionBefore === request.expectedVersion &&
        input.effectFact?.resourceVersionAfter === response.version &&
        input.effectFact?.bugVersionBefore === input.bugResource.version &&
        input.effectFact?.bugVersionAfter === input.bugResource.version &&
        input.effectFact?.activeAttemptIdAfter === response.id
        ? "unambiguous"
        : "ambiguous";
    }

    if (operationId === "deliverRepairAttempt") {
      const resolvedEvidence = input.deliveryFact?.resolvedEvidence;
      const requirement = input.committedBuildRequirementFact;
      const requirementRecord = requirement?.buildRequirement;
      const requirementKind = requirementRecord?.requirement;
      const deliveredCommitSha = request.deliveryKind === "code" ? response.commitSha : null;
      const requirementValid =
        ["required", "not_required"].includes(requirementKind) &&
        buildRequirementFactMatches(requirement, {
          accountId: input.accountId,
          projectId,
          bugId,
          repairAttemptId: response.id,
          sourceDeliveryVersion: response.version,
          deliveredCommitSha,
          requirement: requirementKind,
          linkedBuildId: null,
          linkId: null,
          bugVersionAtDelivery: input.bugResource.version + 1,
          version: 1,
        }) &&
        input.buildRequirementFact?.accountId === input.accountId &&
        input.buildRequirementFact?.projectId === projectId &&
        input.buildRequirementFact?.bugId === bugId &&
        input.buildRequirementFact?.requirementId === requirementRecord?.id &&
        input.buildRequirementFact?.didNotExistBefore === true &&
        requirement?.deliveryRequestDigest === input.persistedRequestDigest &&
        requirement?.evaluatedFromServerPolicy === true &&
        requirement?.committedWithDelivery === true &&
        requirement?.atomicWithReceipt === true &&
        requirementRecord?.createdAt === requirementRecord?.updatedAt;
      const buildRequirement = requirementValid ? requirementKind : undefined;
      const decisionValidAtDelivery =
        (buildRequirement === "required" &&
          request.deliveryKind === "code" &&
          requirementRecord?.decisionBasis === "code_requires_build" &&
          requirementRecord?.decisionReason === null &&
          requirementRecord?.decisionActorId === input.actorId) ||
        (buildRequirement === "not_required" &&
          request.deliveryKind === "no_code" &&
          requirementRecord?.decisionBasis === "no_code_delivery" &&
          requirementRecord?.decisionReason === request.noCodeReason &&
          requirementRecord?.decisionActorId === input.actorId) ||
        (buildRequirement === "not_required" &&
          request.deliveryKind === "code" &&
          requirementRecord?.decisionBasis === "authorized_no_build_exemption" &&
          requirementRecord?.decisionReason === input.buildExemptionFact?.reason &&
          requirementRecord?.decisionActorId === input.actorId);
      const decisionAuditBoundToDelivery =
        requirementRecord?.decisionAuditEventId === input.effectFact?.auditEventId &&
        requirement?.deliveryDecisionAuditFact?.id === input.effectFact?.auditEventId &&
        requirement?.deliveryDecisionAuditFact?.actorId === input.actorId;
      const expectedBugState =
        buildRequirement === "required"
          ? "awaiting_build"
          : buildRequirement === "not_required"
            ? "ready_for_verification"
            : undefined;
      const codeEvidenceValid =
        request.deliveryKind === "code"
          ? Boolean(
              request.noCodeReason == null &&
                ((typeof request.branch === "string" && typeof request.commitSha === "string") ||
                  typeof request.mergeRequestUrl === "string" ||
                  typeof request.patchUrl === "string") &&
                typeof resolvedEvidence?.branch === "string" &&
                typeof resolvedEvidence?.commitSha === "string" &&
                response.branch === resolvedEvidence.branch &&
                response.commitSha === resolvedEvidence.commitSha &&
                sameNullable(response.mergeRequestUrl, resolvedEvidence.mergeRequestUrl) &&
                (request.branch == null || request.branch === resolvedEvidence.branch) &&
                (request.commitSha == null || request.commitSha === resolvedEvidence.commitSha) &&
                sameNullable(
                  resolvedEvidence.mergeRequestUrl,
                  request.mergeRequestUrl ?? null,
                ) &&
                sameNullable(resolvedEvidence.patchUrl, request.patchUrl ?? null) &&
                resolvedEvidence.noCodeReason === null &&
                input.deliveryFact?.commitEvidenceValidated === true &&
                input.deliveryFact?.resolvedEvidenceCommitted === true,
            )
          : request.deliveryKind === "no_code" &&
            typeof request.noCodeReason === "string" &&
            request.branch == null &&
            request.commitSha == null &&
            request.mergeRequestUrl == null &&
            request.patchUrl == null &&
            response.branch == null &&
            response.commitSha == null &&
            response.mergeRequestUrl == null &&
            response.targetBuildId == null &&
            input.deliveryFact?.noCodeEvidenceValidated === true &&
            input.deliveryFact?.resolvedEvidenceCommitted === true &&
            canonicalString(input.deliveryFact?.resolvedEvidence) ===
              canonicalString({
                branch: null,
                commitSha: null,
                mergeRequestUrl: null,
                patchUrl: null,
                noCodeReason: request.noCodeReason,
              });
      return current.status === "running" &&
        response.status === "delivered" &&
        response.summary === request.summary &&
        sameObjectExcept(current, response, [
          "status",
          "version",
          "summary",
          "branch",
          "commitSha",
          "mergeRequestUrl",
        ]) &&
        codeEvidenceValid &&
        input.deliveryFact?.accountId === input.accountId &&
        input.deliveryFact?.projectId === projectId &&
        input.deliveryFact?.bugId === bugId &&
        input.deliveryFact?.attemptId === response.id &&
        input.deliveryFact?.requestDigest === input.persistedRequestDigest &&
        canonicalString(input.deliveryFact?.request) === canonicalString(request) &&
        requirementValid &&
        decisionValidAtDelivery &&
        decisionAuditBoundToDelivery &&
        (request.deliveryKind !== "no_code" || buildRequirement === "not_required") &&
        (request.deliveryKind !== "code" ||
          buildRequirement === "required" ||
          (buildRequirement === "not_required" &&
            input.buildExemptionFact?.accountId === input.accountId &&
            input.buildExemptionFact?.actorId === input.actorId &&
            input.buildExemptionFact?.projectId === projectId &&
            input.buildExemptionFact?.bugId === bugId &&
            input.buildExemptionFact?.repairAttemptId === response.id &&
            input.buildExemptionFact?.authorizedReleaseOverride === true &&
            typeof input.buildExemptionFact?.reason === "string" &&
            input.buildExemptionFact.reason.length > 0)) &&
        input.bugResource.state === "in_progress" &&
        input.effectFact?.fromStatus === "running" &&
        input.effectFact?.toStatus === "delivered" &&
        input.effectFact?.buildRequirement === buildRequirement &&
        input.effectFact?.buildRequirementId === requirementRecord?.id &&
        input.effectFact?.buildRequirementVersionBefore === 0 &&
        input.effectFact?.buildRequirementVersionAfter === 1 &&
        input.effectFact?.buildRequirementMutationCount === 1 &&
        input.effectFact?.bugStateAfter === expectedBugState &&
        input.effectFact?.bugVersionBefore === input.bugResource.version &&
        input.effectFact?.bugVersionAfter === input.bugResource.version + 1 &&
        input.effectFact?.activeAttemptIdAfter === response.id
        ? "unambiguous"
        : "ambiguous";
    }

    if (operationId === "failRepairAttempt") {
      return new Set(["planned", "queued", "running", "needs_input", "blocked"]).has(
        current.status,
      ) &&
        response.status === "failed" &&
        response.summary === request.reason &&
        sameObjectExcept(current, response, ["status", "version", "summary"]) &&
        input.effectFact?.fromStatus === current.status &&
        input.effectFact?.toStatus === "failed" &&
        input.effectFact?.bugStateAfter === "ready" &&
        input.effectFact?.bugVersionBefore === input.bugResource.version &&
        input.effectFact?.bugVersionAfter === input.bugResource.version + 1 &&
        input.effectFact?.activeAttemptIdBefore === response.id &&
        input.effectFact?.activeAttemptIdAfter === null
        ? "unambiguous"
        : "ambiguous";
    }

    const eligibleCurrentStatus = new Set([
      "planned",
      "queued",
      "running",
      "needs_input",
      "blocked",
    ]).has(current.status);
    const commonSupersedeValid =
      eligibleCurrentStatus &&
      response.status === "superseded" &&
      response.summary === request.reason &&
      sameObjectExcept(current, response, ["status", "version", "summary"]) &&
      input.effectFact?.fromStatus === current.status &&
      input.effectFact?.toStatus === "superseded" &&
      input.effectFact?.supersededAttemptMutationCount === 1 &&
      input.effectFact?.bugVersionBefore === input.bugResource.version &&
      input.effectFact?.bugVersionAfter === input.bugResource.version + 1 &&
      input.effectFact?.activeAttemptIdBefore === current.id;
    if (!commonSupersedeValid) return "ambiguous";

    if (representation === "legacy") {
      return !hasOwn(request, "successor") &&
        input.successorAttemptFact == null &&
        input.successorAssigneeFact == null &&
        input.effectFact?.successorAttemptMutationCount === 0 &&
        input.effectFact?.successorAttemptId === null &&
        input.effectFact?.successorVersionAfter === 0 &&
        input.effectFact?.bugStateAfter === "ready" &&
        input.effectFact?.activeAttemptIdAfter === null &&
        input.committedBugFact?.activeAttemptId === null
        ? "unambiguous"
        : "ambiguous";
    }

    const successorDraft = request.successor;
    const successor = input.successorAttemptFact?.attempt;
    return successorDraft &&
      successorDraft.id !== current.id &&
      input.successorAttemptFact?.accountId === input.accountId &&
      input.successorAttemptFact?.projectId === projectId &&
      input.successorAttemptFact?.bugId === bugId &&
      input.successorAttemptFact?.identityUnusedBefore === true &&
      input.successorAttemptFact?.sequenceUniqueWithinBug === true &&
      input.successorAttemptFact?.createdAtomically === true &&
      input.successorAttemptFact?.atomicWithReceipt === true &&
      input.successorAttemptFact?.onlyActiveAttemptAfter === true &&
      successor?.id === successorDraft.id &&
      successor?.bugId === bugId &&
      successor?.sequence === current.sequence + 1 &&
      input.bugResource?.nextAttemptSequence === successor.sequence &&
      successor?.mode === successorDraft.mode &&
      successor?.assigneeId === successorDraft.assigneeId &&
      sameNullable(successor?.summary, successorDraft.summary ?? null) &&
      successor?.parentAttemptId === current.id &&
      successor?.status === "planned" &&
      successor?.branch === null &&
      successor?.commitSha === null &&
      successor?.mergeRequestUrl === null &&
      successor?.targetBuildId === null &&
      successor?.version === 1 &&
      input.successorAssigneeFact?.accountId === input.accountId &&
      input.successorAssigneeFact?.projectId === projectId &&
      input.successorAssigneeFact?.userId === successorDraft.assigneeId &&
      input.successorAssigneeFact?.currentActive === true &&
      input.successorAssigneeFact?.assignable === true &&
      httpResponse?.eventId === input.effectFact?.auditEventId &&
      httpResponse?.replayed === input.exactReplay &&
      canonicalString(httpResponse?.successorAttempt) === canonicalString(successor) &&
      canonicalString(httpResponse?.bug) === canonicalString(input.committedBugFact?.bug) &&
      input.effectFact?.successorAttemptId === successor.id &&
      input.effectFact?.successorVersionAfter === 1 &&
      input.effectFact?.successorAttemptMutationCount === 1 &&
      input.effectFact?.bugStateAfter === "in_progress" &&
      input.effectFact?.activeAttemptIdAfter === successor.id &&
      input.committedBugFact?.activeAttemptId === successor.id
      ? "unambiguous"
      : "ambiguous";
  }

  if (operationId === "createVerification") {
    const attempt = input.repairAttemptFact?.attempt;
    const build = input.buildFact?.build;
    const requirement = input.buildRequirementFact;
    const requirementRecord = requirement?.buildRequirement;
    const requirementValid =
      ["required", "not_required"].includes(requirementRecord?.requirement) &&
      buildRequirementFactMatches(requirement, {
        accountId: input.accountId,
        projectId,
        bugId,
        repairAttemptId: attempt?.id,
        sourceDeliveryVersion: attempt?.version,
        deliveredCommitSha: attempt?.commitSha ?? null,
        requirement: requirementRecord?.requirement,
        linkedBuildId: requirementRecord?.linkedBuildId ?? null,
        linkId: requirementRecord?.linkId ?? null,
        bugVersionAtDelivery: requirementRecord?.bugVersionAtDelivery,
        version: requirementRecord?.version,
      }) &&
      typeof requirement?.deliveryRequestDigest === "string" &&
      requirement.deliveryRequestDigest.length >= 16 &&
      requirement?.evaluatedFromServerPolicy === true &&
      requirement?.committedWithDelivery === true &&
      requirement?.current === true;
    const relationValid = buildRepairRelationMatches(input.linkRelationFact, {
      accountId: input.accountId,
      projectId,
      bugId,
      attemptId: attempt?.id,
      buildId: request.buildId,
      commitSha: attempt?.commitSha,
      requirementId: requirementRecord?.id,
      requirementVersion: requirementRecord?.version,
    });
    const buildValid =
      request.buildId === null
        ? input.buildFact == null &&
          input.linkRelationFact == null &&
          requirementValid &&
          requirementRecord.requirement === "not_required" &&
          requirementRecord.linkedBuildId === null &&
          requirementRecord.linkId === null &&
          requirementRecord.version === 1
        : requirementValid &&
          requirementRecord.requirement === "required" &&
          requirementRecord.linkedBuildId === request.buildId &&
          requirementRecord.linkId === input.linkRelationFact?.link?.id &&
          requirementRecord.version === 2 &&
          relationValid &&
          input.linkRelationFact?.atomicWithBuildRequirement === true &&
          input.linkRelationFact?.atomicWithBugTransition === true &&
          input.buildFact?.accountId === input.accountId &&
          input.buildFact?.projectId === projectId &&
          build?.id === request.buildId &&
          build?.projectId === projectId &&
          build?.status === "ready" &&
          linkedBuildEvidenceEligible({
            link: input.linkRelationFact?.link,
            build,
            deliveredCommitSha: attempt?.commitSha,
            exactManifestEligible: input.buildFact?.exactDeliveredCommitEligible,
          });
    return input.pathBugId === bugId &&
      input.bugResource?.accountId === input.accountId &&
      input.bugResource?.projectId === projectId &&
      input.bugResource?.bugId === bugId &&
      input.bugResource?.state === "ready_for_verification" &&
      input.bugResource?.version === request.expectedVersion &&
      input.bugResource?.activeVerificationId === null &&
      input.bugResource?.noActiveVerification === true &&
      input.repairAttemptFact?.accountId === input.accountId &&
      input.repairAttemptFact?.projectId === projectId &&
      input.repairAttemptFact?.bugId === bugId &&
      attempt?.id === request.repairAttemptId &&
      attempt?.bugId === bugId &&
      attempt?.status === "delivered" &&
      input.repairAttemptFact?.latestNonSuperseded === true &&
      input.repairAttemptFact?.eligibleForVerification === true &&
      buildValid &&
      input.verifierFact?.accountId === input.accountId &&
      input.verifierFact?.projectId === projectId &&
      input.verifierFact?.userId === request.verifierId &&
      input.verifierFact?.currentActive === true &&
      input.verifierFact?.canVerify === true &&
      input.separationOfDutiesFact?.repairAssigneeId === attempt.assigneeId &&
      input.separationOfDutiesFact?.verifierId === request.verifierId &&
      input.separationOfDutiesFact?.passed === true &&
      response.bugId === bugId &&
      response.repairAttemptId === request.repairAttemptId &&
      sameNullable(response.buildId, request.buildId) &&
      response.verifierId === request.verifierId &&
      response.criteriaSnapshot === request.criteria &&
      response.status === "requested" &&
      response.version === 1 &&
      input.effectFact?.fromStatus === "ready_for_verification" &&
      input.effectFact?.toStatus === "ready_for_verification" &&
      input.effectFact?.bugVersionBefore === request.expectedVersion &&
      input.effectFact?.bugVersionAfter === request.expectedVersion + 1 &&
      input.effectFact?.resourceVersionBefore === 0 &&
      input.effectFact?.resourceVersionAfter === 1 &&
      input.effectFact?.activeVerificationIdAfter === response.id
      ? "unambiguous"
      : "ambiguous";
  }

  const current = input.verificationResource?.verification;
  return input.pathVerificationId === response.id &&
    input.pathVerificationId === current?.id &&
    input.verificationResource?.accountId === input.accountId &&
    input.verificationResource?.projectId === projectId &&
    input.verificationResource?.bugId === bugId &&
    canonicalString(input.verificationResource?.verification) === canonicalString(current) &&
    current?.status === "requested" &&
    current?.version === request.expectedVersion &&
    current?.verifierId === input.actorId &&
    response.status === "in_progress" &&
    response.version === request.expectedVersion + 1 &&
    sameObjectExcept(current, response, ["status", "version"]) &&
    input.bugResource?.accountId === input.accountId &&
    input.bugResource?.projectId === projectId &&
    input.bugResource?.bugId === bugId &&
    input.bugResource?.state === "ready_for_verification" &&
    input.bugResource?.activeVerificationId === current.id &&
    input.effectFact?.fromStatus === "requested" &&
    input.effectFact?.toStatus === "in_progress" &&
    input.effectFact?.resourceVersionBefore === request.expectedVersion &&
    input.effectFact?.resourceVersionAfter === response.version &&
    input.effectFact?.bugVersionBefore === input.bugResource.version &&
    input.effectFact?.bugVersionAfter === input.bugResource.version &&
    input.effectFact?.activeVerificationIdAfter === current.id
    ? "unambiguous"
    : "ambiguous";
}

function buildReceiptScope(input, projectId, buildId) {
  return {
    accountId: input.accountId,
    actorId: input.actorId,
    projectId,
    buildId: buildId ?? null,
  };
}

function evaluateBuildWriteReceipt(input) {
  const { operationId, request } = input;
  if (!request || !["registerBuild", "linkBuildRepair"].includes(operationId)) {
    return "ambiguous";
  }
  const representation = input.representation ?? "vendor";
  const response = input.response;
  const build = operationId === "linkBuildRepair" && representation === "vendor"
    ? response?.build
    : response;
  const projectId = input.pathProjectId ?? input.buildResource?.projectId ?? build?.projectId;
  const pathBuildId = input.pathBuildId ?? null;
  const trustedAttempt = input.exactReplay
    ? input.persistedPreconditionFact?.repairAttemptFact?.attempt
    : input.repairAttemptFact?.attempt;
  const effectBugId = operationId === "registerBuild" ? null : trustedAttempt?.bugId;
  const expectedIdempotencyKey =
    operationId === "registerBuild"
      ? `build:register:project:${input.pathProjectId}:provider:${request.provider}:external:${request.externalId}`
      : `build:link:${input.pathBuildId}:attempt:${request.repairAttemptId}:v${request.expectedVersion}`;
  const expectedStatus = operationId === "registerBuild" ? 201 : 200;
  if (
    !build ||
    !humanWriteAuthorityMatches(input, operationId, projectId) ||
    !atomicWriteEffectMatches(input, operationId, projectId, effectBugId, "build", build.id) ||
    !evaluateNonSecretWriteReceiptInvariant(input, {
      operationId,
      scope: buildReceiptScope(input, projectId, pathBuildId),
      requestForDigest: request,
      expectedIdempotencyKey,
      expectedHttpStatus: expectedStatus,
      response,
      responseHasReplayMarker: operationId === "linkBuildRepair" && representation === "vendor",
    }) ||
    input.committedBuildFact?.accountId !== input.accountId ||
    input.committedBuildFact?.projectId !== projectId ||
    canonicalString(input.committedBuildFact?.build) !== canonicalString(build) ||
    input.effectFact?.verificationMutationCount !== 0 ||
    input.effectFact?.bugClosureMutationCount !== 0 ||
    input.effectFact?.humanAcceptanceMutationCount !== 0 ||
    !authorizedReplaySnapshotMatches(input, {
      operationId,
      actorId: input.actorId,
      projectId,
      bugId: effectBugId,
      resourceType: "build",
      resourceId: build.id,
      responseVersion: build.version,
    })
  ) {
    return "ambiguous";
  }
  if (input.exactReplay) {
    input = { ...input, ...input.persistedPreconditionFact };
  }

  if (operationId === "registerBuild") {
    const manifestDigest = sha256Hex(canonicalString(request.manifest));
    const readyEvidenceValid =
      request.status !== "ready" ||
      (typeof request.manifest?.artifactSha256 === "string" &&
        typeof request.downloadUrl === "string" &&
        input.artifactFact?.accountId === input.accountId &&
        input.artifactFact?.projectId === projectId &&
        input.artifactFact?.buildId === build.id &&
        input.artifactFact?.provider === request.provider &&
        input.artifactFact?.externalId === request.externalId &&
        input.artifactFact?.sourceCommitSha === request.sourceCommitSha &&
        input.artifactFact?.manifestDigest === manifestDigest &&
        input.artifactFact?.sha256 === request.manifest.artifactSha256 &&
        input.artifactFact?.downloadUrl === request.downloadUrl &&
        input.artifactFact?.durablyReadable === true &&
        input.artifactFact?.verified === true);
    return input.pathProjectId === projectId &&
      input.projectFact?.accountId === input.accountId &&
      input.projectFact?.projectId === projectId &&
      input.projectFact?.projectKey === request.projectKey &&
      input.projectFact?.currentActive === true &&
      input.releaseAuthorityFact?.accountId === input.accountId &&
      input.releaseAuthorityFact?.actorId === input.actorId &&
      input.releaseAuthorityFact?.projectId === projectId &&
      input.releaseAuthorityFact?.canRegisterBuild === true &&
      input.providerIdentityFact?.accountId === input.accountId &&
      input.providerIdentityFact?.projectId === projectId &&
      input.providerIdentityFact?.provider === request.provider &&
      input.providerIdentityFact?.externalId === request.externalId &&
      input.providerIdentityFact?.globallyUniqueWithinProject === true &&
      input.providerIdentityFact?.convergesOnBuildId === build.id &&
      build.projectId === projectId &&
      build.provider === request.provider &&
      build.externalId === request.externalId &&
      build.versionName === request.version &&
      build.channel === request.channel &&
      build.projectKey === request.projectKey &&
      build.branch === request.branch &&
      build.sourceCommitSha === request.sourceCommitSha &&
      build.mode === request.mode &&
      build.status === request.status &&
      canonicalString(build.manifest?.commitShas) ===
        canonicalString(request.manifest?.commitShas) &&
      sameNullable(build.manifest?.artifactSha256, request.manifest?.artifactSha256 ?? null) &&
      build.version === 1 &&
      readyEvidenceValid &&
      input.effectFact?.bugMutationCount === 0 &&
      input.effectFact?.buildRequirementMutationCount === 0 &&
      input.effectFact?.resourceVersionBefore === 0 &&
      input.effectFact?.resourceVersionAfter === 1
      ? "unambiguous"
      : "ambiguous";
  }

  const currentBuild = input.buildResource?.build;
  const attempt = input.repairAttemptFact?.attempt;
  const currentBug = input.bugResource?.bug;
  const committedBug = input.committedBugFact?.bug;
  const currentRequirement = input.buildRequirementFact?.buildRequirement;
  const committedRequirement = input.committedBuildRequirementFact?.buildRequirement;
  const currentManifestDigest = sha256Hex(canonicalString(currentBuild?.manifest));
  const evidenceAuthorizedAtLink =
    request.evidenceType === "manifest"
      ? currentBuild?.manifest?.commitShas?.includes(request.deliveredCommitSha) &&
        input.manifestEvidenceFact?.accountId === input.accountId &&
        input.manifestEvidenceFact?.projectId === projectId &&
        input.manifestEvidenceFact?.buildId === currentBuild?.id &&
        input.manifestEvidenceFact?.repairAttemptId === attempt?.id &&
        input.manifestEvidenceFact?.deliveredCommitSha === request.deliveredCommitSha &&
        input.manifestEvidenceFact?.manifestDigest === currentManifestDigest &&
        input.manifestEvidenceFact?.manifestVerified === true
      : request.evidenceType === "release_manager_override" &&
        typeof request.overrideReason === "string" &&
        input.overrideAuthorityFact?.accountId === input.accountId &&
        input.overrideAuthorityFact?.actorId === input.actorId &&
        input.overrideAuthorityFact?.projectId === projectId &&
        input.overrideAuthorityFact?.canOverrideBuildEvidence === true &&
        input.overrideAuthorityFact?.reason === request.overrideReason;
  const link = input.linkRelationFact?.link;
  const vendorCasValid =
    representation !== "vendor" ||
    (request.expectedBugVersion === currentBug?.version &&
      request.expectedBuildRequirementVersion === currentRequirement?.version);
  const legacyCasValid =
    representation !== "legacy" ||
    (input.legacyLinkCasFact?.accountId === input.accountId &&
      input.legacyLinkCasFact?.projectId === projectId &&
      input.legacyLinkCasFact?.bugId === attempt?.bugId &&
      input.legacyLinkCasFact?.repairAttemptId === attempt?.id &&
      input.legacyLinkCasFact?.expectedBugVersion === currentRequirement?.bugVersionAtDelivery &&
      input.legacyLinkCasFact?.expectedBuildRequirementVersion === currentRequirement?.version &&
      input.legacyLinkCasFact?.derivedFromStoredBuildRequirement === true &&
      input.legacyLinkCasFact?.exactCompareAndSwap === true);
  const vendorLinkValid =
    representation !== "vendor" ||
    (response?.repairLink &&
      response?.eventId === input.effectFact?.auditEventId &&
      canonicalString(response.repairLink) === canonicalString(link) &&
      canonicalString(response.bug) === canonicalString(committedBug) &&
      canonicalString(response.buildRequirement) === canonicalString(committedRequirement));
  return input.pathBuildId === build.id &&
    input.pathBuildId === currentBuild?.id &&
    input.buildResource?.accountId === input.accountId &&
    input.buildResource?.projectId === projectId &&
    canonicalString(input.buildResource?.build) === canonicalString(currentBuild) &&
    currentBuild?.status === "ready" &&
    currentBuild?.version === request.expectedVersion &&
    build.version === request.expectedVersion + 1 &&
    sameObjectExcept(currentBuild, build, ["version"]) &&
    input.repairAttemptFact?.accountId === input.accountId &&
    input.repairAttemptFact?.projectId === projectId &&
    input.repairAttemptFact?.bugId === attempt?.bugId &&
    attempt?.id === request.repairAttemptId &&
    attempt?.status === "delivered" &&
    attempt?.commitSha === request.deliveredCommitSha &&
    input.repairAttemptFact?.latestNonSuperseded === true &&
    input.bugResource?.accountId === input.accountId &&
    input.bugResource?.projectId === projectId &&
    input.bugResource?.bugId === attempt.bugId &&
    input.bugResource?.activeAttemptId === attempt.id &&
    currentBug?.id === attempt.bugId &&
    currentBug?.projectId === projectId &&
    currentBug?.state === "awaiting_build" &&
    currentBug?.version === currentRequirement?.bugVersionAtDelivery &&
    vendorCasValid &&
    legacyCasValid &&
    buildRequirementFactMatches(input.buildRequirementFact, {
      accountId: input.accountId,
      projectId,
      bugId: attempt.bugId,
      repairAttemptId: attempt.id,
      sourceDeliveryVersion: attempt.version,
      deliveredCommitSha: request.deliveredCommitSha,
      requirement: "required",
      linkedBuildId: null,
      linkId: null,
      bugVersionAtDelivery: currentBug.version,
      version: 1,
    }) &&
    typeof input.buildRequirementFact?.deliveryRequestDigest === "string" &&
    input.buildRequirementFact.deliveryRequestDigest.length >= 16 &&
    input.buildRequirementFact?.evaluatedFromServerPolicy === true &&
    input.buildRequirementFact?.committedWithDelivery === true &&
    input.buildRequirementFact?.current === true &&
    evidenceAuthorizedAtLink &&
    input.linkRelationFact?.accountId === input.accountId &&
    input.linkRelationFact?.projectId === projectId &&
    link?.buildId === build.id &&
    link?.repairAttemptId === attempt.id &&
    link?.bugId === attempt.bugId &&
    link?.projectId === projectId &&
    link?.deliveredCommitSha === request.deliveredCommitSha &&
    link?.evidenceType === request.evidenceType &&
    link?.evidenceDecision ===
      (request.evidenceType === "manifest"
        ? "manifest_verified"
        : "release_manager_authorized") &&
    sameNullable(link?.overrideReason, request.overrideReason ?? null) &&
    link?.evidenceActorId === input.actorId &&
    link?.evidenceAuditEventId === input.effectFact?.auditEventId &&
    link?.evidencePolicyVersion === "1.0.0" &&
    buildRepairRelationMatches(input.linkRelationFact, {
      accountId: input.accountId,
      projectId,
      bugId: attempt.bugId,
      attemptId: attempt.id,
      buildId: build.id,
      commitSha: request.deliveredCommitSha,
      requirementId: committedRequirement?.id,
      requirementVersion: committedRequirement?.version,
    }) &&
    input.linkRelationFact?.didNotExistBefore === true &&
    input.linkRelationFact?.atomicWithBuildRequirement === true &&
    input.linkRelationFact?.atomicWithBugTransition === true &&
    buildRequirementFactMatches(input.committedBuildRequirementFact, {
      accountId: input.accountId,
      projectId,
      bugId: attempt.bugId,
      repairAttemptId: attempt.id,
      sourceDeliveryVersion: attempt.version,
      deliveredCommitSha: request.deliveredCommitSha,
      requirement: "required",
      linkedBuildId: build.id,
      linkId: link?.id,
      bugVersionAtDelivery: currentBug.version,
      version: currentRequirement.version + 1,
    }) &&
    input.committedBuildRequirementFact?.deliveryRequestDigest ===
      input.buildRequirementFact.deliveryRequestDigest &&
    input.committedBuildRequirementFact?.evaluatedFromServerPolicy === true &&
    input.committedBuildRequirementFact?.committedWithDelivery === true &&
    input.committedBuildRequirementFact?.committed === true &&
    input.committedBuildRequirementFact?.atomicWithLink === true &&
    sameObjectExcept(currentRequirement, committedRequirement, [
      "linkedBuildId",
      "linkId",
      "updatedAt",
      "version",
    ]) &&
    input.committedBugFact?.accountId === input.accountId &&
    input.committedBugFact?.projectId === projectId &&
    input.committedBugFact?.bugId === attempt.bugId &&
    input.committedBugFact?.activeAttemptId === attempt.id &&
    input.committedBugFact?.committed === true &&
    input.committedBugFact?.atomicWithBuildLink === true &&
    committedBug?.id === currentBug.id &&
    committedBug?.projectId === projectId &&
    committedBug?.state === "ready_for_verification" &&
    committedBug?.version === currentBug.version + 1 &&
    committedBug?.reopenCount === currentBug.reopenCount &&
    sameObjectExcept(currentBug, committedBug, ["state", "version", "updatedAt"]) &&
    vendorLinkValid &&
    input.effectFact?.resourceVersionBefore === request.expectedVersion &&
    input.effectFact?.resourceVersionAfter === build.version &&
    input.effectFact?.bugVersionBefore === currentBug.version &&
    input.effectFact?.bugVersionAfter === committedBug.version &&
    input.effectFact?.bugStateBefore === "awaiting_build" &&
    input.effectFact?.bugStateAfter === "ready_for_verification" &&
    input.effectFact?.bugMutationCount === 1 &&
    input.effectFact?.buildRequirementId === currentRequirement.id &&
    input.effectFact?.buildRequirementVersionBefore === currentRequirement.version &&
    input.effectFact?.buildRequirementVersionAfter === committedRequirement.version &&
    input.effectFact?.buildRequirementMutationCount === 1 &&
    input.effectFact?.verificationMutationCount === 0 &&
    input.effectFact?.bugClosureMutationCount === 0 &&
    input.effectFact?.humanAcceptanceMutationCount === 0
    ? "unambiguous"
    : "ambiguous";
}

function evaluateVerificationResultStateInvariant(input, response, representation) {
  const request = input.request;
  const verification = response?.verification;
  const bug = response?.bug;
  if (
    !authorizedReplaySnapshotMatches(input, {
      operationId: "recordVerificationResult",
      actorId: input.authenticatedActorId,
      projectId: input.authorizedProjectId,
      bugId: input.targetQaItemId,
      resourceType: "verification",
      resourceId: input.targetVerificationId,
      responseVersion: verification?.version,
    })
  ) {
    return false;
  }
  if (input.exactReplay) {
    input = { ...input, ...input.persistedPreconditionFact };
  }
  const currentVerification = input.verificationResource?.verification;
  const currentAttempt = input.repairAttemptResource?.attempt;
  const currentBug = input.bugResource?.bug;
  const committedBug = input.committedBugFact?.bug;
  const projectedCommittedBug = structuredClone(committedBug);
  if (representation === "legacy" && projectedCommittedBug) {
    delete projectedCommittedBug.moduleId;
    delete projectedCommittedBug.duplicateOfBugId;
  }
  const committedAttempt =
    representation === "vendor" ? response?.repairAttempt : input.committedRepairAttemptFact?.attempt;
  const expectedAttemptStatus = request.status === "failed" ? "verification_failed" : "delivered";
  const expectedBugState = {
    passed: "closed",
    failed: "ready",
    blocked: "ready_for_verification",
  }[request.status];
  const expectedActiveAttemptIdAfter =
    request.status === "blocked" ? currentAttempt?.id : null;
  const attemptVersionAfter =
    request.status === "failed" ? currentAttempt?.version + 1 : currentAttempt?.version;
  const expectedChangedVersions = {
    bug: [input.bugResource?.version, bug?.version],
    verification: [currentVerification?.version, verification?.version],
    repairAttempt: [currentAttempt?.version, attemptVersionAfter],
  };
  const expectedAuditPayload = {
    status: request.status,
    resultSummary: request.resultSummary,
    failureReason: request.failureReason ?? null,
    blockedReason: request.blockedReason ?? null,
    verificationId: currentVerification?.id,
    repairAttemptId: currentAttempt?.id,
    buildId: currentVerification?.buildId ?? null,
  };
  const buildId = currentVerification?.buildId ?? null;
  const requirement = input.buildRequirementFact;
  const requirementRecord = requirement?.buildRequirement;
  const requirementValid =
    ["required", "not_required"].includes(requirementRecord?.requirement) &&
    buildRequirementFactMatches(requirement, {
      accountId: input.accountId,
      projectId: input.authorizedProjectId,
      bugId: input.targetQaItemId,
      repairAttemptId: currentAttempt?.id,
      sourceDeliveryVersion: currentAttempt?.version,
      deliveredCommitSha: currentAttempt?.commitSha ?? null,
      requirement: requirementRecord?.requirement,
      linkedBuildId: requirementRecord?.linkedBuildId ?? null,
      linkId: requirementRecord?.linkId ?? null,
      bugVersionAtDelivery: requirementRecord?.bugVersionAtDelivery,
      version: requirementRecord?.version,
    }) &&
    typeof requirement?.deliveryRequestDigest === "string" &&
    requirement.deliveryRequestDigest.length >= 16 &&
    requirement?.evaluatedFromServerPolicy === true &&
    requirement?.committedWithDelivery === true &&
    requirement?.current === true;
  const relationValid = buildRepairRelationMatches(input.linkRelationFact, {
    accountId: input.accountId,
    projectId: input.authorizedProjectId,
    bugId: input.targetQaItemId,
    attemptId: currentAttempt?.id,
    buildId,
    commitSha: currentAttempt?.commitSha,
    requirementId: requirementRecord?.id,
    requirementVersion: requirementRecord?.version,
  });
  const resultReasonShapeValid =
    (request.status === "failed") === (typeof request.failureReason === "string") &&
    (request.status === "blocked") === (typeof request.blockedReason === "string");
  const buildValid =
    buildId === null
      ? input.buildResource == null &&
        input.linkRelationFact == null &&
        requirementValid &&
        requirementRecord.requirement === "not_required" &&
        requirementRecord.linkedBuildId === null &&
        requirementRecord.linkId === null &&
        requirementRecord.version === 1
      : requirementValid &&
        requirementRecord.requirement === "required" &&
        requirementRecord.linkedBuildId === buildId &&
        requirementRecord.linkId === input.linkRelationFact?.link?.id &&
        requirementRecord.version === 2 &&
        relationValid &&
        input.linkRelationFact?.atomicWithBuildRequirement === true &&
        input.linkRelationFact?.atomicWithBugTransition === true &&
        input.buildResource?.accountId === input.accountId &&
        input.buildResource?.projectId === input.authorizedProjectId &&
        input.buildResource?.build?.id === buildId &&
        input.buildResource?.build?.projectId === input.authorizedProjectId &&
        input.buildResource?.build?.status === "ready" &&
        linkedBuildEvidenceEligible({
          link: input.linkRelationFact?.link,
          build: input.buildResource?.build,
          deliveredCommitSha: currentAttempt?.commitSha,
          exactManifestEligible: input.buildResource?.exactDeliveredCommitEligible,
        });
  return Boolean(
    resultReasonShapeValid &&
      input.verificationResource?.accountId === input.accountId &&
      input.verificationResource?.projectId === input.authorizedProjectId &&
      input.verificationResource?.bugId === input.targetQaItemId &&
      currentVerification?.id === input.targetVerificationId &&
      currentVerification?.bugId === input.targetQaItemId &&
      currentVerification?.status === "in_progress" &&
      currentVerification?.version === request.expectedVersion &&
      currentVerification?.verifierId === input.authenticatedActorId &&
      verification?.id === currentVerification.id &&
      verification?.bugId === currentVerification.bugId &&
      verification?.repairAttemptId === currentVerification.repairAttemptId &&
      sameNullable(verification?.buildId, currentVerification.buildId) &&
      verification?.verifierId === currentVerification.verifierId &&
      verification?.criteriaSnapshot === currentVerification.criteriaSnapshot &&
      verification?.status === request.status &&
      verification?.resultSummary === request.resultSummary &&
      verification?.version === request.expectedVersion + 1 &&
      input.repairAttemptResource?.accountId === input.accountId &&
      input.repairAttemptResource?.projectId === input.authorizedProjectId &&
      input.repairAttemptResource?.bugId === input.targetQaItemId &&
      currentAttempt?.id === currentVerification.repairAttemptId &&
      currentAttempt?.bugId === input.targetQaItemId &&
      currentAttempt?.status === "delivered" &&
      input.repairAttemptResource?.latestNonSuperseded === true &&
      (representation !== "legacy" ||
        (input.committedRepairAttemptFact?.accountId === input.accountId &&
          input.committedRepairAttemptFact?.projectId === input.authorizedProjectId &&
          input.committedRepairAttemptFact?.bugId === input.targetQaItemId)) &&
      committedAttempt?.id === currentAttempt.id &&
      committedAttempt?.bugId === currentAttempt.bugId &&
      committedAttempt?.status === expectedAttemptStatus &&
      committedAttempt?.version === attemptVersionAfter &&
      sameObjectExcept(currentAttempt, committedAttempt, ["status", "version"]) &&
      input.separationOfDutiesFact?.repairAssigneeId === currentAttempt.assigneeId &&
      input.separationOfDutiesFact?.verifierId === input.authenticatedActorId &&
      input.separationOfDutiesFact?.passed === true &&
      buildValid &&
      input.bugResource?.accountId === input.accountId &&
      input.bugResource?.projectId === input.authorizedProjectId &&
      input.bugResource?.bugId === input.targetQaItemId &&
      input.bugResource?.state === "ready_for_verification" &&
      input.bugResource?.activeVerificationId === currentVerification.id &&
      input.bugResource?.activeAttemptId === currentAttempt.id &&
      currentBug?.id === input.targetQaItemId &&
      currentBug?.projectId === input.authorizedProjectId &&
      currentBug?.state === "ready_for_verification" &&
      currentBug?.version === input.bugResource.version &&
      input.committedBugFact?.accountId === input.accountId &&
      input.committedBugFact?.projectId === input.authorizedProjectId &&
      input.committedBugFact?.bugId === input.targetQaItemId &&
      input.committedBugFact?.committed === true &&
      input.committedBugFact?.atomicWithResult === true &&
      committedBug?.id === input.targetQaItemId &&
      committedBug?.projectId === input.authorizedProjectId &&
      committedBug?.state === expectedBugState &&
      committedBug?.version === input.bugResource.version + 1 &&
      sameObjectExcept(currentBug, committedBug, [
        "state",
        "version",
        "updatedAt",
        "closedAt",
        "reopenCount",
      ]) &&
      committedBug?.reopenCount === currentBug.reopenCount &&
      (representation === "vendor"
        ? canonicalString(bug) === canonicalString(committedBug)
        : canonicalString(bug) === canonicalString(projectedCommittedBug)) &&
      bug?.id === input.targetQaItemId &&
      bug?.projectId === input.authorizedProjectId &&
      bug?.state === expectedBugState &&
      bug?.version === input.bugResource.version + 1 &&
      (request.status !== "passed" || bug.closedAt != null) &&
      (request.status === "passed" || bug.closedAt == null) &&
      input.verificationFact?.accountId === input.accountId &&
      input.verificationFact?.projectId === input.authorizedProjectId &&
      input.verificationFact?.verificationId === input.targetVerificationId &&
      canonicalString(input.verificationFact?.response) === canonicalString(verification) &&
      input.eventFact?.id === input.multiAggregateEffectFact?.auditEventId &&
      input.eventFact?.accountId === input.accountId &&
      input.eventFact?.projectId === input.authorizedProjectId &&
      input.eventFact?.bugId === input.targetQaItemId &&
      input.eventFact?.actorId === input.authenticatedActorId &&
      input.eventFact?.type === "verification.result_recorded" &&
      input.eventFact?.source === "qa_hub" &&
      input.eventFact?.actorType === "user" &&
      input.eventFact?.resourceType === "verification" &&
      input.eventFact?.resourceId === currentVerification.id &&
      input.eventFact?.resourceVersionAfter === verification.version &&
      input.eventFact?.fromStatus === "in_progress" &&
      input.eventFact?.toStatus === request.status &&
      input.eventFact?.resultSummary === request.resultSummary &&
      input.eventFact?.requestDigest === input.persistedRequestDigest &&
      canonicalString(input.eventFact?.changedVersions) ===
        canonicalString(expectedChangedVersions) &&
      canonicalString(input.eventFact?.payload) === canonicalString(expectedAuditPayload) &&
      input.eventFact?.typedRelationsValidated === true &&
      input.eventFact?.committed === true &&
      input.eventFact?.verificationId === currentVerification.id &&
      input.eventFact?.repairAttemptId === currentAttempt.id &&
      sameNullable(input.eventFact?.buildId, buildId) &&
      input.eventFact?.status === request.status &&
      sameNullable(input.eventFact?.failureReason, request.failureReason ?? null) &&
      sameNullable(input.eventFact?.blockedReason, request.blockedReason ?? null) &&
      (representation !== "vendor" || response.eventId === input.eventFact.id) &&
      input.multiAggregateEffectFact?.operationId === "recordVerificationResult" &&
      input.multiAggregateEffectFact?.accountId === input.accountId &&
      input.multiAggregateEffectFact?.actorId === input.authenticatedActorId &&
      input.multiAggregateEffectFact?.projectId === input.authorizedProjectId &&
      input.multiAggregateEffectFact?.bugId === input.targetQaItemId &&
      canonicalString(input.multiAggregateEffectFact?.changedVersions) ===
        canonicalString(expectedChangedVersions) &&
      input.multiAggregateEffectFact?.domainMutationCommitted === true &&
      input.multiAggregateEffectFact?.auditEventCommitted === true &&
      input.multiAggregateEffectFact?.auditEventCount === 1 &&
      input.multiAggregateEffectFact?.notificationOutboxCommitted === true &&
      isUniqueArray(input.multiAggregateEffectFact?.notificationMessageIds) &&
      input.multiAggregateEffectFact.notificationMessageIds.length > 0 &&
      input.notificationOutboxFact?.accountId === input.accountId &&
      input.notificationOutboxFact?.projectId === input.authorizedProjectId &&
      input.notificationOutboxFact?.bugId === input.targetQaItemId &&
      input.notificationOutboxFact?.sourceOperationId === "recordVerificationResult" &&
      input.notificationOutboxFact?.eventId === input.eventFact.id &&
      canonicalString(input.notificationOutboxFact?.messageIds) ===
        canonicalString(input.multiAggregateEffectFact.notificationMessageIds) &&
      input.notificationOutboxFact?.recipientsEvaluated === true &&
      input.notificationOutboxFact?.messagesCommitted === true &&
      input.notificationOutboxFact?.atomicWithSubmission === true &&
      input.multiAggregateEffectFact?.idempotencyRecordCommitted === true &&
      input.multiAggregateEffectFact?.atomicWithReceipt === true &&
      input.multiAggregateEffectFact?.humanResultAuthority === true &&
      input.multiAggregateEffectFact?.machineAcceptanceMutationCount === 0 &&
      input.multiAggregateEffectFact?.activeVerificationIdBefore === currentVerification.id &&
      input.multiAggregateEffectFact?.activeVerificationIdAfter === null &&
      input.multiAggregateEffectFact?.activeAttemptIdBefore === currentAttempt.id &&
      input.multiAggregateEffectFact?.activeAttemptIdAfter === expectedActiveAttemptIdAfter,
  );
}

function evaluateVerificationResultWriteReceipt(input) {
  const representation = input.representation ?? "legacy";
  const response = input.response;
  if (!input.request || !response || !["legacy", "vendor"].includes(representation)) {
    return "ambiguous";
  }
  if (
    !humanWriteAuthorityMatches(
      {
        ...input,
        actorId: input.authenticatedActorId,
        authorizedProjectIds: [input.authorizedProjectId],
      },
      "recordVerificationResult",
      input.authorizedProjectId,
    )
  ) {
    return "ambiguous";
  }
  const expectedIdempotencyKey =
    `workflow:recordVerificationResult:verification:${input.targetVerificationId}` +
    `:v${input.request.expectedVersion}`;
  if (
    !evaluateNonSecretWriteReceiptInvariant(input, {
      operationId: "recordVerificationResult",
      scope: {
        accountId: input.accountId,
        actorId: input.authenticatedActorId,
        projectId: input.authorizedProjectId,
        targetQaItemId: input.targetQaItemId,
        targetVerificationId: input.targetVerificationId,
      },
      requestForDigest: input.request,
      expectedIdempotencyKey,
      expectedHttpStatus: 200,
      response,
      responseHasReplayMarker: representation === "vendor",
    }) ||
    !evaluateVerificationResultStateInvariant(input, response, representation)
  ) {
    return "ambiguous";
  }
  return "unambiguous";
}

function evaluateSubmissionReceipt(input) {
  const { request, response } = input;
  if (!request || !response) return "ambiguous";
  if (
    ["create", "append"].includes(input.operation) &&
    !isNativeOccurrenceEnvironment(request.occurrence?.environment, {
      allowAbsent: true,
      allowNull: false,
    })
  ) {
    return "ambiguous";
  }
  if (request.clientSubmissionId !== response.clientSubmissionId) return "ambiguous";
  if (!sameExactStringSet(request.attachmentIds ?? [], response.attachmentIds ?? [])) {
    return "ambiguous";
  }
  if ((request.captureBundleId ?? null) !== (response.captureBundleId ?? null)) {
    return "ambiguous";
  }

  const expectedIntent = {
    create: "bug_create",
    append: "occurrence_append",
    comment: "comment_append",
    verification: "verification_result",
  }[input.operation];
  const responseProjectId =
    response.bug?.projectId ?? response.projectId ?? response.comment?.projectId;
  const responseBugId =
    response.bug?.id ?? response.bugId ?? response.comment?.bugId ?? response.verification?.bugId;
  const occurrenceBuildId =
    ["create", "append"].includes(input.operation)
      ? request.occurrence?.environment?.buildId ?? null
      : null;
  const occurrenceBuildReferenceValid =
    occurrenceBuildId === null
      ? input.occurrenceBuildFact == null
      : input.occurrenceBuildFact?.accountId === input.accountId &&
        input.occurrenceBuildFact?.projectId === input.authorizedProjectId &&
        input.occurrenceBuildFact?.bugId === responseBugId &&
        input.occurrenceBuildFact?.buildId === occurrenceBuildId &&
        input.occurrenceBuildFact?.relationValidated === true;
  const reservationTargetQaItemId =
    input.operation === "create" ? null : input.targetQaItemId;
  const operationId = {
    create: "createBug",
    append: "addOccurrence",
    comment: "addBugComment",
    verification: "recordVerificationResult",
  }[input.operation];
  const submissionScope = {
    accountId: input.accountId,
    actorId: input.authenticatedActorId,
    projectId: input.authorizedProjectId,
    targetQaItemId: reservationTargetQaItemId,
    targetVerificationId:
      input.operation === "verification" ? input.targetVerificationId : null,
  };
  const expectedIdempotencyKey =
    input.operation === "verification"
      ? `workflow:recordVerificationResult:verification:${input.targetVerificationId}:v${request.expectedVersion}`
      : `submission:${request.clientSubmissionId}:commit`;
  const expectedHttpStatus = {
    create: 201,
    append: 201,
    comment: 201,
    verification: 200,
  }[input.operation];
  const captureId = request.captureBundleId ?? null;
  if (
    !operationId ||
    !evaluateNonSecretWriteReceiptInvariant(input, {
      operationId,
      scope: submissionScope,
      requestForDigest: request,
      expectedIdempotencyKey,
      expectedHttpStatus,
      response,
    }) ||
    input.submissionEffectFact?.operationId !== operationId ||
    input.submissionEffectFact?.accountId !== input.accountId ||
    input.submissionEffectFact?.actorId !== input.authenticatedActorId ||
    input.submissionEffectFact?.projectId !== input.authorizedProjectId ||
    input.submissionEffectFact?.clientSubmissionId !== request.clientSubmissionId ||
    input.submissionEffectFact?.bugId !== responseBugId ||
    input.submissionEffectFact?.eventId !== response.eventId ||
    !sameExactStringSet(
      input.submissionEffectFact?.attachmentIds ?? [],
      request.attachmentIds ?? [],
    ) ||
    !sameNullable(input.submissionEffectFact?.captureId, captureId) ||
    input.submissionEffectFact?.businessEntitiesCommitted !== true ||
    input.submissionEffectFact?.attachmentClaimsCommitted !== true ||
    input.submissionEffectFact?.auditEventCommitted !== true ||
    !occurrenceBuildReferenceValid ||
    input.notificationOutboxFact?.accountId !== input.accountId ||
    input.notificationOutboxFact?.projectId !== input.authorizedProjectId ||
    input.notificationOutboxFact?.bugId !== responseBugId ||
    input.notificationOutboxFact?.eventId !== response.eventId ||
    input.notificationOutboxFact?.sourceOperationId !== operationId ||
    input.notificationOutboxFact?.recipientsEvaluated !== true ||
    input.notificationOutboxFact?.messagesCommitted !== true ||
    input.notificationOutboxFact?.atomicWithSubmission !== true ||
    !isUniqueArray(input.notificationOutboxFact?.messageIds) ||
    (captureId !== null &&
      (input.captureFact?.captureId !== captureId ||
        input.captureFact?.accountId !== input.accountId ||
        input.captureFact?.actorId !== input.authenticatedActorId ||
        input.captureFact?.projectId !== input.authorizedProjectId ||
        input.captureFact?.clientSubmissionId !== request.clientSubmissionId ||
        input.captureFact?.durablyPersisted !== true ||
        !sameExactStringSet(
          input.captureFact?.attachmentIds ?? [],
          request.attachmentIds ?? [],
        ))) ||
    (captureId === null && input.captureFact != null) ||
    !Array.isArray(input.claimedAttachmentFacts) ||
    input.claimedAttachmentFacts.length !== (request.attachmentIds ?? []).length ||
    new Set(input.claimedAttachmentFacts.map((fact) => fact.attachmentId)).size !==
      input.claimedAttachmentFacts.length ||
    input.claimedAttachmentFacts.some(
      (fact) =>
        !(request.attachmentIds ?? []).includes(fact.attachmentId) ||
        fact.accountId !== input.accountId ||
        fact.actorId !== input.authenticatedActorId ||
        fact.projectId !== input.authorizedProjectId ||
        fact.clientSubmissionId !== request.clientSubmissionId ||
        !sameNullable(fact.captureId, captureId) ||
        fact.scanStatus !== "clean" ||
        fact.bindingStatus !== "claimed" ||
        fact.durablyReadable !== true ||
        fact.claimIntent !== expectedIntent ||
        !sameNullable(fact.reservationTargetQaItemId, reservationTargetQaItemId) ||
        fact.claimedQaItemId !== responseBugId,
    )
  ) {
    return "ambiguous";
  }

  const expectedEventType = {
    create: "bug.created",
    append: "occurrence.appended",
    comment: "comment.added",
    verification: "verification.result_recorded",
  }[input.operation];
  if (
    typeof input.accountId !== "string" ||
    input.accountId.length === 0 ||
    responseProjectId !== input.authorizedProjectId ||
    !input.eventFact ||
    input.eventFact.id !== response.eventId ||
    input.eventFact.accountId !== input.accountId ||
    input.eventFact.projectId !== input.authorizedProjectId ||
    input.eventFact.bugId !== responseBugId ||
    input.eventFact.actorId !== input.authenticatedActorId ||
    input.eventFact.clientSubmissionId !== request.clientSubmissionId ||
    input.eventFact.type !== expectedEventType
  ) {
    return "ambiguous";
  }
  if (input.exactReplay) {
    if (response.replayed !== true) return "ambiguous";
    if (input.operation !== "verification") return "unambiguous";
    return humanWriteAuthorityMatches(
      {
        ...input,
        actorId: input.authenticatedActorId,
        authorizedProjectIds: [input.authorizedProjectId],
      },
      "recordVerificationResult",
      input.authorizedProjectId,
    ) && evaluateVerificationResultStateInvariant(input, response, "vendor")
      ? "unambiguous"
      : "ambiguous";
  }
  if (response.replayed !== false) return "ambiguous";

  if (input.operation === "create") {
    return evaluateQaItemIdentity({ operation: "create", response }) === "unambiguous" &&
      request.projectId === response.bug?.projectId &&
      request.projectId === input.authorizedProjectId &&
      (request.moduleId ?? null) === response.bug?.moduleId &&
      (!request.moduleId ||
        (input.moduleFact?.id === request.moduleId &&
          input.moduleFact.projectId === input.authorizedProjectId &&
          input.moduleFact.active === true)) &&
      response.bug?.reporterId === input.authenticatedActorId &&
      input.createdBugFact?.accountId === input.accountId &&
      input.createdBugFact?.projectId === input.authorizedProjectId &&
      input.createdBugFact?.bugId === response.bug?.id &&
      canonicalString(input.createdBugFact?.bug) === canonicalString(response.bug) &&
      input.occurrenceFact?.id === response.occurrenceId &&
      input.occurrenceFact?.bugId === response.bug?.id &&
      input.occurrenceFact?.projectId === input.authorizedProjectId &&
      input.occurrenceFact?.clientSubmissionId === request.clientSubmissionId &&
      canonicalString(input.occurrenceFact?.occurrence) === canonicalString(request.occurrence) &&
      response.disposition === "created" &&
      response.bug?.version === 1 &&
      request.title === response.bug?.title &&
      request.description === response.bug?.description &&
      request.expectedBehavior === response.bug?.expectedBehavior &&
      request.severity === response.bug?.severity &&
      request.priority === response.bug?.priority
      ? "unambiguous"
      : "ambiguous";
  }

  if (input.operation === "append") {
    return evaluateQaItemIdentity({
      operation: "append",
      targetQaItemId: input.targetQaItemId,
      targetQaItemKey: input.targetQaItemKey,
      response,
    }) === "unambiguous" &&
      response.disposition === "appended" &&
      input.bugResource?.accountId === input.accountId &&
      input.bugResource?.projectId === input.authorizedProjectId &&
      input.bugResource?.bugId === input.targetQaItemId &&
      input.bugResource?.version === request.expectedVersion &&
      response.bugVersion === request.expectedVersion + 1 &&
      input.occurrenceFact?.id === response.occurrenceId &&
      input.occurrenceFact?.bugId === input.targetQaItemId &&
      input.occurrenceFact?.projectId === input.authorizedProjectId &&
      input.occurrenceFact?.clientSubmissionId === request.clientSubmissionId &&
      canonicalString(input.occurrenceFact?.occurrence) === canonicalString(request.occurrence)
      ? "unambiguous"
      : "ambiguous";
  }

  if (input.operation === "comment") {
    return evaluateQaItemIdentity({
      operation: "comment",
      targetQaItemId: input.targetQaItemId,
      targetQaItemKey: input.targetQaItemKey,
      response,
    }) === "unambiguous" &&
      input.bugResource?.accountId === input.accountId &&
      input.bugResource?.projectId === input.authorizedProjectId &&
      input.bugResource?.bugId === input.targetQaItemId &&
      input.bugResource?.version === request.expectedVersion &&
      response.bugVersion === request.expectedVersion + 1 &&
      response.comment?.projectId === input.authorizedProjectId &&
      response.comment?.authorId === input.authenticatedActorId &&
      response.comment?.body === request.body &&
      sameExactStringSet(response.comment?.attachmentIds ?? [], response.attachmentIds ?? []) &&
      input.commentFact?.accountId === input.accountId &&
      canonicalString(input.commentFact?.comment) === canonicalString(response.comment)
      ? "unambiguous"
      : "ambiguous";
  }

  if (input.operation === "verification") {
    return evaluateQaItemIdentity({
      operation: "verification",
      targetQaItemId: input.targetQaItemId,
      targetQaItemKey: input.targetQaItemKey,
      targetVerificationId: input.targetVerificationId,
      response,
    }) === "unambiguous" &&
      humanWriteAuthorityMatches(
        {
          ...input,
          actorId: input.authenticatedActorId,
          authorizedProjectIds: [input.authorizedProjectId],
        },
        "recordVerificationResult",
        input.authorizedProjectId,
      ) &&
      evaluateVerificationResultStateInvariant(input, response, "vendor") &&
      (input.eventFact.failureReason ?? null) === (request.failureReason ?? null) &&
      (input.eventFact.blockedReason ?? null) === (request.blockedReason ?? null)
      ? "unambiguous"
      : "ambiguous";
  }
  return "ambiguous";
}

function evaluateRelayReceipt(input) {
  if (
    [
      input.currentAttemptId,
      input.currentHandoffId,
      input.currentRelayInstanceId,
      input.currentBugId,
      input.currentProjectId,
    ].some((value) => typeof value !== "string" || value.length === 0) ||
    input.incomingAttemptId !== input.currentAttemptId ||
    input.incomingHandoffId !== input.currentHandoffId ||
    input.incomingRelayInstanceId !== input.currentRelayInstanceId
  ) {
    return "NOT_FOUND";
  }
  if (!relayProjectionStates.has(input.proposedStatus)) {
    return "INTEGRATION_AUTOMATION_FORBIDDEN";
  }
  if (
    typeof input.currentVerificationStatus !== "string" ||
    input.proposedVerificationStatus !== input.currentVerificationStatus ||
    typeof input.currentBugState !== "string" ||
    input.proposedBugState !== input.currentBugState
  ) {
    return "INTEGRATION_AUTOMATION_FORBIDDEN";
  }
  if (input.incomingRevision < input.currentRevision) return "stale_ignored";
  if (input.incomingRevision === input.currentRevision) {
    return input.incomingPayloadHash === input.currentPayloadHash
      ? "replay"
      : "INTEGRATION_EVENT_CONFLICT";
  }
  const deliveredStates = new Set(["fix_delivered", "awaiting_build", "awaiting_verification"]);
  if (deliveredStates.has(input.proposedStatus) && !/^[0-9a-f]{40}$/.test(input.deliveredCommitSha ?? "")) {
    return "RELAY_DELIVERY_EVIDENCE_INVALID";
  }
  if (input.buildRequirement === "not_required") {
    if (input.buildEvidenceStatus !== "not_required" || input.buildId !== null) {
      return "BUILD_IDENTITY_MISMATCH";
    }
  } else if (input.buildRequirement === "required") {
    if (!new Set(["pending", "exact_commit_eligible"]).has(input.buildEvidenceStatus)) {
      return "BUILD_IDENTITY_MISMATCH";
    }
    if (input.buildEvidenceStatus === "exact_commit_eligible" && typeof input.buildId !== "string") {
      return "BUILD_IDENTITY_MISMATCH";
    }
    if (input.buildEvidenceStatus === "exact_commit_eligible") {
      const build = input.buildFact;
      if (
        !build ||
        [build.buildId, build.attemptId, build.bugId, build.projectId].some(
          (value) => typeof value !== "string" || value.length === 0,
        ) ||
        build.buildId !== input.buildId ||
        build.attemptId !== input.currentAttemptId ||
        build.bugId !== input.currentBugId ||
        build.projectId !== input.currentProjectId ||
        build.status !== "ready" ||
        build.sourceCommitSha !== input.deliveredCommitSha ||
        !Array.isArray(build.manifestCommitShas) ||
        !build.manifestCommitShas.includes(input.deliveredCommitSha)
      ) {
        return "BUILD_IDENTITY_MISMATCH";
      }
    }
  } else {
    return "BUILD_IDENTITY_MISMATCH";
  }
  if (
    input.proposedStatus === "awaiting_build" &&
    (input.buildRequirement !== "required" || input.buildEvidenceStatus !== "pending")
  ) {
    return "BUILD_IDENTITY_MISMATCH";
  }
  if (
    input.proposedStatus === "awaiting_verification" &&
    !(
      (input.buildRequirement === "not_required" && input.buildEvidenceStatus === "not_required") ||
      (input.buildRequirement === "required" &&
        input.buildEvidenceStatus === "exact_commit_eligible" &&
        typeof input.buildId === "string")
    )
  ) {
    return "BUILD_IDENTITY_MISMATCH";
  }
  return "projection_only";
}

export function evaluateAppFirstBehavior(kind, input) {
  switch (kind) {
    case "stage-key":
      return canonicalStageKey(input);
    case "key-mapping":
      return input.suppliedKey === canonicalStageKey(input)
        ? "accepted"
        : "CLIENT_SUBMISSION_ID_MISMATCH";
    case "idempotency":
      if (input.authorizationResult !== "allowed") {
        return ["NOT_FOUND", "FORBIDDEN"].includes(input.authorizationResult)
          ? input.authorizationResult
          : "NOT_FOUND";
      }
      if (
        ["AccountId", "ActorId", "OperationId", "IdempotencyKey"].some(
          (field) =>
            typeof input[`existing${field}`] !== "string" ||
            input[`existing${field}`].length === 0 ||
            input[`existing${field}`] !== input[`incoming${field}`],
        )
      ) {
        return "NOT_FOUND";
      }
      if (input.existingOperationId === "createPushSubscription") {
        if (
          typeof input.existingSubscriptionEndpointDigest !== "string" ||
          input.existingSubscriptionEndpointDigest.length === 0 ||
          input.existingSubscriptionEndpointDigest !== input.incomingSubscriptionEndpointDigest
        ) {
          return "NOT_FOUND";
        }
      } else if (
        typeof input.existingProjectId !== "string" ||
        input.existingProjectId.length === 0 ||
        input.existingProjectId !== input.incomingProjectId
      ) {
        return "NOT_FOUND";
      }
      return input.existingHash === input.incomingHash
        ? "replay"
        : "IDEMPOTENCY_PAYLOAD_MISMATCH";
    case "auth-idempotency":
      if (!input.credentialValidated) return input.authenticationError;
      if (input.existingScope !== input.incomingScope) return input.authenticationError;
      return input.existingHash === input.incomingHash
        ? "encrypted_secret_replay"
        : "IDEMPOTENCY_PAYLOAD_MISMATCH";
    case "refresh-idempotency":
      return evaluateRefresh(input);
    case "native-session-receipt":
      return evaluateNativeSessionReceipt(input);
    case "native-session-resource":
      return nativeSessionIdentityMatches(
        input.session,
        input.principal,
        input.principal?.sharedDevice,
      )
        ? "valid"
        : "invalid";
    case "native-account-partition":
      if (input.currentAccountId == null) return "initialize_account_partition";
      return input.currentAccountId === input.receivedAccountId
        ? "retain_account_partition"
        : "clear_partition_and_reauthenticate";
    case "submission-dedupe":
      if (
        input.existingAccountId !== input.incomingAccountId ||
        input.existingActorId !== input.incomingActorId ||
        input.existingProjectId !== input.incomingProjectId
      ) {
        return "NOT_FOUND";
      }
      return input.existingPayloadHash === input.incomingPayloadHash
        ? "replay"
        : "IDEMPOTENCY_PAYLOAD_MISMATCH";
    case "pipeline-replay":
      return evaluatePipeline(input);
    case "pipeline-trace":
      return evaluatePipelineTrace(input);
    case "atomic-attachment-commit":
      return evaluateAtomicAttachmentCommit(input);
    case "resource-scope":
      if (input.actorAccountId !== input.resourceAccountId) return "NOT_FOUND";
      if (!input.actorProjectIds.includes(input.resourceProjectId)) return "NOT_FOUND";
      return input.hasRequiredRole ? "allowed" : "FORBIDDEN";
    case "evidence-resource-tuple":
      return evaluateEvidenceResourceTuple(input);
    case "attachment-reservation":
      if (
        input.actorAccountId !== input.reservation.accountId ||
        input.actorId !== input.reservation.actorId ||
        input.projectId !== input.reservation.projectId ||
        (input.pathAttachmentId && input.pathAttachmentId !== input.reservation.attachmentId)
      ) {
        return "NOT_FOUND";
      }
      if (
        input.clientSubmissionId !== input.reservation.clientSubmissionId ||
        input.clientAttachmentId !== input.reservation.clientAttachmentId ||
        input.intent !== input.reservation.intent ||
        (input.targetQaItemId ?? null) !== (input.reservation.targetQaItemId ?? null)
      ) {
        return "ATTACHMENT_BINDING_CONFLICT";
      }
      if (input.reservation.status === "claimed") return "replay_claim";
      if (input.reservation.status !== "reserved") return "ATTACHMENT_BINDING_CONFLICT";
      {
        const serverNow = toEpoch(input.serverNow);
        const reservedAt = toEpoch(input.reservation.reservedAt);
        const expiresAt = toEpoch(input.reservation.expiresAt);
        return serverNow !== undefined &&
          reservedAt !== undefined &&
          expiresAt !== undefined &&
          reservedAt < expiresAt &&
          serverNow >= reservedAt &&
          serverNow < expiresAt
          ? "claim"
          : "ATTACHMENT_BINDING_CONFLICT";
      }
    case "qa-item-identity":
      return evaluateQaItemIdentity(input);
    case "submission-receipt":
      return evaluateSubmissionReceipt(input);
    case "workflow-write-receipt":
      return evaluateWorkflowWriteReceipt(input);
    case "build-write-receipt":
      return evaluateBuildWriteReceipt(input);
    case "verification-result-write-receipt":
      return evaluateVerificationResultWriteReceipt(input);
    case "occurrence-environment":
      return isNativeOccurrenceEnvironment(input.environment, {
        allowAbsent: input.allowAbsent ?? false,
        allowNull: input.allowNull ?? false,
      })
        ? "valid"
        : "invalid";
    case "upload-receipt":
      return evaluateUploadReceipt(input);
    case "enrichment-status":
      return deriveEnrichmentStatus(input);
    case "capture-consistency":
      return evaluateCapture(input);
    case "capture-receipt":
      return evaluateCaptureReceipt(input);
    case "attachment-download-receipt":
      return evaluateAttachmentDownloadReceipt(input);
    case "poco-correlation":
      return evaluatePocoCorrelation(input);
    case "notification-registration":
      return evaluateNotificationRegistration(input);
    case "notification-registration-receipt":
      return evaluateNotificationRegistrationReceipt(input);
    case "notification-revoke":
      return evaluateNotificationRevoke(input);
    case "notification-revoke-receipt":
      return evaluateNotificationRevokeReceipt(input);
    case "native-session-revoke":
      return evaluateNativeSessionRevoke(input);
    case "notification-inbox":
      return evaluateNotificationInbox(input);
    case "machine-action":
      return allowedMachineProjectionActions.has(input.action)
        ? "allowed"
        : "INTEGRATION_AUTOMATION_FORBIDDEN";
    case "relay-dispatch":
      return input.outboxCommitted && !input.relayAcknowledged
        ? "queued_not_accepted"
        : "invalid_receipt";
    case "relay-projection":
      return evaluateRelayReceipt(input);
    case "relay-receipt-identity":
      return evaluateRelayReceiptIdentity(input);
    case "bug-operation-receipt":
      return evaluateBugOperationReceipt(input);
    case "duplicate-candidates-receipt":
      return evaluateDuplicateCandidatesReceipt(input);
    case "read-model-receipt":
      return evaluateReadModelReceipt(input);
    case "audit-payload":
      return isNativeAuditPayload(input.payload) ? "valid" : "invalid";
    case "audit-list-receipt":
      return evaluateAuditListReceipt(input);
    case "audit-stream-receipt":
      return evaluateAuditStreamReceipt(input);
    case "cursor-scope":
      return input.cursorAccountId === input.accountId &&
        input.cursorActorId === input.actorId &&
        input.cursorProjectId === input.projectId &&
        input.cursorResourceId === input.resourceId &&
        input.cursorFilterHash === input.filterHash &&
        (!hasOwn(input, "cursorSnapshotSequence") ||
          input.cursorSnapshotSequence === input.snapshotSequence)
        ? "page"
        : "INVALID_REQUEST";
    case "content-negotiation":
      if (
        Array.isArray(input.advertisedMediaTypes) &&
        Array.isArray(input.requestedMediaTypes)
      ) {
        if (!isUniqueArray(input.advertisedMediaTypes) || !isUniqueArray(input.requestedMediaTypes)) {
          return input.direction === "request" ? "UNSUPPORTED_MEDIA_TYPE" : "NOT_ACCEPTABLE";
        }
        if (input.direction === "request") {
          return input.requestedMediaTypes.length === 1 &&
            input.advertisedMediaTypes.includes(input.requestedMediaTypes[0])
            ? input.requestedMediaTypes[0]
            : "UNSUPPORTED_MEDIA_TYPE";
        }
        const selected = input.requestedMediaTypes.find((mediaType) =>
          input.advertisedMediaTypes.includes(mediaType),
        );
        return selected ?? "NOT_ACCEPTABLE";
      }
      if (input.direction === "request") {
        return input.contentTypeVendorSupported && input.operationAdvertisesVendor
          ? "vendor"
          : input.contentTypeJson && input.operationAcceptsJson
            ? "application_json"
            : "UNSUPPORTED_MEDIA_TYPE";
      }
      return input.acceptsVendor && input.operationAdvertisesVendor
        ? "vendor"
        : input.acceptsJson && input.operationAcceptsJson
          ? "application_json"
          : "NOT_ACCEPTABLE";
    case "shared-device-session":
      return input.revoked &&
        input.oldAccessRejected &&
        input.oldRefreshRejected &&
        input.notificationDeviceRevoked &&
        input.newActorCannotResumeOldQueue
        ? "cleared"
        : "isolation_failure";
    default:
      throw new Error(`Unknown App-first contract behavior: ${kind}`);
  }
}
