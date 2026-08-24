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
    ],
    version = 3,
    exportSchema = true,
)
@TypeConverters(DatabaseConverters::class)
abstract class QaHubDatabase : RoomDatabase() {
    abstract fun accountProjectDao(): AccountProjectDao
    abstract fun cachedQaItemDao(): CachedQaItemDao
    abstract fun offlineOperationDao(): OfflineOperationDao

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
    }
}
