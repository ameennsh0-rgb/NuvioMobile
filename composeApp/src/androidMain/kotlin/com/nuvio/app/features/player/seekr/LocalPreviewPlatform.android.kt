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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

private const val THUMB_WIDTH = 320
private const val THUMB_HEIGHT = 180

internal actual class PreviewFrameGrabber actual constructor(
    private val url: String,
    private val headers: Map<String, String>,
) {
    private val lock = Mutex()
    private var retriever: MediaMetadataRetriever? = null
    @Volatile private var closed = false
    private var openFailed = false

    actual suspend fun grab(positionMs: Long): ImageBitmap? = withContext(Dispatchers.IO) {
        lock.withLock {
            if (closed || openFailed) return@withLock null
            val r = retriever ?: openRetriever() ?: return@withLock null
            val timeUs = positionMs * 1000L
            val raw = try {
                if (Build.VERSION.SDK_INT >= 27) {
                    // Nearest keyframe, decoded straight to thumbnail size: fast and cheap.
                    r.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, THUMB_WIDTH, THUMB_HEIGHT)
                } else {
                    r.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                }
            } catch (t: Throwable) {
                seekPreviewLog("getFrameAtTime threw: $t")
                null
            } ?: return@withLock null
            shrink(raw).asImageBitmap()
        }
    }

    private fun openRetriever(): MediaMetadataRetriever? = try {
        MediaMetadataRetriever().also {
            it.setDataSource(url, headers)
            retriever = it
        }
    } catch (t: Throwable) {
        seekPreviewLog("setDataSource failed: $t")
        openFailed = true
        null
    }

    actual fun close() {
        if (closed) return
        closed = true
        // A native frame grab may still be running; release once it finishes, off the main thread.
        Thread {
            runBlocking {
                lock.withLock {
                    try { retriever?.release() } catch (_: Throwable) {}
                    retriever = null
                }
            }
        }.apply { name = "seek-preview-release"; isDaemon = true }.start()
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
