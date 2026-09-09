package com.relayqahub.android.network

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.OffsetDateTime
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

enum class RepairMode(val wireName: String) {
    HUMAN("human"),
    RELAY("relay"),
    EXTERNAL("external");

    companion object {
        fun fromWire(value: String): RepairMode = entries.singleOrNull { it.wireName == value }
            ?: error("INVALID_REPAIR_MODE")
    }
}

enum class RepairAttemptStatus(val wireName: String) {
    PLANNED("planned"), QUEUED("queued"), RUNNING("running"), NEEDS_INPUT("needs_input"),
    BLOCKED("blocked"), DELIVERED("delivered"), FAILED("failed"),
    VERIFICATION_FAILED("verification_failed"), CANCELLED("cancelled"), SUPERSEDED("superseded");

    val terminal: Boolean
        get() = this in setOf(DELIVERED, FAILED, VERIFICATION_FAILED, CANCELLED, SUPERSEDED)

    companion object {
        fun fromWire(value: String): RepairAttemptStatus = entries.singleOrNull {
            it.wireName == value
        } ?: error("INVALID_REPAIR_STATUS")
    }
}

/** Frozen fields returned by the Phase C terminal representation. */
data class RepairAttemptRecord(
    val id: String,
    val bugId: String,
    val sequence: Int,
    val mode: RepairMode,
    val status: RepairAttemptStatus,
    val assigneeId: String,
    val parentAttemptId: String?,
    val summary: String?,
    val branch: String?,
    val commitSha: String?,
    val mergeRequestUrl: String?,
    val targetBuildId: String?,
    val version: Int,
)

data class SupersedeRepairAttemptCommand(
    val attemptId: String,
    val expectedVersion: Int,
    val reason: String,
    val successorId: String,
    val successorMode: RepairMode,
    val successorAssigneeId: String,
    val successorSummary: String,
)

data class TerminalBugRecord(
    val id: String,
    val projectId: String,
    val key: String,
    val state: String,
    val version: Int,
)

data class SupersedeRepairAttemptReceipt(
    val supersededAttempt: RepairAttemptRecord,
    val successorAttempt: RepairAttemptRecord,
    val bug: TerminalBugRecord,
    val eventId: String,
    val replayed: Boolean,
)

enum class VerificationStatus(val wireName: String) {
    REQUESTED("requested"), IN_PROGRESS("in_progress"), PASSED("passed"), FAILED("failed"),
    BLOCKED("blocked"), CANCELLED("cancelled");

    companion object {
        fun fromWire(value: String): VerificationStatus = entries.singleOrNull {
            it.wireName == value
        } ?: error("INVALID_VERIFICATION_STATUS")
    }
}

data class VerificationRecord(
    val id: String,
    val bugId: String,
    val repairAttemptId: String,
    val buildId: String?,
    val status: VerificationStatus,
    val verifierId: String,
    val criteriaSnapshot: String,
    val resultSummary: String?,
    val version: Int,
)

enum class VerificationOutcome(val wireName: String) {
    PASSED("passed"), FAILED("failed"), BLOCKED("blocked"),
}

/** A frozen result command; retries must reuse every field, including clientSubmissionId. */
data class VerificationResultCommand(
    val bugId: String,
    val verificationId: String,
    val expectedVersion: Int,
    val outcome: VerificationOutcome,
    val resultSummary: String,
    val clientSubmissionId: String,
    val attachmentIds: List<String>,
    val captureBundleId: String? = null,
    val failureReason: String? = null,
    val blockedReason: String? = null,
)

data class VerificationResultReceipt(
    val clientSubmissionId: String,
    val qaItemKey: String,
    val verification: VerificationRecord,
    val repairAttempt: RepairAttemptRecord,
    val bug: TerminalBugRecord,
    val attachmentIds: List<String>,
    val captureBundleId: String?,
    val eventId: String,
    val replayed: Boolean,
)

