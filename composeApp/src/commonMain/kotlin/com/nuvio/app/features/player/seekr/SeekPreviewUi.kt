package com.nuvio.app.features.player.seekr

import androidx.compose.foundation.Image
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.nuvio.app.features.player.PlayerSettingsStorage
import kotlinx.coroutines.awaitCancellation
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
import coil3.network.httpHeaders

/** The preview source for whatever is playing (Seekr or on-device); null when unavailable. */
internal val LocalSeekPreviewTrack = compositionLocalOf<SeekPreviewSource?> { null }

internal val SeekPreviewThumbWidth: Dp = 160.dp
internal val SeekPreviewThumbHeight: Dp = 90.dp

/**
 * Looks up Seekr previews for the current title. If Seekr has nothing (or no key is set) and the
 * fallback is enabled, generates previews on the device from the stream itself.
 * Re-runs when the title, episode, stream or (second-rounded) duration changes.
 */
@Composable
internal fun rememberSeekPreviewTrack(
    apiKey: String,
    contentId: String?,
    contentType: String?,
    season: Int?,
    episode: Int?,
    durationMs: Long,
    sourceUrl: String? = null,
    sourceHeaders: Map<String, String> = emptyMap(),
    streamType: String? = null,
    isP2p: Boolean = false,
    playerBusy: Boolean = false,
): SeekPreviewSource? {
    val durationSec = durationMs / 1000L
    var track by remember(apiKey, contentId, contentType, season, episode, durationSec, sourceUrl) {
        mutableStateOf<SeekPreviewSource?>(null)
    }
    val context = LocalPlatformContext.current
    val scope = rememberCoroutineScope()
    val busy by rememberUpdatedState(playerBusy)
    val headers by rememberUpdatedState(sourceHeaders)

    LaunchedEffect(apiKey, contentId, contentType, season, episode, durationSec, sourceUrl) {
        if (durationSec <= 0L) return@LaunchedEffect
        val content = seekrContentFor(contentId, contentType, season, episode)
        seekPreviewLog("start id=$contentId type=$contentType s=$season e=$episode dur=${durationSec}s seekrKey=${apiKey.isNotBlank()}")

        fun warm(t: SeekPreviewTrack) {
            // Warm the disk cache so scrubbing is instant; keep them out of memory until needed.
            val loader = SingletonImageLoader.get(context)
            t.sheetUrls.forEach { url ->
                loader.enqueue(
                    ImageRequest.Builder(context)
                        .data(url)
                        .withHeaders(t.requestHeaders)
                        .memoryCachePolicy(CachePolicy.DISABLED)
                        .size(coil3.size.Size.ORIGINAL)
                        .build(),
                )
            }
        }

        // 1) Seekr.
        val seekr = if (apiKey.isNotBlank() && content != null) {
            track = SeekPreviewLookingUp
            SeekrClient.loadTrack(apiKey, content, durationMs)
        } else {
            null
        }
        seekPreviewLog("seekr track=${seekr != null}")
        if (seekr != null) {
            track = seekr
            warm(seekr)
            return@LaunchedEffect
        }

        // 2) Personal cloud thumbnails (GitHub repo fed by TorBox).
        val cloudRepo = PlayerSettingsStorage.loadThumbsRepo().orEmpty().trim().trim('/')
        val cloudToken = PlayerSettingsStorage.loadThumbsToken().orEmpty().trim()
        val cloudKey = content?.let { CloudThumbsClient.keyFor(it) }
        val cloudEnabled = cloudRepo.count { it == '/' } == 1 && cloudToken.isNotBlank() && cloudKey != null
        var cloudNote: String? = null
        var cloudPending = false
        if (cloudEnabled) {
            track = SeekPreviewLookingUp
            when (val result = CloudThumbsClient.lookup(cloudRepo, cloudToken, cloudKey!!, durationMs)) {
                is CloudThumbsClient.Lookup.Ready -> {
                    seekPreviewLog("cloud track ready for $cloudKey")
                    track = result.track
                    warm(result.track)
                    return@LaunchedEffect
                }
                is CloudThumbsClient.Lookup.Missing -> {
                    val directUrl = sourceUrl?.takeIf { !isP2p && (it.startsWith("http://") || it.startsWith("https://")) }
                    cloudPending = CloudThumbsClient.requestGeneration(
                        cloudRepo, cloudToken, cloudKey, content!!, durationMs, directUrl,
                    )
                    cloudNote = if (cloudPending) "cloud: queued" else "cloud: couldn't start"
                }
                is CloudThumbsClient.Lookup.Failed -> {
                    seekPreviewLog("cloud failed earlier: ${result.reason}")
                    val ageSec = kotlin.time.Clock.System.now().epochSeconds - result.atEpochSec
                    if (ageSec > 6 * 3600) {
                        // Old failure: TorBox cache or the generator may have changed since; try again.
                        val directUrl = sourceUrl?.takeIf { !isP2p && (it.startsWith("http://") || it.startsWith("https://")) }
                        cloudPending = CloudThumbsClient.requestGeneration(
                            cloudRepo, cloudToken, cloudKey, content!!, durationMs, directUrl,
                        )
                        cloudNote = if (cloudPending) "cloud: queued" else "cloud: ${result.reason}"
                    } else {
                        cloudNote = "cloud: ${result.reason}"
                    }
                }
                is CloudThumbsClient.Lookup.Error -> {
                    cloudNote = "cloud: ${result.message}"
                    seekPreviewLog("cloud error: ${result.message}")
                }
            }
        }

        // 3) On-device previews while the cloud works (or if it can't help).
        val seekrNote = when {
            apiKey.isBlank() -> "no Seekr key"
            content == null -> "no IMDb/TMDB id for Seekr"
            else -> "Seekr has none"
        }
        var local: LocalPreviewTrack? = null
        val localReason = when {
            !PlayerSettingsStorage.loadLocalSeekPreviewEnabled() -> "on-device previews off"
            else -> LocalPreviewTrack.ineligibleReason(sourceUrl, streamType, isP2p)
        }
        if (localReason == null) {
            val wifiOnly = PlayerSettingsStorage.loadLocalSeekPreviewWifiOnly()
            val cacheKey = (content?.cacheKey ?: "u:${sourceUrl!!.substringBefore('?')}") + "|$durationSec"
            local = LocalPreviewTrack(
                grabber = PreviewFrameGrabber(sourceUrl!!, headers),
                durationMs = durationMs,
                cacheKey = cacheKey,
                backgroundPassEnabled = { !wifiOnly || isOnUnmeteredNetwork() },
                playerBusy = { busy },
            )
            local.note = cloudNote
            seekPreviewLog("local track started key=$cacheKey interval=${local.intervalMs}ms")
            local.start(scope)
            track = local
        } else {
            track = SeekPreviewUnavailable(listOfNotNull(seekrNote, cloudNote, localReason).joinToString(" · "))
        }

        try {
            // Swap to cloud thumbnails as soon as the workflow commits them.
            if (cloudPending) {
                val deadline = kotlin.time.TimeSource.Monotonic.markNow() + kotlin.time.Duration.parse("30m")
                val baseReason = (track as? SeekPreviewUnavailable)?.reason
                while (deadline.hasNotPassedNow()) {
                    kotlinx.coroutines.delay(15_000)
                    CloudThumbsClient.progress(cloudRepo, cloudToken, cloudKey!!)
                        ?.takeIf { it.stage != "failed" }
                        ?.let { p ->
                            val quietSec = kotlin.time.Clock.System.now().epochSeconds - p.at
                            val label = if (quietSec > 300 && p.stage == "extracting") {
                                "cloud: stalled at ${p.done}/${p.total}"
                            } else {
                                "cloud: ${p.label()}"
                            }
                            local?.note = label
                            if (local == null && baseReason != null) {
                                track = SeekPreviewUnavailable("$baseReason · $label")
                            }
                        }
                    when (val result = CloudThumbsClient.lookup(cloudRepo, cloudToken, cloudKey!!, durationMs)) {
                        is CloudThumbsClient.Lookup.Ready -> {
                            seekPreviewLog("cloud track arrived for $cloudKey")
                            local?.close()
                            local = null
                            track = result.track
                            warm(result.track)
                            break
                        }
                        is CloudThumbsClient.Lookup.Failed -> {
                            local?.note = "cloud: ${result.reason}"
                            break
                        }
                        else -> Unit
                    }
                }
            }
            awaitCancellation()
        } finally {
            local?.close()
        }
    }
    return track
}

