package com.nuvio.app.features.party.call

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Cameraswitch
import androidx.compose.material.icons.rounded.CloseFullscreen
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PersonOff
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nuvio.app.features.party.ActiveParty
import kotlin.math.roundToInt

private val Glass = Color(0xCC15151B)
private val TileBackground = Color(0xFF23232A)
private val AvatarBackground = Color(0xFF3A3A44)
private val OffRed = Color(0xFFE5484D)
private val LiveGreen = Color(0xFF3DD68C)

// Main (other person) tile: portrait, like a phone camera.
private val MainWidth = 132.dp
private val MainHeight = 176.dp
// Smaller tiles when 2+ other people are in.
private val GridWidth = 96.dp
private val GridHeight = 128.dp
// Your own picture-in-picture.
private val SelfWidth = 44.dp
private val SelfHeight = 58.dp

private const val MAX_REMOTE_TILES = 4
private const val PREFS = "party_call"
private const val PREF_SHOW_SELF = "show_self"

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

    val prefs = remember { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    var showSelf by remember { mutableStateOf(prefs.getBoolean(PREF_SHOW_SELF, true)) }
    val toggleSelf = {
        showSelf = !showSelf
        prefs.edit().putBoolean(PREF_SHOW_SELF, showSelf).apply()
    }
    var minimized by rememberSaveable { mutableStateOf(false) }
    var drag by remember { mutableStateOf(Offset.Zero) }
    val density = LocalDensity.current

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val maxX = with(density) { maxWidth.toPx() }
        val maxY = with(density) { maxHeight.toPx() }
        val inCall = state.phase != CallUiState.Phase.Idle

        // Not in the call yet: a small button that comes and goes with the player controls.
        AnimatedVisibility(
            visible = !inCall && (controlsVisible || state.error != null),
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 76.dp, end = 20.dp),
        ) {
            JoinButton(error = state.error, onClick = {
                PartyCallEngine.clearError()
                startCall()
            })
        }

        if (inCall) {
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 76.dp, end = 20.dp)
                    .offset { IntOffset(drag.x.roundToInt(), drag.y.roundToInt()) }
                    .pointerInput(Unit) {
                        detectDragGestures { change, amount ->
                            change.consume()
                            drag = Offset(
                                x = (drag.x + amount.x).coerceIn(-maxX + 160f, 0f),
                                y = (drag.y + amount.y).coerceIn(-60f, maxY - 320f),
                            )
                        }
                    },
            ) {
                val local = state.tiles.firstOrNull { it.isLocal }
                val remotes = state.tiles.filterNot { it.isLocal }
                if (minimized) {
                    MinimizedBubble(
                        main = remotes.firstOrNull() ?: local,
                        others = remotes.size,
                        connecting = state.phase == CallUiState.Phase.Connecting,
                        onClick = { minimized = false },
                    )
                } else {
                    CallStage(
                        local = local,
                        remotes = remotes,
                        connecting = state.phase == CallUiState.Phase.Connecting,
                        showSelf = showSelf,
                        onToggleSelf = toggleSelf,
                    )
                }
                state.error?.let { ErrorChip(it) }
                AnimatedVisibility(
                    visible = controlsVisible && !minimized,
                    enter = fadeIn() + scaleIn(initialScale = 0.9f),
                    exit = fadeOut() + scaleOut(targetScale = 0.9f),
                ) {
                    CallControls(
                        state = state,
                        showSelf = showSelf,
                        onToggleSelf = toggleSelf,
                        onMinimize = { minimized = true },
                    )
                }
            }
        }
    }
}

/** The video area: the other person big, you as a small picture-in-picture. */
@Composable
private fun CallStage(
    local: CallTile?,
    remotes: List<CallTile>,
    connecting: Boolean,
    showSelf: Boolean,
    onToggleSelf: () -> Unit,
) {
    Box(modifier = Modifier.animateContentSize()) {
        when {
            remotes.isEmpty() -> {
                // Nobody else yet: show a waiting card (with your camera if self-view is on).
                Box(
                    modifier = Modifier
                        .size(MainWidth, MainHeight)
                        .shadow(10.dp, RoundedCornerShape(18.dp))
                        .clip(RoundedCornerShape(18.dp))
                        .background(TileBackground),
                ) {
                    if (showSelf && local != null && local.cameraOn && local.videoTrack != null) {
                        VideoSurface(local, Modifier.fillMaxSize())
                        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)))
                    }
                    Column(
                        modifier = Modifier.align(Alignment.Center).padding(12.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (connecting) {
                            CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.height(8.dp))
                        }
                        Text(
                            text = if (connecting) "Connecting…" else "Waiting for others to join the call",
                            color = Color.White,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            lineHeight = 15.sp,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
                }
            }
            remotes.size == 1 -> {
                PersonTile(remotes.first(), MainWidth, MainHeight)
                if (showSelf && local != null) {
                    SelfPip(local, onClick = onToggleSelf, modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp))
                }
            }
            else -> {
                val shown = remotes.take(MAX_REMOTE_TILES)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    shown.chunked(2).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { tile -> key(tile.memberId) { PersonTile(tile, GridWidth, GridHeight) } }
                        }
                    }
                }
                if (showSelf && local != null) {
                    SelfPip(local, onClick = onToggleSelf, modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp))
                }
            }
        }
    }
}

@Composable
private fun PersonTile(tile: CallTile, width: Dp, height: Dp) {
    Box(
        modifier = Modifier
            .size(width, height)
            .shadow(10.dp, RoundedCornerShape(18.dp))
            .clip(RoundedCornerShape(18.dp))
            .background(TileBackground),
    ) {
        if (tile.cameraOn && tile.videoTrack != null) {
            VideoSurface(tile, Modifier.fillMaxSize())
        } else {
            Avatar(tile.name, size = if (width >= MainWidth) 56.dp else 40.dp, modifier = Modifier.align(Alignment.Center))
        }
        NameTag(tile, modifier = Modifier.align(Alignment.TopStart).padding(6.dp))
    }
}

