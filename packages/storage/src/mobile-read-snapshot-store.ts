import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  decodeMobileReadCursor,
  encodeMobileReadCursor,
  requireMobileReadPosition,
} from "./mobile-read-cursor.js";
import { MobileRelayStorageError } from "./mobile-relay-store.js";

export type MobileReadSnapshotKind =
  "visible-projects" | "project-members" | "project-builds" | "notifications";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const MAX_ITEMS_PER_SNAPSHOT = 10_000;
const MAX_BYTES_PER_SNAPSHOT = 64 * 1024 * 1024;
const MAX_ACTIVE_SNAPSHOTS_PER_ACTOR = 32;
const MAX_ACTIVE_BYTES_PER_ACTOR = 256 * 1024 * 1024;
const MAX_ACTIVE_SNAPSHOTS_TOTAL = 4_096;
const MAX_ACTIVE_BYTES_TOTAL = 2 * 1024 * 1024 * 1024;
const SNAPSHOT_TTL_MS = 15 * 60_000;

interface SnapshotRow {
  readonly sequence: number;
  readonly id: string;
  readonly kind: string;
  readonly account_id: string;
  readonly actor_id: string;
  readonly project_id: string | null;
  readonly authorization_digest: string;
  readonly filter_digest: string;
  readonly metadata_json: string;
  readonly item_count: number;
  readonly byte_count: number;
  readonly created_at: number;
  readonly expires_at: number;
}

interface SnapshotCapacityRow {
  readonly count: number;
  readonly bytes: number;
}

interface PreparedMaterialization<
  Item extends object,
  Metadata extends object,
> extends MobileReadSnapshotMaterialization<Item, Metadata> {
  readonly metadataJson: string;
  readonly itemJson: readonly string[];
  readonly byteCount: number;
}

export interface MobileReadSnapshotMaterialization<Item extends object, Metadata extends object> {
  readonly items: readonly Item[];
  readonly metadata: Metadata;
}

export interface MobileReadSnapshotPage<Item extends object, Metadata extends object> {
  readonly snapshotSequence: number;
  readonly items: readonly Item[];
  readonly metadata: Metadata;
  readonly nextCursor: string | null;
}

export interface ReadMobileSnapshotPageInput<Item extends object, Metadata extends object> {
  readonly kind: MobileReadSnapshotKind;
  readonly accountId: string;
  readonly actorId: string;
  readonly authorizationProjectId: string | null;
  readonly authorizationDigest: () => string;
  readonly filterDigest: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signingKey: Uint8Array;
  readonly materialize: () => MobileReadSnapshotMaterialization<Item, Metadata>;
}

function invalidSnapshot(message = "cursor is invalid for this list"): never {
  throw new MobileRelayStorageError("INVALID_REQUEST", message);
}

function capacityExceeded(): never {
  throw new MobileRelayStorageError("RATE_LIMITED", "mobile read snapshot capacity exceeded");
}

