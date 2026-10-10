package com.nuvio.app.features.player.seekr

import androidx.compose.ui.graphics.ImageBitmap

// The on-device preview fallback is Android-only for now.

internal actual class PreviewFrameGrabber actual constructor(url: String, headers: Map<String, String>) {
    actual suspend fun grab(positionMs: Long): ImageBitmap? = null
    actual fun close() {}
}

internal actual object PreviewFrameCache {
    actual suspend fun load(key: String, bucket: Int): ImageBitmap? = null
    actual suspend fun save(key: String, bucket: Int, frame: ImageBitmap) {}
}

internal actual fun isLocalSeekPreviewSupported(): Boolean = false

internal actual fun isOnUnmeteredNetwork(): Boolean = false

internal actual fun seekPreviewLog(message: String) {}
