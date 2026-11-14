// Nuvio call archiver.
//
// Small HTTP service that records a participant's Cloudflare Realtime SFU
// tracks to .webm and uploads them to R2 through the nuvio-call Worker, where
// /admin shows them for 48 hours (the bucket's lifecycle rule deletes them).
//
//   GET  /health                      -> {ok, active, ...}
//   POST /wake   (x-recorder-secret)  -> start recording one SFU session
//        body: {room, sessionId, memberId?, name?, tracks?: [trackName]}
//
// The Worker sends /wake whenever someone joins a room, so every participant
// session is recorded as its own file (the Worker repeats it about once a
// minute; repeats for a session that is already recording are ignored).
//
// How it works, per session:
//   1. GET  <WORKER_URL>/admin/api/sfu/sessions/:id        find active tracks
//   2. POST .../sessions/new + .../tracks/new               pull them (remote)
//   3. werift (WebRTC) answers the SFU's offer, receives RTP
//   4. RTP is forwarded over local UDP to ffmpeg, which muxes .webm segments
//      into /tmp (segments keep every upload under the Workers 100 MB body cap)
//   5. every 4s the SFU session is polled; finished segments are uploaded with
//      PUT <WORKER_URL>/admin/api/recordings/:filename and deleted
//   6. when the session ends the rest is uploaded and the temp dir removed
//
// Environment:
//   WORKER_URL        https://nuvio-call.<subdomain>.workers.dev   (required)
//   RECORDER_SECRET   same value as the Worker's RECORDER_SECRET   (required)
//   PORT              default 10000
//   SEGMENT_SECONDS   default 240 (length of each uploaded .webm part)
//   MAX_CONCURRENT    default 6 (simultaneous recordings)
//   MAX_SESSION_HOURS default 6

import http from "node:http";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection } from "werift";

const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const SECRET = process.env.RECORDER_SECRET || "";
const PORT = Number(process.env.PORT || 10000);
const SEGMENT_SECONDS = Math.max(30, Number(process.env.SEGMENT_SECONDS || 240));
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT || 6));
const MAX_SESSION_MS = Math.max(0.1, Number(process.env.MAX_SESSION_HOURS || 6)) * 3600_000;

const POLL_MS = 4000;
const STALL_MS = 30_000; // no RTP for this long => treat the session as over
const MAX_UPLOAD_BYTES = 99 * 1024 * 1024; // Workers request-body cap is 100 MB
const SESSION_ID_RE = /^[A-Za-z0-9_.-]{6,128}$/;

const active = new Map(); // sfu sessionId -> recording state
let rejected = 0; // /wake calls turned away because every slot was busy