function withImmediateTransaction<T>(database: DatabaseSync, work: () => T): T {
  if (database.isTransaction) return work();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function parseRecord(value: string, description: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidSnapshot(`${description} is corrupt`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalidSnapshot(`${description} is corrupt`);
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

function currentTimeMs(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms")
    .get() as { readonly now_ms: number };
  if (!Number.isSafeInteger(row.now_ms) || row.now_ms < 0) {
    throw new Error("SQLite clock is invalid");
  }
  return row.now_ms;
}

function cleanExpiredSnapshots(database: DatabaseSync, nowMs: number): void {
  database.prepare("DELETE FROM mobile_read_snapshots WHERE expires_at <= ?").run(nowMs);
}

function assertCapacity(
  database: DatabaseSync,
  accountId: string,
  actorId: string,
  nowMs: number,
  nextBytes: number,
): void {
  const actor = database
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(byte_count), 0) AS bytes
       FROM mobile_read_snapshots
       WHERE account_id = ? AND actor_id = ? AND expires_at > ?`,
    )
    .get(accountId, actorId, nowMs) as unknown as SnapshotCapacityRow;
  const total = database
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(byte_count), 0) AS bytes
       FROM mobile_read_snapshots WHERE expires_at > ?`,
    )
    .get(nowMs) as unknown as SnapshotCapacityRow;
  if (
    !Number.isSafeInteger(actor.count) ||
    !Number.isSafeInteger(actor.bytes) ||
    !Number.isSafeInteger(total.count) ||
    !Number.isSafeInteger(total.bytes) ||
    actor.count >= MAX_ACTIVE_SNAPSHOTS_PER_ACTOR ||
    actor.bytes + nextBytes > MAX_ACTIVE_BYTES_PER_ACTOR ||
    total.count >= MAX_ACTIVE_SNAPSHOTS_TOTAL ||
    total.bytes + nextBytes > MAX_ACTIVE_BYTES_TOTAL
  ) {
    capacityExceeded();
  }
}

function validateSnapshotContents(database: DatabaseSync, snapshot: SnapshotRow): void {
  const stored = database
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(length(CAST(dto_json AS BLOB))), 0) AS bytes,
              COALESCE(MIN(ordinal), 0) AS first_ordinal,
              COALESCE(MAX(ordinal), -1) AS last_ordinal
       FROM mobile_read_snapshot_items WHERE snapshot_id = ?`,
    )
    .get(snapshot.id) as {
    readonly count: number;
    readonly bytes: number;
    readonly first_ordinal: number;
    readonly last_ordinal: number;
  };
  const metadataBytes = Buffer.byteLength(snapshot.metadata_json, "utf8");
  if (
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 1 ||
    !Number.isSafeInteger(snapshot.item_count) ||
    snapshot.item_count < 0 ||
    snapshot.item_count > MAX_ITEMS_PER_SNAPSHOT ||
    !Number.isSafeInteger(snapshot.byte_count) ||
    snapshot.byte_count < 2 ||
    snapshot.byte_count > MAX_BYTES_PER_SNAPSHOT ||
    stored.count !== snapshot.item_count ||
    stored.bytes + metadataBytes !== snapshot.byte_count ||
    (stored.count > 0 && (stored.first_ordinal !== 0 || stored.last_ordinal !== stored.count - 1))
  ) {
    invalidSnapshot("mobile read snapshot is corrupt");
  }
}

function prepareMaterialization<Item extends object, Metadata extends object>(
  materialized: MobileReadSnapshotMaterialization<Item, Metadata>,
): PreparedMaterialization<Item, Metadata> {
  if (!Array.isArray(materialized.items) || materialized.items.length > MAX_ITEMS_PER_SNAPSHOT) {
    capacityExceeded();
  }
  const metadataJson = JSON.stringify(materialized.metadata);
  if (
    typeof metadataJson !== "string" ||
    materialized.metadata === null ||
    typeof materialized.metadata !== "object" ||
    Array.isArray(materialized.metadata)
  ) {
    invalidSnapshot("mobile read snapshot metadata is invalid");
  }
  const itemJson = materialized.items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      invalidSnapshot("mobile read snapshot item is invalid");
    }
    const encoded = JSON.stringify(item);
    if (typeof encoded !== "string") invalidSnapshot("mobile read snapshot item is invalid");
    return encoded;
  });
  const byteCount =
    Buffer.byteLength(metadataJson, "utf8") +
    itemJson.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
  if (!Number.isSafeInteger(byteCount) || byteCount > MAX_BYTES_PER_SNAPSHOT) {
    capacityExceeded();
  }
  return Object.freeze({ ...materialized, metadataJson, itemJson, byteCount });
}

function createSnapshot<Item extends object, Metadata extends object>(
  database: DatabaseSync,
  input: ReadMobileSnapshotPageInput<Item, Metadata>,
  authorizationDigest: string,
  nowMs: number,
  prepared: PreparedMaterialization<Item, Metadata>,
): SnapshotRow {
  assertCapacity(database, input.accountId, input.actorId, nowMs, prepared.byteCount);

  const id = randomUUID();
  const expiresAt = nowMs + SNAPSHOT_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("mobile read snapshot expiry is invalid");
  const inserted = database
    .prepare(
      `INSERT INTO mobile_read_snapshots(
         id,kind,account_id,actor_id,project_id,authorization_digest,filter_digest,
         metadata_json,item_count,byte_count,created_at,expires_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       RETURNING *`,
    )
    .get(
      id,
      input.kind,
      input.accountId,
      input.actorId,
      input.authorizationProjectId,
      authorizationDigest,
      input.filterDigest,
      prepared.metadataJson,
      prepared.itemJson.length,
      prepared.byteCount,
      nowMs,
      expiresAt,
    ) as unknown as SnapshotRow;
  const insertItem = database.prepare(
    "INSERT INTO mobile_read_snapshot_items(snapshot_id, ordinal, dto_json) VALUES (?, ?, ?)",
  );
  for (const [ordinal, dtoJson] of prepared.itemJson.entries())
    insertItem.run(id, ordinal, dtoJson);
  validateSnapshotContents(database, inserted);
  return inserted;
}

function loadSnapshot(
  database: DatabaseSync,
  input: ReadMobileSnapshotPageInput<
    Readonly<Record<string, unknown>>,
    Readonly<Record<string, unknown>>
  >,
  authorizationDigest: string,
  snapshotSequence: number,
  snapshotId: string,
  nowMs: number,
): SnapshotRow {
  const snapshot = database
    .prepare("SELECT * FROM mobile_read_snapshots WHERE id = ?")
    .get(snapshotId) as unknown as SnapshotRow | undefined;
  if (
    snapshot === undefined ||
    snapshot.sequence !== snapshotSequence ||
    snapshot.kind !== input.kind ||
    snapshot.account_id !== input.accountId ||
    snapshot.actor_id !== input.actorId ||
    snapshot.project_id !== input.authorizationProjectId ||
    snapshot.authorization_digest !== authorizationDigest ||
    snapshot.filter_digest !== input.filterDigest ||
    snapshot.expires_at <= nowMs
  ) {
    invalidSnapshot();
  }
  validateSnapshotContents(database, snapshot);
  return snapshot;
}

export function readMobileSnapshotPage<Item extends object, Metadata extends object>(
  database: DatabaseSync,
  input: ReadMobileSnapshotPageInput<Item, Metadata>,
): MobileReadSnapshotPage<Item, Metadata> {
  return withImmediateTransaction(database, () => {
    const nowMs = currentTimeMs(database);
    cleanExpiredSnapshots(database, nowMs);
    const authorizationDigest = input.authorizationDigest();
    const decoded = decodeMobileReadCursor(input.cursor, {
      kind: input.kind,
      authorizationDigest,
      filterDigest: input.filterDigest,
      signingKey: input.signingKey,
    });

    let offset = 0;
    let snapshot: SnapshotRow;
    if (decoded === null) {
      const prepared = prepareMaterialization(input.materialize());
      if (prepared.items.length <= input.limit) {
        return Object.freeze({
          snapshotSequence: nowMs,
          items: Object.freeze([...prepared.items]),
          metadata: Object.freeze(prepared.metadata),
          nextCursor: null,
        });
      }
      snapshot = createSnapshot(database, input, authorizationDigest, nowMs, prepared);
    } else {
      const position = requireMobileReadPosition(decoded.position, ["offset", "snapshotId"]);
      if (
        typeof position["snapshotId"] !== "string" ||
        !UUID_PATTERN.test(position["snapshotId"]) ||
        !Number.isSafeInteger(position["offset"]) ||
        (position["offset"] as number) < 1
      ) {
        invalidSnapshot();
      }
      offset = position["offset"] as number;
      snapshot = loadSnapshot(
        database,
        input as ReadMobileSnapshotPageInput<
          Readonly<Record<string, unknown>>,
          Readonly<Record<string, unknown>>
        >,
        authorizationDigest,
        decoded.snapshotSequence,
        position["snapshotId"],
        nowMs,
      );
      if (offset >= snapshot.item_count) invalidSnapshot();
    }

    const rows = database
      .prepare(
        `SELECT ordinal, dto_json FROM mobile_read_snapshot_items
         WHERE snapshot_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?`,
      )
      .all(snapshot.id, offset, input.limit + 1) as unknown as {
      readonly ordinal: number;
      readonly dto_json: string;
    }[];
    const selected = rows.slice(0, input.limit);
    if (
      selected.some((row, index) => row.ordinal !== offset + index) ||
      (offset < snapshot.item_count && selected.length === 0)
    ) {
      invalidSnapshot("mobile read snapshot page is corrupt");
    }
    const items = Object.freeze(
      selected.map((row) => parseRecord(row.dto_json, "mobile read snapshot item") as Item),
    );
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < snapshot.item_count;
    if (hasMore !== rows.length > input.limit) {
      invalidSnapshot("mobile read snapshot page is corrupt");
    }
    const metadata = parseRecord(
      snapshot.metadata_json,
      "mobile read snapshot metadata",
    ) as Metadata;
    return Object.freeze({
      snapshotSequence: snapshot.sequence,
      items,
      metadata,
      nextCursor: hasMore
        ? encodeMobileReadCursor(
            {
              kind: input.kind,
              authorizationDigest,
              filterDigest: input.filterDigest,
              snapshotSequence: snapshot.sequence,
              position: { offset: nextOffset, snapshotId: snapshot.id },
            },
            input.signingKey,
          )
        : null,
    });
  });
}