/** Explicit workflow actions with exact optimistic versions and frozen vendor responses. */
class BugLifecycleClient(
    private val api: ProjectOperationsClient,
    private val projectId: String,
    private val token: String,
) {
    suspend fun workflow(bugId: String): JSONObject {
        requireUuid(bugId, "bugId")
        val human = api.request("bugs/$bugId/human-workflow", token).also {
            check(it.getString("bugId") == bugId) { "BUG_SCOPE_MISMATCH" }
        }
        val occurrences = linkedMapOf<String, JSONObject>()
        val attempts = linkedMapOf<String, Pair<RepairAttemptRecord, JSONObject>>()
        val sequenceOwners = mutableMapOf<Int, String>()
        val verifications = linkedMapOf<String, Pair<VerificationRecord, JSONObject>>()
        val builds = linkedMapOf<String, JSONObject>()
        val relayReceipts = linkedMapOf<String, JSONObject>()
        val seenCursors = mutableSetOf<String>()
        var frozenSnapshotSequence: Long? = null
        var frozenBugVersion: Int? = null
        var cursor: String? = null
        repeat(MAX_WORKFLOW_PAGES) {
            val cursorQuery = cursor?.let {
                "&cursor=${URLEncoder.encode(it, StandardCharsets.UTF_8.name()).replace("+", "%20")}"
            }.orEmpty()
            val page = api.request(
                "bugs/$bugId/workflow?limitPerCollection=$WORKFLOW_PAGE_SIZE$cursorQuery",
                token,
            )
            val pageFields = page.keys().asSequence().toSet()
            check(pageFields.all(WORKFLOW_PAGE_FIELDS::contains)) {
                "INVALID_WORKFLOW_RESPONSE"
            }
            check(page.has("bugId") && page.get("bugId") is String) { "INVALID_WORKFLOW_RESPONSE" }
            check(page.getString("bugId") == bugId) { "BUG_SCOPE_MISMATCH" }
            val snapshotSequence = page.requiredWorkflowSequence("snapshotSequence")
            val bugVersion = page.requiredWorkflowVersion("bugVersion")
            val truncated = page.requiredWorkflowBoolean("truncated")
            if (frozenSnapshotSequence == null) {
                frozenSnapshotSequence = snapshotSequence
                frozenBugVersion = bugVersion
            } else {
                check(snapshotSequence == frozenSnapshotSequence) {
                    "WORKFLOW_SNAPSHOT_CHANGED"
                }
                check(bugVersion == frozenBugVersion) { "WORKFLOW_BUG_VERSION_CHANGED" }
            }
            val returnedOccurrences = page.requiredWorkflowCollection("occurrences")
            for (index in 0 until returnedOccurrences.length()) {
                val json = returnedOccurrences.optJSONObject(index)
                    ?: error("INVALID_WORKFLOW_OCCURRENCE")
                val occurrenceId = json.validateWorkflowOccurrence(bugId)
                check(occurrences.putIfAbsent(occurrenceId, json) == null) {
                    "WORKFLOW_OCCURRENCE_REPEATED"
                }
                check(occurrences.size <= MAX_WORKFLOW_ITEMS_PER_COLLECTION) {
                    "WORKFLOW_TOO_LARGE"
                }
            }
            val returned = page.requiredWorkflowCollection("repairAttempts")
            for (index in 0 until returned.length()) {
                val json = returned.optJSONObject(index) ?: error("INVALID_REPAIR_ATTEMPT")
                val attempt = json.toRepairAttempt()
                check(attempt.bugId == bugId) { "BUG_SCOPE_MISMATCH" }
                val previous = attempts.putIfAbsent(attempt.id, attempt to json)
                check(previous == null) {
                    "WORKFLOW_ATTEMPT_REPEATED"
                }
                val sequenceOwner = sequenceOwners.putIfAbsent(attempt.sequence, attempt.id)
                check(sequenceOwner == null || sequenceOwner == attempt.id) {
                    "WORKFLOW_ATTEMPT_SEQUENCE_CONFLICT"
                }
                check(attempts.size <= MAX_WORKFLOW_ITEMS_PER_COLLECTION) {
                    "WORKFLOW_TOO_LARGE"
                }
            }
            val returnedVerifications = page.requiredWorkflowCollection("verifications")
            for (index in 0 until returnedVerifications.length()) {
                val json = returnedVerifications.optJSONObject(index)
                    ?: error("INVALID_VERIFICATION")
                val verification = json.toVerification()
                check(verification.bugId == bugId) { "BUG_SCOPE_MISMATCH" }
                check(verifications.putIfAbsent(verification.id, verification to json) == null) {
                    "WORKFLOW_VERIFICATION_REPEATED"
                }
                check(verifications.size <= MAX_WORKFLOW_ITEMS_PER_COLLECTION) {
                    "WORKFLOW_TOO_LARGE"
                }
            }
            val returnedBuilds = page.requiredWorkflowCollection("builds")
            for (index in 0 until returnedBuilds.length()) {
                val json = returnedBuilds.optJSONObject(index) ?: error("INVALID_WORKFLOW_BUILD")
                val buildId = json.validateWorkflowBuild(projectId)
                check(builds.putIfAbsent(buildId, json) == null) { "WORKFLOW_BUILD_REPEATED" }
                check(builds.size <= MAX_WORKFLOW_ITEMS_PER_COLLECTION) { "WORKFLOW_TOO_LARGE" }
            }
            val returnedReceipts = page.requiredWorkflowCollection("relayReceipts")
            for (index in 0 until returnedReceipts.length()) {
                val json = returnedReceipts.optJSONObject(index)
                    ?: error("INVALID_WORKFLOW_RELAY_RECEIPT")
                val receiptId = json.validateWorkflowRelayReceipt(bugId)
                check(relayReceipts.putIfAbsent(receiptId, json) == null) {
                    "WORKFLOW_RELAY_RECEIPT_REPEATED"
                }
                check(relayReceipts.size <= MAX_WORKFLOW_ITEMS_PER_COLLECTION) {
                    "WORKFLOW_TOO_LARGE"
                }
            }
            check(page.has("nextCursor")) { "INVALID_WORKFLOW_CURSOR" }
            val nextCursor = when (val value = page.get("nextCursor")) {
                JSONObject.NULL -> null
                is String -> value
                else -> error("INVALID_WORKFLOW_CURSOR")
            }
            check(truncated == (nextCursor != null)) { "INVALID_WORKFLOW_TRUNCATION" }
            if (nextCursor == null) {
                verifications.values.forEach { (verification, _) ->
                    check(verification.repairAttemptId in attempts) {
                        "WORKFLOW_VERIFICATION_ATTEMPT_MISSING"
                    }
                    verification.buildId?.let { buildId ->
                        check(buildId in builds) { "WORKFLOW_VERIFICATION_BUILD_MISSING" }
                    }
                }
                relayReceipts.values.forEach { receipt ->
                    check(receipt.getString("repairAttemptId") in attempts) {
                        "WORKFLOW_RELAY_ATTEMPT_MISSING"
                    }
                    receipt.nullableString("buildId")?.let { buildId ->
                        check(buildId in builds) { "WORKFLOW_RELAY_BUILD_MISSING" }
                    }
                }
                val latest = attempts.values.maxByOrNull { it.first.sequence }?.second
                return JSONObject(human.toString())
                    .put(
                        "repairAttempt",
                        latest ?: human.optJSONObject("repairAttempt") ?: JSONObject.NULL,
                    )
                    .put("snapshotSequence", checkNotNull(frozenSnapshotSequence))
                    .put("bugVersion", checkNotNull(frozenBugVersion))
                    .put("truncated", false)
                    .put("nextCursor", JSONObject.NULL)
                    .put("occurrences", JSONArray(occurrences.values.toList()))
                    .put("repairAttempts", JSONArray(attempts.values.map { it.second }))
                    .put("verifications", JSONArray(verifications.values.map { it.second }))
                    .put("builds", JSONArray(builds.values.toList()))
                    .put("relayReceipts", JSONArray(relayReceipts.values.toList()))
            }
            check(
                nextCursor.isNotBlank() && nextCursor.length <= 500 && seenCursors.add(nextCursor),
            ) {
                "INVALID_WORKFLOW_CURSOR"
            }
            cursor = nextCursor
        }
        error("WORKFLOW_TOO_LARGE")
    }

    suspend fun events(bugId: String): JSONObject {
        requireUuid(bugId, "bugId")
        return readHistory(bugId, "bugs/$bugId/events", "EVENT")
    }

    suspend fun comments(bugId: String): JSONObject {
        requireUuid(bugId, "bugId")
        return readHistory(bugId, "projects/$projectId/bugs/$bugId/comments", "COMMENT")
    }

    private suspend fun readHistory(
        bugId: String,
        basePath: String,
        kind: String,
    ): JSONObject {
        val items = JSONArray()
        val seenCursors = mutableSetOf<String>()
        var frozenSnapshotSequence: Long? = null
        var cursor: String? = null
        repeat(MAX_HISTORY_PAGES) {
            val cursorQuery = cursor?.let {
                "&cursor=${URLEncoder.encode(it, StandardCharsets.UTF_8.name()).replace("+", "%20")}"
            }.orEmpty()
            val page = api.request(
                "$basePath?limit=$HISTORY_PAGE_SIZE$cursorQuery",
                token,
            )
            check(page.keys().asSequence().toSet() == HISTORY_PAGE_FIELDS) {
                "INVALID_${kind}_HISTORY_RESPONSE"
            }
            check(
                page.get("projectId") is String && page.get("bugId") is String,
            ) { "INVALID_${kind}_HISTORY_RESPONSE" }
            check(
                page.getString("projectId") == projectId && page.getString("bugId") == bugId,
            ) { "HISTORY_SCOPE_MISMATCH" }
            val snapshotSequence = when (val value = page.get("snapshotSequence")) {
                is Byte, is Short, is Int, is Long -> (value as Number).toLong()
                else -> error("INVALID_${kind}_HISTORY_RESPONSE")
            }
            check(snapshotSequence in 0..MAX_SAFE_JSON_INTEGER) {
                "INVALID_${kind}_HISTORY_RESPONSE"
            }
            if (frozenSnapshotSequence == null) {
                frozenSnapshotSequence = snapshotSequence
            } else {
                check(snapshotSequence == frozenSnapshotSequence) { "${kind}_SNAPSHOT_CHANGED" }
            }
            val returnedItems = page.optJSONArray("items")
                ?: error("INVALID_${kind}_HISTORY_RESPONSE")
            check(returnedItems.length() <= HISTORY_PAGE_SIZE) {
                "INVALID_${kind}_HISTORY_RESPONSE"
            }
            for (index in 0 until returnedItems.length()) {
                items.put(
                    returnedItems.optJSONObject(index)
                        ?: error("INVALID_${kind}_HISTORY_RESPONSE"),
                )
                check(items.length() <= MAX_HISTORY_ITEMS) { "${kind}_HISTORY_TOO_LARGE" }
            }
            check(page.has("nextCursor")) { "INVALID_${kind}_HISTORY_RESPONSE" }
            val nextCursor = when (val value = page.get("nextCursor")) {
                JSONObject.NULL -> null
                is String -> value.also {
                    check(it.isNotBlank() && it.length <= 500) {
                        "INVALID_${kind}_HISTORY_RESPONSE"
                    }
                }
                else -> error("INVALID_${kind}_HISTORY_RESPONSE")
            }
            if (nextCursor == null) {
                return JSONObject()
                    .put("projectId", projectId)
                    .put("bugId", bugId)
                    .put("snapshotSequence", checkNotNull(frozenSnapshotSequence))
                    .put("items", items)
                    .put("nextCursor", JSONObject.NULL)
            }
            check(seenCursors.add(nextCursor)) { "${kind}_CURSOR_REPEATED" }
            cursor = nextCursor
        }
        error("${kind}_PAGE_LIMIT_EXCEEDED")
    }

    private suspend fun readBug(bug: WorkbenchBug): JSONObject =
        api.request("bugs/${bug.id}", token).also {
            check(
                bug.projectId == projectId &&
                    it.getString("id") == bug.id &&
                    it.getString("projectId") == projectId
            ) { "BUG_SCOPE_MISMATCH" }
        }

    private suspend fun current(bug: WorkbenchBug): JSONObject = readBug(bug).also {
        check(it.getInt("version") == bug.version) { "VERSION_CONFLICT" }
    }

    suspend fun manualComplete(bug: WorkbenchBug, note: String) {
        current(bug)
        api.request(
            "bugs/${bug.id}/manual-complete", token, "POST",
            JSONObject().put("expectedVersion", bug.version).put("reason", note),
            "workflow:manualCompleteBug:bug:${bug.id}:v${bug.version}",
        )
    }

    suspend fun beginFix(bug: WorkbenchBug, actorId: String, note: String) {
        var record = current(bug)
        var attempt = workflow(bug.id).optJSONObject("repairAttempt")
        if (attempt == null || attempt.optString("status") !in listOf("planned", "running")) {
            if (record.getString("state") in listOf("reported", "needs_info")) {
                val version = record.getInt("version")
                record = api.request(
                    "bugs/${bug.id}/transitions", token, "POST",
                    JSONObject().put("expectedVersion", version).put("toState", "ready"),
                    "workflow:transitionBug:bug:${bug.id}:v$version:ready",
                )
            }
            val version = record.getInt("version")
            attempt = api.request(
                "bugs/${bug.id}/repair-attempts", token, "POST",
                JSONObject().put("expectedVersion", version).put("mode", "human")
                    .put("assigneeId", bug.ownerId ?: actorId).put("summary", note),
                "workflow:createRepairAttempt:bug:${bug.id}:v$version",
            )
        }
        check(attempt.getString("mode") == "human") { "HUMAN_TAKEOVER_USE_MANUAL_COMPLETE" }
        if (attempt.getString("status") == "planned") {
            val id = attempt.getString("id")
            val version = attempt.getInt("version")
            api.request(
                "repair-attempts/$id/start", token, "POST",
                JSONObject().put("expectedVersion", version).put("reason", note),
                "workflow:startRepairAttempt:attempt:$id:v$version",
            )
        }
    }

    suspend fun submitFix(bug: WorkbenchBug, note: String, branch: String?, commitSha: String?) {
        current(bug)
        val attempt = workflow(bug.id).optJSONObject("repairAttempt")
            ?: error("REPAIR_ATTEMPT_REQUIRED")
        check(attempt.getString("mode") == "human") { "HUMAN_ATTEMPT_REQUIRED" }
        val id = attempt.getString("id")
        val version = attempt.getInt("version")
        val body = JSONObject().put("expectedVersion", version).put("summary", note)
        if (branch != null && commitSha != null) {
            body.put("deliveryKind", "code").put("branch", branch).put("commitSha", commitSha)
        } else {
            body.put("deliveryKind", "no_code").put("noCodeReason", note)
        }
        if (attempt.getString("status") != "delivered") {
            api.request(
                "repair-attempts/$id/deliver", token, "POST", body,
                "workflow:deliverRepairAttempt:attempt:$id:v$version",
            )
        }
        val fresh = readBug(bug)
        if (fresh.getString("state") == "ready_for_verification") return
        val bugVersion = fresh.getInt("version")
        api.request(
            "bugs/${bug.id}/complete", token, "POST",
            JSONObject().put("expectedVersion", bugVersion).put("repairAttemptId", id)
                .put("reason", note),
            "workflow:completeBug:bug:${bug.id}:v$bugVersion",
        )
    }

    suspend fun failRepairAttempt(
        attemptId: String,
        expectedVersion: Int,
        reason: String,
    ): RepairAttemptRecord {
        requireUuid(attemptId, "attemptId")
        require(expectedVersion > 0)
        require(reason.isNotBlank() && reason.length <= 5_000)
        val result = api.request(
            "repair-attempts/$attemptId/fail", token, "POST",
            JSONObject().put("expectedVersion", expectedVersion).put("reason", reason),
            "workflow:failRepairAttempt:attempt:$attemptId:v$expectedVersion",
            QaHubApiContract.VERSIONED_JSON,
        ).toRepairAttempt()
        check(
            result.id == attemptId && result.status == RepairAttemptStatus.FAILED &&
                result.summary == reason && result.version == expectedVersion + 1
        ) { "TERMINAL_ATTEMPT_RESPONSE_MISMATCH" }
        return result
    }

    suspend fun supersedeRepairAttempt(
        command: SupersedeRepairAttemptCommand,
    ): SupersedeRepairAttemptReceipt {
        validateSupersede(command)
        val result = api.request(
            "repair-attempts/${command.attemptId}/supersede", token, "POST",
            JSONObject().put("expectedVersion", command.expectedVersion).put("reason", command.reason)
                .put(
                    "successor",
                    JSONObject().put("id", command.successorId)
                        .put("mode", command.successorMode.wireName)
                        .put("assigneeId", command.successorAssigneeId)
                        .put("summary", command.successorSummary),
                ),
            "workflow:supersedeRepairAttempt:attempt:${command.attemptId}:v${command.expectedVersion}",
            QaHubApiContract.VERSIONED_JSON,
        )
        val superseded = result.getJSONObject("supersededAttempt").toRepairAttempt()
        val successor = result.getJSONObject("successorAttempt").toRepairAttempt()
        val bug = result.getJSONObject("bug").toTerminalBug()
        val eventId = result.requiredUuid("eventId")
        check(
            superseded.id == command.attemptId &&
                superseded.status == RepairAttemptStatus.SUPERSEDED &&
                superseded.summary == command.reason &&
                superseded.version == command.expectedVersion + 1 &&
                successor.id == command.successorId &&
                successor.bugId == superseded.bugId &&
                successor.parentAttemptId == command.attemptId &&
                successor.sequence == superseded.sequence + 1 &&
                successor.mode == command.successorMode &&
                successor.assigneeId == command.successorAssigneeId &&
                successor.summary == command.successorSummary &&
                successor.status == RepairAttemptStatus.PLANNED &&
                successor.version == 1 &&
                bug.id == superseded.bugId && bug.projectId == projectId
        ) { "SUPERSEDE_RESPONSE_MISMATCH" }
        return SupersedeRepairAttemptReceipt(
            superseded, successor, bug, eventId, result.getBoolean("replayed"),
        )
    }

    /** Resolves the persisted Verification before consulting the visible current workflow. */
    suspend fun ensureVerificationInProgress(
        bug: WorkbenchBug,
        actorId: String,
        note: String,
        preferredVerificationId: String? = null,
        activeProjectMemberIds: Set<String>,
        terminalReplayStatus: VerificationStatus? = null,
    ): VerificationRecord {
        check(bug.projectId == projectId) { "BUG_SCOPE_MISMATCH" }
        requireUuid(actorId, "actorId")
        require(note.isNotBlank() && note.length <= 10_000)
        check(actorId in activeProjectMemberIds) { "PROJECT_MEMBERSHIP_REQUIRED" }
        activeProjectMemberIds.forEach { requireUuid(it, "activeProjectMemberId") }
        val authorizationWorkflow = workflow(bug.id)
        val authorizationSnapshot = workflowSnapshotSequence(authorizationWorkflow)
        val workflowVerification = when {
            !authorizationWorkflow.has("verification") -> error("INVALID_VERIFICATION_WORKFLOW")
            authorizationWorkflow.isNull("verification") -> null
            else -> authorizationWorkflow.optJSONObject("verification")
                ?: error("INVALID_VERIFICATION_WORKFLOW")
        }
        val selected = if (preferredVerificationId != null) {
            requireUuid(preferredVerificationId, "verificationId")
            api.request("verifications/$preferredVerificationId", token).toVerification().also {
                check(it.id == preferredVerificationId && it.bugId == bug.id) {
                    "VERIFICATION_SCOPE_MISMATCH"
                }
                val activeId = workflowVerification?.toVerification()?.id
                check(activeId == null || activeId == preferredVerificationId) {
                    "VERIFICATION_ASSIGNEE_REQUIRED"
                }
                val latestId = authorizationWorkflow.optJSONObject("latestVerification")
                    ?.toVerification()?.id
                check(activeId == preferredVerificationId || latestId == preferredVerificationId) {
                    "VERIFICATION_SCOPE_MISMATCH"
                }
            }
        } else {
            workflowVerification?.toVerification()
        }
        if (selected != null && selected.status != VerificationStatus.CANCELLED) {
            check(selected.verifierId == actorId) { "VERIFICATION_ASSIGNEE_REQUIRED" }
            check(
                selected.status in setOf(VerificationStatus.REQUESTED, VerificationStatus.IN_PROGRESS) ||
                    selected.status == terminalReplayStatus && selected.status in setOf(
                    VerificationStatus.PASSED,
                    VerificationStatus.FAILED,
                    VerificationStatus.BLOCKED,
                ),
            ) { "VERIFICATION_ALREADY_TERMINAL" }
            return startVerificationIfNeeded(selected, note)
        }
        check(preferredVerificationId == null) { "VERIFICATION_CANCELLED" }
        check(bug.state == "ready_for_verification") { "VERIFICATION_NOT_READY" }

        val record = current(bug).also {
            check(it.getString("state") == "ready_for_verification") { "VERIFICATION_NOT_READY" }
        }
        val freshWorkflow = workflow(bug.id)
        check(workflowSnapshotSequence(freshWorkflow) == authorizationSnapshot) {
            "WORKFLOW_SNAPSHOT_CHANGED"
        }
        check(freshWorkflow.has("verification") && freshWorkflow.isNull("verification")) {
            "VERSION_CONFLICT"
        }
        val attempt = freshWorkflow.optJSONObject("repairAttempt")
            ?: error("REPAIR_ATTEMPT_REQUIRED")
        val attemptRecord = attempt.toRepairAttempt()
        check(attemptRecord.bugId == bug.id) { "BUG_SCOPE_MISMATCH" }
        val attemptId = attemptRecord.id
        val buildId = freshWorkflow.verificationBuildId(attemptRecord, projectId)
        val version = record.getInt("version")
        val created = api.request(
            "bugs/${bug.id}/verifications", token, "POST",
            JSONObject().put("expectedVersion", version).put("repairAttemptId", attemptId)
                .put("buildId", buildId ?: JSONObject.NULL).put("verifierId", actorId)
                .put("criteria", note),
            "workflow:createVerification:bug:${bug.id}:attempt:$attemptId:v$version",
        ).toVerification()
        check(
            created.bugId == bug.id && created.repairAttemptId == attemptId &&
                created.buildId == buildId && created.verifierId == actorId &&
                created.criteriaSnapshot == note && created.resultSummary == null &&
                created.status == VerificationStatus.REQUESTED && created.version == 1
        ) {
            "VERIFICATION_SCOPE_MISMATCH"
        }
        return startVerificationIfNeeded(created, note)
    }

    suspend fun recordVerificationResult(
        command: VerificationResultCommand,
    ): VerificationResultReceipt {
        validateVerificationResult(command)
        val body = JSONObject().put("submissionContractVersion", QaHubApiContract.VERSION)
            .put("clientSubmissionId", command.clientSubmissionId)
            .put("expectedVersion", command.expectedVersion)
            .put("status", command.outcome.wireName)
            .put("resultSummary", command.resultSummary)
            .put("attachmentIds", JSONArray(command.attachmentIds))
            .put("captureBundleId", command.captureBundleId ?: JSONObject.NULL)
        when (command.outcome) {
            VerificationOutcome.PASSED -> Unit
            VerificationOutcome.FAILED -> body.put("failureReason", command.failureReason)
            VerificationOutcome.BLOCKED -> body.put("blockedReason", command.blockedReason)
        }
        val result = api.request(
            "verifications/${command.verificationId}/result", token, "POST", body,
            "workflow:recordVerificationResult:verification:${command.verificationId}:v${command.expectedVersion}",
            QaHubApiContract.VERSIONED_JSON,
        )
        result.requireObjectShape(
            required = VERIFICATION_RESULT_FIELDS,
            allowed = VERIFICATION_RESULT_FIELDS,
            code = "VERIFICATION_RESULT_RESPONSE_MISMATCH",
        )
        val qaItem = result.getJSONObject("qaItem")
        qaItem.requireObjectShape(QA_ITEM_FIELDS, QA_ITEM_FIELDS, "VERIFICATION_RESULT_RESPONSE_MISMATCH")
        val qaItemId = qaItem.requiredUuid("id")
        val qaItemKey = qaItem.getString("key").also {
            check(BUG_KEY_PATTERN.matches(it)) { "VERIFICATION_RESULT_RESPONSE_MISMATCH" }
        }
        val returnedSubmissionId = result.requiredUuid("clientSubmissionId")
        val verification = result.getJSONObject("verification").toVerification()
        val repairAttempt = result.getJSONObject("repairAttempt").toRepairAttempt()
        val bug = result.getJSONObject("bug").toTerminalBug()
        val returnedAttachments = result.getJSONArray("attachmentIds").strings()
        check(result.has("captureBundleId")) { "VERIFICATION_RESULT_RESPONSE_MISMATCH" }
        val returnedCapture = result.nullableString("captureBundleId")?.also {
            requireUuid(it, "captureBundleId")
        }
        val terminalStateMatches = when (command.outcome) {
            VerificationOutcome.PASSED ->
                bug.state == "closed" && repairAttempt.status == RepairAttemptStatus.DELIVERED
            VerificationOutcome.FAILED ->
                bug.state == "ready" &&
                    repairAttempt.status == RepairAttemptStatus.VERIFICATION_FAILED
            VerificationOutcome.BLOCKED ->
                bug.state == "ready_for_verification" &&
                    repairAttempt.status == RepairAttemptStatus.DELIVERED
        }
        check(
            returnedSubmissionId == command.clientSubmissionId &&
                qaItem.getString("type") == "bug" && qaItemId == command.bugId &&
                qaItemKey == bug.key &&
                verification.id == command.verificationId && verification.bugId == command.bugId &&
                verification.status.wireName == command.outcome.wireName &&
                verification.resultSummary == command.resultSummary &&
                verification.version == command.expectedVersion + 1 &&
                repairAttempt.id == verification.repairAttemptId &&
                repairAttempt.bugId == command.bugId && bug.id == command.bugId &&
                bug.projectId == projectId &&
                terminalStateMatches &&
                returnedAttachments == command.attachmentIds.sorted() &&
                returnedCapture == command.captureBundleId
        ) { "VERIFICATION_RESULT_RESPONSE_MISMATCH" }
        return VerificationResultReceipt(
            command.clientSubmissionId, qaItemKey, verification, repairAttempt, bug,
            returnedAttachments, returnedCapture, result.requiredUuid("eventId"),
            result.requiredExactBoolean("replayed"),
        )
    }

    suspend fun delete(bug: WorkbenchBug) {
        current(bug)
        api.request(
            "bugs/${bug.id}?expectedVersion=${bug.version}", token, "DELETE", null,
            "web:deleteBug:bug:${bug.id}:v${bug.version}",
        )
    }

    private suspend fun startVerificationIfNeeded(
        verification: VerificationRecord,
        note: String,
    ): VerificationRecord {
        if (verification.status != VerificationStatus.REQUESTED) return verification
        val started = api.request(
            "verifications/${verification.id}/start", token, "POST",
            JSONObject().put("expectedVersion", verification.version).put("reason", note),
            "workflow:startVerification:verification:${verification.id}:v${verification.version}",
        ).toVerification()
        check(
            started.id == verification.id && started.bugId == verification.bugId &&
                started.repairAttemptId == verification.repairAttemptId &&
                started.buildId == verification.buildId &&
                started.verifierId == verification.verifierId &&
                started.criteriaSnapshot == verification.criteriaSnapshot &&
                started.resultSummary == verification.resultSummary &&
                started.status == VerificationStatus.IN_PROGRESS &&
                started.version == verification.version + 1
        ) { "VERIFICATION_START_RESPONSE_MISMATCH" }
        return started
    }
}

