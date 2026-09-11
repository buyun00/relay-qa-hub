package com.relayqahub.android

import com.relayqahub.android.network.QaHubApiEndpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QaRuntimeConfigTest {
    @Test
    fun `runtime config accepts the documented LAN endpoint`() {
        val config = QaRuntimeConfigLoader.parse(
            """{"schemaVersion":1,"apiBaseUrl":"http://127.0.0.1:4419/api/v1"}""",
        )

        assertEquals(1, config.schemaVersion)
        assertEquals("http://127.0.0.1:4419/api/v1/", config.apiBaseUrl)
    }

    @Test
    fun `runtime config rejects unsupported fields schema and public cleartext`() {
        listOf(
            """{"schemaVersion":2,"apiBaseUrl":"https://qa.example/api/v1/"}""",
            """{"schemaVersion":1,"apiBaseUrl":"https://qa.example/api/v1/","token":"secret"}""",
            """{"schemaVersion":1,"apiBaseUrl":"http://8.8.8.8:4319/api/v1/"}""",
            """{"schemaVersion":1,"apiBaseUrl":"http://qa.example:4319/api/v1/"}""",
        ).forEach { json ->
            assertTrue(runCatching { QaRuntimeConfigLoader.parse(json) }.isFailure)
        }
    }

    @Test
    fun `runtime config persistence round trip keeps a private LAN address`() {
        val original = QaRuntimeConfig(
            schemaVersion = 1,
            apiBaseUrl = "http://10.100.5.157:4719/api/v1/",
        )

        val persisted = QaRuntimeConfigLoader.serialize(original)
        val restored = QaRuntimeConfigLoader.parse(persisted)

        assertEquals(original, restored)
    }

    @Test
    fun `endpoint policy permits private and link local literals only for cleartext`() {
        listOf(
            "http://localhost:4319/api/v1/",
            "http://127.0.0.2:4319/api/v1/",
            "http://10.0.0.1:4319/api/v1/",
            "http://172.16.0.1:4319/api/v1/",
            "http://172.31.255.254:4319/api/v1/",
            "http://192.168.1.1:4319/api/v1/",
            "http://169.254.1.1:4319/api/v1/",
            "http://[::1]:4319/api/v1/",
            "http://[fe80::1]:4319/api/v1/",
            "http://[fd00::1]:4319/api/v1/",
        ).forEach { url ->
            assertEquals(url, QaHubApiEndpoint.parse(url, allowPrivateHttp = true).toString())
        }

        listOf(
            "http://10.0.0.1:4319/api/v1/",
            "http://172.15.255.255:4319/api/v1/",
            "http://172.32.0.1:4319/api/v1/",
            "http://169.253.1.1:4319/api/v1/",
            "http://8.8.8.8:4319/api/v1/",
            "http://qa.example:4319/api/v1/",
        ).forEachIndexed { index, url ->
            val allowPrivate = index != 0
            assertTrue(
                "Expected cleartext rejection: $url",
                runCatching { QaHubApiEndpoint.parse(url, allowPrivate) }.isFailure,
            )
        }
        assertEquals(
            "https://qa.example/api/v1/",
            QaHubApiEndpoint.parse("https://qa.example/api/v1/").toString(),
        )
    }
}
