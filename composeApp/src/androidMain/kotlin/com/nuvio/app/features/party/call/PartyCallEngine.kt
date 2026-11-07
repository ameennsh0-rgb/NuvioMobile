package com.nuvio.app.features.party.call

import android.content.Context
import android.media.AudioAttributes
import android.util.Log
import com.nuvio.app.features.party.PartyRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One person's tile in the call bubble. */
internal data class CallTile(
    val memberId: String,
    val name: String,
    val isLocal: Boolean,
    val videoTrack: VideoTrack?,
    val cameraOn: Boolean,
    val micOn: Boolean,
)

internal data class CallUiState(
    val phase: Phase = Phase.Idle,
    val micOn: Boolean = true,
    val cameraOn: Boolean = true,
    val tiles: List<CallTile> = emptyList(),
    val error: String? = null,
) {
    enum class Phase { Idle, Connecting, Connected }
}

/**
 * Runs the watch party video call: one WebRTC connection to the Cloudflare SFU that
 * sends our camera + mic and receives everyone else's.
 *
 * Audio is played as media (not as a phone call), so Android does not duck or pause
 * the movie and the call follows the media volume.
 */
internal object PartyCallEngine {
    private const val TAG = "PartyCall"
    private const val AUDIO_TRACK = "a"
    private const val VIDEO_TRACK = "v"
    private const val HEARTBEAT_MS = 4_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val negotiation = Mutex()
    private val server = CallServer()

    private val _state = MutableStateFlow(CallUiState())
    val state: StateFlow<CallUiState> = _state.asStateFlow()

    val isConfigured: Boolean get() = server.configured

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null

    private var room: String? = null
    private var memberId: String? = null
    private var displayName: String = "Guest"

    private var peerConnection: PeerConnection? = null
    private var sessionId: String? = null
    private var capturer: CameraVideoCapturer? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var localVideo: VideoTrack? = null
    private var localAudio: AudioTrack? = null
    private var usingFrontCamera = true

    /** memberId -> pulled remote peer */
    private val remotes = mutableMapOf<String, RemotePeer>()
    private var sessionJob: Job? = null

    private class RemotePeer(
        val info: CallPeerInfo,
        /** trackName -> mid of the tracks we receive from this person. */
        val pulled: Map<String, String>,
    ) {
        val mids: List<String> get() = pulled.values.toList()
    }

    /** Room we are in or joining; set synchronously so party changes can be checked right away. */
    @Volatile private var targetRoom: String? = null
    private var partyWatcher: Job? = null

    fun eglContext(): EglBase.Context? = eglBase?.eglBaseContext

    /** Leaves the call if the watch party ended or we moved to another party. */
    fun onPartyChanged(partyId: String?) {
        val current = targetRoom ?: return
        if (current != partyId) leave()
    }

    private fun watchParty() {
        if (partyWatcher != null) return
        partyWatcher = scope.launch {
            PartyRepository.state
                .map { it.party?.id }
                .distinctUntilChanged()
                .collect { onPartyChanged(it) }
        }
    }

    fun join(context: Context, roomId: String, member: String, name: String) {
        if (room == roomId && memberId == member && _state.value.phase != CallUiState.Phase.Idle) return
        val appContext = context.applicationContext
        targetRoom = roomId
        watchParty()
        val previous = sessionJob
        sessionJob = scope.launch {
            previous?.cancelAndJoin()
            if (room != null) teardown()
            room = roomId
            memberId = member
            displayName = name
            _state.update { it.copy(phase = CallUiState.Phase.Connecting, error = null) }
            try {
                connect(appContext)
                _state.update { it.copy(phase = CallUiState.Phase.Connected) }
                heartbeatLoop()
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                Log.w(TAG, "call failed", error)
                withContext(NonCancellable) { teardown() }
                targetRoom = null
                _state.update {
                    CallUiState(error = error.message ?: "Couldn't connect the call")
                }
            }
        }
    }

