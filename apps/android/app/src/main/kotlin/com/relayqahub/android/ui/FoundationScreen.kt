package com.relayqahub.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayqahub.android.FoundationUiState
import com.relayqahub.android.FoundationViewModel

@Composable
fun FoundationScreen(
    viewModel: FoundationViewModel,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
    onDispatchToRelay: () -> Unit = viewModel::dispatchToRelay,
    onAdoptFixAndBindQaBuild: () -> Unit = viewModel::adoptFixAndBindQaBuild,
    onRefreshInbox: () -> Unit = viewModel::refreshInbox,
    onRefreshBugWorkbench: () -> Unit = viewModel::refreshBugWorkbench,
    onCreateManualRepairAttempt: () -> Unit = viewModel::createManualRepairAttempt,
    onDeliverManualRepairAndLinkBuild: () -> Unit = viewModel::deliverManualRepairAndLinkBuild,
    onVerifyManualRepairAndClose: () -> Unit = viewModel::verifyManualRepairAndClose,
    onRefreshLatestHumanWorkflow: () -> Unit = viewModel::refreshLatestHumanWorkflow,
    onCreateCommentAndReadAudit: () -> Unit = viewModel::createCommentAndReadAudit,
    onCreateBugAndCheckDuplicates: () -> Unit = viewModel::createBugAndCheckDuplicates,
) {
    val state = viewModel.uiState.collectAsStateWithLifecycle().value
    FoundationScreen(
        state = state,
        onQueueDraft = viewModel::queueLocalDraft,
        onRunLiveSmoke = viewModel::runLiveSmoke,
        onStartCaptureSession = onStartCaptureSession,
        onCaptureNow = onCaptureNow,
        onStopCaptureSession = onStopCaptureSession,
        onDispatchToRelay = onDispatchToRelay,
        onAdoptFixAndBindQaBuild = onAdoptFixAndBindQaBuild,
        onRefreshInbox = onRefreshInbox,
        onRefreshBugWorkbench = onRefreshBugWorkbench,
        onCreateManualRepairAttempt = onCreateManualRepairAttempt,
        onDeliverManualRepairAndLinkBuild = onDeliverManualRepairAndLinkBuild,
        onVerifyManualRepairAndClose = onVerifyManualRepairAndClose,
        onRefreshLatestHumanWorkflow = onRefreshLatestHumanWorkflow,
        onCreateCommentAndReadAudit = onCreateCommentAndReadAudit,
        onCreateBugAndCheckDuplicates = onCreateBugAndCheckDuplicates,
    )
}

