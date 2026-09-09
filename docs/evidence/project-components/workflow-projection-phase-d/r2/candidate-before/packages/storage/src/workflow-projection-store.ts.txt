import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  encodeWorkflowCursor,
  parseWorkflowCursor,
  verifyWorkflowCursor,
} from "./workflow-projection-cursor.js";
import {
  WORKFLOW_COLLECTIONS,
  WorkflowProjectionError,
  type BugWorkflowProjection,
  type GetBugWorkflowProjectionInput,
  type WorkflowCollection,
  type WorkflowDto,
  type WorkflowProjectionOptions,
  type WorkflowWatermarks,
} from "./workflow-projection-types.js";

type Row = Record<string, SQLInputValue>;
type Item = { collection: WorkflowCollection; sortKey: string; dto: WorkflowDto };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function invalid(): never {
  throw new WorkflowProjectionError("INVALID_REQUEST", "Invalid workflow query or cursor");
}
function corrupt(): never {
  throw new WorkflowProjectionError("INTERNAL_ERROR", "Workflow projection facts are inconsistent");
}
function capacity(): never {
  throw new WorkflowProjectionError("RATE_LIMITED", "Workflow snapshot capacity exceeded");
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return corrupt();
  return value as Record<string, unknown>;
};
function json(value: SQLInputValue | undefined): unknown {
  if (typeof value !== "string") return corrupt();
  try {
    return JSON.parse(value);
  } catch {
    return corrupt();
  }
}
const pick = (row: Row, fields: Record<string, string>): WorkflowDto =>
  Object.fromEntries(
    Object.entries(fields).map(([key, column]) => {
      if (row[column] === undefined) corrupt();
      return [key, row[column]];
    }),
  );

function authorize(
  database: DatabaseSync,
  input: GetBugWorkflowProjectionInput,
): { bug: Row; membershipDigest: string } {
  const { accountId, projectId, actorId, bugId } = input;
  const actor = database
    .prepare(
      `SELECT actor.version AS actor_version, project.version AS project_version
    FROM accounts AS account JOIN users AS actor ON actor.account_id=account.id AND actor.id=? AND actor.status='active'
    JOIN projects AS project ON project.account_id=account.id AND project.id=? AND project.status='active'
    WHERE account.id=? AND account.status='active' AND EXISTS (SELECT 1 FROM command_project_memberships AS member
      WHERE member.account_id=account.id AND member.project_id=project.id AND member.user_id=actor.id AND member.status='active')`,
    )
    .get(actorId, projectId, accountId);
  if (!actor)
    throw new WorkflowProjectionError("FORBIDDEN", "Workflow requires active project access");
  const bug = database
    .prepare(
      `SELECT id,key,version FROM bugs WHERE account_id=? AND project_id=? AND id=?
    AND NOT EXISTS (SELECT 1 FROM bug_deletions WHERE account_id=? AND project_id=? AND bug_id=?)`,
    )
    .get(accountId, projectId, bugId, accountId, projectId, bugId) as Row | undefined;
  if (!bug) throw new WorkflowProjectionError("NOT_FOUND", "Workflow Bug was not found");
  // Include all actor memberships, including disabled rows, to detect revoke/restore cycles.
  // The virtual GM row exists only inside the trusted worker's command transaction.
  const memberships = database
    .prepare(
      `SELECT id,project_id,status,version FROM command_project_memberships
    WHERE account_id=? AND user_id=? ORDER BY project_id,id`,
    )
    .all(accountId, actorId);
  return { bug, membershipDigest: hash({ actor, memberships }) };
}

