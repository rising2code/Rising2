// Rising2 one-shot deploy + test loop. Runs inside the Deploy Docker image (node + wrangler),
// see README.md. No npm packages: fetch, crypto and child_process only.
//
//   1. check the inputs (deploy.env) and the API keys
//   2. OVH: find the Public Cloud project by name (or order one), check region/flavor/image/cost
//   3. Cloudflare: zone, Turnstile widget, DNS records, R2 bucket + lifecycle,
//      VM files in R2 (LazyServer/docker-compose.yml + server.env), worker + secrets, landing page
//   4. Discord (optional): slash commands, interactions URL, webhook
//   5. TEST_VM=yes: start a VM through the worker, wait for "up", stop it, wait until it's gone
//
// Every step is printed as it runs and written to /out/report.md + /out/report.json.
// Generated values (shared token, Turnstile keys, OVH project id) are kept in /out/generated.env
// so a second run reuses them.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SRC = process.env.SRC_DIR || "/app";          // DeployProjects, mounted read-only
const OUT = process.env.OUT_DIR || "/out";          // report + generated values
const BUILD = "/tmp/rising2-build";                  // patched copies (wrangler.toml, app.js)
const DRY = process.env.DRY_RUN === "1";             // wrangler commands are printed, not run
const CF = process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4";
const DISCORD = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";

fs.mkdirSync(OUT, { recursive: true });
const GEN_FILE = path.join(OUT, "generated.env");
const gen = readEnvFile(GEN_FILE);
const E = { ...defaults(), ...gen, ...clean(process.env) };

// ------------------------------------------------------------------ report

const steps = [];
const missing = [];
const ICON = { ok: "✅", warn: "⚠️", fail: "❌", skip: "⏭️", info: "ℹ️" };
function rec(status, name, detail = "") {
  steps.push({ status, name, detail, at: new Date().toISOString() });
  console.log(`${ICON[status]} ${name}${detail ? ` - ${detail}` : ""}`);
  writeReport();
}
const ok = (n, d) => rec("ok", n, d), warn = (n, d) => rec("warn", n, d), fail = (n, d) => rec("fail", n, d);
const skip = (n, d) => rec("skip", n, d), info = (n, d) => rec("info", n, d);
const need = (name, what) => { missing.push({ name, what }); };

function writeReport() {
  const count = (s) => steps.filter((x) => x.status === s).length;
  const summary = { ok: count("ok"), warn: count("warn"), fail: count("fail"), skip: count("skip") };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ when: new Date().toISOString(), domain: E.DOMAIN, summary, missing, steps }, null, 2));
  const md = [
    `# Rising2 deploy report`, ``, `${new Date().toISOString()} - domain \`${E.DOMAIN || "?"}\`${DRY ? " - DRY RUN" : ""}`, ``,
    `**${summary.ok} ok, ${summary.warn} warnings, ${summary.fail} failed, ${summary.skip} skipped**`, ``,
    ...(missing.length ? [`## Missing settings`, ``, `| Variable | Needed for |`, `|---|---|`, ...missing.map((m) => `| \`${m.name}\` | ${m.what} |`), ``] : []),
    `## Steps`, ``, `| | Step | Detail |`, `|---|---|---|`,
    ...steps.map((s) => `| ${ICON[s.status]} | ${s.name} | ${String(s.detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`), ``,
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "report.md"), md);
}

// Runs a step; an exception marks it failed (with the message) and returns undefined.
async function step(name, fn) {
  try { return await fn(); } catch (e) { fail(name, e.message); }
}

// ------------------------------------------------------------------ main

// (main() is called on the last line of the file, once every helper below is defined)
async function main() {
  console.log(`Rising2 deploy${DRY ? " (DRY RUN: wrangler commands are only printed)" : ""}\n`);
  checkInputs();
  if (!E.DOMAIN || !E.CF_API_TOKEN) {
    fail("inputs", "DOMAIN and CF_API_TOKEN are required - nothing deployed");
    finish();
  }
  const ovhOk = await ovhPart();
  const app = await discordApp();          // before the worker: it needs the app's public key
  const cf = await cloudflarePart(ovhOk);
  await discordPart(cf, app);
  await testLoop(cf, ovhOk);
  finish();
}

// ------------------------------------------------------------------ 1. inputs

