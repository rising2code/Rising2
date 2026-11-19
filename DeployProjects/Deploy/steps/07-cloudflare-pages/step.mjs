// Cloudflare Pages: the landing page (CONFIG filled in), its custom domains <domain> + www, and their DNS.
import fs from "node:fs";
import path from "node:path";
import { F, SRC, BUILD, cfApi, zoneOf, waitFor, wrangler } from "../../lib.mjs";
import { S } from "../../specs.mjs";

export default {
  title: "Cloudflare Pages: the landing page on <domain> and www",
  manual: ["an API token with Account > Cloudflare Pages Edit and Zone > DNS Edit + Zone Read",
    "06-cloudflare-turnstile done (it prints TURNSTILE_SITEKEY)"],
  waitMin: 15,
  env: [
    S.CF_API_TOKEN("Account > Cloudflare Pages Edit, Zone > DNS Edit + Zone Read"), S.CF_ACCOUNT_ID, S.DOMAIN,
    { name: "PAGES_PROJECT", f: F.name, required: true, def: "rising2", about: "the Pages project name (the site is also at <name>.pages.dev)" },
    { name: "TURNSTILE_SITEKEY", f: F.turnstileSite, required: true, about: "the captcha's site key (06-cloudflare-turnstile prints it)" },
    { name: "DISCORD_INVITE", f: F.invite, about: "the Discord buttons' link" },
    { name: "DOWNLOAD_URL", f: F.url, about: "the \"1.3GB ZIP download\" buttons' link" },
  ],

  async deploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const A = `/accounts/${E.CF_ACCOUNT_ID}/pages/projects`;

    // the site, with CONFIG patched (the repo's app.js is never changed)
    const out = path.join(BUILD, "site");
    fs.rmSync(out, { recursive: true, force: true });
    for (const f of ["index.html", "style.css", "app.js", "assets"]) {
      fs.cpSync(path.join(SRC, "LandingPage", f), path.join(out, f), { recursive: true });
    }
    let js = fs.readFileSync(path.join(out, "app.js"), "utf8");
    const set = (key, val) => { if (val) js = js.replace(new RegExp(`(${key}: )"[^"]*"`), `$1${JSON.stringify(val)}`); };
    set("turnstileSiteKey", E.TURNSTILE_SITEKEY); set("discord", E.DISCORD_INVITE); set("download", E.DOWNLOAD_URL);
    fs.writeFileSync(path.join(out, "app.js"), js);
    if (!E.DISCORD_INVITE) R.warn("DISCORD_INVITE", "not set: the Discord buttons keep the placeholder link");
    if (!E.DOWNLOAD_URL) R.warn("DOWNLOAD_URL", "not set: the download buttons keep the placeholder link");

    if (!(await cf("GET", A)).some((p) => p.name === E.PAGES_PROJECT)) {
      await cf("POST", A, { name: E.PAGES_PROJECT, production_branch: "main" });
      R.ok("project", `created ${E.PAGES_PROJECT}`);
    } else R.ok("project", `${E.PAGES_PROJECT} exists`);
    wrangler(["pages", "deploy", out, "--project-name", E.PAGES_PROJECT, "--branch", "main", "--commit-dirty=true"], { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID });
    R.ok("upload", `site uploaded to ${E.PAGES_PROJECT}.pages.dev`);

    // custom domains + their DNS (CNAME to <project>.pages.dev, proxied)
    const z = await zoneOf(cf, E.DOMAIN);
    const recs = await cf("GET", `/zones/${z.id}/dns_records?per_page=500`);
    const have = (await cf("GET", `${A}/${E.PAGES_PROJECT}/domains`)).map((d) => d.name);
    for (const d of [E.DOMAIN, `www.${E.DOMAIN}`]) {
      if (!have.includes(d)) await cf("POST", `${A}/${E.PAGES_PROJECT}/domains`, { name: d });
      const ex = recs.filter((r) => r.name === d);
      if (!ex.length) await cf("POST", `/zones/${z.id}/dns_records`, { type: "CNAME", name: d, content: `${E.PAGES_PROJECT}.pages.dev`, proxied: true, ttl: 1 });
      else if (!(ex[0].type === "CNAME" && ex[0].content === `${E.PAGES_PROJECT}.pages.dev`)) R.warn(d, `DNS already has ${ex[0].type} ${ex[0].content} - kept; the custom domain needs CNAME ${E.PAGES_PROJECT}.pages.dev`);
    }
    // Pages checks the domain and issues a certificate: this is the slow part
    await waitFor("the custom domains to be active", async () => {
      const ds = await cf("GET", `${A}/${E.PAGES_PROJECT}/domains`);
      return [E.DOMAIN, `www.${E.DOMAIN}`].every((n) => ds.find((d) => d.name === n)?.status === "active");
    }, { minutes: E.WAIT_MIN, everySec: 20 });
    R.ok("domains", `${E.DOMAIN} and www.${E.DOMAIN} active`);
    const site = process.env.SITE_CHECK_URL || `https://${E.DOMAIN}/`; // (SITE_CHECK_URL: only for testing this script)
    const r = await waitFor(site, async () => { const r = await fetch(site); return r.ok ? r : null; }, { minutes: E.WAIT_MIN });
    R.ok("site", `${site} answers ${r.status}`);
  },

  async undeploy(E, R) {
    const cf = cfApi(E.CF_API_TOKEN);
    const A = `/accounts/${E.CF_ACCOUNT_ID}/pages/projects`;
    const exists = (await cf("GET", A)).some((p) => p.name === E.PAGES_PROJECT);
    if (exists) {
      for (const d of await cf("GET", `${A}/${E.PAGES_PROJECT}/domains`)) await cf("DELETE", `${A}/${E.PAGES_PROJECT}/domains/${d.name}`);
      await cf("DELETE", `${A}/${E.PAGES_PROJECT}`);
      R.ok("project", `deleted ${E.PAGES_PROJECT} and its custom domains`);
    } else R.ok("project", `${E.PAGES_PROJECT} doesn't exist`);
    const z = await zoneOf(cf, E.DOMAIN);
    const recs = (await cf("GET", `/zones/${z.id}/dns_records?per_page=500`))
      .filter((r) => [E.DOMAIN, `www.${E.DOMAIN}`].includes(r.name) && r.type === "CNAME" && r.content === `${E.PAGES_PROJECT}.pages.dev`);
    for (const r of recs) await cf("DELETE", `/zones/${z.id}/dns_records/${r.id}`);
    R.ok("DNS", recs.length ? `deleted ${recs.map((r) => r.name).join(", ")}` : "no records pointing at the project");
  },
};
