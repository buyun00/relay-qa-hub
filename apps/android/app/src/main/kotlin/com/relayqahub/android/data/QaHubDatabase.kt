package com.relayqahub.android.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        AccountEntity::class,
        ProjectEntity::class,
        CachedQaItemEntity::class,
        OfflineOperationEntity::class,
        OfflineOperationReceiptEntity::class,
        AttachmentPipelineReceiptEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
@TypeConverters(DatabaseConverters::class)
abstract class QaHubDatabase : RoomDatabase() {
    abstract fun accountProjectDao(): AccountProjectDao
    abstract fun cachedQaItemDao(): CachedQaItemDao
    abstract fun offlineOperationDao(): OfflineOperationDao
    abstract fun attachmentPipelineReceiptDao(): AttachmentPipelineReceiptDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE offline_operations " +
                        "ADD COLUMN actorId TEXT NOT NULL DEFAULT ''",
                )
                db.execSQL(
                    "ALTER TABLE offline_operations " +
                        "ADD COLUMN installationId TEXT NOT NULL DEFAULT ''",
                )
                db.execSQL(
                    "ALTER TABLE offline_operations " +
                        "ADD COLUMN sessionId TEXT NOT NULL DEFAULT ''",
                )
                db.execSQL(
                    "UPDATE offline_operations SET state = 'BLOCKED_AUTH', " +
                        "lastErrorCode = 'SESSION_SCOPE_REQUIRED' " +
                        "WHERE state IN ('PENDING', 'RUNNING', 'RETRY', 'BLOCKED_AUTH')",
                )
                db.execSQL(
                    "DROP INDEX IF EXISTS " +
                        "index_offline_operations_accountId_projectId_state_nextAttemptAtEpochMs",
                )
                db.execSQL(
                    "DROP INDEX IF EXISTS " +
                        "index_offline_operations_accountId_projectId_idempotencyKey",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS " +
                        "index_offline_operations_accountId_projectId_actorId_installationId_" +
                        "sessionId_state_nextAttemptAtEpochMs ON offline_operations " +
                        "(accountId, projectId, actorId, installationId, sessionId, " +
                        "state, nextAttemptAtEpochMs)",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS " +
                        "index_offline_operations_accountId_projectId_actorId_installationId_" +
                        "sessionId_idempotencyKey ON offline_operations " +
                        "(accountId, projectId, actorId, installationId, sessionId, idempotencyKey)",
                )
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS offline_operation_receipts (" +
                        "operationId TEXT NOT NULL, accountId TEXT NOT NULL, " +
                        "projectId TEXT NOT NULL, actorId TEXT NOT NULL, " +
                        "installationId TEXT NOT NULL, sessionId TEXT NOT NULL, " +
                        "clientSubmissionId TEXT NOT NULL, qaItemId TEXT NOT NULL, " +
                        "qaItemKey TEXT NOT NULL, bugId TEXT NOT NULL, " +
                        "occurrenceId TEXT NOT NULL, eventId TEXT NOT NULL, " +
                        "replayed INTEGER NOT NULL, responseJson TEXT NOT NULL, " +
                        "receivedAtEpochMs INTEGER NOT NULL, PRIMARY KEY(operationId), " +
                        "FOREIGN KEY(operationId) REFERENCES offline_operations(operationId) " +
                        "ON UPDATE NO ACTION ON DELETE CASCADE)",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS " +
                        "index_offline_operation_receipts_operationId " +
                        "ON offline_operation_receipts (operationId)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS " +
                        "index_offline_operation_receipts_accountId_projectId_qaItemId " +
                        "ON offline_operation_receipts (accountId, projectId, qaItemId)",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS " +
                        "index_offline_operation_receipts_accountId_projectId_actorId_" +
                        "installationId_sessionId_clientSubmissionId " +
                        "ON offline_operation_receipts (accountId, projectId, actorId, " +
                        "installationId, sessionId, clientSubmissionId)",
                )
            }
        }

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS attachment_pipeline_receipts (" +
                        "accountId TEXT NOT NULL, projectId TEXT NOT NULL, " +
                        "actorId TEXT NOT NULL, installationId TEXT NOT NULL, " +
                        "sessionId TEXT NOT NULL, clientSubmissionId TEXT NOT NULL, " +
                        "clientAttachmentId TEXT NOT NULL, attachmentId TEXT NOT NULL, " +
                        "bindingId TEXT NOT NULL, bindingStatus TEXT NOT NULL, " +
                        "qaItemId TEXT, qaItemKey TEXT, responseJson TEXT NOT NULL, " +
                        "updatedAtEpochMs INTEGER NOT NULL, " +
                        "PRIMARY KEY(accountId, projectId, clientSubmissionId, " +
                        "clientAttachmentId), FOREIGN KEY(accountId, projectId) " +
                        "REFERENCES projects(accountId, projectId) " +
                        "ON UPDATE NO ACTION ON DELETE CASCADE)",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS attachment_receipts_scope_idx " +
                        "ON attachment_pipeline_receipts (accountId, projectId, actorId, " +
                        "installationId, sessionId)",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS attachment_receipts_attachment_idx " +
                        "ON attachment_pipeline_receipts (accountId, projectId, attachmentId)",
                )
            }
        }
    }
}
