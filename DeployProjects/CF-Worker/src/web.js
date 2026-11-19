// Website-facing: the landing page's "Wake the server" button.
import { startVm } from "./server.js";
import { turnstileOk } from "./cloudflare.js";
import { json } from "./util.js";

// POST /start, a form with the Turnstile token. One start per IP per START_COOLDOWN_HOURS.
export async function webStart(req, env, ctx) {
  const form = await req.formData().catch(() => null);
  const token = form?.get("cf-turnstile-response");
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  if (!token || !(await turnstileOk(env, token, ip))) return json({ error: "captcha" }, 403);

  const res = await startVm(env, ctx, "Website", `ip_${ip}`);
  if (res.error === "cooldown") return json(res, 429);
  if (res.error === "budget") return json(res, 403);
  return json(res, res.ok ? 200 : res.error === "ovh" ? 502 : 409);
}
