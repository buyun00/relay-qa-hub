import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import { MobileRelayStorageError, type MobileRelayScope } from "./mobile-relay-store.js";
import type { MobileBugRecord } from "./mobile-bug-store.js";
import {
  canonicalNullableProjectUserId,
  canonicalProjectUserId,
} from "./project-identity-projection.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const BUG_STATES = [
  "reported",
  "needs_info",
  "ready",
  "in_progress",
  "awaiting_build",
  "ready_for_verification",
  "closed",
  "deferred",
  "rejected",
  "duplicate",
] as const;

export type MobileBugListState = (typeof BUG_STATES)[number];

export type MobileBugListSort = "updated_desc" | "created_desc" | "priority_desc";

export interface ListMobileBugsInput extends Omit<MobileRelayScope, "projectId"> {
  /** Optional public project filter. Omit it to list every currently authorized project. */
  readonly projectId?: string;
  /**
   * Project used only to authenticate the current request capability. API callers always
   * provide it; direct legacy callers may omit it and use projectId for both purposes.
   */
  readonly authorizationProjectId?: string;
  readonly ownerId?: string;
  readonly verificationOwnerId?: string;
  readonly ownerState?: "assigned" | "unassigned";
  readonly q?: string;
  readonly state?: readonly MobileBugListState[];
  readonly reporterId?: string;
  readonly moduleId?: string;
  readonly severity?: MobileBugRecord["severity"];
  readonly priority?: MobileBugRecord["priority"];
  readonly updatedAfter?: string;
  readonly sort?: MobileBugListSort;
  readonly cursor?: string;
  readonly limit: number;
}

export interface MobileBugList {
  readonly snapshotSequence: number;
  readonly items: readonly MobileBugRecord[];
  readonly nextCursor: string | null;
}

interface MobileBugListRow {
  readonly id: string;
  readonly project_id: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly expected_behavior: string;
  readonly module_id: string | null;
  readonly state: MobileBugRecord["state"];
  readonly severity: MobileBugRecord["severity"];
  readonly priority: MobileBugRecord["priority"];
  readonly reporter_id: string;
  readonly owner_id: string | null;
  readonly verification_owner_id: string | null;
  readonly duplicate_of_bug_id: string | null;
  readonly occurrence_count: number;
  readonly reopen_count: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", `${field} must be a UUID`);
  }
}

function requireLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "limit must be an integer from 1 through 500",
    );
  }
}

function requireStates(value: readonly MobileBugListState[] | undefined): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length < 1 ||
      value.length > 12 ||
      value.some((state) => !(BUG_STATES as readonly string[]).includes(state)))
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "state is invalid");
  }
}

function requireQuery(value: string | undefined): void {
  if (value !== undefined && (value.length < 1 || value.length > 200 || value !== value.trim())) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "q is invalid");
  }
}

function requireSeverity(value: MobileBugRecord["severity"] | undefined): void {
  if (value !== undefined && !["S0", "S1", "S2", "S3", "S4"].includes(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "severity is invalid");
  }
}

function requirePriority(value: MobileBugRecord["priority"] | undefined): void {
  if (value !== undefined && !["P0", "P1", "P2", "P3", "P4"].includes(value)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "priority is invalid");
  }
}

function normalizeUpdatedAfter(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "updatedAfter is invalid");
  }
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart!.split("-").map(Number);
  const [hour, minute, second] = timePart!.slice(0, 8).split(":").map(Number);
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  if (
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month! - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "updatedAfter is invalid");
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeFilters(input: ListMobileBugsInput): NormalizedBugListFilters {
  const state = Object.freeze([...new Set(input.state ?? [])].sort() as MobileBugListState[]);
  const sort = input.sort ?? "updated_desc";
  if (!(["updated_desc", "created_desc", "priority_desc"] as const).includes(sort)) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "sort is invalid");
  }
  return Object.freeze({
    projectId: input.projectId ?? null,
    ownerId: input.ownerId ?? null,
    verificationOwnerId: input.verificationOwnerId ?? null,
    ownerState: input.ownerState ?? null,
    q: input.q ?? null,
    state,
    reporterId: input.reporterId ?? null,
    moduleId: input.moduleId ?? null,
    severity: input.severity ?? null,
    priority: input.priority ?? null,
    updatedAfter: normalizeUpdatedAfter(input.updatedAfter),
    sort,
  });
}

