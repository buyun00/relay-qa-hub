package com.relayqahub.android

import android.content.Context
import androidx.room.Room
import androidx.work.WorkManager
import com.relayqahub.android.data.QaHubDatabase
import com.relayqahub.android.data.ScopedRepository
import com.relayqahub.android.network.AttachmentUploadClient
import com.relayqahub.android.network.BuildProjectionClient
import com.relayqahub.android.network.BugWorkbenchClient
import com.relayqahub.android.network.CommentTimelineClient
import com.relayqahub.android.network.DuplicateCandidateClient
import com.relayqahub.android.network.InboxClient
import com.relayqahub.android.network.HumanWorkflowClient
import com.relayqahub.android.network.OkHttpQaHubApiClient
import com.relayqahub.android.network.RelayHandoffClient
import com.relayqahub.android.network.RepairAttemptClient
import com.relayqahub.android.security.AndroidKeystoreCredentialVault
import com.relayqahub.android.security.CredentialVault
import com.relayqahub.android.security.SessionLifecycleCoordinator
import com.relayqahub.android.work.OfflineSyncEngine
import com.relayqahub.android.work.OfflineAttachmentDraftProcessor
import com.relayqahub.android.work.OfflineAttachmentDraftStore
import com.relayqahub.android.work.DeviceSecurityResumeCoordinator
import com.relayqahub.android.work.SyncScheduler
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

class AppContainer private constructor(
    val database: QaHubDatabase,
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
    val credentialVault: CredentialVault,
    val syncEngine: OfflineSyncEngine,
    val syncScheduler: SyncScheduler,
    val sessionLifecycle: SessionLifecycleCoordinator,
    val deviceSecurityResume: DeviceSecurityResumeCoordinator,
) {
    companion object {
        fun create(context: Context): AppContainer {
            val applicationContext = context.applicationContext
            val database = Room.databaseBuilder(
                applicationContext,
                QaHubDatabase::class.java,
                "qa-hub-cache-v1.db",
            ).addMigrations(
                QaHubDatabase.MIGRATION_1_2,
                QaHubDatabase.MIGRATION_2_3,
                QaHubDatabase.MIGRATION_3_4,
            ).build()
            val credentialVault = AndroidKeystoreCredentialVault(applicationContext)
            val httpClient = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .build()
            val apiClient = OkHttpQaHubApiClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val attachmentUploadClient = AttachmentUploadClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val relayHandoffClient = RelayHandoffClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val repairAttemptClient = RepairAttemptClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val buildProjectionClient = BuildProjectionClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val bugWorkbenchClient = BugWorkbenchClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val commentTimelineClient = CommentTimelineClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val duplicateCandidateClient = DuplicateCandidateClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val inboxClient = InboxClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val humanWorkflowClient = HumanWorkflowClient(
                baseUrl = BuildConfig.QA_HUB_API_BASE_URL,
                httpClient = httpClient,
                allowLoopbackHttp = BuildConfig.DEBUG,
            )
            val scopedRepository = ScopedRepository(
                accountProjectDao = database.accountProjectDao(),
                cachedQaItemDao = database.cachedQaItemDao(),
                offlineOperationDao = database.offlineOperationDao(),
                attachmentPipelineReceiptDao = database.attachmentPipelineReceiptDao(),
                submissionReceiptDao = database.submissionReceiptDao(),
            )
            val offlineAttachmentDraftStore = OfflineAttachmentDraftStore(applicationContext)
            val syncScheduler = SyncScheduler(WorkManager.getInstance(applicationContext))
            return AppContainer(
                database = database,
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