private fun validateSupersede(command: SupersedeRepairAttemptCommand) {
    requireUuid(command.attemptId, "attemptId")
    requireUuid(command.successorId, "successorId")
    requireUuid(command.successorAssigneeId, "successorAssigneeId")
    require(command.successorId != command.attemptId)
    require(command.expectedVersion > 0)
    require(command.reason.isNotBlank() && command.reason.length <= 5_000)
    require(command.successorSummary.isNotBlank() && command.successorSummary.length <= 10_000)
}

private fun validateVerificationResult(command: VerificationResultCommand) {
    requireUuid(command.bugId, "bugId")
    requireUuid(command.verificationId, "verificationId")
    requireUuid(command.clientSubmissionId, "clientSubmissionId")
    require(command.expectedVersion > 0)
    require(command.resultSummary.isNotBlank() && command.resultSummary.length <= 10_000)
    require(command.attachmentIds.size <= 20 && command.attachmentIds.distinct().size == command.attachmentIds.size)
    command.attachmentIds.forEach { requireUuid(it, "attachmentId") }
    command.captureBundleId?.let { requireUuid(it, "captureBundleId") }
    require(
        when (command.outcome) {
            VerificationOutcome.PASSED -> command.failureReason == null && command.blockedReason == null
            VerificationOutcome.FAILED -> !command.failureReason.isNullOrBlank() &&
                command.failureReason.length <= 5_000 && command.blockedReason == null
            VerificationOutcome.BLOCKED -> command.failureReason == null &&
                !command.blockedReason.isNullOrBlank() && command.blockedReason.length <= 5_000
        }
    )
}

