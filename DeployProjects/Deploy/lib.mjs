// Shared code for the deploy steps (code only: every step has its own step.env, nothing is shared at run time).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SRC = process.env.SRC_DIR || "/app";   // DeployProjects, mounted read-only
export const BUILD = "/tmp/rising2-build";          // patched copies (never written back to /app)
export const DRY = process.env.DRY_RUN === "1";     // wrangler commands are printed, not run
const CF = () => process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4";
export const DISCORD_API = () => process.env.DISCORD_API_BASE || "https://discord.com/api/v10";

// ------------------------------------------------------------------ value shapes (for step.env)
// re: what a real value looks like (a mismatch only warns), shape: shown in step.env.example.
export const F = {
  domain: { re: /^(?!https?:)[a-z0-9-]+(\.[a-z0-9-]+)+$/, shape: "a bare domain: rising2.net (no https://, no slash)" },
  url: { re: /^https?:\/\/\S+$/, shape: "a full URL: https://..." },
  cfToken: { re: /^[\w-]{35,}$/, shape: "~40 characters of letters, digits, - and _ (no prefix, not the Global API Key)" },
  hex32: { re: /^[0-9a-f]{32}$/, shape: "32 hex characters, e.g. 023e105f4ecef8ad9ca31a8372d0c353" },
  hex64: { re: /^[0-9a-f]{64}$/, shape: "64 hex characters" },
  sharedToken: { re: /^[0-9a-f]{64}$/, shape: "64 hex characters - make one with: openssl rand -hex 32 (same value in 08-cloudflare-worker and 10-test-loop)" },
  ovhEndpoint: { re: /^https:\/\/(eu|ca|us)\.api\.(ovh|ovhcloud)\.com\/1\.0$/, shape: "https://eu.api.ovh.com/1.0 (ca.api.ovh.com / api.us.ovhcloud.com if the key was made there)" },
  ovhAppKey: { re: /^[A-Za-z0-9]{16}$/, shape: "16 letters/digits, e.g. 7kbG7Bk7S9Nt7ZSV (\"Application Key\")" },
  ovhSecret: { re: /^[A-Za-z0-9]{32}$/, shape: "32 letters/digits (\"Application Secret\")" },
  ovhConsumer: { re: /^[A-Za-z0-9]{32}$/, shape: "32 letters/digits (\"Consumer Key\")" },
  ovhProject: { re: /^[0-9a-f]{32}$/, shape: "32 hex characters: the project id (OVH panel > Public Cloud > your project: under its name and in the page URL)" },
  ovhRegion: { re: /^[A-Z]+\d*(-[A-Z]+-\d+)?(,[A-Z]+\d*(-[A-Z]+-\d+)?)*$/, shape: "OVH region code(s), tried in order: DE1,GRA11 or just GRA11 (others: SBG5, WAW1, UK1, BHS5)" },
  name: { re: /^[a-z0-9][a-z0-9-]{0,62}$/, shape: "lowercase letters, digits and -" },
  yesno: { re: /^(yes|no)$/, shape: "yes or no" },
  number: { re: /^\d+(\.\d+)?$/, shape: "a number" },
  turnstileSite: { re: /^0x4[\w-]{18,}$/, shape: "starts with 0x4AAAAAAA, ~24 characters (06-cloudflare-turnstile prints it)" },
  turnstileSecret: { re: /^0x4[\w-]{28,}$/, shape: "starts with 0x4AAAAAAA, ~35 characters (06-cloudflare-turnstile prints it)" },
  snowflake: { re: /^\d{17,20}$/, shape: "a Discord id: 17-20 digits (Developer Mode > right click > Copy ID)" },
  discordToken: { re: /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{25,}$/, shape: "three dot-separated parts, ~70 characters, e.g. MTIz....GaBcDe.xyz... (Bot > Reset Token)" },
  discordPublicKey: { re: /^[0-9a-f]{64}$/, shape: "64 hex characters (Developer Portal > General Information > Public Key)" },
  webhook: { re: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/, shape: "https://discord.com/api/webhooks/<17-20 digits>/<~68 characters>" },
  invite: { re: /^https:\/\/(discord\.gg|discord\.com\/invite)\/\w+$/, shape: "https://discord.gg/AbCdEf12" },
  flavors: { re: /^[\w.-]+(,[\w.-]+)*$/, shape: "comma-separated OVH flavor names, e.g. c3-8,b3-16" },
  any: { re: /^.+$/, shape: "text" },
};