function checkInputs() {
  const req = {
    DOMAIN: "everything (the site, the API, ip.<domain>)",
    CF_API_TOKEN: "Cloudflare: DNS, R2, worker, Pages, Turnstile",
    OVH_APP_KEY: "OVH: project, VMs, cost", OVH_APP_SECRET: "OVH API", OVH_CONSUMER_KEY: "OVH API",
    GAME_ZIP_URL: "the VM downloads the game from it",
  };
  for (const [k, what] of Object.entries(req)) if (!E[k]) need(k, what);
  const opt = {
    DISCORD_APP_ID: "Discord slash commands", DISCORD_BOT_TOKEN: "Discord slash commands + interactions URL",
    DISCORD_WEBHOOK_URL: "status / cost posts in the Discord channel", DISCORD_INVITE: "the Discord buttons on the landing page",
    DOWNLOAD_URL: "the 1.3GB ZIP download buttons on the landing page",
  };
  for (const [k, what] of Object.entries(opt)) if (!E[k]) need(k, `${what} (optional)`);
  const bad = Object.keys(req).filter((k) => !E[k]);
  if (bad.length) warn("inputs", `missing: ${bad.join(", ")}`);
  else ok("inputs", "all required settings are set");
}

// ------------------------------------------------------------------ 2. OVH

async function ovhPart() {
  if (!E.OVH_APP_KEY || !E.OVH_APP_SECRET || !E.OVH_CONSUMER_KEY) { skip("OVH", "no OVH API keys"); return false; }

  const cred = await step("OVH: API key", () => ovh("GET", "/auth/currentCredential"));
  if (!cred) return false;
  const rules = (cred.rules || []).map((r) => `${r.method} ${r.path}`);
  const has = (m, p) => rules.some((r) => { const [rm, rp] = r.split(" "); return rm === m && new RegExp(`^${rp.replace(/\*/g, ".*")}$`).test(p); });
  const want = [["GET", "/cloud/project/x/instance"], ["POST", "/cloud/project/x/instance"], ["DELETE", "/cloud/project/x/instance/y"], ["GET", "/cloud/project/x/usage/current"]];
  const lacking = want.filter(([m, p]) => !has(m, p)).map(([m, p]) => `${m} ${p.replace("/x", "/*").replace("/y", "/*")}`);
  if (lacking.length) warn("OVH: API key", `valid, but its rules may not allow: ${lacking.join(", ")}`);
  else ok("OVH: API key", `valid (${cred.status || "ok"})`);

  // project by name (its "description" in OVH)
  const project = await step("OVH: project", async () => {
    if (E.OVH_PROJECT) {
      const p = await ovh("GET", `/cloud/project/${E.OVH_PROJECT}`);
      ok("OVH: project", `${p.description || "(no name)"} = ${E.OVH_PROJECT} (from generated.env / OVH_PROJECT)`);
      return E.OVH_PROJECT;
    }
    const ids = await ovh("GET", "/cloud/project");
    for (const id of ids) {
      const p = await ovh("GET", `/cloud/project/${id}`);
      if (p.description === E.OVH_PROJECT_NAME) { ok("OVH: project", `found "${E.OVH_PROJECT_NAME}" = ${id} (${p.status})`); return id; }
    }
    if (E.OVH_CREATE_PROJECT !== "yes") {
      need("OVH_CREATE_PROJECT", `no project named "${E.OVH_PROJECT_NAME}": set yes to order one, or create it in the OVH panel`);
      fail("OVH: project", `no project named "${E.OVH_PROJECT_NAME}" (set OVH_CREATE_PROJECT=yes to order one)`);
      return null;
    }
    return orderProject();
  });
  if (!project) return false;
  E.OVH_PROJECT = project;
  saveGenerated();
  const P = `/cloud/project/${project}`;

  await step("OVH: region", async () => {
    const regions = await ovh("GET", `${P}/region`);
    if (regions.includes(E.OVH_REGION)) ok("OVH: region", `${E.OVH_REGION} is enabled`);
    else fail("OVH: region", `${E.OVH_REGION} is not enabled in the project (enabled: ${regions.join(", ") || "none"})`);
  });
  await step("OVH: flavors + image", async () => {
    const [flavors, images] = await Promise.all([
      ovh("GET", `${P}/flavor?region=${E.OVH_REGION}`), ovh("GET", `${P}/image?region=${E.OVH_REGION}&osType=linux`),
    ]);
    const names = E.OVH_FLAVORS.split(",").map((s) => s.trim());
    const found = names.filter((n) => flavors.some((f) => f.name === n));
    const img = images.some((i) => i.name === E.OVH_IMAGE);
    if (found.length && img) ok("OVH: flavors + image", `flavors ${found.join(", ")} and "${E.OVH_IMAGE}" available in ${E.OVH_REGION}`);
    else fail("OVH: flavors + image", `${found.length ? "" : `none of ${names.join(", ")} in ${E.OVH_REGION}; `}${img ? "" : `image "${E.OVH_IMAGE}" not found`}`);
  });
  await step("OVH: cost", async () => {
    const [cur, fc] = await Promise.all([ovh("GET", `${P}/usage/current`), ovh("GET", `${P}/usage/forecast`)]);
    const c = sumPrices(cur), f = sumPrices(fc);
    const over = (Number(E.MAX_COST_CURRENT) && c >= Number(E.MAX_COST_CURRENT)) || (Number(E.MAX_COST_FORECAST) && f >= Number(E.MAX_COST_FORECAST));
    rec(over ? "warn" : "ok", "OVH: cost", `this month €${c.toFixed(2)}, forecast €${f.toFixed(2)} (limits ${E.MAX_COST_CURRENT} / ${E.MAX_COST_FORECAST})${over ? " - over the limit: Start will be refused" : ""}`);
  });
  await step("OVH: running VMs", async () => {
    const vms = await ovh("GET", `${P}/instance`);
    if (vms.length) warn("OVH: running VMs", `${vms.length} in the project (${vms.map((v) => v.name).join(", ")}): Start is refused while any exists`);
    else ok("OVH: running VMs", "none (nothing is costing money now)");
  });
  await step("Game.zip", async () => {
    if (!E.GAME_ZIP_URL) return skip("Game.zip", "GAME_ZIP_URL not set");
    const r = await fetch(E.GAME_ZIP_URL, { method: "HEAD" });
    const mb = Number(r.headers.get("content-length") || 0) / 1e6;
    if (r.ok) ok("Game.zip", `${r.status}, ${mb ? `${mb.toFixed(0)} MB` : "size unknown"}`);
    else fail("Game.zip", `${E.GAME_ZIP_URL} answered ${r.status}`);
  });
  return true;
}

