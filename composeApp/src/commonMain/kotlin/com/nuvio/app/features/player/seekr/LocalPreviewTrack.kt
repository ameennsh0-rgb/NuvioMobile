package com.nuvio.app.features.player.seekr

import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs

/** Anything the seek bar can show previews from. */
internal sealed interface SeekPreviewSource

/**
 * On-device fallback for titles Seekr doesn't cover (e.g. regional films).
 *
 * Grabs small keyframe thumbnails straight from the stream being played:
 *  - on demand around wherever the user is scrubbing (highest priority),
 *  - plus an optional throttled background pass of roughly one frame per minute,
 *    paused while the player is buffering and (by default) only on unmetered networks.
 * Every frame is also written to a per-title disk cache, so rewatching is instant.
 */
internal class LocalPreviewTrack(
    private val grabber: PreviewFrameGrabber,
    val durationMs: Long,
    private val cacheKey: String,
    private val backgroundPassEnabled: () -> Boolean,
    private val playerBusy: () -> Boolean,
) : SeekPreviewSource {

    /** Spacing between thumbnails: at least 10s, at most [MAX_FRAMES] frames per title. */
    val intervalMs: Long = (durationMs / MAX_FRAMES).coerceAtLeast(MIN_INTERVAL_MS)
    private val bucketCount: Int = (durationMs / intervalMs).toInt() + 1
    private val diskKey = "$cacheKey@$intervalMs"

    private val frames = mutableStateMapOf<Int, ImageBitmap>()
    private val missing = HashSet<Int>()
    // All state is touched on the main dispatcher (the grabber hops to IO internally).
    private var pending: Int? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var lastTarget = 0
    private var consecutiveFailures = 0
    private var gaveUp = false
    private var job: Job? = null

    fun bucketFor(positionMs: Long): Int =
        (positionMs / intervalMs).toInt().coerceIn(0, bucketCount - 1)

    /** Best frame to show for [positionMs]: exact bucket, else the closest one already loaded. */
    fun frameNear(positionMs: Long): ImageBitmap? {
        val bucket = bucketFor(positionMs)
        frames[bucket]?.let { return it }
        for (d in 1..NEAR_SEARCH_BUCKETS) {
            frames[bucket - d]?.let { return it }
            frames[bucket + d]?.let { return it }
        }
        return null
    }

    /** Ask for previews around [positionMs]; newer requests replace older ones. */
    fun request(positionMs: Long) {
        val bucket = bucketFor(positionMs)
        if (bucket in frames && pending == null) return
        pending = bucket
        wake.trySend(Unit)
    }

    private fun takePending(): Int? = pending.also { pending = null }

    fun start(scope: CoroutineScope) {
        if (job != null) return
        job = scope.launch { workLoop() }
    }

    fun close() {
        job?.cancel()
        wake.close()
        grabber.close()
    }

    private suspend fun workLoop() {
        val stride = ((BACKGROUND_SPACING_MS + intervalMs - 1) / intervalMs).toInt().coerceAtLeast(1)
        var nextBackground = 0
        while (kotlinx.coroutines.currentCoroutineContext().isActive && !gaveUp) {
            val target = takePending()
            if (target != null) {
                serveAround(target)
                continue
            }
            val canBackground = nextBackground < bucketCount && backgroundPassEnabled() && !playerBusy()
            if (canBackground) {
                load(nextBackground)
                nextBackground += stride
                // Throttle so the background pass never competes with playback.
                delay(BACKGROUND_DELAY_MS)
                continue
            }
            if (nextBackground < bucketCount) {
                // Background pass paused (busy or metered): wake for scrubs or re-check later.
                kotlinx.coroutines.withTimeoutOrNull(BACKGROUND_DELAY_MS * 2) { wake.receiveCatching() }
            } else {
                if (wake.receiveCatching().isClosed) return
            }
        }
    }

    /** Target first, then neighbours outward, abandoning them as soon as the user scrubs elsewhere. */
    private suspend fun serveAround(target: Int) {
        lastTarget = target
        load(target)
        for (d in 1..PREFETCH_NEIGHBOURS) {
            if (pending != null || gaveUp) return
            load(target + d)
            if (pending != null || gaveUp) return
            load(target - d)
        }
    }

    private suspend fun load(bucket: Int) {
        if (bucket !in 0 until bucketCount || bucket in frames || bucket in missing) return
        val cached = PreviewFrameCache.load(diskKey, bucket)
        if (cached != null) {
            put(bucket, cached)
            return
        }
        val positionMs = (bucket * intervalMs + intervalMs / 2).coerceAtMost(durationMs - 1)
        val frame = try {
            grabber.grab(positionMs)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        if (frame == null) {
            missing += bucket
            // Unsupported codec / dead link: stop spending data on it.
            if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) gaveUp = true
            return
        }
        consecutiveFailures = 0
        put(bucket, frame)
        PreviewFrameCache.save(diskKey, bucket, frame)
    }

    private fun put(bucket: Int, frame: ImageBitmap) {
        frames[bucket] = frame
        if (frames.size > MAX_IN_MEMORY) {
            // Drop the frame farthest from where the user last scrubbed; it stays on disk.
            frames.keys.maxByOrNull { abs(it - lastTarget) }?.let { frames.remove(it) }
        }
    }

    companion object {
        const val MAX_FRAMES = 300L
        const val MIN_INTERVAL_MS = 10_000L
        const val BACKGROUND_SPACING_MS = 60_000L
        const val BACKGROUND_DELAY_MS = 1_500L
        const val PREFETCH_NEIGHBOURS = 2
        const val NEAR_SEARCH_BUCKETS = 6
        const val MAX_IN_MEMORY = 150
        const val MAX_CONSECUTIVE_FAILURES = 4

        /** Streams the platform frame grabber can read directly (no HLS/DASH, no torrents). */
        fun isEligible(url: String?, streamType: String?, isP2p: Boolean): Boolean {
            if (url.isNullOrBlank() || isP2p) return false
            if (!url.startsWith("http://") && !url.startsWith("https://")) return false
            val lowerUrl = url.lowercase().substringBefore('?')
            if (lowerUrl.endsWith(".m3u8") || lowerUrl.endsWith(".mpd") || "m3u8" in lowerUrl) return false
            val type = streamType?.lowercase().orEmpty()
            if ("hls" in type || "dash" in type || "youtube" in type) return false
            return isLocalSeekPreviewSupported()
        }
    }
}

/** Reads keyframes from a remote video. One instance per stream; calls are serialized. */
internal expect class PreviewFrameGrabber(url: String, headers: Map<String, String>) {
    suspend fun grab(positionMs: Long): ImageBitmap?
    fun close()
}

/** Per-title disk cache of generated thumbnails. */
internal expect object PreviewFrameCache {
    suspend fun load(key: String, bucket: Int): ImageBitmap?
    suspend fun save(key: String, bucket: Int, frame: ImageBitmap)
}

internal expect fun isLocalSeekPreviewSupported(): Boolean

/** True on Wi-Fi/Ethernet and other unmetered connections. */
internal expect fun isOnUnmeteredNetwork(): Boolean