// Recent log lines are also kept in memory so they can be read from GET /logs.
const recentLogs = [];
const log = (...args) => {
  const line = [new Date().toISOString(), ...args].join(" ");
  recentLogs.push(line);
  if (recentLogs.length > 300) recentLogs.shift();
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Worker API

async function workerFetch(pathname, init = {}) {
  return fetch(WORKER_URL + pathname, {
    ...init,
    headers: { "x-recorder-secret": SECRET, ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(20_000),
  });
}

async function sfu(method, p, body) {
  const res = await workerFetch(`/admin/api/sfu/sessions${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {}
  if (!res.ok || data.errorCode) {
    throw Object.assign(new Error(data.errorDescription || data.error || `HTTP ${res.status}`), {
      status: res.status,
    });
  }
  return data;
}

const activeLocalTracks = (info) =>
  (info.tracks || []).filter((t) => t.location === "local" && t.status === "active" && t.trackName);

// ------------------------------------------------------- ffmpeg (SDP + args)

export function buildSdp(streams) {
  const lines = ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=nuvio-recorder", "c=IN IP4 127.0.0.1", "t=0 0"];
  for (const s of streams) {
    lines.push(`m=${s.kind} ${s.port} RTP/AVP ${s.pt}`);
    lines.push(`a=rtpmap:${s.pt} ${s.encoding}/${s.clockRate}${s.channels ? "/" + s.channels : ""}`);
    if (s.fmtp) lines.push(`a=fmtp:${s.pt} ${s.fmtp}`);
    lines.push("a=recvonly");
  }
  return lines.join("\r\n") + "\r\n";
}

export function ffmpegArgs(sdpPath, streams, outPattern, segmentSeconds) {
  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-protocol_whitelist", "file,udp,rtp",
    "-analyzeduration", "8000000", "-probesize", "8000000",
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-i", sdpPath,
    "-map", "0",
  ];
  const video = streams.find((s) => s.kind === "video");
  const audio = streams.find((s) => s.kind === "audio");
  // WebM holds VP8/VP9 and Opus as-is. Anything else (e.g. H.264) is re-encoded.
  if (video) {
    if (["VP8", "VP9"].includes(video.encoding.toUpperCase())) args.push("-c:v", "copy");
    else args.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "900k", "-g", "60");
  }
  if (audio) {
    if (audio.encoding.toLowerCase() === "opus") args.push("-c:a", "copy");
    else args.push("-c:a", "libopus", "-b:a", "64k");
  }
  args.push(
    "-f", "segment",
    "-segment_time", String(segmentSeconds),
    "-segment_format", "webm",
    "-reset_timestamps", "1",
    outPattern,
  );
  return args;
}

async function freeUdpPair() {
  for (let i = 0; i < 50; i++) {
    const port = 30000 + 2 * Math.floor(Math.random() * 15000); // even RTP port, odd RTCP port
    const socks = [];
    try {
      for (const p of [port, port + 1]) {
        const s = dgram.createSocket("udp4");
        socks.push(s);
        await new Promise((resolve, reject) => {
          s.once("error", reject);
          s.bind(p, "127.0.0.1", resolve);
        });
      }
      return port;
    } catch (_) {
      // taken; try another pair
    } finally {
      for (const s of socks) s.close();
    }
  }
  throw new Error("no free UDP ports");
}

// ------------------------------------------------------------------- uploads

export async function uploadFile(file, key) {
  const { size } = await stat(file);
  if (size < 2048) return "empty";
  if (size > MAX_UPLOAD_BYTES) {
    log(`skip ${key}: ${size} bytes is over the Worker upload limit (lower SEGMENT_SECONDS)`);
    return "too_big";
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await workerFetch(`/admin/api/recordings/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "content-type": "video/webm", "content-length": String(size) },
        body: Readable.toWeb(createReadStream(file)),
        duplex: "half",
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (res.ok) {
        log(`uploaded ${key} (${(size / 1048576).toFixed(1)} MB)`);
        return "ok";
      }
      log(`upload ${key} attempt ${attempt}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log(`upload ${key} attempt ${attempt}: ${e.message}`);
    }
    await sleep(2000 * attempt);
  }
  return "failed";
}

// Upload (and delete) finished segments. While ffmpeg runs, the newest file is
// still being written, so it is left alone until `final` is true.
async function flushSegments(rec, final) {
  if (rec.flushing) return;
  rec.flushing = true;
  try {
    let files = (await readdir(rec.dir)).filter((f) => /^seg_\d+\.webm$/.test(f)).sort();
    if (!final) files = files.slice(0, -1);
    for (const f of files) {
      const n = Number(f.match(/\d+/)[0]) + 1;
      const key = `${rec.base}__p${String(n).padStart(3, "0")}.webm`;
      const result = await uploadFile(path.join(rec.dir, f), key);
      if (result === "failed") break; // keep the file; retried on the next tick
      await rm(path.join(rec.dir, f), { force: true });
      if (result === "ok") rec.uploaded++;
    }
  } finally {
    rec.flushing = false;
  }
}

// ----------------------------------------------------------------- recording

const safe = (s, n) => String(s || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "x";

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

async function startFfmpeg(rec) {
  const got = [...rec.streams.values()].filter((s) => s.pt != null);
  for (const s of got) s.port = await freeUdpPair();
  await writeFile(path.join(rec.dir, "input.sdp"), buildSdp(got));
  const args = ffmpegArgs(path.join(rec.dir, "input.sdp"), got, path.join(rec.dir, "seg_%03d.webm"), SEGMENT_SECONDS);
  log(`[${rec.tag}] ffmpeg start: ${got.map((s) => `${s.kind}:${s.encoding}`).join(" + ")}`);
  rec.ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  rec.ffmpeg.stderr.on("data", (d) => log(`[${rec.tag}] ffmpeg: ${String(d).trim().slice(0, 300)}`));
  rec.ffmpegExit = new Promise((resolve) => {
    rec.ffmpeg.once("exit", (code, sig) => {
      rec.ffmpegDone = true;
      log(`[${rec.tag}] ffmpeg exited code=${code} signal=${sig}`);
      resolve();
    });
    rec.ffmpeg.once("error", (e) => {
      rec.ffmpegDone = true;
      log(`[${rec.tag}] ffmpeg error: ${e.message}`);
      resolve();
    });
  });
  rec.ffmpeg.stdin.on("error", () => {});
  rec.included = got;
  // ffmpeg binds its UDP ports while opening the SDP; give it a moment, then
  // flush what arrived in the meantime (it begins at the first keyframe).
  await sleep(1000);
  rec.started = true;
  for (const s of got) {
    for (const buf of s.buffer) rec.udp.send(buf, s.port, "127.0.0.1");
    s.buffer = [];
  }
}

// payload type -> codec, read from the SFU's own offer (m-line kind + rtpmap/fmtp).
export function parseOfferCodecs(sdp) {
  const table = {};
  let kind = null;
  for (const raw of String(sdp).split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^m=(audio|video)\s/.exec(line);
    if (m) {
      kind = m[1];
      continue;
    }
    if (!kind) continue;
    m = /^a=rtpmap:(\d+)\s+([^/\s]+)\/(\d+)(?:\/(\d+))?/.exec(line);
    if (m) {
      const entry = (table[`${kind}:${m[1]}`] ||= {});
      entry.encoding = m[2];
      entry.clockRate = Number(m[3]);
      if (m[4]) entry.channels = Number(m[4]);
      continue;
    }
    m = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
    if (m) (table[`${kind}:${m[1]}`] ||= {}).fmtp = m[2];
  }
  return table;
}

const AUX_CODECS = new Set(["rtx", "red", "ulpfec", "flexfec-03"]);

function onTrack(rec, pc, track) {
  const stream = { kind: track.kind, track, pt: null, buffer: [], packets: 0 };
  rec.streams.set(track, stream);
  log(`[${rec.tag}] remote ${track.kind} track arrived`);
  track.onReceiveRtp.subscribe((rtp, _ext, info) => {
    if (rec.ending || (info && info.type === "padding")) return;
    if (stream.pt == null) {
      // The first real packet fixes the payload type; its codec comes from the SFU's offer.
      const pt = rtp.header.payloadType;
      const fromOffer = rec.offerCodecs?.[`${track.kind}:${pt}`];
      const werift = track.codec;
      const encoding = fromOffer?.encoding || String(werift?.mimeType || "").split("/")[1];
      if (!encoding) {
        if (!stream.warned) log(`[${rec.tag}] ${track.kind} packet with unknown payload type ${pt}; skipping`);
        stream.warned = true;
        return;
      }
      if (AUX_CODECS.has(encoding.toLowerCase())) return; // wait for a primary-codec packet
      stream.pt = pt;
      stream.encoding = encoding;
      stream.clockRate = fromOffer?.clockRate || werift?.clockRate || (track.kind === "audio" ? 48000 : 90000);
      stream.channels = track.kind === "audio" ? fromOffer?.channels || werift?.channels || 2 : undefined;
      stream.fmtp = fromOffer?.fmtp || (/^h264$/i.test(encoding) ? "packetization-mode=1" : undefined);
      log(`[${rec.tag}] first ${track.kind} RTP: payload ${pt} ${encoding}/${stream.clockRate}`);
      rec.firstRtpAt ??= Date.now();
    }
    if (rtp.header.payloadType !== stream.pt) return; // RED/FEC/other payloads
    stream.packets++;
    rec.lastRtpAt = Date.now();
    const buf = rtp.serialize();
    if (rec.started && stream.port) rec.udp.send(buf, stream.port, "127.0.0.1");
    else if (stream.buffer.length < 600) stream.buffer.push(buf);
  });
}

async function pullTracks(rec, trackNames) {
  // A retry starts clean: drop the previous attempt's connection and streams.
  try {
    await rec.pc?.close();
  } catch (_) {}
  rec.pc = null;
  rec.streams.clear();
  rec.firstRtpAt = null;
  rec.pullFailed = [];
  const { sessionId: subId } = await sfu("POST", "/new");
  rec.subId = subId;
  const pull = await sfu("POST", `/${encodeURIComponent(subId)}/tracks/new`, {
    tracks: trackNames.map((trackName) => ({ location: "remote", sessionId: rec.sessionId, trackName })),
  });
  for (const t of pull.tracks || []) {
    if (t.errorCode) {
      rec.pullFailed.push(t.trackName);
      log(`[${rec.tag}] SFU could not pull ${t.trackName}: ${t.errorDescription || t.errorCode}`);
    }
  }
  if (!pull.sessionDescription) throw new Error("SFU returned no offer");

  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
  rec.pc = pc;
  rec.offerCodecs = parseOfferCodecs(pull.sessionDescription.sdp);
  pc.connectionStateChange.subscribe((s) => log(`[${rec.tag}] connection ${s}`));
  pc.iceConnectionStateChange.subscribe((s) => log(`[${rec.tag}] ice ${s}`));
  pc.onTrack.subscribe((track) => onTrack(rec, pc, track));
  await pc.setRemoteDescription({ type: pull.sessionDescription.type, sdp: pull.sessionDescription.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  if (pc.iceGatheringState !== "complete") {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 4000);
      pc.iceGatheringStateChange.subscribe((s) => {
        if (s === "complete") {
          clearTimeout(t);
          resolve();
        }
      });
    });
  }
  const local = pc.localDescription || answer;
  await sfu("PUT", `/${encodeURIComponent(subId)}/renegotiate`, {
    sessionDescription: { type: local.type, sdp: local.sdp },
  });
}

async function runRecording(rec) {
  rec.dir = await mkdtemp(path.join(os.tmpdir(), "rec-"));
  rec.udp = dgram.createSocket("udp4");
  rec.udp.on("error", () => {});

  // 1. Wait for the participant to have active tracks on the SFU.
  let names = [];
  let lastSeen = "no answer";
  for (let i = 0; i < 10 && !names.length; i++) {
    const t0 = Date.now();
    try {
      const info = await sfu("GET", `/${encodeURIComponent(rec.sessionId)}`);
      names = activeLocalTracks(info).map((t) => t.trackName);
      lastSeen = `tracks=${JSON.stringify((info.tracks || []).map((t) => `${t.trackName}:${t.location}:${t.status}`))}`;
    } catch (e) {
      lastSeen = `error ${e.status || ""} ${e.message}`.trim();
      if (e.status === 404 && i >= 3) break;
    }
    log(`[${rec.tag}] look for tracks #${i + 1} (${Date.now() - t0}ms): ${lastSeen}`);
    if (!names.length) await sleep(3000);
  }
  if (!names.length) {
    log(`[${rec.tag}] no active tracks; nothing to record (last SFU answer: ${lastSeen})`);
    return;
  }

  // 2. Subscribe.
  await pullTracks(rec, names);
  // The publisher's media often is not flowing yet when its tracks first show as
  // active ("No track data from remote peer"). Pull again a few seconds later,
  // otherwise that person is recorded without video, or not at all.
  for (let attempt = 1; attempt <= 5 && rec.pullFailed.length && !rec.ending; attempt++) {
    log(`[${rec.tag}] retry ${attempt}/5 in 4s for: ${rec.pullFailed.join(", ")}`);
    await sleep(4000);
    try {
      const info = await sfu("GET", `/${encodeURIComponent(rec.sessionId)}`);
      const still = activeLocalTracks(info).map((t) => t.trackName);
      if (!still.length) break;
      names = still;
    } catch (_) {}
    await pullTracks(rec, names).catch((e) => log(`[${rec.tag}] retry pull failed: ${e.message}`));
  }
  if (!rec.pc) throw new Error("could not subscribe to the participant's tracks");
  if (rec.pullFailed.length) log(`[${rec.tag}] still could not pull: ${rec.pullFailed.join(", ")} (recording what is available)`);
  log(`[${rec.tag}] subscribed to ${names.join(", ")}`);

  // 3. Poll until the session ends; start ffmpeg once RTP is flowing; upload as we go.
  let misses = 0;
  let nextPoll = 0;
  let nextPli = 0;
  while (!rec.ending) {
    const now = Date.now();

    if (!rec.started && !rec.starting && rec.firstRtpAt) {
      const all = [...rec.streams.values()];
      if (all.every((s) => s.pt != null) || now - rec.firstRtpAt > 4000) {
        rec.starting = true;
        await startFfmpeg(rec).catch((e) => {
          log(`[${rec.tag}] could not start ffmpeg: ${e.message}`);
          rec.ending = "ffmpeg_failed";
        });
        if (!rec.ending) {
          // Tell the Worker a recording really started (it alerts if this never arrives).
          workerFetch("/admin/api/recording-status", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ room: rec.room, sessionId: rec.sessionId }),
          }).catch((e) => log(`[${rec.tag}] recording-status failed: ${e.message}`));
        }
        nextPli = 0;
      }
    }

    if (rec.started && now >= nextPli) {
      // Ask the publisher for fresh keyframes so segments start cleanly.
      for (const r of rec.pc.getReceivers()) {
        if (r.track && r.track.kind === "video" && r.track.ssrc) r.sendRtcpPLI(r.track.ssrc).catch(() => {});
      }
      nextPli = now + 10_000;
    }

    if (now >= nextPoll) {
      nextPoll = now + POLL_MS;
      if (!rec.started || ++rec.pollCount % 5 === 0) {
        const counts = [...rec.streams.values()].map((s) => `${s.kind}=${s.packets}`).join(" ") || "no tracks yet";
        log(`[${rec.tag}] status: connection=${rec.pc.connectionState} ice=${rec.pc.iceConnectionState} rtp packets: ${counts}`);
      }
      try {
        const alive = activeLocalTracks(await sfu("GET", `/${encodeURIComponent(rec.sessionId)}`)).length > 0;
        misses = alive ? 0 : misses + 1;
      } catch (e) {
        if (e.status === 404) misses++;
      }
      if (misses >= 2) rec.ending = "session_ended";
      else if (rec.started && rec.ffmpegDone) rec.ending = "ffmpeg_exited";
      else if (rec.pc.connectionState === "failed" || rec.pc.connectionState === "closed") rec.ending = "connection_lost";
      else if (rec.lastRtpAt && now - rec.lastRtpAt > STALL_MS) rec.ending = "no_media";
      else if (now - rec.startedAt > MAX_SESSION_MS) rec.ending = "max_duration";
      if (rec.started && !rec.ending) await flushSegments(rec, false);
    }
    await sleep(500);
  }
  log(`[${rec.tag}] stopping: ${rec.ending}`);
}

