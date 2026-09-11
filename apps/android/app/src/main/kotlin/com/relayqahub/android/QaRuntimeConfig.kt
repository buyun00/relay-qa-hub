package com.relayqahub.android

import android.content.Context
import com.relayqahub.android.network.QaHubApiEndpoint
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class QaRuntimeConfig(
    val schemaVersion: Int,
    val apiBaseUrl: String,
)

/**
 * Loads the phone-independent QA API address. This is intentionally separate
 * from Poco, whose socket remains fixed to this phone's 127.0.0.1.
 */
object QaRuntimeConfigLoader {
    const val FILE_NAME = "qa-runtime.json"
    private const val SCHEMA_VERSION = 1
    private const val MAX_CONFIG_BYTES = 16 * 1024
    private val json = Json {
        isLenient = false
        ignoreUnknownKeys = false
    }

    /** User-editable location: /Android/media/<package>/qa-hub/config/qa-runtime.json. */
    fun externalFile(context: Context): File? = context.getExternalMediaDirs()
        .firstOrNull()
        ?.let { File(it, "qa-hub/config/$FILE_NAME").canonicalFile }

    fun load(context: Context, buildDefaultApiBaseUrl: String): QaRuntimeConfig {
        val external = externalFile(context)
        if (external?.isFile == true) {
            require(external.length() <= MAX_CONFIG_BYTES) { "qa runtime config is too large" }
            return parse(external.readText(Charsets.UTF_8))
        }
        return seedConfig(context, buildDefaultApiBaseUrl)
    }

    fun parse(jsonText: String): QaRuntimeConfig {
        require(jsonText.toByteArray(Charsets.UTF_8).size <= MAX_CONFIG_BYTES) {
            "qa runtime config is too large"
        }
        val root = json.parseToJsonElement(jsonText).jsonObject
        require(root.keys == setOf("schemaVersion", "apiBaseUrl")) {
            "qa runtime config has unsupported fields"
        }
        require(root["schemaVersion"]?.jsonPrimitive?.intOrNull == SCHEMA_VERSION) {
            "qa runtime config schemaVersion is unsupported"
        }
        val configuredUrl = root["apiBaseUrl"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
        require(configuredUrl.isNotEmpty() && configuredUrl.length <= 2_048) {
            "qa runtime config apiBaseUrl is invalid"
        }
        val normalizedUrl = QaHubApiEndpoint.parse(
            baseUrl = configuredUrl,
            allowPrivateHttp = true,
        ).toString()
        val endpoint = java.net.URI(normalizedUrl)
        require(endpoint.port != 4319 && endpoint.host != "qa-hub.invalid") {
            "Preview requires a configured isolated API; production port 4319 is forbidden"
        }
        return QaRuntimeConfig(SCHEMA_VERSION, normalizedUrl)
    }

    fun ensureExternalSeed(context: Context, buildDefaultApiBaseUrl: String): File? {
        val target = externalFile(context) ?: return null
        if (target.exists()) return target

        val seed = seedConfig(context, buildDefaultApiBaseUrl)
        writeAtomically(target, serialize(seed), replaceExisting = false)
        return target
    }

    /**
     * Persists a validated endpoint for the next process start. This writes only
     * qa-runtime.json; Room databases, drafts, and offline queue files are not
     * touched when a user changes the server.
     */
    fun save(context: Context, apiBaseUrl: String): QaRuntimeConfig {
        val config = parse(
            "{\"schemaVersion\":$SCHEMA_VERSION,\"apiBaseUrl\":${JsonPrimitive(apiBaseUrl.trim())}}",
        )
        val target = externalFile(context)
            ?: error("QA Hub runtime configuration storage is unavailable")
        writeAtomically(target, serialize(config), replaceExisting = true)
        return config
    }

    internal fun serialize(config: QaRuntimeConfig): String = (
        "{\n" +
            "  \"schemaVersion\": ${config.schemaVersion},\n" +
            "  \"apiBaseUrl\": ${JsonPrimitive(config.apiBaseUrl)}\n" +
            "}\n"
        )

    private fun writeAtomically(target: File, content: String, replaceExisting: Boolean) {
        val bytes = content.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_CONFIG_BYTES)
        target.parentFile?.mkdirs()
        val temporary = File(target.parentFile, "${target.name}.tmp-${UUID.randomUUID()}")
        try {
            FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            try {
                if (replaceExisting) {
                    Files.move(
                        temporary.toPath(),
                        target.toPath(),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                } else {
                    Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
                }
            } catch (_: AtomicMoveNotSupportedException) {
                if (replaceExisting) {
                    Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                } else {
                    Files.move(temporary.toPath(), target.toPath())
                }
            }
        } finally {
            temporary.delete()
        }
    }

    private fun seedConfig(context: Context, buildDefaultApiBaseUrl: String): QaRuntimeConfig {
        val buildDefault = buildDefaultApiBaseUrl.trim()
        require(buildDefault.isNotEmpty()) { "Preview API configuration is required" }
        return parse("{\"schemaVersion\":1,\"apiBaseUrl\":${JsonPrimitive(buildDefault)}}")
    }
}
