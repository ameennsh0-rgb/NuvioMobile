// Nuvio watch party video call server.
//
// Keeps the Cloudflare Realtime App Secret off people's phones and keeps a
// tiny list of who is in each call room, so phones know whose camera and
// microphone tracks to pull from the Cloudflare SFU.
//
// It also records session metadata (who was in which room, when, for how long)
// so the owner can see — on the /admin dashboard — whether calls are live and
// what happened before, and optionally click Play beside any live participant
// to pull and watch/record their WebRTC stream via the authenticated /admin/api/sfu proxy.
//
// Routes (all JSON unless noted):
//   POST /sfu/sessions/new                     -> SFU: new session
//   POST /sfu/sessions/:id/tracks/new          -> SFU: push or pull tracks
//   PUT  /sfu/sessions/:id/renegotiate         -> SFU: send an answer
//   PUT  /sfu/sessions/:id/tracks/close        -> SFU: close tracks
//   POST /rooms/:room/join   {memberId, name, sessionId, tracks:[...]}
//   POST /rooms/:room/leave  {memberId}
//   GET  /rooms/:room                          -> {peers:[...]}
//   GET  /admin                                -> dashboard (HTML, password)
//   POST /admin/login                          -> set the dashboard cookie
//   POST /admin/logout                         -> clear the dashboard cookie
//   GET  /admin/api/state                      -> {live, history, stats}
//   *    /admin/api/sfu/sessions/...           -> cookie-authed SFU proxy for dashboard Play
//   GET  /admin/api/recordings                 -> list of archived calls (last 48h)
//   PUT  /admin/api/recordings/:key            -> archiver uploads a .webm part
//   GET  /admin/api/recordings/:key            -> stream a recording (Range ok); ?download=1 to save
//
// The /admin/api/sfu and /admin/api/recordings routes accept either the dashboard
// cookie or an `x-recorder-secret` header equal to RECORDER_SECRET (used by the
// archiver service in recorder/). If RECORDER_URL and RECORDER_SECRET are set,
// joining a room also pings the archiver (POST /wake) so it starts recording.
// If the IFTTT_KEY secret is set, a phone notification is sent through IFTTT
// Webhooks when a call starts (event nuvio_call_started: value1 room, value2
// name) and when it ends (event nuvio_call_ended: value1 room, value2 length,
// value3 peak people). If someone is in a call with mic/camera on and the
// archiver has not confirmed a recording after about 2 minutes, event
// nuvio_call_not_recording is sent (value1 room, value2 name, value3 reason).

import { watchPage } from "./watch-app.js";

const SFU_BASE = "https://rtc.live.cloudflare.com/v1/apps";
const PEER_TTL_MS = 20_000;
const DIRECTORY_NAME = "global";
const WAKE_RETRY_MS = 12_000; // re-ping interval while the recording is not yet confirmed
const WAKE_EVERY_MS = 60_000; // how often a joined peer re-pings the archiver
const RECORDING_TTL_MS = 48 * 3600_000; // matches the R2 bucket's 2-day lifecycle rule
const IFTTT_START_EVENT = "nuvio_call_started";
const IFTTT_END_EVENT = "nuvio_call_ended";
const IFTTT_NOT_REC_EVENT = "nuvio_call_not_recording";
const NOT_RECORDING_AFTER_MS = 120_000; // alert if no recording has started this long after someone joined
const IFTTT_COOLDOWN_MS = 120_000; // don't re-announce the same room more often than this

// Optional phone notification through IFTTT Webhooks. Does nothing unless the
// IFTTT_KEY secret is set. Values: value1/value2/value3 in the applet text.
// If NTFY_TOPIC is set, alerts go to the free ntfy phone app instead (no monthly cap).
async function ntfyTrigger(env, event, values) {
  const kinds = {
    [IFTTT_START_EVENT]: { title: "Call started", tags: ["phone"], priority: 3, text: [values[0], values[1]] },
    [IFTTT_END_EVENT]: { title: "Call ended", tags: ["checkered_flag"], priority: 2, text: [values[0], values[1], values[2]] },
    [IFTTT_NOT_REC_EVENT]: { title: "Call NOT being recorded", tags: ["warning"], priority: 5, text: [values[0], values[1], values[2]] },
  };
  const kind = kinds[event] || { title: "Nuvio call", tags: [], priority: 3, text: values };
  try {
    const res = await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: env.NTFY_TOPIC,
        title: kind.title,
        message: kind.text.filter(Boolean).join(" · ") || "-",
        priority: kind.priority,
        tags: kind.tags,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return { configured: true, via: "ntfy", status: res.status };
  } catch (error) {
    return { configured: true, via: "ntfy", error: String(error) };
  }
}

