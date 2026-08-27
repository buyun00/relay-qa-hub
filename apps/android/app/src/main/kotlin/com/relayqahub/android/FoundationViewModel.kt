package com.relayqahub.android

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.relayqahub.android.capture.CapturedPocoArtifact
import com.relayqahub.android.capture.PendingCaptureDraft
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.data.QueueState
import com.relayqahub.android.capture.CapturePocoSummary
import com.relayqahub.android.network.AttachmentUploadFailure
import com.relayqahub.android.network.AndroidUpdateRelease
import com.relayqahub.android.network.ApkArtifact
import com.relayqahub.android.network.ApkDistributionException
import com.relayqahub.android.network.DownloadedApk
import com.relayqahub.android.network.CaptureAttachmentReceipt
import com.relayqahub.android.network.CaptureBundleArtifactUpload
import com.relayqahub.android.network.CaptureBundleDeviceInput
import com.relayqahub.android.network.CaptureBundlePocoInput
import com.relayqahub.android.network.QaHubApiContract
import com.relayqahub.android.network.BuildProjectionFailure
import com.relayqahub.android.network.BuildProjectionResult
import com.relayqahub.android.network.BugWorkbenchFailure
import com.relayqahub.android.network.WorkbenchBug
import com.relayqahub.android.network.WorkbenchBugImage
import com.relayqahub.android.network.CommentTimelineFailure
import com.relayqahub.android.network.DuplicateCandidateFailure
import com.relayqahub.android.network.InboxFailure
import com.relayqahub.android.network.HumanWorkflowFailure
import com.relayqahub.android.network.RelayHandoffFailure
import com.relayqahub.android.network.RelayHandoffResult
import com.relayqahub.android.network.RepairAttemptFailure
import com.relayqahub.android.poco.PocoEnrichmentStatus
import com.relayqahub.android.work.SyncRunResult
import com.relayqahub.android.work.OfflineAttachmentDraftContract
import com.relayqahub.android.work.StagedOfflineAttachment
import com.relayqahub.android.work.StagedOfflineBugDraft
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import org.json.JSONObject

data class FoundationUiState(
    val page: QaHubPage = QaHubPage.BUG_LIST,
    val captureSessionStatus: CaptureSessionUiStatus = CaptureSessionUiStatus.STOPPED,
    val overlayPermissionGranted: Boolean = false,
    val people: QaPeopleConfig = QaPeopleConfig(1, "LOCAL", emptyList()),
    val currentActorId: String = "",
    val preferredFixerId: String? = null,
    val newBugFormRevision: Long = 0,
    val captureDraft: CaptureDraftUiState = CaptureDraftUiState(),
    val accountName: String = "Preparing local scope…",
    val projectName: String = "Preparing native foundation…",
    val cachedItemCount: Int = 0,
    val queuedOperationCount: Int = 0,
    val latestQaItemId: String? = null,
    val latestQaItemKey: String? = null,
    val latestDeliveryState: String? = null,
    val latestDeliveryError: String? = null,
    val credentialBoundary: String = "Checking Android Keystore…",
    val contractVersion: String = QaHubApiContract.VERSION,
    val lastAction: String = "Ready for offline-first QA work.",
    val relayHandoff: RelayHandoffResult? = null,
    val buildProjection: BuildProjectionUiState = BuildProjectionUiState(),
    val inbox: InboxUiState = InboxUiState(),
    val bugWorkbench: BugWorkbenchUiState = BugWorkbenchUiState(),
    val bugDetail: BugDetailUiState = BugDetailUiState(),
    val manualRepair: ManualRepairUiState = ManualRepairUiState(),
    val humanRepairBuild: HumanRepairBuildUiState = HumanRepairBuildUiState(),
    val humanWorkflow: HumanWorkflowUiState = HumanWorkflowUiState(),
    val commentAudit: CommentAuditUiState = CommentAuditUiState(),
    val duplicateCandidates: DuplicateCandidateUiState = DuplicateCandidateUiState(),
    val pendingCapture: PendingCaptureUiState = PendingCaptureUiState(),
    val selfUpdate: SelfUpdateUiState = SelfUpdateUiState(),
    val gameApkCatalog: GameApkCatalogUiState = GameApkCatalogUiState(),
    val apkDownload: ApkDownloadUiState = ApkDownloadUiState(),
)

enum class QaHubPage {
    CAPTURE_SETTINGS,
    NEW_BUG,
    BUG_LIST,
}

enum class CaptureSessionUiStatus {
    STOPPED,
    STARTING,
    ACTIVE,
    UNAVAILABLE,
}

data class CaptureDraftUiState(
    val available: Boolean = false,
    val captureId: String? = null,
    val privatePath: String? = null,
    val width: Int = 0,
    val height: Int = 0,
    val requestedAtEpochMs: Long = 0L,
    val pocoStatus: String? = null,
)

data class PendingCaptureUiState(
    val available: Boolean = false,
    val captureId: String? = null,
    val width: Int = 0,
    val height: Int = 0,
    val enrichmentStatus: String? = null,
    val deliveryState: String = "NONE",
)

data class SelfUpdateUiState(
    val phase: String = "idle",
    val currentVersionName: String = BuildConfig.VERSION_NAME,
    val currentVersionCode: Long = BuildConfig.VERSION_CODE.toLong(),
    val release: AndroidUpdateRelease? = null,
    val errorCode: String? = null,
    val checkedAtEpochMs: Long? = null,
)

data class GameApkCatalogUiState(
    val phase: String = "idle",
    val items: List<ApkArtifact> = emptyList(),
    val errorCode: String? = null,
    val refreshedAtEpochMs: Long? = null,
)

data class ApkDownloadUiState(
    val phase: String = "idle",
    val artifactId: String? = null,
    val fileName: String? = null,
    val progressPercent: Int = 0,
    val errorCode: String? = null,
)

private const val UPDATE_CHECK_INTERVAL_MS = 4L * 60L * 60L * 1_000L
private const val GAME_CATALOG_REFRESH_INTERVAL_MS = 5L * 60L * 1_000L

data class BuildProjectionUiState(
    val phase: String = "idle",
    val buildId: String? = null,
    val deliveredCommitSha: String? = null,
    val linked: Boolean = false,
    val errorCode: String? = null,
)

data class InboxUiState(
    val phase: String = "idle",
    val itemCount: Int = 0,
    val unreadCount: Int = 0,
    val firstTitle: String? = null,
    val errorCode: String? = null,
)

data class DuplicateCandidateUiState(
    val phase: String = "idle",
    val sourceBugId: String? = null,
    val count: Int = 0,
    val firstBugKey: String? = null,
    val firstScore: Double? = null,
    val firstReason: String? = null,
    val errorCode: String? = null,
)

data class BugWorkbenchUiState(
    val phase: String = "idle",
    val snapshotSequence: Long = 0,
    val itemCount: Int = 0,
    val stateFilter: String = "reported",
    val firstBugKey: String? = null,
    val firstTitle: String? = null,
    val errorCode: String? = null,
    val items: List<com.relayqahub.android.network.WorkbenchBug> = emptyList(),
)

data class BugDetailUiState(
    val phase: String = "idle",
    val bugId: String? = null,
    val bug: WorkbenchBug? = null,
    val images: List<WorkbenchBugImage> = emptyList(),
    val imageErrorCode: String? = null,
    val errorCode: String? = null,
)

data class ManualRepairUiState(
    val phase: String = "idle",
    val bugKey: String? = null,
    val attemptId: String? = null,
    val mode: String? = null,
    val status: String? = null,
    val missingEvidenceRejectionCode: String? = null,
    val errorCode: String? = null,
)

data class HumanRepairBuildUiState(
    val phase: String = "idle",
    val bugId: String? = null,
    val bugVersion: Int = 0,
    val attemptId: String? = null,
    val deliveredCommitSha: String? = null,
    val buildId: String? = null,
    val buildStatus: String? = null,
    val bugState: String? = null,
    val wrongShaRejectionCode: String? = null,
    val errorCode: String? = null,
    val verificationPhase: String = "idle",
    val verificationId: String? = null,
    val verificationStatus: String? = null,
    val closedBugState: String? = null,
    val closedBugVersion: Int = 0,
    val missingResultRejectionCode: String? = null,
    val verificationErrorCode: String? = null,
)

data class HumanWorkflowUiState(
    val phase: String = "idle",
    val bugKey: String? = null,
    val bugState: String? = null,
    val bugVersion: Int = 0,
    val repairAttemptId: String? = null,
    val repairAttemptStatus: String? = null,
    val buildId: String? = null,
    val buildStatus: String? = null,
    val verificationId: String? = null,
    val verificationStatus: String? = null,
    val verificationVersion: Int = 0,
    val resultSummary: String? = null,
    val missingWorkflowRejectionCode: String? = null,
    val errorCode: String? = null,
)

data class CommentAuditUiState(
    val phase: String = "idle",
    val bugKey: String? = null,
    val commentId: String? = null,
    val commentBody: String? = null,
    val eventId: String? = null,
    val eventType: String? = null,
    val eventCount: Int = 0,
    val missingBugRejectionCode: String? = null,
    val errorCode: String? = null,
)

private data class ScopeUiValues(
    val accountName: String,
    val projectName: String,
    val cachedItemCount: Int,
    val queuedOperationCount: Int,
    val latestQaItemId: String?,
    val latestQaItemKey: String?,
    val latestDeliveryState: String?,
    val latestDeliveryError: String?,
)

private data class DeliveryUiValues(
    val buildProjection: BuildProjectionUiState,
    val inbox: InboxUiState,
    val bugWorkbench: BugWorkbenchUiState,
    val manualRepair: ManualRepairUiState,
    val humanRepairBuild: HumanRepairBuildUiState,
)

private data class DiscoveryUiValues(
    val duplicateCandidates: DuplicateCandidateUiState,
    val humanWorkflow: HumanWorkflowUiState,
    val commentAudit: CommentAuditUiState,
    val pendingCapture: PendingCaptureUiState,
)

private data class CommentAuditResult(
    val bugKey: String,
    val commentId: String,
    val commentBody: String,
    val eventId: String,
    val eventType: String,
    val eventCount: Int,
    val missingBugCode: String,
)