interface MobileBugListCursorPosition {
  readonly primary: string | number;
  readonly secondary: string | null;
  readonly number: number;
  readonly id: string;
}

interface MobileBugListCursor extends MobileBugListCursorPosition {
  readonly authorizationDigest: string;
  readonly filterDigest: string;
  readonly snapshotSequence: number;
}

const CURSOR_PREFIX = "b1";
const CURSOR_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CURSOR_TOKEN_PATTERN = /^b1\.[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/u;
const BUG_LIST_CURSOR_KEYS = new Set([
  "v",
  "authorizationDigest",
  "filterDigest",
  "snapshotSequence",
  "primary",
  "secondary",
  "number",
  "id",
]);
const BUG_LIST_RESPONSE_PAGE_LIMIT = 100;
const PRIORITY_RANK_SQL =
  "CASE bugs.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 WHEN 'P4' THEN 4 END";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface NormalizedBugListFilters {
  readonly projectId: string | null;
  readonly ownerId: string | null;
  readonly verificationOwnerId: string | null;
  readonly ownerState: "assigned" | "unassigned" | null;
  readonly q: string | null;
  readonly state: readonly MobileBugListState[];
  readonly reporterId: string | null;
  readonly moduleId: string | null;
  readonly severity: MobileBugRecord["severity"] | null;
  readonly priority: MobileBugRecord["priority"] | null;
  readonly updatedAfter: string | null;
  readonly sort: MobileBugListSort;
}

interface BugListAuthorizationSnapshot {
  readonly digest: string;
  readonly isGm: boolean;
  readonly snapshotSequence: number;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function filterDigest(filters: NormalizedBugListFilters): string {
  return hash(filters);
}

function authorizationProjectId(input: ListMobileBugsInput): string {
  const projectId = input.authorizationProjectId ?? input.projectId;
  if (projectId === undefined) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "an authorization project is required for the Bug list",
    );
  }
  requireUuid(projectId, "authorizationProjectId");
  return projectId;
}

