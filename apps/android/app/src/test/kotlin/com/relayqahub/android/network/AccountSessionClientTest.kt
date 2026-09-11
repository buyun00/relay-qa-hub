package com.relayqahub.android.network

import com.relayqahub.android.QaPersonRole
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountSessionClientTest {
    @Test
    fun `login sends project code as a string and preserves leading zero`() {
        val client = AccountSessionClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = OkHttpClient(),
        )

        val request = client.buildLoginRequest("Demo Project", "0007", "  新账号  ")
        val body = okio.Buffer().also { request.body?.writeTo(it) }.readUtf8()

        assertEquals("https://qa-hub.example/api/v1/auth/login", request.url.toString())
        assertEquals("POST", request.method)
        assertNull(request.header("Authorization"))
        assertEquals("{\"projectName\":\"Demo Project\",\"code\":\"0007\",\"name\":\"  新账号  \",\"client\":\"android\"}", body)
    }

    @Test
    fun `login request rejects non four digit project codes`() {
        val client = AccountSessionClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = OkHttpClient(),
        )

        listOf("7", "000", "00007", "12a4").forEach { code ->
            val failure = runCatching {
                client.buildLoginRequest("Demo Project", code, "Alice")
            }.exceptionOrNull()
            assertTrue(failure is IllegalArgumentException)
        }
    }

    @Test
    fun `people keep only canonical roles returned by the server`() = runBlocking {
        val projectId = "10000000-0000-4000-8000-000000000099"
        val entries = listOf(
            Triple("20000000-0000-4000-8000-000000000001", "Developer", listOf("developer")),
            Triple("20000000-0000-4000-8000-000000000002", "Verifier", listOf("verifier")),
            Triple("20000000-0000-4000-8000-000000000003", "Both", listOf("developer", "verifier")),
            Triple("20000000-0000-4000-8000-000000000004", "Observer", listOf("viewer")),
        )
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            assertEquals("/api/v1/projects/$projectId/members", request.url.encodedPath)
            assertEquals("100", request.url.queryParameter("limit"))
            assertEquals("Bearer token", request.header("Authorization"))
            val body = JSONObject().put("projectId", projectId).put("snapshotSequence", 42L).put(
                "items",
                JSONArray().also { items ->
                    entries.forEach { (id, name, roles) ->
                        items.put(
                            JSONObject().put("userId", id).put("projectId", projectId)
                                .put("displayName", name)
                                .put("roles", JSONArray(roles)).put("active", true),
                        )
                    }
                },
            ).put("nextCursor", JSONObject.NULL)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                .code(200).message("Fixture").body(body.toString().toResponseBody()).build()
        }.build()
        val people = AccountSessionClient("https://qa-hub.example/api/v1/", http)
            .listPeople(projectId, "QA", "token")

        assertEquals(setOf(QaPersonRole.FIXER), people.people[0].roles)
        assertEquals(setOf(QaPersonRole.VERIFIER), people.people[1].roles)
        assertEquals(setOf(QaPersonRole.FIXER, QaPersonRole.VERIFIER), people.people[2].roles)
        assertEquals(emptySet<QaPersonRole>(), people.people[3].roles)
        assertEquals(listOf("Developer", "Both"), people.activeFixers.map { it.displayName })
        assertEquals(listOf("Verifier", "Both"), people.activeVerifiers.map { it.displayName })
        assertEquals(42L, people.snapshotSequence)
    }

    @Test
    fun `unknown duplicate and non-string roles fail closed`() = runBlocking {
        val projectId = "10000000-0000-4000-8000-000000000099"
        listOf(
            JSONArray().put("verifier").put("future_role"),
            JSONArray().put("verifier").put("verifier"),
            JSONArray().put("verifier").put(7),
            JSONArray(),
        ).forEach { roles ->
            val body = peopleResponse(projectId, member(projectId).put("roles", roles))
            val failure = runCatching {
                clientFor(body).listPeople(projectId, "QA", "token")
            }.exceptionOrNull()

            assertEquals("INVALID_PEOPLE_RESPONSE", (failure as AccountSessionFailure).code)
        }
    }

    @Test
    fun `disabled verifier is parsed but excluded from active verifier authority`() = runBlocking {
        val projectId = "10000000-0000-4000-8000-000000000099"
        val body = peopleResponse(projectId, member(projectId).put("active", false))

        val people = clientFor(body).listPeople(projectId, "QA", "token")

        assertEquals(false, people.people.single().active)
        assertTrue(people.activeVerifiers.isEmpty())
    }

    @Test
    fun `people response rejects coerced active and malformed page metadata`() = runBlocking {
        val projectId = "10000000-0000-4000-8000-000000000099"
        val malformed = listOf(
            peopleResponse(projectId, member(projectId).put("active", "true")),
            peopleResponse(projectId, member(projectId)).put("snapshotSequence", "42"),
            peopleResponse(projectId, member(projectId)).put("nextCursor", 7),
            peopleResponse(projectId, member(projectId)).apply { remove("nextCursor") },
            peopleResponse(projectId, member(projectId)).put("linkedUserIds", JSONArray()),
            peopleResponse(projectId, member(projectId).put("linkedUserIds", JSONArray())),
        )
        malformed.forEach { body ->
            val failure = runCatching {
                clientFor(body).listPeople(projectId, "QA", "token")
            }.exceptionOrNull()

            assertEquals("INVALID_PEOPLE_RESPONSE", (failure as AccountSessionFailure).code)
        }
    }

    @Test
    fun `people directory reads every page at one snapshot`() = runBlocking {
        val projectId = "10000000-0000-4000-8000-000000000099"
        val cursor = "member-page-2"
        val first = member(projectId)
        val second = member(projectId)
            .put("userId", "20000000-0000-4000-8000-000000000002")
            .put("displayName", "Developer")
            .put("roles", JSONArray().put("developer"))
        val requests = mutableListOf<String?>()
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val requestedCursor = chain.request().url.queryParameter("cursor")
            requests += requestedCursor
            val body = if (requestedCursor == null) {
                peoplePage(projectId, 55L, listOf(first), cursor)
            } else {
                assertEquals(cursor, requestedCursor)
                peoplePage(projectId, 55L, listOf(second), null)
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("Fixture").body(body.toString().toResponseBody()).build()
        }.build()

        val people = AccountSessionClient("https://qa-hub.example/api/v1/", http)
            .listPeople(projectId, "QA", "token")

        assertEquals(listOf(null, cursor), requests)
        assertEquals(listOf("Verifier", "Developer"), people.people.map { it.displayName })
        assertEquals(55L, people.snapshotSequence)
    }

    @Test
    fun `people directory rejects snapshot drift repeated cursor and duplicate member`() = runBlocking {
        val projectId = "10000000-0000-4000-8000-000000000099"
        val cursor = "member-page-2"
        listOf("snapshot", "cursor", "duplicate").forEach { failureMode ->
            var calls = 0
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                calls += 1
                val body = when {
                    calls == 1 -> peoplePage(projectId, 55L, listOf(member(projectId)), cursor)
                    failureMode == "snapshot" -> peoplePage(projectId, 56L, emptyList(), null)
                    failureMode == "cursor" -> peoplePage(projectId, 55L, emptyList(), cursor)
                    else -> peoplePage(projectId, 55L, listOf(member(projectId)), null)
                }
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                    .code(200).message("Fixture").body(body.toString().toResponseBody()).build()
            }.build()

            val failure = runCatching {
                AccountSessionClient("https://qa-hub.example/api/v1/", http)
                    .listPeople(projectId, "QA", "token")
            }.exceptionOrNull()

            assertEquals(
                when (failureMode) {
                    "snapshot" -> "PEOPLE_SNAPSHOT_CHANGED"
                    "cursor" -> "PEOPLE_CURSOR_REPEATED"
                    else -> "INVALID_PEOPLE_RESPONSE"
                },
                (failure as AccountSessionFailure).code,
            )
        }
    }

    private fun member(projectId: String) = JSONObject()
        .put("userId", "20000000-0000-4000-8000-000000000001")
        .put("projectId", projectId)
        .put("displayName", "Verifier")
        .put("roles", JSONArray().put("verifier"))
        .put("active", true)

    private fun peopleResponse(projectId: String, vararg members: JSONObject) = JSONObject()
        .put("projectId", projectId)
        .put("snapshotSequence", 42L)
        .put("items", JSONArray(members.toList()))
        .put("nextCursor", JSONObject.NULL)

    private fun peoplePage(
        projectId: String,
        snapshot: Long,
        members: List<JSONObject>,
        nextCursor: String?,
    ) = JSONObject()
        .put("projectId", projectId)
        .put("snapshotSequence", snapshot)
        .put("items", JSONArray(members))
        .put("nextCursor", nextCursor ?: JSONObject.NULL)

    private fun clientFor(body: JSONObject): AccountSessionClient {
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("Fixture").body(body.toString().toResponseBody()).build()
        }.build()
        return AccountSessionClient("https://qa-hub.example/api/v1/", http)
    }
}
