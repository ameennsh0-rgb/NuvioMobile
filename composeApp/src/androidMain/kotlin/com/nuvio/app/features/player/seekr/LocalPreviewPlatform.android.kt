package com.nuvio.app.features.player.seekr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.ConnectivityManager
import android.os.Build
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.nuvio.app.features.player.PlayerSettingsStorage
import `is`.xyz.mpv.MPV
import `is`.xyz.mpv.MPVNode
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

private const val THUMB_WIDTH = 320
private const val THUMB_HEIGHT = 180

/**
 * Decodes thumbnails with a hidden, software-only mpv instance (FFmpeg), so it works for
 * HEVC / 10-bit files the device's hardware decoders can't hand to MediaMetadataRetriever,
 * and never competes with the player for the hardware decoder.
 * Falls back to MediaMetadataRetriever only if mpv can't start.
 */
internal actual class PreviewFrameGrabber actual constructor(
    private val url: String,
    private val headers: Map<String, String>,
) {
    private val lock = Mutex()
    @Volatile private var closed = false
    private var mpvGrabber: MpvThumbnailer? = null
    private var mpvFailed = false
    private var mpvSucceeded = false
    private var mpvMisses = 0
    private var retriever: MediaMetadataRetriever? = null
    private var retrieverFailed = false

    actual suspend fun grab(positionMs: Long): ImageBitmap? = withContext(Dispatchers.IO) {
        lock.withLock {
            if (closed) return@withLock null
            if (!mpvFailed) {
                val mpv = mpvGrabber ?: openMpv()
                if (mpv != null) {
                    val frame = mpv.grab(positionMs)
                    if (frame != null) {
                        mpvSucceeded = true
                        return@withLock shrink(frame).asImageBitmap()
                    }
                    // mpv never produced a frame for this stream: try the Android extractor instead.
                    if (!mpvSucceeded && ++mpvMisses >= 2) {
                        seekPreviewLog("mpv produced no frames; switching to Android extractor")
                        mpv.close()
                        mpvGrabber = null
                        mpvFailed = true
                    } else {
                        return@withLock null
                    }
                }
            }
            grabWithRetriever(positionMs)
        }
    }

    private fun openMpv(): MpvThumbnailer? {
        val context = PlayerSettingsStorage.applicationContext() ?: run {
            mpvFailed = true
            return null
        }
        return try {
            MpvThumbnailer(context, url, headers).also {
                if (it.open()) {
                    mpvGrabber = it
                    seekPreviewLog("decoder: mpv (software)")
                } else {
                    it.close()
                    mpvFailed = true
                    seekPreviewLog("mpv couldn't open the stream; trying Android extractor")
                }
            }.takeIf { !mpvFailed }
        } catch (t: Throwable) {
            seekPreviewLog("mpv thumbnailer failed to start: $t")
            mpvFailed = true
            null
        }
    }

    private fun grabWithRetriever(positionMs: Long): ImageBitmap? {
        if (retrieverFailed) return null
        val r = retriever ?: try {
            MediaMetadataRetriever().also {
                it.setDataSource(url, headers)
                retriever = it
                seekPreviewLog("decoder: Android extractor")
            }
        } catch (t: Throwable) {
            seekPreviewLog("setDataSource failed: $t")
            retrieverFailed = true
            return null
        }
        val timeUs = positionMs * 1000L
        val raw = try {
            if (Build.VERSION.SDK_INT >= 27) {
                r.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, THUMB_WIDTH, THUMB_HEIGHT)
            } else {
                r.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            }
        } catch (t: Throwable) {
            seekPreviewLog("getFrameAtTime threw: $t")
            null
        } ?: return null
        return shrink(raw).asImageBitmap()
    }

    actual fun close() {
        if (closed) return
        closed = true
        // A grab may still be running; release once it finishes, off the main thread.
        Thread {
            runBlocking {
                lock.withLock {
                    try { mpvGrabber?.close() } catch (_: Throwable) {}
                    mpvGrabber = null
                    try { retriever?.release() } catch (_: Throwable) {}
                    retriever = null
                }
            }
        }.apply { name = "seek-preview-release"; isDaemon = true }.start()
    }
}

