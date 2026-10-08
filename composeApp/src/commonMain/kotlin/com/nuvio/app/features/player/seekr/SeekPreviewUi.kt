package com.nuvio.app.features.player.seekr

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.zIndex
import kotlin.math.roundToInt
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.SingletonImageLoader
import coil3.compose.AsyncImagePainter
import coil3.compose.LocalPlatformContext
import coil3.compose.rememberAsyncImagePainter
import coil3.request.CachePolicy
import coil3.request.ImageRequest

/** The preview track for whatever is playing; null when unavailable or disabled. */
internal val LocalSeekPreviewTrack = compositionLocalOf<SeekPreviewTrack?> { null }

internal val SeekPreviewThumbWidth: Dp = 160.dp
internal val SeekPreviewThumbHeight: Dp = 90.dp

/**
 * Looks up Seekr previews for the current title. Re-runs when the title, episode or
 * (second-rounded) duration changes. Returns null until loaded or if Seekr has nothing.
 */
@Composable
internal fun rememberSeekPreviewTrack(
    apiKey: String,
    contentId: String?,
    contentType: String?,
    season: Int?,
    episode: Int?,
    durationMs: Long,
): SeekPreviewTrack? {
    val durationSec = durationMs / 1000L
    var track by remember(apiKey, contentId, contentType, season, episode, durationSec) {
        mutableStateOf<SeekPreviewTrack?>(null)
    }
    val context = LocalPlatformContext.current
    LaunchedEffect(apiKey, contentId, contentType, season, episode, durationSec) {
        if (apiKey.isBlank() || durationSec <= 0L) return@LaunchedEffect
        val content = seekrContentFor(contentId, contentType, season, episode) ?: return@LaunchedEffect
        val loaded = SeekrClient.loadTrack(apiKey, content, durationMs) ?: return@LaunchedEffect
        track = loaded
        // Warm the disk cache so scrubbing is instant; keep them out of memory until needed.
        val loader = SingletonImageLoader.get(context)
        loaded.sheetUrls.forEach { url ->
            loader.enqueue(
                ImageRequest.Builder(context)
                    .data(url)
                    .memoryCachePolicy(CachePolicy.DISABLED)
                    .size(coil3.size.Size.ORIGINAL)
                    .build(),
            )
        }
    }
    return track
}

/** Thumbnail tile cropped out of its sprite sheet, with the scrub time underneath. */
@Composable
internal fun SeekPreviewThumbnail(
    cue: SeekPreviewCue,
    timeLabel: String,
    modifier: Modifier = Modifier,
) {
    val context = LocalPlatformContext.current
    val request = remember(cue.sheetUrl, context) {
        ImageRequest.Builder(context)
            .data(cue.sheetUrl)
            .size(coil3.size.Size.ORIGINAL)
            .build()
    }
    val painter = rememberAsyncImagePainter(request)
    val state by painter.state.collectAsState()
    val shape = RoundedCornerShape(8.dp)

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top,
    ) {
        Spacer(
            Modifier
                .size(SeekPreviewThumbWidth, SeekPreviewThumbHeight)
                .clip(shape)
                .background(Color.Black.copy(alpha = 0.85f))
                .border(1.5.dp, Color.White.copy(alpha = 0.85f), shape)
                .drawBehind {
                    if (state !is AsyncImagePainter.State.Success) return@drawBehind
                    val sheet = painter.intrinsicSize
                    if (sheet.width.isNaN() || sheet.width <= 0f) return@drawBehind
                    val scale = size.width / cue.width
                    translate(left = -cue.x * scale, top = -cue.y * scale) {
                        with(painter) {
                            draw(Size(sheet.width * scale, sheet.height * scale))
                        }
                    }
                },
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = timeLabel,
            color = Color.White,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(Color.Black.copy(alpha = 0.6f))
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/**
 * Wraps a seek bar and, while [active], floats the Seekr thumbnail for [positionMs] above it,
 * horizontally following the scrub position and clamped to the bar's edges.
 */
@Composable
internal fun SeekPreviewHost(
    positionMs: Long,
    durationMs: Long,
    active: Boolean,
    modifier: Modifier = Modifier,
    verticalGap: Dp = 8.dp,
    timeLabel: (Long) -> String,
    content: @Composable () -> Unit,
) {
    val track = LocalSeekPreviewTrack.current
    var barWidthPx by remember { mutableStateOf(0) }
    var previewSize by remember { mutableStateOf(IntSize.Zero) }
    val density = LocalDensity.current
    val gapPx = with(density) { verticalGap.roundToPx() }

    Box(modifier = modifier.onSizeChanged { barWidthPx = it.width }) {
        content()
        val cue = if (active && track != null && durationMs > 0L) track.cueAt(positionMs) else null
        if (cue != null) {
            SeekPreviewThumbnail(
                cue = cue,
                timeLabel = timeLabel(positionMs),
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .zIndex(10f)
                    .onSizeChanged { previewSize = it }
                    .offset {
                        val fraction = (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
                        val maxX = (barWidthPx - previewSize.width).coerceAtLeast(0)
                        val x = (barWidthPx * fraction - previewSize.width / 2f).roundToInt().coerceIn(0, maxX)
                        IntOffset(x, -(previewSize.height + gapPx))
                    },
            )
        }
    }
}