    fun leave() {
        targetRoom = null
        val job = sessionJob
        sessionJob = null
        scope.launch {
            job?.cancelAndJoin()
            teardown()
            _state.value = CallUiState(micOn = _state.value.micOn, cameraOn = _state.value.cameraOn)
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    fun setMic(on: Boolean) {
        localAudio?.setEnabled(on)
        _state.update { it.copy(micOn = on) }
        refreshTiles()
    }

    fun setCamera(on: Boolean) {
        localVideo?.setEnabled(on)
        runCatching {
            if (on) capturer?.startCapture(640, 480, 15) else capturer?.stopCapture()
        }
        _state.update { it.copy(cameraOn = on) }
        refreshTiles()
    }

    fun flipCamera() {
        capturer?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                usingFrontCamera = isFrontCamera
                refreshTiles()
            }

            override fun onCameraSwitchError(errorDescription: String?) = Unit
        })
    }

    fun isFrontCamera(): Boolean = usingFrontCamera

    // region connection

    private fun ensureFactory(context: Context): PeerConnectionFactory {
        factory?.let { return it }
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
        )
        val egl = EglBase.create().also { eglBase = it }
        val audioModule = JavaAudioDeviceModule.builder(context)
            // Software echo cancellation; works the same on every device.
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(true)
            // Play the call as media so the movie is not ducked or paused.
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .createAudioDeviceModule()
        return PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
            .also { factory = it }
    }

    private suspend fun connect(context: Context) {
        val factory = ensureFactory(context)
        val state = _state.value

        // Local media
        val audio = factory.createAudioSource(MediaConstraints()).also { audioSource = it }
        localAudio = factory.createAudioTrack("local-audio", audio).apply { setEnabled(state.micOn) }

        val enumerator = Camera2Enumerator(context)
        val cameraName = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
        if (cameraName != null) {
            usingFrontCamera = enumerator.isFrontFacing(cameraName)
            val source = factory.createVideoSource(false).also { videoSource = it }
            val helper = SurfaceTextureHelper.create("PartyCallCamera", eglBase!!.eglBaseContext).also { surfaceHelper = it }
            capturer = enumerator.createCapturer(cameraName, null).apply {
                initialize(helper, context, source.capturerObserver)
                if (state.cameraOn) startCapture(640, 480, 15)
            }
            localVideo = factory.createVideoTrack("local-video", source).apply { setEnabled(state.cameraOn) }
        }
        refreshTiles()

        // One connection to the SFU
        val config = PeerConnection.RTCConfiguration(
            listOf(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()),
        ).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
        }
        val pc = factory.createPeerConnection(config, ConnectionObserver)
            ?: throw CallServerException("Couldn't start the call connection")
        peerConnection = pc

        val sendOnly = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY)
        val audioTransceiver = pc.addTransceiver(localAudio, sendOnly)
        val videoTransceiver = localVideo?.let { pc.addTransceiver(it, sendOnly) }

        val session = server.newSession().also { sessionId = it }
        negotiation.withLock {
            val offer = pc.awaitCreateOffer()
            pc.awaitSetLocal(offer)
            val tracks = buildList {
                add(audioTransceiver.mid to AUDIO_TRACK)
                videoTransceiver?.let { add(it.mid to VIDEO_TRACK) }
            }
            val answer = server.pushTracks(session, pc.localDescription?.description ?: offer.description, tracks)
            pc.awaitSetRemote(SessionDescription(SessionDescription.Type.ANSWER, answer))
        }
    }

    private suspend fun heartbeatLoop() {
        while (true) {
            val session = sessionId ?: return
            val roomId = room ?: return
            val me = memberId ?: return
            val published = buildList {
                add(AUDIO_TRACK)
                if (localVideo != null) add(VIDEO_TRACK)
            }
            val peers = runCatching {
                server.joinRoom(
                    room = roomId,
                    memberId = me,
                    name = displayName,
                    sessionId = session,
                    tracks = published,
                    camera = _state.value.cameraOn,
                    mic = _state.value.micOn,
                )
            }.onFailure { Log.w(TAG, "room heartbeat failed", it) }.getOrNull()
            if (peers != null) syncPeers(peers.filter { it.memberId != me })
            delay(HEARTBEAT_MS)
        }
    }

    private suspend fun syncPeers(peers: List<CallPeerInfo>) {
        val pc = peerConnection ?: return
        val session = sessionId ?: return
        val byId = peers.associateBy { it.memberId }

        // People who left, or rejoined with a new session
        val gone = remotes.filter { (id, remote) -> byId[id]?.sessionId != remote.info.sessionId }
        gone.forEach { (id, remote) ->
            remotes.remove(id)
            runCatching { server.closeTracks(session, remote.mids) }
        }

        // Status changes (camera/mic toggles, names)
        peers.forEach { info ->
            remotes[info.memberId]?.let { existing ->
                if (existing.info != info) remotes[info.memberId] = RemotePeer(info, existing.pulled)
            }
        }

        // New people, and tracks we couldn't get last time (e.g. a camera that wasn't ready yet)
        peers.forEach { info ->
            val have = remotes[info.memberId]?.pulled.orEmpty()
            val missing = info.tracks.filter { it !in have }
            if (missing.isEmpty()) {
                if (info.memberId !in remotes) remotes[info.memberId] = RemotePeer(info, have)
                return@forEach
            }
            runCatching { pull(pc, session, info, missing, have) }
                .onFailure {
                    Log.w(TAG, "couldn't pull ${info.memberId}", it)
                    if (info.memberId !in remotes) remotes[info.memberId] = RemotePeer(info, have)
                }
        }
        refreshTiles()
    }

    private suspend fun pull(
        pc: PeerConnection,
        session: String,
        info: CallPeerInfo,
        trackNames: List<String>,
        already: Map<String, String>,
    ) {
        negotiation.withLock {
            val result = server.pullTracks(session, info.sessionId, trackNames)
            Log.i(TAG, "pulled ${info.name}: asked $trackNames, got ${result.mids}")
            if (result.requiresRenegotiation && result.offerSdp != null) {
                pc.awaitSetRemote(SessionDescription(SessionDescription.Type.OFFER, result.offerSdp))
                val answer = pc.awaitCreateAnswer()
                pc.awaitSetLocal(answer)
                server.renegotiate(session, pc.localDescription?.description ?: answer.description)
            }
            remotes[info.memberId] = RemotePeer(info, already + result.mids)
        }
    }

    /** Finds the video track we receive from [remote], if it has arrived. */
    private fun remoteVideo(remote: RemotePeer): VideoTrack? {
        val pc = peerConnection ?: return null
        val mid = remote.pulled[VIDEO_TRACK] ?: return null
        return runCatching {
            pc.transceivers.firstOrNull { it.mid == mid }?.receiver?.track() as? VideoTrack
        }.getOrNull()
    }

    private suspend fun teardown() {
        val roomId = room
        val me = memberId
        if (roomId != null && me != null) {
            runCatching { server.leaveRoom(roomId, me) }
        }
        remotes.clear()
        room = null
        memberId = null
        sessionId = null
        runCatching { capturer?.stopCapture() }
        capturer?.dispose()
        capturer = null
        surfaceHelper?.dispose()
        surfaceHelper = null
        peerConnection?.dispose()
        peerConnection = null
        localVideo = null
        localAudio = null
        videoSource?.dispose()
        videoSource = null
        audioSource?.dispose()
        audioSource = null
        _state.update { it.copy(tiles = emptyList()) }
    }

    private fun refreshTiles() {
        val local = CallTile(
            memberId = memberId ?: "me",
            name = "You",
            isLocal = true,
            videoTrack = localVideo,
            cameraOn = _state.value.cameraOn && localVideo != null,
            micOn = _state.value.micOn,
        )
        val others = remotes.values.map { remote ->
            val video = remoteVideo(remote)
            CallTile(
                memberId = remote.info.memberId,
                name = remote.info.name,
                isLocal = false,
                videoTrack = video,
                cameraOn = remote.info.camera && video != null,
                micOn = remote.info.mic,
            )
        }.sortedBy { it.name.lowercase() }
        _state.update { it.copy(tiles = listOf(local) + others) }
    }

    // endregion

    // region WebRTC callback helpers

    private object ConnectionObserver : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            if (state == PeerConnection.IceConnectionState.FAILED) {
                Log.w(TAG, "ICE failed")
                _state.update { it.copy(error = "Call connection lost") }
            }
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) = Unit
        override fun onIceCandidate(candidate: IceCandidate?) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
        override fun onAddStream(stream: MediaStream?) = Unit
        override fun onRemoveStream(stream: MediaStream?) = Unit
        override fun onDataChannel(channel: DataChannel?) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit
    }

    private suspend fun PeerConnection.awaitCreateOffer(): SessionDescription =
        suspendCancellableCoroutine { cont ->
            createOffer(sdpCallback(cont), MediaConstraints())
        }

    private suspend fun PeerConnection.awaitCreateAnswer(): SessionDescription =
        suspendCancellableCoroutine { cont ->
            createAnswer(sdpCallback(cont), MediaConstraints())
        }

    private suspend fun PeerConnection.awaitSetLocal(description: SessionDescription) =
        suspendCancellableCoroutine { cont -> setLocalDescription(setCallback(cont), description) }

    private suspend fun PeerConnection.awaitSetRemote(description: SessionDescription) =
        suspendCancellableCoroutine { cont -> setRemoteDescription(setCallback(cont), description) }

    private fun sdpCallback(cont: kotlinx.coroutines.CancellableContinuation<SessionDescription>) =
        object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                if (cont.isActive) cont.resume(description)
            }
            override fun onCreateFailure(error: String?) {
                if (cont.isActive) cont.resumeWithException(CallServerException(error ?: "SDP create failed"))
            }
            override fun onSetSuccess() = Unit
            override fun onSetFailure(error: String?) = Unit
        }

    private fun setCallback(cont: kotlinx.coroutines.CancellableContinuation<Unit>) =
        object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription?) = Unit
            override fun onCreateFailure(error: String?) = Unit
            override fun onSetSuccess() {
                if (cont.isActive) cont.resume(Unit)
            }
            override fun onSetFailure(error: String?) {
                if (cont.isActive) cont.resumeWithException(CallServerException(error ?: "SDP set failed"))
            }
        }

    // endregion
}
