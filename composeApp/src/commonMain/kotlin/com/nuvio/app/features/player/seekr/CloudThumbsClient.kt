package com.nuvio.app.features.player.seekr

import com.nuvio.app.features.mdblist.createMdbListHttpClient
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Client for the personal "nuvio-thumbs" GitHub repo: reads Seekr-style sprite sheets the
 * repo's Actions workflow generated from TorBox, and asks it to generate missing ones.
 */
internal object CloudThumbsClient {
    private const val API = "https://api.github.com"

    private val json = Json { ignoreUnknownKeys = true }
    private val http: HttpClient by lazy { createMdbListHttpClient() }
    private val ready = mutableMapOf<String, SeekPreviewTrack>()
    private val triggeredAt = mutableMapOf<String, Long>()
    private const val RETRIGGER_AFTER_MS = 10L * 60L * 1000L

    sealed interface Lookup {
        data class Ready(val track: SeekPreviewTrack) : Lookup
        data object Missing : Lookup
        data class Failed(val reason: String, val atEpochSec: Long) : Lookup
        data class Error(val message: String) : Lookup
    }

    @Serializable
    private data class Meta(@SerialName("source_duration_ms") val sourceDurationMs: Long = 0L)

    @Serializable
    data class Progress(val stage: String = "", val done: Int = 0, val total: Int = 0, val at: Long = 0L) {
        /** Short label, e.g. "extracting 120/292". */
        fun label(): String = if (total > 0) "$stage $done/$total" else stage
    }

    /** Live progress the generator publishes on the repo's "progress" branch, or null. */
    suspend fun progress(repo: String, token: String, key: String): Progress? = try {
        val name = key.replace('/', '_') + ".json"
        val response = http.get("$API/repos/$repo/contents/$name?ref=progress") {
            githubHeaders(token)
            header("Accept", "application/vnd.github.raw+json")
        }
        if (response.status.value == 200) json.decodeFromString(Progress.serializer(), response.bodyAsText()) else null
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        null
    }

    @Serializable
    private data class FailedMarker(val reason: String = "", val at: Long = 0L)

    /** Folder for a title inside the repo, matching scripts/generate.py. */
    fun keyFor(content: SeekrContent): String? = when (content) {
        is SeekrContent.Movie -> (content.imdbId ?: content.tmdbId?.let { "tmdb-$it" })?.let { "m/$it" }
        is SeekrContent.Episode -> (content.showImdbId ?: content.showTmdbId?.let { "tmdb-$it" })
            ?.let { "e/$it/${content.season}/${content.episode}" }
    }

    private fun contentIdFor(content: SeekrContent): String? = when (content) {
        is SeekrContent.Movie -> content.imdbId ?: content.tmdbId?.toString()
        is SeekrContent.Episode -> content.showImdbId ?: content.showTmdbId?.toString()
    }