/** One hidden mpv instance per stream: paused, no audio/subs, software decode, tiny read-ahead. */
private class MpvThumbnailer(
    private val context: Context,
    private val url: String,
    private val headers: Map<String, String>,
) {
    private val mpv = MPV()
    private val events = LinkedBlockingQueue<Int>()
    private val observer = object : MPV.EventObserver {
        override fun eventProperty(property: String) = Unit
        override fun eventProperty(property: String, value: Long) = Unit
        override fun eventProperty(property: String, value: Boolean) = Unit
        override fun eventProperty(property: String, value: String) = Unit
        override fun eventProperty(property: String, value: Double) = Unit
        override fun eventProperty(property: String, value: MPVNode) = Unit
        override fun event(eventId: Int, data: MPVNode) {
            events.offer(eventId)
        }
    }
    private var created = false

    /** Loads the stream; true once it's ready to seek. */
    fun open(): Boolean {
        mpv.create(context)
        created = true
        mpv.setOptionString("config", "no")
        mpv.setOptionString("vo", "null")
        mpv.setOptionString("ao", "null")
        mpv.setOptionString("aid", "no")
        mpv.setOptionString("sid", "no")
        mpv.setOptionString("hwdec", "no")
        mpv.setOptionString("pause", "yes")
        mpv.setOptionString("keep-open", "yes")
        mpv.setOptionString("idle", "yes")
        mpv.setOptionString("hr-seek", "no")
        mpv.setOptionString("cache", "no")
        mpv.setOptionString("demuxer-readahead-secs", "0")
        mpv.setOptionString("demuxer-max-bytes", "8MiB")
        mpv.setOptionString("demuxer-max-back-bytes", "0")
        mpv.setOptionString("vd-lavc-threads", "2")
        mpv.setOptionString("vd-lavc-skiploopfilter", "all")
        mpv.setOptionString("vd-lavc-fast", "yes")
        mpv.setOptionString("vf", "lavfi=[scale=${THUMB_WIDTH}:-2:flags=fast_bilinear]")
        mpv.setOptionString("msg-level", "all=error")
        val caFile = File(context.filesDir, "cacert.pem")
        if (caFile.isFile) {
            mpv.setOptionString("tls-verify", "yes")
            mpv.setOptionString("tls-ca-file", caFile.path)
        }
        headers.entries.firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }?.let {
            mpv.setOptionString("user-agent", it.value)
        }
        val fields = headers.filterKeys { !it.equals("User-Agent", ignoreCase = true) }
            .filter { (k, v) -> ',' !in k && ',' !in v }
            .map { (k, v) -> "$k: $v" }
        if (fields.isNotEmpty()) mpv.setOptionString("http-header-fields", fields.joinToString(","))
        mpv.init()
        mpv.addObserver(observer)
        mpv.command("loadfile", url, "replace")
        return when (awaitEvent(OPEN_TIMEOUT_MS, MPV.mpvEvent.MPV_EVENT_FILE_LOADED, MPV.mpvEvent.MPV_EVENT_END_FILE)) {
            MPV.mpvEvent.MPV_EVENT_FILE_LOADED -> {
                // First frame after load.
                awaitEvent(SEEK_TIMEOUT_MS, MPV.mpvEvent.MPV_EVENT_PLAYBACK_RESTART, MPV.mpvEvent.MPV_EVENT_END_FILE)
                true
            }
            else -> false
        }
    }

    fun grab(positionMs: Long): Bitmap? {
        events.clear()
        mpv.command("seek", (positionMs / 1000.0).toString(), "absolute+keyframes")
        val result = awaitEvent(SEEK_TIMEOUT_MS, MPV.mpvEvent.MPV_EVENT_PLAYBACK_RESTART, MPV.mpvEvent.MPV_EVENT_END_FILE)
        if (result != MPV.mpvEvent.MPV_EVENT_PLAYBACK_RESTART) {
            seekPreviewLog("mpv seek to ${positionMs}ms didn't complete (event=$result)")
            return null
        }
        return try {
            screenshot()
        } catch (t: Throwable) {
            seekPreviewLog("mpv screenshot failed: $t")
            null
        }
    }

    /** Raw RGBA frame from mpv (already scaled by the vf above). */
    private fun screenshot(): Bitmap? {
        val node = runCatching { mpv.commandNode("screenshot-raw", "video", "rgba") }.getOrNull() as? MPVNode.MapNode
            ?: runCatching { mpv.commandNode("screenshot-raw", "video") }.getOrNull() as? MPVNode.MapNode
            ?: return null
        val map = node.value
        val w = (map["w"] as? MPVNode.IntNode)?.value?.toInt() ?: return null
        val h = (map["h"] as? MPVNode.IntNode)?.value?.toInt() ?: return null
        val stride = (map["stride"] as? MPVNode.IntNode)?.value?.toInt() ?: return null
        val format = (map["format"] as? MPVNode.StringNode)?.value ?: "bgr0"
        val data = (map["data"] as? MPVNode.ByteArrayNode)?.value ?: return null
        if (w <= 0 || h <= 0 || data.size < stride * h) return null
        // Repack into tight RGBA rows (ARGB_8888's in-memory order), swapping channels for bgr0/bgra.
        val swap = format.startsWith("bgr")
        val px = ByteArray(w * h * 4)
        for (y in 0 until h) {
            var src = y * stride
            var dst = y * w * 4
            for (x in 0 until w) {
                if (swap) {
                    px[dst] = data[src + 2]; px[dst + 1] = data[src + 1]; px[dst + 2] = data[src]
                } else {
                    px[dst] = data[src]; px[dst + 1] = data[src + 1]; px[dst + 2] = data[src + 2]
                }
                px[dst + 3] = 0xFF.toByte()
                src += 4
                dst += 4
            }
        }
        return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply {
            copyPixelsFromBuffer(ByteBuffer.wrap(px))
        }
    }

    private fun awaitEvent(timeoutMs: Long, vararg wanted: Int): Int? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) return null
            val event = events.poll(left, TimeUnit.MILLISECONDS) ?: return null
            if (event in wanted) return event
        }
    }

    fun close() {
        if (!created) return
        try { mpv.removeObserver(observer) } catch (_: Throwable) {}
        try { mpv.destroy() } catch (_: Throwable) {}
        created = false
    }

    private companion object {
        const val OPEN_TIMEOUT_MS = 20_000L
        const val SEEK_TIMEOUT_MS = 15_000L
    }
}