// Orders a new pay-as-you-go Public Cloud project (free itself; you pay for what runs in it).
// Needs a default payment method on the OVH account. Best effort: OVH may ask for more in the panel.
async function orderProject() {
  info("OVH: project", `ordering a new Public Cloud project "${E.OVH_PROJECT_NAME}"...`);
  const cart = await ovh("POST", "/order/cart", { ovhSubsidiary: E.OVH_SUBSIDIARY, description: E.OVH_PROJECT_NAME });
  await ovh("POST", `/order/cart/${cart.cartId}/assign`);
  const item = await ovh("POST", `/order/cart/${cart.cartId}/cloud`, { duration: "P1M", planCode: "project.2018", pricingMode: "default", quantity: 1 });
  await ovh("POST", `/order/cart/${cart.cartId}/item/${item.itemId}/configuration`, { label: "description", value: E.OVH_PROJECT_NAME });
  const order = await ovh("POST", `/order/cart/${cart.cartId}/checkout`, { autoPayWithPreferredPaymentMethod: true, waiveRetractationPeriod: true });
  info("OVH: project", `order ${order.orderId} placed, waiting for the project to appear...`);
  for (let i = 0; i < 30; i++) {
    await sleep(10e3);
    for (const id of await ovh("GET", "/cloud/project")) {
      const p = await ovh("GET", `/cloud/project/${id}`);
      if (p.description === E.OVH_PROJECT_NAME) { ok("OVH: project", `created "${E.OVH_PROJECT_NAME}" = ${id} (${p.status})`); return id; }
    }
  }
  throw new Error(`order ${order.orderId} placed but no project appeared after 5 min: finish it in the OVH panel, then rerun`);
}

// ------------------------------------------------------------------ 3. Cloudflare

