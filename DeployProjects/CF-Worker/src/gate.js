// The website's data is behind one Turnstile check, so crawlers can't read or trigger anything:
// POST /session {token} checks the captcha once and returns a pass (its expiry + an HMAC of it,
// keyed by SHARED_TOKEN). The page sends it as "x-pass" on every call until it expires, then the
// widget makes a new token. (A Turnstile token works only once, so it can't cover polling itself.)
import { turnstileOk } from "./cloudflare.js";
import { json, hex } from "./util.js";

const PASS_MS = 60 * 60e3; // one hour

async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`web-pass|${env.SHARED_TOKEN}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

// POST /session: {token} from the Turnstile widget -> {pass, exp}
export async function webSession(req, env) {
  const { token } = await req.json().catch(() => ({}));
  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (!token || !(await turnstileOk(env, String(token), ip))) return json({ error: "captcha" }, 403);
  const exp = Date.now() + PASS_MS;
  return json({ pass: `${exp}.${await sign(env, String(exp))}`, exp });
}

// true when the request carries a valid, unexpired pass
export async function passOk(env, req) {
  const [exp, sig] = (req.headers.get("x-pass") || "").split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const want = await sign(env, exp);
  if (sig.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= sig.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