private fun JSONObject.toRepairAttempt(): RepairAttemptRecord {
    requireObjectShape(REPAIR_ATTEMPT_REQUIRED_FIELDS, REPAIR_ATTEMPT_FIELDS, "INVALID_REPAIR_ATTEMPT")
    return RepairAttemptRecord(
        id = requiredUuid("id"), bugId = requiredUuid("bugId"),
        sequence = requiredExactInt("sequence", minimum = 1),
        mode = RepairMode.fromWire(getString("mode")),
        status = RepairAttemptStatus.fromWire(getString("status")),
        assigneeId = requiredUuid("assigneeId"),
        parentAttemptId = nullableString("parentAttemptId")?.also { requireUuid(it, "parentAttemptId") },
        summary = nullableString("summary"), branch = nullableString("branch"),
        commitSha = nullableString("commitSha"), mergeRequestUrl = nullableString("mergeRequestUrl"),
        targetBuildId = nullableString("targetBuildId")?.also { requireUuid(it, "targetBuildId") },
        version = requiredExactInt("version", minimum = 1),
    )
}

private fun JSONObject.toVerification(): VerificationRecord {
    requireObjectShape(VERIFICATION_REQUIRED_FIELDS, VERIFICATION_FIELDS, "INVALID_VERIFICATION")
    return VerificationRecord(
        id = requiredUuid("id"), bugId = requiredUuid("bugId"),
        repairAttemptId = requiredUuid("repairAttemptId"),
        buildId = nullableString("buildId")?.also { requireUuid(it, "buildId") },
        status = VerificationStatus.fromWire(getString("status")), verifierId = requiredUuid("verifierId"),
        criteriaSnapshot = getString("criteriaSnapshot"), resultSummary = nullableString("resultSummary"),
        version = requiredExactInt("version", minimum = 1),
    )
}

