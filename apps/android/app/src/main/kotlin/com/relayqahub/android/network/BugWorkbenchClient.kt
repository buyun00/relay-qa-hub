package com.relayqahub.android.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class BugWorkbenchClient(
    baseUrl: String,
    private val httpClient: OkHttpClient,
    allowPrivateHttp: Boolean = false,
) {
    private val apiBaseUrl: HttpUrl = QaHubApiEndpoint.parse(baseUrl, allowPrivateHttp)

    suspend fun listBugs(
        projectId: String,
        state: String? = null,
        limit: Int,
        accessToken: String,
        ownerId: String? = null,
        verificationOwnerId: String? = null,
        cursor: String? = null,
    ): BugWorkbenchResult = withContext(Dispatchers.IO) {
        require(STRICT_UUID_PATTERN.matches(projectId) && runCatching { UUID.fromString(projectId) }.isSuccess)
        state?.let { require(it in BUG_STATES) }
        ownerId?.let { require(STRICT_UUID_PATTERN.matches(it) && runCatching { UUID.fromString(it) }.isSuccess) }
        verificationOwnerId?.let {
            require(STRICT_UUID_PATTERN.matches(it) && runCatching { UUID.fromString(it) }.isSuccess)
        }
        cursor?.let { require(WORKBENCH_CURSOR_PATTERN.matches(it)) }
        require(limit in 1..MAX_ITEMS)
        require(accessToken.isNotBlank())
        val base = apiBaseUrl.resolve("bugs")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val url = base.newBuilder().apply {
            addQueryParameter("projectId", projectId)
            state?.let { addQueryParameter("state", it) }
            ownerId?.let { addQueryParameter("ownerId", it) }
            verificationOwnerId?.let { addQueryParameter("verificationOwnerId", it) }
            cursor?.let { addQueryParameter("cursor", it) }
            addQueryParameter("limit", limit.toString())
        }.build()
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (body.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                throw BugWorkbenchFailure("RESPONSE_TOO_LARGE")
            }
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val root = try {
                JSONObject(body)
            } catch (_: RuntimeException) {
                throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE")
            }
            if (root.keys().asSequence().toSet() != NATIVE_BUG_LIST_FIELDS) {
                throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE")
            }
            val snapshotSequence = root.requiredSnapshotSequence()
            val itemsJson = root.optJSONArray("items")
                ?: throw BugWorkbenchFailure("WORKBENCH_ITEMS_MISSING")
            if (itemsJson.length() > limit) {
                throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE")
            }
            val items = buildList {
                for (index in 0 until itemsJson.length()) {
                    val item = itemsJson.optJSONObject(index)
                        ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
                    val parsed = parseBug(item, expectedProjectId = projectId)
                    if (state != null && parsed.state != state) {
                        throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
                    }
                    add(parsed)
                }
            }
            val nextCursor = when {
                !root.has("nextCursor") ->
                    throw BugWorkbenchFailure("WORKBENCH_CURSOR_INVALID")
                root.isNull("nextCursor") -> null
                root.get("nextCursor") is String -> root.getString("nextCursor").also {
                    if (!WORKBENCH_CURSOR_PATTERN.matches(it)) {
                        throw BugWorkbenchFailure("WORKBENCH_CURSOR_INVALID")
                    }
                }
                else -> throw BugWorkbenchFailure("WORKBENCH_CURSOR_INVALID")
            }
            BugWorkbenchResult(
                snapshotSequence = snapshotSequence,
                items = items,
                nextCursor = nextCursor,
            )
        }
    }

    /** Loads the complete personal workbench from the owner and verifier indexes at one snapshot. */
    suspend fun listAssignedBugs(
        projectId: String,
        actorId: String,
        limitPerPage: Int,
        accessToken: String,
    ): BugWorkbenchResult = withContext(Dispatchers.IO) {
        require(STRICT_UUID_PATTERN.matches(actorId) && runCatching { UUID.fromString(actorId) }.isSuccess)
        val owned = listAssignmentPages(
            projectId = projectId,
            actorId = actorId,
            limitPerPage = limitPerPage,
            accessToken = accessToken,
            byVerificationOwner = false,
        )
        val verifying = listAssignmentPages(
            projectId = projectId,
            actorId = actorId,
            limitPerPage = limitPerPage,
            accessToken = accessToken,
            byVerificationOwner = true,
        )
        if (owned.snapshotSequence != verifying.snapshotSequence) {
            throw BugWorkbenchFailure("WORKBENCH_SNAPSHOT_CHANGED")
        }
        val merged = linkedMapOf<String, WorkbenchBug>()
        (owned.items + verifying.items).forEach { bug ->
            val previous = merged[bug.id]
            if (previous == null) {
                merged[bug.id] = bug
            } else {
                if (previous.withoutAssignmentProof() != bug.withoutAssignmentProof()) {
                    throw BugWorkbenchFailure("WORKBENCH_ITEM_CHANGED")
                }
                merged[bug.id] = previous.copy(
                    ownerAssignmentProof = previous.ownerAssignmentProof ?: bug.ownerAssignmentProof,
                    verifierAssignmentProof =
                        previous.verifierAssignmentProof ?: bug.verifierAssignmentProof,
                )
            }
        }
        BugWorkbenchResult(
            snapshotSequence = owned.snapshotSequence,
            items = merged.values.sortedWith(
                compareByDescending<WorkbenchBug> { it.updatedAt }
                    .thenByDescending { it.number }
                    .thenByDescending { it.id },
            ),
            nextCursor = null,
        )
    }

    /** Loads the complete project Bug index at one snapshot for an authorization recheck. */
    suspend fun listProjectBugs(
        projectId: String,
        limitPerPage: Int,
        accessToken: String,
    ): BugWorkbenchResult = withContext(Dispatchers.IO) {
        var cursor: String? = null
        var snapshotSequence: Long? = null
        val seenCursors = mutableSetOf<String>()
        val collected = linkedMapOf<String, WorkbenchBug>()
        repeat(MAX_WORKBENCH_PAGES) {
            val page = listBugs(
                projectId = projectId,
                limit = limitPerPage,
                accessToken = accessToken,
                cursor = cursor,
            )
            if (snapshotSequence == null) {
                snapshotSequence = page.snapshotSequence
            } else if (snapshotSequence != page.snapshotSequence) {
                throw BugWorkbenchFailure("WORKBENCH_SNAPSHOT_CHANGED")
            }
            page.items.forEach { bug ->
                val previous = collected.putIfAbsent(bug.id, bug)
                if (previous != null) {
                    throw BugWorkbenchFailure(
                        if (previous == bug) "WORKBENCH_ITEM_REPEATED" else "WORKBENCH_ITEM_CHANGED",
                    )
                }
                if (collected.size > MAX_PROJECT_ITEMS) {
                    throw BugWorkbenchFailure("WORKBENCH_ITEM_LIMIT_EXCEEDED")
                }
            }
            val next = page.nextCursor
                ?: return@withContext BugWorkbenchResult(
                    checkNotNull(snapshotSequence),
                    collected.values.toList(),
                    null,
                )
            if (!seenCursors.add(next)) {
                throw BugWorkbenchFailure("WORKBENCH_CURSOR_REPEATED")
            }
            cursor = next
        }
        throw BugWorkbenchFailure("WORKBENCH_PAGE_LIMIT_EXCEEDED")
    }

    private suspend fun listAssignmentPages(
        projectId: String,
        actorId: String,
        limitPerPage: Int,
        accessToken: String,
        byVerificationOwner: Boolean,
    ): BugWorkbenchResult {
        var cursor: String? = null
        var snapshotSequence: Long? = null
        val seenCursors = mutableSetOf<String>()
        val collected = linkedMapOf<String, WorkbenchBug>()
        repeat(MAX_WORKBENCH_PAGES) {
            val page = listBugs(
                projectId = projectId,
                state = null,
                limit = limitPerPage,
                accessToken = accessToken,
                ownerId = actorId.takeUnless { byVerificationOwner },
                verificationOwnerId = actorId.takeIf { byVerificationOwner },
                cursor = cursor,
            )
            if (snapshotSequence == null) {
                snapshotSequence = page.snapshotSequence
            } else if (snapshotSequence != page.snapshotSequence) {
                throw BugWorkbenchFailure("WORKBENCH_SNAPSHOT_CHANGED")
            }
            page.items.forEach { bug ->
                val proof = WorkbenchAssignmentProof(
                    projectId = projectId,
                    actorId = actorId,
                    snapshotSequence = page.snapshotSequence,
                )
                val assigned = if (byVerificationOwner) {
                    bug.copy(verifierAssignmentProof = proof)
                } else {
                    bug.copy(ownerAssignmentProof = proof)
                }
                val previous = collected.putIfAbsent(assigned.id, assigned)
                if (previous != null) {
                    throw BugWorkbenchFailure(
                        if (previous == assigned) "WORKBENCH_ITEM_REPEATED" else "WORKBENCH_ITEM_CHANGED",
                    )
                }
                if (collected.size > MAX_ASSIGNED_ITEMS) {
                    throw BugWorkbenchFailure("WORKBENCH_ITEM_LIMIT_EXCEEDED")
                }
            }
            val next = page.nextCursor
                ?: return BugWorkbenchResult(checkNotNull(snapshotSequence), collected.values.toList(), null)
            if (!seenCursors.add(next)) {
                throw BugWorkbenchFailure("WORKBENCH_CURSOR_REPEATED")
            }
            cursor = next
        }
        throw BugWorkbenchFailure("WORKBENCH_PAGE_LIMIT_EXCEEDED")
    }

    suspend fun getBug(
        bugId: String,
        accessToken: String,
    ): WorkbenchBug = withContext(Dispatchers.IO) {
        require(runCatching { UUID.fromString(bugId) }.isSuccess)
        require(accessToken.isNotBlank())
        val url = apiBaseUrl.resolve("bugs/$bugId")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = runCatching { httpClient.newCall(request).execute() }
            .getOrElse { throw BugWorkbenchFailure("NETWORK_IO") }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val item = runCatching { JSONObject(body) }
                .getOrElse { throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE") }
            parseBug(item, expectedProjectId = null)
        }
    }

    /** Reads the complete editable Bug projection, attachment metadata, and image previews. */
    suspend fun getBugDetail(
        bugId: String,
        accessToken: String,
    ): WorkbenchBugDetail = withContext(Dispatchers.IO) {
        val bug = getBug(bugId, accessToken)
        var imageErrorCode: String? = null
        val attachments = runCatching { listBugAttachments(bug, accessToken) }
            .getOrElse { failure ->
                imageErrorCode = failure.workbenchCode("ATTACHMENT_READ_FAILED")
                emptyList()
            }
        val images = attachments
            .filter { item ->
                item.mediaType.startsWith("image/", ignoreCase = true) &&
                    item.size <= MAX_DETAIL_IMAGE_BYTES
            }
            .take(MAX_DETAIL_IMAGES)
            .mapNotNull { item ->
            runCatching { downloadImage(item, accessToken) }
                .onFailure { failure ->
                    if (imageErrorCode == null) {
                        imageErrorCode = failure.workbenchCode("ATTACHMENT_READ_FAILED")
                    }
                }
                .getOrNull()
        }
        var moduleErrorCode: String? = null
        val modules = runCatching { listProjectModules(bug.projectId, accessToken) }
            .getOrElse { failure ->
                moduleErrorCode = failure.workbenchCode("MODULE_DIRECTORY_FAILED")
                emptyList()
            }
        WorkbenchBugDetail(
            bug = bug,
            attachments = attachments,
            images = images,
            modules = modules,
            imageErrorCode = imageErrorCode,
            moduleErrorCode = moduleErrorCode,
        )
    }

    suspend fun updateBug(
        request: WorkbenchBugUpdate,
        accessToken: String,
    ): WorkbenchBug = withContext(Dispatchers.IO) {
        require(runCatching { UUID.fromString(request.bugId) }.isSuccess)
        require(request.expectedVersion >= 1)
        require(request.title.isNotBlank() && request.title.length <= 300)
        require(request.description.isNotBlank() && request.description.length <= 20_000)
        require(request.expectedBehavior.isNotBlank() && request.expectedBehavior.length <= 10_000)
        require(request.severity in SEVERITIES)
        require(request.priority in PRIORITIES)
        request.moduleId?.let { require(runCatching { UUID.fromString(it) }.isSuccess) }
        request.ownerId?.let { require(runCatching { UUID.fromString(it) }.isSuccess) }
        request.verificationOwnerId?.let { require(runCatching { UUID.fromString(it) }.isSuccess) }
        require(request.attachmentIds.size <= MAX_ATTACHMENTS)
        require(request.attachmentIds.toSet().size == request.attachmentIds.size)
        require(request.attachmentIds.all { runCatching { UUID.fromString(it) }.isSuccess })
        require(accessToken.isNotBlank())

        val body = buildJsonObject {
            put("expectedVersion", request.expectedVersion)
            put("title", request.title.trim())
            put("description", request.description.trim())
            put("expectedBehavior", request.expectedBehavior.trim())
            put("moduleId", request.moduleId?.let(::JsonPrimitive) ?: JsonNull)
            put("severity", request.severity)
            put("priority", request.priority)
            put("ownerId", request.ownerId?.let(::JsonPrimitive) ?: JsonNull)
            put(
                "verificationOwnerId",
                request.verificationOwnerId?.let(::JsonPrimitive) ?: JsonNull,
            )
            put("attachmentIds", JsonArray(request.attachmentIds.map(::JsonPrimitive)))
        }.toString()
        val url = apiBaseUrl.resolve("bugs/${request.bugId}")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val httpRequest = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .header(
                "Idempotency-Key",
                "android:updateBug:bug:${request.bugId}:v${request.expectedVersion}:${request.mutationId}",
            )
            .patch(body.toRequestBody(QaHubApiContract.VERSIONED_JSON.toMediaType()))
            .build()
        val response = try {
            httpClient.newCall(httpRequest).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("NETWORK_IO")
        }
        response.use { result ->
            val responseBody = result.body?.byteStream()
                ?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(responseBody).optString("code") }
                    .getOrNull()
                    .orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "HTTP_${result.code}" })
            }
            val updated = runCatching { JSONObject(responseBody) }
                .getOrElse { throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE") }
                .let { parseBug(it, expectedProjectId = null) }
            if (
                updated.id != request.bugId ||
                updated.version != request.expectedVersion + 1
            ) {
                throw BugWorkbenchFailure("INVALID_WORKBENCH_RESPONSE")
            }
            updated
        }
    }

    private fun listBugAttachments(
        bug: WorkbenchBug,
        accessToken: String,
    ): List<WorkbenchBugAttachmentMetadata> {
        val base = apiBaseUrl.resolve("bugs/${bug.id}/attachments")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val request = Request.Builder()
            .url(base.newBuilder().addQueryParameter("limit", "20").build())
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("ATTACHMENT_NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "ATTACHMENT_HTTP_${result.code}" })
            }
            val root = runCatching { JSONObject(body) }
                .getOrElse { throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE") }
            if (root.optString("bugId") != bug.id || root.optString("projectId") != bug.projectId) {
                throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE")
            }
            val items = root.optJSONArray("items")
                ?: throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE")
            return buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index)
                        ?: throw BugWorkbenchFailure("INVALID_ATTACHMENT_RESPONSE")
                    val attachmentId = item.optString("attachmentId")
                    val filename = item.optString("filename")
                    val mediaType = item.optString("mediaType")
                    val size = item.optLong("size", -1L)
                    val sha256 = item.optString("sha256")
                    if (
                        runCatching { UUID.fromString(attachmentId) }.isFailure ||
                        filename.isBlank() || mediaType.isBlank() ||
                        size !in 1..MAX_ATTACHMENT_METADATA_BYTES ||
                        !SHA256_PATTERN.matches(sha256)
                    ) continue
                    add(WorkbenchBugAttachmentMetadata(attachmentId, filename, mediaType, size, sha256))
                }
            }.sortedWith(
                compareByDescending<WorkbenchBugAttachmentMetadata> {
                    it.filename.contains("annotated", ignoreCase = true)
                }.thenBy { it.filename },
            )
        }
    }

    private fun listProjectModules(
        projectId: String,
        accessToken: String,
    ): List<WorkbenchProjectModule> {
        val url = apiBaseUrl.resolve("projects/$projectId/modules")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", QaHubApiContract.JSON_ACCEPT)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("MODULE_NETWORK_IO")
        }
        response.use { result ->
            val body = result.body?.byteStream()?.use { it.readWorkbenchUtf8(MAX_RESPONSE_BYTES) }
                .orEmpty()
            if (result.code != 200) {
                val code = runCatching { JSONObject(body).optString("code") }.getOrNull().orEmpty()
                throw BugWorkbenchFailure(code.ifBlank { "MODULE_HTTP_${result.code}" })
            }
            val root = runCatching { JSONObject(body) }
                .getOrElse { throw BugWorkbenchFailure("INVALID_MODULE_RESPONSE") }
            if (root.optString("projectId") != projectId) {
                throw BugWorkbenchFailure("INVALID_MODULE_RESPONSE")
            }
            val items = root.optJSONArray("items")
                ?: throw BugWorkbenchFailure("INVALID_MODULE_RESPONSE")
            return buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index)
                        ?: throw BugWorkbenchFailure("INVALID_MODULE_RESPONSE")
                    val id = item.optString("id")
                    val itemProjectId = item.optString("projectId")
                    val name = item.optString("name")
                    if (
                        runCatching { UUID.fromString(id) }.isFailure ||
                        itemProjectId != projectId ||
                        name.isBlank()
                    ) throw BugWorkbenchFailure("INVALID_MODULE_RESPONSE")
                    add(
                        WorkbenchProjectModule(
                            id = id,
                            name = name,
                            active = item.optBoolean("active", false),
                        ),
                    )
                }
            }
        }
    }

    private fun downloadImage(
        metadata: WorkbenchBugAttachmentMetadata,
        accessToken: String,
    ): WorkbenchBugImage {
        val url = apiBaseUrl.resolve("attachments/${metadata.attachmentId}")
            ?: throw BugWorkbenchFailure("INVALID_WORKBENCH_PATH")
        val request = Request.Builder()
            .url(url)
            .header("Accept", metadata.mediaType)
            .header("Authorization", "Bearer $accessToken")
            .get()
            .build()
        val response = try {
            httpClient.newCall(request).execute()
        } catch (_: IOException) {
            throw BugWorkbenchFailure("ATTACHMENT_NETWORK_IO")
        }
        response.use { result ->
            if (result.code != 200) {
                throw BugWorkbenchFailure("ATTACHMENT_HTTP_${result.code}")
            }
            val bytes = result.body?.byteStream()?.use { it.readWorkbenchBytes(MAX_DETAIL_IMAGE_BYTES) }
                ?: throw BugWorkbenchFailure("ATTACHMENT_BODY_MISSING")
            if (bytes.size.toLong() != metadata.size || bytes.sha256Hex() != metadata.sha256) {
                throw BugWorkbenchFailure("ATTACHMENT_INTEGRITY_FAILED")
            }
            return WorkbenchBugImage(
                attachmentId = metadata.attachmentId,
                filename = metadata.filename,
                mediaType = metadata.mediaType,
                bytes = bytes,
            )
        }
    }

    private fun parseBug(item: JSONObject, expectedProjectId: String?): WorkbenchBug {
        if (item.keys().asSequence().toSet() != NATIVE_BUG_FIELDS) {
            throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
        }
        val bugId = item.workbenchRequiredUuid("id")
        val itemProjectId = item.workbenchRequiredUuid("projectId")
        val number = item.workbenchRequiredInt("number", 1)
        val key = item.workbenchRequiredString("key", allowBlank = false)
        val title = item.workbenchRequiredString("title", allowBlank = false)
        val description = item.workbenchRequiredString("description", allowBlank = false)
        val expectedBehavior = item.workbenchRequiredString("expectedBehavior", allowBlank = false)
        val moduleId = item.workbenchRequiredNullableUuid("moduleId")
        val itemState = item.workbenchRequiredString("state", allowBlank = false)
        val severity = item.workbenchRequiredString("severity", allowBlank = false)
        val priority = item.workbenchRequiredString("priority", allowBlank = false)
        val reporterId = item.workbenchRequiredUuid("reporterId")
        val ownerId = item.workbenchRequiredNullableUuid("ownerId")
        val verificationOwnerId = item.workbenchRequiredNullableUuid("verificationOwnerId")
        val duplicateOfBugId = item.workbenchRequiredNullableUuid("duplicateOfBugId")
        val occurrenceCount = item.workbenchRequiredInt("occurrenceCount", 1)
        val reopenCount = item.workbenchRequiredInt("reopenCount", 0)
        val version = item.workbenchRequiredInt("version", 1)
        val createdAt = item.workbenchRequiredTimestamp("createdAt")
        val updatedAt = item.workbenchRequiredTimestamp("updatedAt")
        val closedAt = item.workbenchRequiredNullableTimestamp("closedAt")
        if (
            (expectedProjectId != null && itemProjectId != expectedProjectId) ||
            itemState !in BUG_STATES || severity !in SEVERITIES || priority !in PRIORITIES ||
            !BUG_KEY_PATTERN.matches(key) || key.substringAfterLast('-').toIntOrNull() != number ||
            title.length > 300 || description.length > 20_000 || expectedBehavior.length > 10_000
        ) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
        return WorkbenchBug(
            id = bugId,
            projectId = itemProjectId,
            key = key,
            title = title,
            state = itemState,
            occurrenceCount = occurrenceCount,
            updatedAt = updatedAt,
            reporterId = reporterId,
            ownerId = ownerId,
            verificationOwnerId = verificationOwnerId,
            description = description,
            expectedBehavior = expectedBehavior,
            moduleId = moduleId,
            severity = severity,
            priority = priority,
            createdAt = createdAt,
            closedAt = closedAt,
            version = version,
            number = number,
            duplicateOfBugId = duplicateOfBugId,
            reopenCount = reopenCount,
        )
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 1024 * 1024
        const val MAX_ITEMS = 100
        const val MAX_WORKBENCH_PAGES = 100
        const val MAX_ASSIGNED_ITEMS = MAX_ITEMS * MAX_WORKBENCH_PAGES * 2
        const val MAX_PROJECT_ITEMS = MAX_ITEMS * MAX_WORKBENCH_PAGES
        const val MAX_DETAIL_IMAGES = 4
        const val MAX_DETAIL_IMAGE_BYTES = 24 * 1024 * 1024
        const val MAX_ATTACHMENT_METADATA_BYTES = 2L * 1024 * 1024 * 1024
        const val MAX_ATTACHMENTS = 20
        val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
        val WORKBENCH_CURSOR_PATTERN = Regex("^b1\\.[A-Za-z0-9_-]{1,400}\\.[A-Za-z0-9_-]{43}$")
        val SEVERITIES = setOf("S0", "S1", "S2", "S3", "S4")
        val PRIORITIES = setOf("P0", "P1", "P2", "P3", "P4")
        val BUG_STATES = setOf(
            "reported",
            "needs_info",
            "ready",
            "in_progress",
            "awaiting_build",
            "ready_for_verification",
            "closed",
            "deferred",
            "rejected",
            "duplicate",
        )
        val BUG_KEY_PATTERN = Regex("^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]*$")
        val NATIVE_BUG_FIELDS = setOf(
            "id", "projectId", "number", "key", "title", "description", "expectedBehavior",
            "moduleId", "state", "severity", "priority", "reporterId", "ownerId",
            "verificationOwnerId", "duplicateOfBugId", "occurrenceCount", "reopenCount",
            "version", "createdAt", "updatedAt", "closedAt",
        )
        val NATIVE_BUG_LIST_FIELDS = setOf("snapshotSequence", "items", "nextCursor")
    }
}

