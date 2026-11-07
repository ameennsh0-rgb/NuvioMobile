package com.nuvio.app.features.party.call

import android.content.Context
import android.graphics.SurfaceTexture
import android.view.TextureView
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Renders a WebRTC video track into a TextureView. A TextureView (unlike a SurfaceView)
 * composes normally with the rest of the UI, so tiles can have rounded corners and sit
 * on top of the movie without z-order fights.
 */
internal class CallVideoView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener, VideoSink {
    private val renderer = EglRenderer("CallVideoView")
    private var initialized = false
    private var track: VideoTrack? = null

    init {
        surfaceTextureListener = this
        isOpaque = false
    }

    fun bind(eglContext: EglBase.Context?, newTrack: VideoTrack?, mirror: Boolean) {
        if (!initialized && eglContext != null) {
            renderer.init(eglContext, EglBase.CONFIG_PLAIN, GlRectDrawer())
            initialized = true
            if (isAvailable) surfaceTexture?.let(::attachSurface)
        }
        renderer.setMirror(mirror)
        if (newTrack === track) return
        runCatching { track?.removeSink(this) }
        if (initialized) renderer.clearImage()
        track = newTrack
        if (initialized) runCatching { newTrack?.addSink(this) }
    }

    fun release() {
        runCatching { track?.removeSink(this) }
        track = null
        if (initialized) {
            renderer.release()
            initialized = false
        }
    }

    override fun onFrame(frame: VideoFrame) {
        renderer.onFrame(frame)
    }

    private fun attachSurface(surface: SurfaceTexture) {
        renderer.createEglSurface(surface)
        if (width > 0 && height > 0) renderer.setLayoutAspectRatio(width.toFloat() / height)
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (initialized) attachSurface(surface)
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        if (initialized && width > 0 && height > 0) renderer.setLayoutAspectRatio(width.toFloat() / height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        if (initialized) {
            val latch = CountDownLatch(1)
            renderer.releaseEglSurface { latch.countDown() }
            latch.await(500, TimeUnit.MILLISECONDS)
        }
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
}
