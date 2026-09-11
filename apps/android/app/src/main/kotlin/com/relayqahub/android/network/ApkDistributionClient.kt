package com.relayqahub.android.network

import android.content.Context
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

enum class ApkArtifactKind {
    SELF_UPDATE,
    GAME,
}

data class ApkArtifact(
    val kind: ApkArtifactKind,
    val fileName: String,
    val displayName: String,
    val downloadUrl: String,
    val sizeBytes: Long,
    val modifiedAtEpochMs: Long? = null,
    val versionName: String? = null,
    val expectedSha256: String? = null,
    val expectedPackageName: String? = null,
    val expectedVersionCode: Long? = null,
    val configuration: String? = null,
    val buildNumber: Long? = null,
) {
    val id: String get() = downloadUrl
}

data class AndroidUpdateRelease(
    val versionCode: Long,
    val versionName: String,
    val packageName: String,
    val fileName: String,
    val sizeBytes: Long,
    val sha256: String,
    val downloadUrl: String,
) {
    fun asArtifact(): ApkArtifact = ApkArtifact(
        kind = ApkArtifactKind.SELF_UPDATE,
        fileName = fileName,
        displayName = "Relay QA Hub $versionName",
        downloadUrl = downloadUrl,
        sizeBytes = sizeBytes,
        versionName = versionName,
        expectedSha256 = sha256,
        expectedPackageName = packageName,
        expectedVersionCode = versionCode,
    )
}

data class DownloadedApk(
    val artifact: ApkArtifact,
    val file: File,
)

class ApkDistributionException(val code: String) : Exception(code)

class AndroidUpdateClient(
    apiBaseUrl: String,
    private val httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val feedUrl = QaHubRelativePath.resolve(
        QaHubApiEndpoint.parse(apiBaseUrl, allowPrivateHttp),
        "/android-updates/stable/latest.json",
    )

    suspend fun latest(): AndroidUpdateRelease = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(feedUrl)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache")
            .build()
        httpClient.newCall(request).execute().use { response ->
            if (response.code == 404) throw ApkDistributionException("UPDATE_NOT_PUBLISHED")
            if (!response.isSuccessful) throw ApkDistributionException("UPDATE_HTTP_${response.code}")
            val body = response.body ?: throw ApkDistributionException("UPDATE_EMPTY_BODY")
            val text = body.charStream().use { it.readText() }
            if (text.toByteArray(Charsets.UTF_8).size > MAX_UPDATE_METADATA_BYTES) {
                throw ApkDistributionException("UPDATE_METADATA_TOO_LARGE")
            }
            parseAndroidUpdateManifest(text, feedUrl)
        }
    }
}