async function cloudflarePart(ovhOk) {
  const out = {};
  const tok = await step("Cloudflare: API token", () => cfApi("GET", "/user/tokens/verify"));
  if (!tok) return out;
  ok("Cloudflare: API token", tok.status);

  const zone = await step("Cloudflare: zone", async () => {
    const z = (await cfApi("GET", `/zones?name=${E.DOMAIN}`))[0];
    if (!z) throw new Error(`zone ${E.DOMAIN} not found for this token (add the domain to Cloudflare first)`);
    ok("Cloudflare: zone", `${z.name} (${z.status}), account ${z.account?.name || z.account?.id}`);
    return z;
  });
  if (!zone) return out;
  out.zone = zone.id;
  const acc = E.CF_ACCOUNT_ID || zone.account.id;
  out.account = acc;
  const wenv = { CLOUDFLARE_API_TOKEN: E.CF_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: acc };

  // Turnstile widget for the Start button (reused by name)
  const ts = await step("Cloudflare: Turnstile", async () => {
    if (E.TURNSTILE_SITEKEY && E.TURNSTILE_SECRET) { ok("Cloudflare: Turnstile", `site key ${E.TURNSTILE_SITEKEY} (from generated.env)`); return true; }
    const name = `${E.PAGES_PROJECT}-start`;
    const list = await cfApi("GET", `/accounts/${acc}/challenges/widgets`);
    let w = list.find((x) => x.name === name);
    w = w ? await cfApi("GET", `/accounts/${acc}/challenges/widgets/${w.sitekey}`)
          : await cfApi("POST", `/accounts/${acc}/challenges/widgets`, { name, domains: [E.DOMAIN], mode: "managed" });
    E.TURNSTILE_SITEKEY = w.sitekey; E.TURNSTILE_SECRET = w.secret;
    saveGenerated();
    ok("Cloudflare: Turnstile", `widget "${name}", site key ${w.sitekey}`);
    return true;
  });

  // DNS: ip.<domain> (the VM, grey cloud), *.<domain> -> ip, apex + www -> Pages (orange)
  await step("Cloudflare: DNS", async () => {
    const recs = await cfApi("GET", `/zones/${zone.id}/dns_records?per_page=500`);
    const find = (name) => recs.filter((r) => r.name === name);
    const done = [], kept = [];
    const ensure = async (name, type, content, proxied, ttl = 1) => {
      const ex = find(name);
      if (ex.length) { kept.push(`${name} (${ex.map((r) => `${r.type} ${r.content}`).join(", ")})`); return; }
      await cfApi("POST", `/zones/${zone.id}/dns_records`, { type, name, content, proxied, ttl });
      done.push(`${name} ${type} ${content}`);
    };
    await ensure(`ip.${E.DOMAIN}`, "A", "127.0.0.1", false, Number(E.DNS_TTL));
    await ensure(`*.${E.DOMAIN}`, "CNAME", `ip.${E.DOMAIN}`, false);
    await ensure(E.DOMAIN, "CNAME", `${E.PAGES_PROJECT}.pages.dev`, true);
    await ensure(`www.${E.DOMAIN}`, "CNAME", `${E.PAGES_PROJECT}.pages.dev`, true);
    const ipRec = find(`ip.${E.DOMAIN}`)[0];
    if (ipRec?.proxied) warn("Cloudflare: DNS", `ip.${E.DOMAIN} is proxied (orange): the game needs it grey (DNS only)`);
    ok("Cloudflare: DNS", `${done.length ? `created ${done.join("; ")}` : "nothing to create"}${kept.length ? `; kept existing ${kept.join("; ")}` : ""}`);
  });

  // R2 bucket + the 1-day lifecycle rule for ratelimit/
  const r2 = await step("Cloudflare: R2 bucket", async () => {
    const buckets = (await cfApi("GET", `/accounts/${acc}/r2/buckets`)).buckets || [];
    if (buckets.some((b) => b.name === E.R2_BUCKET)) ok("Cloudflare: R2 bucket", `${E.R2_BUCKET} exists`);
    else { await cfApi("POST", `/accounts/${acc}/r2/buckets`, { name: E.R2_BUCKET }); ok("Cloudflare: R2 bucket", `created ${E.R2_BUCKET}`); }
    return true;
  });
  if (r2) await step("Cloudflare: R2 lifecycle", async () => {
    try {
      await cfApi("PUT", `/accounts/${acc}/r2/buckets/${E.R2_BUCKET}/lifecycle`, { rules: [{
        id: "ratelimit-1d", enabled: true, conditions: { prefix: "ratelimit/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
      }] });
      ok("Cloudflare: R2 lifecycle", "ratelimit/ objects are deleted after 1 day");
    } catch (e) {
      warn("Cloudflare: R2 lifecycle", `${e.message} - set it by hand: R2 > ${E.R2_BUCKET} > Settings > Object lifecycle rules: delete prefix ratelimit/ after 1 day`);
    }
  });

  // the VM's files: LazyServer/docker-compose.yml + server.env (+ R2_ADMIN_TOKEN if empty)
  if (r2) await step("R2: VM files", async () => {
    const lazy = path.join(SRC, "LazyServer");
    const envSrc = fs.existsSync(path.join(lazy, "server.env")) ? "server.env" : "server.env.example";
    let envText = fs.readFileSync(path.join(lazy, envSrc), "utf8");
    if (envSrc === "server.env.example") warn("R2: VM files", "LazyServer/server.env not found: uploading server.env.example (passwords are change-me)");
    if (/change-me/.test(envText)) need("LazyServer/server.env", "the dedicated servers' GameSpy passwords (still change-me)");
    if (/^R2_ADMIN_TOKEN=\s*$/m.test(envText)) {
      E.R2_ADMIN_TOKEN ||= randomBytes(16).toString("hex"); saveGenerated();
      envText = envText.replace(/^R2_ADMIN_TOKEN=\s*$/m, `R2_ADMIN_TOKEN=${E.R2_ADMIN_TOKEN}`);
    }
    fs.mkdirSync(BUILD, { recursive: true });
    const envFile = path.join(BUILD, "server.env");
    fs.writeFileSync(envFile, envText);
    wrangler(["r2", "object", "put", `${E.R2_BUCKET}/server/docker-compose.yml`, "--file", path.join(lazy, "docker-compose.yml"), "--remote"], wenv);
    wrangler(["r2", "object", "put", `${E.R2_BUCKET}/server/.env`, "--file", envFile, "--remote"], wenv);
    fs.rmSync(envFile);
    ok("R2: VM files", `server/docker-compose.yml + server/.env (from ${envSrc})`);
  });

  // the worker: patched wrangler.toml (domain, bucket, settings), deploy, then secrets
  E.SHARED_TOKEN ||= randomBytes(32).toString("hex");
  saveGenerated();
  const worker = await step("Cloudflare: worker", async () => {
    const dir = path.join(BUILD, "DeployProjects");
    fs.rmSync(dir, { recursive: true, force: true });
    for (const d of ["CF-Worker", "LazyServer", "LandingPage"]) copyDir(path.join(SRC, d), path.join(dir, d));
    const tomlPath = path.join(dir, "CF-Worker", "wrangler.toml");
    let toml = fs.readFileSync(tomlPath, "utf8").replaceAll("rising2.net", E.DOMAIN);
    const set = (key, val) => { toml = toml.replace(new RegExp(`^${key} = ".*?"`, "m"), `${key} = ${JSON.stringify(val)}`); };
    set("name", E.WORKER_NAME); set("bucket_name", E.R2_BUCKET);
    for (const k of ["OVH_ENDPOINT", "OVH_REGION", "OVH_FLAVORS", "OVH_IMAGE", "VM_NAME", "GAME_ZIP_URL", "START_COOLDOWN_HOURS",
      "DISCORD_ADMIN_ROLE", "MAX_COST_CURRENT", "MAX_COST_FORECAST", "DNS_TTL"]) set(k, E[k] ?? "");
    fs.writeFileSync(tomlPath, toml);
    wrangler(["deploy"], wenv, path.join(dir, "CF-Worker"));

    const secrets = {
      SHARED_TOKEN: E.SHARED_TOKEN, TURNSTILE_SECRET: E.TURNSTILE_SECRET || "", CF_API_TOKEN: E.CF_DNS_TOKEN || E.CF_API_TOKEN, CF_ZONE_ID: zone.id,
      OVH_APP_KEY: E.WORKER_OVH_APP_KEY || E.OVH_APP_KEY, OVH_APP_SECRET: E.WORKER_OVH_APP_SECRET || E.OVH_APP_SECRET,
      OVH_CONSUMER_KEY: E.WORKER_OVH_CONSUMER_KEY || E.OVH_CONSUMER_KEY, OVH_PROJECT: E.OVH_PROJECT || "",
      DISCORD_PUBLIC_KEY: E.DISCORD_PUBLIC_KEY || "", DISCORD_WEBHOOK_URL: E.DISCORD_WEBHOOK_URL || "",
    };
    const sf = path.join(BUILD, "secrets.json");
    fs.writeFileSync(sf, JSON.stringify(Object.fromEntries(Object.entries(secrets).filter(([, v]) => v))));
    try { wrangler(["secret", "bulk", sf], wenv, path.join(dir, "CF-Worker")); } finally { fs.rmSync(sf); }
    const empty = Object.entries(secrets).filter(([, v]) => !v).map(([k]) => k);
    if (!E.CF_DNS_TOKEN) need("CF_DNS_TOKEN", "a DNS-only token for the worker (optional: CF_API_TOKEN is used, which can do much more)");
    rec(empty.length ? "warn" : "ok", "Cloudflare: worker", `${E.WORKER_NAME} on ${E.DOMAIN}/api/*${empty.length ? `; not set: ${empty.join(", ")}` : ""}`);
    return dir;
  });

  // the landing page: CONFIG patched (Turnstile site key, Discord invite, download), Pages deploy
  await step("Cloudflare: landing page", async () => {
    const dir = worker || path.join(BUILD, "DeployProjects");
    if (!worker) copyDir(path.join(SRC, "LandingPage"), path.join(dir, "LandingPage"));
    const site = path.join(BUILD, "site");
    fs.rmSync(site, { recursive: true, force: true });
    fs.mkdirSync(site, { recursive: true });
    for (const f of ["index.html", "style.css", "app.js", "assets"]) copyDir(path.join(dir, "LandingPage", f), path.join(site, f));
    const appJs = path.join(site, "app.js");
    let js = fs.readFileSync(appJs, "utf8");
    const cfg = (key, val) => { if (val) js = js.replace(new RegExp(`(${key}: )"[^"]*"`), `$1${JSON.stringify(val)}`); };
    cfg("turnstileSiteKey", E.TURNSTILE_SITEKEY); cfg("discord", E.DISCORD_INVITE); cfg("download", E.DOWNLOAD_URL);
    fs.writeFileSync(appJs, js);
    const projects = await cfApi("GET", `/accounts/${acc}/pages/projects`);
    if (!projects.some((p) => p.name === E.PAGES_PROJECT)) {
      await cfApi("POST", `/accounts/${acc}/pages/projects`, { name: E.PAGES_PROJECT, production_branch: "main" });
    }
    wrangler(["pages", "deploy", site, "--project-name", E.PAGES_PROJECT, "--branch", "main", "--commit-dirty=true"], wenv);
    const domains = (await cfApi("GET", `/accounts/${acc}/pages/projects/${E.PAGES_PROJECT}/domains`)).map((d) => d.name);
    for (const d of [E.DOMAIN, `www.${E.DOMAIN}`]) {
      if (!domains.includes(d)) await cfApi("POST", `/accounts/${acc}/pages/projects/${E.PAGES_PROJECT}/domains`, { name: d });
    }
    ok("Cloudflare: landing page", `Pages project ${E.PAGES_PROJECT}, domains ${E.DOMAIN} + www${E.TURNSTILE_SITEKEY ? "" : " (Turnstile test key: Start will not really check visitors)"}`);
  });

  // the worker answers on the domain (DNS + Pages + route can take a minute)
  out.api = E.WORKER_TEST_URL || `https://${E.DOMAIN}/api`;
  await step("worker: /status", async () => {
    for (let i = 0; i < (DRY && !E.WORKER_TEST_URL ? 0 : 12); i++) {
      const r = await fetch(`${out.api}/status`).catch(() => null);
      if (r?.ok) { const s = await r.json(); ok("worker: /status", `${out.api} answers, state "${s.state}"`); out.workerUp = true; return; }
      await sleep(10e3);
    }
    if (DRY && !E.WORKER_TEST_URL) return skip("worker: /status", "dry run");
    fail("worker: /status", `${out.api}/status does not answer yet (DNS / custom domain may need a few minutes - rerun later)`);
  });
  out.ovhOk = ovhOk;
  return out;
}

// ------------------------------------------------------------------ 4. Discord

// The bot token gives us the app (and its public key, which the worker checks signatures with).
async function discordApp() {
  if (!E.DISCORD_APP_ID || !E.DISCORD_BOT_TOKEN) return null;
  return step("Discord: app", async () => {
    const r = await fetch(`${DISCORD}/applications/@me`, { headers: { authorization: `Bot ${E.DISCORD_BOT_TOKEN}` } });
    if (!r.ok) throw new Error(`bot token rejected (${r.status})`);
    const a = await r.json();
    if (!E.DISCORD_PUBLIC_KEY && a.verify_key) E.DISCORD_PUBLIC_KEY = a.verify_key;
    ok("Discord: app", `"${a.name}"`);
    return a;
  });
}

async function discordPart(cf, app) {
  if (E.DISCORD_WEBHOOK_URL) await step("Discord: webhook", async () => {
    const r = await fetch(E.DISCORD_WEBHOOK_URL);
    if (!r.ok) throw new Error(`webhook URL answered ${r.status}`);
    const w = await r.json();
    ok("Discord: webhook", `"${w.name}" in channel ${w.channel_id}`);
  });
  else skip("Discord: webhook", "DISCORD_WEBHOOK_URL not set: no posts in the channel");

  if (!E.DISCORD_APP_ID || !E.DISCORD_BOT_TOKEN) return skip("Discord: commands", "DISCORD_APP_ID / DISCORD_BOT_TOKEN not set");
  if (!app) return;
  const h = { authorization: `Bot ${E.DISCORD_BOT_TOKEN}`, "content-type": "application/json" };
  await step("Discord: commands", async () => {
    const url = E.DISCORD_GUILD_ID ? `${DISCORD}/applications/${E.DISCORD_APP_ID}/guilds/${E.DISCORD_GUILD_ID}/commands` : `${DISCORD}/applications/${E.DISCORD_APP_ID}/commands`;
    const r = await fetch(url, { method: "PUT", headers: h, body: JSON.stringify([
      { name: "start", description: "Start the Rising2 game server (once a day per player)" },
      { name: "status", description: "Show the game server state and its last events" },
      { name: "stop", description: "Save and stop the game server (admins)" },
    ]) });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    ok("Discord: commands", `/start /status /stop registered ${E.DISCORD_GUILD_ID ? "in the guild" : "globally (can take up to an hour to show)"}`);
  });
  await step("Discord: interactions URL", async () => {
    if (!cf.workerUp) return skip("Discord: interactions URL", "the worker isn't answering yet");
    const r = await fetch(`${DISCORD}/applications/@me`, { method: "PATCH", headers: h, body: JSON.stringify({ interactions_endpoint_url: `https://${E.DOMAIN}/api/discord` }) });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()} (Discord checks the URL with a signed PING)`);
    ok("Discord: interactions URL", `https://${E.DOMAIN}/api/discord`);
  });
}