// ------------------------------------------------------------------ env

// spec: [{ name, f: F.x, required, def, about }]. Returns { E, problems }.
export function loadEnv(spec) {
  const E = {};
  const problems = [];
  for (const s of spec) {
    const v = (process.env[s.name] ?? "").trim();
    E[s.name] = v || s.def || "";
    if (!v && s.required && !s.def) problems.push({ kind: "missing", name: s.name, about: s.about, shape: s.f.shape });
    else if (v && !s.f.re.test(v)) problems.push({ kind: "format", name: s.name, about: s.about, shape: s.f.shape });
  }
  E.WAIT_MIN = Number(process.env.WAIT_MIN || 0) || null;
  return { E, problems };
}

// step.env.example text from a step's spec
export function exampleEnv(step) {
  const lines = [
    `# ${step.id}: ${step.title}`,
    `# Copy to step.env (git-ignored) and fill in. One value per line, comments on their own line.`,
    ...(step.manual?.length ? ["#", "# Do by hand first:", ...step.manual.map((m) => `#   - ${m}`)] : []),
    "",
  ];
  for (const s of step.env) {
    lines.push(`# ${s.about}${s.required ? "" : " (optional)"}`);
    lines.push(`# Looks like: ${s.f.shape}`);
    lines.push(`${s.name}=${s.def ?? ""}`, "");
  }
  lines.push("# How long to wait for the provider before giving up (minutes, optional).", `# WAIT_MIN=${step.waitMin ?? 10}`, "");
  return lines.join("\n");
}

// ------------------------------------------------------------------ report

export function makeReport(outDir, stepId, action) {
  fs.mkdirSync(outDir, { recursive: true });
  const steps = [], outputs = {};
  const ICON = { ok: "✅", warn: "⚠️", fail: "❌", skip: "⏭️", info: "ℹ️", todo: "✋" };
  const write = () => {
    const count = (s) => steps.filter((x) => x.status === s).length;
    const summary = { ok: count("ok"), warn: count("warn"), fail: count("fail"), skip: count("skip"), todo: count("todo") };
    fs.writeFileSync(path.join(outDir, `${action}.report.json`), JSON.stringify({ step: stepId, action, when: new Date().toISOString(), summary, outputs: Object.keys(outputs), steps }, null, 2));
    fs.writeFileSync(path.join(outDir, `${action}.report.md`), [
      `# ${stepId} - ${action}`, "", `${new Date().toISOString()}${DRY ? " - DRY RUN" : ""}`, "",
      `**${summary.ok} ok, ${summary.warn} warnings, ${summary.fail} failed, ${summary.todo} to do by hand**`, "",
      "| | Check | Detail |", "|---|---|---|",
      ...steps.map((s) => `| ${ICON[s.status]} | ${s.name} | ${String(s.detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
      ...(Object.keys(outputs).length ? ["", "## Outputs (also in outputs.env)", "", ...Object.keys(outputs).map((k) => `- \`${k}\``)] : []), "",
    ].join("\n"));
    if (Object.keys(outputs).length) {
      fs.writeFileSync(path.join(outDir, "outputs.env"),
        `# ${stepId}: values for the next steps' step.env - secrets, keep out of git\n` + Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    }
  };
  const rec = (status, name, detail = "") => { steps.push({ status, name, detail }); console.log(`${ICON[status]} ${name}${detail ? ` - ${detail}` : ""}`); write(); };
  return {
    ok: (n, d) => rec("ok", n, d), warn: (n, d) => rec("warn", n, d), fail: (n, d) => rec("fail", n, d),
    skip: (n, d) => rec("skip", n, d), info: (n, d) => rec("info", n, d), todo: (n, d) => rec("todo", n, d),
    output: (k, v, secret = false) => { outputs[k] = v; console.log(`   -> ${k}=${secret ? v.slice(0, 6) + "..." : v}`); write(); },
    failed: () => steps.some((s) => s.status === "fail"),
    write,
  };
}