class GameApkCatalogClient(
    directoryUrl: String,
    httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val httpClient = httpClient.newBuilder()
        .callTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val directoryUrl = parseControlledDistributionUrl(directoryUrl, allowPrivateHttp)
        .newBuilder()
        .query(null)
        .fragment(null)
        .apply { if (!directoryUrl.trim().substringBefore('?').endsWith('/')) addPathSegment("") }
        .build()

    suspend fun latest(limit: Int = 5): List<ApkArtifact> = withContext(Dispatchers.IO) {
        require(limit in 1..20)
        if (directoryUrl.encodedPath.trimEnd('/').endsWith("/apk")) {
            // Keep explicitly configured legacy feeds; the default never falls back to old APKs.
            return@withContext parseGameApkCatalog(readMetadata(directoryUrl.newBuilder()
                .addQueryParameter("json", "true").build())!!, directoryUrl, limit)
        }
        coroutineScope {
            listOf("Debug", "Release").map { configuration ->
                async { latestVersioned(configuration, limit) }
            }.awaitAll().flatten()
        }
    }

    private fun latestVersioned(configuration: String, limit: Int): List<ApkArtifact> {
        val base = directoryUrl.newBuilder().addPathSegment("Android")
            .addPathSegment(configuration).addPathSegment("").build()
        val entries = parseGameBuildDirectories(readMetadata(base.newBuilder()
            .addQueryParameter("json", "true").build())!!)
        val result = mutableListOf<ApkArtifact>()
        var inspectedBuilds = 0
        // A folded version/build directory and an ordinary version directory are both valid.
        for (version in entries.map { it.version }.distinct().sortedWith(GAME_VERSION_ORDER).take(100)) {
            val direct = entries.filter { it.version == version && it.buildNumber != null }
            val expanded = if (entries.any { it.version == version && it.buildNumber == null }) {
                val url = base.newBuilder().addPathSegment(version).addPathSegment("")
                    .addQueryParameter("json", "true").build()
                parseGameBuildDirectories(readMetadata(url)!!, version)
            } else emptyList()
            for (entry in (direct + expanded).distinctBy { it.buildNumber }
                .sortedByDescending { it.buildNumber }.take(100)) {
                val buildNumber = entry.buildNumber ?: continue
                if (++inspectedBuilds > 100) throw ApkDistributionException("GAME_APK_SCAN_LIMIT")
                val buildRoot = base.newBuilder().addPathSegment(version)
                    .addPathSegment(buildNumber.toString()).addPathSegment("").build()
                val metadata = readMetadata(buildRoot.newBuilder().addPathSegment("build-info.json").build(), optional = true)
                    ?: continue
                val artifacts = parseVersionedGameApks(metadata, buildRoot, configuration, version, buildNumber, entry.modifiedAt)
                result += artifacts
                if (result.size >= limit) return result.take(limit)
            }
        }
        return result
    }

    private fun readMetadata(url: HttpUrl, optional: Boolean = false): String? {
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache")
            .build()
        httpClient.newCall(request).execute().use { response ->
            if (optional && response.code == 404) return null
            if (!response.isSuccessful) throw ApkDistributionException("GAME_APK_HTTP_${response.code}")
            val body = response.body ?: throw ApkDistributionException("GAME_APK_EMPTY_BODY")
            val bytes = body.byteStream().use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (output.size() <= MAX_CATALOG_BYTES) {
                    val count = input.read(buffer, 0, minOf(buffer.size, MAX_CATALOG_BYTES + 1 - output.size()))
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            if (bytes.size > MAX_CATALOG_BYTES) {
                throw ApkDistributionException("GAME_APK_CATALOG_TOO_LARGE")
            }
            return bytes.toString(Charsets.UTF_8)
        }
    }
}

class ApkDownloadClient(
    context: Context,
    httpClient: OkHttpClient,
) {
    // These requests are GETs. Recover a pooled connection closed by the file server.
    private val httpClient = httpClient.newBuilder().retryOnConnectionFailure(true).build()
    private val downloadDirectory = File(context.filesDir, DOWNLOAD_DIRECTORY_NAME)

    suspend fun download(
        artifact: ApkArtifact,
        onProgress: (Int) -> Unit,
    ): DownloadedApk = withContext(Dispatchers.IO) {
        requireSafeApkFileName(artifact.fileName)
        if (artifact.sizeBytes !in 1..MAX_APK_BYTES) {
            throw ApkDistributionException("APK_SIZE_INVALID")
        }
        val downloadUrl = parseControlledDistributionUrl(artifact.downloadUrl, allowPrivateHttp = true)
        val request = Request.Builder()
            .url(downloadUrl)
            .header("Accept", "application/vnd.android.package-archive, application/octet-stream")
            .build()
        val directory = downloadDirectory.also { target ->
            if (!target.exists() && !target.mkdirs()) {
                throw ApkDistributionException("APK_DIRECTORY_UNAVAILABLE")
            }
        }
        val partial = File(directory, ".${UUID.randomUUID()}.partial")
        val destination = File(directory, artifact.fileName)
        try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ApkDistributionException("APK_DOWNLOAD_HTTP_${response.code}")
                }
                val body = response.body ?: throw ApkDistributionException("APK_DOWNLOAD_EMPTY_BODY")
                val declaredLength = body.contentLength()
                if (declaredLength > MAX_APK_BYTES ||
                    (declaredLength >= 0 && declaredLength != artifact.sizeBytes)
                ) {
                    throw ApkDistributionException("APK_DOWNLOAD_SIZE_MISMATCH")
                }
                val digest = MessageDigest.getInstance("SHA-256")
                var written = 0L
                var lastPercent = -1
                body.byteStream().use { input ->
                    FileOutputStream(partial).use { output ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            written += read
                            if (written > artifact.sizeBytes || written > MAX_APK_BYTES) {
                                throw ApkDistributionException("APK_DOWNLOAD_TOO_LARGE")
                            }
                            output.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            val percent = ((written * 100L) / artifact.sizeBytes).toInt().coerceIn(0, 100)
                            if (percent != lastPercent) {
                                lastPercent = percent
                                onProgress(percent)
                            }
                        }
                        output.fd.sync()
                    }
                }
                if (written != artifact.sizeBytes) {
                    throw ApkDistributionException("APK_DOWNLOAD_SIZE_MISMATCH")
                }
                val expectedSha256 = artifact.expectedSha256
                if (expectedSha256 != null && digest.digest().toHex() != expectedSha256.lowercase()) {
                    throw ApkDistributionException("APK_DOWNLOAD_HASH_MISMATCH")
                }
            }
            if (destination.exists() && !destination.delete()) {
                throw ApkDistributionException("APK_REPLACE_FAILED")
            }
            if (!partial.renameTo(destination)) {
                throw ApkDistributionException("APK_FINALIZE_FAILED")
            }
            onProgress(100)
            DownloadedApk(artifact, destination)
        } catch (error: Throwable) {
            partial.delete()
            throw error
        }
    }

    companion object {
        const val DOWNLOAD_DIRECTORY_NAME = "apk-downloads"
    }
}