async function iftttTrigger(env, event, values) {
  if (env.NTFY_TOPIC) return ntfyTrigger(env, event, values);
  if (!env.IFTTT_KEY) return { configured: false };
  try {
    const base = env.IFTTT_BASE || "https://maker.ifttt.com";
    const res = await fetch(`${base}/trigger/${encodeURIComponent(event)}/with/key/${encodeURIComponent(env.IFTTT_KEY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value1: values[0] || "", value2: values[1] || "", value3: values[2] || "" }),
      signal: AbortSignal.timeout(10_000),
    });
    return { configured: true, status: res.status, reply: (await res.text()).slice(0, 160) };
  } catch (error) {
    // A failed notification must never affect the call; the result is only for /admin/api/notify-test.
    return { configured: true, error: String(error) };
  }
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-call-key, authorization",
  "Access-Control-Max-Age": "86400",
};

function withCors(response) {
  // WebSocket upgrades must be returned untouched (re-wrapping drops the socket).
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    // The browser (web app) sends a CORS preflight before cross-origin POST/PUT.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return withCors(await this.route(request, env, ctx));
  },

  // Cron: keep the free-tier recorder awake during the day (08:00-23:00 Dubai).
  // GET /health is held by the host until it has booted. Outside those hours the
  // host sleeps and a call wakes it (see CallRoom.wakeRecorder).
  async scheduled(event, env, ctx) {
    if (!env.RECORDER_URL) return;
    const base = String(env.RECORDER_URL).replace(/\/+$/, "");
    ctx.waitUntil(
      (async () => {
        const t0 = Date.now();
        let result;
        try {
          const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(90_000) });
          result = { health: res.status };
        } catch (e) {
          result = { health: "error", error: String((e && e.message) || e).slice(0, 80) };
        }
        // Keep a record so the dashboard's wake log shows the keep-alive ran.
        await directoryStub(env)
          .fetch("https://directory/wakelog", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ at: new Date(t0).toISOString(), ms: Date.now() - t0, room: "(keep-alive)", name: "cron", ...result }),
          })
          .catch(() => {});
      })(),
    );
  },

  async route(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      // Dashboard has its own password; it is not gated by CALL_KEY.
      if (parts[0] === "admin") {
        return await handleAdmin(request, env, url, parts.slice(1));
      }

      // Web app page (watch together + video call in the browser).
      if (parts[0] === "watch" || parts.length === 0) {
        if (request.method === "GET") {
          return htmlResponse(watchPage());
        }
      }

      // Playback-sync WebSocket for a room (not gated by CALL_KEY; carries no media).
      if (parts[0] === "rooms" && parts[1] && parts[2] === "sync") {
        const id = env.WATCHSYNC.idFromName(parts[1]);
        return await env.WATCHSYNC.get(id).fetch(request);
      }

      // App-facing API, optionally gated by a shared CALL_KEY.
      if (env.CALL_KEY && request.headers.get("x-call-key") !== env.CALL_KEY) {
        return json({ error: "unauthorized" }, 401);
      }

      if (parts[0] === "sfu" && parts[1] === "sessions") {
        return await proxySfu(request, env, parts.slice(2));
      }
      if (parts[0] === "rooms" && parts[1]) {
        const id = env.ROOMS.idFromName(parts[1]);
        return await env.ROOMS.get(id).fetch(request);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: "server_error", detail: String(error) }, 500);
    }
  },
};

async function proxySfu(request, env, rest, allowGetSession = false) {
  const allowed =
    (allowGetSession && rest.length === 1 && request.method === "GET") ||
    (rest.length === 1 && rest[0] === "new" && request.method === "POST") ||
    (rest.length === 3 && rest[1] === "tracks" && rest[2] === "new" && request.method === "POST") ||
    (rest.length === 2 && rest[1] === "renegotiate" && request.method === "PUT") ||
    (rest.length === 3 && rest[1] === "tracks" && rest[2] === "close" && request.method === "PUT");
  if (!allowed) return json({ error: "not_found" }, 404);

  let body = request.method === "POST" || request.method === "PUT" ? await request.text() : undefined;
  // The SFU rejects an empty JSON object; send no body instead.
  if (body !== undefined && body.trim().replace(/\s/g, "") === "{}") body = undefined;
  const upstream = await fetch(`${SFU_BASE}/${env.CF_REALTIME_APP_ID}/sessions/${rest.join("/")}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
      "content-type": "application/json",
    },
    body: body && body.length > 0 ? body : undefined,
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}

// ---- Room presence (one Durable Object per call room) ----

function directoryStub(env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME));
}