/**
 * Proof that the server's scoped assignment index matched this Bug for the current actor. The
 * assigned UUID may be a canonical identity alias, so callers must use this proof rather than
 * comparing the response field directly with [actorId].
 */
data class WorkbenchAssignmentProof(
    val projectId: String,
    val actorId: String,
    val snapshotSequence: Long,
)

data class WorkbenchBug(
    val id: String,
    val projectId: String,
    val key: String,
    val title: String,
    val state: String,
    val occurrenceCount: Int,
    val updatedAt: String,
    val reporterId: String = "",
    val ownerId: String? = null,
    val verificationOwnerId: String? = null,
    val description: String = "",
    val expectedBehavior: String = "",
    val moduleId: String? = null,
    val severity: String = "",
    val priority: String = "",
    val createdAt: String = "",
    val closedAt: String? = null,
    val version: Int = 1,
    val number: Int = 0,
    val duplicateOfBugId: String? = null,
    val reopenCount: Int = 0,
    val ownerAssignmentProof: WorkbenchAssignmentProof? = null,
    val verifierAssignmentProof: WorkbenchAssignmentProof? = null,
)

internal fun WorkbenchBug.hasVerifierAssignmentProof(
    expectedProjectId: String,
    expectedActorId: String,
    expectedSnapshotSequence: Long,
): Boolean = verifierAssignmentProof == WorkbenchAssignmentProof(
    projectId = expectedProjectId,
    actorId = expectedActorId,
    snapshotSequence = expectedSnapshotSequence,
) && projectId == expectedProjectId