class FoundationViewModel(application: Application) : AndroidViewModel(application) {
    private val appContainer = (application as QaHubApplication).container
    private val scope = foundationScope(
        checkNotNull(appContainer.identityStore.actorIdOrNull()) {
            "QA identity must be selected before FoundationViewModel is created"
        },
    )
    private val lastAction = MutableStateFlow("Ready for offline-first QA work.")
    private val latestRelayHandoff = MutableStateFlow<RelayHandoffResult?>(null)
    private val buildProjection = MutableStateFlow(BuildProjectionUiState())
    private val inbox = MutableStateFlow(InboxUiState())
    private val bugWorkbench = MutableStateFlow(BugWorkbenchUiState())
    private val manualRepair = MutableStateFlow(ManualRepairUiState())
    private val humanRepairBuild = MutableStateFlow(HumanRepairBuildUiState())
    private val duplicateCandidates = MutableStateFlow(DuplicateCandidateUiState())
    private val humanWorkflow = MutableStateFlow(HumanWorkflowUiState())
    private val commentAudit = MutableStateFlow(CommentAuditUiState())
    private val pendingCapture = MutableStateFlow(PendingCaptureUiState())
    private val page = MutableStateFlow(QaHubPage.BUG_LIST)
    private val captureSessionStatus = MutableStateFlow(CaptureSessionUiStatus.STOPPED)
    private val overlayPermissionGranted = MutableStateFlow(false)
    private val people = MutableStateFlow(QaPeopleConfig(1, "LOCAL", emptyList()))
    private val captureDraft = MutableStateFlow(CaptureDraftUiState())
    private val preferredFixerId = MutableStateFlow<String?>(null)
    private val bugDetail = MutableStateFlow(BugDetailUiState())
    private val newBugFormRevision = MutableStateFlow(0L)
    private val selfUpdate = MutableStateFlow(SelfUpdateUiState())
    private val gameApkCatalog = MutableStateFlow(GameApkCatalogUiState())
    private val apkDownload = MutableStateFlow(ApkDownloadUiState())
    private val apkInstallRequestFlow = MutableSharedFlow<DownloadedApk>(extraBufferCapacity = 1)

    val apkInstallRequests = apkInstallRequestFlow.asSharedFlow()

    private val scopeState = combine(
        appContainer.scopedRepository.observeAccount(scope.accountId),
        appContainer.scopedRepository.observeProject(scope),
        appContainer.scopedRepository.observeCachedItems(scope),
        appContainer.scopedRepository.observeOutstandingCount(scope),
        appContainer.scopedRepository.observeLatestSubmission(scope),
    ) { account, project, cachedItems, queuedCount, latestSubmission ->
        ScopeUiValues(
            accountName = account?.displayName ?: "Local account scope",
            projectName = project?.displayName ?: "Local project scope",
            cachedItemCount = cachedItems.size,
            queuedOperationCount = queuedCount,
            latestQaItemId = latestSubmission.receipt?.qaItemId,
            latestQaItemKey = latestSubmission.receipt?.qaItemKey,
            latestDeliveryState = latestSubmission.operation?.state?.name,
            latestDeliveryError = latestSubmission.operation?.lastErrorCode,
        )
    }

    private val deliveryState = combine(
        buildProjection,
        inbox,
        bugWorkbench,
        manualRepair,
        humanRepairBuild,
    ) { projection, inboxState, workbenchState, manualRepairState, humanRepairBuildState ->
        DeliveryUiValues(
            buildProjection = projection,
            inbox = inboxState,
            bugWorkbench = workbenchState,
            manualRepair = manualRepairState,
            humanRepairBuild = humanRepairBuildState,
        )
    }

    private val discoveryState = combine(
        duplicateCandidates,
        humanWorkflow,
        commentAudit,
        pendingCapture,
    ) { duplicateState, workflowState, commentAuditState, pendingCaptureState ->
        DiscoveryUiValues(
            duplicateCandidates = duplicateState,
            humanWorkflow = workflowState,
            commentAudit = commentAuditState,
            pendingCapture = pendingCaptureState,
        )
    }

    private val baseUiState = combine(
        scopeState,
        lastAction,
        latestRelayHandoff,
        deliveryState,
        discoveryState,
    ) { values, action, handoff, delivery, discovery ->
        val support = appContainer.credentialVault.support()
        FoundationUiState(
            currentActorId = scope.actorId,
            accountName = values.accountName,
            projectName = values.projectName,
            cachedItemCount = values.cachedItemCount,
            queuedOperationCount = values.queuedOperationCount,
            latestQaItemId = values.latestQaItemId,
            latestQaItemKey = values.latestQaItemKey,
            latestDeliveryState = values.latestDeliveryState,
            latestDeliveryError = values.latestDeliveryError,
            credentialBoundary = if (support.available) {
                "${support.provider} format v${support.formatVersion} available"
            } else {
                "Unavailable: ${support.reasonCode}"
            },
            lastAction = action,
            relayHandoff = handoff,
            buildProjection = delivery.buildProjection,
            inbox = delivery.inbox,
            bugWorkbench = delivery.bugWorkbench,
            manualRepair = delivery.manualRepair,
            humanRepairBuild = delivery.humanRepairBuild,
            humanWorkflow = discovery.humanWorkflow,
            commentAudit = discovery.commentAudit,
            duplicateCandidates = discovery.duplicateCandidates,
            pendingCapture = discovery.pendingCapture,
        )
    }