export class CallRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const room = segments[1] || "";
    const action = segments[2] || "";
    const peers = await this.livePeers();

    if (request.method === "GET" && action === "") {
      return json({ peers: Object.values(peers) });
    }

    if (request.method === "POST" && action === "join") {
      const body = await request.json();
      if (!body.memberId || !body.sessionId) return json({ error: "bad_request" }, 400);
      const now = Date.now();
      const previous = peers[body.memberId];
      const roomWasEmpty = Object.keys(peers).length === 0;
      const peer = {
        memberId: String(body.memberId),
        name: String(body.name || "Guest").slice(0, 60),
        sessionId: String(body.sessionId),
        tracks: Array.isArray(body.tracks) ? body.tracks.map(String).slice(0, 4) : [],
        camera: body.camera !== false,
        mic: body.mic !== false,
        seenAt: now,
        firstSeenAt: previous && previous.sessionId === String(body.sessionId) ? previous.firstSeenAt || now : now,
        wokeAt: previous ? previous.wokeAt : undefined,
      };
      // Wake the archiver when a participant (or a new SFU session) appears, and
      // repeat about once a minute: it ignores sessions it is already recording,
      // and the traffic keeps a sleeping free-tier host awake during the call.
      // Until the archiver confirms it is recording, retry every few seconds so a
      // cold-starting host or a dropped ping costs seconds, not a minute.
      const recstate = (await this.ctx.storage.get("recstate")) || {};
      const confirmed = !!(recstate[peer.sessionId] && recstate[peer.sessionId].recordedAt);
      const wakeEvery = confirmed || (!peer.mic && !peer.camera) ? WAKE_EVERY_MS : WAKE_RETRY_MS;
      if (!previous || previous.sessionId !== peer.sessionId || now - (previous.wokeAt || 0) > wakeEvery) {
        peer.wokeAt = now;
        this.wakeRecorder({ room, memberId: peer.memberId, name: peer.name, sessionId: peer.sessionId, tracks: peer.tracks });
      }
      peers[body.memberId] = peer;
      await this.ctx.storage.put("peers", peers);
      await this.checkNotRecording(room, peer, now);
      // First person into an empty room: tell the owner's phone (once per call).
      if (roomWasEmpty && (this.env.NTFY_TOPIC || this.env.IFTTT_KEY)) {
        const last = (await this.ctx.storage.get("iftttAt")) || 0;
        if (now - last > IFTTT_COOLDOWN_MS) {
          await this.ctx.storage.put("iftttAt", now);
          this.ctx.waitUntil(iftttTrigger(this.env, IFTTT_START_EVENT, [room, peer.name]));
        }
      }
      // Record metadata for the dashboard (never any media).
      this.notifyDirectory("/heartbeat", {
        room,
        memberId: peer.memberId,
        name: peer.name,
        camera: peer.camera,
        mic: peer.mic,
        sfuSession: peer.sessionId,
      });
      return json({ peers: Object.values(peers) });
    }

    // The archiver reports here once it is really recording this SFU session.
    if (request.method === "POST" && action === "recording-status") {
      const body = await request.json();
      const sid = String(body.sessionId || "");
      if (!sid) return json({ error: "bad_request" }, 400);
      const state = (await this.ctx.storage.get("recstate")) || {};
      state[sid] = { ...(state[sid] || {}), recordedAt: Date.now() };
      await this.ctx.storage.put("recstate", this.pruneRecState(state));
      return json({ ok: true });
    }

    if (request.method === "POST" && action === "leave") {
      const body = await request.json();
      delete peers[body.memberId];
      await this.ctx.storage.put("peers", peers);
      this.notifyDirectory("/leave", { room, memberId: String(body.memberId || "") });
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  }

  pruneRecState(state) {
    const keys = Object.keys(state);
    if (keys.length > 20) {
      keys.sort((a, b) => (state[a].recordedAt || state[a].alertedAt || 0) - (state[b].recordedAt || state[b].alertedAt || 0));
      for (const k of keys.slice(0, keys.length - 20)) delete state[k];
    }
    return state;
  }

  // Phone alert when a call is on (mic/camera sending) but nothing is being recorded.
  async checkNotRecording(room, peer, now) {
    if (!(this.env.NTFY_TOPIC || this.env.IFTTT_KEY) || !this.env.RECORDER_URL || !this.env.RECORDER_SECRET) return;
    if (!peer.mic && !peer.camera) return; // watch-only: nothing to record
    if (now - peer.firstSeenAt < NOT_RECORDING_AFTER_MS) return;
    const state = (await this.ctx.storage.get("recstate")) || {};
    const entry = state[peer.sessionId] || {};
    if (entry.recordedAt || entry.alertedAt) return;
    state[peer.sessionId] = { ...entry, alertedAt: now };
    await this.ctx.storage.put("recstate", this.pruneRecState(state));
    this.ctx.waitUntil(
      iftttTrigger(this.env, IFTTT_NOT_REC_EVENT, [room, peer.name, `no recording ${Math.round((now - peer.firstSeenAt) / 1000)}s after joining`]),
    );
  }

  wakeRecorder(body) {
    const { RECORDER_URL, RECORDER_SECRET } = this.env;
    if (!RECORDER_URL || !RECORDER_SECRET) return;
    // A sleeping free-tier host answers a POST with an instant 502 and does NOT
    // boot, but it does boot (and holds the request) for a GET. So first GET
    // /health, which waits for the host to come up, then POST /wake.
    // Only one such attempt is in flight at a time.
    const now = Date.now();
    if (this.wakingSince && now - this.wakingSince < 100_000) return;
    this.wakingSince = now;
    const base = String(RECORDER_URL).replace(/\/+$/, "");
    const logWake = (result) =>
      this.notifyDirectory("/wakelog", { at: new Date(now).toISOString(), ms: Date.now() - now, room: body.room, name: body.name, ...result });
    this.ctx.waitUntil(
      (async () => {
        let health = 0;
        try {
          health = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(90_000) })).status;
        } catch (e) {
          logWake({ error: "health: " + String(e).slice(0, 100) });
          return;
        }
        try {
          const r = await fetch(`${base}/wake`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-recorder-secret": RECORDER_SECRET },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20_000),
          });
          logWake({ health, status: r.status });
        } catch (e) {
          logWake({ health, error: String(e).slice(0, 100) });
        }
      })().finally(() => {
        this.wakingSince = 0;
      }),
    );
  }

  notifyDirectory(path, body) {
    this.ctx.waitUntil(
      directoryStub(this.env)
        .fetch("https://directory" + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        .catch(() => {}),
    );
  }

  async livePeers() {
    const stored = (await this.ctx.storage.get("peers")) || {};
    const now = Date.now();
    const live = {};
    for (const [id, peer] of Object.entries(stored)) {
      if (now - peer.seenAt < PEER_TTL_MS) live[id] = peer;
    }
    return live;
  }
}

// ---- Directory: one Durable Object holding live + historical session metadata ----

const STALE_MS = 25_000; // no heartbeat for this long => treat as left
const SWEEP_MS = 15_000; // how often to close empty/stale sessions

