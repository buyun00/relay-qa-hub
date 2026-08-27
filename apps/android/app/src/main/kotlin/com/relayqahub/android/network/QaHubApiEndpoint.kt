package com.relayqahub.android.network

import java.net.Inet6Address
import java.net.InetAddress
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * Single validation boundary for every native QA Hub HTTP client.
 *
 * HTTPS may use a DNS name or IP address. Plain HTTP is deliberately narrower:
 * callers must opt in and the host must be a literal loopback/private/link-local
 * address. Refusing DNS names for cleartext avoids silently treating a public
 * hostname as an internal endpoint after DNS changes.
 */
object QaHubApiEndpoint {
    const val API_BASE_PATH = "/api/v1/"

    fun parse(baseUrl: String, allowPrivateHttp: Boolean = false): HttpUrl {
        val parsed = baseUrl.trim().toHttpUrl()
        require(parsed.username.isEmpty() && parsed.password.isEmpty()) {
            "QA Hub API base URL must not embed credentials"
        }
        require(parsed.query == null && parsed.fragment == null) {
            "QA Hub API base URL must not contain a query or fragment"
        }
        val privateHttp = parsed.scheme == "http" &&
            allowPrivateHttp &&
            isPrivateHttpHost(parsed.host)
        require(parsed.isHttps || privateHttp) {
            "QA Hub API base URL must use HTTPS or an explicitly enabled private HTTP address"
        }
        val normalized = parsed.newBuilder().apply {
            if (!parsed.encodedPath.endsWith('/')) addPathSegment("")
        }.build()
        require(normalized.encodedPath == API_BASE_PATH) {
            "QA Hub API base URL must use the frozen $API_BASE_PATH path"
        }
        return normalized
    }

    internal fun isPrivateHttpHost(host: String): Boolean {
        if (host.equals("localhost", ignoreCase = true)) return true
        val address = when {
            IPV4_LITERAL.matches(host) -> parseIpv4(host) ?: return false
            ':' in host -> runCatching { InetAddress.getByName(host) }.getOrNull() ?: return false
            else -> return false
        }
        return address.isLoopbackAddress ||
            address.isSiteLocalAddress ||
            address.isLinkLocalAddress ||
            (address is Inet6Address && (address.address[0].toInt() and 0xfe) == 0xfc)
    }

    private fun parseIpv4(host: String): InetAddress? {
        val octets = host.split('.').map { it.toIntOrNull() ?: return null }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return null
        return InetAddress.getByAddress(ByteArray(4) { index -> octets[index].toByte() })
    }

    private val IPV4_LITERAL = Regex("^[0-9]{1,3}(?:\\.[0-9]{1,3}){3}$")
}
