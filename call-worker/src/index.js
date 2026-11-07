// Nuvio watch party video call server.
//
// Keeps the Cloudflare Realtime App Secret off people's phones and keeps a
// tiny list of who is in each call room, so phones know whose camera and
// microphone tracks to pull from the Cloudflare SFU.
//
// Routes (all JSON):
//   POST /sfu/sessions/new                      -> SFU: new session
//   POST /sfu/sessions/:id/tracks/new           -> SFU: push or pull tracks
//   PUT  /sfu/sessions/:id/renegotiate          -> SFU: send an answer
//   PUT  /sfu/sessions/:id/tracks/close         -> SFU: close tracks
//   POST /rooms/:room/join   {memberId, name, sessionId, tracks:[...]}
//   POST /rooms/:room/leave  {memberId}
//   GET  /rooms/:room                           -> {peers:[...]}

const SFU_BASE = "https://rtc.live.cloudflare.com/v1/apps";
const PEER_TTL_MS = 20_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (env.CALL_KEY && request.headers.get("x-call-key") !== env.CALL_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (parts[0] === "sfu" && parts[1] === "sessions") {
        return await proxySfu(request, env, parts.slice(2));
      }
      if (parts[0] === "rooms" && parts[1]) {
        const id = env.ROOMS.idFromName(parts[1]);
        return await env.ROOMS.get(id).fetch(request);
      }
      if (parts.length === 0) {
        return json({ ok: true, service: "nuvio-call" });
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

export class CallRoom {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split("/").filter(Boolean)[2] || "";
    const peers = await this.livePeers();

    if (request.method === "GET" && action === "") {
      return json({ peers: Object.values(peers) });
    }

    if (request.method === "POST" && action === "join") {
      const body = await request.json();
      if (!body.memberId || !body.sessionId) return json({ error: "bad_request" }, 400);
      peers[body.memberId] = {
        memberId: String(body.memberId),
        name: String(body.name || "Guest").slice(0, 60),
        sessionId: String(body.sessionId),
        tracks: Array.isArray(body.tracks) ? body.tracks.map(String).slice(0, 4) : [],
        camera: body.camera !== false,
        mic: body.mic !== false,
        seenAt: Date.now(),
      };
      await this.ctx.storage.put("peers", peers);
      return json({ peers: Object.values(peers) });
    }

    if (request.method === "POST" && action === "leave") {
      const body = await request.json();
      delete peers[body.memberId];
      await this.ctx.storage.put("peers", peers);
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
