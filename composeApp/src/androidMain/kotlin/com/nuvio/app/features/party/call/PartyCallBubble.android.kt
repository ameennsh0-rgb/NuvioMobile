package com.nuvio.app.features.party.call

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Cameraswitch
import androidx.compose.material.icons.rounded.CloseFullscreen
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.VideoCall
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nuvio.app.features.party.ActiveParty
import kotlin.math.roundToInt

private val BubbleBackground = Color(0xE6101014)
private val TileBackground = Color(0xFF23232A)
private val EndRed = Color(0xFFE5484D)
private val TileWidth = 112.dp
private val TileHeight = 148.dp
private const val MAX_TILES = 4

@Composable
actual fun PartyCallBubble(
    party: ActiveParty?,
    visible: Boolean,
    controlsVisible: Boolean,
    modifier: Modifier,
) {
    val state by PartyCallEngine.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // Leave the call when the watch party ends or we switch parties.
    val partyId = party?.id
    LaunchedEffect(partyId) {
        PartyCallEngine.onPartyChanged(partyId)
    }

    if (party == null || !visible || !PartyCallEngine.isConfigured) return

    val myName = party.members.firstOrNull { it.id == party.memberId }?.displayName ?: "Guest"
    val join = { PartyCallEngine.join(context, party.id, party.memberId, myName) }

    val permissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val mic = results[Manifest.permission.RECORD_AUDIO] == true
        val camera = results[Manifest.permission.CAMERA] == true
        if (mic) {
            if (!camera) PartyCallEngine.setCamera(false)
            join()
        }
    }
    val startCall = {
        val needed = listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA).filter {
            ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isEmpty()) join() else permissions.launch(needed.toTypedArray())
    }

    var collapsed by rememberSaveable { mutableStateOf(false) }
    var drag by remember { mutableStateOf(Offset.Zero) }
    val density = LocalDensity.current

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val maxX = with(density) { maxWidth.toPx() }
        val maxY = with(density) { maxHeight.toPx() }
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 64.dp, end = 16.dp)
                .offset { IntOffset(drag.x.roundToInt(), drag.y.roundToInt()) }
                .pointerInput(Unit) {
                    detectDragGestures { change, amount ->
                        change.consume()
                        drag = Offset(
                            x = (drag.x + amount.x).coerceIn(-maxX + 120f, 0f),
                            y = (drag.y + amount.y).coerceIn(-40f, maxY - 200f),
                        )
                    }
                },
        ) {
            AnimatedContent(
                targetState = when {
                    state.phase == CallUiState.Phase.Idle -> BubbleMode.Join
                    collapsed -> BubbleMode.Collapsed
                    else -> BubbleMode.Expanded
                },
                label = "partyCallBubble",
            ) { mode ->
                when (mode) {
                    BubbleMode.Join -> AnimatedVisibility(
                        visible = controlsVisible || state.error != null,
                        enter = fadeIn(),
                        exit = fadeOut(),
                    ) {
                        JoinPill(error = state.error, onClick = {
                            PartyCallEngine.clearError()
                            startCall()
                        })
                    }
                    BubbleMode.Collapsed -> CollapsedBubble(
                        people = state.tiles.size,
                        connecting = state.phase == CallUiState.Phase.Connecting,
                        onClick = { collapsed = false },
                    )
                    BubbleMode.Expanded -> ExpandedBubble(
                        state = state,
                        controlsVisible = controlsVisible,
                        onCollapse = { collapsed = true },
                    )
                }
            }
        }
    }
}

private enum class BubbleMode { Join, Collapsed, Expanded }

