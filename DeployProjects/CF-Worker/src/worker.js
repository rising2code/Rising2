// Rising2 control worker: starts/stops the lazy OVH game VM, keeps its status in R2,
// points ip.rising2.net at it, and answers the Discord /start /stop /status commands.
// No dependencies: fetch, WebCrypto and the R2 binding only.
import CLOUD_INIT from "../../LazyServer/cloud_init.sh";

const STATUS_KEY = "functions/vm_status.txt"; // {state, updated, log: [last 10 {t, msg}]}
const STOP_KEY = "functions/stop_request";    // present = the VM should sync and tear itself down
const LOG_KEEP = 10;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    try {
      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

      // ---- public ----
      if (path === "/status" && req.method === "GET") return cors(json(await readStatus(env)));
      if (path === "/start" && req.method === "POST") return cors(await webStart(req, env, ctx));
      if (path === "/discord" && req.method === "POST") return await discord(req, env, ctx);

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
        return json({ stop: !!(await env.R2.head(STOP_KEY)) });
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

// ------------------------------------------------------------------ web start (Turnstile)

async function webStart(req, env, ctx) {
  const form = await req.formData().catch(() => null);
  const token = form?.get("cf-turnstile-response");
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  if (!token || !(await turnstileOk(env, token, ip))) return json({ error: "captcha" }, 403);

  const wait = await cooldown(env, `ip_${ip}`);
  if (wait) return json({ error: "cooldown", retryAfterHours: wait }, 429);

  const res = await startVm(env, ctx, "Website");
  return json(res, res.ok ? 200 : 409);
}

async function turnstileOk(env, token, ip) {
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  return (await r.json()).success === true;
}

// Rate limit: ratelimit/<who> holds the time of the last try. An R2 lifecycle rule deletes
// these after a day, so the folder never grows (see README).
async function cooldown(env, who) {
  const key = `ratelimit/${who.replace(/[^\w.:-]/g, "_")}`;
  const hours = Number(env.START_COOLDOWN_HOURS || 20);
  const obj = await env.R2.get(key);
  if (obj) {
    const left = hours - (Date.now() - Number(await obj.text())) / 3600e3;
    if (left > 0) return Math.ceil(left);
  }
  await env.R2.put(key, String(Date.now()));
  return 0;
}

// ------------------------------------------------------------------ VM life cycle

async function startVm(env, ctx, by) {
  const existing = await findInstance(env);
  if (existing) return { ok: false, error: "already running", state: (await readStatus(env)).state };

  await env.R2.delete(STOP_KEY);
  await addEvent(env, `Start requested (${by})`, "starting");
  ctx.waitUntil(createInstance(env).catch((e) => addEvent(env, `Start failed: ${e.message}`, "off")));
  return { ok: true, state: "starting" };
}

async function createInstance(env) {
  const region = env.OVH_REGION;
  const [flavors, images] = await Promise.all([
    ovh(env, "GET", `/cloud/project/${env.OVH_PROJECT}/flavor?region=${region}`),
    ovh(env, "GET", `/cloud/project/${env.OVH_PROJECT}/image?region=${region}&osType=linux`),
  ]);
  const image = images.find((i) => i.name === env.OVH_IMAGE);
  if (!image) throw new Error(`image ${env.OVH_IMAGE} not found in ${region}`);

  const userData = CLOUD_INIT
    .replaceAll("__WORKER_URL__", `${env.PUBLIC_URL}/api`)
    .replaceAll("__TOKEN__", env.SHARED_TOKEN)
    .replaceAll("__GAME_ZIP_URL__", env.GAME_ZIP_URL);

  let lastErr;
  for (const name of env.OVH_FLAVORS.split(",").map((s) => s.trim())) {
    const flavor = flavors.find((f) => f.name === name);
    if (!flavor) continue;
    try {
      await ovh(env, "POST", `/cloud/project/${env.OVH_PROJECT}/instance`, {
        name: env.VM_NAME, region, flavorId: flavor.id, imageId: image.id, userData, monthlyBilling: false,
      });
      await addEvent(env, `VM created (${name}), booting...`, "starting");
      return;
    } catch (e) {
      lastErr = e;
      await addEvent(env, `Flavor ${name} failed: ${e.message.slice(0, 120)}`);
    }
  }
  throw lastErr || new Error("no flavor available");
}

async function findInstance(env) {
  const list = await ovh(env, "GET", `/cloud/project/${env.OVH_PROJECT}/instance?region=${env.OVH_REGION}`);
  return list.find((i) => i.name === env.VM_NAME) || null;
}

// Graceful: the VM sees the flag within a minute, syncs to R2, then calls /teardown.
async function requestStop(env, why) {
  await env.R2.put(STOP_KEY, why);
  await addEvent(env, `${why}: stopping after a final sync...`, "stopping");
}

// Called by the VM after its final sync: delete it and park the DNS name.
async function teardown(env, why) {
  const inst = await findInstance(env);
  if (inst) await ovh(env, "DELETE", `/cloud/project/${env.OVH_PROJECT}/instance/${inst.id}`);
  await env.R2.delete(STOP_KEY);
  await setDns(env, "127.0.0.1").catch(() => {}); // don't leave the name on an IP someone else may get
  await addEvent(env, `${why}: VM deleted`, "off");
}

// ------------------------------------------------------------------ status log

async function readStatus(env) {
  const obj = await env.R2.get(STATUS_KEY);
  return obj ? JSON.parse(await obj.text()) : { state: "off", updated: 0, log: [] };
}

async function addEvent(env, msg, state) {
  const st = await readStatus(env);
  if (state) st.state = state;
  st.updated = Date.now();
  if (msg) st.log = [...st.log, { t: st.updated, msg }].slice(-LOG_KEEP);
  await env.R2.put(STATUS_KEY, JSON.stringify(st));
  if (msg && env.DISCORD_WEBHOOK_URL) {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `\`[${st.state}]\` ${msg}`, allowed_mentions: { parse: [] } }),
    }).catch(() => {});
  }
}

