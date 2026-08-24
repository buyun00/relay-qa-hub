package com.relayqahub.android.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RoomScopeIsolationTest {
    private lateinit var database: QaHubDatabase

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, QaHubDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun cacheAndQueueQueriesRequireMatchingAccountAndProject() = runBlocking {
        val scopes = database.accountProjectDao()
        scopes.upsertScope(account("account-a"), project("account-a", "project-a"))
        scopes.upsertScope(account("account-b"), project("account-b", "project-b"))
        database.cachedQaItemDao().upsert(cachedItem("account-a", "project-a", "bug-a"))
        database.cachedQaItemDao().upsert(cachedItem("account-b", "project-b", "bug-b"))
        database.offlineOperationDao().insert(operation("account-a", "project-a", "operation-a"))
        database.offlineOperationDao().insert(
            operation("account-a", "project-a", "operation-a-session-2").copy(
                actorId = "actor-account-a-2",
                installationId = "installation-account-a-2",
                sessionId = "session-account-a-2",
                idempotencyKey = "submission:operation-a:commit",
            ),
        )
        database.offlineOperationDao().insert(operation("account-b", "project-b", "operation-b"))

        assertEquals(
            listOf("bug-a"),
            database.cachedQaItemDao().listForScope("account-a", "project-a").map { it.remoteId },
        )
        assertEquals(
            listOf("operation-a"),
            database.offlineOperationDao().listForScope(
                "account-a",
                "project-a",
                "actor-account-a",
                "installation-account-a",
                "session-account-a",
            ).map { it.operationId },
        )
        assertEquals(
            listOf("operation-a-session-2"),
            database.offlineOperationDao().listForScope(
                "account-a",
                "project-a",
                "actor-account-a-2",
                "installation-account-a-2",
                "session-account-a-2",
            ).map { it.operationId },
        )
        assertEquals(
            listOf("operation-b"),
            database.offlineOperationDao().listForScope(
                "account-b",
                "project-b",
                "actor-account-b",
                "installation-account-b",
                "session-account-b",
            )
                .map { it.operationId },
        )
        assertEquals(
            emptyList<CachedQaItemEntity>(),
            database.cachedQaItemDao().listForScope("account-a", "project-b"),
        )
    }

    @Test
    fun deletingOneAccountCascadesOnlyItsNamespace() = runBlocking {
        val scopes = database.accountProjectDao()
        scopes.upsertScope(account("account-a"), project("account-a", "project-a"))
        scopes.upsertScope(account("account-b"), project("account-b", "project-b"))
        database.cachedQaItemDao().upsert(cachedItem("account-a", "project-a", "bug-a"))
        database.cachedQaItemDao().upsert(cachedItem("account-b", "project-b", "bug-b"))

        scopes.deleteAccount("account-a")

        assertEquals(
            emptyList<CachedQaItemEntity>(),
            database.cachedQaItemDao().listForScope("account-a", "project-a"),
        )
        assertEquals(
            listOf("bug-b"),
            database.cachedQaItemDao().listForScope("account-b", "project-b").map { it.remoteId },
        )
    }

    @Test
    fun refreshingScopeMetadataDoesNotReplaceAndDeleteOfflineData() = runBlocking {
        val scopes = database.accountProjectDao()
        scopes.upsertScope(account("account-a"), project("account-a", "project-a"))
        database.cachedQaItemDao().upsert(cachedItem("account-a", "project-a", "bug-a"))
        database.offlineOperationDao().insert(operation("account-a", "project-a", "operation-a"))

        scopes.upsertScope(
            account("account-a").copy(displayName = "Updated account"),
            project("account-a", "project-a").copy(displayName = "Updated project"),
        )

        assertEquals(
            listOf("bug-a"),
            database.cachedQaItemDao().listForScope("account-a", "project-a").map { it.remoteId },
        )
        assertEquals(
            listOf("operation-a"),
            database.offlineOperationDao().listForScope(
                "account-a",
                "project-a",
                "actor-account-a",
                "installation-account-a",
                "session-account-a",
            )
                .map { it.operationId },
        )
    }

    @Test
    fun createBugReceiptIsDurableBeforeOperationCanBecomeSucceeded() = runBlocking {
        val operation = operation("account-a", "project-a", "submission-a")
        database.accountProjectDao().upsertScope(
            account("account-a"),
            project("account-a", "project-a"),
        )
        val dao = database.offlineOperationDao()
        dao.insert(operation)
        assertEquals(
            1,
            dao.markRunning(
                operation.accountId,
                operation.projectId,
                operation.actorId,
                operation.installationId,
                operation.sessionId,
                listOf(operation.operationId),
                2,
            ),
        )
        assertEquals(
            0,
            dao.recordAttempt(
                operation.accountId,
                operation.projectId,
                operation.actorId,
                operation.installationId,
                operation.sessionId,
                operation.operationId,
                QueueState.SUCCEEDED,
                3,
                null,
                3,
            ),
        )

        val receipt = OfflineOperationReceiptEntity(
            operationId = operation.operationId,
            accountId = operation.accountId,
            projectId = operation.projectId,
            actorId = operation.actorId,
            installationId = operation.installationId,
            sessionId = operation.sessionId,
            clientSubmissionId = "submission-a",
            qaItemId = "bug-a",
            qaItemKey = "QA-1",
            bugId = "bug-a",
            occurrenceId = "occurrence-a",
            eventId = "event-a",
            replayed = false,
            responseJson = "{\"clientSubmissionId\":\"submission-a\"}",
            receivedAtEpochMs = 3,
        )
        dao.completeCreateBug(operation.copy(state = QueueState.RUNNING), receipt, 3)

        assertEquals(receipt, dao.findReceipt(operation.operationId))
        assertEquals(
            QueueState.SUCCEEDED,
            dao.listForScope(
                operation.accountId,
                operation.projectId,
                operation.actorId,
                operation.installationId,
                operation.sessionId,
            ).single().state,
        )
    }

    @Test
    fun mismatchedCreateBugSubmissionKeyRollsBackReceiptAndSuccess() = runBlocking {
        val operation = operation("account-a", "project-a", "operation-a")
        database.accountProjectDao().upsertScope(
            account("account-a"),
            project("account-a", "project-a"),
        )
        val dao = database.offlineOperationDao()
        dao.insert(operation)
        assertEquals(
            1,
            dao.markRunning(
                operation.accountId,
                operation.projectId,
                operation.actorId,
                operation.installationId,
                operation.sessionId,
                listOf(operation.operationId),
                2,
            ),
        )
        val mismatchedReceipt = receipt(
            operation = operation,
            clientSubmissionId = "different-submission",
        )

        val failure = runCatching {
            dao.completeCreateBug(
                operation.copy(state = QueueState.RUNNING),
                mismatchedReceipt,
                3,
            )
        }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
        assertNull(dao.findReceipt(operation.operationId))
        val persisted = dao.listForScope(
            operation.accountId,
            operation.projectId,
            operation.actorId,
            operation.installationId,
            operation.sessionId,
        ).single()
        assertEquals(QueueState.RUNNING, persisted.state)
        assertEquals(operation.accountId, persisted.accountId)
        assertEquals(operation.projectId, persisted.projectId)
        assertEquals(operation.actorId, persisted.actorId)
        assertEquals(operation.installationId, persisted.installationId)
        assertEquals(operation.sessionId, persisted.sessionId)
    }

    private fun account(id: String) = AccountEntity(id, id, 1)

    private fun project(accountId: String, projectId: String) = ProjectEntity(
        accountId = accountId,
        projectId = projectId,
        projectKey = projectId,
        displayName = projectId,
        updatedAtEpochMs = 1,
    )

    private fun cachedItem(accountId: String, projectId: String, remoteId: String) =
        CachedQaItemEntity(
            accountId = accountId,
            projectId = projectId,
            remoteId = remoteId,
            itemKey = remoteId,
            title = remoteId,
            state = "reported",
            serverVersion = 1,
            payloadJson = "{}",
            updatedAtEpochMs = 1,
        )

    private fun operation(accountId: String, projectId: String, operationId: String) =
        OfflineOperationEntity(
            operationId = operationId,
            accountId = accountId,
            projectId = projectId,
            actorId = "actor-$accountId",
            installationId = "installation-$accountId",
            sessionId = "session-$accountId",
            operationKind = "CREATE_BUG",
            httpMethod = "POST",
            relativePath = "/bugs",
            payloadJson = "{}",
            idempotencyKey = "submission:$operationId:commit",
            state = QueueState.PENDING,
            attemptCount = 0,
            nextAttemptAtEpochMs = 0,
            lastErrorCode = null,
            createdAtEpochMs = 0,
            updatedAtEpochMs = 0,
        )

    private fun receipt(
        operation: OfflineOperationEntity,
        clientSubmissionId: String,
    ) = OfflineOperationReceiptEntity(
        operationId = operation.operationId,
        accountId = operation.accountId,
        projectId = operation.projectId,
        actorId = operation.actorId,
        installationId = operation.installationId,
        sessionId = operation.sessionId,
        clientSubmissionId = clientSubmissionId,
        qaItemId = "bug-a",
        qaItemKey = "QA-1",
        bugId = "bug-a",
        occurrenceId = "occurrence-a",
        eventId = "event-a",
        replayed = false,
        responseJson = "{\"clientSubmissionId\":\"$clientSubmissionId\"}",
        receivedAtEpochMs = 3,
    )
}
