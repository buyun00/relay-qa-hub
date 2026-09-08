package com.relayqahub.android.data

/** Media may be discarded only before any durable intent or queue row can reference it. */
internal suspend fun commitDurableBugDraft(
    prepare: suspend () -> NewOfflineOperation,
    saveIntent: ((NewOfflineOperation) -> Unit)?,
    enqueue: suspend (NewOfflineOperation) -> String,
    markQueued: (String) -> Unit,
    schedule: () -> Unit,
    discardStaged: suspend () -> Unit,
): String {
    var retainMedia = false
    try {
        val request = prepare()
        if (saveIntent != null) {
            // Failed preference commits can have uncertain durability too.
            retainMedia = true
            saveIntent(request)
        }
        val operationId = enqueue(request)
        retainMedia = true
        markQueued(operationId)
        schedule()
        return operationId
    } catch (failure: Throwable) {
        if (!retainMedia) discardStaged()
        throw failure
    }
}
