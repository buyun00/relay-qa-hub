package com.relayqahub.android.work

import com.relayqahub.android.data.AccountProjectScope

/** Re-enqueues fail-closed BLOCKED_DEVICE rows when the user returns after device unlock. */
class DeviceSecurityResumeCoordinator(
    private val blockedScopes: suspend () -> List<AccountProjectScope>,
    private val syncWorkController: SyncWorkController,
) {
    suspend fun resumeBlockedOperations(): Int {
        val scopes = blockedScopes().distinct()
        scopes.forEach(syncWorkController::resumeAfterDeviceUnlock)
        return scopes.size
    }
}
