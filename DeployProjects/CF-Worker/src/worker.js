// Rising2 control worker: starts/stops the lazy OVH game VM, keeps its status in R2,
// points ip.rising2.net at it, and answers the Discord /start /stop /status commands.
// No dependencies: fetch, WebCrypto and the R2 binding only. Wrangler bundles the modules.
//
// This file is the list of every inbound call (the whole API); the work is done in:
//   gate.js       website: the Turnstile check -> a one-hour pass for every website call
//   web.js        website: Start button
//   files.js      website: links (urls.json), the archive list (s3files.json), signed S3 downloads
//   discord.js    Discord: slash commands + webhook posts
//   server.js     the VM's life cycle: start checks, stop, teardown, status log
//   ovh.js        OVH API: signed requests, instances, this month's cost
//   cloudflare.js Cloudflare: R2 (status, stop flag, rate limit, files), DNS, Turnstile
import { webStart } from "./web.js";
import { webSession, passOk } from "./gate.js";
import { getLinks, getFiles, signFile } from "./files.js";
import { discordInteraction } from "./discord.js";
import { addEvent, setPlayers, teardown, startVm, requestStop } from "./server.js";
import { readStatus, stopRequested, setDns, r2File } from "./cloudflare.js";
import { json, maskDiscordIds } from "./util.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    try {
      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

      // ---- open: the captcha check itself, and Discord (it signs its own requests) ----
      if (path === "/session" && req.method === "POST") return cors(await webSession(req, env));
      if (path === "/discord" && req.method === "POST") return await discordInteraction(req, env, ctx);

      // ---- website: only with the Turnstile pass (the VM / deploy tests may use the shared token) ----
      const web = ["/status", "/start", "/links", "/get-files", "/sign-s3-1"].includes(path);
      if (web && !(await passOk(env, req)) && !authed(req, env)) return cors(json({ error: "pass" }, 401));
      if (path === "/status" && req.method === "GET") {
        const st = await readStatus(env);
        st.log = st.log.map((l) => ({ ...l, msg: maskDiscordIds(l.msg) })); // web only: no full Discord ids
        return cors(json(st));
      }
      if (path === "/start" && req.method === "POST") return cors(await webStart(req, env, ctx));
      if (path === "/links" && req.method === "GET") return cors(await getLinks(env));
      if (path === "/get-files" && req.method === "GET") return cors(await getFiles(env));
      if (path === "/sign-s3-1" && req.method === "POST") return cors(await signFile(req, env));

      // ---- VM only (shared token) ----
      if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
      if (path === "/event" && req.method === "POST") {
        const { msg, state } = await req.json();
        await addEvent(env, String(msg || "").slice(0, 300), state);
        return json({ ok: true });
      }
      if (path === "/players" && req.method === "POST") {
        const { players } = await req.json().catch(() => ({}));
        await setPlayers(env, players);
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
      // Deploy test loop (Deploy/deploy.mjs): start / stop with the same checks as everyone
      // (VM exists, budget), but no captcha and no cooldown. Token-only, like the VM's calls.
      if (path === "/admin/start" && req.method === "POST") {
        const res = await startVm(env, ctx, "Deploy test", null);
        return json(res, res.ok ? 200 : res.error === "budget" ? 403 : res.error === "ovh" ? 502 : 409);
      }
      if (path === "/admin/stop" && req.method === "POST") {
        await requestStop(env, "Deploy test");
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
  res.headers.set("access-control-allow-headers", "content-type, x-pass");
  return res;
}