// ------------------------------------------------------------------ 5. one real loop

async function testLoop(cf, ovhOk) {
  if (E.TEST_VM !== "yes") return skip("test loop", "TEST_VM is not yes (the loop starts a real VM for a few minutes and costs a little)");
  if (!cf.workerUp || !ovhOk) return fail("test loop", "skipped: the worker or OVH step failed above");

  const H = { authorization: `Bearer ${E.SHARED_TOKEN}` };
  const api = (m, p) => fetch(`${cf.api}${p}`, { method: m, headers: H }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const t0 = Date.now(), mins = () => ((Date.now() - t0) / 60e3).toFixed(1);
  let seen = 0;
  const follow = async () => {
    const st = (await api("GET", "/status")).body;
    const lines = (st.log || []).filter((l) => l.t > seen);
    for (const l of lines) { console.log(`     [${mins()} min] ${l.msg}`); seen = l.t; }
    return st;
  };
  seen = Math.max(0, ...((await api("GET", "/status")).body.log || []).map((l) => l.t));

  const start = await api("POST", "/admin/start");
  if (start.status !== 200) return fail("test: start", `${start.status} ${start.body.message || start.body.error || ""}`);
  ok("test: start", "the worker accepted the start");

  const upBy = Date.now() + Number(E.TEST_TIMEOUT_MIN) * 60e3;
  let st;
  while (Date.now() < upBy) {
    await sleep(Number(E.TEST_POLL_SEC) * 1e3);
    st = await follow();
    if (st.state === "up" || st.state === "off" || st.state === "error") break;
  }
  if (st?.state === "up") ok("test: VM up", `after ${mins()} min`);
  else fail("test: VM up", `state "${st?.state}" after ${mins()} min${st?.state === "off" ? " (the start failed, see the log lines above)" : " (timeout)"}`);

  if (st?.state === "up") await step("test: DNS", async () => {
    const recs = await cfApi("GET", `/zones/${cf.zone}/dns_records?type=A&name=ip.${E.DOMAIN}`);
    const ip = recs[0]?.content;
    rec(ip && ip !== "127.0.0.1" ? "ok" : "fail", "test: DNS", `ip.${E.DOMAIN} -> ${ip}`);
  });

  // stop: graceful through the worker; if the VM doesn't go away, delete it directly (no bill leak)
  await api("POST", "/admin/stop");
  info("test: stop", "stop requested, waiting for the VM to sync and tear itself down...");
  const goneBy = Date.now() + 10 * 60e3;
  let gone = false;
  while (Date.now() < goneBy) {
    await sleep(Number(E.TEST_POLL_SEC) * 1e3);
    st = await follow();
    const vms = await ovh("GET", `/cloud/project/${E.OVH_PROJECT}/instance`).catch(() => null);
    if (st.state === "off" && vms && !vms.some((v) => v.name === E.VM_NAME)) { gone = true; break; }
  }
  if (gone) ok("test: teardown", `VM deleted, state off, after ${mins()} min in total`);
  else {
    const vms = await ovh("GET", `/cloud/project/${E.OVH_PROJECT}/instance`).catch(() => []);
    for (const v of vms.filter((x) => x.name === E.VM_NAME)) await ovh("DELETE", `/cloud/project/${E.OVH_PROJECT}/instance/${v.id}`).catch(() => {});
    fail("test: teardown", "the VM did not tear itself down in 10 min - deleted it directly through the OVH API; check cloud_init.sh logs");
  }
  const vrecs = await cfApi("GET", `/zones/${cf.zone}/dns_records?type=A&name=ip.${E.DOMAIN}`).catch(() => []);
  rec(vrecs[0]?.content === "127.0.0.1" ? "ok" : "warn", "test: DNS parked", `ip.${E.DOMAIN} -> ${vrecs[0]?.content}`);
}

// ------------------------------------------------------------------ end

function finish() {
  writeReport();
  const f = steps.filter((s) => s.status === "fail").length, w = steps.filter((s) => s.status === "warn").length;
  console.log(`\n${f ? "❌" : w ? "⚠️" : "✅"} done: ${f} failed, ${w} warnings - report in ${path.join(OUT, "report.md")}`);
  if (missing.length) console.log(`   missing settings: ${missing.map((m) => m.name).join(", ")}`);
  process.exit(f ? 1 : 0);
}

// ------------------------------------------------------------------ helpers

function defaults() {
  return {
    OVH_ENDPOINT: "https://eu.api.ovh.com/1.0", OVH_PROJECT_NAME: "rising2", OVH_SUBSIDIARY: "FR", OVH_CREATE_PROJECT: "no",
    OVH_REGION: "GRA11", OVH_FLAVORS: "c3-8,b3-16", OVH_IMAGE: "Debian 12", VM_NAME: "rising2-lazy",
    R2_BUCKET: "rising2", WORKER_NAME: "rising2-worker", PAGES_PROJECT: "rising2", DNS_TTL: "60",
    START_COOLDOWN_HOURS: "20", DISCORD_ADMIN_ROLE: "", MAX_COST_CURRENT: "15", MAX_COST_FORECAST: "20",
    TEST_VM: "no", TEST_TIMEOUT_MIN: "25", TEST_POLL_SEC: "15",
  };
}

function clean(env) { return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")); }

function readEnvFile(f) {
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

// values the script made up or looked up, kept for the next run (and never in the repo)
function saveGenerated() {
  const keys = ["SHARED_TOKEN", "TURNSTILE_SITEKEY", "TURNSTILE_SECRET", "OVH_PROJECT", "R2_ADMIN_TOKEN", "DISCORD_PUBLIC_KEY"];
  const lines = ["# written by deploy.mjs - secrets, keep out of git", ...keys.filter((k) => E[k]).map((k) => `${k}=${E[k]}`)];
  fs.writeFileSync(GEN_FILE, lines.join("\n") + "\n", { mode: 0o600 });
}

async function cfApi(method, p, body) {
  const r = await fetch(`${CF}${p}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${E.CF_API_TOKEN}`, "content-type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Cloudflare ${method} ${p.split("?")[0]}: ${r.status} ${(j.errors || []).map((e) => e.message).join("; ")}`);
  return j.result;
}

let ovhSkew = null;
async function ovh(method, p, body) {
  if (ovhSkew === null) {
    const t = await fetch(`${E.OVH_ENDPOINT}/auth/time`).then((r) => r.text()).catch(() => null);
    ovhSkew = t ? Number(t) - Math.floor(Date.now() / 1000) : 0;
  }
  const url = E.OVH_ENDPOINT + p;
  const data = body ? JSON.stringify(body) : "";
  const now = Math.floor(Date.now() / 1000) + ovhSkew;
  const sig = "$1$" + createHash("sha1").update([E.OVH_APP_SECRET, E.OVH_CONSUMER_KEY, method, url, data, now].join("+")).digest("hex");
  const r = await fetch(url, { method, body: data || undefined, headers: {
    "content-type": "application/json", "X-Ovh-Application": E.OVH_APP_KEY, "X-Ovh-Consumer": E.OVH_CONSUMER_KEY,
    "X-Ovh-Timestamp": String(now), "X-Ovh-Signature": sig,
  } });
  const text = await r.text();
  if (!r.ok) throw new Error(`OVH ${method} ${p.split("?")[0]}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// same as the worker's: item totals already include their details
function sumPrices(node) {
  if (Array.isArray(node)) return node.reduce((a, n) => a + sumPrices(n), 0);
  if (!node || typeof node !== "object") return 0;
  if (typeof node.totalPrice === "number") return node.totalPrice;
  if (node.totalPrice && typeof node.totalPrice.value === "number") return node.totalPrice.value;
  return Object.values(node).reduce((a, n) => a + sumPrices(n), 0);
}

function wrangler(args, env, cwd = BUILD) {
  const shown = `wrangler ${args.join(" ")}`;
  if (DRY) { console.log(`     (dry run) ${shown}`); return ""; }
  const r = spawnSync("wrangler", args, { cwd, env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false", CI: "1" }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${shown} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout;
}

function copyDir(from, to) {
  const skipNames = new Set(["node_modules", ".wrangler", ".dev.vars", "server.env", "README.md"]);
  const st = fs.statSync(from);
  if (!st.isDirectory()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); return; }
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) if (!skipNames.has(n)) copyDir(path.join(from, n), path.join(to, n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await main();
