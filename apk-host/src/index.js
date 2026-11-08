// Serves the latest Nuvio video call APK from Cloudflare.
//
// Cloudflare limits each uploaded file to 25 MiB, so CI splits the APK into
// parts (public/parts/*) and this Worker streams them back as one file.

const APK_NAME = "nuvio-video-call.apk";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const manifest = await loadManifest(env, url);
      return new Response(page(manifest), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    if (url.pathname === `/${APK_NAME}` || url.pathname === "/nuvio.apk") {
      const manifest = await loadManifest(env, url);
      if (!manifest) return new Response("APK not uploaded yet", { status: 404 });

      const headers = {
        "content-type": "application/vnd.android.package-archive",
        "content-disposition": `attachment; filename="${APK_NAME}"`,
        "content-length": String(manifest.size),
        "cache-control": "no-cache",
      };
      if (request.method === "HEAD") return new Response(null, { headers });

      const { readable, writable } = new FixedLengthStream(manifest.size);
      ctx.waitUntil(
        (async () => {
          try {
            for (const part of manifest.parts) {
              const res = await env.ASSETS.fetch(new URL(`/parts/${part}`, url));
              if (!res.ok || !res.body) throw new Error(`missing part ${part}`);
              await res.body.pipeTo(writable, { preventClose: true });
            }
            await writable.close();
          } catch (error) {
            await writable.abort(error);
          }
        })(),
      );
      return new Response(readable, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function loadManifest(env, url) {
  const res = await env.ASSETS.fetch(new URL("/parts/manifest.json", url));
  if (!res.ok) return null;
  return res.json();
}

function page(manifest) {
  const size = manifest ? `${Math.round(manifest.size / 1048576)} MB` : "not uploaded yet";
  const built = manifest?.builtAt ? new Date(manifest.builtAt).toUTCString() : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nuvio with video calls</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f13;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;text-align:center}a{display:inline-block;margin-top:20px;padding:14px 22px;border-radius:999px;background:#3dd68c;color:#0f0f13;font-weight:700;text-decoration:none}
p{color:#aaa;line-height:1.5}</style></head><body><main>
<h1>Nuvio with video calls</h1>
<p>Latest build · ${size}${built ? `<br>${built}` : ""}</p>
<a href="/${APK_NAME}">Download APK</a>
<p>Open the downloaded file to install. Android may ask you to allow installs from your browser.</p>
</main></body></html>`;
}
