package com.relayqahub.android

import com.relayqahub.android.security.nativeSessionScope
import org.junit.Assert.*
import org.junit.Test

class ProjectScopeIsolationTest {
    private val account = "10000000-0000-4000-8000-000000000001"
    private val actor = "10000000-0000-4000-8000-000000000002"
    private val projectA = "10000000-0000-4000-8000-000000000003"
    private val projectB = "10000000-0000-4000-8000-000000000004"
    @Test fun `server project and person each isolate native sessions and drafts`() {
        val server = "http://127.0.0.1:4419/api/v1/"
        val original = scopedIdentity(server, account, projectA, actor)
        val otherProject = scopedIdentity(server, account, projectB, actor)
        val otherServer = scopedIdentity("http://127.0.0.1:4519/api/v1/", account, projectA, actor)
        val otherPerson = scopedIdentity(server, account, projectA, account)
        assertEquals(original, scopedIdentity(server, account, projectA, actor))
        listOf(otherProject, otherServer, otherPerson).forEach {
            assertNotEquals(original.nativeSessionScope(), it.nativeSessionScope())
        }
        val keys = setOf(draftScopeKey(server, projectA, actor), draftScopeKey(server, projectB, actor),
            draftScopeKey("http://127.0.0.1:4519/api/v1/", projectA, actor), draftScopeKey(server, projectA, account))
        assertEquals(4, keys.size)
    }
    @Test fun `preview runtime refuses production or unset endpoint`() {
        listOf("http://127.0.0.1:4319/api/v1/", "http://10.100.5.157:4319/api/v1/", "https://qa-hub.invalid/api/v1/", "").forEach {
            assertTrue(runCatching { QaRuntimeConfigLoader.parse("""{"schemaVersion":1,"apiBaseUrl":"$it"}""") }.isFailure)
        }
    }
    @Test fun `token binding cannot follow the active project selection`() {
        val token = "test-token-${java.util.UUID.randomUUID()}"
        NativeProjectBindings.register(token, projectA)
        NativeProjectBindings.register(token, projectA)
        assertTrue(runCatching { NativeProjectBindings.register(token, projectB) }.isFailure)
        assertEquals(projectA, NativeProjectBindings.projectFor(token))
    }
}
