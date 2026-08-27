package com.relayqahub.android.network

import com.relayqahub.android.data.OfflineOperationEntity
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

internal data class CreateBugRequestScope(
    val clientSubmissionId: String,
    val projectId: String,
    val actorId: String,
    val attachmentIds: List<String>,
    val captureBundleId: String?,
    val ownerId: String?,
    val verificationOwnerId: String?,
)

internal class SuccessResponseViolation(
    val errorCode: String,
    val retryable: Boolean,
) : IllegalArgumentException(errorCode)

/**
 * Strict App-first createBug response validator.
 *
 * A transport-level 201 is not a durable success until the response is proven to belong to the
 * exact queued submission and authenticated project/actor scope. This deliberately mirrors the
 * frozen 1.1 schema instead of accepting a loosely shaped JSON object.
 */
internal object CreateBugSuccessResponseValidator {
    private val json = Json {
        isLenient = false
        ignoreUnknownKeys = false
        allowSpecialFloatingPointValues = false
    }
    private val uuidPattern = Regex(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )
    private val qaItemKeyPattern = Regex("^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]*$")
    private val bugStates = setOf(
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
    )
    private val severities = setOf("S0", "S1", "S2", "S3", "S4")
    private val priorities = setOf("P0", "P1", "P2", "P3", "P4")
    private val responseKeys = setOf(
        "clientSubmissionId",
        "qaItem",
        "disposition",
        "bug",
        "occurrenceId",
        "attachmentIds",
        "captureBundleId",
        "eventId",
        "replayed",
    )
    private val qaItemKeys = setOf("type", "id", "key")
    private val bugKeys = setOf(
        "id",
        "projectId",
        "number",
        "key",
        "title",
        "description",
        "expectedBehavior",
        "moduleId",
        "state",
        "severity",
        "priority",
        "reporterId",
        "ownerId",
        "verificationOwnerId",
        "duplicateOfBugId",
        "occurrenceCount",
        "reopenCount",
        "version",
        "createdAt",
        "updatedAt",
        "closedAt",
    )

    fun requireQueuedOperation(operation: OfflineOperationEntity): CreateBugRequestScope {
        require(operation.operationKind == "CREATE_BUG")
        require(operation.httpMethod == "POST")
        require(operation.relativePath == "/bugs")
        requireUuid(operation.operationId, "operationId")
        requireUuid(operation.accountId, "accountId")
        requireUuid(operation.projectId, "projectId")
        requireUuid(operation.actorId, "actorId")
        requireUuid(operation.installationId, "installationId")
        requireUuid(operation.sessionId, "sessionId")
        val request = parseObject(operation.payloadJson, queuedRequest = true)
        val submissionId = requireUuid(
            requireString(request, "clientSubmissionId", 1, 100, queuedRequest = true),
            "clientSubmissionId",
        )
        val requestProjectId = requireUuid(
            requireString(request, "projectId", 1, 100, queuedRequest = true),
            "projectId",
        )
        require(requestProjectId == operation.projectId)
        require(operation.idempotencyKey == "submission:$submissionId:commit")
        val attachmentIds = request["attachmentIds"]?.let { element ->
            requireUuidArray(element, "attachmentIds", maxItems = 20, queuedRequest = true)
        } ?: emptyList()
        val captureBundleId = when (val capture = request["captureBundleId"]) {
            null, JsonNull -> null
            else -> requireUuid(
                requireString(capture, "captureBundleId", 1, 100, queuedRequest = true),
                "captureBundleId",
            )
        }
        val ownerId = queuedOptionalUuid(request, "ownerId")
        val verificationOwnerId = queuedOptionalUuid(request, "verificationOwnerId")
        return CreateBugRequestScope(
            clientSubmissionId = submissionId,
            projectId = requestProjectId,
            actorId = operation.actorId,
            attachmentIds = attachmentIds,
            captureBundleId = captureBundleId,
            ownerId = ownerId,
            verificationOwnerId = verificationOwnerId,
        )
    }