function authorizationSnapshot(
  database: DatabaseSync,
  input: ListMobileBugsInput,
): BugListAuthorizationSnapshot {
  const requestProjectId = authorizationProjectId(input);
  const principal = database
    .prepare(
      `SELECT account.id AS account_id, account.version AS account_version,
              actor.id AS actor_id, actor.version AS actor_version
       FROM accounts AS account
       JOIN users AS actor
         ON actor.account_id = account.id
        AND actor.id = ?
        AND actor.status = 'active'
       JOIN projects AS project
         ON project.account_id = account.id
        AND project.id = ?
        AND project.status = 'active'
       WHERE account.id = ?
         AND account.status = 'active'
         AND EXISTS (
           SELECT 1
           FROM command_project_memberships AS membership
           WHERE membership.account_id = account.id
             AND membership.project_id = project.id
             AND membership.user_id = actor.id
             AND membership.status = 'active'
         )`,
    )
    .get(input.actorId, requestProjectId, input.accountId) as
    Readonly<Record<string, SQLInputValue>> | undefined;
  if (!principal) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }

  const isGm =
    database
      .prepare(
        `SELECT 1 AS present
         FROM storage_command_authorizations
         WHERE account_id = ? AND project_id = ? AND actor_id = ?`,
      )
      .get(input.accountId, requestProjectId, input.actorId) !== undefined;

  // Retain disabled rows and project versions so revoke/restore and archive/restore cycles
  // invalidate every cursor minted against the prior authorized-project snapshot.
  const memberships = database
    .prepare(
      `SELECT membership.id, membership.project_id, membership.status, membership.version,
              project.status AS project_status, project.version AS project_version
       FROM command_project_memberships AS membership
       JOIN projects AS project
         ON project.account_id = membership.account_id
        AND project.id = membership.project_id
       WHERE membership.account_id = ? AND membership.user_id = ?
       ORDER BY membership.project_id, membership.id`,
    )
    .all(input.accountId, input.actorId);
  const projects = isGm
    ? database
        .prepare(
          `SELECT id, status, version
           FROM projects
           WHERE account_id = ?
           ORDER BY id`,
        )
        .all(input.accountId)
    : memberships.map((membership) => ({
        id: membership.project_id,
        status: membership.project_status,
        version: membership.project_version,
      }));
  const authorizedProjectIds = projects
    .filter((project, index, rows) => {
      if (project.status !== "active") return false;
      if (isGm) return true;
      const membership = memberships.find(
        (candidate) => candidate.project_id === project.id && candidate.status === "active",
      );
      return (
        membership !== undefined &&
        rows.findIndex((candidate) => candidate.id === project.id) === index
      );
    })
    .map((project) => String(project.id));
  if (input.projectId !== undefined && !authorizedProjectIds.includes(input.projectId)) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }
  if (authorizedProjectIds.length === 0) {
    throw new MobileRelayStorageError("FORBIDDEN", "actor has no active project membership");
  }
  const projectPlaceholders = authorizedProjectIds.map(() => "?").join(", ");
  const identityLinks = database
    .prepare(
      `SELECT id, project_id, source_user_id, canonical_user_id, status, version
       FROM project_identity_links
       WHERE account_id = ? AND project_id IN (${projectPlaceholders})
       ORDER BY project_id, id`,
    )
    .all(input.accountId, ...authorizedProjectIds);

  const snapshot = database
    .prepare(
      `SELECT COALESCE(MAX(event_position), 0) AS snapshot_sequence
       FROM events
       WHERE account_id = ? AND project_id IN (${projectPlaceholders})`,
    )
    .get(input.accountId, ...authorizedProjectIds) as { readonly snapshot_sequence: number };
  if (!Number.isSafeInteger(snapshot.snapshot_sequence) || snapshot.snapshot_sequence < 0) {
    throw new Error("Bug list snapshot sequence is invalid");
  }

  return {
    digest: hash({
      principal,
      isGm,
      projects,
      memberships: isGm ? [] : memberships,
      identityLinks,
    }),
    isGm,
    snapshotSequence: snapshot.snapshot_sequence,
  };
}

function requireCursorSigningKey(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("Bug list cursor signing key must contain exactly 32 bytes");
  }
}

function invalidCursor(): never {
  throw new MobileRelayStorageError("INVALID_REQUEST", "cursor is invalid for this Bug list");
}

