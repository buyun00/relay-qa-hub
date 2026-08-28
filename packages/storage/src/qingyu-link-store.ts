import type { DatabaseSync } from "node:sqlite";

export type QingyuLinkSyncStatus = "not_synced" | "syncing" | "succeeded" | "failed";

export interface QingyuLinkScope {
  readonly accountId: string;
  readonly projectId: string;
}

export interface QingyuLinkRecord {
  readonly bugId: string;
  readonly qaProjectId: string;
  readonly externalProjectId: string;
  readonly defectId: string;
  readonly defectCode: string | null;
  readonly defectTitle: string;
  readonly defectUrl: string;
  readonly importedByActorId: string;
  readonly qingyuUserId: string;
  readonly qingyuUserName: string;
  readonly importedAt: string;
  readonly syncStatus: QingyuLinkSyncStatus;
  readonly syncAttempts: number;
  readonly syncedAt: string | null;
  readonly externalStatus: string | null;
  readonly lastSyncErrorCode: string | null;
  readonly lastSyncErrorMessage: string | null;
  readonly lastSyncAt: string | null;
  readonly version: number;
}

export interface PutQingyuLinkInput extends QingyuLinkScope {
  readonly link: Omit<QingyuLinkRecord, "version">;
  readonly updatedAt: string;
}

export interface GetQingyuLinkInput extends QingyuLinkScope {
  readonly bugId: string;
}

export interface GetQingyuLinkByExternalInput extends QingyuLinkScope {
  readonly externalProjectId: string;
  readonly defectId: string;
}

export interface UpdateQingyuLinkSyncInput extends QingyuLinkScope {
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly syncStatus: QingyuLinkSyncStatus;
  readonly syncAttempts: number;
  readonly syncedAt: string | null;
  readonly externalStatus: string | null;
  readonly lastSyncErrorCode: string | null;
  readonly lastSyncErrorMessage: string | null;
  readonly lastSyncAt: string | null;
  readonly updatedAt: string;
}

interface LinkRow {
  readonly project_id: string;
  readonly bug_id: string;
  readonly external_project_id: string;
  readonly defect_id: string;
  readonly defect_code: string | null;
  readonly defect_title: string;
  readonly defect_url: string;
  readonly imported_by_actor_id: string;
  readonly qingyu_user_id: string;
  readonly qingyu_user_name: string;
  readonly imported_at: string;
  readonly sync_status: QingyuLinkSyncStatus;
  readonly sync_attempts: number;
  readonly synced_at: string | null;
  readonly external_status: string | null;
  readonly last_sync_error_code: string | null;
  readonly last_sync_error_message: string | null;
  readonly last_sync_at: string | null;
  readonly version: number;
}

const SELECT_LINK = `SELECT project_id, bug_id, external_project_id, defect_id, defect_code,
  defect_title, defect_url, imported_by_actor_id, qingyu_user_id, qingyu_user_name,
  imported_at, sync_status, sync_attempts, synced_at, external_status,
  last_sync_error_code, last_sync_error_message, last_sync_at, version
  FROM qingyu_bug_links`;

function toRecord(row: LinkRow | undefined): QingyuLinkRecord | null {
  if (row === undefined) return null;
  return {
    bugId: row.bug_id,
    qaProjectId: row.project_id,
    externalProjectId: row.external_project_id,
    defectId: row.defect_id,
    defectCode: row.defect_code,
    defectTitle: row.defect_title,
    defectUrl: row.defect_url,
    importedByActorId: row.imported_by_actor_id,
    qingyuUserId: row.qingyu_user_id,
    qingyuUserName: row.qingyu_user_name,
    importedAt: row.imported_at,
    syncStatus: row.sync_status,
    syncAttempts: row.sync_attempts,
    syncedAt: row.synced_at,
    externalStatus: row.external_status,
    lastSyncErrorCode: row.last_sync_error_code,
    lastSyncErrorMessage: row.last_sync_error_message,
    lastSyncAt: row.last_sync_at,
    version: row.version,
  };
}

export function getQingyuLink(
  database: DatabaseSync,
  input: GetQingyuLinkInput,
): QingyuLinkRecord | null {
  return toRecord(
    database
      .prepare(`${SELECT_LINK} WHERE account_id = ? AND project_id = ? AND bug_id = ?`)
      .get(input.accountId, input.projectId, input.bugId) as LinkRow | undefined,
  );
}

export function getQingyuLinkByExternal(
  database: DatabaseSync,
  input: GetQingyuLinkByExternalInput,
): QingyuLinkRecord | null {
  return toRecord(
    database
      .prepare(
        `${SELECT_LINK} WHERE account_id = ? AND project_id = ? AND external_project_id = ? AND defect_id = ?`,
      )
      .get(input.accountId, input.projectId, input.externalProjectId, input.defectId) as
      LinkRow | undefined,
  );
}

export function putQingyuLink(database: DatabaseSync, input: PutQingyuLinkInput): QingyuLinkRecord {
  const existing = getQingyuLinkByExternal(database, {
    accountId: input.accountId,
    projectId: input.projectId,
    externalProjectId: input.link.externalProjectId,
    defectId: input.link.defectId,
  });
  if (existing !== null) return existing;
  const link = input.link;
  database
    .prepare(
      `INSERT INTO qingyu_bug_links(
    account_id, project_id, bug_id, external_project_id, defect_id, defect_code,
    defect_title, defect_url, imported_by_actor_id, qingyu_user_id, qingyu_user_name,
    imported_at, sync_status, sync_attempts, synced_at, external_status,
    last_sync_error_code, last_sync_error_message, last_sync_at, updated_at, version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      input.accountId,
      input.projectId,
      link.bugId,
      link.externalProjectId,
      link.defectId,
      link.defectCode,
      link.defectTitle,
      link.defectUrl,
      link.importedByActorId,
      link.qingyuUserId,
      link.qingyuUserName,
      link.importedAt,
      link.syncStatus,
      link.syncAttempts,
      link.syncedAt,
      link.externalStatus,
      link.lastSyncErrorCode,
      link.lastSyncErrorMessage,
      link.lastSyncAt,
      input.updatedAt,
    );
  const created = getQingyuLink(database, { ...input, bugId: link.bugId });
  if (created === null) throw new Error("Qingyu link insert did not produce a record");
  return created;
}

export function updateQingyuLinkSync(
  database: DatabaseSync,
  input: UpdateQingyuLinkSyncInput,
): QingyuLinkRecord {
  const result = database
    .prepare(
      `UPDATE qingyu_bug_links SET
    sync_status = ?, sync_attempts = ?, synced_at = ?, external_status = ?,
    last_sync_error_code = ?, last_sync_error_message = ?, last_sync_at = ?,
    updated_at = ?, version = version + 1
    WHERE account_id = ? AND project_id = ? AND bug_id = ? AND version = ?`,
    )
    .run(
      input.syncStatus,
      input.syncAttempts,
      input.syncedAt,
      input.externalStatus,
      input.lastSyncErrorCode,
      input.lastSyncErrorMessage,
      input.lastSyncAt,
      input.updatedAt,
      input.accountId,
      input.projectId,
      input.bugId,
      input.expectedVersion,
    );
  if (result.changes !== 1)
    throw Object.assign(new Error("Qingyu link version changed"), { code: "VERSION_CONFLICT" });
  const updated = getQingyuLink(database, input);
  if (updated === null) throw new Error("Qingyu link update lost its record");
  return updated;
}
