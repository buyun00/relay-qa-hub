package com.relayqahub.android.network

import java.util.UUID
import kotlinx.serialization.json.*

enum class RelayRecordSource(val label: String, val endpoint: String) {
    BATCHES("本地批次", "batches"),
    OUTBOX("Bug 投递记录", "outbox"),
    TASKS("远端任务", "tasks"),
}

data class RelayRecord(
    val id: String,
    val projectId: String,
    val source: RelayRecordSource,
    val state: String,
    val title: String,
    val componentVersion: Long?,
    val updatedAt: String?,
    val summary: String,
    val raw: String,
) {
    val canResume: Boolean get() = when (source) {
        RelayRecordSource.OUTBOX -> state == "paused"
        RelayRecordSource.BATCHES -> state in setOf("paused", "failed", "partial_failure")
        RelayRecordSource.TASKS -> false
    }
}

data class RelayOperation(val projectId: String, val path: String, val method: String = "GET", val body: String? = null)

/** Immutable record IDs select the server's original project/version snapshot. */
object RelayOperations {
    private val batchId = Regex("[a-f0-9]{64}")
    private val externalId = Regex("[A-Za-z0-9._:-]{1,100}")
    private val actions = setOf("continue", "cancel", "retry", "reopen", "finish", "merge")

    fun list(projectId: String, source: RelayRecordSource): RelayOperation =
        RelayOperation(project(projectId), "production/${source.endpoint}?projectId=$projectId")

    fun detail(record: RelayRecord): RelayOperation {
        require(record.source != RelayRecordSource.OUTBOX) { "OUTBOX_HAS_NO_DETAIL_ROUTE" }
        return RelayOperation(project(record.projectId), "production/${record.source.endpoint}/${id(record.id, record.source)}?projectId=${record.projectId}")
    }

    fun resume(record: RelayRecord, componentReady: Boolean): RelayOperation {
        require(componentReady) { "COMPONENT_DISABLED" }
        require(record.canResume) { "TASK_NOT_PAUSED_OR_FAILED" }
        require(record.componentVersion != null && record.componentVersion > 0) { "COMPONENT_VERSION_MISSING" }
        val suffix = if (record.source == RelayRecordSource.OUTBOX) "resume" else "retry"
        return RelayOperation(project(record.projectId), "production/${record.source.endpoint}/${id(record.id, record.source)}/$suffix", "POST", "{}")
    }

    fun action(record: RelayRecord, action: String, componentReady: Boolean, message: String = "", confirmMerge: Boolean = false): RelayOperation {
        require(componentReady) { "COMPONENT_DISABLED" }
        require(record.source == RelayRecordSource.TASKS && action in actions) { "INVALID_RELAY_ACTION" }
        require(!record.updatedAt.isNullOrBlank() && record.updatedAt.length <= 40) { "TASK_UPDATED_AT_MISSING" }
        require(action != "merge" || confirmMerge) { "MERGE_CONFIRMATION_REQUIRED" }
        require(action != "continue" || (message.isNotBlank() && message.length <= 20_000)) { "CONTINUE_MESSAGE_REQUIRED" }
        val body = buildJsonObject {
            put("projectId", project(record.projectId))
            put("requestId", UUID.randomUUID().toString())
            put("kind", "action")
            putJsonArray("items") {
                add(buildJsonObject {
                    put("taskId", id(record.id, record.source))
                    put("expectedUpdatedAt", record.updatedAt)
                    put("action", action)
                    put("confirmMerge", action == "merge" && confirmMerge)
                    if (action == "continue") {
                        put("message", message)
                        put("uploadIds", JsonArray(emptyList()))
                        put("selectedAttachmentIds", JsonArray(emptyList()))
                    }
                })
            }
        }
        return RelayOperation(record.projectId, "production/batches", "POST", body.toString())
    }

    fun create(projectId: String, title: String, message: String): RelayOperation {
        require(title.isNotBlank() && title.length <= 200 && message.isNotBlank() && message.length <= 20_000)
        val body = buildJsonObject {
            put("projectId", project(projectId))
            put("requestId", UUID.randomUUID().toString())
            put("kind", "create")
            putJsonArray("items") { add(buildJsonObject {
                put("title", title); put("message", message); put("uploadIds", JsonArray(emptyList()))
            }) }
        }
        return RelayOperation(projectId, "production/batches", "POST", body.toString())
    }

    fun records(json: String, projectId: String, source: RelayRecordSource): List<RelayRecord> {
        project(projectId)
        val root = Json.parseToJsonElement(json).jsonObject
        require(root.text("projectId") == projectId || (source == RelayRecordSource.TASKS && root.text("projectId") == null)) { "PROJECT_MISMATCH" }
        return root.getValue("items").jsonArray.map { record(it.jsonObject, projectId, source) }
    }

    fun taskDetail(json: String, projectId: String, expectedTaskId: String): RelayRecord {
        val root = Json.parseToJsonElement(json).jsonObject
        require(root.text("projectId") == null || root.text("projectId") == projectId) { "PROJECT_MISMATCH" }
        val task = root["task"]?.jsonObject ?: root
        return record(task, projectId, RelayRecordSource.TASKS).also {
            require(it.id == expectedTaskId) { "TASK_MISMATCH" }
        }
    }

    private fun record(item: JsonObject, projectId: String, source: RelayRecordSource): RelayRecord {
        require(item.text("projectId") == null || item.text("projectId") == projectId) { "PROJECT_MISMATCH" }
        val version = item["componentVersion"]?.jsonPrimitive?.longOrNull
        if (source != RelayRecordSource.TASKS) require(version != null && version > 0) { "COMPONENT_VERSION_MISSING" }
        val state = item.text("state") ?: item.text("status") ?: "unknown"
        val summary = listOf("bugId" to "Bug", "handoffId" to "交接", "relayTaskId" to "远端任务", "attemptCount" to "尝试次数", "errorCode" to "错误", "createdAt" to "创建", "submittedAt" to "投递")
            .mapNotNull { (key, label) -> item.text(key)?.let { "$label：$it" } }.joinToString("\n")
        return RelayRecord(id(requireNotNull(item.text("id")), source), projectId, source, state,
            item.text("title") ?: item.text("name") ?: source.label, version, item.text("updatedAt")?.takeIf { it.length <= 40 }, summary, item.toString())
    }

    private fun project(value: String): String = UUID.fromString(value).toString().also { require(it == value.lowercase()) }
    private fun id(value: String, source: RelayRecordSource): String {
        require(if (source == RelayRecordSource.BATCHES) batchId.matches(value) else externalId.matches(value)) { "INVALID_RELAY_RECORD_ID" }
        if (source == RelayRecordSource.OUTBOX) project(value)
        return value
    }
    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank)
}
