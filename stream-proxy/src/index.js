// Nuvio stream relay.
//
// The browser can play video fine, but it cannot DOWNLOAD from sources that
// block browser requests (hotlink/Referer protection) or disallow CORS. A web
// page also can't forge Referer/Origin. This Worker is a server, not a browser,
// so it sends the headers a CDN expects, fetches the bytes, and streams them
// back to the browser with CORS — acting as a relay, not re-hosting anything.
//
//   GET/HEAD /stream?url=<encoded>&h=<base64url JSON headers>&k=<key?>
//     - forwards the Range header (seeking) and returns 206 for partial content
//     - defaults Referer/Origin/User-Agent to the target's own origin
//     - rewrites HLS (.m3u8) manifests so segments also go through the relay
//     - refuses text/html and private hosts (not a general web proxy)

const BLOCK_CT = /^text\/html/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/") {
      return new Response(landing(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname !== "/stream") return cors(new Response("Not found", { status: 404 }));

    const target = url.searchParams.get("url");
    if (!target) return cors(new Response("Missing url", { status: 400 }));
    if (env.STREAM_KEY && url.searchParams.get("k") !== env.STREAM_KEY) {
      return cors(new Response("Unauthorized", { status: 401 }));
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (_) {
      return cors(new Response("Bad url", { status: 400 }));
    }
    if (!/^https?:$/.test(targetUrl.protocol)) return cors(new Response("Only http(s)", { status: 400 }));
    if (isPrivateHost(targetUrl.hostname)) return cors(new Response("Blocked host", { status: 403 }));

    const h = url.searchParams.get("h");
    let extra = null;
    if (h) {
      try {
        extra = JSON.parse(b64urlDecode(h));
      } catch (_) {}
    }
    const range = request.headers.get("range");
    const method = request.method === "HEAD" ? "HEAD" : "GET";

    // Build upstream headers. spoofOrigin adds Referer/Origin = the target's own
    // origin, which bypasses hotlink protection — but breaks open CDNs that reject
    // an unexpected Origin, so we only use it on a retry after a block.
    const buildHeaders = (spoofOrigin) => {
      const headers = new Headers();
      headers.set(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );
      headers.set("accept", "*/*");
      if (spoofOrigin) {
        headers.set("referer", targetUrl.origin + "/");
        headers.set("origin", targetUrl.origin);
      }
      if (extra) for (const key in extra) if (extra[key]) headers.set(key, String(extra[key]));
      if (range) headers.set("range", range);
      return headers;
    };

    let upstream;
    try {
      // Try a clean request first (works for open CDNs).
      upstream = await fetch(targetUrl.toString(), { method, headers: buildHeaders(false), redirect: "follow" });
      // If the source blocks it, retry pretending the request came from its own site.
      if (upstream.status === 401 || upstream.status === 403) {
        upstream = await fetch(targetUrl.toString(), { method, headers: buildHeaders(true), redirect: "follow" });
      }
    } catch (e) {
      return cors(new Response("Upstream fetch failed: " + e, { status: 502 }));
    }

    const ct = upstream.headers.get("content-type") || "";
    if (BLOCK_CT.test(ct)) return cors(new Response("Refused content type", { status: 415 }));

    // HLS: rewrite the manifest so every segment and key also routes through here.
    const looksHls = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(targetUrl.pathname + targetUrl.search);
    if (looksHls && upstream.ok && request.method !== "HEAD") {
      const text = await upstream.text();
      const rewritten = rewriteManifest(text, targetUrl, url, h, env);
      return cors(
        new Response(rewritten, {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        }),
      );
    }

    const out = new Headers();
    copyHeader(upstream, out, "content-type");
    copyHeader(upstream, out, "content-length");
    copyHeader(upstream, out, "content-range");
    copyHeader(upstream, out, "accept-ranges");
    copyHeader(upstream, out, "content-disposition");
    if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
    return cors(new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out }));
  },
};

function rewriteManifest(text, baseUrl, proxyUrl, h, env) {
  const proxyBase = proxyUrl.origin + "/stream";
  const keyParam = env.STREAM_KEY ? "&k=" + encodeURIComponent(env.STREAM_KEY) : "";
  const hParam = h ? "&h=" + encodeURIComponent(h) : "";
  const wrap = (u) => {
    let abs;
    try {
      abs = new URL(u, baseUrl).toString();
    } catch (_) {
      return u;
    }
    return proxyBase + "?url=" + encodeURIComponent(abs) + hParam + keyParam;
  };
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        // Rewrite URI="..." inside EXT-X-KEY / EXT-X-MEDIA / EXT-X-MAP tags.
        return line.replace(/URI="([^"]+)"/g, (_m, u) => 'URI="' + wrap(u) + '"');
      }
      return wrap(t);
    })
    .join("\n");
}

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "*");
  h.set("access-control-allow-methods", "GET,HEAD,OPTIONS");
  h.set("access-control-expose-headers", "Content-Length,Content-Range,Accept-Ranges,Content-Type");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function copyHeader(from, to, name) {
  const v = from.headers.get(name);
  if (v) to.set(name, v);
}

function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || !h.includes(".")) return true;
  if (h === "::1" || h.startsWith("[")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  return false;
}

function b64urlDecode(s) {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return atob(b);
}

function landing() {
  return `<!doctype html><meta charset="utf-8"><title>Nuvio stream relay</title>
<body style="font-family:system-ui;background:#0d0d11;color:#ddd;padding:40px;max-width:640px;margin:auto">
<h1>Nuvio stream relay</h1>
<p>This service relays video streams for the Nuvio web app so the browser can play
sources that block direct browser requests. It only relays media, not web pages.</p>
<p>Usage: <code>/stream?url=&lt;encoded video URL&gt;</code></p>
</body>`;
}