/** Small "SEEKR" / "LOCAL" tag in the thumbnail's corner. */
@Composable
private fun SourceBadge(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = Color.White,
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.6.sp,
        modifier = modifier
            .padding(4.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(Color.Black.copy(alpha = 0.65f))
            .padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

/** Time under the thumbnail, with an optional smaller status line. */
@Composable
private fun PreviewCaption(timeLabel: String, status: String?) {
    Spacer(Modifier.height(4.dp))
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(Color.Black.copy(alpha = 0.6f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(text = timeLabel, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        if (status != null) {
            Text(text = status, color = Color.White.copy(alpha = 0.75f), fontSize = 10.sp)
        }
    }
}

/** Shown while scrubbing when there's no thumbnail, saying why. */
@Composable
internal fun SeekPreviewReasonChip(timeLabel: String, reason: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        PreviewCaption(timeLabel = timeLabel, status = reason)
    }
}

/** Thumbnail tile cropped out of its sprite sheet, with the scrub time underneath. */
@Composable
internal fun SeekPreviewThumbnail(
    cue: SeekPreviewCue,
    timeLabel: String,
    modifier: Modifier = Modifier,
    headers: Map<String, String> = emptyMap(),
    badge: String = "SEEKR",
) {
    val context = LocalPlatformContext.current
    val request = remember(cue.sheetUrl, context, headers) {
        ImageRequest.Builder(context)
            .data(cue.sheetUrl)
            .size(coil3.size.Size.ORIGINAL)
            .withHeaders(headers)
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
        Box(Modifier.size(SeekPreviewThumbWidth, SeekPreviewThumbHeight)) {
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
        SourceBadge(badge, Modifier.align(Alignment.TopStart))
        }
        PreviewCaption(timeLabel = timeLabel, status = null)
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
        val placement = Modifier
            .align(Alignment.TopStart)
            .zIndex(10f)
            .onSizeChanged { previewSize = it }
            .offset {
                val fraction = (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
                val maxX = (barWidthPx - previewSize.width).coerceAtLeast(0)
                val x = (barWidthPx * fraction - previewSize.width / 2f).roundToInt().coerceIn(0, maxX)
                IntOffset(x, -(previewSize.height + gapPx))
            }
        val showing = active && durationMs > 0L
        when (track) {
            is SeekPreviewTrack -> {
                val cue = if (showing) track.cueAt(positionMs) else null
                if (cue != null) {
                    SeekPreviewThumbnail(
                        cue = cue,
                        timeLabel = timeLabel(positionMs),
                        modifier = placement,
                        headers = track.requestHeaders,
                        badge = track.sourceLabel,
                    )
                }
            }
            is LocalPreviewTrack -> if (showing) {
                val bucket = track.bucketFor(positionMs)
                LaunchedEffect(track, bucket) { track.request(positionMs) }
                val frame = track.frameNear(positionMs)
                val status = when {
                    track.failed && frame == null -> "on-device: can't seek this file"
                    track.failed -> "on-device ${track.readyCount}/${track.totalCount} · stopped"
                    frame == null -> "on-device: grabbing…"
                    else -> "on-device ${track.readyCount}/${track.totalCount}"
                }.let { base -> track.note?.let { "$base · $it" } ?: base }
                LocalPreviewThumbnail(
                    frame = frame,
                    timeLabel = timeLabel(positionMs),
                    status = status,
                    modifier = placement,
                )
            }
            is SeekPreviewLookingUp -> if (showing) {
                SeekPreviewReasonChip(timeLabel(positionMs), "checking Seekr…", placement)
            }
            is SeekPreviewUnavailable -> if (showing) {
                SeekPreviewReasonChip(timeLabel(positionMs), "No preview: ${track.reason}", placement)
            }
            null -> Unit
        }
    }
}

/** Thumbnail generated on the device; shows a dark box with the time until a frame is ready. */
@Composable
internal fun LocalPreviewThumbnail(
    frame: ImageBitmap?,
    timeLabel: String,
    status: String?,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(8.dp)
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top,
    ) {
        Box(
            Modifier
                .size(SeekPreviewThumbWidth, SeekPreviewThumbHeight)
                .clip(shape)
                .background(Color.Black.copy(alpha = 0.85f))
                .border(1.5.dp, Color.White.copy(alpha = 0.85f), shape),
            contentAlignment = Alignment.Center,
        ) {
            if (frame != null) {
                Image(
                    bitmap = frame,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.matchParentSize(),
                )
            }
            SourceBadge("LOCAL", Modifier.align(Alignment.TopStart))
        }
        PreviewCaption(timeLabel = timeLabel, status = status)
    }
}

/** Adds request headers (e.g. a private repo token) when there are any. */
internal fun ImageRequest.Builder.withHeaders(headers: Map<String, String>): ImageRequest.Builder {
    if (headers.isEmpty()) return this
    val built = coil3.network.NetworkHeaders.Builder().apply {
        headers.forEach { (k, v) -> set(k, v) }
    }.build()
    return httpHeaders(built)
}