private fun JSONObject.toTerminalBug(): TerminalBugRecord {
    requireObjectShape(NATIVE_BUG_FIELDS, NATIVE_BUG_FIELDS, "INVALID_TERMINAL_BUG")
    listOf("id", "projectId", "reporterId").forEach { requiredUuid(it) }
    listOf("moduleId", "ownerId", "verificationOwnerId", "duplicateOfBugId").forEach { key ->
        check(has(key)) { "INVALID_TERMINAL_BUG" }
        nullableString(key)?.also { requireUuid(it, key) }
    }
    val number = requiredExactInt("number", 1)
    requiredExactInt("occurrenceCount", 1)
    requiredExactInt("reopenCount", 0)
    val version = requiredExactInt("version", 1)
    listOf("key", "title", "description", "expectedBehavior", "state", "severity", "priority").forEach {
        check(get(it) is String) { "INVALID_TERMINAL_BUG" }
    }
    check(
        BUG_KEY_PATTERN.matches(getString("key")) &&
            getString("key").substringAfterLast('-').toIntOrNull() == number &&
            getString("title").isNotBlank() && getString("title").length <= 300 &&
            getString("description").isNotBlank() && getString("description").length <= 20_000 &&
            getString("expectedBehavior").isNotBlank() &&
            getString("expectedBehavior").length <= 10_000 &&
            getString("state") in TERMINAL_BUG_STATES &&
            getString("severity") in TERMINAL_BUG_SEVERITIES &&
            getString("priority") in TERMINAL_BUG_PRIORITIES
    ) { "INVALID_TERMINAL_BUG" }
    listOf("createdAt", "updatedAt").forEach { OffsetDateTime.parse(getString(it)) }
    check(has("closedAt")) { "INVALID_TERMINAL_BUG" }
    nullableString("closedAt")?.let(OffsetDateTime::parse)
    return TerminalBugRecord(
        id = requiredUuid("id"), projectId = requiredUuid("projectId"), key = getString("key"),
        state = getString("state"), version = version,
    )
}