    val uiState = baseUiState
        .combine(page) { state, currentPage -> state.copy(page = currentPage) }
        .combine(captureSessionStatus) { state, status ->
            state.copy(captureSessionStatus = status)
        }
        .combine(overlayPermissionGranted) { state, granted ->
            state.copy(overlayPermissionGranted = granted)
        }
        .combine(people) { state, config -> state.copy(people = config) }
        .combine(captureDraft) { state, draft -> state.copy(captureDraft = draft) }
        .combine(preferredFixerId) { state, fixerId -> state.copy(preferredFixerId = fixerId) }
        .combine(bugDetail) { state, detail -> state.copy(bugDetail = detail) }
        .combine(newBugFormRevision) { state, revision ->
            state.copy(newBugFormRevision = revision)
        }
        .combine(selfUpdate) { state, update -> state.copy(selfUpdate = update) }
        .combine(gameApkCatalog) { state, catalog -> state.copy(gameApkCatalog = catalog) }
        .combine(apkDownload) { state, download -> state.copy(apkDownload = download) }
        .stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = FoundationUiState(),
    )

    init {
        runCatching {
            QaPeopleConfigLoader.ensureExternalSeed(getApplication())
            people.value = QaPeopleConfigLoader.load(getApplication())
        }
        viewModelScope.launch {
            appContainer.scopedRepository.seedFoundationScope(scope)
        }
        checkForSelfUpdate()
        refreshGameApkCatalog()
        viewModelScope.launch {
            appContainer.scopedRepository.observeLatestSubmission(scope).collect { latestSubmission ->
                refreshPendingCaptureState()
                if (latestSubmission.receipt != null && page.value != QaHubPage.NEW_BUG) {
                    refreshBugWorkbench()
                }
            }
        }
    }

    fun navigateTo(page: QaHubPage) {
        this.page.value = page
        if (page == QaHubPage.BUG_LIST) refreshBugWorkbench()
        if (page == QaHubPage.CAPTURE_SETTINGS) {
            checkForSelfUpdate()
            refreshGameApkCatalog()
        }
    }

    fun checkForSelfUpdate(force: Boolean = false) {
        val current = selfUpdate.value
        if (current.phase == "checking") return
        val checkedAt = current.checkedAtEpochMs
        if (!force && checkedAt != null && System.currentTimeMillis() - checkedAt < UPDATE_CHECK_INTERVAL_MS) {
            return
        }
        selfUpdate.value = current.copy(phase = "checking", errorCode = null)
        viewModelScope.launch {
            runCatching { appContainer.androidUpdateClient.latest() }
                .onSuccess { release ->
                    val now = System.currentTimeMillis()
                    selfUpdate.value = when {
                        release.packageName != BuildConfig.APPLICATION_ID -> SelfUpdateUiState(
                            phase = "failed",
                            errorCode = "UPDATE_PACKAGE_MISMATCH",
                            checkedAtEpochMs = now,
                        )
                        release.versionCode > BuildConfig.VERSION_CODE.toLong() -> SelfUpdateUiState(
                            phase = "available",
                            release = release,
                            checkedAtEpochMs = now,
                        )
                        else -> SelfUpdateUiState(
                            phase = "up_to_date",
                            checkedAtEpochMs = now,
                        )
                    }
                }
                .onFailure { error ->
                    selfUpdate.value = SelfUpdateUiState(
                        phase = if ((error as? ApkDistributionException)?.code == "UPDATE_NOT_PUBLISHED") {
                            "not_published"
                        } else {
                            "failed"
                        },
                        errorCode = (error as? ApkDistributionException)?.code
                            ?: "UPDATE_CHECK_FAILED",
                        checkedAtEpochMs = System.currentTimeMillis(),
                    )
                }
        }
    }

    fun refreshGameApkCatalog(force: Boolean = false) {
        val current = gameApkCatalog.value
        if (current.phase == "loading") return
        val refreshedAt = current.refreshedAtEpochMs
        if (!force && refreshedAt != null &&
            System.currentTimeMillis() - refreshedAt < GAME_CATALOG_REFRESH_INTERVAL_MS
        ) {
            return
        }
        gameApkCatalog.value = current.copy(phase = "loading", errorCode = null)
        viewModelScope.launch {
            runCatching { appContainer.gameApkCatalogClient.latest(limit = 5) }
                .onSuccess { items ->
                    gameApkCatalog.value = GameApkCatalogUiState(
                        phase = "ready",
                        items = items,
                        refreshedAtEpochMs = System.currentTimeMillis(),
                    )
                }
                .onFailure { error ->
                    gameApkCatalog.value = current.copy(
                        phase = "failed",
                        errorCode = (error as? ApkDistributionException)?.code
                            ?: "GAME_APK_CATALOG_FAILED",
                    )
                }
        }
    }

    fun downloadSelfUpdate() {
        val release = selfUpdate.value.release ?: return
        downloadAndInstall(release.asArtifact())
    }

    fun downloadGameApk(artifact: ApkArtifact) {
        val trusted = gameApkCatalog.value.items.firstOrNull { it.id == artifact.id } ?: return
        downloadAndInstall(trusted)
    }

    fun reportApkInstallFailure(code: String) {
        val current = apkDownload.value
        apkDownload.value = current.copy(phase = "failed", errorCode = code)
    }

    private fun downloadAndInstall(artifact: ApkArtifact) {
        if (apkDownload.value.phase == "downloading") return
        apkDownload.value = ApkDownloadUiState(
            phase = "downloading",
            artifactId = artifact.id,
            fileName = artifact.fileName,
        )
        viewModelScope.launch {
            runCatching {
                appContainer.apkDownloadClient.download(artifact) { progress ->
                    apkDownload.value = apkDownload.value.copy(progressPercent = progress)
                }
            }.onSuccess { downloaded ->
                apkDownload.value = apkDownload.value.copy(
                    phase = "installing",
                    progressPercent = 100,
                )
                apkInstallRequestFlow.emit(downloaded)
            }.onFailure { error ->
                apkDownload.value = apkDownload.value.copy(
                    phase = "failed",
                    errorCode = (error as? ApkDistributionException)?.code
                        ?: "APK_DOWNLOAD_FAILED",
                )
            }
        }
    }

    fun onCaptureReady(
        captureId: String,
        privatePath: String,
        width: Int,
        height: Int,
        requestedAtEpochMs: Long,
        pocoStatus: String,
    ) {
        captureDraft.value = CaptureDraftUiState(
            available = true,
            captureId = captureId,
            privatePath = privatePath,
            width = width,
            height = height,
            requestedAtEpochMs = requestedAtEpochMs,
            pocoStatus = pocoStatus,
        )
        page.value = QaHubPage.NEW_BUG
        lastAction.value = "截图已载入新建 Bug。"
    }

    fun restoreLatestCaptureDraft() {
        viewModelScope.launch {
            val draft = runCatching { appContainer.pendingCaptureDraftStore.latest() }.getOrNull()
                ?: return@launch
            val queued = appContainer.scopedRepository.findOperationByIdempotencyKey(
                scope = scope,
                idempotencyKey = "submission:${draft.clientSubmissionId}:commit",
            )
            if (queued != null && queued.state != QueueState.FAILED_PERMANENT) {
                refreshPendingCaptureState()
                return@launch
            }
            if (draft.captureId != captureDraft.value.captureId) {
                onCaptureReady(
                    captureId = draft.captureId,
                    privatePath = draft.primaryPath,
                    width = draft.width,
                    height = draft.height,
                    requestedAtEpochMs = draft.requestedAtEpochMs,
                    pocoStatus = draft.poco.status.name,
                )
            }
        }
    }

    fun clearCaptureDraft() {
        val captureId = captureDraft.value.captureId
        captureDraft.value = CaptureDraftUiState()
        viewModelScope.launch {
            appContainer.pendingCaptureDraftStore.latest()
                ?.takeIf { it.captureId == captureId }
                ?.let { runCatching { appContainer.pendingCaptureDraftStore.delete(it) } }
        }
    }

    fun queueLocalDraft() {
        viewModelScope.launch {
            runCatching {
                appContainer.scopedRepository.enqueue(
                    scope = scope,
                    request = FoundationCreateBugContract.buildOperation(
                        projectId = scope.projectId,
                        submissionId = UUID.randomUUID().toString(),
                        observedAt = Instant.now().toString(),
                        qaAppVersion = BuildConfig.VERSION_NAME,
                    ),
                )
            }.onSuccess {
                lastAction.value = "Local draft queued inside the current account/project scope."
            }.onFailure {
                lastAction.value = "Queue rejected by the local isolation boundary."
            }
        }
    }

    fun scheduleConstrainedSync() {
        appContainer.syncScheduler.enqueue(scope)
        lastAction.value = "Sync scheduled with connected-network and battery constraints."
    }

    fun runLiveSmoke() {
        queueOfflinePngDraft(
            pngBytes = createLiveSmokePng(),
            filename = LIVE_SMOKE_FILENAME,
            actionLabel = "Live smoke",
        )
    }

    private fun queueOfflinePngDraft(
        pngBytes: ByteArray,
        filename: String,
        actionLabel: String,
        submissionId: String = UUID.randomUUID().toString(),
        clientAttachmentId: String = UUID.randomUUID().toString(),
        captureId: String? = null,
        capturedAtEpochMs: Long? = null,
        observedAt: String = Instant.now().toString(),
        qaAppVersion: String = BuildConfig.VERSION_NAME,
        onCompleted: () -> Unit = {},
    ) {
        queueDurableBugDraft(
            originalPng = pngBytes,
            annotatedPng = null,
            originalFilename = filename,
            actionLabel = actionLabel,
            submissionId = submissionId,
            originalAttachmentId = clientAttachmentId,
            captureId = captureId,
            capturedAtEpochMs = capturedAtEpochMs,
            observedAt = observedAt,
            qaAppVersion = qaAppVersion,
            title = "Native QA Hub contract-validation draft",
            description =
                "The Android foundation queued a representative Bug command for offline sync.",
            expectedBehavior =
                "A valid App-first Bug command remains isolated to its authenticated project.",
            ownerId = null,
            verificationOwnerId = null,
            navigateAfterQueue = false,
            onCompleted = onCompleted,
        )
    }

    private fun queueDurableBugDraft(
        originalPng: ByteArray?,
        annotatedPng: ByteArray?,
        originalFilename: String,
        actionLabel: String,
        submissionId: String,
        originalAttachmentId: String,
        captureId: String?,
        capturedAtEpochMs: Long?,
        observedAt: String,
        qaAppVersion: String,
        title: String,
        description: String,
        expectedBehavior: String,
        ownerId: String?,
        verificationOwnerId: String?,
        navigateAfterQueue: Boolean,
        onCompleted: () -> Unit = {},
    ) {
        val immutableOriginal = originalPng?.copyOf()
        val immutableAnnotated = annotatedPng?.copyOf()
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                lastAction.value =
                    "$actionLabel unavailable: configure qaHubDebugAccessToken for a debug build."
                onCompleted()
                return@launch
            }

            val preferredKey = "submission:$submissionId:commit"
            val previous = appContainer.scopedRepository.findOperationByIdempotencyKey(
                scope = scope,
                idempotencyKey = preferredKey,
            )
            if (previous != null && previous.state != QueueState.FAILED_PERMANENT) {
                lastAction.value = "$actionLabel 已在持久队列中，无需重复提交。"
                if (navigateAfterQueue) finishNewBugForm()
                onCompleted()
                return@launch
            }
            val effectiveSubmissionId = if (previous == null) submissionId else UUID.randomUUID().toString()
            val effectiveOriginalAttachmentId = if (previous == null) {
                originalAttachmentId
            } else {
                UUID.randomUUID().toString()
            }
            val persistedAttachmentIds = mutableListOf<String>()
            lastAction.value = "正在持久保存 Bug 字段和图片，尚未发起网络请求…"
            val result = runCatching {
                appContainer.scopedRepository.seedFoundationScope(scope)
                val stagedAttachments = buildList {
                    immutableOriginal?.let { bytes ->
                        val metadata = appContainer.offlineAttachmentDraftStore.persist(
                            submissionId = effectiveSubmissionId,
                            clientAttachmentId = effectiveOriginalAttachmentId,
                            pngBytes = bytes,
                        )
                        persistedAttachmentIds += effectiveOriginalAttachmentId
                        add(
                            StagedOfflineAttachment(
                                clientAttachmentId = effectiveOriginalAttachmentId,
                                filename = originalFilename,
                                expectedSize = metadata.expectedSize,
                                sha256 = metadata.sha256,
                                role = OfflineAttachmentDraftContract.ROLE_ORIGINAL,
                            ),
                        )
                    }
                    immutableAnnotated?.let { bytes ->
                        val annotatedAttachmentId = UUID.nameUUIDFromBytes(
                            "$effectiveSubmissionId:annotated".toByteArray(Charsets.UTF_8),
                        ).toString()
                        val metadata = appContainer.offlineAttachmentDraftStore.persist(
                            submissionId = effectiveSubmissionId,
                            clientAttachmentId = annotatedAttachmentId,
                            pngBytes = bytes,
                        )
                        persistedAttachmentIds += annotatedAttachmentId
                        add(
                            StagedOfflineAttachment(
                                clientAttachmentId = annotatedAttachmentId,
                                filename = originalFilename.substringBeforeLast('.', originalFilename) +
                                    "-annotated.png",
                                expectedSize = metadata.expectedSize,
                                sha256 = metadata.sha256,
                                role = OfflineAttachmentDraftContract.ROLE_ANNOTATED,
                            ),
                        )
                    }
                }
                val request = OfflineAttachmentDraftContract.buildOperation(
                    projectId = scope.projectId,
                    staged = StagedOfflineBugDraft(
                        submissionId = effectiveSubmissionId,
                        observedAt = observedAt,
                        qaAppVersion = qaAppVersion,
                        title = title,
                        description = description,
                        expectedBehavior = expectedBehavior,
                        ownerId = ownerId,
                        verificationOwnerId = verificationOwnerId,
                        captureId = captureId,
                        capturedAtEpochMs = capturedAtEpochMs,
                        attachments = stagedAttachments,
                    ),
                )
                val operationId = appContainer.scopedRepository.enqueue(scope, request)
                appContainer.syncScheduler.enqueue(scope)
                operationId
            }
            result.onSuccess { operationId ->
                lastAction.value =
                    "$actionLabel 已持久排队 (${operationId.take(8)})；网络恢复后自动上传并创建。" +
                        if (captureId == null) "" else " Poco 上下文将在线尽力附加，失败不阻断 Bug。"
                if (navigateAfterQueue) finishNewBugForm()
            }.onFailure { failure ->
                persistedAttachmentIds.forEach { attachmentId ->
                    runCatching {
                        appContainer.offlineAttachmentDraftStore.delete(
                            effectiveSubmissionId,
                            attachmentId,
                        )
                    }
                }
                val code = (failure as? LiveSmokeFailure)?.code
                    ?: "OFFLINE_DRAFT_PERSIST_FAILED"
                lastAction.value = "$actionLabel failed: $code."
            }
            onCompleted()
        }
    }

    private fun finishNewBugForm() {
        captureDraft.value = CaptureDraftUiState()
        newBugFormRevision.value += 1
        page.value = QaHubPage.BUG_LIST
    }

    /**
     * Runs the smallest App-first Relay handoff slice. The Bug is still created through the
     * Room queue and normal sync/receipt path; only the subsequent guarded workflow calls are
     * direct QA Hub requests using the native human token.
     */
    fun dispatchToRelay() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                lastAction.value =
                    "Relay handoff unavailable: configure qaHubDebugAccessToken for a debug build."
                return@launch
            }

            lastAction.value = "Creating a no-attachment Bug through the Room queue…"
            val result = runCatching {
                appContainer.scopedRepository.seedFoundationScope(scope)
                val submissionId = UUID.randomUUID().toString()
                val operationId = appContainer.scopedRepository.enqueue(
                    scope = scope,
                    request = FoundationCreateBugContract.buildOperation(
                        projectId = scope.projectId,
                        submissionId = submissionId,
                        observedAt = Instant.now().toString(),
                        qaAppVersion = BuildConfig.VERSION_NAME,
                    ),
                )
                appContainer.syncEngine.run(scope)
                val receipt = appContainer.scopedRepository.findReceipt(scope, operationId)
                    ?: throw RelayHandoffFailure("BUG_COMMIT_RECEIPT_MISSING")
                appContainer.relayHandoffClient.dispatchBugToRelay(
                    bugId = receipt.bugId,
                    bugKey = receipt.qaItemKey,
                    actorId = scope.actorId,
                    accessToken = accessToken,
                )
            }
            result.onSuccess { handoff ->
                latestRelayHandoff.value = handoff
                buildProjection.value = BuildProjectionUiState()
                lastAction.value =
                    "${handoff.bugKey} queued to Relay; receipt=${handoff.handoffStatus}; " +
                        "requiresHumanVerification=${handoff.requiresHumanVerification}."
            }.onFailure { failure ->
                val code = when (failure) {
                    is RelayHandoffFailure -> failure.code
                    else -> "UNEXPECTED_RELAY_HANDOFF_FAILURE"
                }
                lastAction.value = "Relay handoff failed: $code."
            }
        }
    }

    /** Human-only action: register the delivered commit as a Build and read it back. */
    fun adoptFixAndBindQaBuild() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setBuildProjectionFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            val handoff = latestRelayHandoff.value
            if (handoff == null) {
                setBuildProjectionFailure("RELAY_HANDOFF_MISSING")
                return@launch
            }
            if (handoff.handoffStatus != "fix_delivered") {
                setBuildProjectionFailure("BUILD_ADOPTION_REQUIRES_FIX_DELIVERED")
                return@launch
            }
            if (handoff.deliveredCommitSha.isNullOrBlank()) {
                setBuildProjectionFailure("BUILD_DELIVERED_COMMIT_MISSING")
                return@launch
            }

            buildProjection.value = BuildProjectionUiState(
                phase = "in_flight",
                deliveredCommitSha = handoff.deliveredCommitSha,
            )
            lastAction.value = "Registering the delivered commit as a QA Build…"
            runCatching {
                appContainer.buildProjectionClient.adoptFixAndBindQaBuild(
                    projectId = scope.projectId,
                    projectKey = FOUNDATION_PROJECT_KEY,
                    handoff = handoff,
                    accessToken = accessToken,
                    deliveredCommitShaOverride = null,
                )
            }.onSuccess { result ->
                setBuildProjectionSuccess(result)
            }.onFailure { failure ->
                setBuildProjectionFailure(
                    when (failure) {
                        is BuildProjectionFailure -> failure.code
                        else -> "UNEXPECTED_BUILD_PROJECTION_FAILURE"
                    },
                    handoff.deliveredCommitSha,
                )
            }
        }
    }

    private fun setBuildProjectionSuccess(result: BuildProjectionResult) {
        buildProjection.value = BuildProjectionUiState(
            phase = "registered",
            buildId = result.buildId,
            deliveredCommitSha = result.deliveredCommitSha,
            linked = result.linked,
        )
        lastAction.value =
            "QA Build ${result.buildId} (v${result.buildVersion}) registered and read back for delivered " +
                "${result.deliveredCommitSha}; " +
                "this does not verify or close the Bug."
    }

    private fun setBuildProjectionFailure(code: String, deliveredCommitSha: String? = null) {
        buildProjection.value = BuildProjectionUiState(
            phase = "failed",
            deliveredCommitSha = deliveredCommitSha,
            errorCode = code,
        )
        lastAction.value = "QA Build adoption failed: $code."
    }

    fun refreshInbox() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setInboxFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            inbox.value = InboxUiState(phase = "loading")
            lastAction.value = "Reading the durable QA Hub Inbox…"
            runCatching {
                appContainer.inboxClient.listNotifications(accessToken)
            }.onSuccess { result ->
                inbox.value = InboxUiState(
                    phase = "loaded",
                    itemCount = result.items.size,
                    unreadCount = result.unreadCount,
                    firstTitle = result.items.firstOrNull()?.title,
                )
                lastAction.value =
                    "QA Inbox read back ${result.items.size} item(s), ${result.unreadCount} unread."
            }.onFailure { failure ->
                setInboxFailure(
                    if (failure is InboxFailure) failure.code else "UNEXPECTED_INBOX_FAILURE",
                )
            }
        }
    }

    private fun setInboxFailure(code: String) {
        inbox.value = InboxUiState(phase = "failed", errorCode = code)
        lastAction.value = "QA Inbox read failed: $code."
    }

    fun refreshBugWorkbench() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setBugWorkbenchFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            bugWorkbench.value = BugWorkbenchUiState(phase = "loading")
            lastAction.value = "Reading project Bugs from the QA Hub…"
            runCatching {
                appContainer.bugWorkbenchClient.listBugs(
                    projectId = scope.projectId,
                    state = null,
                    limit = WORKBENCH_MVP_LIMIT,
                    accessToken = accessToken,
                )
            }.onSuccess { result ->
                val first = result.items.firstOrNull()
                bugWorkbench.value = BugWorkbenchUiState(
                    phase = "loaded",
                    snapshotSequence = result.snapshotSequence,
                    itemCount = result.items.size,
                    stateFilter = "all",
                    firstBugKey = first?.key,
                    firstTitle = first?.title,
                    items = result.items,
                )
                lastAction.value =
                    "QA Hub read back ${result.items.size} project Bug(s)."
            }.onFailure { failure ->
                setBugWorkbenchFailure(
                    if (failure is BugWorkbenchFailure) {
                        failure.code
                    } else {
                        "UNEXPECTED_WORKBENCH_FAILURE"
                    },
                )
            }
        }
    }

    private fun setBugWorkbenchFailure(code: String) {
        bugWorkbench.value = BugWorkbenchUiState(
            phase = "failed",
            errorCode = code,
        )
        lastAction.value = "QA Hub Bug list failed: $code."
    }

    fun openBugDetail(bugId: String) {
        bugDetail.value = BugDetailUiState(phase = "loading", bugId = bugId)
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                bugDetail.value = BugDetailUiState(
                    phase = "failed",
                    bugId = bugId,
                    errorCode = "DEBUG_ACCESS_TOKEN_MISSING",
                )
                return@launch
            }
            runCatching {
                appContainer.bugWorkbenchClient.getBugDetail(
                    bugId = bugId,
                    accessToken = accessToken,
                )
            }.onSuccess { detail ->
                if (bugDetail.value.bugId != bugId) return@onSuccess
                bugDetail.value = BugDetailUiState(
                    phase = "loaded",
                    bugId = bugId,
                    bug = detail.bug,
                    images = detail.images,
                    imageErrorCode = detail.imageErrorCode,
                )
            }.onFailure { failure ->
                if (bugDetail.value.bugId != bugId) return@onFailure
                bugDetail.value = BugDetailUiState(
                    phase = "failed",
                    bugId = bugId,
                    errorCode = (failure as? BugWorkbenchFailure)?.code
                        ?: "UNEXPECTED_BUG_DETAIL_FAILURE",
                )
            }
        }
    }

    fun closeBugDetail() {
        bugDetail.value = BugDetailUiState()
    }

    fun createManualRepairAttempt() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setManualRepairFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            manualRepair.value = ManualRepairUiState(phase = "loading")
            humanRepairBuild.value = HumanRepairBuildUiState()
            lastAction.value = "Creating a Relay-independent human RepairAttempt…"
            runCatching {
                appContainer.scopedRepository.seedFoundationScope(scope)
                val submissionId = UUID.randomUUID().toString()
                val operationId = appContainer.scopedRepository.enqueue(
                    scope = scope,
                    request = FoundationCreateBugContract.buildOperation(
                        projectId = scope.projectId,
                        submissionId = submissionId,
                        observedAt = Instant.now().toString(),
                        qaAppVersion = BuildConfig.VERSION_NAME,
                    ),
                )
                appContainer.syncEngine.run(scope)
                val receipt = appContainer.scopedRepository.findReceipt(scope, operationId)
                    ?: throw RepairAttemptFailure("BUG_COMMIT_RECEIPT_MISSING")
                val result = appContainer.repairAttemptClient
                    .createReadAndRejectMissingDeliveryEvidence(
                        bugId = receipt.bugId,
                        assigneeId = scope.actorId,
                        accessToken = accessToken,
                    )
                receipt.qaItemKey to result
            }.onSuccess { (bugKey, result) ->
                manualRepair.value = ManualRepairUiState(
                    phase = "loaded",
                    bugKey = bugKey,
                    attemptId = result.attemptId,
                    mode = result.mode,
                    status = result.status,
                    missingEvidenceRejectionCode = result.missingEvidenceRejectionCode,
                )
                lastAction.value =
                    "$bugKey human RepairAttempt ${result.attemptId} was created/read back; " +
                        "missing evidence rejected as ${result.missingEvidenceRejectionCode}."
            }.onFailure { failure ->
                setManualRepairFailure(
                    if (failure is RepairAttemptFailure) {
                        failure.code
                    } else {
                        failure.message?.takeIf(String::isNotBlank)
                            ?: "UNEXPECTED_REPAIR_ATTEMPT_FAILURE"
                    },
                )
            }
        }
    }

    private fun setManualRepairFailure(code: String) {
        manualRepair.value = ManualRepairUiState(phase = "failed", errorCode = code)
        lastAction.value = "Human RepairAttempt failed: $code."
    }

    fun deliverManualRepairAndLinkBuild() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setHumanRepairBuildFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            val attemptId = manualRepair.value.attemptId
            if (manualRepair.value.phase != "loaded" || attemptId.isNullOrBlank()) {
                setHumanRepairBuildFailure("MANUAL_REPAIR_ATTEMPT_MISSING")
                return@launch
            }
            humanRepairBuild.value = HumanRepairBuildUiState(
                phase = "loading",
                attemptId = attemptId,
            )
            lastAction.value = "Delivering the human repair and linking an exact QA Build…"
            runCatching {
                appContainer.repairAttemptClient.deliverAndLinkManualBuild(
                    projectId = scope.projectId,
                    projectKey = FOUNDATION_PROJECT_KEY,
                    attemptId = attemptId,
                    accessToken = accessToken,
                )
            }.onSuccess { result ->
                humanRepairBuild.value = HumanRepairBuildUiState(
                    phase = "linked",
                    bugId = result.bugId,
                    bugVersion = result.bugVersion,
                    attemptId = result.attemptId,
                    deliveredCommitSha = result.deliveredCommitSha,
                    buildId = result.buildId,
                    buildStatus = result.buildStatus,
                    bugState = result.bugState,
                    wrongShaRejectionCode = result.wrongShaRejectionCode,
                )
                lastAction.value =
                    "Human RepairAttempt ${result.attemptId} delivered ${result.deliveredCommitSha}; " +
                        "Build ${result.buildId} linked; Bug=${result.bugState}; " +
                        "wrong SHA=${result.wrongShaRejectionCode}."
            }.onFailure { failure ->
                setHumanRepairBuildFailure(
                    if (failure is RepairAttemptFailure) {
                        failure.code
                    } else {
                        failure.message?.takeIf(String::isNotBlank)
                            ?: "UNEXPECTED_HUMAN_BUILD_FAILURE"
                    },
                    attemptId,
                )
            }
        }
    }

    private fun setHumanRepairBuildFailure(code: String, attemptId: String? = null) {
        humanRepairBuild.value = HumanRepairBuildUiState(
            phase = "failed",
            attemptId = attemptId,
            errorCode = code,
        )
        lastAction.value = "Human delivery/Build link failed: $code."
    }

    fun verifyManualRepairAndClose() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setHumanVerificationFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            val current = humanRepairBuild.value
            val bugId = current.bugId
            val attemptId = current.attemptId
            val buildId = current.buildId
            if (
                current.phase != "linked" ||
                bugId.isNullOrBlank() ||
                current.bugVersion < 1 ||
                attemptId.isNullOrBlank() ||
                buildId.isNullOrBlank()
            ) {
                setHumanVerificationFailure("HUMAN_BUILD_LINK_MISSING")
                return@launch
            }
            humanRepairBuild.value = current.copy(
                verificationPhase = "loading",
                verificationErrorCode = null,
            )
            lastAction.value = "Running human Verification against the exact QA Build…"
            runCatching {
                appContainer.repairAttemptClient.verifyManualBuildAndClose(
                    bugId = bugId,
                    expectedBugVersion = current.bugVersion,
                    attemptId = attemptId,
                    buildId = buildId,
                    verifierId = scope.actorId,
                    accessToken = accessToken,
                )
            }.onSuccess { result ->
                humanRepairBuild.value = humanRepairBuild.value.copy(
                    verificationPhase = "closed",
                    verificationId = result.verificationId,
                    verificationStatus = result.verificationStatus,
                    closedBugState = result.bugState,
                    closedBugVersion = result.bugVersion,
                    missingResultRejectionCode = result.missingResultRejectionCode,
                )
                lastAction.value =
                    "Human Verification ${result.verificationId}=${result.verificationStatus}; " +
                        "Bug ${result.bugId}=${result.bugState}; missing result=" +
                        "${result.missingResultRejectionCode}."
            }.onFailure { failure ->
                setHumanVerificationFailure(
                    if (failure is RepairAttemptFailure) {
                        failure.code
                    } else {
                        failure.message?.takeIf(String::isNotBlank)
                            ?: "UNEXPECTED_HUMAN_VERIFICATION_FAILURE"
                    },
                )
            }
        }
    }

    private fun setHumanVerificationFailure(code: String) {
        humanRepairBuild.value = humanRepairBuild.value.copy(
            verificationPhase = "failed",
            verificationErrorCode = code,
        )
        lastAction.value = "Human Verification failed: $code."
    }

    fun refreshLatestHumanWorkflow() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setHumanWorkflowFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            humanWorkflow.value = HumanWorkflowUiState(phase = "loading")
            lastAction.value = "Reading the persisted human QA workflow after restart…"
            runCatching {
                val missingCode = try {
                    appContainer.humanWorkflowClient.readLatest(
                        projectId = MISSING_WORKFLOW_PROJECT_ID,
                        accessToken = accessToken,
                    )
                    throw HumanWorkflowFailure("MISSING_WORKFLOW_UNEXPECTEDLY_FOUND")
                } catch (failure: HumanWorkflowFailure) {
                    if (failure.httpStatus != 404) throw failure
                    failure.code
                }
                appContainer.humanWorkflowClient.readLatest(
                    projectId = scope.projectId,
                    accessToken = accessToken,
                ) to missingCode
            }.onSuccess { (workflow, missingCode) ->
                humanWorkflow.value = HumanWorkflowUiState(
                    phase = "loaded",
                    bugKey = workflow.bugKey,
                    bugState = workflow.bugState,
                    bugVersion = workflow.bugVersion,
                    repairAttemptId = workflow.repairAttemptId,
                    repairAttemptStatus = workflow.repairAttemptStatus,
                    buildId = workflow.buildId,
                    buildStatus = workflow.buildStatus,
                    verificationId = workflow.verificationId,
                    verificationStatus = workflow.verificationStatus,
                    verificationVersion = workflow.verificationVersion,
                    resultSummary = workflow.resultSummary,
                    missingWorkflowRejectionCode = missingCode,
                )
                lastAction.value =
                    "${workflow.bugKey} restart readback: Attempt=${workflow.repairAttemptStatus}, " +
                        "Build=${workflow.buildStatus}, Verification=${workflow.verificationStatus}, " +
                        "Bug=${workflow.bugState}; missing workflow=$missingCode."
            }.onFailure { failure ->
                setHumanWorkflowFailure(
                    if (failure is HumanWorkflowFailure) {
                        failure.code
                    } else {
                        failure.message?.takeIf(String::isNotBlank)
                            ?: "UNEXPECTED_HUMAN_WORKFLOW_FAILURE"
                    },
                )
            }
        }
    }

    private fun setHumanWorkflowFailure(code: String) {
        humanWorkflow.value = HumanWorkflowUiState(phase = "failed", errorCode = code)
        lastAction.value = "Human workflow readback failed: $code."
    }

    fun createCommentAndReadAudit() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setCommentAuditFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            commentAudit.value = CommentAuditUiState(phase = "loading")
            lastAction.value = "Appending a Comment and reading the immutable Bug timeline…"
            runCatching {
                val missingCode = try {
                    appContainer.commentTimelineClient.readTimeline(
                        bugId = MISSING_COMMENT_BUG_ID,
                        limit = 1,
                        accessToken = accessToken,
                    )
                    throw CommentTimelineFailure("MISSING_BUG_UNEXPECTEDLY_FOUND")
                } catch (failure: CommentTimelineFailure) {
                    if (failure.httpStatus != 404) throw failure
                    failure.code
                }
                val workflow = appContainer.humanWorkflowClient.readLatest(
                    projectId = scope.projectId,
                    accessToken = accessToken,
                )
                val submissionId = UUID.randomUUID().toString()
                val body = "MuMu native Comment audit ${Instant.now()}"
                val comment = appContainer.commentTimelineClient.createComment(
                    bugId = workflow.bugId,
                    clientSubmissionId = submissionId,
                    body = body,
                    accessToken = accessToken,
                )
                val timeline = appContainer.commentTimelineClient.readTimeline(
                    bugId = workflow.bugId,
                    limit = COMMENT_AUDIT_MVP_LIMIT,
                    accessToken = accessToken,
                )
                val event = timeline.items.firstOrNull {
                    it.type == "comment.created" && it.commentId == comment.id
                } ?: throw CommentTimelineFailure("COMMENT_AUDIT_EVENT_MISSING")
                CommentAuditResult(
                    bugKey = workflow.bugKey,
                    commentId = comment.id,
                    commentBody = comment.body,
                    eventId = event.id,
                    eventType = event.type,
                    eventCount = timeline.items.size,
                    missingBugCode = missingCode,
                )
            }.onSuccess { result ->
                commentAudit.value = CommentAuditUiState(
                    phase = "loaded",
                    bugKey = result.bugKey,
                    commentId = result.commentId,
                    commentBody = result.commentBody,
                    eventId = result.eventId,
                    eventType = result.eventType,
                    eventCount = result.eventCount,
                    missingBugRejectionCode = result.missingBugCode,
                )
                lastAction.value =
                    "${result.bugKey} Comment ${result.commentId} persisted; " +
                        "audit=${result.eventType}; missing Bug=${result.missingBugCode}."
            }.onFailure { failure ->
                setCommentAuditFailure(
                    when (failure) {
                        is CommentTimelineFailure -> failure.code
                        is HumanWorkflowFailure -> failure.code
                        else -> failure.message?.takeIf(String::isNotBlank)
                            ?: "UNEXPECTED_COMMENT_AUDIT_FAILURE"
                    },
                )
            }
        }
    }

    private fun setCommentAuditFailure(code: String) {
        commentAudit.value = CommentAuditUiState(phase = "failed", errorCode = code)
        lastAction.value = "Comment/audit failed: $code."
    }

    fun createBugAndCheckDuplicates() {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                setDuplicateFailure("DEBUG_ACCESS_TOKEN_MISSING")
                return@launch
            }
            duplicateCandidates.value = DuplicateCandidateUiState(phase = "loading")
            lastAction.value = "Creating a QA Bug and checking duplicate candidates…"
            runCatching {
                appContainer.scopedRepository.seedFoundationScope(scope)
                val submissionId = UUID.randomUUID().toString()
                val operationId = appContainer.scopedRepository.enqueue(
                    scope = scope,
                    request = FoundationCreateBugContract.buildOperation(
                        projectId = scope.projectId,
                        submissionId = submissionId,
                        observedAt = Instant.now().toString(),
                        qaAppVersion = BuildConfig.VERSION_NAME,
                    ),
                )
                appContainer.syncEngine.run(scope)
                val receipt = appContainer.scopedRepository.findReceipt(scope, operationId)
                    ?: throw DuplicateCandidateFailure("BUG_COMMIT_RECEIPT_MISSING")
                appContainer.duplicateCandidateClient.listCandidates(
                    bugId = receipt.bugId,
                    accessToken = accessToken,
                )
            }.onSuccess { result ->
                val first = result.candidates.firstOrNull()
                duplicateCandidates.value = DuplicateCandidateUiState(
                    phase = "loaded",
                    sourceBugId = result.sourceBugId,
                    count = result.candidates.size,
                    firstBugKey = first?.bugKey,
                    firstScore = first?.score,
                    firstReason = first?.reasons?.firstOrNull(),
                )
                lastAction.value =
                    "Duplicate check returned ${result.candidates.size} candidate(s) for " +
                        result.sourceBugId + "."
            }.onFailure { failure ->
                setDuplicateFailure(
                    if (failure is DuplicateCandidateFailure) {
                        failure.code
                    } else {
                        "UNEXPECTED_DUPLICATE_FAILURE"
                    },
                )
            }
        }
    }

    private fun setDuplicateFailure(code: String) {
        duplicateCandidates.value = DuplicateCandidateUiState(
            phase = "failed",
            errorCode = code,
        )
        lastAction.value = "Duplicate check failed: $code."
    }

    fun submitCapturedPng(
        captureId: String,
        capturedAtEpochMs: Long,
        pngBytes: ByteArray,
        pocoSummary: CapturePocoSummary,
        pocoArtifacts: List<CapturedPocoArtifact>,
    ) {
        val immutableBytes = pngBytes.copyOf()
        submitPngAttachment(
            pngBytes = immutableBytes,
            filename = "capture-$captureId.png",
            captureId = captureId,
            capturedAtEpochMs = capturedAtEpochMs,
            actionLabel = "Capture",
            pocoSummary = pocoSummary,
            pocoArtifacts = pocoArtifacts.map(CapturedPocoArtifact::immutableCopy),
        )
    }

    /** One field-client submit action durably stages fields, media, and assignments atomically. */
    fun submitNewBug(
        annotatedPng: ByteArray?,
        content: String,
        fixerId: String,
        verifierId: String,
    ) {
        val cleanContent = content.trim()
        if (cleanContent.isBlank()) {
            lastAction.value = "请填写 Bug 内容。"
            return
        }
        if (verifierId.isBlank()) {
            lastAction.value = "请选择验收人。"
            return
        }
        viewModelScope.launch {
            val draftState = captureDraft.value
            val draft = runCatching { appContainer.pendingCaptureDraftStore.latest() }
                .getOrNull()
                ?.takeIf { it.captureId == draftState.captureId }
            val originalPng = draft?.let {
                runCatching { appContainer.pendingCaptureDraftStore.readPrimary(it) }.getOrNull()
            }
            val submissionId = draft?.clientSubmissionId ?: UUID.randomUUID().toString()
            val originalAttachmentId = draft?.clientAttachmentId ?: UUID.randomUUID().toString()
            queueDurableBugDraft(
                originalPng = originalPng,
                annotatedPng = annotatedPng,
                originalFilename = draft?.let { "capture-${it.captureId}.png" } ?: "bug.png",
                actionLabel = "Bug",
                submissionId = submissionId,
                originalAttachmentId = originalAttachmentId,
                captureId = draft?.captureId,
                capturedAtEpochMs = draft?.requestedAtEpochMs,
                observedAt = draft?.observedAt ?: Instant.now().toString(),
                qaAppVersion = draft?.qaAppVersion ?: BuildConfig.VERSION_NAME,
                title = internalBugSummary(cleanContent),
                description = cleanContent,
                expectedBehavior = "按测试步骤可稳定复现并符合项目预期行为。",
                ownerId = fixerId.takeIf(String::isNotBlank),
                verificationOwnerId = verifierId,
                navigateAfterQueue = true,
            )
        }
    }

    fun reportCaptureUnavailable(reason: String) {
        captureSessionStatus.value = CaptureSessionUiStatus.UNAVAILABLE
        lastAction.value = "Capture unavailable: $reason. Ordinary defect entry remains available."
    }

    fun reportOverlayPermissionState(granted: Boolean) {
        val changed = overlayPermissionGranted.value != granted
        overlayPermissionGranted.value = granted
        if (granted && changed) {
            lastAction.value =
                "Floating-window permission granted. Screen capture remains off until explicitly authorized."
        }
    }

    fun reportCaptureSessionState(active: Boolean) {
        captureSessionStatus.value = if (active) {
            CaptureSessionUiStatus.ACTIVE
        } else {
            CaptureSessionUiStatus.STOPPED
        }
        lastAction.value = if (active) {
            "Capture session active. Use the visible QA ball or Capture now; Stop is always available."
        } else {
            "Capture session stopped. Ordinary defect entry remains available."
        }
    }

    fun reportCaptureSessionStarting() {
        captureSessionStatus.value = CaptureSessionUiStatus.STARTING
        lastAction.value = "Starting the explicitly authorized capture session…"
    }

    fun reportPendingCaptureSaved(captureId: String, width: Int, height: Int) {
        viewModelScope.launch {
            refreshPendingCaptureState()
            lastAction.value =
                "Pending capture $captureId saved locally (${width}x$height); add details before submit."
        }
    }

    fun refreshPendingCapture() {
        viewModelScope.launch { refreshPendingCaptureState() }
    }

    fun submitLatestPendingCapture() {
        val current = pendingCapture.value
        if (!current.available || current.deliveryState != "SAVED") return
        pendingCapture.value = current.copy(deliveryState = "QUEUEING")
        viewModelScope.launch {
            val draft = runCatching { appContainer.pendingCaptureDraftStore.latest() }
                .getOrNull()
            if (draft == null) {
                pendingCapture.value = PendingCaptureUiState()
                lastAction.value = "No durable pending capture is available to submit."
                return@launch
            }
            val png = runCatching { appContainer.pendingCaptureDraftStore.readPrimary(draft) }
                .getOrElse {
                    pendingCapture.value = current
                    lastAction.value = "Pending capture failed: PENDING_CAPTURE_READ_FAILED."
                    return@launch
                }
            queueOfflinePngDraft(
                pngBytes = png,
                filename = "capture-${draft.captureId}.png",
                actionLabel = "Pending capture",
                submissionId = draft.clientSubmissionId,
                clientAttachmentId = draft.clientAttachmentId,
                captureId = draft.captureId,
                capturedAtEpochMs = draft.requestedAtEpochMs,
                observedAt = draft.observedAt,
                qaAppVersion = draft.qaAppVersion,
                onCompleted = ::refreshPendingCapture,
            )
        }
    }

    private suspend fun refreshPendingCaptureState() {
        val draft = runCatching { appContainer.pendingCaptureDraftStore.latest() }.getOrNull()
        if (draft == null) {
            pendingCapture.value = PendingCaptureUiState()
            return
        }
        val idempotencyKey = "submission:${draft.clientSubmissionId}:commit"
        val operation = appContainer.scopedRepository.findOperationByIdempotencyKey(
            scope = scope,
            idempotencyKey = idempotencyKey,
        )
        if (
            operation?.state == QueueState.SUCCEEDED &&
            appContainer.scopedRepository.findReceipt(scope, operation.operationId) != null
        ) {
            runCatching { appContainer.pendingCaptureDraftStore.delete(draft) }
            pendingCapture.value = PendingCaptureUiState()
            return
        }
        pendingCapture.value = draft.toUiState(operation?.state?.name ?: "SAVED")
    }

    private fun submitPngAttachment(
        pngBytes: ByteArray,
        annotatedPngBytes: ByteArray? = null,
        filename: String,
        captureId: String?,
        capturedAtEpochMs: Long?,
        actionLabel: String,
        pocoSummary: CapturePocoSummary?,
        pocoArtifacts: List<CapturedPocoArtifact>,
        submissionIdOverride: String? = null,
        clientAttachmentIdOverride: String? = null,
        title: String = "Native QA Hub contract-validation draft",
        description: String =
            "The Android foundation queued a representative Bug command for offline sync.",
        expectedBehavior: String =
            "A valid App-first Bug command remains isolated to its authenticated project.",
    ) {
        viewModelScope.launch {
            val accessToken = BuildConfig.QA_HUB_DEBUG_ACCESS_TOKEN.trim()
            if (!BuildConfig.DEBUG || accessToken.isEmpty()) {
                lastAction.value =
                    "$actionLabel unavailable: configure qaHubDebugAccessToken for a debug build."
                return@launch
            }

            lastAction.value = "Uploading $actionLabel PNG, then committing it through the Room queue…"
            var effectivePocoSummary = pocoSummary
            val result = runCatching {
                appContainer.scopedRepository.seedFoundationScope(scope)
                val submissionId = submissionIdOverride ?: UUID.randomUUID().toString()
                val clientAttachmentId = clientAttachmentIdOverride ?: UUID.randomUUID().toString()
                val uploadReceipt = appContainer.attachmentUploadClient.uploadAndReserveBugCreate(
                    scope = scope,
                    clientSubmissionId = submissionId,
                    clientAttachmentId = clientAttachmentId,
                    filename = filename,
                    pngBytes = pngBytes,
                    accessToken = accessToken,
                    captureId = captureId,
                )
                appContainer.scopedRepository.recordAttachmentReservation(scope, uploadReceipt)
                val annotatedReceipt = annotatedPngBytes?.let { markedBytes ->
                    val markedAttachmentId = UUID.nameUUIDFromBytes(
                        "$submissionId:annotated".toByteArray(Charsets.UTF_8),
                    ).toString()
                    appContainer.attachmentUploadClient.uploadAndReserveBugCreate(
                        scope = scope,
                        clientSubmissionId = submissionId,
                        clientAttachmentId = markedAttachmentId,
                        filename = filename.substringBeforeLast('.', filename) + "-annotated.png",
                        pngBytes = markedBytes,
                        accessToken = accessToken,
                        captureId = captureId,
                    ).also { receipt ->
                        appContainer.scopedRepository.recordAttachmentReservation(scope, receipt)
                    }
                }

                var captureBundleId: String? = null
                var captureEvidenceSummary = ""
                if (
                    captureId != null &&
                    capturedAtEpochMs != null &&
                    pocoSummary != null
                ) {
                    val uploadedArtifacts = pocoArtifacts.mapNotNull { artifact ->
                        runCatching {
                            val receipt =
                                appContainer.attachmentUploadClient.uploadCaptureArtifact(
                                    scope = scope,
                                    clientSubmissionId = submissionId,
                                    clientAttachmentId = UUID.randomUUID().toString(),
                                    filename = artifact.captureFilename(captureId),
                                    mediaType = artifact.mediaType,
                                    contentBytes = artifact.bytes,
                                    accessToken = accessToken,
                                    captureId = captureId,
                                )
                            UploadedCaptureArtifact(artifact, receipt)
                        }.getOrNull()
                    }
                    val durableSummary = pocoSummary.withPersistedArtifacts(
                        persistedKinds = uploadedArtifacts.map { it.source.kind.wireName }.toSet(),
                    )
                    effectivePocoSummary = durableSummary
                    val captureReceipt = runCatching {
                        appContainer.attachmentUploadClient.createCaptureBundleAndReadBack(
                            scope = scope,
                            clientSubmissionId = submissionId,
                            captureId = captureId,
                            capturedAtEpochMs = capturedAtEpochMs,
                            primaryAttachment = uploadReceipt,
                            artifacts = uploadedArtifacts.map { uploaded ->
                                CaptureBundleArtifactUpload(
                                    kind = uploaded.source.kind.wireName,
                                    attachment = uploaded.receipt,
                                    startedAtEpochMs = uploaded.source.startedAtEpochMs,
                                    endedAtEpochMs = uploaded.source.endedAtEpochMs,
                                    truncated = uploaded.source.truncated,
                                )
                            },
                            poco = durableSummary.toCaptureBundlePocoInput(),
                            device = CaptureBundleDeviceInput(
                                manufacturer = Build.MANUFACTURER,
                                model = Build.MODEL,
                                androidApi = Build.VERSION.SDK_INT,
                                androidRelease = Build.VERSION.RELEASE,
                                qaAppVersion = BuildConfig.VERSION_NAME,
                            ),
                            accessToken = accessToken,
                        )
                    }.getOrNull()
                    if (captureReceipt != null) {
                        captureBundleId = captureReceipt.captureId
                        effectivePocoSummary = durableSummary.copy(
                            status = captureReceipt.enrichmentStatus.toPocoEnrichmentStatus(),
                        )
                        captureEvidenceSummary =
                            "; capture bundle ${captureReceipt.captureId} read back with " +
                                "${captureReceipt.artifactAttachmentIds.size} Poco artifact(s)"
                    } else {
                        effectivePocoSummary = durableSummary.copy(
                            status = durableSummary.status.downgradedAfterBundleFailure(),
                            failureCode = durableSummary.failureCode
                                ?: "CAPTURE_BUNDLE_PERSIST_FAILED",
                        )
                        captureEvidenceSummary =
                            "; capture bundle persistence failed, ordinary Bug continued"
                    }
                }

                val operationId = appContainer.scopedRepository.enqueue(
                    scope = scope,
                    request = FoundationCreateBugContract.buildOperation(
                        projectId = scope.projectId,
                        submissionId = submissionId,
                        observedAt = Instant.now().toString(),
                        qaAppVersion = BuildConfig.VERSION_NAME,
                        attachmentIds = listOfNotNull(
                            uploadReceipt.attachmentId,
                            annotatedReceipt?.attachmentId,
                        ),
                        captureBundleId = captureBundleId,
                        title = title,
                        description = description,
                        expectedBehavior = expectedBehavior,
                    ),
                )
                val syncResult = appContainer.syncEngine.run(scope)
                val receipt = appContainer.scopedRepository.findReceipt(scope, operationId)
                if (receipt != null) {
                    val claimed = listOfNotNull(uploadReceipt, annotatedReceipt).map { uploaded ->
                        appContainer.scopedRepository.recordAttachmentClaimed(
                            scope = scope,
                            clientSubmissionId = submissionId,
                            clientAttachmentId = uploaded.clientAttachmentId,
                            qaItemId = receipt.qaItemId,
                            qaItemKey = receipt.qaItemKey,
                            responseJson = receipt.responseJson,
                        )
                    }
                    if (captureId == captureDraft.value.captureId) clearCaptureDraft()
                    "$actionLabel created ${receipt.qaItemKey}; ${claimed.size} attachment(s) " +
                        "are ${claimed.joinToString { it.bindingStatus }}" +
                        captureEvidenceSummary + "."
                } else {
                    "Attachment ${uploadReceipt.attachmentId} is reserved; Bug commit " +
                        "${syncResult.liveSmokeSummary()}."
                }
            }
            val actionResult = result.getOrElse { failure ->
                val code = when (failure) {
                    is LiveSmokeFailure -> failure.code
                    is AttachmentUploadFailure -> failure.code
                    else -> "UNEXPECTED_LOCAL_FAILURE"
                }
                "$actionLabel failed: $code."
            }
            lastAction.value = actionResult + effectivePocoSummary.pocoDisplaySuffix()
        }
    }

    companion object {
        const val FOUNDATION_PROJECT_KEY = "LOCAL"
        private const val WORKBENCH_MVP_LIMIT = 100
        private const val COMMENT_AUDIT_MVP_LIMIT = 20
        private const val MISSING_WORKFLOW_PROJECT_ID =
            "10000000-0000-4000-8000-000000000099"
        private const val MISSING_COMMENT_BUG_ID =
            "20000000-0000-4000-8000-000000000099"
        internal fun foundationScope(actorId: String) = AccountProjectScope(
            accountId = "10000000-0000-4000-8000-000000000020",
            projectId = "10000000-0000-4000-8000-000000000004",
            actorId = actorId,
            installationId = "10000000-0000-4000-8000-000000000001",
            sessionId = "10000000-0000-4000-8000-000000000002",
        )
    }
}

