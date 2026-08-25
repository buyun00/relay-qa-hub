package com.relayqahub.android.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RoomMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        QaHubDatabase::class.java,
    )

    @Test
    fun versionOneQueueRowsAreFailClosedDuringSessionIdentityUpgrade() {
        val databaseName = "migration-${UUID.randomUUID()}"
        helper.createDatabase(databaseName, 1).apply {
            seedVersionOneQueue(this)
            close()
        }

        helper.runMigrationsAndValidate(
            databaseName,
            4,
            true,
            QaHubDatabase.MIGRATION_1_2,
            QaHubDatabase.MIGRATION_2_3,
            QaHubDatabase.MIGRATION_3_4,
        ).use { database ->
            database.query(
                "SELECT actorId, installationId, sessionId, state, lastErrorCode " +
                    "FROM offline_operations WHERE operationId = 'legacy-operation'",
            ).use { cursor ->
                check(cursor.moveToFirst())
                assertEquals("", cursor.getString(0))
                assertEquals("", cursor.getString(1))
                assertEquals("", cursor.getString(2))
                assertEquals("BLOCKED_AUTH", cursor.getString(3))
                assertEquals("SESSION_SCOPE_REQUIRED", cursor.getString(4))
            }
            database.query(
                "SELECT COUNT(*) FROM offline_operation_receipts",
            ).use { cursor ->
                check(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
        }
    }

    @Test
    fun durableQueueSurvivesReopenAndUnknownDowngradeIsRefused() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "restart-${UUID.randomUUID()}"
        val scope = AccountProjectScope(
            "account-restart",
            "project-restart",
            "actor-restart",
            "installation-restart",
            "session-restart",
        )
        val original = Room.databaseBuilder(context, QaHubDatabase::class.java, databaseName)
            .addMigrations(
                QaHubDatabase.MIGRATION_1_2,
                QaHubDatabase.MIGRATION_2_3,
                QaHubDatabase.MIGRATION_3_4,
            )
            .build()
        original.accountProjectDao().upsertScope(
            AccountEntity(scope.accountId, "Account", 1),
            ProjectEntity(scope.accountId, scope.projectId, "KEY", "Project", 1),
        )
        original.offlineOperationDao().insert(operation(scope))
        original.close()

        val reopened = Room.databaseBuilder(context, QaHubDatabase::class.java, databaseName)
            .addMigrations(
                QaHubDatabase.MIGRATION_1_2,
                QaHubDatabase.MIGRATION_2_3,
                QaHubDatabase.MIGRATION_3_4,
            )
            .build()
        assertEquals(
            listOf("durable-operation"),
            reopened.offlineOperationDao().listForScope(
                scope.accountId,
                scope.projectId,
                scope.actorId,
                scope.installationId,
                scope.sessionId,
            ).map { it.operationId },
        )
        reopened.close()
        context.deleteDatabase(databaseName)

        val downgradeName = "downgrade-${UUID.randomUUID()}"
        val downgradePath = context.getDatabasePath(downgradeName)
        downgradePath.parentFile?.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(downgradePath, null).use { database ->
            database.version = 5
        }
        val downgradeAttempt = Room.databaseBuilder(
            context,
            QaHubDatabase::class.java,
            downgradeName,
        ).addMigrations(
            QaHubDatabase.MIGRATION_1_2,
            QaHubDatabase.MIGRATION_2_3,
            QaHubDatabase.MIGRATION_3_4,
        ).build()
        try {
            val failure = runCatching {
                downgradeAttempt.openHelper.writableDatabase
            }.exceptionOrNull()
            assertTrue(failure != null)
            assertTrue(
                generateSequence(failure) { it.cause }
                    .mapNotNull(Throwable::message)
                    .any { message -> "5 to 4" in message },
            )
        } finally {
            downgradeAttempt.close()
            context.deleteDatabase(downgradeName)
        }
        Unit
    }

    private fun seedVersionOneQueue(database: SupportSQLiteDatabase) {
        database.execSQL("INSERT INTO accounts VALUES ('legacy-account', 'Legacy', 1)")
        database.execSQL(
            "INSERT INTO projects VALUES " +
                "('legacy-account', 'legacy-project', 'LEG', 'Legacy', 1)",
        )
        database.execSQL(
            "INSERT INTO offline_operations VALUES (" +
                "'legacy-operation', 'legacy-account', 'legacy-project', 'CREATE_BUG', " +
                "'POST', '/bugs', '{}', 'submission:legacy:commit', 'PENDING', " +
                "0, 0, NULL, 0, 0)",
        )
    }

    private fun operation(scope: AccountProjectScope) = OfflineOperationEntity(
        operationId = "durable-operation",
        accountId = scope.accountId,
        projectId = scope.projectId,
        actorId = scope.actorId,
        installationId = scope.installationId,
        sessionId = scope.sessionId,
        operationKind = "CREATE_BUG",
        httpMethod = "POST",
        relativePath = "/bugs",
        payloadJson = "{}",
        idempotencyKey = "submission:durable:commit",
        state = QueueState.PENDING,
        attemptCount = 0,
        nextAttemptAtEpochMs = 0,
        lastErrorCode = null,
        createdAtEpochMs = 0,
        updatedAtEpochMs = 0,
    )
}