async function finish(rec) {
  rec.ending ||= "stopped";
  try {
    if (rec.ffmpeg && !rec.ffmpegDone) {
      rec.ffmpeg.stdin.write("q\n");
      await Promise.race([rec.ffmpegExit, sleep(20_000)]);
      if (!rec.ffmpegDone) rec.ffmpeg.kill("SIGKILL");
    }
  } catch (_) {}
  try {
    await rec.pc?.close();
  } catch (_) {}
  try {
    rec.udp?.close();
  } catch (_) {}
  try {
    if (rec.dir) await flushSegments(rec, true);
  } catch (e) {
    log(`[${rec.tag}] final upload error: ${e.message}`);
  }
  if (rec.dir) await rm(rec.dir, { recursive: true, force: true });
  active.delete(rec.sessionId);
  log(`[${rec.tag}] done, ${rec.uploaded} part(s) uploaded`);
}

function startRecording({ room, sessionId, name }) {
  const startedAt = Date.now();
  const rec = {
    sessionId,
    room: String(room || ""),
    startedAt,
    tag: `${safe(room, 20)}/${sessionId.slice(0, 8)}`,
    base: `${safe(room, 40)}__${safe(name, 24)}__${sessionId.slice(0, 8)}__${stamp(new Date(startedAt))}`,
    streams: new Map(),
    uploaded: 0,
    pollCount: 0,
    ending: null,
    started: false,
  };
  active.set(sessionId, rec);
  runRecording(rec)
    .catch((e) => log(`[${rec.tag}] error: ${e.message}`))
    .finally(() => finish(rec));
  return rec;
}