internal fun parseAndroidUpdateManifest(
    json: String,
    feedUrl: HttpUrl,
): AndroidUpdateRelease {
    val root = runCatching { Json.parseToJsonElement(json).jsonObject }
        .getOrElse { throw ApkDistributionException("UPDATE_METADATA_INVALID") }
    if (root.strictLong("schemaVersion") != 1L) {
        throw ApkDistributionException("UPDATE_SCHEMA_UNSUPPORTED")
    }
    val versionCode = root.strictLong("versionCode")
    val versionName = root.strictString("versionName")
    val packageName = root.strictString("packageName")
    val fileName = root.strictString("fileName")
    val size = root.strictLong("size")
    val sha256 = root.strictString("sha256").lowercase()
    if (versionCode <= 0 || size !in 1..MAX_APK_BYTES) {
        throw ApkDistributionException("UPDATE_METADATA_INVALID")
    }
    if (!VERSION_NAME_PATTERN.matches(versionName) || !PACKAGE_NAME_PATTERN.matches(packageName)) {
        throw ApkDistributionException("UPDATE_METADATA_INVALID")
    }
    requireSafeApkFileName(fileName)
    if (!ANDROID_UPDATE_FILE_PATTERN.matches(fileName) || !SHA256_PATTERN.matches(sha256)) {
        throw ApkDistributionException("UPDATE_METADATA_INVALID")
    }
    val downloadUrl = feedUrl.newBuilder()
        .removePathSegment(feedUrl.pathSize - 1)
        .addPathSegment(fileName)
        .build()
    return AndroidUpdateRelease(
        versionCode = versionCode,
        versionName = versionName,
        packageName = packageName,
        fileName = fileName,
        sizeBytes = size,
        sha256 = sha256,
        downloadUrl = downloadUrl.toString(),
    )
}