private fun JSONObject.nullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key)

private fun JSONObject.requiredUuid(key: String): String = getString(key).also {
    requireUuid(it, key)
}

private fun JSONObject.requireObjectShape(
    required: Set<String>,
    allowed: Set<String>,
    code: String,
) {
    val keys = keys().asSequence().toSet()
    check(keys.containsAll(required) && keys.all(allowed::contains)) { code }
}

private fun JSONObject.requiredWorkflowSequence(key: String): Long {
    check(has(key)) { "INVALID_WORKFLOW_SNAPSHOT" }
    val value = when (val raw = get(key)) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> error("INVALID_WORKFLOW_SNAPSHOT")
    }
    check(value in 0..MAX_SAFE_JSON_INTEGER) { "INVALID_WORKFLOW_SNAPSHOT" }
    return value
}

internal fun workflowSnapshotSequence(workflow: JSONObject): Long =
    workflow.requiredWorkflowSequence("snapshotSequence")

private fun JSONObject.requiredExactInt(key: String, minimum: Int): Int {
    check(has(key)) { "INVALID_INTEGER_FIELD" }
    val value = when (val raw = get(key)) {
        is Int -> raw
        is Long -> raw.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
        else -> null
    }
    return checkNotNull(value) { "INVALID_INTEGER_FIELD" }.also {
        check(it >= minimum) { "INVALID_INTEGER_FIELD" }
    }
}

private fun JSONObject.requiredExactBoolean(key: String): Boolean {
    check(has(key) && get(key) is Boolean) { "INVALID_BOOLEAN_FIELD" }
    return getBoolean(key)
}

private fun JSONObject.requiredWorkflowVersion(key: String): Int {
    check(has(key) && get(key) is Int) { "INVALID_WORKFLOW_BUG_VERSION" }
    return getInt(key).also { check(it > 0) { "INVALID_WORKFLOW_BUG_VERSION" } }
}

private fun JSONObject.requiredWorkflowBoolean(key: String): Boolean {
    check(has(key) && get(key) is Boolean) { "INVALID_WORKFLOW_TRUNCATION" }
    return getBoolean(key)
}

private fun JSONObject.requiredWorkflowCollection(key: String): JSONArray {
    val value = optJSONArray(key) ?: error("INVALID_WORKFLOW_RESPONSE")
    check(value.length() <= WORKFLOW_PAGE_SIZE) { "INVALID_WORKFLOW_RESPONSE" }
    return value
}

private fun JSONObject.validateWorkflowOccurrence(expectedBugId: String): String {
    requireObjectShape(
        WORKFLOW_OCCURRENCE_FIELDS,
        WORKFLOW_OCCURRENCE_FIELDS,
        "INVALID_WORKFLOW_OCCURRENCE",
    )
    val id = requiredUuid("id")
    check(requiredUuid("bugId") == expectedBugId) { "BUG_SCOPE_MISMATCH" }
    requiredUuid("reporterId")
    listOf("observedAt", "createdAt").forEach { key ->
        check(get(key) is String) { "INVALID_WORKFLOW_OCCURRENCE" }
        OffsetDateTime.parse(getString(key))
    }
    check(getString("platform") in WORKFLOW_PLATFORMS) { "INVALID_WORKFLOW_OCCURRENCE" }
    mapOf(
        "appVersion" to 100,
        "resourceVersion" to 100,
        "deviceModel" to 200,
        "osVersion" to 100,
        "frequency" to 100,
        "errorSignature" to 500,
    ).forEach { (key, maxLength) ->
        nullableString(key)?.let { check(it.length <= maxLength) { "INVALID_WORKFLOW_OCCURRENCE" } }
    }
    nullableString("gitSha")?.let {
        check(COMMIT_SHA_PATTERN.matches(it)) { "INVALID_WORKFLOW_OCCURRENCE" }
    }
    val steps = optJSONArray("steps") ?: error("INVALID_WORKFLOW_OCCURRENCE")
    check(steps.length() in 1..50) { "INVALID_WORKFLOW_OCCURRENCE" }
    for (index in 0 until steps.length()) {
        val step = steps.get(index)
        check(step is String && step.isNotBlank() && step.length <= 1_000) {
            "INVALID_WORKFLOW_OCCURRENCE"
        }
    }
    check(get("actualBehavior") is String) { "INVALID_WORKFLOW_OCCURRENCE" }
    val actualBehavior = getString("actualBehavior")
    check(actualBehavior.isNotBlank() && actualBehavior.length <= 10_000) {
        "INVALID_WORKFLOW_OCCURRENCE"
    }
    when {
        isNull("environment") -> Unit
        else -> (optJSONObject("environment") ?: error("INVALID_WORKFLOW_OCCURRENCE"))
            .validateWorkflowEnvironment()
    }
    val attachmentIds = optJSONArray("attachmentIds") ?: error("INVALID_WORKFLOW_OCCURRENCE")
    check(attachmentIds.length() <= 20) { "INVALID_WORKFLOW_OCCURRENCE" }
    val seenAttachments = mutableSetOf<String>()
    for (index in 0 until attachmentIds.length()) {
        val attachmentId = attachmentIds.get(index)
        check(attachmentId is String && seenAttachments.add(attachmentId)) {
            "INVALID_WORKFLOW_OCCURRENCE"
        }
        requireUuid(attachmentId, "attachmentId")
    }
    nullableString("captureBundleId")?.let { requireUuid(it, "captureBundleId") }
    return id
}

private fun JSONObject.validateWorkflowEnvironment() {
    val keys = keys().asSequence().toSet()
    check(keys.all(WORKFLOW_ENVIRONMENT_FIELDS::contains) && keys.size <= 6) {
        "INVALID_WORKFLOW_OCCURRENCE"
    }
    nullableString("qaAppVersion")?.let {
        check(QA_APP_VERSION_PATTERN.matches(it)) { "INVALID_WORKFLOW_OCCURRENCE" }
    }
    listOf("testSessionId", "buildId").forEach { key ->
        nullableString(key)?.let { requireUuid(it, key) }
    }
    if (has("networkType") && !isNull("networkType")) {
        check(get("networkType") is String && getString("networkType") in WORKFLOW_NETWORK_TYPES) {
            "INVALID_WORKFLOW_OCCURRENCE"
        }
    }
    if (has("networkMetered") && !isNull("networkMetered")) {
        check(get("networkMetered") is Boolean) { "INVALID_WORKFLOW_OCCURRENCE" }
    }
    if (has("orientation") && !isNull("orientation")) {
        check(get("orientation") is String && getString("orientation") in WORKFLOW_ORIENTATIONS) {
            "INVALID_WORKFLOW_OCCURRENCE"
        }
    }
    check(toString().toByteArray(Charsets.UTF_8).size <= 256) { "INVALID_WORKFLOW_OCCURRENCE" }
}

