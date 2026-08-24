package com.relayqahub.android.network

import com.relayqahub.android.data.OfflineOperationEntity
import java.security.MessageDigest

object QaHubApiContract {
    const val VERSION = "1.1.0"
    const val VERSIONED_JSON = "application/vnd.relay-qa-hub.v1.1+json"
    const val JSON_ACCEPT =
        "application/vnd.relay-qa-hub.v1.1+json, application/json;q=0.9"
}

sealed interface ApiOutcome {
    data class Success(
        val httpStatus: Int,
        val createBugReceipt: CreateBugReceipt? = null,
    ) : ApiOutcome
    data class Retryable(val errorCode: String) : ApiOutcome
    data class AuthExpired(val errorCode: String = "NATIVE_SESSION_EXPIRED") : ApiOutcome
    data class PermanentFailure(val errorCode: String) : ApiOutcome
}

data class CreateBugReceipt(
    val clientSubmissionId: String,
    val qaItemId: String,
    val qaItemKey: String,
    val bugId: String,
    val projectId: String,
    val occurrenceId: String,
    val eventId: String,
    val replayed: Boolean,
    val responseJson: String,
)

interface QaHubApiClient {
    suspend fun execute(
        operation: OfflineOperationEntity,
        accessToken: String,
    ): ApiOutcome
}

data class RecordedApiCall(
    val operationId: String,
    val operationKind: String,
    val accountId: String,
    val projectId: String,
    val actorId: String,
    val installationId: String,
    val sessionId: String,
    val httpMethod: String,
    val relativePath: String,
    val payloadJson: String,
    val idempotencyKey: String,
    val contractVersion: String,
)

class FakeQaHubApiClient(
    outcomes: List<ApiOutcome> = emptyList(),
    private val defaultOutcome: ApiOutcome? = null,
) : QaHubApiClient {
    private val scriptedOutcomes = ArrayDeque(outcomes)
    private val mutableCalls = mutableListOf<RecordedApiCall>()

    val calls: List<RecordedApiCall>
        get() = mutableCalls.toList()

    override suspend fun execute(
        operation: OfflineOperationEntity,
        accessToken: String,
    ): ApiOutcome {
        require(accessToken.isNotBlank())
        mutableCalls += RecordedApiCall(
            operationId = operation.operationId,
            operationKind = operation.operationKind,
            accountId = operation.accountId,
            projectId = operation.projectId,
            actorId = operation.actorId,
            installationId = operation.installationId,
            sessionId = operation.sessionId,
            httpMethod = operation.httpMethod,
            relativePath = operation.relativePath,
            payloadJson = operation.payloadJson,
            idempotencyKey = operation.idempotencyKey,
            contractVersion = QaHubApiContract.VERSION,
        )
        return if (scriptedOutcomes.isEmpty()) {
            defaultOutcome ?: ApiOutcome.Success(201, operation.syntheticCreateBugReceipt())
        } else {
            scriptedOutcomes.removeFirst()
        }
    }
}

/**
 * Stateful fake for the offline reconciliation invariant: a server effect can commit before the
 * response is lost, and an exact idempotent replay must return the original receipt without
 * applying the effect twice.
 */
class IdempotentReconcileFakeQaHubApiClient(
    private val loseFirstResponseFor: Set<String>,
) : QaHubApiClient {
    private data class RequestIdentity(
        val accountId: String,
        val projectId: String,
        val actorId: String,
        val installationId: String,
        val sessionId: String,
        val operationKind: String,
        val httpMethod: String,
        val relativePath: String,
        val payloadJson: String,
    )

    private data class CommittedEffect(
        val identity: RequestIdentity,
        val receipt: CreateBugReceipt,
    )

    private val effectsByIdempotencyKey = linkedMapOf<String, CommittedEffect>()
    private val lostResponses = mutableSetOf<String>()
    private val mutableObservedPayloads = mutableListOf<String>()
    private val mutableObservedIdempotencyKeys = mutableListOf<String>()
    private val mutableReturnedReceiptIds = mutableListOf<String>()

    val effectCount: Int
        get() = effectsByIdempotencyKey.size
    val observedPayloads: List<String>
        get() = mutableObservedPayloads.toList()
    val observedIdempotencyKeys: List<String>
        get() = mutableObservedIdempotencyKeys.toList()
    val returnedReceiptIds: List<String>
        get() = mutableReturnedReceiptIds.toList()

    fun receiptFor(idempotencyKey: String): String? =
        effectsByIdempotencyKey[idempotencyKey]?.receipt?.qaItemId

    override suspend fun execute(
        operation: OfflineOperationEntity,
        accessToken: String,
    ): ApiOutcome {
        require(accessToken.isNotBlank())
        mutableObservedPayloads += operation.payloadJson
        mutableObservedIdempotencyKeys += operation.idempotencyKey
        val identity = operation.requestIdentity()
        val existing = effectsByIdempotencyKey[operation.idempotencyKey]
        if (existing != null) {
            if (existing.identity != identity) {
                return ApiOutcome.PermanentFailure("IDEMPOTENCY_KEY_REUSE_MISMATCH")
            }
            mutableReturnedReceiptIds += existing.receipt.qaItemId
            return ApiOutcome.Success(
                201,
                existing.receipt.copy(replayed = true),
            )
        }

        val receipt = CommittedEffect(
            identity = identity,
            receipt = operation.syntheticCreateBugReceipt(),
        )
        effectsByIdempotencyKey[operation.idempotencyKey] = receipt
        if (
            operation.idempotencyKey in loseFirstResponseFor &&
            lostResponses.add(operation.idempotencyKey)
        ) {
            return ApiOutcome.Retryable("RESPONSE_LOST_AFTER_COMMIT")
        }
        mutableReturnedReceiptIds += receipt.receipt.qaItemId
        return ApiOutcome.Success(201, receipt.receipt)
    }

    private fun OfflineOperationEntity.requestIdentity(): RequestIdentity = RequestIdentity(
        accountId = accountId,
        projectId = projectId,
        actorId = actorId,
        installationId = installationId,
        sessionId = sessionId,
        operationKind = operationKind,
        httpMethod = httpMethod,
        relativePath = relativePath,
        payloadJson = payloadJson,
    )

    private fun String.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
        .digest(toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}

internal fun OfflineOperationEntity.syntheticCreateBugReceipt(): CreateBugReceipt {
    val digest = idempotencyKey.sha256Hex()
    val submissionId = idempotencyKey
        .removePrefix("submission:")
        .removeSuffix(":commit")
    val qaItemId = digest.asDeterministicUuid()
    return CreateBugReceipt(
        clientSubmissionId = submissionId,
        qaItemId = qaItemId,
        qaItemKey = "LOCAL-${digest.take(7).toLong(16).coerceAtLeast(1)}",
        bugId = qaItemId,
        projectId = projectId,
        occurrenceId = digest.drop(8).asDeterministicUuid(),
        eventId = digest.drop(16).asDeterministicUuid(),
        replayed = false,
        responseJson = "{}",
    )
}

private fun String.asDeterministicUuid(): String {
    val value = padEnd(32, '0').take(32)
    return buildString(36) {
        append(value, 0, 8)
        append('-')
        append(value, 8, 12)
        append('-')
        append(value, 12, 16)
        append('-')
        append(value, 16, 20)
        append('-')
        append(value, 20, 32)
    }
}

private fun String.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(toByteArray(Charsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
