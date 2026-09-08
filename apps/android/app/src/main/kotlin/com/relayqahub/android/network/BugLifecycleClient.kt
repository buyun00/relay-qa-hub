package com.relayqahub.android.network

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Explicit existing workflow actions, with version checks and persisted server readback. */
class BugLifecycleClient(private val api: ProjectOperationsClient, private val projectId: String, private val token: String) {
    suspend fun workflow(bugId: String): JSONObject = api.request("bugs/$bugId/human-workflow", token).also {
        check(it.getString("bugId") == bugId) { "BUG_SCOPE_MISMATCH" }
    }
    suspend fun events(bugId: String): JSONObject = api.request("bugs/$bugId/events?limit=100", token)
    suspend fun comments(bugId: String): JSONObject = api.request("projects/$projectId/bugs/$bugId/comments?limit=100", token)
    private suspend fun readBug(bug: WorkbenchBug): JSONObject = api.request("bugs/${bug.id}", token).also {
        check(bug.projectId == projectId && it.getString("id") == bug.id && it.getString("projectId") == projectId) { "BUG_SCOPE_MISMATCH" }
    }
    private suspend fun current(bug: WorkbenchBug): JSONObject = readBug(bug).also {
        check(it.getInt("version") == bug.version) { "VERSION_CONFLICT" }
    }
    suspend fun manualComplete(bug: WorkbenchBug, note: String) {
        current(bug)
        api.request("bugs/${bug.id}/manual-complete", token, "POST", JSONObject()
            .put("expectedVersion", bug.version).put("reason", note),
            "workflow:manualCompleteBug:bug:${bug.id}:v${bug.version}")
    }
    suspend fun beginFix(bug: WorkbenchBug, actorId: String, note: String) {
        var record = current(bug)
        var attempt = workflow(bug.id).optJSONObject("repairAttempt")
        if (attempt == null || attempt.optString("status") !in listOf("planned", "running")) {
            if (record.getString("state") in listOf("reported", "needs_info")) {
                val version = record.getInt("version")
                record = api.request("bugs/${bug.id}/transitions", token, "POST",
                    JSONObject().put("expectedVersion", version).put("toState", "ready"),
                    "workflow:transitionBug:bug:${bug.id}:v$version:ready")
            }
            val version = record.getInt("version")
            attempt = api.request("bugs/${bug.id}/repair-attempts", token, "POST", JSONObject()
                .put("expectedVersion", version).put("mode", "human").put("assigneeId", bug.ownerId ?: actorId).put("summary", note),
                "workflow:createRepairAttempt:bug:${bug.id}:v$version")
        }
        check(attempt.getString("mode") == "human") { "HUMAN_TAKEOVER_USE_MANUAL_COMPLETE" }
        if (attempt.getString("status") == "planned") {
            val id = attempt.getString("id"); val version = attempt.getInt("version")
            api.request("repair-attempts/$id/start", token, "POST", JSONObject().put("expectedVersion", version).put("reason", note),
                "workflow:startRepairAttempt:attempt:$id:v$version")
        }
    }
    suspend fun submitFix(bug: WorkbenchBug, note: String, branch: String?, commitSha: String?) {
        current(bug)
        val attempt = workflow(bug.id).optJSONObject("repairAttempt") ?: error("REPAIR_ATTEMPT_REQUIRED")
        check(attempt.getString("mode") == "human") { "HUMAN_ATTEMPT_REQUIRED" }
        val id = attempt.getString("id"); val version = attempt.getInt("version")
        val body = JSONObject().put("expectedVersion", version).put("summary", note)
        if (branch != null && commitSha != null) body.put("deliveryKind", "code").put("branch", branch).put("commitSha", commitSha)
        else body.put("deliveryKind", "no_code").put("noCodeReason", note)
        if (attempt.getString("status") != "delivered") api.request("repair-attempts/$id/deliver", token, "POST", body,
            "workflow:deliverRepairAttempt:attempt:$id:v$version")
        val fresh = readBug(bug)
        // A no-code delivery can finish this transition itself. Trust scoped server readback.
        if (fresh.getString("state") == "ready_for_verification") return
        val bugVersion = fresh.getInt("version")
        api.request("bugs/${bug.id}/complete", token, "POST", JSONObject().put("expectedVersion", bugVersion)
            .put("repairAttemptId", id).put("reason", note), "workflow:completeBug:bug:${bug.id}:v$bugVersion")
    }
    suspend fun verify(bug: WorkbenchBug, actorId: String, passed: Boolean, note: String) {
        current(bug)
        val workflow = workflow(bug.id)
        val attempt = workflow.optJSONObject("repairAttempt") ?: error("REPAIR_ATTEMPT_REQUIRED")
        val attemptId = attempt.getString("id")
        var verification = workflow.optJSONObject("verification")
        if (verification == null || verification.optString("status") !in listOf("requested", "in_progress")) {
            verification = api.request("bugs/${bug.id}/verifications", token, "POST", JSONObject()
                .put("expectedVersion", bug.version).put("repairAttemptId", attemptId)
                .put("buildId", JSONObject.NULL).put("verifierId", bug.verificationOwnerId ?: actorId).put("criteria", note),
                "workflow:createVerification:bug:${bug.id}:attempt:$attemptId:v${bug.version}")
        }
        val id = verification.getString("id")
        if (verification.getString("status") == "requested") {
            val version = verification.getInt("version")
            verification = api.request("verifications/$id/start", token, "POST", JSONObject().put("expectedVersion", version).put("reason", note),
                "workflow:startVerification:verification:$id:v$version")
        }
        val version = verification.getInt("version")
        val clientId = UUID.nameUUIDFromBytes("$id:$version:$passed:$note".toByteArray()).toString()
        val body = JSONObject().put("submissionContractVersion", "1.1.0").put("clientSubmissionId", clientId)
            .put("expectedVersion", version).put("status", if (passed) "passed" else "failed")
            .put("resultSummary", note).put("attachmentIds", JSONArray())
        if (!passed) body.put("failureReason", note)
        api.request("verifications/$id/result", token, "POST", body,
            "workflow:recordVerificationResult:verification:$id:v$version", "application/vnd.relay-qa-hub.v1.1+json")
    }
    suspend fun delete(bug: WorkbenchBug) {
        current(bug)
        api.request("bugs/${bug.id}?expectedVersion=${bug.version}", token, "DELETE", null,
            "web:deleteBug:bug:${bug.id}:v${bug.version}")
    }
}