internal fun WorkbenchBug.hasOwnerAssignmentProof(
    expectedProjectId: String,
    expectedActorId: String,
    expectedSnapshotSequence: Long,
): Boolean = ownerId != null && ownerAssignmentProof == WorkbenchAssignmentProof(
    projectId = expectedProjectId,
    actorId = expectedActorId,
    snapshotSequence = expectedSnapshotSequence,
) && projectId == expectedProjectId

private fun WorkbenchBug.withoutAssignmentProof(): WorkbenchBug = copy(
    ownerAssignmentProof = null,
    verifierAssignmentProof = null,
)

internal fun WorkbenchBug.inheritAssignmentProofIfSameProjection(
    source: WorkbenchBug?,
): WorkbenchBug = if (
    source != null && withoutAssignmentProof() == source.withoutAssignmentProof()
) {
    copy(
        ownerAssignmentProof = source.ownerAssignmentProof,
        verifierAssignmentProof = source.verifierAssignmentProof,
    )
} else {
    this
}

data class WorkbenchBugAttachmentMetadata(
    val attachmentId: String,
    val filename: String,
    val mediaType: String,
    val size: Long,
    val sha256: String,
)

data class WorkbenchProjectModule(
    val id: String,
    val name: String,
    val active: Boolean,
)

data class WorkbenchBugImage(
    val attachmentId: String,
    val filename: String,
    val mediaType: String,
    val bytes: ByteArray,
)