@Composable
private fun JoinPill(error: String?, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.End) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(BubbleBackground)
                .clickable(onClick = onClick)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.VideoCall, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text("Join video call", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
        if (error != null) {
            Spacer(Modifier.height(6.dp))
            Text(
                text = error,
                color = Color.White,
                fontSize = 11.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .width(220.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(EndRed.copy(alpha = 0.85f))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun CollapsedBubble(people: Int, connecting: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(52.dp)
            .clip(CircleShape)
            .background(BubbleBackground)
            .border(2.dp, Color(0xFF3DD68C), CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (connecting) {
            CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Rounded.Videocam, contentDescription = "Show call", tint = Color.White, modifier = Modifier.size(18.dp))
                Text("$people", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun ExpandedBubble(state: CallUiState, controlsVisible: Boolean, onCollapse: () -> Unit) {
    // With controls hidden only the camera tiles stay, on a fully see-through backdrop.
    val backdrop by animateColorAsState(
        targetValue = if (controlsVisible) BubbleBackground else Color.Transparent,
        label = "callBubbleBackdrop",
    )
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(backdrop)
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (state.phase == CallUiState.Phase.Connecting) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(4.dp)) {
                CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(8.dp))
                Text("Connecting…", color = Color.White, fontSize = 12.sp)
            }
        }
        val shown = state.tiles.take(MAX_TILES)
        // Two columns once more than two people are in, so it stays short.
        shown.chunked(if (shown.size > 2) 2 else 1).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { tile -> key(tile.memberId) { CallTileView(tile) } }
            }
        }
        if (state.tiles.size > MAX_TILES) {
            Text("+${state.tiles.size - MAX_TILES} more", color = Color.White.copy(alpha = 0.7f), fontSize = 11.sp)
        }
        state.error?.let {
            Text(it, color = EndRed, fontSize = 11.sp, maxLines = 2, modifier = Modifier.width(TileWidth * 2))
        }
        AnimatedVisibility(
            visible = controlsVisible,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            ControlButton(
                icon = if (state.micOn) Icons.Rounded.Mic else Icons.Rounded.MicOff,
                description = if (state.micOn) "Mute" else "Unmute",
                active = state.micOn,
                onClick = { PartyCallEngine.setMic(!state.micOn) },
            )
            ControlButton(
                icon = if (state.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff,
                description = if (state.cameraOn) "Camera off" else "Camera on",
                active = state.cameraOn,
                onClick = { PartyCallEngine.setCamera(!state.cameraOn) },
            )
            if (state.cameraOn) {
                ControlButton(Icons.Rounded.Cameraswitch, "Flip camera", true) { PartyCallEngine.flipCamera() }
            }
            ControlButton(Icons.Rounded.CloseFullscreen, "Minimize", true, onClick = onCollapse)
            ControlButton(Icons.Rounded.CallEnd, "Leave call", true, background = EndRed) { PartyCallEngine.leave() }
        }
        }
    }
}

@Composable
private fun CallTileView(tile: CallTile) {
    val eglContext = PartyCallEngine.eglContext()
    Box(
        modifier = Modifier
            .size(TileWidth, TileHeight)
            .clip(RoundedCornerShape(14.dp))
            .background(TileBackground),
    ) {
        if (tile.cameraOn && tile.videoTrack != null && eglContext != null) {
            val mirror = tile.isLocal && PartyCallEngine.isFrontCamera()
            AndroidView(
                factory = { CallVideoView(it) },
                update = { view -> view.bind(eglContext, tile.videoTrack, mirror) },
                onRelease = { view -> view.release() },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(52.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF3A3A44)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = tile.name.trim().firstOrNull()?.uppercase() ?: "?",
                    color = Color.White,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
        Row(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(6.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(Color.Black.copy(alpha = 0.55f))
                .padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!tile.micOn) {
                Icon(Icons.Rounded.MicOff, contentDescription = "Muted", tint = EndRed, modifier = Modifier.size(12.dp))
                Spacer(Modifier.width(3.dp))
            }
            Text(
                text = tile.name,
                color = Color.White,
                fontSize = 10.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.width(TileWidth - 34.dp),
            )
        }
    }
}

@Composable
private fun ControlButton(
    icon: ImageVector,
    description: String,
    active: Boolean,
    background: Color = Color.White.copy(alpha = 0.14f),
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(if (active) background else Color.White.copy(alpha = 0.9f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = description,
            tint = if (active) Color.White else Color.Black,
            modifier = Modifier.size(18.dp),
        )
    }
}