// ------------------------------------------------------------------ R2 files for the VM

async function r2File(req, env, key, writable) {
  if (req.method === "GET") {
    const obj = await env.R2.get(key);
    return obj ? new Response(obj.body) : json({ error: "not found" }, 404);
  }
  if (req.method === "PUT" && writable) {
    // keep the previous copy, so one bad upload can't wipe the stats
    const old = await env.R2.get(key);
    if (old) await env.R2.put(`${key}.prev`, old.body);
    await env.R2.put(key, req.body);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}

// ------------------------------------------------------------------ Cloudflare DNS

async function setDns(env, ip) {
  const api = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`;
  const h = { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" };
  const found = await (await fetch(`${api}?type=A&name=${env.DNS_NAME}`, { headers: h })).json();
  const rec = { type: "A", name: env.DNS_NAME, content: ip, ttl: Number(env.DNS_TTL), proxied: false };
  const id = found.result?.[0]?.id;
  const r = await fetch(id ? `${api}/${id}` : api, { method: id ? "PUT" : "POST", headers: h, body: JSON.stringify(rec) });
  if (!r.ok) throw new Error(`DNS update failed: ${r.status} ${await r.text()}`);
}

// ------------------------------------------------------------------ OVH API (signed requests)

async function ovh(env, method, path, body) {
  const url = env.OVH_ENDPOINT + path;
  const data = body ? JSON.stringify(body) : "";
  const now = Math.floor(Date.now() / 1000);
  const toSign = [env.OVH_APP_SECRET, env.OVH_CONSUMER_KEY, method, url, data, now].join("+");
  const sig = "$1$" + hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(toSign)));
  const r = await fetch(url, {
    method, body: data || undefined,
    headers: {
      "content-type": "application/json",
      "X-Ovh-Application": env.OVH_APP_KEY,
      "X-Ovh-Consumer": env.OVH_CONSUMER_KEY,
      "X-Ovh-Timestamp": String(now),
      "X-Ovh-Signature": sig,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OVH ${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------------ Discord interactions

async function discord(req, env, ctx) {
  const body = await req.text();
  if (!(await discordSigOk(env, req, body))) return new Response("bad signature", { status: 401 });
  const it = JSON.parse(body);
  if (it.type === 1) return json({ type: 1 }); // PING

  const user = it.member?.user || it.user || {};
  const isAdmin = !!env.DISCORD_ADMIN_ROLE && (it.member?.roles || []).includes(env.DISCORD_ADMIN_ROLE);
  const reply = (content) => json({ type: 4, data: { content, flags: 64 } }); // 64 = only the caller sees it

  switch (it.data?.name) {
    case "status": {
      const st = await readStatus(env);
      const log = st.log.map((l) => `<t:${Math.floor(l.t / 1000)}:t> ${l.msg}`).join("\n");
      return reply(`**State:** ${st.state}\n${log || "(no events yet)"}`);
    }
    case "start": {
      if (!isAdmin) {
        const wait = await cooldown(env, `discord_${user.id}`);
        if (wait) return reply(`You already used Start today. Try again in ~${wait}h.`);
      }
      const res = await startVm(env, ctx, `Discord: ${user.username}`);
      return reply(res.ok ? "Starting the server... follow with `/status`." : `Not started: ${res.error}.`);
    }
    case "stop": {
      if (!isAdmin) return reply("Only admins can stop the server.");
      await requestStop(env, `Stop by ${user.username}`);
      return reply("The server will sync and shut down within a minute or two.");
    }
  }
  return reply("Unknown command.");
}

async function discordSigOk(env, req, body) {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;
  const key = await crypto.subtle.importKey("raw", unhex(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, unhex(sig), new TextEncoder().encode(ts + body));
}

// ------------------------------------------------------------------ helpers

function authed(req, env) {
  const got = req.headers.get("authorization") || "";
  const want = `Bearer ${env.SHARED_TOKEN}`;
  if (!env.SHARED_TOKEN || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function cors(res) {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return res;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