data class WorkbenchBugDetail(
    val bug: WorkbenchBug,
    val attachments: List<WorkbenchBugAttachmentMetadata>,
    val images: List<WorkbenchBugImage>,
    val modules: List<WorkbenchProjectModule>,
    val imageErrorCode: String? = null,
    val moduleErrorCode: String? = null,
)

data class WorkbenchBugUpdate(
    val bugId: String,
    val expectedVersion: Int,
    val mutationId: String,
    val title: String,
    val description: String,
    val expectedBehavior: String,
    val moduleId: String?,
    val severity: String,
    val priority: String,
    val ownerId: String?,
    val verificationOwnerId: String?,
    val attachmentIds: List<String>,
)

data class BugWorkbenchResult(
    val snapshotSequence: Long,
    val items: List<WorkbenchBug>,
    val nextCursor: String?,
)

class BugWorkbenchFailure(val code: String) : RuntimeException()

private fun JSONObject.requiredSnapshotSequence(): Long {
    if (!has("snapshotSequence")) throw BugWorkbenchFailure("WORKBENCH_SNAPSHOT_INVALID")
    val value = when (val raw = get("snapshotSequence")) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> throw BugWorkbenchFailure("WORKBENCH_SNAPSHOT_INVALID")
    }
    if (value !in 0..9_007_199_254_740_991L) {
        throw BugWorkbenchFailure("WORKBENCH_SNAPSHOT_INVALID")
    }
    return value
}

