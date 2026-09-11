package com.relayqahub.android.network

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.Collections
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionedGameApkCatalogTest {
    private fun manifest(configuration: String = "Debug", version: String = "2.5.1", build: Long = 12, packages: String = """{"file":"packages/game.apk","size":123,"sha256":"${"a".repeat(64)}"}"""): String {
        val product = if (configuration == "Debug") "2001" else "2002"
        return """{"schemaVersion":1,"status":"ready","platform":"Android","packageConfiguration":"$configuration","resourceConfiguration":"$configuration","releaseVersion":"$version","buildNumber":$build,"sourceRevision":"${"b".repeat(40)}","productId":"$product","channelId":"1002","expectedRuiXueTarget":{"productId":"$product","channelId":"1002","version":"$version"},"packages":[$packages]}"""
    }

    @Test fun `folded and regular directories are ordered numerically and unsafe paths ignored`() {
        val entries = parseGameBuildDirectories("""{"files":[{"type":"dir","name":"2.5.9/9","mtime":100},{"type":"dir","name":"2.5.10"},{"type":"dir","name":"../999"},{"type":"dir","name":"2.5.11/../999"},{"type":"file","name":"2.5.12"}]}""")
        assertEquals(listOf("2.5.10", "2.5.9"), entries.map { it.version }.sortedWith(GAME_VERSION_ORDER))
        assertEquals(9L, entries.first().buildNumber)
        assertEquals(123L, parseGameBuildDirectories("""{"files":[{"type":"dir","name":"123"}]}""", "2.5.10").single().buildNumber)
    }

    @Test fun `APK requires matching ready build identity and hash and never uses remote URLs`() {
        val root = "http://10.100.5.129:8000/ozdqp/Android/Debug/2.5.1/12/".toHttpUrl()
        fun parse(json: String) = parseVersionedGameApks(json, root, "Debug", "2.5.1", 12, 1234)
        val valid = parse(manifest()).single()
        assertEquals(root.toString() + "packages/game.apk", valid.downloadUrl)
        assertEquals("a".repeat(64), valid.expectedSha256)
        assertEquals("Debug", valid.configuration)
        assertEquals(12L, valid.buildNumber)
        for (bad in listOf(
            manifest("Release"), manifest(version = "2.5.2"), manifest(build = 13),
            manifest().replace("ready", "building"), manifest().replace("Android", "iOS"),
            manifest().replace("1002", "2004"), manifest().replace("packages/game.apk", "packages/../game.apk"),
            manifest().replace("a".repeat(64), "missing"), manifest().replace("game.apk", "game.aab"),
            manifest().replace("packages/game.apk", "hot-update/game.zip"), manifest(packages = ""),
        )) assertTrue(parse(bad).isEmpty())
    }

    @Test fun `live HTTP traversal skips resource-only builds and returns newest APKs for both configurations`() = runBlocking {
        val requests = Collections.synchronizedList(mutableListOf<String>())
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val uri = exchange.requestURI.toString()
            requests += uri
            val body = when (uri) {
                "/ozdqp/Android/Debug/?json=true" -> """{"files":[{"type":"dir","name":"2.5.10/14"},{"type":"dir","name":"2.5.9/13"}]}"""
                "/ozdqp/Android/Release/?json=true" -> """{"files":[{"type":"dir","name":"2.5.1"}]}"""
                "/ozdqp/Android/Release/2.5.1/?json=true" -> """{"files":[{"type":"dir","name":"12"}]}"""
                "/ozdqp/Android/Debug/2.5.10/14/build-info.json" -> manifest(version = "2.5.10", build = 14, packages = "")
                "/ozdqp/Android/Debug/2.5.9/13/build-info.json" -> manifest(version = "2.5.9", build = 13)
                "/ozdqp/Android/Release/2.5.1/12/build-info.json" -> manifest("Release")
                else -> null
            }
            val bytes = (body ?: "missing").toByteArray()
            exchange.sendResponseHeaders(if (body == null) 404 else 200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val items = GameApkCatalogClient("http://127.0.0.1:${server.address.port}/ozdqp/", OkHttpClient(), true).latest(1)
            assertEquals(listOf("Debug", "Release"), items.map { it.configuration })
            assertEquals(listOf("2.5.9", "2.5.1"), items.map { it.versionName })
            assertTrue(items.all { it.expectedSha256 != null && it.downloadUrl.endsWith("/packages/game.apk") })
            assertTrue(requests.none { it.startsWith("/apk/") || it.contains("iOS") || it.endsWith(".apk") })
        } finally { server.stop(0) }
    }
}