    suspend fun lookup(repo: String, token: String, key: String, clientDurationMs: Long): Lookup {
        ready["$repo|$key"]?.let { return Lookup.Ready(it.rescaled(clientDurationMs)) }
        return try {
            val metaResponse = getRaw(repo, token, "thumbs/$key/meta.json")
            when (metaResponse.status.value) {
                200 -> {
                    val meta = json.decodeFromString(Meta.serializer(), metaResponse.bodyAsText())
                    val vttResponse = getRaw(repo, token, "thumbs/$key/index.vtt")
                    if (vttResponse.status.value != 200) return Lookup.Error("index missing")
                    // Load sprites through the same authenticated API path as meta.json/index.vtt
                    // (which demonstrably works), pinned to the exact commit so nothing is stale.
                    val ref = latestCommit(repo, token) ?: "HEAD"
                    val baseUrl = "$API/repos/$repo/contents/thumbs/$key/index.vtt"
                    val cues = SeekrVttParser.parse(vttResponse.bodyAsText(), baseUrl)
                        .map { it.copy(sheetUrl = it.sheetUrl + "?ref=" + ref) }
                    if (cues.isEmpty() || meta.sourceDurationMs <= 0L) return Lookup.Error("empty index")
                    val track = SeekPreviewTrack(
                        cues = cues,
                        scale = 1.0,
                        sourceDurationMs = meta.sourceDurationMs,
                        requestHeaders = mapOf(
                            "Authorization" to "Bearer $token",
                            "Accept" to "application/vnd.github.raw+json",
                            "X-GitHub-Api-Version" to "2022-11-28",
                            "User-Agent" to "nuvio-fork",
                        ),
                        sourceLabel = "CLOUD",
                    )
                    ready["$repo|$key"] = track
                    Lookup.Ready(track.rescaled(clientDurationMs))
                }
                404 -> {
                    val failed = getRaw(repo, token, "thumbs/$key/failed.json")
                    if (failed.status.value == 200) {
                        val marker = json.decodeFromString(FailedMarker.serializer(), failed.bodyAsText())
                        Lookup.Failed(marker.reason.ifBlank { "generation failed" }, marker.at)
                    } else {
                        Lookup.Missing
                    }
                }
                401, 403 -> Lookup.Error("token rejected")
                else -> Lookup.Error("HTTP ${metaResponse.status.value}")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Lookup.Error(t.message ?: "network error")
        }
    }

    /** Asks the repo's workflow to generate this title. At most once per title per app run. */
    suspend fun requestGeneration(
        repo: String,
        token: String,
        key: String,
        content: SeekrContent,
        clientDurationMs: Long,
        candidates: List<Candidate>,
    ): Boolean {
        val now = kotlin.time.Clock.System.now().toEpochMilliseconds()
        val last = triggeredAt["$repo|$key"]
        if (last != null && now - last < RETRIGGER_AFTER_MS) return true
        triggeredAt["$repo|$key"] = now
        val contentId = contentIdFor(content) ?: return false
        val body = buildJsonObject {
            put("event_type", "generate")
            putJsonObject("client_payload") {
                when (content) {
                    is SeekrContent.Movie -> put("kind", "movie")
                    is SeekrContent.Episode -> {
                        put("kind", "episode")
                        put("season", content.season.toString())
                        put("episode", content.episode.toString())
                    }
                }
                put("content_id", contentId)
                put("duration_ms", clientDurationMs.toString())
                // Releases for this title from the user's own addons, smallest first. The job adds
                // one to TorBox with its own key and requests its own link (nothing is shared).
                put("candidates", candidatesJson(candidates))
            }
        }
        return try {
            val response = http.post("$API/repos/$repo/dispatches") {
                githubHeaders(token)
                contentType(ContentType.Application.Json)
                setBody(body.toString())
            }
            val ok = response.status.value == 204
            if (!ok) triggeredAt.remove("$repo|$key")
            seekPreviewLog("cloud dispatch $key -> HTTP ${response.status.value}")
            ok
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            triggeredAt.remove("$repo|$key")
            seekPreviewLog("cloud dispatch failed: $t")
            false
        }
    }

    /** SHA of the default branch's latest commit, or null. */
    private suspend fun latestCommit(repo: String, token: String): String? = try {
        val response = http.get("$API/repos/$repo/commits/HEAD") {
            githubHeaders(token)
            header("Accept", "application/vnd.github.sha")
        }
        response.bodyAsText().trim().takeIf { response.status.value == 200 && it.length == 40 }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        null
    }

    /** A release the cloud job can fetch: torrent hash + size (+ file index when known). */
    data class Candidate(val hash: String, val size: Long, val fileIdx: Int?, val name: String)

    /**
     * Smallest releases from the title's stream list that have a torrent hash and a known size,
     * preferring ones Nuvio already confirmed cached on the user's debrid service.
     */
    fun candidatesFrom(streams: List<com.nuvio.app.features.streams.StreamItem>): List<Candidate> {
        val minSize = 200L * 1024 * 1024 // skip samples and extras
        return streams.mapNotNull { stream ->
            val hash = stream.p2pInfoHash ?: return@mapNotNull null
            val size = stream.behaviorHints.videoSize ?: stream.debridCacheStatus?.cachedSize ?: return@mapNotNull null
            if (size < minSize) return@mapNotNull null
            if (stream.debridCacheStatus?.state == com.nuvio.app.features.streams.StreamDebridCacheState.NOT_CACHED) {
                return@mapNotNull null
            }
            val cachedFirst = if (stream.debridCacheStatus?.state ==
                com.nuvio.app.features.streams.StreamDebridCacheState.CACHED) 0 else 1
            Triple(cachedFirst, size, Candidate(
                hash = hash.lowercase(),
                size = size,
                fileIdx = stream.p2pFileIdx,
                name = (stream.behaviorHints.filename ?: stream.title ?: stream.name ?: "").take(120),
            ))
        }
            .distinctBy { it.third.hash }
            .sortedWith(compareBy({ it.first }, { it.second }))
            .take(6)
            .map { it.third }
    }

    private fun candidatesJson(candidates: List<Candidate>): String =
        kotlinx.serialization.json.buildJsonArray {
            candidates.forEach { c ->
                add(kotlinx.serialization.json.buildJsonObject {
                    put("hash", c.hash)
                    put("size", c.size)
                    c.fileIdx?.let { put("file_idx", it) }
                    put("name", c.name)
                })
            }
        }.toString()

    private suspend fun getRaw(repo: String, token: String, path: String): HttpResponse =
        http.get("$API/repos/$repo/contents/$path") {
            githubHeaders(token)
            header("Accept", "application/vnd.github.raw+json")
        }

    private fun io.ktor.client.request.HttpRequestBuilder.githubHeaders(token: String) {
        header("Authorization", "Bearer $token")
        header("X-GitHub-Api-Version", "2022-11-28")
        header("User-Agent", "nuvio-fork")
    }
}
