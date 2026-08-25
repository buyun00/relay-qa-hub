package com.relayqahub.android

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.relayqahub.android.capture.CapturedPocoArtifact
import com.relayqahub.android.data.AccountProjectScope
import com.relayqahub.android.data.NewOfflineOperation
import com.relayqahub.android.capture.CapturePocoSummary
import com.relayqahub.android.network.AttachmentUploadFailure
import com.relayqahub.android.network.CaptureAttachmentReceipt
import com.relayqahub.android.network.CaptureBundleArtifactUpload
import com.relayqahub.android.network.CaptureBundleDeviceInput
import com.relayqahub.android.network.CaptureBundlePocoInput
import com.relayqahub.android.network.QaHubApiContract
import com.relayqahub.android.network.BuildProjectionFailure
import com.relayqahub.android.network.BuildProjectionResult
import com.relayqahub.android.network.DuplicateCandidateFailure
import com.relayqahub.android.network.InboxFailure
import com.relayqahub.android.network.RelayHandoffFailure
import com.relayqahub.android.network.RelayHandoffResult
import com.relayqahub.android.security.NativeCredentials
import com.relayqahub.android.security.VaultResult
import com.relayqahub.android.security.nativeSessionScope
import com.relayqahub.android.poco.PocoEnrichmentStatus
import com.relayqahub.android.work.SyncRunResult
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import org.json.JSONObject

data class FoundationUiState(
    val accountName: String = "Preparing local scope…",
    val projectName: String = "Preparing native foundation…",
    val cachedItemCount: Int = 0,
    val queuedOperationCount: Int = 0,
    val credentialBoundary: String = "Checking Android Keystore…",
    val contractVersion: String = QaHubApiContract.VERSION,
    val lastAction: String = "Ready for offline-first QA work.",
    val relayHandoff: RelayHandoffResult? = null,
    val buildProjection: BuildProjectionUiState = BuildProjectionUiState(),
    val inbox: InboxUiState = InboxUiState(),
    val duplicateCandidates: DuplicateCandidateUiState = DuplicateCandidateUiState(),
)

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

private data class ScopeUiValues(
    val accountName: String,
    val projectName: String,
    val cachedItemCount: Int,
    val queuedOperationCount: Int,
)

private data class DeliveryUiValues(
    val buildProjection: BuildProjectionUiState,
    val inbox: InboxUiState,
)

class FoundationViewModel(application: Application) : AndroidViewModel(application) {
    private val appContainer = (application as QaHubApplication).container
    private val scope = FOUNDATION_SCOPE
    private val lastAction = MutableStateFlow("Ready for offline-first QA work.")
    private val latestRelayHandoff = MutableStateFlow<RelayHandoffResult?>(null)
    private val buildProjection = MutableStateFlow(BuildProjectionUiState())
    private val inbox = MutableStateFlow(InboxUiState())
    private val duplicateCandidates = MutableStateFlow(DuplicateCandidateUiState())

    private val scopeState = combine(
        appContainer.scopedRepository.observeAccount(scope.accountId),
        appContainer.scopedRepository.observeProject(scope),
        appContainer.scopedRepository.observeCachedItems(scope),
        appContainer.scopedRepository.observeOutstandingCount(scope),
    ) { account, project, cachedItems, queuedCount ->
        ScopeUiValues(
            accountName = account?.displayName ?: "Local account scope",
            projectName = project?.displayName ?: "Local project scope",
            cachedItemCount = cachedItems.size,
            queuedOperationCount = queuedCount,
        )
    }

    private val deliveryState = combine(buildProjection, inbox) { projection, inboxState ->
        DeliveryUiValues(buildProjection = projection, inbox = inboxState)
    }

