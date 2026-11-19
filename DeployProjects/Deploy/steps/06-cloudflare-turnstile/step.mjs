// Cloudflare Turnstile: the captcha widget behind the landing page's "Wake the server" button.
import { F, cfApi } from "../../lib.mjs";
import { S } from "../../specs.mjs";

export default {
  title: "Cloudflare Turnstile: the captcha widget for the Start button",
  manual: ["an API token with Account > Turnstile Edit (shown as \"Account.Turnstile\" / \"Challenge Widgets\")"],
  waitMin: 2,
  env: [
    S.CF_API_TOKEN("Account > Turnstile Edit"), S.CF_ACCOUNT_ID, S.DOMAIN,
    { name: "TURNSTILE_NAME", f: F.any, required: true, def: "rising2-start", about: "the widget's name (found again by it)" },
  ],

  async deploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const A = `/accounts/${E.CF_ACCOUNT_ID}/challenges/widgets`;
    const ex = (await cf("GET", A)).find((w) => w.name === E.TURNSTILE_NAME);
    let w;
    if (ex) {
      w = await cf("GET", `${A}/${ex.sitekey}`);
      if (!(w.domains || []).includes(E.DOMAIN)) {
        w = await cf("PUT", `${A}/${ex.sitekey}`, { name: w.name, domains: [...(w.domains || []), E.DOMAIN], mode: w.mode || "managed" });
        R.ok("widget", `"${E.TURNSTILE_NAME}" exists, added ${E.DOMAIN}`);
      } else R.ok("widget", `"${E.TURNSTILE_NAME}" exists for ${w.domains.join(", ")}`);
    } else {
      w = await cf("POST", A, { name: E.TURNSTILE_NAME, domains: [E.DOMAIN], mode: "managed" });
      R.ok("widget", `created "${E.TURNSTILE_NAME}" for ${E.DOMAIN}`);
    }
    R.output("TURNSTILE_SITEKEY", w.sitekey);
    if (w.secret) R.output("TURNSTILE_SECRET", w.secret, true);
    else R.warn("secret", "Cloudflare didn't return the secret: copy it from dashboard > Turnstile > the widget > Settings");
  },

  async undeploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const A = `/accounts/${E.CF_ACCOUNT_ID}/challenges/widgets`;
    const ws = (await cf("GET", A)).filter((w) => w.name === E.TURNSTILE_NAME);
    for (const w of ws) await cf("DELETE", `${A}/${w.sitekey}`);
    R.ok("widget", ws.length ? `deleted "${E.TURNSTILE_NAME}"` : "none to delete");
  },
};
