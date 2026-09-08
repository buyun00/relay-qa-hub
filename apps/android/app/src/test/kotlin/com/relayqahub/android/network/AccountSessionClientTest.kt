package com.relayqahub.android.network

import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountSessionClientTest {
    @Test
    fun `login sends the untouched name to the backend account boundary`() {
        val client = AccountSessionClient(
            baseUrl = "https://qa-hub.example/api/v1/",
            httpClient = OkHttpClient(),
        )

        val request = client.buildLoginRequest("  新账号  ", "10000000-0000-4000-8000-000000000099")
        val body = okio.Buffer().also { request.body?.writeTo(it) }.readUtf8()

        assertEquals("https://qa-hub.example/api/v1/auth/login", request.url.toString())
        assertEquals("POST", request.method)
        assertNull(request.header("Authorization"))
        assertEquals("{\"name\":\"  新账号  \",\"client\":\"android\",\"projectId\":\"10000000-0000-4000-8000-000000000099\"}", body)
    }
}
