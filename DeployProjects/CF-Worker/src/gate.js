// The website's data is behind one Turnstile check, so crawlers can't read or trigger anything:
// POST /session {token} checks the captcha once and returns a pass "<ip>:<expiry>:<hmac>" - the
// visitor's IP, now + 10 min, and an HMAC of both keyed by SHARED_TOKEN. The page sends it as
// "x-pass" on every call; it only works from that IP and until it expires. The widget renews its
// token every ~5 min (Turnstile tokens last 300 s), and the page trades each one for a new pass.
// (A Turnstile token works only once, so it can't cover polling itself.)
import { turnstileOk } from "./cloudflare.js";
import { json, hex } from "./util.js";

const PASS_MS = 10 * 60e3; // ten minutes
const ipOf = (req) => req.headers.get("CF-Connecting-IP") || "";

async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`web-pass|${env.SHARED_TOKEN}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

// POST /session: {token} from the Turnstile widget -> {pass, exp}
export async function webSession(req, env) {
  const { token } = await req.json().catch(() => ({}));
  const ip = ipOf(req);
  if (!token || !(await turnstileOk(env, String(token), ip))) return json({ error: "captcha" }, 403);
  const exp = Date.now() + PASS_MS;
  return json({ pass: `${ip}:${exp}:${await sign(env, `${ip}:${exp}`)}`, exp });
}

// true when the request carries a valid, unexpired pass made for this request's IP.
// (Split from the right: an IPv6 address has colons of its own.)
export async function passOk(env, req) {
  const p = req.headers.get("x-pass") || "";
  const b = p.lastIndexOf(":"), a = p.lastIndexOf(":", b - 1);
  if (a < 0) return false;
  const ip = p.slice(0, a), exp = p.slice(a + 1, b), sig = p.slice(b + 1);
  if (!sig || ip !== ipOf(req) || !(Number(exp) > Date.now())) return false;
  const want = await sign(env, `${ip}:${exp}`);
  if (sig.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= sig.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