function decodeCursor(
  input: ListMobileBugsInput,
  filters: NormalizedBugListFilters,
  signingKey: Uint8Array,
  expectedAuthorizationDigest: string,
  expectedSnapshotSequence: number,
): MobileBugListCursorPosition | null {
  if (input.cursor === undefined) return null;
  if (input.cursor.length > 500 || !CURSOR_TOKEN_PATTERN.test(input.cursor)) invalidCursor();
  const [, encoded, signature] = input.cursor.split(".");
  if (encoded === undefined || signature === undefined) invalidCursor();
  const expectedSignature = createHmac("sha256", signingKey)
    .update(`${CURSOR_PREFIX}.${encoded}`)
    .digest();
  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(signature, "base64url");
  } catch {
    invalidCursor();
  }
  if (
    receivedSignature.toString("base64url") !== signature ||
    receivedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    invalidCursor();
  }
  let decoded: unknown;
  let decodedText: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) invalidCursor();
    decodedText = UTF8_DECODER.decode(bytes);
    decoded = JSON.parse(decodedText);
  } catch {
    invalidCursor();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) invalidCursor();
  const value = decoded as Record<string, unknown>;
  const primaryIsValid =
    filters.sort === "priority_desc"
      ? Number.isSafeInteger(value["primary"]) &&
        (value["primary"] as number) >= 0 &&
        (value["primary"] as number) <= 4
      : typeof value["primary"] === "string" &&
        value["primary"].length <= 64 &&
        Number.isFinite(Date.parse(value["primary"]));
  const secondaryIsValid =
    filters.sort === "priority_desc"
      ? typeof value["secondary"] === "string" &&
        value["secondary"].length <= 64 &&
        Number.isFinite(Date.parse(value["secondary"]))
      : value["secondary"] === null;
  if (
    Object.keys(value).length !== BUG_LIST_CURSOR_KEYS.size ||
    Object.keys(value).some((key) => !BUG_LIST_CURSOR_KEYS.has(key)) ||
    value["v"] !== 1 ||
    value["authorizationDigest"] !== expectedAuthorizationDigest ||
    value["filterDigest"] !== filterDigest(filters) ||
    value["snapshotSequence"] !== expectedSnapshotSequence ||
    !CURSOR_DIGEST_PATTERN.test(String(value["authorizationDigest"] ?? "")) ||
    !CURSOR_DIGEST_PATTERN.test(String(value["filterDigest"] ?? "")) ||
    !primaryIsValid ||
    !secondaryIsValid ||
    !Number.isSafeInteger(value["number"]) ||
    (value["number"] as number) < 1 ||
    typeof value["id"] !== "string" ||
    !UUID_PATTERN.test(value["id"])
  ) {
    invalidCursor();
  }
  const canonical = JSON.stringify({
    v: 1,
    authorizationDigest: value["authorizationDigest"],
    filterDigest: value["filterDigest"],
    snapshotSequence: value["snapshotSequence"],
    primary: value["primary"],
    secondary: value["secondary"],
    number: value["number"],
    id: value["id"],
  });
  if (decodedText !== canonical) invalidCursor();
  return {
    primary: value["primary"] as string | number,
    secondary: value["secondary"] as string | null,
    number: value["number"] as number,
    id: value["id"],
  };
}

function encodeCursor(cursor: MobileBugListCursor, signingKey: Uint8Array): string {
  const encoded = Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey)
    .update(`${CURSOR_PREFIX}.${encoded}`)
    .digest("base64url");
  const token = `${CURSOR_PREFIX}.${encoded}.${signature}`;
  if (token.length > 500) throw new Error("Bug list cursor exceeds its contract limit");
  return token;
}

function toMobileBug(
  database: DatabaseSync,
  accountId: string,
  row: MobileBugListRow,
): MobileBugRecord {
  const scope = { accountId, projectId: row.project_id };
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    key: row.key,
    title: row.title,
    description: row.description,
    expectedBehavior: row.expected_behavior,
    moduleId: row.module_id,
    state: row.state,
    severity: row.severity,
    priority: row.priority,
    reporterId: canonicalProjectUserId(database, scope, row.reporter_id),
    ownerId: canonicalNullableProjectUserId(database, scope, row.owner_id),
    verificationOwnerId: canonicalNullableProjectUserId(database, scope, row.verification_owner_id),
    duplicateOfBugId: row.duplicate_of_bug_id,
    occurrenceCount: row.occurrence_count,
    reopenCount: row.reopen_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  });
}

