// Rising2 control worker: starts/stops the lazy OVH game VM, keeps its status in R2,
// points ip.rising2.net at it, and answers the Discord /start /stop /status commands.
// No dependencies: fetch, WebCrypto and the R2 binding only. Wrangler bundles the modules.
//
// This file is the list of every inbound call (the whole API); the work is done in:
//   web.js        website: Start button (Turnstile)
//   discord.js    Discord: slash commands + webhook posts
//   server.js     the VM's life cycle: start checks, stop, teardown, status log
//   ovh.js        OVH API: signed requests, instances, this month's cost
//   cloudflare.js Cloudflare: R2 (status, stop flag, rate limit, files), DNS, Turnstile
import { webStart } from "./web.js";
import { discordInteraction } from "./discord.js";
import { addEvent, teardown } from "./server.js";
import { readStatus, stopRequested, setDns, r2File } from "./cloudflare.js";
import { json } from "./util.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    try {
      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

      // ---- public ----
      if (path === "/status" && req.method === "GET") return cors(json(await readStatus(env)));
      if (path === "/start" && req.method === "POST") return cors(await webStart(req, env, ctx));
      if (path === "/discord" && req.method === "POST") return await discordInteraction(req, env, ctx);

      // ---- VM only (shared token) ----
      if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
      if (path === "/event" && req.method === "POST") {
        const { msg, state } = await req.json();
        await addEvent(env, String(msg || "").slice(0, 300), state);
        return json({ ok: true });
      }
      if (path === "/dns" && req.method === "POST") {
        const ip = req.headers.get("CF-Connecting-IP");
        await setDns(env, ip);
        return json({ ok: true, ip });
      }
      if (path === "/should-stop" && req.method === "GET") {
        return json({ stop: await stopRequested(env) });
      }
      if (path === "/teardown" && req.method === "POST") {
        ctx.waitUntil(teardown(env, "VM asked for teardown"));
        return json({ ok: true });
      }
      // R2 file access for the VM: server/* read-only (compose + .env), configs_sync/* read/write
      const m = path.match(/^\/r2\/(server|configs_sync)\/([\w.-]+)$/);
      if (m) return await r2File(req, env, `${m[1]}/${m[2]}`, m[1] === "configs_sync");

      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(e.stack || e);
      return cors(json({ error: String(e.message || e) }, 500));
    }
  },
};

// Bearer SHARED_TOKEN, compared in constant time.
function authed(req, env) {
  const got = req.headers.get("authorization") || "";
  const want = `Bearer ${env.SHARED_TOKEN}`;
  if (!env.SHARED_TOKEN || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function cors(res) {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return res;
}
