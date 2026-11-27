// Website-facing: the landing page's "Wake the server" button.
import { startVm } from "./server.js";
import { passOk } from "./gate.js";
import { json } from "./util.js";

// POST /start, with the page's Turnstile pass (x-pass). One start per IP per START_COOLDOWN_HOURS.
export async function webStart(req, env, ctx) {
  if (!(await passOk(env, req))) return json({ error: "captcha" }, 403);
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const res = await startVm(env, ctx, "Website", `ip_${ip}`);
  if (res.error === "cooldown") return json(res, 429);
  if (res.error === "budget") return json(res, 403);
  return json(res, res.ok ? 200 : res.error === "ovh" ? 502 : 409);
}
