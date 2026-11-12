// Nuvio audio helper: runs on YOUR computer (like Stremio's streaming server).
// When the web player finds a movie whose audio the browser cannot decode
// (Dolby AC3/EAC3, DTS, TrueHD...), it asks this helper for an HLS stream where
// the video is copied untouched and only the audio is converted to AAC.
//
//   brew install ffmpeg node      (macOS)      then:     node helper.mjs
//
// Listens on 127.0.0.1 only. No dependencies besides node and ffmpeg.

const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtemp, rm, readFile, stat } = require("node:fs/promises");
const { createReadStream, existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const PORT = Number(process.env.NUVIO_HELPER_PORT || 11471);
function resolveFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    // ffmpeg-static ships a ready-made ffmpeg; inside the packaged app it is unpacked from the asar.
    return require("ffmpeg-static").replace("app.asar", "app.asar.unpacked");
  } catch (_) {
    return "ffmpeg"; // fall back to one installed on the computer
  }
}
const FFMPEG = resolveFfmpeg();
const IDLE_KILL_MS = 90_000; // stop converting when the player stops fetching segments
// Pages allowed to use the helper: your Nuvio web hosts (comma separated, "*" = any).
const ORIGINS = (process.env.NUVIO_ORIGINS || "*.workers.dev,localhost,127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);

const sessions = new Map(); // id -> {dir, proc, last}

function originAllowed(origin) {
  if (!origin) return true; // curl / same machine
  if (ORIGINS.includes("*")) return true;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return ORIGINS.some((o) => (o.startsWith("*.") ? host.endsWith(o.slice(1)) : host === o));
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-allow-private-network", "true");
  res.setHeader("access-control-max-age", "600");
}

function privateTarget(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (!net.isIP(h)) return false;
  if (net.isIPv6(h)) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  const [a, b] = h.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function ffmpegArgs({ url, start, audio, dir, video = "copy" }) {
  const remote = /^https?:/i.test(url);
  return [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    // Be patient with slow or flaky servers: keep retrying the connection.
    ...(remote ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "30000000"] : []),
    "-analyzeduration", "20000000", "-probesize", "40000000",
    ...(start > 0 ? ["-ss", String(start)] : []),
    "-i", url,
    "-map", "0:v:0?", "-map", `0:a:${audio}?`,
    // "copy" leaves the picture untouched; "h264" re-encodes it for files the browser cannot show.
    ...(video === "h264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-force_key_frames", "expr:gte(t,n_forced*4)"]
      : ["-c:v", "copy"]),
    "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    // keep the original timeline so the player's clock and saved progress stay right
    "-output_ts_offset", String(start),
    "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
    "-hls_playlist_type", "event", "-hls_segment_type", "fmp4",
    "-hls_flags", "independent_segments",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(dir, "seg%05d.m4s"),
    path.join(dir, "index.m3u8"),
  ];
}

async function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.proc.kill("SIGKILL"); } catch {}
  await rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

async function startSession({ url, start, audio, video }) {
  for (const id of [...sessions.keys()]) await stopSession(id); // one movie at a time
  const id = Math.random().toString(36).slice(2, 10);
  const dir = await mkdtemp(path.join(os.tmpdir(), "nuvio-audio-"));
  const proc = spawn(FFMPEG, ffmpegArgs({ url, start, audio, dir, video }), { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + d).slice(-600); });
  const session = { dir, proc, last: Date.now(), exited: false, err: () => err };
  proc.on("exit", () => { session.exited = true; });
  proc.on("error", (e) => { err = String(e.message); session.exited = true; });
  sessions.set(id, session);
  // Wait until the first segment exists so the player can start right away.
  const playlist = path.join(dir, "index.m3u8");
  const t0 = Date.now();
  while (Date.now() - t0 < 75_000) {
    if (existsSync(playlist)) {
      const text = await readFile(playlist, "utf8").catch(() => "");
      if (text.includes(".m4s")) return id;
    }
    if (session.exited) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const reason = (err || "no output from the converter").replace(/\s+/g, " ").trim().slice(-260);
  await stopSession(id);
  throw new Error(reason);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.last > IDLE_KILL_MS) void stopSession(id);
}, 15_000).unref();

const TYPES = { ".m3u8": "application/vnd.apple.mpegurl", ".m4s": "video/iso.segment", ".mp4": "video/mp4" };

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, "http://x");
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.headers.origin && !originAllowed(req.headers.origin)) return json(403, { error: "origin_not_allowed" });
    if (u.pathname === "/health") return json(200, { ok: true, helper: "nuvio-audio", version: 2, sessions: sessions.size });

    if (u.pathname === "/start") {
      let target;
      try { target = new URL(u.searchParams.get("url") || ""); } catch { return json(400, { error: "bad_url" }); }
      if (!/^https?:$/.test(target.protocol)) return json(400, { error: "bad_url" });
      if (!process.env.NUVIO_ALLOW_PRIVATE && privateTarget(target.hostname)) return json(400, { error: "private_address_blocked" });
      const start = Math.max(0, Math.floor(Number(u.searchParams.get("t") || 0)) || 0);
      const audio = Math.max(0, Math.floor(Number(u.searchParams.get("a") || 0)) || 0);
      const video = u.searchParams.get("v") === "h264" ? "h264" : "copy";
      const id = await startSession({ url: target.href, start, audio, video });
      return json(200, { playlist: `/hls/${id}/index.m3u8`, start });
    }

    const m = u.pathname.match(/^\/hls\/([a-z0-9]+)\/([A-Za-z0-9_.-]+)$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return json(404, { error: "no_session" });
      s.last = Date.now();
      const file = path.join(s.dir, m[2]);
      if (!existsSync(file)) return json(404, { error: "not_ready" });
      const st = await stat(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(m[2])] || "application/octet-stream", "content-length": st.size, "cache-control": "no-store" });
      return createReadStream(file).pipe(res);
    }
    json(404, { error: "not_found" });
  } catch (e) {
    json(500, { error: "failed", detail: String(e.message || e).slice(0, 300) });
  }
});

// Quick check that the bundled converter really runs on this computer.
async function selfTest() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nuvio-selftest-"));
  try {
    return await new Promise((resolve) => {
      const proc = spawn(FFMPEG, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:a", "aac", "-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", "1",
        "-hls_segment_filename", path.join(dir, "t%d.m4s"), path.join(dir, "t.m3u8"),
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      proc.stderr.on("data", (d) => { err = (err + d).slice(-300); });
      proc.on("error", (e) => resolve({ ok: false, detail: String(e.message || e) }));
      proc.on("exit", (code) => resolve(code === 0 ? { ok: true } : { ok: false, detail: err.trim() || `exit code ${code}` }));
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve({ ok: false, detail: "converter did not finish" }); }, 20000);
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function start() {
  return new Promise((resolve) => {
    server.on("error", (e) => {
      console.warn("audio helper not started:", e.code || e.message);
      resolve(false);
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Nuvio audio helper on http://127.0.0.1:${PORT} (ffmpeg: ${FFMPEG})`);
      resolve(true);
    });
  });
}

async function stopAll() {
  for (const id of [...sessions.keys()]) await stopSession(id);
}

module.exports = { start, stopAll, selfTest, ffmpegArgs, FFMPEG };
