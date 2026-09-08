package com.relayqahub.android

/** Immutable token bindings prevent a late request from acquiring the newly selected project. */
object NativeProjectBindings {
    private val projects = java.util.concurrent.ConcurrentHashMap<String, String>()
    fun register(token: String, projectId: String) {
        val existing = projects.putIfAbsent(token, projectId)
        check(existing == null || existing == projectId) { "TOKEN_PROJECT_MISMATCH" }
    }
    fun projectFor(token: String): String? = projects[token]
}
