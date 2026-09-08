package com.relayqahub.android

import android.content.Context
import androidx.room.Room
import androidx.work.WorkManager
import com.relayqahub.android.data.QaHubDatabase
import com.relayqahub.android.data.ScopedRepository
import com.relayqahub.android.capture.PendingCaptureDraftStore
import com.relayqahub.android.capture.CaptureArtifactStore
import com.relayqahub.android.network.AttachmentUploadClient
import com.relayqahub.android.network.AccountSessionClient
import com.relayqahub.android.network.ProjectOperationsClient
import com.relayqahub.android.network.AndroidUpdateClient
import com.relayqahub.android.network.ApkDownloadClient
import com.relayqahub.android.network.BuildProjectionClient
import com.relayqahub.android.network.BugWorkbenchClient
import com.relayqahub.android.network.CommentTimelineClient
import com.relayqahub.android.network.DuplicateCandidateClient
import com.relayqahub.android.network.InboxClient
import com.relayqahub.android.network.HumanWorkflowClient
import com.relayqahub.android.network.GameApkCatalogClient
import com.relayqahub.android.network.OkHttpQaHubApiClient
import com.relayqahub.android.network.RelayHandoffClient
import com.relayqahub.android.network.RepairAttemptClient
import com.relayqahub.android.security.AppPrivateCredentialVault
import com.relayqahub.android.security.CredentialVault
import com.relayqahub.android.security.SessionLifecycleCoordinator
import com.relayqahub.android.work.OfflineSyncEngine
import com.relayqahub.android.work.OfflineAttachmentDraftProcessor
import com.relayqahub.android.work.OfflineAttachmentDraftStore
import com.relayqahub.android.work.DeviceSecurityResumeCoordinator
import com.relayqahub.android.work.SyncScheduler
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient

class AppContainer private constructor(
    val apiBaseUrl: String,
    val projectOperationsClient: ProjectOperationsClient,
    val identityStore: QaIdentityStore,
    val accountSessionClient: AccountSessionClient,
    val bugDraftPreferences: BugDraftPreferences,
    val database: QaHubDatabase,
    val androidUpdateClient: AndroidUpdateClient,
    val gameApkCatalogClient: GameApkCatalogClient,
    val apkDownloadClient: ApkDownloadClient,
    val scopedRepository: ScopedRepository,
    val attachmentUploadClient: AttachmentUploadClient,
    val relayHandoffClient: RelayHandoffClient,
    val repairAttemptClient: RepairAttemptClient,
    val buildProjectionClient: BuildProjectionClient,
    val bugWorkbenchClient: BugWorkbenchClient,
    val commentTimelineClient: CommentTimelineClient,
    val duplicateCandidateClient: DuplicateCandidateClient,
    val inboxClient: InboxClient,
    val humanWorkflowClient: HumanWorkflowClient,
    val offlineAttachmentDraftStore: OfflineAttachmentDraftStore,
    val pendingCaptureDraftStore: PendingCaptureDraftStore,
    val credentialVault: CredentialVault,
    val syncEngine: OfflineSyncEngine,
    val syncScheduler: SyncScheduler,
    val sessionLifecycle: SessionLifecycleCoordinator,
    val deviceSecurityResume: DeviceSecurityResumeCoordinator,
) {
    companion object {
        fun create(context: Context): AppContainer {
            val applicationContext = context.applicationContext
            QaRuntimeConfigLoader.ensureExternalSeed(
                applicationContext,
                BuildConfig.QA_HUB_API_BASE_URL,
            )
            val apiBaseUrl = QaRuntimeConfigLoader.load(
                applicationContext,
                BuildConfig.QA_HUB_API_BASE_URL,
            ).apiBaseUrl
            val identityStore = QaIdentityStore(applicationContext, apiBaseUrl)
            val database = Room.databaseBuilder(
                applicationContext,
                QaHubDatabase::class.java,
                "qa-hub-preview-${namespaceId(apiBaseUrl)}.db",
            ).addMigrations(
                QaHubDatabase.MIGRATION_1_2,
                QaHubDatabase.MIGRATION_2_3,
                QaHubDatabase.MIGRATION_3_4,
            ).build()
            val credentialVault = AppPrivateCredentialVault(applicationContext)
            val httpClient = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                // Mutations must not replay automatically; avoid reusing an idle socket closed by the service.
                .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
                .addInterceptor { chain ->
                    val request = chain.request()
                    val token = request.header("Authorization")?.removePrefix("Bearer ")
                    val projectId = token?.let(NativeProjectBindings::projectFor)
                    chain.proceed(if (projectId == null) request else request.newBuilder()
                        .header("x-qa-project-id", projectId).build())
                }
                .build()
            val distributionHttpClient = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(2, TimeUnit.MINUTES)
                .writeTimeout(30, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
                .build()
            val accountSessionClient = AccountSessionClient(
                baseUrl = apiBaseUrl,
                httpClient = distributionHttpClient,
                allowPrivateHttp = true,
            )
            val apiClient = OkHttpQaHubApiClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val androidUpdateClient = AndroidUpdateClient(
                apiBaseUrl = apiBaseUrl,
                httpClient = distributionHttpClient,
                allowPrivateHttp = true,
            )
            val gameApkCatalogClient = GameApkCatalogClient(
                directoryUrl = BuildConfig.QA_HUB_GAME_APK_DIRECTORY_URL,
                httpClient = distributionHttpClient,
                allowPrivateHttp = true,
            )
            val attachmentUploadClient = AttachmentUploadClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val relayHandoffClient = RelayHandoffClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val repairAttemptClient = RepairAttemptClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val buildProjectionClient = BuildProjectionClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val bugWorkbenchClient = BugWorkbenchClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val commentTimelineClient = CommentTimelineClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val duplicateCandidateClient = DuplicateCandidateClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val inboxClient = InboxClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val humanWorkflowClient = HumanWorkflowClient(
                baseUrl = apiBaseUrl,
                httpClient = httpClient,
                allowPrivateHttp = true,
            )
            val scopedRepository = ScopedRepository(
                accountProjectDao = database.accountProjectDao(),
                cachedQaItemDao = database.cachedQaItemDao(),
                offlineOperationDao = database.offlineOperationDao(),
                attachmentPipelineReceiptDao = database.attachmentPipelineReceiptDao(),
                submissionReceiptDao = database.submissionReceiptDao(),
            )
            val offlineAttachmentDraftStore = OfflineAttachmentDraftStore(applicationContext)
            val pendingCaptureDraftStore = PendingCaptureDraftStore(applicationContext)
            val syncScheduler = SyncScheduler(WorkManager.getInstance(applicationContext))
            return AppContainer(
                apiBaseUrl = apiBaseUrl,
                projectOperationsClient = ProjectOperationsClient(apiBaseUrl, distributionHttpClient),
                identityStore = identityStore,
                accountSessionClient = accountSessionClient,
                bugDraftPreferences = BugDraftPreferences(applicationContext),
                database = database,
                androidUpdateClient = androidUpdateClient,
                gameApkCatalogClient = gameApkCatalogClient,
                apkDownloadClient = ApkDownloadClient(applicationContext, distributionHttpClient),
                scopedRepository = scopedRepository,
                attachmentUploadClient = attachmentUploadClient,
                relayHandoffClient = relayHandoffClient,
                repairAttemptClient = repairAttemptClient,
                buildProjectionClient = buildProjectionClient,
                bugWorkbenchClient = bugWorkbenchClient,
                commentTimelineClient = commentTimelineClient,
                duplicateCandidateClient = duplicateCandidateClient,
                inboxClient = inboxClient,
                humanWorkflowClient = humanWorkflowClient,
                offlineAttachmentDraftStore = offlineAttachmentDraftStore,
                pendingCaptureDraftStore = pendingCaptureDraftStore,
                credentialVault = credentialVault,
                syncEngine = OfflineSyncEngine(
                    operationDao = database.offlineOperationDao(),
                    apiClient = apiClient,
                    credentialVault = credentialVault,
                    attachmentDraftProcessor = OfflineAttachmentDraftProcessor(
                        draftDao = database.offlineAttachmentDraftDao(),
                        scopedRepository = scopedRepository,
                        uploadClient = attachmentUploadClient,
                        draftStore = offlineAttachmentDraftStore,
                        pendingCaptureDraftStore = pendingCaptureDraftStore,
                        captureArtifactStore = CaptureArtifactStore(applicationContext),
                    ),
                    attachmentReceiptDao = database.attachmentPipelineReceiptDao(),
                    attachmentDraftStore = offlineAttachmentDraftStore,
                ),
                syncScheduler = syncScheduler,
                sessionLifecycle = SessionLifecycleCoordinator(
                    credentialVault = credentialVault,
                    accountDataCleaner = scopedRepository,
                    syncWorkCanceller = syncScheduler,
                ),
                deviceSecurityResume = DeviceSecurityResumeCoordinator(
                    blockedScopes = scopedRepository::listBlockedDeviceScopes,
                    syncWorkController = syncScheduler,
                ),
            )
        }
    }
}