@Composable
internal fun FoundationScreen(
    state: FoundationUiState,
    onQueueDraft: () -> Unit,
    onRunLiveSmoke: () -> Unit,
    onStartCaptureSession: () -> Unit,
    onCaptureNow: () -> Unit,
    onStopCaptureSession: () -> Unit,
    onDispatchToRelay: () -> Unit = {},
    onAdoptFixAndBindQaBuild: () -> Unit = {},
    onRefreshInbox: () -> Unit = {},
    onRefreshBugWorkbench: () -> Unit = {},
    onCreateManualRepairAttempt: () -> Unit = {},
    onDeliverManualRepairAndLinkBuild: () -> Unit = {},
    onVerifyManualRepairAndClose: () -> Unit = {},
    onRefreshLatestHumanWorkflow: () -> Unit = {},
    onCreateCommentAndReadAudit: () -> Unit = {},
    onCreateBugAndCheckDuplicates: () -> Unit = {},
) {
    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing),
        containerColor = MaterialTheme.colorScheme.background,
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 20.dp)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .testTag("foundation-screen"),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Spacer(Modifier.size(6.dp))
            Text(
                text = "Relay QA Hub",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.testTag("app-title"),
            )
            Text(
                text = "Native Android foundation",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = "Jetpack Compose UI — no WebView, PWA, or service worker.",
                style = MaterialTheme.typography.bodyMedium,
            )

            ScopeCard(state)

            FoundationCard(
                title = "Local isolation",
                detail = "Room cache and queue keys include both account and project.",
                value = "${state.cachedItemCount} cached • ${state.queuedOperationCount} queued",
            )
            FoundationCard(
                title = "Latest submission",
                detail = "The final Room receipt survives process restart and identifies the QA item.",
                value = state.latestQaItemKey?.let { key ->
                    "$key • ${state.latestQaItemId}"
                } ?: "No completed submission yet",
            )
            FoundationCard(
                title = "Offline delivery",
                detail = "Queued media stays app-private while WorkManager waits or retries.",
                value = state.latestDeliveryState?.let { deliveryState ->
                    state.latestDeliveryError?.let { "$deliveryState • $it" } ?: deliveryState
                } ?: "No queued operation yet",
            )
            FoundationCard(
                title = "Constrained delivery",
                detail = "WorkManager uses connected-network, battery, unique-work, and exponential backoff gates.",
                value = "4-run retry ceiling",
            )
            FoundationCard(
                title = "Credential boundary",
                detail = "Opaque native session credentials stay outside Room and are encrypted with Android Keystore.",
                value = state.credentialBoundary,
            )
            FoundationCard(
                title = "Versioned QA Hub API",
                detail = "Queued and live JSON writes share the additive App-first vendor media type and contract boundary.",
                value = "Contract ${state.contractVersion}",
            )
            FoundationCard(
                title = "Explicit evidence session",
                detail = "MediaProjection starts only after system consent; the persistent notification and Stop action remain visible.",
                value = "Overlay capture stays optional; ordinary defects remain available",
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedButton(
                    onClick = onQueueDraft,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("queue-draft"),
                ) {
                    Text("Queue draft")
                }
                Button(
                    onClick = onRunLiveSmoke,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("live-smoke"),
                ) {
                    Text("Run live smoke")
                }
            }
            Button(
                onClick = onDispatchToRelay,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("dispatch-to-relay"),
            ) {
                Text("交给 Relay（新建 Bug）")
            }
            val handoff = state.relayHandoff
            val buildProjection = state.buildProjection
            val canAdoptFix = handoff?.handoffStatus == "fix_delivered" &&
                !handoff.deliveredCommitSha.isNullOrBlank() &&
                buildProjection.phase != "in_flight"
            Button(
                onClick = onAdoptFixAndBindQaBuild,
                enabled = canAdoptFix,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("adopt-fix-build"),
            ) {
                Text("注册并回读 QA Build")
            }
            when (buildProjection.phase) {
                "in_flight" -> Text(
                    text = "QA Build: linking delivered ${buildProjection.deliveredCommitSha}…",
                    modifier = Modifier.testTag("build-projection-status"),
                )
                "registered" -> Text(
                    text = "QA Build ${buildProjection.buildId} registered/read back; " +
                        "SHA ${buildProjection.deliveredCommitSha}. 不代表验收或关闭 Bug。",
                    modifier = Modifier.testTag("build-projection-status"),
                )
                "failed" -> Text(
                    text = "QA Build adoption error: ${buildProjection.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("build-projection-status"),
                )
            }
            Button(
                onClick = onRefreshInbox,
                enabled = state.inbox.phase != "loading",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("refresh-inbox"),
            ) {
                Text("回读 QA Inbox")
            }
            when (state.inbox.phase) {
                "loading" -> Text(
                    text = "QA Inbox: loading…",
                    modifier = Modifier.testTag("inbox-status"),
                )
                "loaded" -> Text(
                    text = "QA Inbox ${state.inbox.itemCount} item(s), " +
                        "${state.inbox.unreadCount} unread; first=${state.inbox.firstTitle ?: "none"}.",
                    modifier = Modifier.testTag("inbox-status"),
                )
                "failed" -> Text(
                    text = "QA Inbox error: ${state.inbox.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("inbox-status"),
                )
            }
            Button(
                onClick = onRefreshBugWorkbench,
                enabled = state.bugWorkbench.phase != "loading",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("refresh-bug-workbench"),
            ) {
                Text("回读 Bug 工作台（reported）")
            }
            when (state.bugWorkbench.phase) {
                "loading" -> Text(
                    text = "Bug workbench: loading…",
                    modifier = Modifier.testTag("bug-workbench-status"),
                )
                "loaded" -> Text(
                    text = "Bug workbench ${state.bugWorkbench.itemCount} " +
                        "${state.bugWorkbench.stateFilter}; " +
                        "first=${state.bugWorkbench.firstBugKey ?: "none"}; " +
                        "title=${state.bugWorkbench.firstTitle ?: "none"}; " +
                        "snapshot=${state.bugWorkbench.snapshotSequence}.",
                    modifier = Modifier.testTag("bug-workbench-status"),
                )
                "failed" -> Text(
                    text = "Bug workbench error: " +
                        "${state.bugWorkbench.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("bug-workbench-status"),
                )
            }
            Button(
                onClick = onCreateManualRepairAttempt,
                enabled = state.manualRepair.phase != "loading",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("create-manual-repair"),
            ) {
                Text("创建并回读人工 RepairAttempt")
            }
            when (state.manualRepair.phase) {
                "loading" -> Text(
                    text = "Human RepairAttempt: creating…",
                    modifier = Modifier.testTag("manual-repair-status"),
                )
                "loaded" -> Text(
                    text = "${state.manualRepair.bugKey ?: "Bug"} RepairAttempt " +
                        "${state.manualRepair.attemptId}; mode=${state.manualRepair.mode}; " +
                        "status=${state.manualRepair.status}; missingEvidence=" +
                        "${state.manualRepair.missingEvidenceRejectionCode}.",
                    modifier = Modifier.testTag("manual-repair-status"),
                )
                "failed" -> Text(
                    text = "Human RepairAttempt error: " +
                        "${state.manualRepair.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("manual-repair-status"),
                )
            }
            Button(
                onClick = onDeliverManualRepairAndLinkBuild,
                enabled = state.manualRepair.phase == "loaded" &&
                    state.humanRepairBuild.phase != "loading" &&
                    state.humanRepairBuild.phase != "linked",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("deliver-manual-repair-build"),
            ) {
                Text("交付人工修复并绑定 QA Build")
            }
            when (state.humanRepairBuild.phase) {
                "loading" -> Text(
                    text = "Human delivery/Build: linking…",
                    modifier = Modifier.testTag("human-repair-build-status"),
                )
                "linked" -> Text(
                    text = "Attempt ${state.humanRepairBuild.attemptId}; " +
                        "commit=${state.humanRepairBuild.deliveredCommitSha}; " +
                        "Build=${state.humanRepairBuild.buildId}/" +
                        "${state.humanRepairBuild.buildStatus}; " +
                        "Bug=${state.humanRepairBuild.bugState}; wrongSha=" +
                        "${state.humanRepairBuild.wrongShaRejectionCode}.",
                    modifier = Modifier.testTag("human-repair-build-status"),
                )
                "failed" -> Text(
                    text = "Human delivery/Build error: " +
                        "${state.humanRepairBuild.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("human-repair-build-status"),
                )
            }
            Button(
                onClick = onVerifyManualRepairAndClose,
                enabled = state.humanRepairBuild.phase == "linked" &&
                    state.humanRepairBuild.verificationPhase != "loading" &&
                    state.humanRepairBuild.verificationPhase != "closed",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("verify-manual-repair-close"),
            ) {
                Text("人工验收 QA Build 并关闭 Bug")
            }
            when (state.humanRepairBuild.verificationPhase) {
                "loading" -> Text(
                    text = "Human Verification: running…",
                    modifier = Modifier.testTag("human-verification-status"),
                )
                "closed" -> Text(
                    text = "Verification ${state.humanRepairBuild.verificationId}/" +
                        "${state.humanRepairBuild.verificationStatus}; Bug=" +
                        "${state.humanRepairBuild.closedBugState}/v" +
                        "${state.humanRepairBuild.closedBugVersion}; missingResult=" +
                        "${state.humanRepairBuild.missingResultRejectionCode}.",
                    modifier = Modifier.testTag("human-verification-status"),
                )
                "failed" -> Text(
                    text = "Human Verification error: " +
                        "${state.humanRepairBuild.verificationErrorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("human-verification-status"),
                )
            }
            Button(
                onClick = onRefreshLatestHumanWorkflow,
                enabled = state.humanWorkflow.phase != "loading",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("refresh-human-workflow"),
            ) {
                Text("重启后回读最近人工闭环")
            }
            when (state.humanWorkflow.phase) {
                "loading" -> Text(
                    text = "Human workflow: reading persisted facts…",
                    modifier = Modifier.testTag("human-workflow-status"),
                )
                "loaded" -> Text(
                    text = "${state.humanWorkflow.bugKey}/" +
                        "${state.humanWorkflow.bugState}/v${state.humanWorkflow.bugVersion}; " +
                        "Attempt=${state.humanWorkflow.repairAttemptStatus}; " +
                        "Build=${state.humanWorkflow.buildStatus}; " +
                        "Verification=${state.humanWorkflow.verificationStatus}/v" +
                        "${state.humanWorkflow.verificationVersion}; missing=" +
                        "${state.humanWorkflow.missingWorkflowRejectionCode}; " +
                        "result=${state.humanWorkflow.resultSummary}.",
                    modifier = Modifier.testTag("human-workflow-status"),
                )
                "failed" -> Text(
                    text = "Human workflow readback error: " +
                        "${state.humanWorkflow.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("human-workflow-status"),
                )
            }
            Button(
                onClick = onCreateCommentAndReadAudit,
                enabled = state.commentAudit.phase != "loading",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("create-comment-audit"),
            ) {
                Text("评论并回读审计时间线")
            }
            when (state.commentAudit.phase) {
                "loading" -> Text(
                    text = "Comment/audit: writing and reading persisted facts…",
                    modifier = Modifier.testTag("comment-audit-status"),
                )
                "loaded" -> Text(
                    text = "${state.commentAudit.bugKey} Comment=" +
                        "${state.commentAudit.commentId}; event=" +
                        "${state.commentAudit.eventType}/${state.commentAudit.eventId}; " +
                        "timeline=${state.commentAudit.eventCount}; missing=" +
                        "${state.commentAudit.missingBugRejectionCode}; body=" +
                        "${state.commentAudit.commentBody}.",
                    modifier = Modifier.testTag("comment-audit-status"),
                )
                "failed" -> Text(
                    text = "Comment/audit error: " +
                        "${state.commentAudit.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("comment-audit-status"),
                )
            }
            Button(
                onClick = onCreateBugAndCheckDuplicates,
                enabled = state.duplicateCandidates.phase != "loading",
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("check-duplicates"),
            ) {
                Text("创建 Bug 并检查重复")
            }
            when (state.duplicateCandidates.phase) {
                "loading" -> Text(
                    text = "Duplicate candidates: loading…",
                    modifier = Modifier.testTag("duplicate-status"),
                )
                "loaded" -> Text(
                    text = "Duplicate candidates ${state.duplicateCandidates.count}; " +
                        "first=${state.duplicateCandidates.firstBugKey ?: "none"}; " +
                        "score=${state.duplicateCandidates.firstScore ?: 0.0}; " +
                        "reason=${state.duplicateCandidates.firstReason ?: "none"}.",
                    modifier = Modifier.testTag("duplicate-status"),
                )
                "failed" -> Text(
                    text = "Duplicate check error: " +
                        "${state.duplicateCandidates.errorCode ?: "UNKNOWN"}.",
                    modifier = Modifier.testTag("duplicate-status"),
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = onStartCaptureSession,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("start-capture-session"),
                ) {
                    Text("Start capture session")
                }
                OutlinedButton(
                    onClick = onCaptureNow,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("capture-now"),
                ) {
                    Text("Capture now")
                }
                OutlinedButton(
                    onClick = onStopCaptureSession,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("stop-capture-session"),
                ) {
                    Text("Stop")
                }
            }

            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = state.lastAction,
                    modifier = Modifier
                        .padding(14.dp)
                        .testTag("last-action"),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Spacer(Modifier.size(16.dp))
        }
    }
}
@Composable
private fun ScopeCard(state: FoundationUiState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = "Current local scope",
                style = MaterialTheme.typography.labelLarge,
            )
            Text(
                text = state.accountName,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(text = state.projectName, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun FoundationCard(
    title: String,
    detail: String,
    value: String,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(text = detail, style = MaterialTheme.typography.bodyMedium)
            Text(
                text = value,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}
