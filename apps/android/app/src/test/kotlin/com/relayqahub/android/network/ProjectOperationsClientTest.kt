package com.relayqahub.android.network

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectOperationsClientTest {
    @Test
    fun `project picker reads every page at one snapshot`() = runBlocking {
        val cursor = "project-page-2"
        val requested = mutableListOf<String?>()
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val pageCursor = chain.request().url.queryParameter("cursor")
            requested += pageCursor
            val body = if (pageCursor == null) {
                page(21L, listOf(project("10000000-0000-4000-8000-000000000001", "QA", "QA")), cursor)
            } else {
                page(21L, listOf(project("10000000-0000-4000-8000-000000000002", "GAME", "Game")), null)
            }
            response(chain.request(), body)
        }.build()

        val projects = ProjectOperationsClient("https://qa-hub.example/api/v1/", http)
            .projects("token")

        assertEquals(listOf(null, cursor), requested)
        assertEquals(listOf("QA", "GAME"), projects.map { it.key })
    }

    @Test
    fun `project picker rejects snapshot drift repeated cursors duplicate ids and malformed shape`() =
        runBlocking {
            val cursor = "project-page-2"
            listOf("snapshot", "cursor", "duplicate", "shape", "uuid").forEach { mode ->
                var calls = 0
                val first = project("10000000-0000-4000-8000-000000000001", "QA", "QA")
                val http = OkHttpClient.Builder().addInterceptor { chain ->
                    calls += 1
                    val body = when {
                        mode == "shape" -> page(21L, emptyList(), null).put("unexpected", true)
                        mode == "uuid" -> page(21L, listOf(project("1-1-1-1-1", "QA", "QA")), null)
                        calls == 1 -> page(21L, listOf(first), cursor)
                        mode == "snapshot" -> page(22L, emptyList(), null)
                        mode == "cursor" -> page(21L, emptyList(), cursor)
                        else -> page(21L, listOf(first), null)
                    }
                    response(chain.request(), body)
                }.build()

                val failure = runCatching {
                    ProjectOperationsClient("https://qa-hub.example/api/v1/", http).projects("token")
                }.exceptionOrNull()

                assertTrue("mode $mode must fail", failure != null)
            }
        }

    private fun project(id: String, key: String, name: String) = JSONObject()
        .put("id", id)
        .put("key", key)
        .put("name", name)
        .put("roles", JSONArray().put("viewer"))
        .put("active", true)

    private fun page(
        snapshot: Long,
        items: List<JSONObject>,
        nextCursor: String?,
    ) = JSONObject()
        .put("snapshotSequence", snapshot)
        .put("items", JSONArray(items))
        .put("nextCursor", nextCursor ?: JSONObject.NULL)

    private fun response(request: okhttp3.Request, body: JSONObject): Response =
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
            .code(200).message("Fixture").body(body.toString().toResponseBody()).build()
}
