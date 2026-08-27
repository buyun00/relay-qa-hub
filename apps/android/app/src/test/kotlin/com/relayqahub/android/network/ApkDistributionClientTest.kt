package com.relayqahub.android.network

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ApkDistributionClientTest {
    @Test
    fun `android update manifest resolves only the published sibling APK`() {
        val release = parseAndroidUpdateManifest(
            json = """
                {
                  "schemaVersion": 1,
                  "versionCode": 7,
                  "versionName": "0.1.6-debug",
                  "packageName": "com.relayqahub.android.debug",
                  "fileName": "Relay-QA-Hub-Android-7-0.1.6-debug.apk",
                  "size": 33000000,
                  "sha256": "${"ab".repeat(32)}"
                }
            """.trimIndent(),
            feedUrl = "http://10.100.5.157:4319/api/v1/android-updates/stable/latest.json"
                .toHttpUrl(),
        )

        assertEquals(7L, release.versionCode)
        assertEquals("0.1.6-debug", release.versionName)
        assertEquals(
            "http://10.100.5.157:4319/api/v1/android-updates/stable/" +
                "Relay-QA-Hub-Android-7-0.1.6-debug.apk",
            release.downloadUrl,
        )
        assertTrue(
            runCatching {
                parseAndroidUpdateManifest(
                    """{"schemaVersion":1,"versionCode":8,"versionName":"0.1.7-debug","packageName":"com.relayqahub.android.debug","fileName":"../evil.apk","size":1,"sha256":"${"ab".repeat(32)}"}""",
                    "http://10.100.5.157:4319/api/v1/android-updates/stable/latest.json"
                        .toHttpUrl(),
                )
            }.isFailure,
        )
    }

    @Test
    fun `game catalog returns the latest five game APKs and excludes QA Hub packages`() {
        val files = (1..7).joinToString(",") { index ->
            """{"name":"baloot_google_release_2.1.${index}_20260827150${index}_1_intra_nosdk.apk","path":"apk/game-$index.apk","type":"file","size":${170000000 + index},"mtime":${1000 + index}}"""
        }
        val json = """
            {"files":[
              $files,
              {"name":"Relay-QA-Hub-Android-7-0.1.6-debug.apk","path":"apk/qa.apk","type":"file","size":33000000,"mtime":9999},
              {"name":"qr","path":"apk/qr","type":"dir","size":0,"mtime":10000}
            ]}
        """.trimIndent()

        val items = parseGameApkCatalog(
            json,
            "http://10.100.5.129:8000/apk/".toHttpUrl(),
            limit = 5,
        )

        assertEquals(5, items.size)
        assertEquals("2.1.7", items.first().versionName)
        assertEquals(1007L, items.first().modifiedAtEpochMs)
        assertEquals("2.1.3", items.last().versionName)
        assertTrue(items.all { it.kind == ApkArtifactKind.GAME })
        assertTrue(items.all { it.downloadUrl.startsWith("http://10.100.5.129:8000/apk/") })
    }
}
