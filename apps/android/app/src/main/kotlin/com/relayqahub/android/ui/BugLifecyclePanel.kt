package com.relayqahub.android.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.relayqahub.android.BugEditImageUpload
import com.relayqahub.android.FrozenVerificationResult
import com.relayqahub.android.NativeProjectBindings
import com.relayqahub.android.PendingVerificationAttachment
import com.relayqahub.android.PendingVerificationSubmission
import com.relayqahub.android.QaHubApplication
import com.relayqahub.android.QaPeopleConfig
import com.relayqahub.android.QaPerson
import com.relayqahub.android.QaPersonRole
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.draftScopeKey
import com.relayqahub.android.network.*
import com.relayqahub.android.security.*
import com.relayqahub.android.work.StagedOfflineAttachment
import java.util.UUID
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun BugLifecyclePanel(
    bug: WorkbenchBug,
    people: List<QaPerson>,
    onChanged: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    val container = (context.applicationContext as QaHubApplication).container
    val projectScope = remember(bug.projectId, bug.id) { container.identityStore.scope() }
    val verificationScopeKey = remember(container.apiBaseUrl, bug.projectId, projectScope.actorId) {
        draftScopeKey(container.apiBaseUrl, bug.projectId, projectScope.actorId)
    }
    val coroutineScope = rememberCoroutineScope()
    var workflow by remember(bug.id, bug.version) { mutableStateOf<JSONObject?>(null) }
    var events by remember(bug.id, bug.version) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var comments by remember(bug.id, bug.version) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var qingyuLink by remember(bug.id, bug.version) { mutableStateOf<JSONObject?>(null) }
    var qingyuError by remember(bug.id, bug.version) { mutableStateOf<String?>(null) }
    var token by remember(bug.id) { mutableStateOf<String?>(null) }
    var note by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var branch by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var commit by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var codeDelivery by rememberSaveable(bug.projectId, bug.id) { mutableStateOf(false) }
    var comment by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var commentId by rememberSaveable(bug.projectId, bug.id) {
        mutableStateOf(UUID.randomUUID().toString())
    }
    var pendingVerification by remember(bug.projectId, bug.id) {
        mutableStateOf<PendingVerificationSubmission?>(null)
    }
    var verificationImages by remember(bug.projectId, bug.id) {
        mutableStateOf<List<BugEditImageUpload>>(emptyList())
    }
    var captureBundleIdInput by rememberSaveable(bug.projectId, bug.id) { mutableStateOf("") }
    var selectionError by remember(bug.projectId, bug.id) { mutableStateOf<String?>(null) }
    var busy by remember(bug.id) { mutableStateOf(false) }
    var error by remember(bug.id) { mutableStateOf<String?>(null) }
    var deleteConfirm by remember(bug.id) { mutableStateOf(false) }

    suspend fun client(): BugLifecycleClient {
        check(projectScope.projectId == bug.projectId) { "BUG_SCOPE_MISMATCH" }
        val credentials = container.credentialVault.read(projectScope.nativeSessionScope())
        val accessToken = (credentials as? VaultResult.Success)?.value?.accessToken
            ?: error("SESSION_EXPIRED")
        NativeProjectBindings.register(accessToken, projectScope.projectId)
        token = accessToken
        return BugLifecycleClient(container.projectOperationsClient, bug.projectId, accessToken)
    }

    suspend fun reload(api: BugLifecycleClient) {
        workflow = api.workflow(bug.id)
        events = api.events(bug.id).objects()
        comments = api.comments(bug.id).objects()
        pendingVerification = container.bugDraftPreferences.pendingVerificationForBug(
            verificationScopeKey,
            projectScope,
            bug.id,
        )
        pendingVerification?.captureBundleId?.let { persisted ->
            if (captureBundleIdInput.isBlank()) captureBundleIdInput = persisted
        }
        runCatching {
            val accessToken = checkNotNull(token)
            val enabled = container.projectOperationsClient.components(bug.projectId, accessToken)
                .any { it.key == "qingyu.sync" && it.enabled }
            if (enabled) {
                qingyuLink = container.projectOperationsClient
                    .request("bugs/${bug.id}/integrations/qingyu", accessToken)
                    .optJSONObject("link")
            }
        }.onFailure { qingyuError = it.message }
    }

    fun perform(deleted: Boolean = false, action: suspend (BugLifecycleClient) -> Unit) {
        if (busy) return
        busy = true
        error = null
        coroutineScope.launch {
            try {
                val api = client()
                action(api)
                if (!deleted) reload(api)
                onChanged(deleted)
            } catch (failure: Exception) {
                error = "操作失败：${failure.message ?: "UNKNOWN"}"
            } finally {
                busy = false
            }
        }
    }

    fun submitVerification(outcome: VerificationOutcome) {
        if (!canActOnVerification(workflow, bug, pendingVerification, projectScope, people)) {
            error = "只有当前项目的启用成员可以发起验收；已有验收只能由该轮验收人继续。"
            return
        }
        perform { api ->
            var pending = container.bugDraftPreferences.pendingVerificationForBug(
                verificationScopeKey,
                projectScope,
                bug.id,
            )
            val actionNote = verificationSubmissionNote(pending, note)
            val actionSnapshot = loadConsistentVerificationActionSnapshot(
                bugId = bug.id,
                projectId = projectScope.projectId,
                actorId = projectScope.actorId,
                readPeople = {
                    container.accountSessionClient.listPeople(
                        projectId = projectScope.projectId,
                        projectKey = container.identityStore.projectKey(),
                        accessToken = checkNotNull(token),
                    )
                },
                readProjectBugs = {
                    container.bugWorkbenchClient.listProjectBugs(
                        projectId = projectScope.projectId,
                        limitPerPage = 100,
                        accessToken = checkNotNull(token),
                    )
                },
                readWorkflow = { api.workflow(bug.id) },
            )
            val currentWorkflow = actionSnapshot.workflow
            val currentBug = actionSnapshot.bug
            val freshPeople = actionSnapshot.people.people
            check(
                canActOnVerification(
                    currentWorkflow,
                    currentBug,
                    pending,
                    projectScope,
                    freshPeople,
                ),
            ) { "VERIFICATION_ACTION_NOT_ALLOWED" }
            val verification = api.ensureVerificationInProgress(
                bug = currentBug,
                actorId = projectScope.actorId,
                note = actionNote,
                preferredVerificationId = pending?.verificationId,
                activeProjectMemberIds = canonicalActiveProjectMemberIds(freshPeople),
                terminalReplayStatus = pending?.frozenResult?.status?.let(VerificationStatus::fromWire),
            )
            var submission = pending ?: container.bugDraftPreferences.openVerification(
                verificationScopeKey,
                projectScope,
                bug.id,
                verification.id,
            )
            submission.requireScope(projectScope, bug.id, verification.id)

            if (submission.frozenResult == null) {
                check(verification.status == VerificationStatus.IN_PROGRESS) {
                    "当前验收已结束，不能生成另一份结果。"
                }
                val requestedCapture = captureBundleIdInput.trim().takeIf(String::isNotEmpty)
                requestedCapture?.let {
                    require(STRICT_PANEL_UUID.matches(it))
                    UUID.fromString(it)
                }
                check(submission.captureBundleId == null || submission.captureBundleId == requestedCapture) {
                    "本次验收已绑定另一份采集包，不能在重试时更换。"
                }
                check(
                    verificationCaptureCanChange(submission) ||
                        submission.captureBundleId == requestedCapture
                ) { "附件开始上传后不能更换采集包。" }
                submission = submission.copy(captureBundleId = requestedCapture)
                container.bugDraftPreferences.saveVerification(verificationScopeKey, submission)

                val knownAttachmentIds = submission.attachments.map { it.clientAttachmentId }.toSet()
                verificationImages.filterNot { it.localId in knownAttachmentIds }.forEach { image ->
                    val metadata = container.offlineAttachmentDraftStore.persist(
                        submission.clientSubmissionId,
                        image.localId,
                        image.bytes,
                    )
                    submission = submission.copy(
                        attachments = submission.attachments + PendingVerificationAttachment(
                            clientAttachmentId = image.localId,
                            filename = image.filename.safeAttachmentName(),
                            mediaType = image.mediaType,
                            expectedSize = metadata.expectedSize,
                            sha256 = metadata.sha256,
                        ),
                    )
                    container.bugDraftPreferences.saveVerification(verificationScopeKey, submission)
                    pendingVerification = submission
                    verificationImages = verificationImages.filterNot { it.localId == image.localId }
                }

                submission.attachments.forEach { attachment ->
                    val bytes = container.offlineAttachmentDraftStore.read(
                        submission.clientSubmissionId,
                        StagedOfflineAttachment(
                            clientAttachmentId = attachment.clientAttachmentId,
                            filename = attachment.filename,
                            expectedSize = attachment.expectedSize,
                            sha256 = attachment.sha256,
                            role = "verification_result",
                        ),
                    )
                    val receipt = container.attachmentUploadClient.uploadAndReserveVerificationResult(
                        scope = projectScope,
                        bugId = bug.id,
                        clientSubmissionId = submission.clientSubmissionId,
                        clientAttachmentId = attachment.clientAttachmentId,
                        filename = attachment.filename,
                        contentBytes = bytes,
                        accessToken = checkNotNull(token),
                        captureId = submission.captureBundleId,
                        mediaType = attachment.mediaType,
                        checkpoint = attachment.uploadCheckpoint,
                        onCheckpoint = { checkpoint ->
                            submission = submission.copy(
                                attachments = submission.attachments.map { current ->
                                    if (current.clientAttachmentId == attachment.clientAttachmentId) {
                                        current.copy(
                                            attachmentId = checkpoint.attachmentId,
                                            uploadCheckpoint = checkpoint,
                                        )
                                    } else {
                                        current
                                    }
                                },
                            )
                            container.bugDraftPreferences.saveVerification(
                                verificationScopeKey,
                                submission,
                            )
                        },
                    )
                    check(
                        receipt.clientSubmissionId == submission.clientSubmissionId &&
                            receipt.clientAttachmentId == attachment.clientAttachmentId
                    ) { "UPLOAD_RECEIPT_SCOPE_MISMATCH" }
                    check(
                        submission.attachments.single {
                            it.clientAttachmentId == attachment.clientAttachmentId
                        }.uploadCheckpoint.bindingId == receipt.bindingId,
                    ) { "UPLOAD_CHECKPOINT_RECEIPT_MISMATCH" }
                    pendingVerification = submission
                }

                val uploadedIds = canonicalVerificationAttachmentIds(submission.attachments)
                val summary = actionNote
                submission = submission.copy(
                    frozenResult = FrozenVerificationResult(
                        verificationId = verification.id,
                        expectedVersion = verification.version,
                        status = outcome.wireName,
                        resultSummary = summary,
                        attachmentIds = uploadedIds,
                        captureBundleId = submission.captureBundleId,
                        failureReason = summary.takeIf { outcome == VerificationOutcome.FAILED },
                        blockedReason = summary.takeIf { outcome == VerificationOutcome.BLOCKED },
                    ),
                )
                container.bugDraftPreferences.saveVerification(verificationScopeKey, submission)
                pendingVerification = submission
            }

            val frozen = checkNotNull(submission.frozenResult)
            check(frozen.status == outcome.wireName) {
                "已有${frozen.status.verificationOutcomeLabel()}结果等待确认，请重试同一结果。"
            }
            val command = VerificationResultCommand(
                    bugId = bug.id,
                    verificationId = frozen.verificationId,
                    expectedVersion = frozen.expectedVersion,
                    outcome = VerificationOutcome.entries.single { it.wireName == frozen.status },
                    resultSummary = frozen.resultSummary,
                    clientSubmissionId = submission.clientSubmissionId,
                    attachmentIds = frozen.attachmentIds,
                    captureBundleId = frozen.captureBundleId,
                    failureReason = frozen.failureReason,
                    blockedReason = frozen.blockedReason,
                )
            val receipt = recordVerificationResultWithReservationRecovery(
                attachments = submission.attachments,
                record = { api.recordVerificationResult(command) },
                renew = { attachment ->
                    val renewed = container.attachmentUploadClient.renewVerificationResultReservation(
                        scope = projectScope,
                        bugId = bug.id,
                        clientSubmissionId = submission.clientSubmissionId,
                        clientAttachmentId = attachment.clientAttachmentId,
                        accessToken = checkNotNull(token),
                        checkpoint = attachment.uploadCheckpoint,
                        onCheckpoint = { checkpoint ->
                            submission = submission.copy(
                                attachments = submission.attachments.map { current ->
                                    if (current.clientAttachmentId == attachment.clientAttachmentId) {
                                        current.copy(
                                            attachmentId = checkpoint.attachmentId,
                                            uploadCheckpoint = checkpoint,
                                        )
                                    } else {
                                        current
                                    }
                                },
                            )
                            container.bugDraftPreferences.saveVerification(
                                verificationScopeKey,
                                submission,
                            )
                        },
                    )
                    check(renewed.attachmentId == attachment.attachmentId) {
                        "UPLOAD_RENEWAL_RECEIPT_MISMATCH"
                    }
                },
            )
            check(verificationResultReceiptMatches(receipt, submission, frozen, currentBug)) {
                "VERIFICATION_RESULT_RECEIPT_SCOPE_MISMATCH"
            }
            val confirmed = container.bugDraftPreferences.confirmVerification(
                verificationScopeKey,
                receipt.verification.id,
                submission.clientSubmissionId,
            )
            checkNotNull(confirmed) { "验收回执不属于当前待提交记录。" }
            confirmed.attachments.forEach { attachment ->
                runCatching {
                    container.offlineAttachmentDraftStore.delete(
                        confirmed.clientSubmissionId,
                        attachment.clientAttachmentId,
                    )
                }
            }
            pendingVerification = null
            verificationImages = emptyList()
            captureBundleIdInput = ""
            selectionError = null
        }
    }

    val imagePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetMultipleContents(),
    ) { uris: List<Uri> ->
        if (!canActOnVerification(workflow, bug, pendingVerification, projectScope, people)) {
            selectionError = "只有当前项目的启用成员可以发起验收；已有验收只能由该轮验收人继续。"
            return@rememberLauncherForActivityResult
        }
        val pendingCount = pendingVerification?.attachments?.size ?: 0
        val remaining = (20 - pendingCount - verificationImages.size).coerceAtLeast(0)
        val currentBytes = (pendingVerification?.attachments?.sumOf { it.expectedSize.toLong() } ?: 0L) +
            verificationImages.sumOf { it.bytes.size.toLong() }
        var acceptedBytes = currentBytes
        val selected = uris.take(remaining).mapNotNull { uri -> readBugEditImage(context, uri) }
            .filter { image ->
                val fits = acceptedBytes + image.bytes.size <= MAX_VERIFICATION_EVIDENCE_BYTES
                if (fits) acceptedBytes += image.bytes.size
                fits
            }
        selectionError = when {
            pendingVerification?.frozenResult != null -> "结果已发送，重试时不能更换证据。"
            uris.size > remaining -> "每次验收最多提交 20 张图片。"
            selected.size != uris.take(remaining).size -> "部分图片格式不支持、超过 20 MB，或总量超过 100 MB。"
            else -> null
        }
        if (pendingVerification?.frozenResult == null) verificationImages = verificationImages + selected
    }

    LaunchedEffect(bug.id, bug.version) {
        try {
            reload(client())
        } catch (failure: Exception) {
            error = failure.message
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Text("处理与验收", style = MaterialTheme.typography.titleLarge)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        val attempt = workflow?.optJSONObject("repairAttempt")
        attempt?.let { Text("修复轮次：${it.optString("sequence")} · ${it.optString("status").repairStatusLabel()}") }
        workflow?.optJSONObject("verification")?.let {
            Text("验收：${it.optString("status").verificationOutcomeLabel()}")
        }
        OutlinedTextField(
            note,
            { note = it },
            label = { Text("处理说明 / 验收结果") },
            modifier = Modifier.fillMaxWidth().testTag("bug-action-note"),
        )
        val mayAct = !busy && note.isNotBlank()
        if (bug.state in listOf("reported", "needs_info", "ready", "in_progress")) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled = mayAct,
                    onClick = { perform { it.beginFix(bug, projectScope.actorId, note) } },
                    modifier = Modifier.testTag("bug-begin-fix"),
                ) { Text("开始修复") }
                OutlinedButton(
                    enabled = mayAct,
                    onClick = { perform { it.manualComplete(bug, note) } },
                    modifier = Modifier.testTag("bug-manual-complete"),
                ) { Text("人工完成") }
            }
        }
        if (attempt?.optString("mode") == "human" && attempt.optString("status") in listOf("planned", "running")) {
            Row { Checkbox(codeDelivery, { codeDelivery = it }); Text("提交代码交付") }
            if (codeDelivery) {
                OutlinedTextField(branch, { branch = it }, label = { Text("实际分支") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(commit, { commit = it }, label = { Text("实际提交 SHA") }, modifier = Modifier.fillMaxWidth())
            }
            Button(
                enabled = mayAct && (!codeDelivery || branch.isNotBlank() && commit.matches(Regex("[0-9a-f]{40}"))),
                onClick = { perform { it.submitFix(bug, note, branch.takeIf { codeDelivery }, commit.takeIf { codeDelivery }) } },
                modifier = Modifier.testTag("bug-submit-fix"),
            ) { Text(if (codeDelivery) "提交代码修复" else "提交无需代码的处理") }
        }

        if (attempt != null && attempt.optString("status") in ACTIVE_REPAIR_STATUSES) {
            RepairAttemptTerminalControls(
                attempt = attempt,
                people = people,
                actorId = projectScope.actorId,
                busy = busy,
                onFail = { reason ->
                    perform { api ->
                        api.failRepairAttempt(attempt.getString("id"), attempt.getInt("version"), reason)
                    }
                },
                onSupersede = { reason, successorId, mode, assigneeId, summary ->
                    perform { api ->
                        api.supersedeRepairAttempt(
                            SupersedeRepairAttemptCommand(
                                attemptId = attempt.getString("id"),
                                expectedVersion = attempt.getInt("version"),
                                reason = reason,
                                successorId = successorId,
                                successorMode = mode,
                                successorAssigneeId = assigneeId,
                                successorSummary = summary,
                            ),
                        )
                    }
                },
            )
        }

        if (
            bug.state in listOf("awaiting_build", "ready_for_verification") ||
                pendingVerification != null
        ) {
            HorizontalDivider()
            Text("验收证据", style = MaterialTheme.typography.titleMedium)
            Text("结果上传失败时，图片和提交编号会保留；回到这个项目和 Bug 后可直接重试。")
            val mayEditVerification = canActOnVerification(
                workflow,
                bug,
                pendingVerification,
                projectScope,
                people,
            )
            if (!mayEditVerification) {
                Text(
                    if (bug.state == "awaiting_build" && pendingVerification == null) {
                        "构建尚未完成；完成并进入待验收后才能创建验收。"
                    } else {
                        "当前内容只读；需要当前项目启用成员，且已有验收只能由该轮验收人继续。"
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            pendingVerification?.let { pending ->
                Text("待确认提交：${pending.clientSubmissionId}", style = MaterialTheme.typography.labelSmall)
                pending.attachments.forEach { attachment ->
                    Text("${if (attachment.attachmentId == null) "待上传" else "已上传"} · ${attachment.filename}")
                }
                pending.frozenResult?.let { frozen ->
                    Text("已发送${frozen.status.verificationOutcomeLabel()}结果；现在只能原样重试。")
                }
            }
            verificationImages.forEach { image ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("待加入 · ${image.filename}", modifier = Modifier.weight(1f))
                    TextButton(
                        enabled = mayEditVerification && !busy && pendingVerification?.frozenResult == null,
                        onClick = { verificationImages = verificationImages.filterNot { it.localId == image.localId } },
                    ) { Text("移除") }
                }
            }
            selectionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            OutlinedButton(
                enabled = mayEditVerification && !busy && pendingVerification?.frozenResult == null,
                onClick = { imagePicker.launch("image/*") },
                modifier = Modifier.fillMaxWidth().testTag("bug-verification-add-evidence"),
            ) { Text("添加验收图片") }
            OutlinedTextField(
                value = captureBundleIdInput,
                onValueChange = { captureBundleIdInput = it.trim() },
                enabled = mayEditVerification && !busy &&
                    verificationCaptureCanChange(pendingVerification),
                label = { Text("采集包编号（高级，可选）") },
                supportingText = {
                    Text("仅填写由当前待确认提交编号创建、且附件完全一致的未使用采集包 UUID。")
                },
                modifier = Modifier.fillMaxWidth().testTag("bug-verification-capture-bundle"),
            )
            val frozenOutcome = pendingVerification?.frozenResult?.status
            val maySubmitVerification = mayEditVerification && !busy &&
                (frozenOutcome != null || note.isNotBlank())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled = maySubmitVerification &&
                        (frozenOutcome == null || frozenOutcome == "passed"),
                    onClick = { submitVerification(VerificationOutcome.PASSED) },
                    modifier = Modifier.testTag("bug-verify-pass"),
                ) { Text("验收通过并关闭") }
                OutlinedButton(
                    enabled = maySubmitVerification &&
                        (frozenOutcome == null || frozenOutcome == "failed"),
                    onClick = { submitVerification(VerificationOutcome.FAILED) },
                    modifier = Modifier.testTag("bug-verify-fail"),
                ) { Text("验收失败并退回") }
            }
            OutlinedButton(
                enabled = maySubmitVerification &&
                    (frozenOutcome == null || frozenOutcome == "blocked"),
                onClick = { submitVerification(VerificationOutcome.BLOCKED) },
                modifier = Modifier.fillMaxWidth().testTag("bug-verify-blocked"),
            ) { Text("暂时无法验收（说明阻塞原因）") }
        }

        HorizontalDivider()
        Text("评论与历史", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(comment, { comment = it }, label = { Text("评论") }, modifier = Modifier.fillMaxWidth().testTag("bug-comment-input"))
        Button(
            enabled = !busy && comment.isNotBlank(),
            onClick = {
                perform {
                    container.commentTimelineClient.createComment(bug.id, commentId, comment, checkNotNull(token))
                    comment = ""
                    commentId = UUID.randomUUID().toString()
                }
            },
            modifier = Modifier.testTag("bug-comment-submit"),
        ) { Text("添加评论") }
        comments.forEach { entry ->
            Text("${entry.optString("createdAt")} · ${entry.optString("authorId")}", style = MaterialTheme.typography.labelSmall)
            Text(entry.optString("body"))
        }
        events.forEach { event ->
            Text(
                "${event.optString("occurredAt", event.optString("createdAt"))} · ${event.optString("type", event.optString("eventType"))}",
                style = MaterialTheme.typography.labelMedium,
            )
            event.optJSONObject("payload")?.let { payload ->
                listOf("body", "commentBody", "reason", "resultSummary", "summary").forEach { field ->
                    payload.optString(field).takeIf(String::isNotBlank)?.let { Text(it) }
                }
            }
        }
        TextButton(
            onClick = { deleteConfirm = true },
            enabled = !busy,
            modifier = Modifier.testTag("bug-delete"),
        ) { Text("删除 Bug（保留审计记录）") }
        qingyuLink?.let { link ->
            HorizontalDivider()
            Text("关联订单：${link.optString("defectTitle")}")
            Text("同步状态：${link.optString("syncStatus")}")
            qingyuError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (bug.state == "closed") {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        coroutineScope.launch {
                            busy = true
                            qingyuError = null
                            try {
                                val accessToken = checkNotNull(token)
                                container.projectOperationsClient.request(
                                    "bugs/${bug.id}/integrations/qingyu/resolve",
                                    accessToken,
                                    "POST",
                                )
                                qingyuLink = container.projectOperationsClient.request(
                                    "bugs/${bug.id}/integrations/qingyu",
                                    accessToken,
                                ).optJSONObject("link")
                            } catch (failure: Exception) {
                                qingyuError = failure.message
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text("核对 / 重试订单同步") }
            }
        }
    }
    if (deleteConfirm) {
        AlertDialog(
            onDismissRequest = { deleteConfirm = false },
            title = { Text("删除 ${bug.key}") },
            text = { Text("该 Bug 将从普通列表移除，历史和审计记录保留。") },
            confirmButton = {
                TextButton(onClick = {
                    deleteConfirm = false
                    perform(deleted = true) { it.delete(bug) }
                }) { Text("删除") }
            },
            dismissButton = { TextButton(onClick = { deleteConfirm = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun RepairAttemptTerminalControls(
    attempt: JSONObject,
    people: List<QaPerson>,
    actorId: String,
    busy: Boolean,
    onFail: (String) -> Unit,
    onSupersede: (String, String, RepairMode, String, String) -> Unit,
) {
    val attemptId = attempt.getString("id")
    val currentAssignee = attempt.optString("assigneeId").takeIf(String::isNotBlank) ?: actorId
    val assigneeOptions = people.filter { it.active && QaPersonRole.FIXER in it.roles }
        .map { it.id to it.displayName }
        .distinctBy { it.first }
    var reason by rememberSaveable(attemptId) { mutableStateOf("") }
    val successorId by rememberSaveable(attemptId) { mutableStateOf(UUID.randomUUID().toString()) }
    var successorModeName by rememberSaveable(attemptId) { mutableStateOf(RepairMode.HUMAN.wireName) }
    var successorAssigneeId by rememberSaveable(attemptId) {
        mutableStateOf(
            currentAssignee.takeIf { id -> assigneeOptions.any { it.first == id } }
                ?: assigneeOptions.firstOrNull()?.first.orEmpty(),
        )
    }
    var successorSummary by rememberSaveable(attemptId) { mutableStateOf("") }
    var modeMenu by remember(attemptId) { mutableStateOf(false) }
    var assigneeMenu by remember(attemptId) { mutableStateOf(false) }
    val successorMode = RepairMode.fromWire(successorModeName)

    HorizontalDivider()
    Text("结束或更换本轮处理", style = MaterialTheme.typography.titleMedium)
    Text("系统会使用屏幕上这轮的准确版本；若别人已更新，请刷新后再操作。")
    OutlinedTextField(
        reason,
        { reason = it },
        label = { Text("为什么结束或更换") },
        modifier = Modifier.fillMaxWidth().testTag("bug-terminal-reason"),
    )
    OutlinedButton(
        enabled = !busy && reason.isNotBlank(),
        onClick = { onFail(reason.trim()) },
        modifier = Modifier.fillMaxWidth().testTag("bug-fail-repair-attempt"),
    ) { Text("结束本轮并退回待处理") }
    Text("如需继续处理，请明确下一轮的方式、接手人和任务说明。")
    Box {
        OutlinedButton(onClick = { modeMenu = true }, enabled = !busy) {
            Text("处理方式：${successorMode.label()}")
        }
        DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
            RepairMode.entries.forEach { mode ->
                DropdownMenuItem(
                    text = { Text(mode.label()) },
                    onClick = { successorModeName = mode.wireName; modeMenu = false },
                )
            }
        }
    }
    Box {
        OutlinedButton(
            onClick = { assigneeMenu = true },
            enabled = !busy && assigneeOptions.isNotEmpty(),
        ) {
            Text(
                "接手人：${assigneeOptions.firstOrNull { it.first == successorAssigneeId }?.second ?: "无可用开发人员"}",
            )
        }
        DropdownMenu(expanded = assigneeMenu, onDismissRequest = { assigneeMenu = false }) {
            assigneeOptions.forEach { (id, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = { successorAssigneeId = id; assigneeMenu = false },
                )
            }
        }
    }
    OutlinedTextField(
        successorSummary,
        { successorSummary = it },
        label = { Text("下一轮要做什么") },
        modifier = Modifier.fillMaxWidth().testTag("bug-successor-summary"),
    )
    Text("下一轮编号：$successorId", style = MaterialTheme.typography.labelSmall)
    Button(
        enabled = !busy && reason.isNotBlank() && successorSummary.isNotBlank() &&
            assigneeOptions.any { it.first == successorAssigneeId },
        onClick = {
            onSupersede(
                reason.trim(), successorId, successorMode, successorAssigneeId,
                successorSummary.trim(),
            )
        },
        modifier = Modifier.fillMaxWidth().testTag("bug-supersede-repair-attempt"),
    ) { Text("更换处理方式和接手人") }
}

private fun RepairMode.label(): String = when (this) {
    RepairMode.HUMAN -> "人工处理"
    RepairMode.RELAY -> "Relay 自动处理"
    RepairMode.EXTERNAL -> "外部处理"
}

private fun String.repairStatusLabel(): String = when (this) {
    "planned" -> "待开始"
    "queued" -> "排队中"
    "running" -> "处理中"
    "needs_input" -> "等待补充信息"
    "blocked" -> "处理受阻"
    "delivered" -> "已交付"
    "failed" -> "本轮失败"
    "verification_failed" -> "验收未通过"
    "cancelled" -> "已取消"
    "superseded" -> "已由下一轮接替"
    else -> this
}

private fun String.verificationOutcomeLabel(): String = when (this) {
    "requested" -> "等待验收"
    "in_progress" -> "验收中"
    "passed" -> "通过"
    "failed" -> "未通过"
    "blocked" -> "暂时无法验收"
    "cancelled" -> "已取消"
    else -> this
}

private fun String.safeAttachmentName(): String = replace('/', '_').replace('\\', '_').take(255)

internal fun canActOnVerification(
    workflow: JSONObject?,
    bug: WorkbenchBug,
    pending: PendingVerificationSubmission?,
    scope: AccountProjectScope,
    people: List<QaPerson>,
): Boolean {
    if (workflow == null) return false
    if (bug.projectId != scope.projectId) return false
    if (pending != null && bug.id != pending.bugId) return false
    if (scope.actorId !in canonicalActiveProjectMemberIds(people)) return false
    if (pending != null && runCatching {
            pending.requireScope(scope, bug.id, pending.verificationId)
        }.isFailure
    ) return false
    val snapshotSequence = runCatching { workflowSnapshotSequence(workflow) }.getOrNull()
        ?: return false
    if (snapshotSequence < 0 || workflow.optString("bugId") != bug.id) return false
    if (!workflow.has("verification")) return false
    val activeVerification = workflow.optJSONObject("verification")
    val latestVerification = workflow.optJSONObject("latestVerification")
    if (workflow.has("verification") && !workflow.isNull("verification") && activeVerification == null) {
        return false
    }
    if (
        pending != null && workflow.has("latestVerification") &&
        !workflow.isNull("latestVerification") && latestVerification == null
    ) {
        return false
    }
    val verification = if (pending == null) {
        activeVerification
    } else {
        if (
            activeVerification != null &&
            activeVerification.optString("id") != pending.verificationId
        ) return false
        sequenceOf(activeVerification, latestVerification)
            .filterNotNull()
            .firstOrNull { it.optString("id") == pending.verificationId }
            ?: return false
    }
    if (verification != null) {
        val verificationId = runCatching { verification.getString("id") }.getOrNull()
            ?: return false
        if (
            !STRICT_PANEL_UUID.matches(verificationId) ||
            runCatching { UUID.fromString(verificationId) }.isFailure ||
            verification.optString("bugId") != bug.id
        ) {
            return false
        }
    }
    val workflowVerifierId = verification?.let {
        val verifierId = runCatching { it.getString("verifierId") }.getOrNull()
            ?: return false
        verifierId.takeIf { value ->
            STRICT_PANEL_UUID.matches(value) && runCatching { UUID.fromString(value) }.isSuccess
        }
            ?: return false
    }
    if (workflowVerifierId != null && workflowVerifierId != scope.actorId) return false
    val statusEligible = when {
        verification == null -> pending == null
        pending?.frozenResult != null -> verification.optString("status") in
            setOf("requested", "in_progress", pending.frozenResult.status)
        else -> verification.optString("status") in setOf("requested", "in_progress")
    }
    return statusEligible && (bug.state == "ready_for_verification" || pending != null)
}

internal fun canonicalActiveProjectMemberIds(people: List<QaPerson>): Set<String> {
    if (
        people.map { it.id }.distinct().size != people.size ||
        people.any {
            !STRICT_PANEL_UUID.matches(it.id) || runCatching { UUID.fromString(it.id) }.isFailure
        }
    ) {
        return emptySet()
    }
    return people.filter { it.active }.map { it.id }.toSet()
}

internal fun verificationResultReceiptMatches(
    receipt: VerificationResultReceipt,
    submission: PendingVerificationSubmission,
    frozen: FrozenVerificationResult,
    currentBug: WorkbenchBug,
): Boolean =
        receipt.clientSubmissionId == submission.clientSubmissionId &&
        receipt.verification.id == frozen.verificationId &&
        receipt.verification.verifierId == submission.scope.actorId &&
        receipt.verification.bugId == submission.bugId &&
        receipt.qaItemKey == currentBug.key &&
        receipt.bug.id == currentBug.id &&
        receipt.bug.projectId == submission.scope.projectId &&
        currentBug.projectId == submission.scope.projectId &&
        receipt.repairAttempt.id == receipt.verification.repairAttemptId

internal fun verificationSubmissionNote(
    pending: PendingVerificationSubmission?,
    editorNote: String,
): String = pending?.frozenResult?.resultSummary ?: editorNote.trim()

internal fun canonicalVerificationAttachmentIds(
    attachments: List<PendingVerificationAttachment>,
): List<String> = attachments.map { checkNotNull(it.attachmentId) }.sorted()

internal fun verificationCaptureCanChange(
    pending: PendingVerificationSubmission?,
): Boolean = pending?.frozenResult == null &&
    pending?.attachments?.none { it.uploadCheckpoint.sessionId != null } != false

internal data class VerificationActionSnapshot(
    val people: QaPeopleConfig,
    val bugs: BugWorkbenchResult,
    val bug: WorkbenchBug,
    val workflow: JSONObject,
)

/** Reads all three authorities again and accepts them only at one project snapshot. */
internal suspend fun loadConsistentVerificationActionSnapshot(
    bugId: String,
    projectId: String,
    actorId: String,
    readPeople: suspend () -> QaPeopleConfig,
    readProjectBugs: suspend () -> BugWorkbenchResult,
    readWorkflow: suspend () -> JSONObject,
): VerificationActionSnapshot {
    repeat(2) { attempt ->
        val people = try {
            readPeople()
        } catch (failure: AccountSessionFailure) {
            if (attempt == 0 && failure.code == "PEOPLE_SNAPSHOT_CHANGED") return@repeat
            throw failure
        }
        val bugs = try {
            readProjectBugs()
        } catch (failure: BugWorkbenchFailure) {
            if (attempt == 0 && failure.code == "WORKBENCH_SNAPSHOT_CHANGED") return@repeat
            throw failure
        }
        val workflow = try {
            readWorkflow()
        } catch (failure: IllegalStateException) {
            if (
                attempt == 0 && failure.message in
                setOf("WORKFLOW_SNAPSHOT_CHANGED", "WORKFLOW_BUG_VERSION_CHANGED")
            ) {
                return@repeat
            }
            throw failure
        }
        val workflowSequence = workflowSnapshotSequence(workflow)
        if (
            people.snapshotSequence == bugs.snapshotSequence &&
            bugs.snapshotSequence == workflowSequence
        ) {
            val bug = bugs.items.singleOrNull { it.id == bugId }
                ?: error("BUG_NOT_VISIBLE")
            check(bug.projectId == projectId && workflow.optString("bugId") == bugId) {
                "BUG_SCOPE_MISMATCH"
            }
            check(actorId in canonicalActiveProjectMemberIds(people.people)) {
                "PROJECT_MEMBERSHIP_REQUIRED"
            }
            return VerificationActionSnapshot(people, bugs, bug, workflow)
        }
    }
    error("VERIFICATION_SNAPSHOT_CHANGED")
}

/**
 * Replay the frozen result before touching its reservations. A lost successful response can then
 * return the server's idempotent receipt even though its bindings have already been claimed.
 */
internal suspend fun <T> recordVerificationResultWithReservationRecovery(
    attachments: List<PendingVerificationAttachment>,
    record: suspend () -> T,
    renew: suspend (PendingVerificationAttachment) -> Unit,
): T {
    try {
        return record()
    } catch (failure: AccountSessionFailure) {
        if (
            attachments.isEmpty() ||
            failure.code !in setOf("ATTACHMENT_BINDING_CONFLICT", "INVALID_REQUEST")
        ) {
            throw failure
        }
    }
    attachments.forEach { renew(it) }
    return record()
}

private val ACTIVE_REPAIR_STATUSES = setOf("planned", "queued", "running", "needs_input", "blocked")
private const val MAX_VERIFICATION_EVIDENCE_BYTES = 100L * 1024L * 1024L
private val STRICT_PANEL_UUID = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)
