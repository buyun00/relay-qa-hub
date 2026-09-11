package com.relayqahub.android.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl

internal data class GameBuildDirectory(val version: String, val buildNumber: Long?, val modifiedAt: Long?)

private val versionPattern = Regex("^[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}$")
private val buildPattern = Regex("^[1-9][0-9]{0,9}$")
private val hashPattern = Regex("^[a-f0-9]{64}$")
internal val GAME_VERSION_ORDER = Comparator<String> { a, b ->
    val left = a.split('.').map(String::toLong)
    val right = b.split('.').map(String::toLong)
    (0..2).firstNotNullOfOrNull { i -> right[i].compareTo(left[i]).takeIf { it != 0 } } ?: 0
}

internal fun parseGameBuildDirectories(json: String, parentVersion: String? = null): List<GameBuildDirectory> {
    val root = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull()
    val files = root?.get("files") as? JsonArray
        ?: throw ApkDistributionException("GAME_APK_CATALOG_INVALID")
    return files.mapNotNull { raw ->
        val entry = raw as? JsonObject ?: return@mapNotNull null
        if (entry.text("type") != "dir") return@mapNotNull null
        val name = entry.text("name") ?: return@mapNotNull null
        val parts = name.split('/')
        val version = parentVersion ?: parts.first()
        if (!versionPattern.matches(version)) return@mapNotNull null
        val build = if (parentVersion == null) {
            if (parts.size !in 1..2) return@mapNotNull null
            parts.getOrNull(1)
        } else {
            if (parts.size != 1) return@mapNotNull null
            name
        }
        if (build != null && !buildPattern.matches(build)) return@mapNotNull null
        GameBuildDirectory(version, build?.toLong(), entry.number("mtime")?.takeIf { it > 0 })
    }
}

/** Derive URLs from the selected directory; never trust remote links or another build's identity. */
internal fun parseVersionedGameApks(
    json: String,
    buildRoot: HttpUrl,
    configuration: String,
    version: String,
    buildNumber: Long,
    modifiedAt: Long?,
): List<ApkArtifact> {
    val info = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return emptyList()
    val product = when (configuration) { "Debug" -> "2001"; "Release" -> "2002"; else -> return emptyList() }
    val target = info["expectedRuiXueTarget"] as? JsonObject ?: return emptyList()
    if (info.number("schemaVersion") != 1L || info.text("status") != "ready" ||
        info.text("platform") != "Android" || info.text("packageConfiguration") != configuration ||
        info.text("resourceConfiguration") != configuration || info.text("releaseVersion") != version ||
        info.number("buildNumber") != buildNumber || info.text("productId") != product || info.text("channelId") != "1002" ||
        target.text("productId") != product || target.text("channelId") != "1002" || target.text("version") != version ||
        !Regex("^[a-f0-9]{40}$").matches(info.text("sourceRevision") ?: "")
    ) return emptyList()
    val packages = info["packages"] as? JsonArray ?: return emptyList()
    return packages.mapNotNull { raw ->
        val file = raw as? JsonObject ?: return@mapNotNull null
        val relative = file.text("file") ?: return@mapNotNull null
        if (!Regex("^packages/[A-Za-z0-9][A-Za-z0-9._-]{0,230}\\.apk$").matches(relative) || relative.contains("..")) return@mapNotNull null
        val name = relative.removePrefix("packages/")
        if (runCatching { requireSafeApkFileName(name) }.isFailure) return@mapNotNull null
        val size = file.number("size") ?: return@mapNotNull null
        val hash = file.text("sha256") ?: return@mapNotNull null
        if (size !in 1..1024L * 1024L * 1024L || !hashPattern.matches(hash)) return@mapNotNull null
        ApkArtifact(
            kind = ApkArtifactKind.GAME,
            fileName = name,
            displayName = "$configuration · $version · #$buildNumber",
            downloadUrl = buildRoot.newBuilder().addPathSegment("packages").addPathSegment(name).build().toString(),
            sizeBytes = size,
            modifiedAtEpochMs = modifiedAt,
            versionName = version,
            expectedSha256 = hash,
            configuration = configuration,
            buildNumber = buildNumber,
        )
    }.distinctBy { it.downloadUrl }
}

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
private fun JsonObject.number(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