// ------------------------------------------------------------------ waiting

// Polls check() until it returns something truthy (that's returned) or the time is up (throws).
// Providers (OVH especially) can take minutes before a change shows: every step waits instead of failing.
export async function waitFor(label, check, { minutes = 10, everySec = 15 } = {}) {
  const end = Date.now() + minutes * 60e3, t0 = Date.now();
  let last;
  for (let i = 0; ; i++) {
    try { const r = await check(); if (r) return r; } catch (e) { last = e.message; }
    if (Date.now() >= end) throw new Error(`${label}: not ready after ${minutes} min${last ? ` (last error: ${last})` : ""} - rerun later, the step is safe to repeat`);
    if (i === 0 || i % 4 === 0) console.log(`     ... waiting for ${label} (${((Date.now() - t0) / 60e3).toFixed(1)} min)`);
    await sleep(everySec * 1e3);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ APIs

export function cfApi(token) {
  return async function (method, p, body) {
    const r = await fetch(`${CF()}${p}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) {
      const err = new Error(`Cloudflare ${method} ${p.split("?")[0]}: ${r.status} ${(j.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ")}`);
      err.status = r.status; throw err;
    }
    return j.result;
  };
}

// Signed OVH API calls: X-Ovh-Signature = "$1$" + SHA1(secret+consumerKey+method+url+body+timestamp),
// timestamp taken from OVH's clock (a skewed local clock makes every call fail).
export function ovhApi({ endpoint, appKey, appSecret, consumerKey }) {
  let skew = null;
  return async function (method, p, body) {
    if (skew === null) {
      const t = await fetch(`${endpoint}/auth/time`).then((r) => r.text()).catch(() => null);
      skew = t ? Number(t) - Math.floor(Date.now() / 1000) : 0;
    }
    const url = endpoint + p;
    const data = body ? JSON.stringify(body) : "";
    const now = Math.floor(Date.now() / 1000) + skew;
    const sig = "$1$" + createHash("sha1").update([appSecret, consumerKey, method, url, data, now].join("+")).digest("hex");
    const r = await fetch(url, { method, body: data || undefined, headers: {
      "content-type": "application/json", "X-Ovh-Application": appKey, "X-Ovh-Consumer": consumerKey,
      "X-Ovh-Timestamp": String(now), "X-Ovh-Signature": sig,
    } });
    const text = await r.text();
    if (!r.ok) { const e = new Error(`OVH ${method} ${p.split("?")[0]}: ${r.status} ${text.slice(0, 200)}`); e.status = r.status; throw e; }
    return text ? JSON.parse(text) : null;
  };
}

export function sumPrices(node) {
  if (Array.isArray(node)) return node.reduce((a, n) => a + sumPrices(n), 0);
  if (!node || typeof node !== "object") return 0;
  if (typeof node.totalPrice === "number") return node.totalPrice;
  if (node.totalPrice && typeof node.totalPrice.value === "number") return node.totalPrice.value;
  return Object.values(node).reduce((a, n) => a + sumPrices(n), 0);
}

// zone by name -> { id, account }
export async function zoneOf(cf, domain) {
  const z = (await cf("GET", `/zones?name=${domain}`))[0];
  if (!z) throw new Error(`zone ${domain} not found for this token (add the domain to Cloudflare, and give the token access to it)`);
  return z;
}

// ------------------------------------------------------------------ wrangler + files

export function wrangler(args, { token, account, cwd = BUILD } = {}) {
  const shown = `wrangler ${args.join(" ")}`;
  if (DRY) { console.log(`     (dry run) ${shown}`); return ""; }
  fs.mkdirSync(cwd, { recursive: true });
  const r = spawnSync("wrangler", args, { cwd, encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_SEND_METRICS: "false", CI: "1" } });
  if (r.status !== 0) throw new Error(`${shown} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout;
}

export function copyDir(from, to, skip = ["node_modules", ".wrangler", ".dev.vars", "server.env", "README.md"]) {
  const st = fs.statSync(from);
  if (!st.isDirectory()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); return; }
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) if (!skip.includes(n)) copyDir(path.join(from, n), path.join(to, n), skip);
}