    fun validate(
        operation: OfflineOperationEntity,
        responseJson: String,
    ): CreateBugReceipt {
        val expected = try {
            requireQueuedOperation(operation)
        } catch (failure: IllegalArgumentException) {
            throw SuccessResponseViolation("INVALID_QUEUED_REQUEST", retryable = false)
        }
        val root = parseObject(responseJson, queuedRequest = false)
        requireExactKeys(root, responseKeys, "createBug response")

        val submissionId = responseUuid(root, "clientSubmissionId")
        requireScope(submissionId == expected.clientSubmissionId)
        requireSchema(responseString(root, "disposition", 7, 7) == "created")

        val qaItem = responseObject(root, "qaItem")
        requireExactKeys(qaItem, qaItemKeys, "qaItem")
        requireSchema(responseString(qaItem, "type", 3, 3) == "bug")
        val qaItemId = responseUuid(qaItem, "id")
        val qaItemKey = responseString(qaItem, "key", 3, 64)
        requireSchema(qaItemKey.matches(qaItemKeyPattern))

        val bug = responseObject(root, "bug")
        requireExactKeys(bug, bugKeys, "bug")
        val bugId = responseUuid(bug, "id")
        val bugProjectId = responseUuid(bug, "projectId")
        val bugNumber = responsePositiveLong(bug, "number", minimum = 1)
        val bugKey = responseString(bug, "key", 3, 64)
        requireScope(bugProjectId == expected.projectId)
        requireSchema(qaItemId == bugId && qaItemKey == bugKey)
        requireSchema(bugKey.matches(qaItemKeyPattern))
        requireSchema(bugKey.substringAfterLast('-').toLongOrNull() == bugNumber)
        responseString(bug, "title", 1, 300)
        responseString(bug, "description", 1, 20_000)
        responseString(bug, "expectedBehavior", 1, 10_000)
        responseNullableUuid(bug, "moduleId")
        requireSchema(responseString(bug, "state", 1, 64) in bugStates)
        requireSchema(responseString(bug, "severity", 2, 2) in severities)
        requireSchema(responseString(bug, "priority", 2, 2) in priorities)
        val reporterId = responseUuid(bug, "reporterId")
        requireScope(reporterId == expected.actorId)
        requireScope(responseNullableUuid(bug, "ownerId") == expected.ownerId)
        requireScope(
            responseNullableUuid(bug, "verificationOwnerId") == expected.verificationOwnerId,
        )
        responseNullableUuid(bug, "duplicateOfBugId")
        responsePositiveLong(bug, "occurrenceCount", minimum = 1)
        responsePositiveLong(bug, "reopenCount", minimum = 0)
        responsePositiveLong(bug, "version", minimum = 1)
        responseDateTime(bug, "createdAt")
        responseDateTime(bug, "updatedAt")
        responseNullableDateTime(bug, "closedAt")

        val occurrenceId = responseUuid(root, "occurrenceId")
        val attachmentIds = requireUuidArray(
            root.getValue("attachmentIds"),
            "attachmentIds",
            maxItems = 20,
            queuedRequest = false,
        )
        requireScope(
            attachmentIds.size == expected.attachmentIds.size &&
                attachmentIds.toSet() == expected.attachmentIds.toSet(),
        )
        val captureBundleId = responseNullableUuid(root, "captureBundleId")
        requireScope(captureBundleId == expected.captureBundleId)
        val eventId = responseUuid(root, "eventId")
        val replayed = responseBoolean(root, "replayed")

        return CreateBugReceipt(
            clientSubmissionId = submissionId,
            qaItemId = qaItemId,
            qaItemKey = qaItemKey,
            bugId = bugId,
            projectId = bugProjectId,
            occurrenceId = occurrenceId,
            eventId = eventId,
            replayed = replayed,
            responseJson = responseJson,
        )
    }