private fun JSONObject.workbenchRequiredString(key: String, allowBlank: Boolean): String {
    if (!has(key) || isNull(key) || get(key) !is String) {
        throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
    }
    return getString(key).also {
        if (!allowBlank && it.isBlank()) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
    }
}

private fun JSONObject.workbenchRequiredUuid(key: String): String =
    workbenchRequiredString(key, allowBlank = false).also {
        if (!STRICT_UUID_PATTERN.matches(it) || runCatching { UUID.fromString(it) }.isFailure) {
            throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
        }
    }

private fun JSONObject.workbenchRequiredNullableUuid(key: String): String? {
    if (!has(key)) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
    if (isNull(key)) return null
    return workbenchRequiredUuid(key)
}

private fun JSONObject.workbenchRequiredInt(key: String, minimum: Int): Int {
    if (!has(key) || get(key) !is Int) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
    return getInt(key).also {
        if (it < minimum) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
    }
}

private fun JSONObject.workbenchRequiredTimestamp(key: String): String =
    workbenchRequiredString(key, allowBlank = false).also {
        if (runCatching { OffsetDateTime.parse(it) }.isFailure) {
            throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
        }
    }

private fun JSONObject.workbenchRequiredNullableTimestamp(key: String): String? {
    if (!has(key)) throw BugWorkbenchFailure("INVALID_WORKBENCH_ITEM")
    if (isNull(key)) return null
    return workbenchRequiredTimestamp(key)
}

private fun InputStream.readWorkbenchUtf8(maxBytes: Int): String {
    val output = ByteArrayOutputStream(minOf(maxBytes, 8 * 1024))
    val buffer = ByteArray(8 * 1024)
    var total = 0
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        output.write(buffer, 0, read)
        if (total > maxBytes) break
    }
    return output.toByteArray().toString(Charsets.UTF_8)
}

private fun InputStream.readWorkbenchBytes(maxBytes: Int): ByteArray {
    val output = ByteArrayOutputStream(minOf(maxBytes, 64 * 1024))
    val buffer = ByteArray(16 * 1024)
    var total = 0
    while (true) {
        val read = read(buffer)
        if (read < 0) break
        total += read
        if (total > maxBytes) throw BugWorkbenchFailure("ATTACHMENT_TOO_LARGE")
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}

private fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
    .digest(this)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private fun Throwable.workbenchCode(fallback: String): String =
    (this as? BugWorkbenchFailure)?.code ?: fallback

private val STRICT_UUID_PATTERN = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)
