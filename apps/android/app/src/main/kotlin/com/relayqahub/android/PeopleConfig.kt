package com.relayqahub.android

import android.content.Context
import android.os.Environment
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * The only people source used by the field client.  The external file is
 * intentionally outside the APK so a QA team can replace it without adding a
 * people-management screen to the phone app.
 */
data class QaPerson(
    val id: String,
    val displayName: String,
    val roles: Set<QaPersonRole>,
    val active: Boolean,
)

enum class QaPersonRole {
    FIXER,
    VERIFIER,
}

data class QaPeopleConfig(
    val schemaVersion: Int,
    val projectKey: String,
    val people: List<QaPerson>,
) {
    val activeFixers: List<QaPerson>
        get() = people.filter { it.active && QaPersonRole.FIXER in it.roles }

    val activeVerifiers: List<QaPerson>
        get() = people.filter { it.active && QaPersonRole.VERIFIER in it.roles }
}

object QaPeopleConfigLoader {
    const val FILE_NAME = "qa-people.json"
    const val CONFIG_PROJECT_KEY = "LOCAL"
    private const val SCHEMA_VERSION = 1
    private const val MAX_CONFIG_BYTES = 128 * 1024
    private const val MAX_PEOPLE = 200

    /** User-editable location: /Android/media/<package>/qa-hub/config/qa-people.json. */
    fun externalFile(context: Context): File? = context.getExternalMediaDirs()
        .firstOrNull()
        ?.let { File(it, "qa-hub/config/$FILE_NAME").canonicalFile }

    fun load(context: Context): QaPeopleConfig {
        val external = externalFile(context)
        val externalJson = external?.takeIf(File::isFile)?.let { file ->
            runCatching { file.readText(Charsets.UTF_8) }.getOrNull()
        }
        val jsonText = externalJson ?: context.assets.open(FILE_NAME).use { input ->
            require(input.available() <= MAX_CONFIG_BYTES) { "qa people config is too large" }
            input.readBytes().toString(Charsets.UTF_8)
        }
        return parse(jsonText)
    }

    fun parse(jsonText: String): QaPeopleConfig {
        require(jsonText.toByteArray(Charsets.UTF_8).size <= MAX_CONFIG_BYTES) {
            "qa people config is too large"
        }
        val root = JSONObject(jsonText)
        require(root.length() == 3) { "qa people config has unsupported fields" }
        require(root.optInt("schemaVersion", -1) == SCHEMA_VERSION) {
            "qa people config schemaVersion is unsupported"
        }
        val projectKey = root.optString("projectKey").trim()
        require(projectKey.isNotEmpty() && projectKey.length <= 100) {
            "qa people config projectKey is invalid"
        }
        val peopleJson = root.optJSONArray("people") ?: error("qa people config people missing")
        require(peopleJson.length() <= MAX_PEOPLE) { "qa people config has too many people" }
        val ids = mutableSetOf<String>()
        val people = buildList {
            for (index in 0 until peopleJson.length()) {
                val item = peopleJson.optJSONObject(index)
                    ?: error("qa people config people[$index] must be an object")
                require(item.length() == 4) { "qa people config people[$index] has unsupported fields" }
                val id = item.optString("id").trim()
                val displayName = item.optString("displayName").trim()
                require(id.isNotEmpty() && id.length <= 100) { "person id is invalid" }
                require(displayName.isNotEmpty() && displayName.length <= 100) {
                    "person displayName is invalid"
                }
                require(ids.add(id)) { "person id is duplicated" }
                val rolesJson = item.optJSONArray("roles")
                    ?: error("person roles is missing")
                require(rolesJson.length() in 1..2) { "person roles is invalid" }
                val roles = buildSet {
                    for (roleIndex in 0 until rolesJson.length()) {
                        add(
                            when (rolesJson.optString(roleIndex)) {
                                "fixer" -> QaPersonRole.FIXER
                                "verifier" -> QaPersonRole.VERIFIER
                                else -> error("person role is unsupported")
                            },
                        )
                    }
                }
                add(
                    QaPerson(
                        id = id,
                        displayName = displayName,
                        roles = roles,
                        active = item.optBoolean("active", false),
                    ),
                )
            }
        }
        return QaPeopleConfig(SCHEMA_VERSION, projectKey, people)
    }

    fun ensureExternalSeed(context: Context): File? {
        val target = externalFile(context) ?: return null
        if (!target.exists()) {
            target.parentFile?.mkdirs()
            context.assets.open(FILE_NAME).use { input -> target.outputStream().use(input::copyTo) }
        }
        return target
    }
}
