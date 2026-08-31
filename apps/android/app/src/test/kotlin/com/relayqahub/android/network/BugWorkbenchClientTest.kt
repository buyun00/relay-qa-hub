package com.relayqahub.android.network

import java.io.IOException
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BugWorkbenchClientTest {
    @Test
    fun `full Bug edit sends fields assignments and the final attachment set`() = runBlocking {
        var capturedBody = ""
        var capturedIdempotency = ""
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request()
                capturedBody = Buffer().also { request.body?.writeTo(it) }.readUtf8()
                capturedIdempotency = request.header("Idempotency-Key").orEmpty()
                assertEquals("PATCH", request.method)
                assertEquals("Bearer access-token", request.header("Authorization"))
                assertEquals("/api/v1/bugs/$BUG_ID", request.url.encodedPath)
                throw IOException("request captured")
            }
            .build()
        val client = BugWorkbenchClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = http,
        )

        val failure = runCatching {
            client.updateBug(
                request = WorkbenchBugUpdate(
                    bugId = BUG_ID,
                    expectedVersion = 7,
                    mutationId = MUTATION_ID,
                    title = "Edited title",
                    description = "Edited description",
                    expectedBehavior = "Edited expectation",
                    moduleId = null,
                    severity = "S1",
                    priority = "P0",
                    ownerId = null,
                    verificationOwnerId = VERIFIER_ID,
                    attachmentIds = listOf(ATTACHMENT_ID),
                ),
                accessToken = "access-token",
            )
        }.exceptionOrNull()

        assertEquals("NETWORK_IO", (failure as BugWorkbenchFailure).code)
        assertEquals(
            "android:updateBug:bug:$BUG_ID:v7:$MUTATION_ID",
            capturedIdempotency,
        )
        assertTrue(capturedBody.contains("\"moduleId\":null"))
        assertTrue(capturedBody.contains("\"ownerId\":null"))
        assertTrue(capturedBody.contains("\"verificationOwnerId\":\"$VERIFIER_ID\""))
        assertTrue(capturedBody.contains("\"priority\":\"P0\""))
        assertTrue(capturedBody.contains("\"attachmentIds\":[\"$ATTACHMENT_ID\"]"))
    }

    private companion object {
        const val BUG_ID = "70000000-0000-4000-8000-000000000001"
        const val VERIFIER_ID = "10000000-0000-4000-8000-000000000005"
        const val ATTACHMENT_ID = "50000000-0000-4000-8000-000000000001"
        const val MUTATION_ID = "60000000-0000-4000-8000-000000000001"
    }
}
