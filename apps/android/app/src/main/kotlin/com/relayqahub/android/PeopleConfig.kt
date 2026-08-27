package com.relayqahub.android

/** Personnel returned by the authenticated QA Hub project-members endpoint. */
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
    val projectKey: String,
    val people: List<QaPerson>,
) {
    val activeFixers: List<QaPerson>
        get() = people.filter { it.active && QaPersonRole.FIXER in it.roles }

    val activeVerifiers: List<QaPerson>
        get() = people.filter { it.active && QaPersonRole.VERIFIER in it.roles }
}