/** The API contract still requires title; the field UI intentionally exposes only content. */
internal fun internalBugSummary(content: String): String {
    val normalized = content.trim().replace(Regex("\\s+"), " ")
    require(normalized.isNotBlank()) { "Bug content must not be blank" }
    return normalized.take(80)
}

private fun CapturePocoSummary?.pocoDisplaySuffix(): String = when (this?.status) {
    null -> ""
    PocoEnrichmentStatus.COMPLETE ->
        " Unity context: complete / 已获取 Unity 上下文" + pocoEndpointSuffix() + "."
    PocoEnrichmentStatus.PARTIAL ->
        " Unity context: partial / 部分" + pocoEndpointSuffix() + "."
    PocoEnrichmentStatus.UNAVAILABLE -> " Unity context: unavailable / 未连接."
}

private fun PendingCaptureDraft.toUiState(deliveryState: String): PendingCaptureUiState =
    PendingCaptureUiState(
        available = true,
        captureId = captureId,
        width = width,
        height = height,
        enrichmentStatus = poco.status.name,
        deliveryState = deliveryState,
    )

private fun CapturePocoSummary.pocoEndpointSuffix(): String = buildString {
    sdkVersion?.let { append(" (SDK ").append(it) }
    port?.let {
        if (sdkVersion == null) append(" (") else append(", ")
        append("127.0.0.1:").append(it)
    }
    if (sdkVersion != null || port != null) append(")")
}