/** Fit inside the thumbnail box and use 16-bit colour to halve memory. */
private fun shrink(src: Bitmap): Bitmap {
    val scale = minOf(THUMB_WIDTH.toFloat() / src.width, THUMB_HEIGHT.toFloat() / src.height, 1f)
    val w = (src.width * scale).toInt().coerceAtLeast(1)
    val h = (src.height * scale).toInt().coerceAtLeast(1)
    val scaled = if (w != src.width || h != src.height) Bitmap.createScaledBitmap(src, w, h, true) else src
    return scaled.copy(Bitmap.Config.RGB_565, false) ?: scaled
}

internal actual object PreviewFrameCache {
    private const val DIR_NAME = "seek-previews"
    private const val MAX_TITLES = 40
    @Volatile private var pruned = false

    private fun context(): Context? = PlayerSettingsStorage.applicationContext()

    private fun titleDir(key: String): File? {
        val root = File(context()?.cacheDir ?: return null, DIR_NAME)
        val digest = MessageDigest.getInstance("SHA-1").digest(key.toByteArray())
        val name = digest.joinToString("") { "%02x".format(it) }
        return File(root, name)
    }

    actual suspend fun load(key: String, bucket: Int): ImageBitmap? = withContext(Dispatchers.IO) {
        val file = File(titleDir(key) ?: return@withContext null, "$bucket.jpg")
        if (!file.isFile) return@withContext null
        try {
            val options = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.RGB_565 }
            BitmapFactory.decodeFile(file.path, options)?.asImageBitmap()
        } catch (_: Throwable) {
            null
        }
    }

    actual suspend fun save(key: String, bucket: Int, frame: ImageBitmap) = withContext(Dispatchers.IO) {
        val dir = titleDir(key) ?: return@withContext
        try {
            if (!pruned) prune(dir.parentFile)
            dir.mkdirs()
            dir.setLastModified(System.currentTimeMillis())
            val tmp = File(dir, "$bucket.jpg.tmp")
            tmp.outputStream().use { frame.asAndroidBitmap().compress(Bitmap.CompressFormat.JPEG, 70, it) }
            tmp.renameTo(File(dir, "$bucket.jpg"))
        } catch (_: Throwable) {
        }
    }

    /** Keep only the most recently used titles. */
    private fun prune(root: File?) {
        pruned = true
        val dirs = root?.listFiles()?.filter { it.isDirectory } ?: return
        if (dirs.size <= MAX_TITLES) return
        dirs.sortedByDescending { it.lastModified() }.drop(MAX_TITLES).forEach { it.deleteRecursively() }
    }
}

internal actual fun isLocalSeekPreviewSupported(): Boolean = true

internal actual fun isOnUnmeteredNetwork(): Boolean {
    val cm = PlayerSettingsStorage.applicationContext()
        ?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return false
    return try {
        cm.activeNetworkInfo?.isConnected == true && !cm.isActiveNetworkMetered
    } catch (_: Throwable) {
        false
    }
}

internal actual fun seekPreviewLog(message: String) {
    android.util.Log.i("SeekPreview", message)
}