@Composable
private fun SelfPip(tile: CallTile, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(SelfWidth, SelfHeight)
            .shadow(6.dp, RoundedCornerShape(10.dp))
            .clip(RoundedCornerShape(10.dp))
            .background(AvatarBackground)
            .border(1.5.dp, Color.White.copy(alpha = 0.85f), RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
    ) {
        if (tile.cameraOn && tile.videoTrack != null) {
            VideoSurface(tile, Modifier.fillMaxSize())
        } else {
            Icon(
                Icons.Rounded.VideocamOff,
                contentDescription = "Your camera is off",
                tint = Color.White.copy(alpha = 0.8f),
                modifier = Modifier.align(Alignment.Center).size(18.dp),
            )
        }
    }
}

@Composable
private fun MinimizedBubble(main: CallTile?, others: Int, connecting: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(60.dp)
            .shadow(10.dp, CircleShape)
            .clip(CircleShape)
            .background(TileBackground)
            .border(2.dp, LiveGreen, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        when {
            connecting -> CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            main != null && main.cameraOn && main.videoTrack != null -> VideoSurface(main, Modifier.fillMaxSize())
            main != null -> Avatar(main.name, size = 60.dp)
        }
        if (others > 1) {
            Text(
                text = "+${others - 1}",
                color = Color.White,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 4.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color.Black.copy(alpha = 0.6f))
                    .padding(horizontal = 4.dp),
            )
        }
    }
}

@Composable
private fun CallControls(
    state: CallUiState,
    showSelf: Boolean,
    onToggleSelf: () -> Unit,
    onMinimize: () -> Unit,
) {
    Row(
        modifier = Modifier
            .shadow(8.dp, RoundedCornerShape(50))
            .clip(RoundedCornerShape(50))
            .background(Glass)
            .padding(horizontal = 6.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ToggleButton(
            on = state.micOn,
            onIcon = Icons.Rounded.Mic,
            offIcon = Icons.Rounded.MicOff,
            description = if (state.micOn) "Mute microphone" else "Unmute microphone",
            onClick = { PartyCallEngine.setMic(!state.micOn) },
        )
        ToggleButton(
            on = state.cameraOn,
            onIcon = Icons.Rounded.Videocam,
            offIcon = Icons.Rounded.VideocamOff,
            description = if (state.cameraOn) "Turn camera off" else "Turn camera on",
            onClick = { PartyCallEngine.setCamera(!state.cameraOn) },
        )
        if (state.cameraOn) {
            PlainButton(Icons.Rounded.Cameraswitch, "Switch camera") { PartyCallEngine.flipCamera() }
        }
        PlainButton(
            icon = if (showSelf) Icons.Rounded.Person else Icons.Rounded.PersonOff,
            description = if (showSelf) "Hide my video" else "Show my video",
            onClick = onToggleSelf,
        )
        PlainButton(Icons.Rounded.CloseFullscreen, "Minimize call", onClick = onMinimize)
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(CircleShape)
                .background(OffRed)
                .clickable { PartyCallEngine.leave() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Rounded.CallEnd, contentDescription = "Leave call", tint = Color.White, modifier = Modifier.size(18.dp))
        }
    }
}

/** On = plain white icon. Off = red circle with the crossed-out icon, so it's obvious. */
@Composable
private fun ToggleButton(
    on: Boolean,
    onIcon: ImageVector,
    offIcon: ImageVector,
    description: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(if (on) Color.Transparent else OffRed.copy(alpha = 0.9f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = if (on) onIcon else offIcon,
            contentDescription = description,
            tint = Color.White,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun PlainButton(icon: ImageVector, description: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = description, tint = Color.White, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun JoinButton(error: String?, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.End) {
        Row(
            modifier = Modifier
                .shadow(8.dp, RoundedCornerShape(50))
                .clip(RoundedCornerShape(50))
                .background(Glass)
                .clickable(onClick = onClick)
                .padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.VideoCall, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text("Join video call", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
        error?.let {
            Spacer(Modifier.height(6.dp))
            ErrorChip(it)
        }
    }
}

@Composable
private fun ErrorChip(message: String) {
    Text(
        text = message,
        color = Color.White,
        fontSize = 11.sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .widthIn(max = 220.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(OffRed.copy(alpha = 0.9f))
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

@Composable
private fun NameTag(tile: CallTile, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Color.Black.copy(alpha = 0.5f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!tile.micOn) {
            Icon(Icons.Rounded.MicOff, contentDescription = "Muted", tint = OffRed, modifier = Modifier.size(11.dp))
            Spacer(Modifier.width(3.dp))
        }
        Text(
            text = tile.name,
            color = Color.White,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 90.dp),
        )
    }
}

@Composable
private fun Avatar(name: String, size: Dp, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(AvatarBackground),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = name.trim().firstOrNull()?.uppercase() ?: "?",
            color = Color.White,
            fontSize = (size.value * 0.4f).sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun VideoSurface(tile: CallTile, modifier: Modifier) {
    val eglContext = PartyCallEngine.eglContext() ?: return
    val mirror = tile.isLocal && PartyCallEngine.isFrontCamera()
    key(tile.memberId) {
        AndroidView(
            factory = { CallVideoView(it) },
            update = { view -> view.bind(eglContext, tile.videoTrack, mirror) },
            onRelease = { view -> view.release() },
            modifier = modifier,
        )
    }
}