private fun JSONObject.validateWorkflowBuild(expectedProjectId: String): String {
    requireObjectShape(WORKFLOW_BUILD_FIELDS, WORKFLOW_BUILD_FIELDS, "INVALID_WORKFLOW_BUILD")
    val id = requiredUuid("id")
    check(requiredUuid("projectId") == expectedProjectId) { "BUILD_SCOPE_MISMATCH" }
    mapOf(
        "externalId" to 300,
        "versionName" to 100,
        "channel" to 100,
        "branch" to 300,
    ).forEach { (key, maxLength) ->
        check(get(key) is String) { "INVALID_WORKFLOW_BUILD" }
        val value = getString(key)
        check(value.isNotBlank() && value.length <= maxLength) { "INVALID_WORKFLOW_BUILD" }
    }
    check(get("provider") is String && getString("provider") in WORKFLOW_BUILD_PROVIDERS) {
        "INVALID_WORKFLOW_BUILD"
    }
    check(get("projectKey") is String && PROJECT_KEY_PATTERN.matches(getString("projectKey"))) {
        "INVALID_WORKFLOW_BUILD"
    }
    check(get("sourceCommitSha") is String && COMMIT_SHA_PATTERN.matches(getString("sourceCommitSha"))) {
        "INVALID_WORKFLOW_BUILD"
    }
    check(get("mode") is String && getString("mode") in WORKFLOW_BUILD_MODES) {
        "INVALID_WORKFLOW_BUILD"
    }
    check(get("status") is String && getString("status") in WORKFLOW_BUILD_STATUSES) {
        "INVALID_WORKFLOW_BUILD"
    }
    val manifest = optJSONObject("manifest") ?: error("INVALID_WORKFLOW_BUILD")
    val manifestKeys = manifest.keys().asSequence().toSet()
    check(
        "commitShas" in manifestKeys && manifestKeys.all(WORKFLOW_BUILD_MANIFEST_FIELDS::contains),
    ) { "INVALID_WORKFLOW_BUILD" }
    val commits = manifest.optJSONArray("commitShas") ?: error("INVALID_WORKFLOW_BUILD")
    check(commits.length() > 0) { "INVALID_WORKFLOW_BUILD" }
    val seenCommits = mutableSetOf<String>()
    for (index in 0 until commits.length()) {
        val commit = commits.get(index)
        check(commit is String && COMMIT_SHA_PATTERN.matches(commit) && seenCommits.add(commit)) {
            "INVALID_WORKFLOW_BUILD"
        }
    }
    if (manifest.has("artifactSha256")) {
        check(
            manifest.get("artifactSha256") is String &&
                SHA256_PATTERN.matches(manifest.getString("artifactSha256")),
        ) { "INVALID_WORKFLOW_BUILD" }
    }
    requiredExactInt("version", 1)
    return id
}

private fun JSONObject.validateWorkflowRelayReceipt(expectedBugId: String): String {
    requireObjectShape(
        WORKFLOW_RELAY_RECEIPT_FIELDS,
        WORKFLOW_RELAY_RECEIPT_FIELDS,
        "INVALID_WORKFLOW_RELAY_RECEIPT",
    )
    val qaItem = optJSONObject("qaItem") ?: error("INVALID_WORKFLOW_RELAY_RECEIPT")
    qaItem.requireObjectShape(QA_ITEM_FIELDS, QA_ITEM_FIELDS, "INVALID_WORKFLOW_RELAY_RECEIPT")
    check(
        qaItem.get("type") is String && qaItem.getString("type") == "bug" &&
            qaItem.requiredUuid("id") == expectedBugId &&
            qaItem.get("key") is String && BUG_KEY_PATTERN.matches(qaItem.getString("key")),
    ) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    requiredUuid("repairAttemptId")
    val handoffId = requiredUuid("handoffId")
    check(
        get("relayInstanceId") is String &&
            RELAY_INSTANCE_PATTERN.matches(getString("relayInstanceId")),
    ) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    val status = getString("handoffStatus")
    check(status in WORKFLOW_HANDOFF_STATUSES) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    val relayTaskId = nullableString("relayTaskId")
    check(relayTaskId == null || relayTaskId.length <= 200) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    if (status != "queued") check(!relayTaskId.isNullOrBlank()) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    val requirement = getString("buildRequirement")
    val evidence = getString("buildEvidenceStatus")
    check(requirement in setOf("not_required", "required")) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    check(evidence in setOf("not_required", "pending", "exact_commit_eligible")) {
        "INVALID_WORKFLOW_RELAY_RECEIPT"
    }
    val delivered = nullableString("deliveredCommitSha")
    delivered?.let { check(COMMIT_SHA_PATTERN.matches(it)) { "INVALID_WORKFLOW_RELAY_RECEIPT" } }
    val buildId = nullableString("buildId")?.also { requireUuid(it, "buildId") }
    requiredWorkflowNonNegativeLong("externalRevision", "INVALID_WORKFLOW_RELAY_RECEIPT")
    check(requiredExactBoolean("requiresHumanVerification")) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    check(getString("automationAuthority") == "delivery_build_projection_only") {
        "INVALID_WORKFLOW_RELAY_RECEIPT"
    }
    check(get("lastEventAt") is String) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    OffsetDateTime.parse(getString("lastEventAt"))
    val failure = nullableString("failureSummary")
    check(failure == null || failure.length <= 2_000) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    requiredExactInt("version", 1)
    check(
        when (status) {
            "queued", "submitted", "running", "needs_input", "blocked", "failed" -> delivered == null
            else -> delivered != null
        },
    ) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    check((status == "failed") == !failure.isNullOrBlank()) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    check(
        when (requirement) {
            "not_required" -> evidence == "not_required" && buildId == null
            else -> evidence in setOf("pending", "exact_commit_eligible") &&
                (evidence != "exact_commit_eligible" || buildId != null)
        },
    ) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    if (status == "awaiting_build") {
        check(requirement == "required" && evidence == "pending") {
            "INVALID_WORKFLOW_RELAY_RECEIPT"
        }
    }
    if (status == "awaiting_verification") {
        check(
            (requirement == "not_required" && evidence == "not_required" && buildId == null) ||
                (requirement == "required" && evidence == "exact_commit_eligible" && buildId != null),
        ) { "INVALID_WORKFLOW_RELAY_RECEIPT" }
    }
    return handoffId
}

private fun JSONObject.requiredWorkflowNonNegativeLong(key: String, code: String): Long {
    val value = when (val raw = get(key)) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> error(code)
    }
    check(value in 0..MAX_SAFE_JSON_INTEGER) { code }
    return value
}

