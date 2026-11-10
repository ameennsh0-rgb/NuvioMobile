// Nuvio watch party video call server.
//
// Keeps the Cloudflare Realtime App Secret off people's phones and keeps a
// tiny list of who is in each call room, so phones know whose camera and
// microphone tracks to pull from the Cloudflare SFU.
//
// It also records session metadata (who was in which room, when, for how long)
// so the owner can see — on the /admin dashboard — whether calls are live and
// what happened before. The dashboard shows names, counts and timing only; it
// never pulls anyone's camera or microphone.
//
// Routes (all JSON unless noted):
//   POST /sfu/sessions/new                      -> SFU: new session
//   POST /sfu/sessions/:id/tracks/new           -> SFU: push or pull tracks
//   PUT  /sfu/sessions/:id/renegotiate          -> SFU: send an answer
//   PUT  /sfu/sessions/:id/tracks/close         -> SFU: close tracks
//   POST /rooms/:room/join   {memberId, name, sessionId, tracks:[...]}
//   POST /rooms/:room/leave  {memberId}
//   GET  /rooms/:room                           -> {peers:[...]}
//   GET  /admin                                 -> dashboard (HTML, password)
//   POST /admin/login                           -> set the dashboard cookie
//   POST /admin/logout                          -> clear the dashboard cookie
//   GET  /admin/api/state                       -> {live, history, stats}

import { watchPage } from "./watch-app.js";

const SFU_BASE = "https://rtc.live.cloudflare.com/v1/apps";
const PEER_TTL_MS = 20_000;
const DIRECTORY_NAME = "global";

export default {
  async fetch(request, env, ctx) {
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

async function proxySfu(request, env, rest) {
  const allowed =
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
      const peer = {
        memberId: String(body.memberId),
        name: String(body.name || "Guest").slice(0, 60),
        sessionId: String(body.sessionId),
        tracks: Array.isArray(body.tracks) ? body.tracks.map(String).slice(0, 4) : [],
        camera: body.camera !== false,
        mic: body.mic !== false,
        seenAt: Date.now(),
      };
      peers[body.memberId] = peer;
      await this.ctx.storage.put("peers", peers);
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

    if (request.method === "POST" && action === "leave") {
      const body = await request.json();
      delete peers[body.memberId];
      await this.ctx.storage.put("peers", peers);
      this.notifyDirectory("/leave", { room, memberId: String(body.memberId || "") });
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
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
      this.sql.exec(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`, now, sessionId);
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

  if (rest.length === 0) {
    return htmlResponse(authed ? dashboardPage() : loginPage());
  }
  return json({ error: "not_found" }, 404);
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
a{color:#3dd68c}.wrap{max-width:860px;margin:0 auto;padding:20px 16px 60px}`;
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
.card{background:#17171d;border:1px solid #23232c;border-radius:14px;padding:14px 16px;margin-bottom:10px}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3dd68c;margin-right:7px;box-shadow:0 0 0 0 rgba(61,214,140,.7);animation:pulse 1.8s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 7px rgba(61,214,140,0)}100%{box-shadow:0 0 0 0 rgba(61,214,140,0)}}
.room{font-weight:700;font-size:15px}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.chip{background:#23232c;border-radius:999px;padding:5px 11px;font-size:13px;display:flex;align-items:center;gap:6px}
.ico{font-size:12px;opacity:.65}.ico.off{opacity:1;filter:grayscale(1)}
.sid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#8a8a95;cursor:copy}
.phist{display:flex;flex-direction:column;gap:3px}.phist .nm{color:#e9e9ee}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #23232c;vertical-align:top}
th{color:#9a9aa5;font-weight:600}.empty{color:#9a9aa5;padding:14px 2px}
.note{font-size:12px;color:#7a7a85;margin-top:8px}.topbtn{font-size:13px}</style></head><body><div class="wrap">
<header><h1>Call dashboard</h1><a class="topbtn" href="/admin/logout">Sign out</a></header>
<div class="muted small">Session details only — names, timing and live status. No camera or microphone is ever shown here.</div>
<div class="stats" id="stats"></div>
<h2>Live now</h2><div id="live"><div class="empty">Loading…</div></div>
<h2>History</h2><div id="history" class="card"><div class="empty">Loading…</div></div>
<div class="note">Updates every few seconds. History keeps the last 100 calls.</div>
</div>
<script>
const fmtTime = ts => new Date(ts).toLocaleString();
const ago = ts => { const s=Math.max(0,Math.round((Date.now()-ts)/1000)); if(s<60)return s+'s'; const m=Math.round(s/60); if(m<60)return m+'m'; return Math.round(m/60)+'h'; };
const dur = s => { if(s<60)return s+'s'; const m=Math.floor(s/60); if(m<60)return m+'m '+(s%60)+'s'; return Math.floor(m/60)+'h '+(m%60)+'m'; };
const esc = t => { const d=document.createElement('div'); d.textContent=t; return d.innerHTML; };
const shortId = s => s ? (s.length>14 ? s.slice(0,12)+'…' : s) : '—';
const sidTag = s => s ? '<code class="sid" title="'+esc(s)+'" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.title)">'+esc(shortId(s))+'</code>' : '<span class="sid">—</span>';
function statCard(n,l){ return '<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }
function render(d){
  document.getElementById('stats').innerHTML =
    statCard(d.stats.liveRooms,'live calls') + statCard(d.stats.livePeople,'people on now') + statCard(d.stats.totalCalls,'calls all-time');
  const live = document.getElementById('live');
  if(!d.live.length){ live.innerHTML='<div class="empty">No calls right now.</div>'; }
  else { live.innerHTML = d.live.map(r=>{
    const chips = r.participants.map(p=>'<span class="chip">'+esc(p.name)
      +'<span class="ico '+(p.cameraOn?'':'off')+'">'+(p.cameraOn?'📷':'🚫')+'</span>'
      +'<span class="ico '+(p.micOn?'':'off')+'">'+(p.micOn?'🎙️':'🔇')+'</span>'
      +sidTag(p.sfuSession)+'</span>').join('');
    return '<div class="card"><div><span class="live-dot"></span><span class="room">'+esc(r.room)+'</span>'
      +' <span class="muted small">· '+r.count+' in call · started '+ago(r.startedAt)+' ago</span></div>'
      +'<div class="chips">'+chips+'</div></div>';
  }).join(''); }
  const h = document.getElementById('history');
  if(!d.history.length){ h.innerHTML='<div class="empty">No past calls yet.</div>'; }
  else { h.innerHTML = '<table><thead><tr><th>Room</th><th>When</th><th>Length</th><th>People (SFU session id)</th></tr></thead><tbody>'
    + d.history.map(s=>{
        const ppl = s.participants.map(p=>'<div><span class="nm">'+esc(p.name)+'</span> '+sidTag(p.sfuSession)+'</div>').join('');
        return '<tr><td>'+esc(s.room)+'</td><td>'+fmtTime(s.startedAt)+'</td><td>'+dur(s.durationSec)
        +'</td><td><div class="phist">'+ppl+'</div></td></tr>';
      }).join('') + '</tbody></table>'; }
}
async function tick(){
  try{ const r=await fetch('/admin/api/state',{cache:'no-store'}); if(r.status===401){location.reload();return;} render(await r.json()); }
  catch(e){}
}
tick(); setInterval(tick, 4000);
</script></body></html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
