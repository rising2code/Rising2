// Cloudflare services: R2 (status, stop flag, rate limit, the VM's files), DNS and Turnstile.
import { json } from "./util.js";

const STATUS_KEY = "functions/vm_status.txt"; // {state, updated, log: [last 10 {t, msg}]}
const STOP_KEY = "functions/stop_request";    // present = the VM should sync and tear itself down

// ---- status (public, GET /status) ----

export async function readStatus(env) {
  const obj = await env.R2.get(STATUS_KEY);
  return obj ? JSON.parse(await obj.text()) : { state: "off", updated: 0, log: [] };
}

export async function writeStatus(env, st) {
  await env.R2.put(STATUS_KEY, JSON.stringify(st));
}

// ---- stop flag ----

export const setStopRequest = (env, why) => env.R2.put(STOP_KEY, why);
export const clearStopRequest = (env) => env.R2.delete(STOP_KEY);
export const stopRequested = async (env) => !!(await env.R2.head(STOP_KEY));

// ---- rate limit ----

// ratelimit/<who> holds the time of the last start. An R2 lifecycle rule deletes these after a
// day, so the folder never grows (see README). Returns hours left, or 0 and records this start.
export async function cooldown(env, who) {
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

// ---- files for the VM: GET always, PUT only where writable ----

export async function r2File(req, env, key, writable) {
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

// ---- DNS: DNS_NAME -> ip (grey cloud, DNS_TTL) ----

export async function setDns(env, ip) {
  const api = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`;
  const h = { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" };
  const found = await (await fetch(`${api}?type=A&name=${env.DNS_NAME}`, { headers: h })).json();
  const rec = { type: "A", name: env.DNS_NAME, content: ip, ttl: Number(env.DNS_TTL), proxied: false };
  const id = found.result?.[0]?.id;
  const r = await fetch(id ? `${api}/${id}` : api, { method: id ? "PUT" : "POST", headers: h, body: JSON.stringify(rec) });
  if (!r.ok) throw new Error(`DNS update failed: ${r.status} ${await r.text()}`);
}

// ---- Turnstile (the captcha on the website) ----

export async function turnstileOk(env, token, ip) {
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  return (await r.json()).success === true;
}
