package com.nuvio.app.features.player.seekr

import com.nuvio.app.features.mdblist.createMdbListHttpClient
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Minimal client for the Seekr seek-preview API (https://seekr.tv/docs).
 *
 * One lookup per title returns a signed WebVTT file whose cues point at 320x180 tiles
 * inside JPEG sprite sheets. The VTT and the sheets need no API key.
 */
internal object SeekrClient {
    private const val API_BASE = "https://api.seekr.tv"
    private const val SPRITES_BASE = "https://sprites.seekr.tv"

    private val json = Json { ignoreUnknownKeys = true }
    private val http: HttpClient by lazy { createMdbListHttpClient() }

    /** In-memory cache so re-opening the controls or reconfiguring doesn't re-spend quota. */
    private val cache = mutableMapOf<String, CachedTrack>()
    private const val CACHE_TTL_MS = 4L * 60L * 60L * 1000L // signed URLs live 6h

    private class CachedTrack(val track: SeekPreviewTrack, val fetchedAtMs: Long)

    @Serializable
    private data class LookupResponse(
        @SerialName("vtt_url") val vttUrl: String,
        @SerialName("source_duration_ms") val sourceDurationMs: Long = 0L,
        val scale: Double = 1.0,
    )

    suspend fun loadTrack(
        apiKey: String,
        content: SeekrContent,
        durationMs: Long,
    ): SeekPreviewTrack? {
        if (apiKey.isBlank() || durationMs <= 0L) return null
        val cacheKey = "${content.cacheKey}|$durationMs"
        val now = kotlin.time.Clock.System.now().toEpochMilliseconds()
        cache[cacheKey]?.let { cached ->
            if (now - cached.fetchedAtMs < CACHE_TTL_MS) return cached.track
        }

        return try {
            val lookup = http.get("$API_BASE/sprites") {
                header("X-API-Key", apiKey.trim())
                parameter("duration_ms", durationMs)
                when (content) {
                    is SeekrContent.Movie -> {
                        content.imdbId?.let { parameter("imdb_id", it) }
                        content.tmdbId?.let { parameter("tmdb_id", it) }
                    }
                    is SeekrContent.Episode -> {
                        content.showImdbId?.let { parameter("show_imdb_id", it) }
                        content.showTmdbId?.let { parameter("show_tmdb_id", it) }
                        parameter("season", content.season)
                        parameter("episode", content.episode)
                    }
                }
            }
            if (!lookup.status.isSuccess()) return null
            val body = json.decodeFromString(LookupResponse.serializer(), lookup.bodyAsText())

            val vttUrl = absolutize(body.vttUrl)
            val vttResponse = http.get(vttUrl)
            if (!vttResponse.status.isSuccess()) return null
            val cues = SeekrVttParser.parse(vttResponse.bodyAsText(), baseUrl = vttUrl)
            if (cues.isEmpty()) return null

            SeekPreviewTrack(
                cues = cues,
                scale = body.scale.takeIf { it > 0.0 } ?: 1.0,
            ).also { cache[cacheKey] = CachedTrack(it, now) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
    }

    private fun absolutize(url: String): String = when {
        url.startsWith("http://") || url.startsWith("https://") -> url
        url.startsWith("/") -> SPRITES_BASE + url
        else -> "$SPRITES_BASE/$url"
    }
}

/** What to ask Seekr for. */
internal sealed interface SeekrContent {
    val cacheKey: String

    data class Movie(val tmdbId: Int?, val imdbId: String?) : SeekrContent {
        override val cacheKey: String get() = "m:${imdbId ?: tmdbId}"
    }

    data class Episode(
        val showTmdbId: Int?,
        val showImdbId: String?,
        val season: Int,
        val episode: Int,
    ) : SeekrContent {
        override val cacheKey: String get() = "e:${showImdbId ?: showTmdbId}:$season:$episode"
    }
}

/**
 * Maps a Nuvio meta id (e.g. "tt0133093", "tmdb:603", "tt0944947:1:2") to Seekr content.
 * Ported from the Seekr NuvioTV fork's SeekrContentMapping.
 */
internal fun seekrContentFor(
    contentId: String?,
    contentType: String?,
    season: Int?,
    episode: Int?,
): SeekrContent? {
    val baseId = contentId
        ?.removePrefix("tmdb:")
        ?.removePrefix("movie:")
        ?.removePrefix("series:")
        ?.substringBefore(':')
        ?.substringBefore('/')
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: return null

    val imdbId = baseId.takeIf { it.startsWith("tt") }
    val tmdbId = baseId.toIntOrNull()
    if (imdbId == null && tmdbId == null) return null

    val isSeries = contentType?.lowercase() in setOf("series", "tv", "show", "anime")
    return if (isSeries && season != null && episode != null) {
        SeekrContent.Episode(showTmdbId = tmdbId, showImdbId = imdbId, season = season, episode = episode)
    } else {
        SeekrContent.Movie(tmdbId = tmdbId, imdbId = imdbId)
    }
}