private data class UploadedCaptureArtifact(
    val source: CapturedPocoArtifact,
    val receipt: CaptureAttachmentReceipt,
)

private fun CapturedPocoArtifact.immutableCopy(): CapturedPocoArtifact = copy(bytes = bytes.copyOf())

internal fun CapturedPocoArtifact.captureFilename(captureId: String): String {
    val extension = when (mediaType) {
        "image/png" -> "png"
        "image/jpeg" -> "jpg"
        "image/webp" -> "webp"
        "application/json" -> "json"
        else -> throw LiveSmokeFailure("POCO_ARTIFACT_MEDIA_TYPE_UNSUPPORTED")
    }
    return "capture-$captureId-${kind.wireName}.$extension"
}

internal fun CapturePocoSummary.withPersistedArtifacts(
    persistedKinds: Set<String>,
): CapturePocoSummary {
    val durableMethods = succeededMethods.filter { method ->
        val requiredKind = POCO_METHOD_ARTIFACT_KIND[method]
        requiredKind == null || requiredKind in persistedKinds
    }.distinct()
    val artifactWasLost = durableMethods.size != succeededMethods.distinct().size
    val handshakeSucceeded = "GetSDKVersion" in durableMethods
    val durableStatus = when {
        status == PocoEnrichmentStatus.UNAVAILABLE || !handshakeSucceeded ->
            PocoEnrichmentStatus.UNAVAILABLE
        status == PocoEnrichmentStatus.COMPLETE && !artifactWasLost ->
            PocoEnrichmentStatus.COMPLETE
        else -> PocoEnrichmentStatus.PARTIAL
    }
    return copy(
        status = durableStatus,
        port = port.takeIf { handshakeSucceeded },
        sdkVersion = sdkVersion.takeIf { handshakeSucceeded },
        succeededMethods = durableMethods,
        screenWidth = screenWidth.takeIf { "GetScreenSize" in durableMethods },
        screenHeight = screenHeight.takeIf { "GetScreenSize" in durableMethods },
        failureCode = when {
            artifactWasLost -> "POCO_ARTIFACT_UPLOAD_FAILED"
            durableStatus == PocoEnrichmentStatus.COMPLETE -> null
            else -> failureCode ?: "POCO_PARTIAL"
        },
    )
}