internal fun parseGameApkCatalog(
    json: String,
    directoryUrl: HttpUrl,
    limit: Int,
): List<ApkArtifact> {
    val root = runCatching { Json.parseToJsonElement(json).jsonObject }
        .getOrElse { throw ApkDistributionException("GAME_APK_CATALOG_INVALID") }
    val files = root["files"] as? JsonArray
        ?: throw ApkDistributionException("GAME_APK_CATALOG_INVALID")
    return buildList {
        for (element in files) {
            val item = element as? JsonObject ?: continue
            if (item.stringOrNull("type") != "file") continue
            val name = item.stringOrNull("name") ?: continue
            if (!name.endsWith(".apk", ignoreCase = true) || isQaHubApk(name)) continue
            if (runCatching { requireSafeApkFileName(name) }.isFailure) continue
            val size = item.longOrNull("size") ?: continue
            val modified = item.longOrNull("mtime") ?: continue
            if (size !in 1..MAX_APK_BYTES || modified <= 0L) continue
            val downloadUrl = directoryUrl.newBuilder().addPathSegment(name).build().toString()
            add(
                ApkArtifact(
                    kind = ApkArtifactKind.GAME,
                    fileName = name,
                    displayName = name.removeSuffix(".apk"),
                    downloadUrl = downloadUrl,
                    sizeBytes = size,
                    modifiedAtEpochMs = modified,
                    versionName = GAME_VERSION_PATTERN.find(name)?.groupValues?.getOrNull(1),
                ),
            )
        }
    }.sortedByDescending { it.modifiedAtEpochMs }.take(limit)
}

private fun JsonObject.strictString(name: String): String {
    val value = this[name] as? JsonPrimitive
    val content = value?.takeIf { it.isString }?.contentOrNull
    if (content.isNullOrBlank()) throw ApkDistributionException("UPDATE_METADATA_INVALID")
    return content
}

private fun JsonObject.strictLong(name: String): Long {
    val value = this[name] as? JsonPrimitive
    return value?.takeIf { !it.isString }?.longOrNull
        ?: throw ApkDistributionException("UPDATE_METADATA_INVALID")
}

private fun JsonObject.stringOrNull(name: String): String? =
    (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.longOrNull(name: String): Long? =
    (this[name] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

private fun parseControlledDistributionUrl(value: String, allowPrivateHttp: Boolean): HttpUrl {
    val parsed = value.trim().toHttpUrl()
    require(parsed.username.isEmpty() && parsed.password.isEmpty()) {
        "APK distribution URL must not embed credentials"
    }
    require(parsed.fragment == null) { "APK distribution URL must not contain a fragment" }
    val privateHttp = parsed.scheme == "http" &&
        allowPrivateHttp &&
        QaHubApiEndpoint.isPrivateHttpHost(parsed.host)
    require(parsed.isHttps || privateHttp) {
        "APK distribution URL must use HTTPS or an explicitly enabled private HTTP address"
    }
    return parsed
}

internal fun requireSafeApkFileName(fileName: String) {
    require(fileName.length in 5..160)
    require(fileName.endsWith(".apk", ignoreCase = true))
    require('/' !in fileName && '\\' !in fileName)
    require(fileName.none { it.isISOControl() })
    require(fileName != "." && fileName != "..")
}

private fun isQaHubApk(name: String): Boolean =
    name.startsWith("Relay-QA-Hub-Android-", ignoreCase = true) ||
        name.startsWith("relay-qa-hub", ignoreCase = true)

private fun ByteArray.toHex(): String = joinToString(separator = "") { byte -> "%02x".format(byte) }

private const val MAX_UPDATE_METADATA_BYTES = 64 * 1024
private const val MAX_CATALOG_BYTES = 2 * 1024 * 1024
private const val MAX_APK_BYTES = 1024L * 1024L * 1024L
private val VERSION_NAME_PATTERN = Regex("^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")
private val PACKAGE_NAME_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
private val ANDROID_UPDATE_FILE_PATTERN =
    Regex("^Relay-QA-Hub-Android-[1-9][0-9]{0,9}-[0-9A-Za-z][0-9A-Za-z.+-]{0,63}\\.apk$")
private val GAME_VERSION_PATTERN = Regex("_(\\d+(?:\\.\\d+){1,3})_")