export class CallDirectory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.pending = []; // in-flight notifications, awaited by the sweep alarm
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS sessions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          peak INTEGER NOT NULL DEFAULT 0
        )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS participants(
          session_id INTEGER NOT NULL,
          member_id TEXT NOT NULL,
          name TEXT NOT NULL,
          camera INTEGER NOT NULL DEFAULT 1,
          mic INTEGER NOT NULL DEFAULT 1,
          sfu_session TEXT,
          joined_at INTEGER NOT NULL,
          left_at INTEGER,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (session_id, member_id)
        )`,
      );
      // Add the column for databases created before it existed.
      try {
        this.sql.exec(`ALTER TABLE participants ADD COLUMN sfu_session TEXT`);
      } catch (_) {
        // Already present.
      }
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/heartbeat") return this.heartbeat(await request.json());
    if (path === "/leave") return this.leave(await request.json());
    if (path === "/state") return json(this.state());
    if (path === "/wakelog") {
      if (request.method === "POST") {
        const entry = await request.json();
        const log = (await this.ctx.storage.get("wakelog")) || [];
        log.push(entry);
        await this.ctx.storage.put("wakelog", log.slice(-150));
        return json({ ok: true });
      }
      return json({ wakelog: (await this.ctx.storage.get("wakelog")) || [] });
    }
    if (path === "/reset") {
      this.sql.exec("DELETE FROM participants");
      this.sql.exec("DELETE FROM sessions");
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  openSessionId(room, now) {
    const existing = this.sql
      .exec(`SELECT id FROM sessions WHERE room = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`, room)
      .toArray()[0];
    if (existing) return existing.id;
    this.sql.exec(`INSERT INTO sessions(room, started_at) VALUES(?, ?)`, room, now);
    return this.sql.exec(`SELECT last_insert_rowid() AS id`).toArray()[0].id;
  }

  async heartbeat(body) {
    const now = Date.now();
    const room = String(body.room || "");
    const memberId = String(body.memberId || "");
    if (!room || !memberId) return json({ error: "bad_request" }, 400);

    const sessionId = this.openSessionId(room, now);
    const name = String(body.name || "Guest").slice(0, 60);
    const camera = body.camera ? 1 : 0;
    const mic = body.mic ? 1 : 0;
    const sfuSession = body.sfuSession ? String(body.sfuSession).slice(0, 120) : null;
    const exists = this.sql
      .exec(`SELECT member_id FROM participants WHERE session_id = ? AND member_id = ?`, sessionId, memberId)
      .toArray()[0];
    if (exists) {
      this.sql.exec(
        `UPDATE participants SET name = ?, camera = ?, mic = ?, sfu_session = COALESCE(?, sfu_session),
         last_seen = ?, left_at = NULL WHERE session_id = ? AND member_id = ?`,
        name, camera, mic, sfuSession, now, sessionId, memberId,
      );
    } else {
      this.sql.exec(
        `INSERT INTO participants(session_id, member_id, name, camera, mic, sfu_session, joined_at, last_seen)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId, memberId, name, camera, mic, sfuSession, now, now,
      );
    }
    const active = this.activeCount(sessionId);
    this.sql.exec(`UPDATE sessions SET peak = MAX(peak, ?) WHERE id = ?`, active, sessionId);
    await this.ensureAlarm();
    return json({ ok: true });
  }

  async leave(body) {
    const now = Date.now();
    const room = String(body.room || "");
    const memberId = String(body.memberId || "");
    const session = this.sql
      .exec(`SELECT id FROM sessions WHERE room = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`, room)
      .toArray()[0];
    if (!session) return json({ ok: true });
    this.sql.exec(
      `UPDATE participants SET left_at = ? WHERE session_id = ? AND member_id = ? AND left_at IS NULL`,
      now, session.id, memberId,
    );
    this.closeIfEmpty(session.id, now);
    return json({ ok: true });
  }

  activeCount(sessionId) {
    return this.sql
      .exec(`SELECT COUNT(*) AS c FROM participants WHERE session_id = ? AND left_at IS NULL`, sessionId)
      .toArray()[0].c;
  }

  closeIfEmpty(sessionId, now) {
    if (this.activeCount(sessionId) === 0) {
      const open = this.sql
        .exec(`SELECT room, started_at, peak FROM sessions WHERE id = ? AND ended_at IS NULL`, sessionId)
        .toArray()[0];
      if (!open) return;
      this.sql.exec(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`, now, sessionId);
      const sent = iftttTrigger(this.env, IFTTT_END_EVENT, [
        open.room,
        formatDuration(now - open.started_at),
        `${open.peak} ${open.peak === 1 ? "person" : "people"}`,
      ]);
      this.pending.push(sent);
      this.ctx.waitUntil(sent);
    }
  }

  async ensureAlarm() {
    const current = await this.ctx.storage.getAlarm();
    if (current == null) this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async alarm() {
    const now = Date.now();
    // People whose app stopped sending heartbeats (screen off with no leave, crash, network drop).
    this.sql.exec(
      `UPDATE participants SET left_at = last_seen WHERE left_at IS NULL AND last_seen < ?`,
      now - STALE_MS,
    );
    for (const s of this.sql.exec(`SELECT id FROM sessions WHERE ended_at IS NULL`).toArray()) {
      this.closeIfEmpty(s.id, now);
    }
    const stillOpen = this.sql.exec(`SELECT COUNT(*) AS c FROM sessions WHERE ended_at IS NULL`).toArray()[0].c;
    if (stillOpen > 0) this.ctx.storage.setAlarm(now + SWEEP_MS);
    await Promise.allSettled(this.pending.splice(0));
  }

  state() {
    const liveRows = this.sql
      .exec(`SELECT id, room, started_at, peak FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`)
      .toArray();
    const live = liveRows.map((s) => {
      const people = this.sql
        .exec(
          `SELECT name, camera, mic, sfu_session, joined_at FROM participants
           WHERE session_id = ? AND left_at IS NULL ORDER BY joined_at`,
          s.id,
        )
        .toArray();
      return {
        room: s.room,
        startedAt: s.started_at,
        peak: s.peak,
        count: people.length,
        participants: people.map((p) => ({
          name: p.name,
          cameraOn: !!p.camera,
          micOn: !!p.mic,
          sfuSession: p.sfu_session || null,
          joinedAt: p.joined_at,
        })),
      };
    });
    const history = this.sql
      .exec(
        `SELECT id, room, started_at, ended_at, peak FROM sessions
         WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 100`,
      )
      .toArray()
      .map((s) => {
        const people = this.sql
          .exec(`SELECT name, sfu_session FROM participants WHERE session_id = ? ORDER BY joined_at`, s.id)
          .toArray()
          .map((r) => ({ name: r.name, sfuSession: r.sfu_session || null }));
        return {
          room: s.room,
          startedAt: s.started_at,
          endedAt: s.ended_at,
          durationSec: Math.max(0, Math.round((s.ended_at - s.started_at) / 1000)),
          peak: s.peak,
          participants: people,
        };
      });
    const totals = this.sql
      .exec(`SELECT COUNT(*) AS calls, COALESCE(SUM(peak), 0) AS seats FROM sessions`)
      .toArray()[0];
    return {
      live,
      history,
      stats: {
        liveRooms: live.length,
        livePeople: live.reduce((n, r) => n + r.count, 0),
        totalCalls: totals.calls,
      },
      now: Date.now(),
    };
  }
}

// ---- Watch-together playback sync (one Durable Object per room) ----
//
// A WebSocket relay so everyone in a room shares one video: the same link,
// play/pause, and seek position. Carries control messages and chat only —
// never any video or audio (those go peer-to-peer through the SFU).

export class WatchSync {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected_websocket" }, 426);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // Catch a new joiner up to the current shared state.
    const state = await this.ctx.storage.get("state");
    if (state) {
      try {
        server.send(JSON.stringify({ type: "state", ...state }));
      } catch (_) {}
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (msg.type === "state") {
      const state = {
        url: msg.url ? String(msg.url).slice(0, 2000) : null,
        paused: !!msg.paused,
        time: Number(msg.time) || 0,
        by: String(msg.by || "").slice(0, 60),
        at: Date.now(),
      };
      await this.ctx.storage.put("state", state);
      this.broadcast(JSON.stringify({ type: "state", ...state }), ws);
    } else if (msg.type === "chat") {
      this.broadcast(
        JSON.stringify({
          type: "chat",
          name: String(msg.name || "Guest").slice(0, 60),
          text: String(msg.text || "").slice(0, 500),
          at: Date.now(),
        }),
        null,
      );
    }
  }

  broadcast(data, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) {
        try {
          ws.send(data);
        } catch (_) {}
      }
    }
  }
}

// ---- Admin dashboard ----

async function handleAdmin(request, env, url, rest) {
  const password = env.DASHBOARD_PASSWORD;
  if (!password) {
    return htmlResponse(notConfiguredPage(), 503);
  }

  if (rest[0] === "login" && request.method === "POST") {
    const form = await request.formData();
    const given = String(form.get("password") || "");
    if (timingSafeEqual(given, password)) {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/admin",
          "set-cookie": `dash=${encodeURIComponent(password)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`,
        },
      });
    }
    return htmlResponse(loginPage("Wrong password."), 401);
  }

  if (rest[0] === "logout") {
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin",
        "set-cookie": `dash=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
      },
    });
  }

  const authed = timingSafeEqual(cookieValue(request, "dash") || "", password);

  if (rest[0] === "api" && rest[1] === "state") {
    if (!authed) return json({ error: "unauthorized" }, 401);
    const res = await directoryStub(env).fetch("https://directory/state");
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // The archiver service (recorder/) has no browser cookie; it sends a shared secret instead.
  const viaRecorder =
    !!env.RECORDER_SECRET && timingSafeEqual(request.headers.get("x-recorder-secret") || "", env.RECORDER_SECRET);
  const allowed = authed || viaRecorder;

  // SFU proxy for the /admin Play button and the archiver (includes GET /sessions/:id)
  if (rest[0] === "api" && rest[1] === "sfu" && rest[2] === "sessions") {
    if (!allowed) return json({ error: "unauthorized" }, 401);
    return await proxySfu(request, env, rest.slice(3), true);
  }

  // Sends a test phone notification now and reports what IFTTT answered.
  if (rest[0] === "api" && rest[1] === "notify-test") {
    if (!allowed) return json({ error: "unauthorized" }, 401);
    if (url.searchParams.get("event") === "not-recording") {
      return json(await iftttTrigger(env, IFTTT_NOT_REC_EVENT, ["notify-test", "test", "this is a test of the not-recording alert"]));
    }
    return json(await iftttTrigger(env, IFTTT_START_EVENT, ["notify-test", "manual test"]));
  }

  // Last Worker -> recorder wake attempts and what they returned.
  if (rest[0] === "api" && rest[1] === "wake-log") {
    if (!allowed) return json({ error: "unauthorized" }, 401);
    const res = await directoryStub(env).fetch("https://directory/wakelog");
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  }

  // Archiver tells the room it is recording (used for the "not recording" alert).
  if (rest[0] === "api" && rest[1] === "recording-status" && request.method === "POST") {
    if (!viaRecorder) return json({ error: "unauthorized" }, 401);
    const body = await request.json().catch(() => ({}));
    const room = String(body.room || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!room) return json({ error: "bad_request" }, 400);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return await stub.fetch(`https://room/rooms/${room}/recording-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: body.sessionId }),
    });
  }

  // Diagnose the Worker -> recorder link (does not record anything).
  if (rest[0] === "api" && rest[1] === "recorder-test") {
    if (!allowed) return json({ error: "unauthorized" }, 401);
    const { RECORDER_URL, RECORDER_SECRET } = env;
    if (!RECORDER_URL || !RECORDER_SECRET) {
      return json({ urlSet: !!RECORDER_URL, secretSet: !!RECORDER_SECRET });
    }
    try {
      const r = await fetch(`${String(RECORDER_URL).replace(/\/+$/, "")}/wake`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-recorder-secret": RECORDER_SECRET },
        body: JSON.stringify({ room: "recorder-test", sessionId: "recorder-test", name: "test" }),
        signal: AbortSignal.timeout(25_000),
      });
      return json({ urlSet: true, secretSet: true, host: new URL(RECORDER_URL).host, status: r.status, body: (await r.text()).slice(0, 200) });
    } catch (error) {
      return json({ urlSet: true, secretSet: true, error: String(error) });
    }
  }

  // Archived calls: list, upload (archiver) and stream/download (dashboard).
  if (rest[0] === "api" && rest[1] === "recordings") {
    if (!allowed) return json({ error: "unauthorized" }, 401);
    return await handleRecordings(request, env, url, rest.slice(2));
  }

  if (rest.length === 0) {
    return htmlResponse(authed ? dashboardPage() : loginPage());
  }
  return json({ error: "not_found" }, 404);
}

// ---- Recordings (R2) ----

const RECORDING_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.webm$/;

async function handleRecordings(request, env, url, rest) {
  if (!env.RECORDINGS) return json({ error: "recordings_not_configured" }, 503);

  if (rest.length === 0) {
    if (request.method !== "GET") return json({ error: "not_found" }, 404);
    // R2 lifecycle deletion can lag, so also hide anything older than 48 hours.
    const cutoff = Date.now() - RECORDING_TTL_MS;
    const recordings = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const listing = await env.RECORDINGS.list({ limit: 1000, cursor });
      for (const o of listing.objects) {
        const uploaded = o.uploaded.getTime();
        if (uploaded >= cutoff) {
          recordings.push({ key: o.key, size: o.size, uploaded, expiresAt: uploaded + RECORDING_TTL_MS });
        }
      }
      if (!listing.truncated) break;
      cursor = listing.cursor;
    }
    recordings.sort((a, b) => b.uploaded - a.uploaded);
    return new Response(JSON.stringify({ recordings }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  if (rest.length !== 1) return json({ error: "not_found" }, 404);
  let key;
  try {
    key = decodeURIComponent(rest[0]);
  } catch (_) {
    return json({ error: "bad_key" }, 400);
  }
  if (!RECORDING_KEY_RE.test(key)) return json({ error: "bad_key" }, 400);

  if (request.method === "PUT") {
    // R2 needs a stream of known length, so the uploader must send Content-Length.
    const length = Number(request.headers.get("content-length"));
    if (!request.body || !Number.isFinite(length) || length <= 0) {
      return json({ error: "content_length_required" }, 411);
    }
    await env.RECORDINGS.put(key, request.body, { httpMetadata: { contentType: "video/webm" } });
    return json({ ok: true, key, size: length });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const head = await env.RECORDINGS.head(key);
    if (!head) return json({ error: "not_found" }, 404);
    const size = head.size;
    const headers = new Headers({
      "content-type": "video/webm",
      "accept-ranges": "bytes",
      etag: head.httpEtag,
      "cache-control": "private, max-age=3600",
    });
    if (url.searchParams.get("download") === "1") {
      headers.set("content-disposition", `attachment; filename="${key}"`);
    }

    // <video> seeks with Range requests, so answer them with 206 Partial Content.
    const range = parseRange(request.headers.get("range"), size);
    if (range === "invalid") {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const length = range.end - range.start + 1;
      headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
      headers.set("content-length", String(length));
      if (request.method === "HEAD") return new Response(null, { status: 206, headers });
      const part = await env.RECORDINGS.get(key, { range: { offset: range.start, length } });
      if (!part) return json({ error: "not_found" }, 404);
      return new Response(part.body, { status: 206, headers });
    }
    headers.set("content-length", String(size));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    const full = await env.RECORDINGS.get(key);
    if (!full) return json({ error: "not_found" }, 404);
    return new Response(full.body, { status: 200, headers });
  }

  return json({ error: "not_found" }, 404);
}

// Parses a single "bytes=a-b" range. Returns {start,end} (inclusive), null when
// there is no usable Range header (serve the whole file), or "invalid" (416).
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

function cookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ---- helpers ----

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function shellStyles() {
  return `*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d0d11;color:#e9e9ee}
a{color:#3dd68c}.wrap{max-width:960px;margin:0 auto;padding:20px 16px 60px}`;
}

function notConfiguredPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard not set up</title><style>${shellStyles()}</style></head><body><div class="wrap">
<h1>Dashboard not set up</h1>
<p>Add a <code>DASHBOARD_PASSWORD</code> secret to the <code>nuvio-call</code> Worker (or the <code>DASHBOARD_PASSWORD</code> GitHub secret) and redeploy. Until then this page stays locked.</p>
</div></body></html>`;
}

function loginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nuvio call dashboard</title><style>${shellStyles()}
form{max-width:320px;margin:12vh auto 0;text-align:center}input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #333;background:#17171d;color:#fff;font-size:15px}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:999px;background:#3dd68c;color:#0d0d11;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#e5484d;margin-top:10px;min-height:18px}h1{text-align:center;font-size:20px}</style></head><body><div class="wrap">
<form method="post" action="/admin/login">
<h1>Call dashboard</h1>
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button type="submit">Open</button>
<div class="err">${error ? escapeHtml(error) : ""}</div>
</form></div></body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nuvio call dashboard</title><style>${shellStyles()}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:20px;margin:0}.muted{color:#9a9aa5}.small{font-size:13px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.stat{background:#17171d;border:1px solid #23232c;border-radius:14px;padding:12px 16px;min-width:120px}
.stat .n{font-size:26px;font-weight:700}.stat .l{font-size:12px;color:#9a9aa5;margin-top:2px}
h2{font-size:15px;color:#c7c7d1;margin:26px 0 10px;text-transform:uppercase;letter-spacing:.04em}
.card{background:#17171d;border:1px solid #23232c;border-radius:14px;padding:14px 16px;margin-bottom:10px;overflow-x:auto}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3dd68c;margin-right:7px;box-shadow:0 0 0 0 rgba(61,214,140,.7);animation:pulse 1.8s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 7px rgba(61,214,140,0)}100%{box-shadow:0 0 0 0 rgba(61,214,140,0)}}
.room{font-weight:700;font-size:15px}.chips{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.chip{background:#23232c;border-radius:10px;padding:8px 12px;font-size:13px;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ico{font-size:12px;opacity:.65}.ico.off{opacity:1;filter:grayscale(1)}
.sid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#c7c7d1;background:#17171d;padding:2px 6px;border-radius:6px;word-break:break-all;user-select:all;cursor:copy}
.playbtn{margin-left:auto;border:0;border-radius:8px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;background:#3dd68c;color:#0d0d11}
.playbtn.active{background:#e5484d;color:#fff}
.player-card{display:none;background:#17171d;border:1px solid #3dd68c;border-radius:14px;padding:14px 16px;margin:14px 0}
.player-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.player-meta{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#9a9aa5}
.player-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.btn-sm{border:1px solid #333;background:#23232c;color:#e9e9ee;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer}
.btn-stop{border-color:#e5484d;background:rgba(229,72,77,.15);color:#ff8b90}
video#dash-video{width:100%;max-height:420px;background:#000;border-radius:10px}
.phist{display:flex;flex-direction:column;gap:6px}.phist .nm{color:#e9e9ee}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #23232c;vertical-align:top}
th{color:#9a9aa5;font-weight:600}.empty{color:#9a9aa5;padding:14px 2px}
.note{font-size:12px;color:#7a7a85;margin-top:8px}.topbtn{font-size:13px}
.rec{padding:10px 0;border-bottom:1px solid #23232c}.rec:last-child{border-bottom:0}
.rec-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.rec-name{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
.rec-video video{width:100%;max-height:420px;background:#000;border-radius:10px;margin-top:10px}
a.btn-sm{text-decoration:none;display:inline-block}</style></head><body><div class="wrap">
<header><h1>Call dashboard</h1><a class="topbtn" href="/admin/logout">Sign out</a></header>
<div class="muted small">Live room &amp; participant monitor. Click <strong>Play</strong> beside any live participant to pull &amp; record their WebRTC stream.</div>
<div class="stats" id="stats"></div>

<div class="player-card" id="player-card">
  <div class="player-head">
    <div>
      <strong id="player-title">Streaming</strong>
      <div class="player-meta" id="player-meta">Connecting...</div>
    </div>
    <div class="player-actions">
      <label class="small muted" style="display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="checkbox" id="auto-rec" checked> Auto-record (.webm)
      </label>
      <button type="button" class="btn-sm" id="rec-btn" onclick="toggleRec()">Start Rec</button>
      <button type="button" class="btn-sm btn-stop" onclick="stopDashStream()">Disconnect</button>
    </div>
  </div>
  <video id="dash-video" autoplay playsinline controls></video>
</div>

<h2>Live now</h2><div id="live"><div class="empty">Loading…</div></div>
<h2>History</h2><div id="history" class="card"><div class="empty">Loading…</div></div>
<div class="note">Updates every 4 seconds. History keeps the last 100 calls.</div>

<h2>Recordings (Last 48h) <button type="button" class="btn-sm" onclick="loadRecordings(true)" style="text-transform:none;letter-spacing:0">Refresh</button></h2>
<div id="recs" class="card"><div class="empty">Loading…</div></div>
<div class="note">Calls are archived automatically and deleted 48 hours after upload. Longer calls are saved in several parts.</div>
</div>
<script>
const fmtTime = ts => new Date(ts).toLocaleString();
const ago = ts => { const s=Math.max(0,Math.round((Date.now()-ts)/1000)); if(s<60)return s+'s'; const m=Math.round(s/60); if(m<60)return m+'m'; return Math.round(m/60)+'h'; };
const dur = s => { if(s<60)return s+'s'; const m=Math.floor(s/60); if(m<60)return m+'m '+(s%60)+'s'; return Math.floor(m/60)+'h '+(m%60)+'m'; };
const esc = t => String(t).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sidTag = s => s ? '<code class="sid" data-sid="'+esc(s)+'" title="Click to copy" onclick="copySid(this)">'+esc(s)+'</code>' : '<span class="sid">—</span>';
function copySid(el){ try{ navigator.clipboard && navigator.clipboard.writeText(el.dataset.sid); }catch(e){} }
const fmtSize = b => b>=1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB';
const timeLeft = ts => { const m=Math.max(0,Math.round((ts-Date.now())/60000)); return m<60 ? m+'m' : Math.floor(m/60)+'h '+(m%60)+'m'; };
const recUrl = (k, dl) => '/admin/api/recordings/' + encodeURIComponent(k) + (dl ? '?download=1' : '');
function statCard(n,l){ return '<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }

let activePc = null, activeStream = null, activeSid = null, statsTimer = null, pollTimer = null;
let recorder = null, recChunks = [], lastBytes = 0, lastAt = 0, gotMedia = false, stallSec = 0;

async function sfuCall(method, path, body){
  const r = await fetch('/admin/api/sfu/sessions' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok || data.errorCode) throw Object.assign(new Error(data.errorDescription || data.error || ('HTTP '+r.status)), { status: r.status });
  return data;
}

async function waitIce(pc){
  if(pc.iceGatheringState==='complete') return;
  await new Promise(res => {
    const t = setTimeout(res, 1500);
    pc.addEventListener('icegatheringstatechange', function f(){
      if(pc.iceGatheringState==='complete'){ clearTimeout(t); pc.removeEventListener('icegatheringstatechange', f); res(); }
    });
  });
}

function toggleRec(){
  if(recorder && recorder.state==='recording'){ recorder.stop(); return; }
  if(!activeStream || !activeStream.getTracks().length) return;
  recChunks = [];
  const mime = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  recorder = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
  recorder.ondataavailable = e => { if(e.data && e.data.size>0) recChunks.push(e.data); };
  recorder.onstop = () => {
    document.getElementById('rec-btn').textContent = 'Start Rec';
    if(!recChunks.length) return;
    const blob = new Blob(recChunks, { type: recChunks[0].type || 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nuvio-' + (activeSid||'call').slice(0,10) + '-' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '.webm';
    document.body.appendChild(a); a.click(); a.remove();
  };
  recorder.start(1000);
  document.getElementById('rec-btn').textContent = 'Stop Rec';
}

function stopDashStream(){
  if(recorder && recorder.state==='recording') recorder.stop();
  clearInterval(statsTimer); clearInterval(pollTimer);
  if(activePc){ activePc.close(); activePc = null; }
  activeStream = null; activeSid = null; gotMedia = false; stallSec = 0;
  document.getElementById('dash-video').srcObject = null;
  document.getElementById('player-card').style.display = 'none';
  tick();
}

async function playParticipant(sid, name){
  if(activeSid === sid){ stopDashStream(); return; }
  stopDashStream();
  activeSid = sid;
  const card = document.getElementById('player-card');
  const meta = document.getElementById('player-meta');
  card.style.display = 'block';
  document.getElementById('player-title').textContent = 'Streaming: ' + name;
  meta.textContent = 'Detecting active tracks on ' + sid + '...';
  try{
    const info = await sfuCall('GET', '/' + encodeURIComponent(sid));
    const tracks = (info.tracks || []).filter(t => t.location==='local' && t.status==='active' && t.trackName).map(t => t.trackName);
    if(!tracks.length) throw new Error('No active local tracks found on this session.');

    const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.cloudflare.com:3478' }], bundlePolicy:'max-bundle' });
    activePc = pc;
    activeStream = new MediaStream();
    document.getElementById('dash-video').srcObject = activeStream;

    pc.ontrack = e => {
      activeStream.addTrack(e.track);
      if(document.getElementById('auto-rec').checked && (!recorder || recorder.state!=='recording')) toggleRec();
    };

    const { sessionId: subId } = await sfuCall('POST', '/new');
    const pull = await sfuCall('POST', '/' + encodeURIComponent(subId) + '/tracks/new', {
      tracks: tracks.map(trackName => ({ location:'remote', sessionId:sid, trackName }))
    });
    if(pull.sessionDescription){
      await pc.setRemoteDescription(new RTCSessionDescription(pull.sessionDescription));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await waitIce(pc);
      await sfuCall('PUT', '/' + encodeURIComponent(subId) + '/renegotiate', {
        sessionDescription: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
      });
    }

    lastBytes = 0; lastAt = performance.now(); gotMedia = false; stallSec = 0;
    statsTimer = setInterval(async () => {
      if(!activePc) return;
      const st = await activePc.getStats();
      let b = 0; st.forEach(r => { if(r.type==='inbound-rtp' && typeof r.bytesReceived==='number') b += r.bytesReceived; });
      const now = performance.now(), dt = (now - lastAt)/1000;
      if(dt > 0){
        const db = b - lastBytes, kbps = Math.max(0, Math.round((db*8)/1000/dt));
        if(db > 0){ gotMedia = true; stallSec = 0; } else if(gotMedia){ stallSec += dt; }
        meta.textContent = 'LIVE · ' + tracks.join(', ') + ' · ' + kbps + ' kbps · ICE: ' + activePc.connectionState;
        if(stallSec >= 10){ stopDashStream(); }
      }
      lastBytes = b; lastAt = now;
    }, 1500);

    pollTimer = setInterval(async () => {
      if(!activeSid) return;
      try{
        const s = await sfuCall('GET', '/' + encodeURIComponent(activeSid));
        const alive = (s.tracks || []).some(t => t.location==='local' && t.status==='active');
        if(!alive) stopDashStream();
      }catch(e){ if(e.status===404) stopDashStream(); }
    }, 3000);
  }catch(err){
    meta.textContent = 'Error: ' + err.message;
  }
  tick();
}

function render(d){
  document.getElementById('stats').innerHTML =
    statCard(d.stats.liveRooms,'live calls') + statCard(d.stats.livePeople,'people on now') + statCard(d.stats.totalCalls,'calls all-time');
  const live = document.getElementById('live');
  if(!d.live.length){ live.innerHTML='<div class="empty">No calls right now.</div>'; }
  else { live.innerHTML = d.live.map(r=>{
    const chips = r.participants.map(p=>{
      const isPlaying = p.sfuSession && activeSid === p.sfuSession;
      const playBtn = p.sfuSession
        ? '<button type="button" class="playbtn '+(isPlaying?'active':'')+'" data-sid="'+esc(p.sfuSession)+'" data-name="'+esc(p.name)+'" onclick="playParticipant(this.dataset.sid,this.dataset.name)">'+(isPlaying?'■ Stop':'▶ Play')+'</button>'
        : '';
      return '<div class="chip"><strong>'+esc(p.name)+'</strong>'
        +'<span class="ico '+(p.cameraOn?'':'off')+'">'+(p.cameraOn?'📷':'🚫')+'</span>'
        +'<span class="ico '+(p.micOn?'':'off')+'">'+(p.micOn?'🎙️':'🔇')+'</span>'
        +'<span class="muted small">joined '+fmtTime(p.joinedAt)+'</span>'
        +sidTag(p.sfuSession)+playBtn+'</div>';
    }).join('');
    return '<div class="card"><div><span class="live-dot"></span><span class="room">'+esc(r.room)+'</span>'
      +' <span class="muted small">· '+r.count+' in call (peak '+r.peak+') · started '+fmtTime(r.startedAt)+' ('+ago(r.startedAt)+' ago)</span></div>'
      +'<div class="chips">'+chips+'</div></div>';
  }).join(''); }
  const h = document.getElementById('history');
  if(!d.history.length){ h.innerHTML='<div class="empty">No past calls yet.</div>'; }
  else { h.innerHTML = '<table><thead><tr><th>Room</th><th>Started / Ended</th><th>Length</th><th>Peak</th><th>People (Full SFU session id)</th></tr></thead><tbody>'
    + d.history.map(s=>{
        const ppl = s.participants.map(p=>'<div><span class="nm">'+esc(p.name)+'</span> '+sidTag(p.sfuSession)+'</div>').join('');
        return '<tr><td>'+esc(s.room)+'</td><td>'+fmtTime(s.startedAt)+'<br><span class="muted small">to '+fmtTime(s.endedAt)+'</span></td><td>'+dur(s.durationSec)
        +'</td><td>'+s.peak+'</td><td><div class="phist">'+ppl+'</div></td></tr>';
      }).join('') + '</tbody></table>'; }
}
async function tick(){
  try{ const r=await fetch('/admin/api/state',{cache:'no-store'}); if(r.status===401){location.reload();return;} render(await r.json()); }
  catch(e){}
}
tick(); setInterval(tick, 4000);

let openRec = null;
async function loadRecordings(force){
  if(!force && openRec) return; // keep the list (and the playing video) as is
  const box = document.getElementById('recs');
  try{
    const r = await fetch('/admin/api/recordings', { cache:'no-store' });
    if(r.status===401){ location.reload(); return; }
    const d = await r.json().catch(() => ({}));
    if(!r.ok){
      box.innerHTML = '<div class="empty">'+(d.error==='recordings_not_configured' ? 'Recording storage is not set up on this Worker yet.' : 'Could not load recordings.')+'</div>';
      return;
    }
    openRec = null;
    if(!d.recordings.length){ box.innerHTML = '<div class="empty">No recordings in the last 48 hours.</div>'; return; }
    box.innerHTML = d.recordings.map(x =>
      '<div class="rec" data-key="'+esc(x.key)+'"><div class="rec-row"><div><span class="rec-name">'+esc(x.key)+'</span>'
      +'<div class="muted small">'+fmtTime(x.uploaded)+' · '+fmtSize(x.size)+' · expires in '+timeLeft(x.expiresAt)+'</div></div>'
      +'<div class="player-actions"><button type="button" class="btn-sm watch" onclick="toggleRecVideo(this)">▶ Watch</button>'
      +'<a class="btn-sm" href="'+recUrl(x.key,true)+'">Download</a></div></div><div class="rec-video"></div></div>'
    ).join('');
  }catch(e){}
}
function toggleRecVideo(btn){
  const row = btn.closest('.rec'), holder = row.querySelector('.rec-video');
  const wasOpen = !!holder.firstChild;
  document.querySelectorAll('#recs .rec-video').forEach(h => { h.innerHTML = ''; h.closest('.rec').querySelector('.watch').textContent = '▶ Watch'; });
  openRec = null;
  if(wasOpen) return;
  const v = document.createElement('video');
  v.controls = true; v.autoplay = true; v.playsInline = true; v.preload = 'metadata'; v.src = recUrl(row.dataset.key);
  holder.appendChild(v);
  btn.textContent = '■ Close';
  openRec = row.dataset.key;
}
loadRecordings(true); setInterval(() => loadRecordings(false), 30000);
</script></body></html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