    val uiState = combine(
        scopeState,
        lastAction,
        latestRelayHandoff,
        deliveryState,
        duplicateCandidates,
    ) { values, action, handoff, delivery, duplicateState ->
        val support = appContainer.credentialVault.support()
        FoundationUiState(
            accountName = values.accountName,
            projectName = values.projectName,
            cachedItemCount = values.cachedItemCount,
            queuedOperationCount = values.queuedOperationCount,
            credentialBoundary = if (support.available) {
                "${support.provider} format v${support.formatVersion} available"
            } else {
                "Unavailable: ${support.reasonCode}"
            },
            lastAction = action,
            relayHandoff = handoff,
            buildProjection = delivery.buildProjection,
            inbox = delivery.inbox,
            duplicateCandidates = duplicateState,
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = FoundationUiState(),
    )

    init {
        viewModelScope.launch {
            appContainer.scopedRepository.seedFoundationScope(scope)
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
        submitPngAttachment(
            pngBytes = createLiveSmokePng(),
            filename = LIVE_SMOKE_FILENAME,
            captureId = null,
            capturedAtEpochMs = null,
            actionLabel = "Live smoke",
            pocoSummary = null,
            pocoArtifacts = emptyList(),
        )
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
                when (
                    appContainer.credentialVault.put(
                        scope = scope.nativeSessionScope(),
                        credentials = NativeCredentials(
                            accessToken = accessToken,
                            refreshToken = LIVE_SMOKE_UNUSED_REFRESH_TOKEN,
                            accessTokenExpiresAtEpochMs =
                                System.currentTimeMillis() + LIVE_SMOKE_CREDENTIAL_TTL_MS,
                            sharedDeviceSession = false,
                        ),
                    )
                ) {
                    is VaultResult.Success -> Unit
                    VaultResult.Missing -> throw RelayHandoffFailure("CREDENTIAL_WRITE_MISSING")
                    is VaultResult.Unavailable ->
                        throw RelayHandoffFailure("CREDENTIAL_VAULT_UNAVAILABLE")
                }

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
                when (
                    appContainer.credentialVault.put(
                        scope = scope.nativeSessionScope(),
                        credentials = NativeCredentials(
                            accessToken = accessToken,
                            refreshToken = LIVE_SMOKE_UNUSED_REFRESH_TOKEN,
                            accessTokenExpiresAtEpochMs =
                                System.currentTimeMillis() + LIVE_SMOKE_CREDENTIAL_TTL_MS,
                            sharedDeviceSession = false,
                        ),
                    )
                ) {
                    is VaultResult.Success -> Unit
                    VaultResult.Missing -> throw DuplicateCandidateFailure("CREDENTIAL_WRITE_MISSING")
                    is VaultResult.Unavailable ->
                        throw DuplicateCandidateFailure("CREDENTIAL_VAULT_UNAVAILABLE")
                }
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

    fun reportCaptureUnavailable(reason: String) {
        lastAction.value = "Capture unavailable: $reason. Ordinary defect entry remains available."
    }

    fun reportCaptureSessionState(active: Boolean) {
        lastAction.value = if (active) {
            "Capture session active. Use the visible QA ball or Capture now; Stop is always available."
        } else {
            "Capture session stopped. Ordinary defect entry remains available."
        }
    }

    fun reportCaptureSessionStarting() {
        lastAction.value = "Starting the explicitly authorized capture session…"
    }

    fun reportPendingCaptureSaved(captureId: String, width: Int, height: Int) {
        lastAction.value =
            "Pending capture $captureId saved locally (${width}x$height); add details before submit."
    }

    private fun submitPngAttachment(
        pngBytes: ByteArray,
        filename: String,
        captureId: String?,
        capturedAtEpochMs: Long?,
        actionLabel: String,
        pocoSummary: CapturePocoSummary?,
        pocoArtifacts: List<CapturedPocoArtifact>,
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
                when (
                    appContainer.credentialVault.put(
                        scope = scope.nativeSessionScope(),
                        credentials = NativeCredentials(
                            accessToken = accessToken,
                            refreshToken = LIVE_SMOKE_UNUSED_REFRESH_TOKEN,
                            accessTokenExpiresAtEpochMs =
                                System.currentTimeMillis() + LIVE_SMOKE_CREDENTIAL_TTL_MS,
                            sharedDeviceSession = false,
                        ),
                    )
                ) {
                    is VaultResult.Success -> Unit
                    VaultResult.Missing -> throw LiveSmokeFailure("CREDENTIAL_WRITE_MISSING")
                    is VaultResult.Unavailable ->
                        throw LiveSmokeFailure("CREDENTIAL_VAULT_UNAVAILABLE")
                }

                val submissionId = UUID.randomUUID().toString()
                val clientAttachmentId = UUID.randomUUID().toString()
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
                        attachmentIds = listOf(uploadReceipt.attachmentId),
                        captureBundleId = captureBundleId,
                    ),
                )
                val syncResult = appContainer.syncEngine.run(scope)
                val receipt = appContainer.scopedRepository.findReceipt(scope, operationId)
                if (receipt != null) {
                    val claimed = appContainer.scopedRepository.recordAttachmentClaimed(
                        scope = scope,
                        clientSubmissionId = submissionId,
                        clientAttachmentId = clientAttachmentId,
                        qaItemId = receipt.qaItemId,
                        qaItemKey = receipt.qaItemKey,
                        responseJson = receipt.responseJson,
                    )
                    "$actionLabel created ${receipt.qaItemKey}; attachment " +
                        "${claimed.attachmentId} is ${claimed.bindingStatus}" +
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
        val FOUNDATION_SCOPE = AccountProjectScope(
            accountId = "10000000-0000-4000-8000-000000000020",
            projectId = "10000000-0000-4000-8000-000000000004",
            actorId = "10000000-0000-4000-8000-000000000003",
            installationId = "10000000-0000-4000-8000-000000000001",
            sessionId = "10000000-0000-4000-8000-000000000002",
        )
    }
}

private fun CapturePocoSummary?.pocoDisplaySuffix(): String = when (this?.status) {
    null -> ""
    PocoEnrichmentStatus.COMPLETE ->
        " Unity context: complete / 已获取 Unity 上下文" + pocoEndpointSuffix() + "."
    PocoEnrichmentStatus.PARTIAL ->
        " Unity context: partial / 部分" + pocoEndpointSuffix() + "."
    PocoEnrichmentStatus.UNAVAILABLE -> " Unity context: unavailable / 未连接."
}

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

private fun CapturedPocoArtifact.captureFilename(captureId: String): String {
    val extension = when (mediaType) {
        "image/png" -> "png"
        "image/jpeg" -> "jpg"
        "image/webp" -> "webp"
        "application/json" -> "json"
        else -> throw LiveSmokeFailure("POCO_ARTIFACT_MEDIA_TYPE_UNSUPPORTED")
    }
    return "capture-$captureId-${kind.wireName}.$extension"
}

private fun CapturePocoSummary.withPersistedArtifacts(
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

private fun CapturePocoSummary.toCaptureBundlePocoInput(): CaptureBundlePocoInput {
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

private const val LIVE_SMOKE_CREDENTIAL_TTL_MS = 5 * 60 * 1_000L
private const val LIVE_SMOKE_UNUSED_REFRESH_TOKEN = "debug-live-smoke-does-not-refresh"
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
            "title" to "Native QA Hub contract-validation draft",
            "description" to
                "The Android foundation queued a representative Bug command for offline sync.",
            "expectedBehavior" to
                "A valid App-first Bug command remains isolated to its authenticated project.",
            "severity" to "S3",
            "priority" to "P3",
            "occurrence" to occurrence,
            "attachmentIds" to attachmentIds,
        )
        captureBundleId?.let { payload["captureBundleId"] = it }
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
    ): NewOfflineOperation {
        val request = buildRequest(
            projectId = projectId,
            submissionId = submissionId,
            observedAt = observedAt,
            qaAppVersion = qaAppVersion,
            attachmentIds = attachmentIds,
            captureBundleId = captureBundleId,
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