// ---------------------------------------------------------------- HTTP server

function authorized(req) {
  const given = Buffer.from(String(req.headers["x-recorder-secret"] || ""));
  const want = Buffer.from(SECRET);
  return given.length === want.length && given.length > 0 && timingSafeEqual(given, want);
}

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch (_) {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, active: active.size, max: MAX_CONCURRENT, rejected, uptimeSec: Math.round(process.uptime()) });
  }
  if (req.method === "GET" && url.pathname === "/logs") {
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    const n = Math.min(1000, Math.max(20, Number(url.searchParams.get("n")) || 300));
    // Prefer the permanent systemd journal (survives restarts); fall back to the in-memory buffer.
    const fromJournal = await new Promise((resolve) =>
      execFile("journalctl", ["-u", "nuvio-recorder", "-n", String(n), "-o", "cat", "--no-pager", "-q"], { timeout: 5000, maxBuffer: 4_000_000 }, (err, out) => resolve(err ? "" : String(out))),
    );
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end((fromJournal.trim() || recentLogs.slice(-n).join("\n")) + "\n");
  }
  if (req.method === "POST" && url.pathname === "/wake") {
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    const sessionId = String(body.sessionId || "");
    if (!SESSION_ID_RE.test(sessionId)) return send(res, 400, { error: "bad_session_id" });
    if (active.has(sessionId)) return send(res, 200, { status: "already_recording" });
    if (active.size >= MAX_CONCURRENT) {
      rejected++;
      log(`too_many_recordings: ${active.size}/${MAX_CONCURRENT} busy [${[...active.values()].map((r) => r.tag).join(", ")}]; turned away ${body.name || ""} ${sessionId.slice(0, 8)}`);
      return send(res, 429, { error: "too_many_recordings", active: active.size, max: MAX_CONCURRENT });
    }
    startRecording({ room: body.room, sessionId, name: body.name });
    return send(res, 202, { status: "started" });
  }
  return send(res, 404, { error: "not_found" });
}

async function shutdown(signal) {
  log(`${signal}: finishing ${active.size} recording(s)`);
  for (const rec of active.values()) rec.ending ||= "shutdown";
  const deadline = Date.now() + 25_000;
  while (active.size && Date.now() < deadline) await sleep(500);
  process.exit(0);
}

function main() {
  if (!WORKER_URL || !SECRET) {
    console.error("WORKER_URL and RECORDER_SECRET environment variables are required.");
    process.exit(1);
  }
  http
    .createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: String(e.message || e) })))
    .listen(PORT, "0.0.0.0", () => log(`recorder listening on :${PORT}, worker ${WORKER_URL}`));

  // Render's free tier sleeps after 15 minutes without inbound traffic, which
  // would kill a long recording. Poke our own public URL while recording.
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) {
    setInterval(() => {
      if (active.size) fetch(`${self}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    }, 4 * 60_000);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
