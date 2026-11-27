// Cloudflare Worker: CF-Worker deployed on <domain>/api/* with its settings and secrets.
import fs from "node:fs";
import path from "node:path";
import { F, SRC, BUILD, DRY, copyDir, wrangler, waitFor } from "../../lib.mjs";
import { S } from "../../specs.mjs";

const VARS = ["OVH_ENDPOINT", "OVH_REGION", "OVH_FLAVORS", "OVH_IMAGE", "VM_NAME", "GAME_ZIP_URL", "SSH_PUBLIC_KEY", "START_COOLDOWN_HOURS",
  "DISCORD_ADMIN_ROLE", "MAX_COST_CURRENT", "MAX_COST_FORECAST", "DNS_TTL"];
const SECRETS = ["SHARED_TOKEN", "TURNSTILE_SECRET", "CF_DNS_TOKEN", "CF_ZONE_ID", "OVH_APP_KEY", "OVH_APP_SECRET", "OVH_CONSUMER_KEY",
  "OVH_PROJECT", "DISCORD_PUBLIC_KEY", "DISCORD_WEBHOOK_URL"];

export default {
  title: "Cloudflare Worker: the API on <domain>/api/* with its settings + secrets",
  manual: [
    "07-cloudflare-pages done (the worker's route needs <domain> to be on Cloudflare's proxy)",
    "a deploy token with Account > Workers Scripts Edit and Zone > Workers Routes Edit",
    "a second, DNS-only token for the worker itself (Zone > DNS Edit on this zone): CF_DNS_TOKEN",
    "a worker OVH key, made on your OVH site (ca/eu.api.ovh.com/createToken/), rules with your REAL project id typed in place of PROJECT_ID: GET /cloud/project/PROJECT_ID/*, POST /cloud/project/PROJECT_ID/instance, DELETE /cloud/project/PROJECT_ID/instance/*",
    "SHARED_TOKEN: make one (openssl rand -hex 32) and keep it: 10-test-loop needs the same value",
  ],
  waitMin: 10,
  env: [
    S.CF_API_TOKEN("Account > Workers Scripts Edit, Zone > Workers Routes Edit (to deploy)"), S.CF_ACCOUNT_ID, S.DOMAIN,
    { name: "WORKER_NAME", f: F.name, required: true, def: "rising2-worker", about: "the worker's name" },
    S.R2_BUCKET,
    // ---- secrets the worker runs with
    S.SHARED_TOKEN,
    { name: "TURNSTILE_SECRET", f: F.turnstileSecret, required: true, about: "the captcha's secret (06-cloudflare-turnstile prints it)" },
    { name: "CF_DNS_TOKEN", f: F.cfToken, required: true, about: "the worker's own Cloudflare token: Zone > DNS Edit on this zone only" },
    { name: "CF_ZONE_ID", f: F.hex32, required: true, about: "the zone id (03-cloudflare-dns prints it)" },
    S.OVH_ENDPOINT,
    { name: "OVH_APP_KEY", f: F.ovhAppKey, required: true, about: "the worker's OVH key: Application Key" },
    { name: "OVH_APP_SECRET", f: F.ovhSecret, required: true, about: "the worker's OVH key: Application Secret" },
    { name: "OVH_CONSUMER_KEY", f: F.ovhConsumer, required: true, about: "the worker's OVH key: Consumer Key" },
    S.OVH_PROJECT,
    { name: "DISCORD_PUBLIC_KEY", f: F.discordPublicKey, about: "the Discord app's public key (for /start /stop /status)" },
    { name: "DISCORD_WEBHOOK_URL", f: F.webhook, about: "channel webhook for status + monthly cost posts" },
    // ---- settings (plain vars)
    S.OVH_REGION,
    { name: "OVH_FLAVORS", f: F.flavors, required: true, def: "c3-8,b3-16", about: "VM sizes to try, in order" },
    S.OVH_IMAGE,
    S.VM_NAME,
    { name: "GAME_ZIP_URL", f: F.urlOrNone, required: true, def: "none", about: "Game.zip the VM downloads (root holds bin/ and data/); empty or none = no game files (test server)" },
    { name: "SSH_PUBLIC_KEY", f: F.sshKey, about: "your public SSH key: every VM lets it in as root and debian (logs, debugging)" },
    { name: "START_COOLDOWN_HOURS", f: F.number, required: true, def: "20", about: "one Start per IP / Discord user per this many hours" },
    { name: "DISCORD_ADMIN_ROLE", f: F.snowflake, about: "Discord role id: no cooldown, may /stop" },
    { name: "MAX_COST_CURRENT", f: F.number, required: true, def: "15", about: "no Start once this month's OVH cost reaches this (EUR)" },
    { name: "MAX_COST_FORECAST", f: F.number, required: true, def: "20", about: "no Start once OVH's forecast for the month reaches this (EUR)" },
    { name: "DNS_TTL", f: F.number, required: true, def: "60", about: "TTL the worker sets on ip.<domain>" },
  ],

  async deploy(E, R) {
    if (E.GAME_ZIP_URL === "none") R.warn("GAME_ZIP_URL", "none: the VM gets no game files (fine with the 05a test server, not with the real one)");
    // a copy of CF-Worker (+ LazyServer, bundled as userData) with wrangler.toml set to this deployment
    const dir = path.join(BUILD, "DeployProjects");
    fs.rmSync(dir, { recursive: true, force: true });
    for (const d of ["CF-Worker", "LazyServer"]) copyDir(path.join(SRC, d), path.join(dir, d));
    const tomlPath = path.join(dir, "CF-Worker", "wrangler.toml");
    let toml = fs.readFileSync(tomlPath, "utf8").replaceAll("rising2.net", E.DOMAIN);
    const set = (k, v) => { toml = toml.replace(new RegExp(`^${k} = ".*?"`, "m"), `${k} = ${JSON.stringify(v)}`); };
    set("name", E.WORKER_NAME); set("bucket_name", E.R2_BUCKET);
    for (const k of VARS) set(k, E[k] ?? "");
    fs.writeFileSync(tomlPath, toml);

    const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID, cwd: path.join(dir, "CF-Worker") };
    wrangler(["deploy"], w);
    R.ok("deploy", `${E.WORKER_NAME} on ${E.DOMAIN}/api/* and www.${E.DOMAIN}/api/*`);

    // the worker reads its DNS token as CF_API_TOKEN
    const secrets = Object.fromEntries(SECRETS.filter((k) => E[k]).map((k) => [k === "CF_DNS_TOKEN" ? "CF_API_TOKEN" : k, E[k]]));
    const sf = path.join(BUILD, "secrets.json");
    fs.writeFileSync(sf, JSON.stringify(secrets), { mode: 0o600 });
    try { wrangler(["secret", "bulk", sf], w); } finally { fs.rmSync(sf, { force: true }); }
    const unset = SECRETS.filter((k) => !E[k]);
    R.ok("secrets", `${Object.keys(secrets).length} set${unset.length ? `; not set (optional): ${unset.join(", ")}` : ""}`);

    if (DRY && !process.env.WORKER_TEST_URL) return R.skip("live check", "dry run");
    const api = process.env.WORKER_TEST_URL || `https://${E.DOMAIN}/api`;
    const st = await waitFor(`${api}/status`, async () => {
      const r = await fetch(`${api}/status`);
      return r.ok && (r.headers.get("content-type") || "").includes("json") ? r.json() : null;
    }, { minutes: E.WAIT_MIN });
    R.ok("live", `${api}/status answers: state "${st.state}"`);
    const bad = await fetch(`${api}/should-stop`, { headers: { authorization: "Bearer wrong" } });
    if (bad.status === 401) R.ok("token check", "a wrong token is refused");
    else R.fail("token check", `a wrong token got ${bad.status}`);
    const good = await fetch(`${api}/should-stop`, { headers: { authorization: `Bearer ${E.SHARED_TOKEN}` } });
    if (good.ok) R.ok("shared token", "the worker accepts SHARED_TOKEN");
    else R.fail("shared token", `SHARED_TOKEN got ${good.status}: the secret didn't take - rerun`);
  },

  async undeploy(E, R) {
    try {
      wrangler(["delete", "--name", E.WORKER_NAME, "--force"], { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID });
      R.ok("worker", `deleted ${E.WORKER_NAME} (its routes and secrets go with it)`);
    } catch (e) {
      if (/not found|does not exist|10007/i.test(e.message)) R.ok("worker", `${E.WORKER_NAME} doesn't exist`);
      else throw e;
    }
  },
};
