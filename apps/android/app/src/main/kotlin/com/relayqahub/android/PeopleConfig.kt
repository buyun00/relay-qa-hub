package com.relayqahub.android

/** Active project members returned by the QA Hub backend. */
data class QaPerson(
    val id: String,
    val displayName: String,
    val roles: Set<QaPersonRole>,
    val active: Boolean,
)

enum class QaPersonRole {
    FIXER,
    VERIFIER,
}

data class QaPeopleConfig(
    val schemaVersion: Int,
    val projectKey: String,
    val people: List<QaPerson>,
    val snapshotSequence: Long = 0,
) {
    val activeFixers: List<QaPerson>
        get() = people.filter { it.active && QaPersonRole.FIXER in it.roles }

    val activeVerifiers: List<QaPerson>
        get() = people.filter { it.active && QaPersonRole.VERIFIER in it.roles }

}