internal fun CapturePocoSummary.toCaptureBundlePocoInput(): CaptureBundlePocoInput {
    val succeeded = succeededMethods.filter(ALLOWED_POCO_METHODS::contains).distinct()
    val connected = port != null && sdkVersion != null && "GetSDKVersion" in succeeded
    val negotiated = if (connected) {
        (attemptedMethods + succeeded).filter(ALLOWED_POCO_METHODS::contains).distinct()
    } else {
        emptyList()
    }
    val hasFailedNegotiatedMethod = negotiated.any { it !in succeeded }
    return CaptureBundlePocoInput(
        attempted = true,
        connectedPort = port.takeIf { connected },
        sdkVersion = sdkVersion?.toString().takeIf { connected },
        screenWidth = screenWidth.takeIf { "GetScreenSize" in succeeded },
        screenHeight = screenHeight.takeIf { "GetScreenSize" in succeeded },
        negotiatedMethods = negotiated,
        succeededMethods = succeeded,
        failureReason = when {
            !connected -> failureCode.toCaptureFailureReason(default = "not_running")
            hasFailedNegotiatedMethod -> failureCode.toCaptureFailureReason(default = "unknown")
            else -> null
        },
    )
}

private fun String?.toCaptureFailureReason(default: String): String {
    val normalized = this?.uppercase().orEmpty()
    return when {
        "NOT_RUNNING" in normalized || "UNAVAILABLE" in normalized -> "not_running"
        "CONNECTION" in normalized || "REFUSED" in normalized -> "connection_refused"
        "TIMEOUT" in normalized || "DEADLINE" in normalized -> "timeout"
        "CANCEL" in normalized -> "cancelled"
        "INVALID_FRAME" in normalized || "JSONRPC" in normalized -> "invalid_frame"
        "OVERSIZED" in normalized || "TOO_LARGE" in normalized -> "oversized_response"
        "UNSUPPORTED" in normalized || "SDK_VERSION" in normalized -> "unsupported_version"
        "UNITY_STOPPED" in normalized -> "unity_stopped"
        normalized.isBlank() -> default
        else -> "unknown"
    }
}

