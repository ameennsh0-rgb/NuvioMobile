package com.nuvio.app.features.party.call

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** A participant's published tracks, as listed by the call server's room registry. */
internal data class CallPeerInfo(
    val memberId: String,
    val name: String,
    val sessionId: String,
    val tracks: List<String>,
    val camera: Boolean,
    val mic: Boolean,
)

internal class CallServerException(message: String) : Exception(message)

/** Talks to the nuvio-call Cloudflare Worker (SFU proxy + room registry). */
internal class CallServer(
    private val baseUrl: String = PartyCallConfig.SERVER_URL,
    private val key: String = PartyCallConfig.KEY,
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    val configured: Boolean get() = baseUrl.isNotBlank()

    suspend fun newSession(): String {
        val response = send("POST", "/sfu/sessions/new", JSONObject())
        return response.optString("sessionId").takeIf { it.isNotBlank() }
            ?: throw CallServerException("No session id from call server")
    }

    /** Pushes local tracks with an offer; returns the SFU's answer SDP. */
    suspend fun pushTracks(sessionId: String, offerSdp: String, tracks: List<Pair<String, String>>): String {
        val body = JSONObject()
            .put("sessionDescription", JSONObject().put("type", "offer").put("sdp", offerSdp))
            .put("tracks", JSONArray().apply {
                tracks.forEach { (mid, name) ->
                    put(JSONObject().put("location", "local").put("mid", mid).put("trackName", name))
                }
            })
        val response = send("POST", "/sfu/sessions/$sessionId/tracks/new", body)
        checkTrackErrors(response)
        return response.optJSONObject("sessionDescription")?.optString("sdp")?.takeIf { it.isNotBlank() }
            ?: throw CallServerException("No answer from call server")
    }

    /** Asks the SFU to send us a peer's tracks. */
    suspend fun pullTracks(sessionId: String, remoteSessionId: String, trackNames: List<String>): PullResult {
        val body = JSONObject().put("tracks", JSONArray().apply {
            trackNames.forEach { name ->
                put(JSONObject().put("location", "remote").put("sessionId", remoteSessionId).put("trackName", name))
            }
        })
        val response = send("POST", "/sfu/sessions/$sessionId/tracks/new", body)
        val mids = linkedMapOf<String, String>()
        response.optJSONArray("tracks")?.let { array ->
            for (i in 0 until array.length()) {
                val track = array.optJSONObject(i) ?: continue
                if (track.has("errorCode")) continue
                val mid = track.optString("mid").takeIf { it.isNotBlank() } ?: continue
                val name = track.optString("trackName").takeIf { it.isNotBlank() } ?: trackNames.getOrNull(i) ?: continue
                mids[name] = mid
            }
        }
        val description = response.optJSONObject("sessionDescription")
        return PullResult(
            offerSdp = description?.takeIf { it.optString("type") == "offer" }?.optString("sdp"),
            requiresRenegotiation = response.optBoolean("requiresImmediateRenegotiation", false),
            mids = mids,
        )
    }

    suspend fun renegotiate(sessionId: String, answerSdp: String) {
        val body = JSONObject().put(
            "sessionDescription",
            JSONObject().put("type", "answer").put("sdp", answerSdp),
        )
        send("PUT", "/sfu/sessions/$sessionId/renegotiate", body)
    }

    suspend fun closeTracks(sessionId: String, mids: List<String>) {
        if (mids.isEmpty()) return
        val body = JSONObject()
            .put("force", true)
            .put("tracks", JSONArray().apply { mids.forEach { put(JSONObject().put("mid", it)) } })
        send("PUT", "/sfu/sessions/$sessionId/tracks/close", body)
    }

    suspend fun joinRoom(
        room: String,
        memberId: String,
        name: String,
        sessionId: String,
        tracks: List<String>,
        camera: Boolean,
        mic: Boolean,
    ): List<CallPeerInfo> {
        val body = JSONObject()
            .put("memberId", memberId)
            .put("name", name)
            .put("sessionId", sessionId)
            .put("tracks", JSONArray(tracks))
            .put("camera", camera)
            .put("mic", mic)
        return parsePeers(send("POST", "/rooms/${room.urlSafe()}/join", body))
    }

    suspend fun leaveRoom(room: String, memberId: String) {
        send("POST", "/rooms/${room.urlSafe()}/leave", JSONObject().put("memberId", memberId))
    }

    private fun parsePeers(response: JSONObject): List<CallPeerInfo> {
        val array = response.optJSONArray("peers") ?: return emptyList()
        return (0 until array.length()).mapNotNull { i ->
            val peer = array.optJSONObject(i) ?: return@mapNotNull null
            val tracks = peer.optJSONArray("tracks")?.let { t -> (0 until t.length()).map { t.optString(it) } }.orEmpty()
            CallPeerInfo(
                memberId = peer.optString("memberId"),
                name = peer.optString("name", "Guest"),
                sessionId = peer.optString("sessionId"),
                tracks = tracks.filter { it.isNotBlank() },
                camera = peer.optBoolean("camera", true),
                mic = peer.optBoolean("mic", true),
            ).takeIf { it.memberId.isNotBlank() && it.sessionId.isNotBlank() }
        }
    }

    private fun checkTrackErrors(response: JSONObject) {
        response.optString("errorCode").takeIf { it.isNotBlank() }?.let {
            throw CallServerException(response.optString("errorDescription", it))
        }
    }

    private suspend fun send(method: String, path: String, body: JSONObject): JSONObject =
        withContext(Dispatchers.IO) {
            if (!configured) throw CallServerException("Video call server is not set up in this build")
            val request = Request.Builder()
                .url(baseUrl + path)
                .method(method, body.toString().toRequestBody(jsonType))
                .apply { if (key.isNotBlank()) header("x-call-key", key) }
                .build()
            http.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw CallServerException("Call server error ${response.code}: ${text.take(200)}")
                }
                if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        }

    private fun String.urlSafe(): String = filter { it.isLetterOrDigit() || it == '-' || it == '_' }

    data class PullResult(
        val offerSdp: String?,
        val requiresRenegotiation: Boolean,
        /** trackName -> mid, for the tracks the SFU accepted. */
        val mids: Map<String, String>,
    )
}