/** Read only typed same-Bug facts; invalid relationships abort instead of disappearing from pages. */
function collect(
  database: DatabaseSync,
  input: GetBugWorkflowProjectionInput,
  maxItems: number,
  maxBytes: number,
): Item[] {
  const { accountId, projectId, bugId } = input;
  const scope = [accountId, projectId, bugId];
  const rows = (table: string) =>
    database
      .prepare(
        `SELECT * FROM ${table} WHERE account_id=? AND project_id=? AND bug_id=? ORDER BY id`,
      )
      .all(...scope) as Row[];
  let rawCount = 0;
  for (const table of [
    "occurrences",
    "repair_attempts",
    "verifications",
    "relay_receipts",
    "build_repair_links",
  ]) {
    rawCount += Number(
      database
        .prepare(
          `SELECT count(*) AS count FROM ${table} WHERE account_id=? AND project_id=? AND bug_id=?`,
        )
        .get(...scope)!.count,
    );
    if (rawCount > maxItems) capacity();
  }
  const user = (id: SQLInputValue | undefined) => {
    if (
      typeof id !== "string" ||
      !database.prepare("SELECT 1 FROM users WHERE account_id=? AND id=?").get(accountId, id)
    )
      corrupt();
  };
  const related = (table: string, id: SQLInputValue | undefined, requireBug = false): Row => {
    if (typeof id !== "string") return corrupt();
    const row = database
      .prepare(
        `SELECT * FROM ${table} WHERE account_id=? AND project_id=? AND id=?${requireBug ? " AND bug_id=?" : ""}`,
      )
      .get(accountId, projectId, id, ...(requireBug ? [bugId] : [])) as Row | undefined;
    return row ?? corrupt();
  };
  const items: Item[] = [];
  let byteCount = 0;
  const add = (collection: WorkflowCollection, id: SQLInputValue | undefined, dto: WorkflowDto) => {
    if (typeof id !== "string" || !UUID.test(id)) corrupt();
    byteCount += Buffer.byteLength(JSON.stringify(dto));
    if (items.length >= maxItems || byteCount > maxBytes) capacity();
    items.push({ collection, sortKey: id as string, dto });
  };
  const buildIds = new Set<string>();
  const build = (id: SQLInputValue | undefined) => {
    if (id === null) return;
    const row = related("builds", id);
    buildIds.add(String(row.id));
  };
  const exactBuildLink = (attemptId: SQLInputValue, buildId: SQLInputValue, requirement: Row) => {
    if (
      requirement.requirement !== "required" ||
      requirement.linked_build_id !== buildId ||
      !database
        .prepare(
          `SELECT 1 FROM build_repair_links WHERE account_id=? AND project_id=? AND bug_id=? AND repair_attempt_id=? AND build_id=? AND build_requirement_id=? AND build_requirement_version=? AND delivered_commit_sha=?`,
        )
        .get(
          ...scope,
          attemptId,
          buildId,
          requirement.id!,
          requirement.version!,
          requirement.delivered_commit_sha!,
        )
    )
      corrupt();
  };
  for (const row of rows("occurrences")) {
    user(row.reporter_id);
    let environment: Record<string, unknown> | null = null;
    if (row.environment_json !== null) {
      const raw = object(json(row.environment_json));
      const allowed = [
        "qaAppVersion",
        "testSessionId",
        "buildId",
        "networkType",
        "networkMetered",
        "orientation",
      ];
      if (Object.keys(raw).some((key) => !allowed.includes(key))) corrupt();
      environment = { ...raw };
      if (raw.buildId != null) build(raw.buildId as SQLInputValue);
    }
    if (row.capture_bundle_id !== null) {
      const capture = related("capture_bundles", row.capture_bundle_id);
      if (capture.actor_id !== row.reporter_id) corrupt();
    }
    const attachmentRows = database
      .prepare(
        `SELECT * FROM occurrence_attachments
      WHERE account_id=? AND project_id=? AND occurrence_id=? ORDER BY attachment_id`,
      )
      .all(accountId, projectId, row.id!) as Row[];
    if (attachmentRows.length > 20) corrupt();
    for (const attachment of attachmentRows) {
      related("attachments", attachment.attachment_id);
      const binding = related("attachment_bindings", attachment.binding_id);
      if (
        binding.attachment_id !== attachment.attachment_id ||
        binding.target_bug_id !== bugId ||
        binding.state !== "claimed"
      )
        corrupt();
    }
    const steps = json(row.steps_json);
    if (
      !Array.isArray(steps) ||
      steps.length < 1 ||
      steps.length > 50 ||
      steps.some((x) => typeof x !== "string" || !x.length || x.length > 1000)
    )
      corrupt();
    add("occurrences", row.id, {
      ...pick(row, {
        id: "id",
        bugId: "bug_id",
        reporterId: "reporter_id",
        observedAt: "observed_at",
        platform: "platform",
        appVersion: "app_version",
        resourceVersion: "resource_version",
        gitSha: "git_sha",
        deviceModel: "device_model",
        osVersion: "os_version",
        actualBehavior: "actual_behavior",
        frequency: "frequency",
        errorSignature: "error_signature",
        captureBundleId: "capture_bundle_id",
        createdAt: "created_at",
      }),
      steps,
      environment,
      attachmentIds: attachmentRows.map((x) => x.attachment_id),
    });
  }
  for (const row of rows("repair_attempts")) {
    user(row.assignee_id);
    if (row.parent_attempt_id !== null) related("repair_attempts", row.parent_attempt_id, true);
    build(row.target_build_id);
    add(
      "repairAttempts",
      row.id,
      pick(row, {
        id: "id",
        bugId: "bug_id",
        sequence: "sequence",
        mode: "mode",
        status: "status",
        assigneeId: "assignee_id",
        parentAttemptId: "parent_attempt_id",
        summary: "summary",
        branch: "branch",
        commitSha: "commit_sha",
        mergeRequestUrl: "merge_request_url",
        targetBuildId: "target_build_id",
        version: "version",
      }),
    );
  }
  for (const row of rows("verifications")) {
    user(row.verifier_id);
    related("repair_attempts", row.repair_attempt_id, true);
    const requirement = database
      .prepare(
        `SELECT * FROM build_requirements WHERE account_id=? AND project_id=? AND bug_id=? AND repair_attempt_id=?`,
      )
      .get(...scope, row.repair_attempt_id!) as Row | undefined;
    if (!requirement) corrupt();
    if (row.build_id === null) {
      if (requirement!.requirement !== "not_required" || requirement!.linked_build_id !== null)
        corrupt();
    } else {
      build(row.build_id);
      exactBuildLink(row.repair_attempt_id!, row.build_id!, requirement!);
    }
    add(
      "verifications",
      row.id,
      pick(row, {
        id: "id",
        bugId: "bug_id",
        repairAttemptId: "repair_attempt_id",
        buildId: "build_id",
        status: "status",
        verifierId: "verifier_id",
        criteriaSnapshot: "criteria_snapshot",
        resultSummary: "result_summary",
        version: "version",
      }),
    );
  }
  for (const row of rows("relay_receipts")) {
    const attempt = related("repair_attempts", row.repair_attempt_id, true);
    const integration = related("integration_links", row.integration_link_id);
    const metadata = object(json(integration.metadata_json));
    if (
      attempt.mode !== "relay" ||
      integration.integration_type !== "relay" ||
      integration.local_resource_type !== "repair_attempt" ||
      integration.local_resource_id !== row.repair_attempt_id ||
      integration.external_resource_type !== "relay_handoff" ||
      integration.external_resource_id !== row.handoff_id ||
      metadata.relayInstanceId !== row.relay_instance_id
    )
      corrupt();
    build(row.build_id);
    if (row.build_id !== null) {
      const requirement = database
        .prepare(
          "SELECT * FROM build_requirements WHERE account_id=? AND project_id=? AND bug_id=? AND repair_attempt_id=?",
        )
        .get(...scope, row.repair_attempt_id!) as Row | undefined;
      if (!requirement || requirement.delivered_commit_sha !== row.delivered_commit_sha) corrupt();
      exactBuildLink(row.repair_attempt_id!, row.build_id!, requirement!);
    }
    const bug = related("bugs", bugId);
    add("relayReceipts", row.id, {
      ...pick(row, {
        repairAttemptId: "repair_attempt_id",
        handoffId: "handoff_id",
        relayInstanceId: "relay_instance_id",
        relayTaskId: "relay_task_id",
        handoffStatus: "handoff_status",
        buildRequirement: "build_requirement",
        buildEvidenceStatus: "build_evidence_status",
        deliveredCommitSha: "delivered_commit_sha",
        buildId: "build_id",
        externalRevision: "external_revision",
        lastEventAt: "last_event_at",
        failureSummary: "failure_summary",
        version: "version",
      }),
      qaItem: { type: "bug", id: bugId, key: bug.key },
      requiresHumanVerification: true,
      automationAuthority: "delivery_build_projection_only",
    });
  }
  for (const link of rows("build_repair_links")) {
    related("repair_attempts", link.repair_attempt_id, true);
    const requirement = related("build_requirements", link.build_requirement_id, true);
    if (
      requirement.repair_attempt_id !== link.repair_attempt_id ||
      requirement.linked_build_id !== link.build_id ||
      requirement.version !== link.build_requirement_version ||
      requirement.delivered_commit_sha !== link.delivered_commit_sha
    )
      corrupt();
    build(link.build_id);
  }
  for (const id of [...buildIds].sort()) {
    const row = related("builds", id);
    const commits = database
      .prepare(
        `SELECT commit_sha FROM build_manifest_commits WHERE account_id=? AND project_id=? AND build_id=? ORDER BY ordinal`,
      )
      .all(accountId, projectId, id)
      .map((x) => x.commit_sha);
    const raw = object(json(row.manifest_json));
    if (
      !commits.length ||
      commits.some((commit) => typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit)) ||
      new Set(commits).size !== commits.length
    )
      corrupt();
    // Typed normalized commit rows are authoritative, including historical provider manifests.
    // When a provider supplied the normalized field, it must agree exactly.
    if (raw.commitShas !== undefined && JSON.stringify(raw.commitShas) !== JSON.stringify(commits))
      corrupt();
    // download_url and arbitrary provider manifest fields are deliberately never projected.
    const manifest: Record<string, unknown> = { commitShas: commits };
    if (raw.artifactSha256 !== undefined) {
      if (raw.artifactSha256 !== row.artifact_sha256) corrupt();
      manifest.artifactSha256 = raw.artifactSha256;
    }
    add("builds", id, {
      ...pick(row, {
        id: "id",
        projectId: "project_id",
        provider: "provider",
        externalId: "external_id",
        versionName: "version_name",
        channel: "channel",
        projectKey: "project_key",
        branch: "branch",
        sourceCommitSha: "source_commit_sha",
        mode: "mode",
        status: "status",
        version: "version",
      }),
      manifest,
    });
  }
  return items;
}