    private fun parseObject(value: String, queuedRequest: Boolean): JsonObject {
        val parsed = runCatching { json.parseToJsonElement(value) }.getOrElse {
            if (queuedRequest) throw IllegalArgumentException("Queued request is not JSON", it)
            throw SuccessResponseViolation("INVALID_SUCCESS_JSON", retryable = true)
        }
        return parsed as? JsonObject ?: if (queuedRequest) {
            throw IllegalArgumentException("Queued request must be an object")
        } else {
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
    }

    private fun requireExactKeys(value: JsonObject, expected: Set<String>, label: String) {
        if (value.keys != expected) {
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
    }

    private fun responseObject(value: JsonObject, key: String): JsonObject =
        value[key] as? JsonObject
            ?: throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)

    private fun responseString(
        value: JsonObject,
        key: String,
        minLength: Int,
        maxLength: Int,
    ): String = requireString(
        value.getValue(key),
        key,
        minLength,
        maxLength,
        queuedRequest = false,
    )

    private fun requireString(
        value: JsonObject,
        key: String,
        minLength: Int,
        maxLength: Int,
        queuedRequest: Boolean,
    ): String = requireString(
        value[key] ?: if (queuedRequest) {
            throw IllegalArgumentException("$key is missing")
        } else {
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        },
        key,
        minLength,
        maxLength,
        queuedRequest,
    )

    private fun requireString(
        element: JsonElement,
        key: String,
        minLength: Int,
        maxLength: Int,
        queuedRequest: Boolean,
    ): String {
        val primitive = element as? JsonPrimitive
        val value = primitive?.takeIf(JsonPrimitive::isString)?.content
        if (value == null || value.length !in minLength..maxLength) {
            if (queuedRequest) throw IllegalArgumentException("$key must be a bounded string")
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
        return value
    }

    private fun responseUuid(value: JsonObject, key: String): String =
        requireUuid(responseString(value, key, 1, 100), key, queuedRequest = false)

    private fun requireUuid(value: String, key: String, queuedRequest: Boolean = true): String {
        if (!value.matches(uuidPattern) || runCatching { UUID.fromString(value) }.isFailure) {
            if (queuedRequest) throw IllegalArgumentException("$key must be a UUID")
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
        return value.lowercase()
    }

    private fun requireUuidArray(
        element: JsonElement,
        key: String,
        maxItems: Int,
        queuedRequest: Boolean,
    ): List<String> {
        val values = element as? JsonArray
        if (values == null || values.size > maxItems) {
            if (queuedRequest) throw IllegalArgumentException("$key must be a bounded array")
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
        val result = values.mapIndexed { index, item ->
            val text = (item as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
            if (text == null) {
                if (queuedRequest) throw IllegalArgumentException("$key[$index] must be a UUID")
                throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
            }
            requireUuid(text, "$key[$index]", queuedRequest)
        }
        if (result.distinct().size != result.size) {
            if (queuedRequest) throw IllegalArgumentException("$key must contain unique values")
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
        return result
    }

    private fun responseNullableUuid(value: JsonObject, key: String): String? {
        val element = value[key]
            ?: throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        if (element is JsonNull) return null
        val string = (element as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
            ?: throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        return requireUuid(string, key, queuedRequest = false)
    }

    private fun queuedOptionalUuid(value: JsonObject, key: String): String? =
        when (val element = value[key]) {
            null, JsonNull -> null
            else -> requireUuid(
                requireString(element, key, 1, 100, queuedRequest = true),
                key,
                queuedRequest = true,
            )
        }

    private fun responsePositiveLong(value: JsonObject, key: String, minimum: Long): Long {
        val primitive = value[key] as? JsonPrimitive
        val number = primitive?.takeUnless(JsonPrimitive::isString)?.longOrNull
        if (number == null || number < minimum) {
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
        return number
    }

    private fun responseBoolean(value: JsonObject, key: String): Boolean {
        val primitive = value[key] as? JsonPrimitive
        return primitive?.takeUnless(JsonPrimitive::isString)?.booleanOrNull
            ?: throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
    }

    private fun responseDateTime(value: JsonObject, key: String): String {
        val dateTime = responseString(value, key, 1, 100)
        requireSchema(runCatching { OffsetDateTime.parse(dateTime) }.isSuccess)
        return dateTime
    }

    private fun responseNullableDateTime(value: JsonObject, key: String): String? {
        val element = value[key]
            ?: throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        if (element is JsonNull) return null
        val dateTime = (element as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
            ?: throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        requireSchema(dateTime.length <= 100 && runCatching { OffsetDateTime.parse(dateTime) }.isSuccess)
        return dateTime
    }

    private fun requireSchema(condition: Boolean) {
        if (!condition) {
            throw SuccessResponseViolation("INVALID_SUCCESS_SCHEMA", retryable = true)
        }
    }

    private fun requireScope(condition: Boolean) {
        if (!condition) {
            throw SuccessResponseViolation("SUCCESS_RESPONSE_SCOPE_MISMATCH", retryable = false)
        }
    }
}