private fun String.toPocoEnrichmentStatus(): PocoEnrichmentStatus = when (this) {
    "complete" -> PocoEnrichmentStatus.COMPLETE
    "partial" -> PocoEnrichmentStatus.PARTIAL
    "unavailable" -> PocoEnrichmentStatus.UNAVAILABLE
    else -> throw LiveSmokeFailure("CAPTURE_STATUS_INVALID")
}

private fun PocoEnrichmentStatus.downgradedAfterBundleFailure(): PocoEnrichmentStatus = when (this) {
    PocoEnrichmentStatus.COMPLETE -> PocoEnrichmentStatus.PARTIAL
    PocoEnrichmentStatus.PARTIAL -> PocoEnrichmentStatus.PARTIAL
    PocoEnrichmentStatus.UNAVAILABLE -> PocoEnrichmentStatus.UNAVAILABLE
}

private class LiveSmokeFailure(val code: String) : RuntimeException()

private fun SyncRunResult.liveSmokeSummary(): String = when (this) {
    is SyncRunResult.Completed -> "completed without a matching receipt"
    is SyncRunResult.ContinueAt -> "queued for retry"
    is SyncRunResult.BlockedOnAuthentication -> "authentication rejected"
    is SyncRunResult.BlockedOnDeviceSecurity -> "device credential storage unavailable"
    is SyncRunResult.Exhausted -> "retry limit exhausted"
}

private const val LIVE_SMOKE_FILENAME = "android-live-smoke.png"
private val ALLOWED_POCO_METHODS = setOf(
    "GetSDKVersion",
    "Screenshot",
    "Dump",
    "GetScreenSize",
    "GetDebugProfilingData",
    "qa.snapshot",
)
private val POCO_METHOD_ARTIFACT_KIND = mapOf(
    "Screenshot" to "poco_screenshot",
    "Dump" to "poco_hierarchy",
    "GetDebugProfilingData" to "poco_profiling",
    "qa.snapshot" to "poco_snapshot",
)

private fun createLiveSmokePng(): ByteArray {
    val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
    return try {
        bitmap.eraseColor(Color.rgb(42, 91, 215))
        ByteArrayOutputStream().use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
            output.toByteArray()
        }
    } finally {
        bitmap.recycle()
    }
}

internal data class FoundationFakeCreateBugRequest(
    val operationKind: String,
    val httpMethod: String,
    val relativePath: String,
    val payload: Map<String, Any?>,
    val idempotencyKey: String,
)

/**
 * Pure Kotlin guard for the foundation demonstrator's `/bugs` submission.
 *
 * The DTO and nested maps are validated before the Android-only JSONObject serialization step,
 * so JVM tests can exercise the same path, payload, scope, and idempotency rules. The server is
 * still authoritative and must repeat full schema and authorization validation.
 */
internal object FoundationCreateBugContract {
    private const val OPERATION_KIND = "CREATE_BUG"
    private const val HTTP_METHOD = "POST"
    private const val RELATIVE_PATH = "/bugs"

    private val uuidPattern = Regex(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )
    private val qaAppVersionPattern = Regex(
        "^[0-9]+(?:\\.[0-9]+){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?" +
            "(?:\\+[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$",
    )
    private val requiredTopLevelKeys = setOf(
        "submissionContractVersion",
        "projectId",
        "clientSubmissionId",
        "title",
        "description",
        "expectedBehavior",
        "severity",
        "priority",
        "occurrence",
    )
    private val allowedTopLevelKeys = requiredTopLevelKeys + setOf(
        "moduleId",
        "attachmentIds",
        "captureBundleId",
        "ownerId",
        "verificationOwnerId",
    )
    private val requiredOccurrenceKeys = setOf(
        "observedAt",
        "platform",
        "steps",
        "actualBehavior",
    )
    private val allowedOccurrenceKeys = requiredOccurrenceKeys + setOf(
        "appVersion",
        "resourceVersion",
        "gitSha",
        "deviceModel",
        "osVersion",
        "frequency",
        "errorSignature",
        "environment",
    )
    private val allowedEnvironmentKeys = setOf(
        "qaAppVersion",
        "testSessionId",
        "buildId",
        "networkType",
        "networkMetered",
        "orientation",
    )

