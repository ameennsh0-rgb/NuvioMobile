// The browser watch-together + video-call page, served at /watch.
//
// It joins the same call rooms as the phones (same SFU proxy and /rooms API),
// so a web user and a phone user in the same room see and hear each other.
// The shared movie is a plain <video> kept in sync over a WebSocket; the camera
// call is peer-to-peer WebRTC through the Cloudflare SFU.

export function watchPage() {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="data:,">
<title>Nuvio Watch Together</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js"></script>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0b0b0f;color:#e9e9ee;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
button{font-family:inherit;cursor:pointer}
#join{min-height:100%;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:380px;background:#15151c;border:1px solid #23232c;border-radius:18px;padding:24px}
.card h1{font-size:20px;margin:0 0 4px}.card p{color:#9a9aa5;font-size:13px;margin:0 0 18px}
label{display:block;font-size:12px;color:#9a9aa5;margin:12px 0 5px}
input[type=text]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #2c2c37;background:#101016;color:#fff;font-size:15px}
.primary{margin-top:20px;width:100%;padding:13px;border:0;border-radius:999px;background:#3dd68c;color:#0b0b0f;font-weight:700;font-size:15px}
#app{display:none;height:100%;flex-direction:column}
.top{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #1d1d25;background:#101016}
.top .room{font-weight:700}.top .muted{color:#8a8a95;font-size:12px}
.top .spacer{flex:1}
.stage{flex:1;display:flex;min-height:0}
.main{flex:1;display:flex;flex-direction:column;min-width:0;padding:12px;gap:10px}
.urlbar{display:flex;gap:8px}
.urlbar input{flex:1;padding:10px 12px;border-radius:10px;border:1px solid #2c2c37;background:#101016;color:#fff;font-size:13px}
.urlbar button{padding:0 14px;border:0;border-radius:10px;background:#2b2b35;color:#fff;font-weight:600;font-size:13px}
.player{flex:1;background:#000;border-radius:14px;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:0}
.player video{width:100%;height:100%;background:#000}
.empty{color:#6a6a75;font-size:14px;text-align:center;padding:20px}
.side{width:200px;border-left:1px solid #1d1d25;display:flex;flex-direction:column;background:#0d0d12}
.tiles{display:flex;flex-wrap:wrap;gap:8px;padding:10px;overflow:auto}
.tile{position:relative;width:88px;height:116px;border-radius:12px;overflow:hidden;background:#20202a}
.tile video{width:100%;height:100%;object-fit:cover}
.tile .av{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#cfcfd6}
.tile .nm{position:absolute;left:4px;bottom:4px;right:4px;font-size:10px;background:rgba(0,0,0,.55);border-radius:6px;padding:2px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .mute{color:#e5484d;margin-right:3px}
.chat{flex:1;display:flex;flex-direction:column;border-top:1px solid #1d1d25;min-height:0}
.msgs{flex:1;overflow:auto;padding:8px 10px;font-size:13px;display:flex;flex-direction:column;gap:6px}
.msgs .m b{color:#3dd68c}
.chatbar{display:flex;gap:6px;padding:8px;border-top:1px solid #1d1d25}
.chatbar input{flex:1;padding:8px 10px;border-radius:8px;border:1px solid #2c2c37;background:#101016;color:#fff;font-size:13px}
.controls{display:flex;gap:8px;justify-content:center;padding:10px;border-top:1px solid #1d1d25;background:#101016}
.ctl{width:44px;height:44px;border-radius:50%;border:0;background:#26262f;color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center}
.ctl.off{background:#e5484d}.ctl.leave{background:#e5484d}
.status{font-size:12px;color:#8a8a95;text-align:center;padding:4px}
@media(max-width:720px){.stage{flex-direction:column}.side{width:auto;border-left:0;border-top:1px solid #1d1d25;max-height:46%}.tiles{max-height:130px}}
</style>
</head>
<body>
<div id="join">
  <div class="card">
    <h1>Watch Together</h1>
    <p>Join a room to watch in sync and video call. Share the room name with friends — phone or web, same room.</p>
    <label>Your name</label>
    <input type="text" id="name" placeholder="Name" autocomplete="off">
    <label>Room name</label>
    <input type="text" id="room" placeholder="e.g. movie-night" autocomplete="off">
    <button class="primary" id="joinBtn">Join</button>
    <div class="status" id="joinStatus"></div>
  </div>
</div>

<div id="app">
  <div class="top">
    <span class="room" id="roomLabel"></span>
    <span class="muted" id="peerCount"></span>
    <span class="spacer"></span>
    <span class="muted" id="status"></span>
  </div>
  <div class="stage">
    <div class="main">
      <div class="urlbar">
        <input type="text" id="url" placeholder="Paste a video link (.mp4 or .m3u8) to play for everyone">
        <button id="loadBtn">Play for all</button>
      </div>
      <div class="player">
        <video id="shared" playsinline controls></video>
        <div class="empty" id="playerEmpty">No video yet. Paste a link above and it plays for everyone in sync.</div>
      </div>
    </div>
    <div class="side">
      <div class="tiles" id="tiles"></div>
      <div class="chat">
        <div class="msgs" id="msgs"></div>
        <div class="chatbar">
          <input type="text" id="chatInput" placeholder="Message" autocomplete="off">
          <button class="ctl" id="chatSend" style="width:40px;height:40px">&#10148;</button>
        </div>
      </div>
    </div>
  </div>
  <div class="controls">
    <button class="ctl" id="micBtn" title="Mute">&#127908;</button>
    <button class="ctl" id="camBtn" title="Camera">&#128247;</button>
    <button class="ctl leave" id="leaveBtn" title="Leave">&#128379;</button>
  </div>
</div>

<script>
(function(){
  var API = location.origin;
  var WSBASE = location.origin.replace(/^http/, "ws");
  var room, myName, memberId, sessionId, pc, localStream, ws, presenceTimer, syncTimer;
  var camOn = true, micOn = true, applyingState = false, left = false;
  var mediaNote = "";
  var remotes = {};
  var lock = Promise.resolve();
  var video;

  function $(id){ return document.getElementById(id); }
  function rid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
  function setStatus(t){ $("status").textContent = t || ""; }
  function withLock(fn){ var run = lock.then(fn, fn); lock = run.then(function(){}, function(){}); return run; }

  async function api(method, path, body){
    var opt = { method: method, headers: { "content-type": "application/json" } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    var r = await fetch(API + path, opt);
    var t = await r.text();
    if (!r.ok) throw new Error(path + " -> " + r.status + " " + t.slice(0,120));
    return t ? JSON.parse(t) : {};
  }

  async function join(){
    room = $("room").value.trim().replace(/[^A-Za-z0-9_-]/g, "");
    myName = $("name").value.trim() || "Guest";
    if (!room){ $("joinStatus").textContent = "Enter a room name."; return; }
    memberId = rid();
    $("join").style.display = "none";
    $("app").style.display = "flex";
    $("roomLabel").textContent = room;
    video = $("shared");
    wireVideo();
    wireChat();
    // Watch-together sync is the primary feature and runs even if the call fails.
    connectSync();
    setStatus("Starting camera...");
    await startMedia();
    // The video call is best-effort: a camera/SFU problem must not stop the movie.
    try{
      setStatus("Connecting call...");
      await withLock(connectSfu);
      setStatus(mediaNote);
    }catch(e){
      console.warn("call unavailable", e);
      setStatus("Call unavailable" + (mediaNote ? " - " + mediaNote : ""));
    }
    try{
      await heartbeat();
      presenceTimer = setInterval(heartbeat, 4000);
    }catch(_){}
  }

  async function startMedia(){
    // Try camera+mic, then mic only, then camera only, so a PC without a
    // camera still sends audio. Never fail the join; report what happened.
    var attempts = [
      { video: { width: 640, height: 480 }, audio: true },
      { audio: true },
      { video: { width: 640, height: 480 } }
    ];
    var lastErr = null;
    localStream = null;
    for (var i = 0; i < attempts.length && !localStream; i++){
      try{
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("getUserMedia unavailable (needs HTTPS)");
        localStream = await navigator.mediaDevices.getUserMedia(attempts[i]);
      }catch(e){
        lastErr = e;
        if (e && e.name === "NotAllowedError") break; // user/browser blocked it; retrying won't help
      }
    }
    if (!localStream){
      localStream = new MediaStream();
      camOn = false; micOn = false;
      mediaNote = "No mic/camera: " + ((lastErr && (lastErr.name || lastErr.message)) || "unknown") + ". Joined watch-only; nothing is sent or recorded.";
    }else{
      micOn = localStream.getAudioTracks().length > 0;
      camOn = localStream.getVideoTracks().length > 0;
      if (!camOn && micOn) mediaNote = "No camera found. Joined with microphone only.";
      else if (!micOn && camOn) mediaNote = "No microphone found. Joined with camera only.";
    }
    setStatus(mediaNote);
    addTile({ memberId: memberId, name: myName + " (you)", camera: camOn, mic: micOn }, localStream, true);
  }

  async function connectSfu(){
    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle"
    });
    pc.oniceconnectionstatechange = function(){
      if (pc.iceConnectionState === "failed") setStatus("Call connection problem");
    };
    var audioTrack = localStream.getAudioTracks()[0];
    var videoTrack = localStream.getVideoTracks()[0];
    var txA = pc.addTransceiver(audioTrack || "audio", { direction: "sendonly" });
    var txV = pc.addTransceiver(videoTrack || "video", { direction: "sendonly" });
    var s = await api("POST", "/sfu/sessions/new", {});
    sessionId = s.sessionId;
    await pc.setLocalDescription(await pc.createOffer());
    var tracks = [];
    if (txA.mid != null) tracks.push({ location: "local", mid: txA.mid, trackName: "a" });
    if (txV.mid != null) tracks.push({ location: "local", mid: txV.mid, trackName: "v" });
    var res = await api("POST", "/sfu/sessions/" + sessionId + "/tracks/new", {
      sessionDescription: { type: "offer", sdp: pc.localDescription.sdp },
      tracks: tracks
    });
    await pc.setRemoteDescription({ type: "answer", sdp: res.sessionDescription.sdp });
  }

  function pullPeer(peer){
    return withLock(async function(){
      var names = ["a", "v"];
      var res = await api("POST", "/sfu/sessions/" + sessionId + "/tracks/new", {
        tracks: names.map(function(n){ return { location: "remote", sessionId: peer.sessionId, trackName: n }; })
      });
      if (res.requiresImmediateRenegotiation && res.sessionDescription){
        await pc.setRemoteDescription({ type: "offer", sdp: res.sessionDescription.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await api("PUT", "/sfu/sessions/" + sessionId + "/renegotiate", {
          sessionDescription: { type: "answer", sdp: pc.localDescription.sdp }
        });
      }
      var list = res.tracks || [];
      var stream = new MediaStream();
      list.forEach(function(t){
        if (t.errorCode || !t.mid) return;
        var tx = pc.getTransceivers().find(function(x){ return x.mid === t.mid; });
        if (tx && tx.receiver && tx.receiver.track) stream.addTrack(tx.receiver.track);
      });
      return stream;
    });
  }

  async function heartbeat(){
    if (left) return;
    try{
      var res = await api("POST", "/rooms/" + encodeURIComponent(room) + "/join", {
        memberId: memberId, name: myName, sessionId: sessionId,
        tracks: ["a", "v"], camera: camOn, mic: micOn
      });
      await reconcile(res.peers || []);
    }catch(e){ console.warn("heartbeat", e.message); }
  }

  async function reconcile(peers){
    var seen = {};
    for (var i = 0; i < peers.length; i++){
      var p = peers[i];
      if (!p || p.memberId === memberId) continue;
      seen[p.memberId] = true;
      if (!remotes[p.memberId]){
        remotes[p.memberId] = { info: p };
        try{
          var stream = await pullPeer(p);
          remotes[p.memberId].stream = stream;
          addTile(p, stream, false);
        }catch(e){ console.warn("pull", e.message); }
      } else {
        remotes[p.memberId].info = p;
        updateTile(p);
      }
    }
    Object.keys(remotes).forEach(function(id){
      if (!seen[id]){ removeTile(id); delete remotes[id]; }
    });
    var n = Object.keys(remotes).length + 1;
    $("peerCount").textContent = n + (n === 1 ? " person" : " people");
  }

  // ---- tiles ----
  function tileId(id){ return "tile-" + id; }
  function addTile(info, stream, isSelf){
    var exists = $(tileId(info.memberId));
    if (exists) exists.remove();
    var el = document.createElement("div");
    el.className = "tile"; el.id = tileId(info.memberId);
    var hasVideo = stream && stream.getVideoTracks && stream.getVideoTracks().length > 0;
    var v = document.createElement("video");
    v.autoplay = true; v.playsInline = true; v.muted = !!isSelf;
    if (stream) v.srcObject = stream;
    el.appendChild(v);
    var av = document.createElement("div");
    av.className = "av"; av.textContent = (info.name || "?").trim().charAt(0).toUpperCase();
    av.style.display = (info.camera === false || !hasVideo) ? "flex" : "none";
    el.appendChild(av);
    var nm = document.createElement("div");
    nm.className = "nm"; nm.innerHTML = (info.mic === false ? '<span class="mute">&#128263;</span>' : "") + escapeHtml(info.name || "Guest");
    el.appendChild(nm);
    $("tiles").appendChild(el);
    v.play().catch(function(){});
  }
  function updateTile(info){
    var el = $(tileId(info.memberId)); if (!el) return;
    var v = el.querySelector("video");
    var hasVideo = v && v.srcObject && v.srcObject.getVideoTracks().length > 0;
    el.querySelector(".av").style.display = (info.camera === false || !hasVideo) ? "flex" : "none";
    el.querySelector(".nm").innerHTML = (info.mic === false ? '<span class="mute">&#128263;</span>' : "") + escapeHtml(info.name || "Guest");
  }
  function removeTile(id){ var el = $(tileId(id)); if (el) el.remove(); }

  // ---- shared video sync ----
  function wireVideo(){
    video.addEventListener("play", broadcastState);
    video.addEventListener("pause", broadcastState);
    video.addEventListener("seeked", broadcastState);
    $("loadBtn").onclick = function(){
      var u = $("url").value.trim();
      if (!u) return;
      loadVideo(u);
      video.play().catch(function(){});
      broadcastState();
    };
    syncTimer = setInterval(function(){ if (video && !video.paused) broadcastState(); }, 3000);
  }
  function loadVideo(url){
    $("playerEmpty").style.display = "none";
    video.dataset.url = url;
    if (window.Hls && Hls.isSupported() && /\\.m3u8(\\?|$)/i.test(url)){
      if (window._hls){ try{ window._hls.destroy(); }catch(_){} }
      window._hls = new Hls();
      window._hls.loadSource(url);
      window._hls.attachMedia(video);
    } else {
      if (window._hls){ try{ window._hls.destroy(); }catch(_){} window._hls = null; }
      video.src = url;
    }
  }
  function connectSync(){
    ws = new WebSocket(WSBASE + "/rooms/" + encodeURIComponent(room) + "/sync");
    ws.onmessage = function(e){
      var m; try{ m = JSON.parse(e.data); }catch(_){ return; }
      if (m.type === "state") applyState(m);
      else if (m.type === "chat") addChat(m.name, m.text);
    };
    ws.onclose = function(){ if (!left) setTimeout(connectSync, 2000); };
  }
  function applyState(m){
    applyingState = true;
    try{
      if (m.url && m.url !== video.dataset.url) loadVideo(m.url);
      if (m.paused){
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - m.time) > 0.5) video.currentTime = m.time;
      } else {
        var expected = m.time + (Date.now() - m.at) / 1000;
        if (Math.abs(video.currentTime - expected) > 1.5) video.currentTime = expected;
        if (video.paused) video.play().catch(function(){});
      }
    } finally {
      setTimeout(function(){ applyingState = false; }, 350);
    }
  }
  function broadcastState(){
    if (applyingState || !ws || ws.readyState !== 1 || !video.dataset.url) return;
    ws.send(JSON.stringify({ type: "state", url: video.dataset.url || null, paused: video.paused, time: video.currentTime, by: myName }));
  }

  // ---- chat ----
  function wireChat(){
    $("chatSend").onclick = sendChat;
    $("chatInput").addEventListener("keydown", function(e){ if (e.key === "Enter") sendChat(); });
  }
  function sendChat(){
    var t = $("chatInput").value.trim();
    if (!t || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", name: myName, text: t }));
    addChat(myName, t);
    $("chatInput").value = "";
  }
  function addChat(name, text){
    var m = document.createElement("div");
    m.className = "m";
    m.innerHTML = "<b>" + escapeHtml(name) + ":</b> " + escapeHtml(text);
    var box = $("msgs"); box.appendChild(m); box.scrollTop = box.scrollHeight;
  }

  // ---- controls ----
  function toggleMic(){
    micOn = !micOn;
    localStream.getAudioTracks().forEach(function(t){ t.enabled = micOn; });
    $("micBtn").className = "ctl" + (micOn ? "" : " off");
    $("micBtn").innerHTML = micOn ? "&#127908;" : "&#128263;";
    updateTile({ memberId: memberId, name: myName + " (you)", camera: camOn, mic: micOn });
  }
  function toggleCam(){
    camOn = !camOn;
    localStream.getVideoTracks().forEach(function(t){ t.enabled = camOn; });
    $("camBtn").className = "ctl" + (camOn ? "" : " off");
    var el = $(tileId(memberId)); if (el) el.querySelector(".av").style.display = camOn ? "none" : "flex";
  }
  async function leave(){
    left = true;
    clearInterval(presenceTimer); clearInterval(syncTimer);
    try{ if (ws) ws.close(); }catch(_){}
    try{ if (pc) pc.close(); }catch(_){}
    try{ localStream.getTracks().forEach(function(t){ t.stop(); }); }catch(_){}
    try{ navigator.sendBeacon && navigator.sendBeacon("/rooms/" + encodeURIComponent(room) + "/leave", JSON.stringify({ memberId: memberId })); }catch(_){}
    location.reload();
  }

  function escapeHtml(t){ var d = document.createElement("div"); d.textContent = t == null ? "" : String(t); return d.innerHTML; }

  // ---- wire up ----
  $("joinBtn").onclick = join;
  $("room").addEventListener("keydown", function(e){ if (e.key === "Enter") join(); });
  $("micBtn").onclick = toggleMic;
  $("camBtn").onclick = toggleCam;
  $("leaveBtn").onclick = leave;
  window.addEventListener("beforeunload", function(){
    try{ navigator.sendBeacon && navigator.sendBeacon("/rooms/" + encodeURIComponent(room || "") + "/leave", JSON.stringify({ memberId: memberId })); }catch(_){}
  });

  // Prefill room from ?room=
  var q = new URLSearchParams(location.search);
  if (q.get("room")) $("room").value = q.get("room");
})();
</script>
</body>
</html>`;