/** Caller owns one transaction, including trusted GM authorization and snapshot persistence. */
export function getBugWorkflowProjection(
  database: DatabaseSync,
  input: GetBugWorkflowProjectionInput,
  options: WorkflowProjectionOptions = {},
): BugWorkflowProjection {
  if (!database.isTransaction)
    throw new WorkflowProjectionError(
      "SQLITE_TRANSACTION_REQUIRED",
      "Workflow projection requires a transaction",
    );
  for (const id of [input.accountId, input.projectId, input.actorId, input.bugId])
    if (typeof id !== "string" || !UUID.test(id)) invalid();
  const limit = input.limitPerCollection ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
  const now = (options.now ?? (() => new Date()))().getTime();
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const maxItems = options.maxItemsPerSnapshot ?? 10_000;
  const maxBytes = options.maxBytesPerSnapshot ?? 64 * 1024 * 1024;
  const maxActive = options.maxActiveSnapshotsPerActor ?? 64;
  const maxRetained = options.maxRetainedSnapshotsPerActor ?? 1024;
  const maxRetainedBytes = options.maxRetainedBytesPerActor ?? 256 * 1024 * 1024;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(now + ttlMs) ||
    [ttlMs, maxItems, maxBytes, maxActive, maxRetained, maxRetainedBytes].some(
      (x) => !Number.isSafeInteger(x) || x < 1,
    )
  )
    corrupt();
  const auth = authorize(database, input);
  const filterDigest = hash({ limitPerCollection: limit });
  let snapshot: Row;
  let watermarks: WorkflowWatermarks;
  if (input.cursor !== undefined) {
    const ref = parseWorkflowCursor(input.cursor);
    const found = database
      .prepare("SELECT * FROM workflow_projection_snapshots WHERE id=?")
      .get(ref.snapshotId) as Row | undefined;
    if (
      !found ||
      found.account_id !== input.accountId ||
      found.project_id !== input.projectId ||
      found.actor_id !== input.actorId ||
      found.bug_id !== input.bugId ||
      found.membership_digest !== auth.membershipDigest ||
      found.filter_digest !== filterDigest ||
      Number(found.expires_at) <= now
    )
      invalid();
    if (!(found.signing_key instanceof Uint8Array)) corrupt();
    verifyWorkflowCursor(input.cursor, found.signing_key as Uint8Array);
    const page = database
      .prepare(
        "SELECT watermarks_json FROM workflow_projection_cursors WHERE id=? AND snapshot_id=?",
      )
      .get(ref.cursorId, ref.snapshotId);
    if (!page) invalid();
    watermarks = object(json(page.watermarks_json)) as unknown as WorkflowWatermarks;
    if (
      Object.keys(watermarks).length !== WORKFLOW_COLLECTIONS.length ||
      Object.keys(watermarks).some(
        (key) => !WORKFLOW_COLLECTIONS.includes(key as WorkflowCollection),
      )
    )
      corrupt();
    snapshot = found;
  } else {
    const active = Number(
      database
        .prepare(
          "SELECT count(*) AS count FROM workflow_projection_snapshots WHERE account_id=? AND actor_id=? AND expires_at>?",
        )
        .get(input.accountId, input.actorId, now)!.count,
    );
    if (active >= maxActive) capacity();
    const retained = database
      .prepare(
        "SELECT count(*) AS count, coalesce(sum(byte_count),0) AS bytes FROM workflow_projection_snapshots WHERE account_id=? AND actor_id=?",
      )
      .get(input.accountId, input.actorId)!;
    if (Number(retained.count) >= maxRetained) capacity();
    const items = collect(database, input, maxItems, maxBytes);
    if (
      Number(retained.bytes) +
        items.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x.dto)), 0) >
      maxRetainedBytes
    )
      capacity();
    const id = randomUUID();
    const sequence = Number(
      database
        .prepare(
          "SELECT coalesce(max(event_position),0) AS sequence FROM events WHERE account_id=? AND project_id=?",
        )
        .get(input.accountId, input.projectId)!.sequence,
    );
    database
      .prepare(
        `INSERT INTO workflow_projection_snapshots(id,account_id,project_id,actor_id,bug_id,membership_digest,filter_digest,bug_version,snapshot_sequence,limit_per_collection,signing_key,created_at,expires_at,item_count,byte_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.accountId,
        input.projectId,
        input.actorId,
        input.bugId,
        auth.membershipDigest,
        filterDigest,
        auth.bug.version!,
        sequence,
        limit,
        randomBytes(32),
        now,
        now + ttlMs,
        items.length,
        items.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x.dto)), 0),
      );
    const insert = database.prepare(
      "INSERT INTO workflow_projection_items(snapshot_id,collection,sort_key,dto_json) VALUES(?,?,?,?)",
    );
    for (const item of items)
      insert.run(id, item.collection, item.sortKey, JSON.stringify(item.dto));
    snapshot = database
      .prepare("SELECT * FROM workflow_projection_snapshots WHERE id=?")
      .get(id) as Row;
    watermarks = Object.fromEntries(
      WORKFLOW_COLLECTIONS.map((collection) => [collection, { lastSortKey: null, hasMore: true }]),
    ) as unknown as WorkflowWatermarks;
  }
  const collections: Partial<Record<WorkflowCollection, WorkflowDto[]>> = {};
  const next: Record<string, { lastSortKey: string | null; hasMore: boolean }> = {};
  for (const collection of WORKFLOW_COLLECTIONS) {
    const mark = watermarks[collection];
    if (
      !mark ||
      Object.keys(mark).length !== 2 ||
      typeof mark.hasMore !== "boolean" ||
      (mark.lastSortKey !== null &&
        (typeof mark.lastSortKey !== "string" || !UUID.test(mark.lastSortKey)))
    )
      corrupt();
    const page = mark.hasMore
      ? database
          .prepare(
            `SELECT sort_key,dto_json FROM workflow_projection_items WHERE snapshot_id=? AND collection=? AND sort_key>? ORDER BY sort_key LIMIT ?`,
          )
          .all(snapshot.id!, collection, mark.lastSortKey ?? "", limit + 1)
      : [];
    const selected = page.slice(0, limit);
    collections[collection] = selected.map((row) => object(json(row.dto_json)));
    next[collection] = {
      lastSortKey: selected.length ? String(selected.at(-1)!.sort_key) : mark.lastSortKey,
      hasMore: page.length > limit,
    };
  }
  const truncated = Object.values(next).some((mark) => mark.hasMore);
  let nextCursor: string | null = null;
  if (truncated) {
    const encoded = JSON.stringify(next);
    const old = database
      .prepare(
        "SELECT id FROM workflow_projection_cursors WHERE snapshot_id=? AND watermarks_json=?",
      )
      .get(snapshot.id!, encoded);
    const cursorId = old ? String(old.id) : randomUUID();
    if (!old)
      database
        .prepare(
          "INSERT INTO workflow_projection_cursors(id,snapshot_id,watermarks_json) VALUES(?,?,?)",
        )
        .run(cursorId, snapshot.id!, encoded);
    nextCursor = encodeWorkflowCursor(
      { snapshotId: String(snapshot.id), cursorId },
      snapshot.signing_key as Uint8Array,
    );
  }
  return {
    bugId: input.bugId,
    bugVersion: Number(snapshot.bug_version),
    snapshotSequence: Number(snapshot.snapshot_sequence),
    truncated,
    nextCursor,
    ...(collections as Record<WorkflowCollection, WorkflowDto[]>),
  };
}