private fun JSONObject.verificationBuildId(
    attempt: RepairAttemptRecord,
    projectId: String,
): String? {
    val requirement = when {
        !has("buildRequirement") || isNull("buildRequirement") -> null
        else -> optJSONObject("buildRequirement") ?: error("VERIFICATION_BUILD_INVALID")
    }
    val build = when {
        !has("build") || isNull("build") -> null
        else -> optJSONObject("build") ?: error("VERIFICATION_BUILD_INVALID")
    }
    requirement?.let {
        check(it.requiredUuid("repairAttemptId") == attempt.id) {
            "VERIFICATION_BUILD_INVALID"
        }
    }
    if (build == null) {
        check(requirement?.nullableString("linkedBuildId") == null) {
            "VERIFICATION_BUILD_INVALID"
        }
        return null
    }
    val required = requirement ?: error("VERIFICATION_BUILD_INVALID")
    val buildId = build.requiredUuid("id")
    val deliveredCommitSha = required.getString("deliveredCommitSha")
    check(
        required.getInt("version") == 2 && required.requiredUuid("linkedBuildId") == buildId &&
            build.requiredUuid("projectId") == projectId && build.getString("status") == "ready" &&
            deliveredCommitSha.matches(Regex("^[0-9a-f]{40}$")) &&
            build.getString("sourceCommitSha") == deliveredCommitSha &&
            attempt.commitSha == deliveredCommitSha
    ) { "VERIFICATION_BUILD_INVALID" }
    return buildId
}

private fun JSONArray.strings(): List<String> = (0 until length()).map { index ->
    getString(index).also { requireUuid(it, "attachmentId") }
}

private fun requireUuid(value: String, label: String) {
    require(
        STRICT_LIFECYCLE_UUID.matches(value) && runCatching { UUID.fromString(value) }.isSuccess,
    ) { "$label must be a UUID" }
}

private const val WORKFLOW_PAGE_SIZE = 100
private const val MAX_WORKFLOW_PAGES = 100
private const val MAX_WORKFLOW_ITEMS_PER_COLLECTION = WORKFLOW_PAGE_SIZE * MAX_WORKFLOW_PAGES
private const val HISTORY_PAGE_SIZE = 100
private const val MAX_HISTORY_PAGES = 100
private const val MAX_HISTORY_ITEMS = HISTORY_PAGE_SIZE * MAX_HISTORY_PAGES
private const val MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991L
private val STRICT_LIFECYCLE_UUID = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)
private val VERIFICATION_RESULT_FIELDS = setOf(
    "clientSubmissionId", "qaItem", "verification", "repairAttempt", "bug", "attachmentIds",
    "captureBundleId", "eventId", "replayed",
)
private val QA_ITEM_FIELDS = setOf("type", "id", "key")
private val BUG_KEY_PATTERN = Regex("^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]*$")
private val PROJECT_KEY_PATTERN = Regex("^[A-Z][A-Z0-9]{1,15}$")
private val COMMIT_SHA_PATTERN = Regex("^[0-9a-f]{40}$")
private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
private val QA_APP_VERSION_PATTERN = Regex(
    "^[0-9]+(?:\\.[0-9]+){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?(?:\\+[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$",
)
private val RELAY_INSTANCE_PATTERN = Regex("^[a-z0-9][a-z0-9_-]{2,63}$")
private val WORKFLOW_PAGE_FIELDS = setOf(
    "bugId", "bugVersion", "snapshotSequence", "truncated", "nextCursor", "occurrences",
    "repairAttempts", "verifications", "builds", "relayReceipts",
)
private val HISTORY_PAGE_FIELDS = setOf(
    "projectId", "bugId", "snapshotSequence", "items", "nextCursor",
)
private val WORKFLOW_OCCURRENCE_FIELDS = setOf(
    "id", "bugId", "reporterId", "observedAt", "platform", "appVersion", "resourceVersion",
    "gitSha", "deviceModel", "osVersion", "steps", "actualBehavior", "frequency",
    "errorSignature", "environment", "attachmentIds", "captureBundleId", "createdAt",
)
private val WORKFLOW_ENVIRONMENT_FIELDS = setOf(
    "qaAppVersion", "testSessionId", "buildId", "networkType", "networkMetered", "orientation",
)
private val WORKFLOW_PLATFORMS = setOf(
    "android", "ios", "windows", "macos", "linux", "web", "other",
)
private val WORKFLOW_NETWORK_TYPES = setOf(
    "wifi", "cellular", "ethernet", "vpn", "offline", "other", "unknown",
)
private val WORKFLOW_ORIENTATIONS = setOf("portrait", "landscape", "square", "unknown")
private val WORKFLOW_BUILD_FIELDS = setOf(
    "id", "projectId", "provider", "externalId", "versionName", "channel", "projectKey", "branch",
    "sourceCommitSha", "mode", "status", "manifest", "version",
)
private val WORKFLOW_BUILD_MANIFEST_FIELDS = setOf("commitShas", "artifactSha256")
private val WORKFLOW_BUILD_PROVIDERS = setOf("manual", "ozdqp", "custom")
private val WORKFLOW_BUILD_MODES = setOf("full", "hot_update", "cdn", "debug", "other")
private val WORKFLOW_BUILD_STATUSES = setOf(
    "registered", "queued", "building", "validating", "publishing", "ready", "failed",
)
private val WORKFLOW_RELAY_RECEIPT_FIELDS = setOf(
    "qaItem", "repairAttemptId", "handoffId", "relayInstanceId", "relayTaskId", "handoffStatus",
    "buildRequirement", "buildEvidenceStatus", "deliveredCommitSha", "buildId", "externalRevision",
    "requiresHumanVerification", "automationAuthority", "lastEventAt", "failureSummary", "version",
)
private val WORKFLOW_HANDOFF_STATUSES = setOf(
    "queued", "submitted", "running", "needs_input", "blocked", "failed", "fix_delivered",
    "awaiting_build", "awaiting_verification",
)
private val TERMINAL_BUG_STATES = setOf(
    "reported", "needs_info", "ready", "in_progress", "awaiting_build",
    "ready_for_verification", "closed", "deferred", "rejected", "duplicate",
)
private val TERMINAL_BUG_SEVERITIES = setOf("S0", "S1", "S2", "S3", "S4")
private val TERMINAL_BUG_PRIORITIES = setOf("P0", "P1", "P2", "P3", "P4")
private val REPAIR_ATTEMPT_REQUIRED_FIELDS = setOf(
    "id", "bugId", "sequence", "mode", "status", "assigneeId", "version",
)
private val REPAIR_ATTEMPT_FIELDS = REPAIR_ATTEMPT_REQUIRED_FIELDS + setOf(
    "parentAttemptId", "summary", "branch", "commitSha", "mergeRequestUrl", "targetBuildId",
)
private val VERIFICATION_REQUIRED_FIELDS = setOf(
    "id", "bugId", "repairAttemptId", "buildId", "status", "verifierId", "criteriaSnapshot", "version",
)
private val VERIFICATION_FIELDS = VERIFICATION_REQUIRED_FIELDS + "resultSummary"
private val NATIVE_BUG_FIELDS = setOf(
    "id", "projectId", "number", "key", "title", "description", "expectedBehavior", "moduleId",
    "state", "severity", "priority", "reporterId", "ownerId", "verificationOwnerId",
    "duplicateOfBugId", "occurrenceCount", "reopenCount", "version", "createdAt", "updatedAt",
    "closedAt",
)