function addIdentityFilter(
  conditions: string[],
  parameters: SQLInputValue[],
  column: "owner_id" | "verification_owner_id",
  userId: string,
): void {
  conditions.push(
    `bugs.${column} IN (
      SELECT ? AS user_id
      UNION
      SELECT direct.canonical_user_id
      FROM project_identity_links AS direct
      WHERE direct.account_id = bugs.account_id
        AND direct.project_id = bugs.project_id
        AND direct.source_user_id = ?
        AND direct.status = 'active'
      UNION
      SELECT sibling.source_user_id
      FROM project_identity_links AS sibling
      WHERE sibling.account_id = bugs.account_id
        AND sibling.project_id = bugs.project_id
        AND sibling.status = 'active'
        AND sibling.canonical_user_id = COALESCE((
          SELECT source.canonical_user_id
          FROM project_identity_links AS source
          WHERE source.account_id = bugs.account_id
            AND source.project_id = bugs.project_id
            AND source.source_user_id = ?
            AND source.status = 'active'
        ), ?)
    )`,
  );
  parameters.push(userId, userId, userId, userId);
}

function priorityRank(priority: MobileBugRecord["priority"]): number {
  return Number(priority.slice(1));
}

export function listMobileBugs(
  database: DatabaseSync,
  input: ListMobileBugsInput,
  cursorSigningKey: Uint8Array,
): MobileBugList {
  requireUuid(input.accountId, "accountId");
  requireUuid(input.actorId, "actorId");
  if (input.projectId !== undefined) requireUuid(input.projectId, "projectId");
  if (input.ownerId !== undefined) requireUuid(input.ownerId, "ownerId");
  if (input.verificationOwnerId !== undefined)
    requireUuid(input.verificationOwnerId, "verificationOwnerId");
  if (input.reporterId !== undefined) requireUuid(input.reporterId, "reporterId");
  if (input.moduleId !== undefined) requireUuid(input.moduleId, "moduleId");
  if (input.ownerId !== undefined && input.ownerState !== undefined) {
    throw new MobileRelayStorageError(
      "INVALID_REQUEST",
      "ownerId and ownerState cannot be combined",
    );
  }
  requireLimit(input.limit);
  requireQuery(input.q);
  requireStates(input.state);
  requireSeverity(input.severity);
  requirePriority(input.priority);
  requireCursorSigningKey(cursorSigningKey);
  const filters = normalizeFilters(input);
  const authorization = authorizationSnapshot(database, input);
  const cursor = decodeCursor(
    input,
    filters,
    cursorSigningKey,
    authorization.digest,
    authorization.snapshotSequence,
  );

  const conditions = [
    "bugs.account_id = ?",
    `EXISTS (
      SELECT 1
      FROM projects AS visible_project
      WHERE visible_project.account_id = bugs.account_id
        AND visible_project.id = bugs.project_id
        AND visible_project.status = 'active'
        AND (
          ? = 1 OR EXISTS (
            SELECT 1
            FROM memberships AS visible_membership
            WHERE visible_membership.account_id = bugs.account_id
              AND visible_membership.project_id = bugs.project_id
              AND visible_membership.user_id = ?
              AND visible_membership.status = 'active'
          )
        )
    )`,
    `NOT EXISTS (
      SELECT 1 FROM bug_deletions AS deletion
      WHERE deletion.account_id = bugs.account_id
        AND deletion.project_id = bugs.project_id
      AND deletion.bug_id = bugs.id
    )`,
  ];
  const parameters: SQLInputValue[] = [input.accountId, authorization.isGm ? 1 : 0, input.actorId];
  if (filters.projectId !== null) {
    conditions.push("bugs.project_id = ?");
    parameters.push(filters.projectId);
  }
  if (filters.ownerId !== null)
    addIdentityFilter(conditions, parameters, "owner_id", filters.ownerId);
  if (filters.verificationOwnerId !== null)
    addIdentityFilter(conditions, parameters, "verification_owner_id", filters.verificationOwnerId);
  if (filters.ownerState === "assigned") conditions.push("bugs.owner_id IS NOT NULL");
  if (filters.ownerState === "unassigned") conditions.push("bugs.owner_id IS NULL");
  if (filters.q !== null) {
    conditions.push(
      "(instr(lower(key), lower(?)) > 0 OR instr(lower(title), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0 OR instr(lower(expected_behavior), lower(?)) > 0)",
    );
    parameters.push(filters.q, filters.q, filters.q, filters.q);
  }
  if (filters.state.length > 0) {
    conditions.push(`bugs.state IN (${filters.state.map(() => "?").join(", ")})`);
    parameters.push(...filters.state);
  }
  if (filters.reporterId !== null) {
    conditions.push("bugs.reporter_id = ?");
    parameters.push(filters.reporterId);
  }
  if (filters.moduleId !== null) {
    conditions.push("bugs.module_id = ?");
    parameters.push(filters.moduleId);
  }
  if (filters.severity !== null) {
    conditions.push("bugs.severity = ?");
    parameters.push(filters.severity);
  }
  if (filters.priority !== null) {
    conditions.push("bugs.priority = ?");
    parameters.push(filters.priority);
  }
  if (filters.updatedAfter !== null) {
    conditions.push("bugs.updated_at > ?");
    parameters.push(filters.updatedAfter);
  }
  if (cursor !== null) {
    if (filters.sort === "priority_desc") {
      conditions.push(
        `(${PRIORITY_RANK_SQL} > ? OR
          (${PRIORITY_RANK_SQL} = ? AND bugs.updated_at < ?) OR
          (${PRIORITY_RANK_SQL} = ? AND bugs.updated_at = ? AND bugs.number < ?) OR
          (${PRIORITY_RANK_SQL} = ? AND bugs.updated_at = ? AND bugs.number = ? AND bugs.id < ?))`,
      );
      parameters.push(
        cursor.primary,
        cursor.primary,
        cursor.secondary,
        cursor.primary,
        cursor.secondary,
        cursor.number,
        cursor.primary,
        cursor.secondary,
        cursor.number,
        cursor.id,
      );
    } else {
      const column = filters.sort === "created_desc" ? "bugs.created_at" : "bugs.updated_at";
      conditions.push(
        `(${column} < ? OR (${column} = ? AND bugs.number < ?) OR
          (${column} = ? AND bugs.number = ? AND bugs.id < ?))`,
      );
      parameters.push(
        cursor.primary,
        cursor.primary,
        cursor.number,
        cursor.primary,
        cursor.number,
        cursor.id,
      );
    }
  }
  const pageLimit = Math.min(input.limit, BUG_LIST_RESPONSE_PAGE_LIMIT);
  parameters.push(pageLimit + 1);
  const orderBy =
    filters.sort === "created_desc"
      ? "bugs.created_at DESC, bugs.number DESC, bugs.id DESC"
      : filters.sort === "priority_desc"
        ? `${PRIORITY_RANK_SQL} ASC, bugs.updated_at DESC, bugs.number DESC, bugs.id DESC`
        : "bugs.updated_at DESC, bugs.number DESC, bugs.id DESC";

  const rows = database
    .prepare(
      `SELECT id, project_id, number, key, title, description, expected_behavior,
              module_id, state, severity, priority, reporter_id, owner_id,
              verification_owner_id, duplicate_of_bug_id, occurrence_count,
              reopen_count, version, created_at, updated_at, closed_at
       FROM bugs
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ?`,
    )
    .all(...parameters) as unknown as MobileBugListRow[];

  const items = rows.slice(0, pageLimit);
  const last = items.at(-1);
  return Object.freeze({
    snapshotSequence: authorization.snapshotSequence,
    items: Object.freeze(items.map((row) => toMobileBug(database, input.accountId, row))),
    nextCursor:
      rows.length > pageLimit && last
        ? encodeCursor(
            {
              authorizationDigest: authorization.digest,
              filterDigest: filterDigest(filters),
              snapshotSequence: authorization.snapshotSequence,
              primary:
                filters.sort === "created_desc"
                  ? last.created_at
                  : filters.sort === "priority_desc"
                    ? priorityRank(last.priority)
                    : last.updated_at,
              secondary: filters.sort === "priority_desc" ? last.updated_at : null,
              number: last.number,
              id: last.id,
            },
            cursorSigningKey,
          )
        : null,
  });
}
