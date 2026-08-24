package com.relayqahub.android.network

import okhttp3.HttpUrl

object QaHubRelativePath {
    private val binaryUploadChunkPath =
        Regex("^/uploads/[^/]+/chunks/(?:0|[1-9][0-9]*)$")

    fun requireValid(relativePath: String): String = relativePath.also { path ->
        require(path.startsWith('/') && !path.startsWith("//")) {
            "Queued paths must have exactly one leading slash"
        }
        require(path.length > 1)
        require(path.none(Char::isWhitespace))
        require(path.none { it.isISOControl() })
        require('\\' !in path && '?' !in path && '#' !in path && '%' !in path)
        require("://" !in path)
        require(path.removePrefix("/").split('/').all { segment ->
            segment.isNotEmpty() && segment != "." && segment != ".."
        })
    }

    fun resolve(apiBaseUrl: HttpUrl, relativePath: String): HttpUrl {
        val path = requireValid(relativePath)
        val resolved = apiBaseUrl.resolve(path.removePrefix("/"))
            ?: throw IllegalArgumentException("Invalid relative QA Hub path")
        require(resolved.scheme == apiBaseUrl.scheme)
        require(resolved.host == apiBaseUrl.host)
        require(resolved.port == apiBaseUrl.port)
        require(resolved.username.isEmpty() && resolved.password.isEmpty())
        require(resolved.query == null && resolved.fragment == null)
        require(resolved.encodedPath.startsWith(apiBaseUrl.encodedPath))
        return resolved
    }

    fun isBinaryUploadChunk(relativePath: String): Boolean =
        binaryUploadChunkPath.matches(requireValid(relativePath))
}
