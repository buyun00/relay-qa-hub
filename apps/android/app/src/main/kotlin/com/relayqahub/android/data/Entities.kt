package com.relayqahub.android.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.TypeConverter

@Entity(tableName = "accounts")
data class AccountEntity(
    @PrimaryKey val accountId: String,
    val displayName: String,
    val updatedAtEpochMs: Long,
)

@Entity(
    tableName = "projects",
    primaryKeys = ["accountId", "projectId"],
    foreignKeys = [
        ForeignKey(
            entity = AccountEntity::class,
            parentColumns = ["accountId"],
            childColumns = ["accountId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("accountId")],
)
data class ProjectEntity(
    val accountId: String,
    val projectId: String,
    val projectKey: String,
    val displayName: String,
    val updatedAtEpochMs: Long,
)

@Entity(
    tableName = "cached_qa_items",
    primaryKeys = ["accountId", "projectId", "remoteId"],
    foreignKeys = [
        ForeignKey(
            entity = ProjectEntity::class,
            parentColumns = ["accountId", "projectId"],
            childColumns = ["accountId", "projectId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["accountId", "projectId"])],
)
data class CachedQaItemEntity(
    val accountId: String,
    val projectId: String,
    val remoteId: String,
    val itemKey: String,
    val title: String,
    val state: String,
    val serverVersion: Long,
    val payloadJson: String,
    val updatedAtEpochMs: Long,
)

enum class QueueState {
    PENDING,
    RUNNING,
    RETRY,
    BLOCKED_AUTH,
    BLOCKED_DEVICE,
    FAILED_PERMANENT,
    SUCCEEDED,
}

@Entity(
    tableName = "offline_operations",
    foreignKeys = [
        ForeignKey(
            entity = ProjectEntity::class,
            parentColumns = ["accountId", "projectId"],
            childColumns = ["accountId", "projectId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index(
            value = [
                "accountId",
                "projectId",
                "actorId",
                "installationId",
                "sessionId",
                "state",
                "nextAttemptAtEpochMs",
            ],
        ),
        Index(
            value = [
                "accountId",
                "projectId",
                "actorId",
                "installationId",
                "sessionId",
                "idempotencyKey",
            ],
            unique = true,
        ),
    ],
)
data class OfflineOperationEntity(
    @PrimaryKey val operationId: String,
    val accountId: String,
    val projectId: String,
    val actorId: String,
    val installationId: String,
    val sessionId: String,
    val operationKind: String,
    val httpMethod: String,
    val relativePath: String,
    val payloadJson: String,
    val idempotencyKey: String,
    val state: QueueState,
    val attemptCount: Int,
    val nextAttemptAtEpochMs: Long,
    val lastErrorCode: String?,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
)

@Entity(
    tableName = "offline_operation_receipts",
    foreignKeys = [
        ForeignKey(
            entity = OfflineOperationEntity::class,
            parentColumns = ["operationId"],
            childColumns = ["operationId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index("operationId", unique = true),
        Index(value = ["accountId", "projectId", "qaItemId"]),
        Index(
            value = [
                "accountId",
                "projectId",
                "actorId",
                "installationId",
                "sessionId",
                "clientSubmissionId",
            ],
            unique = true,
        ),
    ],
)
data class OfflineOperationReceiptEntity(
    @PrimaryKey val operationId: String,
    val accountId: String,
    val projectId: String,
    val actorId: String,
    val installationId: String,
    val sessionId: String,
    val clientSubmissionId: String,
    val qaItemId: String,
    val qaItemKey: String,
    val bugId: String,
    val occurrenceId: String,
    val eventId: String,
    val replayed: Boolean,
    val responseJson: String,
    val receivedAtEpochMs: Long,
) {
    init {
        require(operationId.isNotBlank())
        require(accountId.isNotBlank())
        require(projectId.isNotBlank())
        require(actorId.isNotBlank())
        require(installationId.isNotBlank())
        require(sessionId.isNotBlank())
        require(clientSubmissionId.isNotBlank())
        require(qaItemId.isNotBlank() && bugId == qaItemId)
        require(qaItemKey.isNotBlank())
        require(occurrenceId.isNotBlank())
        require(eventId.isNotBlank())
        require(responseJson.toByteArray(Charsets.UTF_8).size <= 256 * 1024)
        require(receivedAtEpochMs >= 0)
    }
}

@Entity(
    tableName = "attachment_pipeline_receipts",
    primaryKeys = ["accountId", "projectId", "clientSubmissionId", "clientAttachmentId"],
    foreignKeys = [
        ForeignKey(
            entity = ProjectEntity::class,
            parentColumns = ["accountId", "projectId"],
            childColumns = ["accountId", "projectId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index(
            name = "attachment_receipts_scope_idx",
            value = [
                "accountId",
                "projectId",
                "actorId",
                "installationId",
                "sessionId",
            ],
        ),
        Index(
            name = "attachment_receipts_attachment_idx",
            value = ["accountId", "projectId", "attachmentId"],
            unique = true,
        ),
    ],
)
data class AttachmentPipelineReceiptEntity(
    val accountId: String,
    val projectId: String,
    val actorId: String,
    val installationId: String,
    val sessionId: String,
    val clientSubmissionId: String,
    val clientAttachmentId: String,
    val attachmentId: String,
    val bindingId: String,
    val bindingStatus: String,
    val qaItemId: String?,
    val qaItemKey: String?,
    val responseJson: String,
    val updatedAtEpochMs: Long,
) {
    init {
        require(
            listOf(
                accountId,
                projectId,
                actorId,
                installationId,
                sessionId,
                clientSubmissionId,
                clientAttachmentId,
                attachmentId,
                bindingId,
            ).all(String::isNotBlank),
        )
        require(bindingStatus in setOf("reserved", "claimed"))
        if (bindingStatus == "reserved") {
            require(qaItemId == null && qaItemKey == null)
        } else {
            require(!qaItemId.isNullOrBlank() && !qaItemKey.isNullOrBlank())
        }
        require(responseJson.toByteArray(Charsets.UTF_8).size <= 256 * 1024)
        require(updatedAtEpochMs >= 0)
    }
}

class DatabaseConverters {
    @TypeConverter
    fun queueStateToString(value: QueueState): String = value.name

    @TypeConverter
    fun stringToQueueState(value: String): QueueState = QueueState.valueOf(value)
}