    fun buildRequest(
        projectId: String,
        submissionId: String,
        observedAt: String,
        qaAppVersion: String,
        attachmentIds: List<String> = emptyList(),
        captureBundleId: String? = null,
        title: String = "Native QA Hub contract-validation draft",
        description: String =
            "The Android foundation queued a representative Bug command for offline sync.",
        expectedBehavior: String =
            "A valid App-first Bug command remains isolated to its authenticated project.",
        ownerId: String? = null,
        verificationOwnerId: String? = null,
    ): FoundationFakeCreateBugRequest {
        val occurrence = linkedMapOf<String, Any?>(
            "observedAt" to observedAt,
            "platform" to "android",
            "appVersion" to qaAppVersion,
            "steps" to listOf(
                "Open the native QA Hub foundation screen.",
                "Tap Queue local draft.",
            ),
            "actualBehavior" to
                "The native client queued this contract-validation example for submission.",
            "environment" to linkedMapOf(
                "qaAppVersion" to qaAppVersion,
                "networkType" to "unknown",
                "orientation" to "unknown",
            ),
        )
        val payload = linkedMapOf<String, Any?>(
            "submissionContractVersion" to QaHubApiContract.VERSION,
            "projectId" to projectId,
            "clientSubmissionId" to submissionId,
            "title" to title,
            "description" to description,
            "expectedBehavior" to expectedBehavior,
            "severity" to "S3",
            "priority" to "P3",
            "occurrence" to occurrence,
            "attachmentIds" to attachmentIds,
        )
        captureBundleId?.let { payload["captureBundleId"] = it }
        ownerId?.let { payload["ownerId"] = it }
        verificationOwnerId?.let { payload["verificationOwnerId"] = it }
        return FoundationFakeCreateBugRequest(
            operationKind = OPERATION_KIND,
            httpMethod = HTTP_METHOD,
            relativePath = RELATIVE_PATH,
            payload = payload,
            idempotencyKey = "submission:$submissionId:commit",
        ).also { requireValid(it, expectedProjectId = projectId) }
    }

    fun buildOperation(
        projectId: String,
        submissionId: String,
        observedAt: String,
        qaAppVersion: String,
        attachmentIds: List<String> = emptyList(),
        captureBundleId: String? = null,
        title: String = "Native QA Hub contract-validation draft",
        description: String =
            "The Android foundation queued a representative Bug command for offline sync.",
        expectedBehavior: String =
            "A valid App-first Bug command remains isolated to its authenticated project.",
        ownerId: String? = null,
        verificationOwnerId: String? = null,
    ): NewOfflineOperation {
        val request = buildRequest(
            projectId = projectId,
            submissionId = submissionId,
            observedAt = observedAt,
            qaAppVersion = qaAppVersion,
            attachmentIds = attachmentIds,
            captureBundleId = captureBundleId,
            title = title,
            description = description,
            expectedBehavior = expectedBehavior,
            ownerId = ownerId,
            verificationOwnerId = verificationOwnerId,
        )
        requireValid(request, expectedProjectId = projectId)
        return NewOfflineOperation(
            operationKind = request.operationKind,
            httpMethod = request.httpMethod,
            relativePath = request.relativePath,
            payloadJson = JSONObject(request.payload).toString(),
            idempotencyKey = request.idempotencyKey,
        )
    }

    fun requireValid(
        request: FoundationFakeCreateBugRequest,
        expectedProjectId: String,
    ) {
        require(request.operationKind == OPERATION_KIND) {
            "Foundation fake supports only the frozen createBug operation"
        }
        require(request.httpMethod == HTTP_METHOD) { "createBug must use POST" }
        require(request.relativePath == RELATIVE_PATH) {
            "createBug must use the exact /bugs path"
        }
        requireExactKeys(request.payload, requiredTopLevelKeys, allowedTopLevelKeys, "createBug")
        require(
            requireString(request.payload, "submissionContractVersion", 1, 20) ==
                QaHubApiContract.VERSION,
        ) { "submissionContractVersion must match the frozen App-first contract" }

        requireUuid(expectedProjectId, "expectedProjectId")
        val projectId = requireUuid(
            requireString(request.payload, "projectId", 1, 100),
            "projectId",
        )
        require(projectId == expectedProjectId) {
            "createBug projectId must match the queued project scope"
        }
        val submissionId = requireUuid(
            requireString(request.payload, "clientSubmissionId", 1, 100),
            "clientSubmissionId",
        )
        require(request.idempotencyKey == "submission:$submissionId:commit") {
            "createBug Idempotency-Key must derive from clientSubmissionId"
        }

        requireString(request.payload, "title", 1, 300)
        requireString(request.payload, "description", 1, 20_000)
        requireString(request.payload, "expectedBehavior", 1, 10_000)
        require(
            requireString(request.payload, "severity", 2, 2) in
                setOf("S0", "S1", "S2", "S3", "S4"),
        ) { "severity is not allowed" }
        require(
            requireString(request.payload, "priority", 2, 2) in
                setOf("P0", "P1", "P2", "P3", "P4"),
        ) { "priority is not allowed" }
        validateOptionalUuid(request.payload, "moduleId", nullable = true)
        validateOptionalUuid(request.payload, "captureBundleId", nullable = false)
        validateOptionalUuid(request.payload, "ownerId", nullable = false)
        validateOptionalUuid(request.payload, "verificationOwnerId", nullable = false)
        validateUuidList(request.payload, "attachmentIds", maxItems = 20)
        validateOccurrence(requireMap(request.payload["occurrence"], "occurrence"))
    }

    private fun validateOccurrence(occurrence: Map<String, Any?>) {
        requireExactKeys(
            occurrence,
            requiredOccurrenceKeys,
            allowedOccurrenceKeys,
            "occurrence",
        )
        val observedAt = requireString(occurrence, "observedAt", 1, 100)
        require(runCatching { OffsetDateTime.parse(observedAt) }.isSuccess) {
            "occurrence.observedAt must be an RFC 3339 date-time"
        }
        require(
            requireString(occurrence, "platform", 1, 20) in
                setOf("android", "ios", "windows", "macos", "linux", "web", "other"),
        ) { "occurrence.platform is not allowed" }
        validateOptionalString(occurrence, "appVersion", 100)
        validateOptionalString(occurrence, "resourceVersion", 100)
        validateOptionalString(occurrence, "deviceModel", 200)
        validateOptionalString(occurrence, "osVersion", 100)
        validateOptionalString(occurrence, "frequency", 100)
        validateOptionalString(occurrence, "errorSignature", 500)
        if (occurrence["gitSha"] != null) {
            require(
                requireString(occurrence, "gitSha", 40, 40).matches(Regex("^[0-9a-f]{40}$")),
            ) { "occurrence.gitSha must be a lowercase 40-character SHA" }
        }

        val steps = requireList(occurrence["steps"], "occurrence.steps")
        require(steps.size in 1..50) { "occurrence.steps must contain 1 to 50 items" }
        steps.forEachIndexed { index, value ->
            val step = value as? String
                ?: throw IllegalArgumentException("occurrence.steps[$index] must be a string")
            require(step.length in 1..1_000) {
                "occurrence.steps[$index] must contain 1 to 1000 characters"
            }
        }
        requireString(occurrence, "actualBehavior", 1, 10_000)
        if (occurrence.containsKey("environment")) {
            validateEnvironment(requireMap(occurrence["environment"], "occurrence.environment"))
        }
    }

    private fun validateEnvironment(environment: Map<String, Any?>) {
        require(environment.size <= 6) { "occurrence.environment may contain at most 6 fields" }
        require(environment.keys.all { it in allowedEnvironmentKeys }) {
            "occurrence.environment contains an unsupported or sensitive field"
        }
        require(encodedEnvironment(environment).toByteArray(Charsets.UTF_8).size <= 256) {
            "occurrence.environment exceeds the 256-byte contract limit"
        }
        if (environment.containsKey("qaAppVersion")) {
            require((environment["qaAppVersion"] as? String)?.matches(qaAppVersionPattern) == true) {
                "occurrence.environment.qaAppVersion is invalid"
            }
        }
        validateOptionalUuid(environment, "testSessionId", nullable = true)
        validateOptionalUuid(environment, "buildId", nullable = true)
        if (environment.containsKey("networkType")) {
            val networkType = environment["networkType"]
            require(
                networkType is String &&
                    networkType in
                    setOf("wifi", "cellular", "ethernet", "vpn", "offline", "other", "unknown"),
            ) { "occurrence.environment.networkType is invalid" }
        }
        environment["networkMetered"]?.let {
            require(it is Boolean) {
                "occurrence.environment.networkMetered must be boolean or null"
            }
        }
        if (environment.containsKey("orientation")) {
            val orientation = environment["orientation"]
            require(
                orientation is String &&
                    orientation in setOf("portrait", "landscape", "square", "unknown"),
            ) {
                "occurrence.environment.orientation is invalid"
            }
        }
    }

    private fun requireExactKeys(
        value: Map<String, Any?>,
        required: Set<String>,
        allowed: Set<String>,
        label: String,
    ) {
        require(value.keys.containsAll(required)) { "$label is missing required fields" }
        require(value.keys.all { it in allowed }) { "$label contains unsupported fields" }
    }

    private fun requireString(
        value: Map<String, Any?>,
        key: String,
        minLength: Int,
        maxLength: Int,
    ): String {
        val string = value[key] as? String
            ?: throw IllegalArgumentException("$key must be a string")
        require(string.length in minLength..maxLength) {
            "$key must contain $minLength to $maxLength characters"
        }
        return string
    }

    private fun requireUuid(value: String, label: String): String {
        require(value.matches(uuidPattern) && runCatching { UUID.fromString(value) }.isSuccess) {
            "$label must be a UUID"
        }
        return value
    }

    private fun validateOptionalUuid(
        value: Map<String, Any?>,
        key: String,
        nullable: Boolean,
    ) {
        if (!value.containsKey(key)) return
        val item = value[key]
        require(nullable || item != null) { "$key cannot be null" }
        item?.let { requireUuid(it as? String ?: "", key) }
    }

    private fun validateOptionalString(value: Map<String, Any?>, key: String, maxLength: Int) {
        value[key]?.let {
            require(it is String && it.length <= maxLength) {
                "$key must be a string of at most $maxLength characters or null"
            }
        }
    }

    private fun validateUuidList(value: Map<String, Any?>, key: String, maxItems: Int) {
        if (!value.containsKey(key)) return
        val items = requireList(value[key], key)
        require(items.size <= maxItems) { "$key contains too many items" }
        val uniqueItems = mutableSetOf<String>()
        items.forEachIndexed { index, item ->
            val uuid = requireUuid(item as? String ?: "", "$key[$index]")
            require(uniqueItems.add(uuid)) { "$key must contain unique UUIDs" }
        }
    }

    private fun requireMap(value: Any?, label: String): Map<String, Any?> {
        val map = value as? Map<*, *>
            ?: throw IllegalArgumentException("$label must be an object")
        require(map.keys.all { it is String }) { "$label keys must be strings" }
        @Suppress("UNCHECKED_CAST")
        return map as Map<String, Any?>
    }

    private fun requireList(value: Any?, label: String): List<Any?> =
        value as? List<Any?> ?: throw IllegalArgumentException("$label must be an array")

    private fun encodedEnvironment(environment: Map<String, Any?>): String =
        environment.entries.joinToString(prefix = "{", postfix = "}") { (key, value) ->
            "\"${escapeJson(key)}\":" + when (value) {
                null -> "null"
                is Boolean, is Number -> value.toString()
                is String -> "\"${escapeJson(value)}\""
                else -> throw IllegalArgumentException("occurrence.environment values must be scalar")
            }
        }

    private fun escapeJson(value: String): String = buildString {
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) {
                    append("\\u%04x".format(character.code))
                } else {
                    append(character)
                }
            }
        }
    }
}
