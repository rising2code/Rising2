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
  urlOrNone: { re: /^(https?:\/\/\S+|none)$/, shape: "a full URL: https://..., or none" },
  sshKey: { re: /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/]+=* ?\S*$/, shape: "one public key line: ssh-ed25519 AAAAC3Nza... you@pc (the .pub file, never the private key)" },
  cfToken: { re: /^[\w-]{35,}$/, shape: "~40 characters of letters, digits, - and _ (no prefix, not the Global API Key)" },
  hex32: { re: /^[0-9a-f]{32}$/, shape: "32 hex characters, e.g. 023e105f4ecef8ad9ca31a8372d0c353" },
  hex64: { re: /^[0-9a-f]{64}$/, shape: "64 hex characters" },
  sharedToken: { re: /^[0-9a-f]{64}$/, shape: "64 hex characters - make one with: openssl rand -hex 32 (same value in 08-repeated-cloudflare-worker and 10-test-loop)" },
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
  dockerId: { re: /^[a-z0-9]{4,30}$/, shape: "your Docker ID: 4-30 lowercase letters/digits (the name in docker login -u)" },
  dockerToken: { re: /^dckr_pat_[\w-]{20,}$/, shape: "dckr_pat_ + ~27 characters (Docker Hub > Account settings > Personal access tokens, Read & Write)" },
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
  // the report file uses words: an old Windows console prints the icons as "?"
  const WORD = { ok: "OK", warn: "WARN", fail: "FAIL", skip: "skip", info: "info", todo: "TO DO" };
  const write = () => {
    const count = (s) => steps.filter((x) => x.status === s).length;
    const summary = { ok: count("ok"), warn: count("warn"), fail: count("fail"), skip: count("skip"), todo: count("todo") };
    fs.writeFileSync(path.join(outDir, `${action}.report.json`), JSON.stringify({ step: stepId, action, when: new Date().toISOString(), summary, outputs: Object.keys(outputs), steps }, null, 2));
    // UTF-8 with a BOM, so Windows PowerShell 5's Get-Content shows the icons (not "âœ…")
    fs.writeFileSync(path.join(outDir, `${action}.report.md`), "﻿" + [
      `# ${stepId} - ${action}`, "", `${new Date().toISOString()}${DRY ? " - DRY RUN" : ""}`, "",
      `**${summary.ok} ok, ${summary.warn} warnings, ${summary.fail} failed, ${summary.todo} to do by hand**`, "",
      "| | Check | Detail |", "|---|---|---|",
      ...steps.map((s) => `| ${WORD[s.status]} | ${s.name} | ${String(s.detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
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

// Checks an OVH key before a step uses it: valid on this endpoint, validated, not expired, and
// rules covering `needs` ([method, example path]). Turns OVH's terse errors into what to fix.
// Throws (stops the step) when the key can't be used.
export async function checkOvhKey(ovh, R, endpoint, needs = []) {
  let cred;
  try {
    cred = await ovh("GET", "/auth/currentCredential");
  } catch (e) {
    const m = e.message.toLowerCase();
    const why =
      m.includes("application key is invalid") ? `OVH doesn't know this Application Key on ${endpoint}. Check: (1) OVH_APP_KEY is the "Application Key" (16 characters), not the name or the secret; (2) the key was made on the same site as OVH_ENDPOINT (eu.api.ovh.com vs ca.api.ovh.com / api.us.ovhcloud.com); (3) the key wasn't deleted or remade - a new key changes all three values` :
      m.includes("invalid signature") ? "the Application Key is known but OVH_APP_SECRET doesn't match it (copy the \"Application Secret\" of the same key)" :
      m.includes("credential") || m.includes("consumer") ? "OVH_CONSUMER_KEY is wrong, expired or was never validated (copy the \"Consumer Key\" shown with the same key)" :
      m.includes("not been granted") ? "the key works but has no rule for GET /auth/currentCredential - add it to the key" :
      "see the message";
    R.fail("OVH key", `${e.message} -> ${why}`);
    throw new Error("the OVH key can't be used - fix it in step.env and rerun");
  }
  // an OVH rule path is literal text where * matches anything (also across /)
  const esc = (t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const rules = (cred.rules || []).map((r) => ({ method: r.method, re: new RegExp(`^${r.path.split("*").map(esc).join(".*")}$`) }));
  if ((cred.rules || []).some((r) => /[<>]|PROJECT_ID/.test(r.path))) {
    R.fail("OVH key", `a rule still has a placeholder (${cred.rules.filter((r) => /[<>]|PROJECT_ID/.test(r.path)).map((r) => r.path).join(", ")}): OVH matches it literally - make a new key with your real project id in the rules`);
  }
  const lacking = needs.filter(([m, p]) => !rules.some((r) => r.method === m && r.re.test(p))).map(([m, p]) => `${m} ${p}`);
  const exp = cred.expiration ? `, expires ${cred.expiration}` : ", no expiry";
  const ruleList = (cred.rules || []).map((r) => `${r.method} ${r.path}`).join(", ");
  if (cred.status !== "validated") R.fail("OVH key", `status "${cred.status}" - the key isn't usable (validate it, or make a new one)`);
  else if (lacking.length) R.fail("OVH key", `valid${exp}, but its rules (${ruleList}) don't allow: ${lacking.join(", ")}`);
  else R.ok("OVH key", `valid${exp}; rules: ${ruleList}`);
  if (cred.status !== "validated" || lacking.length) throw new Error("the OVH key can't do what this step needs");
  return cred;
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
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
  if (r.status !== 0) {
    // wrangler ends with "Logs were written to ..." (a file that's gone with the container):
    // keep its [ERROR] block and the lines after it, which say what actually went wrong
    // (it also prints upgrade / "report this bug" chatter and colour codes: dropped)
    const noise = /Logs were written to|newer version of Wrangler|out-of-date|npm install|npx wrangler|report this error|fallback value in non-interactive|create an issue at|^\s*[-─]+\s*$/i;
    const all = `${r.stdout || ""}\n${r.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trimEnd())
      .filter((l) => l.trim() && !noise.test(l));
    console.log(all.map((l) => `     | ${l}`).join("\n"));
    let at = all.findIndex((l) => /\[ERROR\]/.test(l));
    if (at < 0) at = all.findIndex((l) => /✘|\berror\b/i.test(l));
    const why = (at >= 0 ? all.slice(at, at + 4) : all.slice(-4)).map((l) => l.trim().replace(/^✘\s*/, "")).join(" ");
    throw new Error(`${shown} failed: ${why || `exit code ${r.status}, no output`}`);
  }
  return r.stdout;
}

// ------------------------------------------------------------------ docker (steps 04a, 04b)
// The docker CLI talks to your Docker Desktop through the mounted socket. Its login lives in a
// config folder inside this container only (gone with it): your PC's own docker login is untouched.
const DOCKER_CONFIG = "/tmp/docker-config";
export const REPO = process.env.REPO_DIR || "/repo"; // the whole git repo, read-only (docker steps only)

// live: show the command's output as it runs (builds, pushes); else it's captured and returned.
export function docker(args, { input, live = false } = {}) {
  const shown = `docker ${args.join(" ")}`;
  if (DRY) { console.log(`     (dry run) ${shown}`); return ""; }
  if (live) console.log(`     $ ${shown}`);
  const r = spawnSync("docker", args, { input, encoding: "utf8", stdio: live ? ["ignore", "inherit", "inherit"] : "pipe",
    env: { ...process.env, DOCKER_CONFIG, BUILDKIT_PROGRESS: "plain", NO_COLOR: "1" } });
  if (r.error?.code === "ENOENT") throw new Error("the deploy image has no docker CLI yet (it's older than steps 04a/04b): rebuild it once with step.ps1 -Rebuild (step.sh: REBUILD=1)");
  if (r.error) throw new Error(`${shown}: ${r.error.message}`);
  if (r.status !== 0) {
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!live) console.log(out.map((l) => `     | ${l}`).join("\n"));
    throw new Error(`${shown} failed: ${out.slice(-3).join(" ") || `exit code ${r.status} (see the output above)`}`);
  }
  return r.stdout || "";
}

// Checks Docker Desktop is reachable, then logs in to the registry with the step's token.
// DOCKER_REGISTRY: only for testing these scripts against a local registry (default: Docker Hub).
export function dockerLogin(E, R) {
  if (!DRY && !fs.existsSync("/var/run/docker.sock")) {
    throw new Error("no Docker socket in the container: run this step with step.ps1 / step.sh (they mount it for steps 04a/04b)");
  }
  const v = docker(["version", "--format", "{{.Server.Version}}"]).trim();
  R.ok("docker", `Docker Desktop reachable${v ? ` (engine ${v})` : ""}`);
  const reg = process.env.DOCKER_REGISTRY || "";
  docker(["login", ...(reg ? [reg] : []), "-u", E.DOCKERHUB_USER, "--password-stdin"], { input: E.DOCKERHUB_TOKEN });
  R.ok("login", `logged in to ${reg || "Docker Hub"} as ${E.DOCKERHUB_USER} (inside this container only)`);
  return (name) => `${reg ? `${reg}/` : ""}${E.DOCKERHUB_USER}/${name}`;
}

// The VM's two files in R2 (steps 05a test / 05b real write the same keys: the last one run wins).
// (wrangler 3: r2 object commands go to Cloudflare by default; "--remote" is a wrangler 4 flag and fails here.)
export const SERVER_KEYS = ["server/docker-compose.yml", "server/.env"];

// files: { "server/docker-compose.yml": localPath, "server/.env": localPath }. Uploads, then reads
// each back and compares, so "uploaded" means it's really there.
// Keeps the first and last 3 characters of a value, the rest becomes * (short values: all *).
// Long values keep their first and last 3 characters; short ones (3-6) only their last 2, so a
// whole short value never shows; 1-2 characters are all stars.
export const maskValue = (v) =>
  v.length > 6 ? v.slice(0, 3) + "*".repeat(v.length - 6) + v.slice(-3)
  : v.length > 2 ? "*".repeat(v.length - 2) + v.slice(-2)
  : "*".repeat(v.length);

// A file's text for the console with every value masked: "KEY=value" in .env files, "key: value" in
// YAML. Comments, blank lines and lines without a value stay as they are.
export function maskedText(text, kind) {
  return text.split(/\r?\n/).map((line) => {
    if (/^\s*(#|$)/.test(line)) return line;
    const m = kind === "env" ? line.match(/^(\s*[\w.-]+\s*=\s*)(.*?)(\s*)$/) : line.match(/^(\s*(?:-\s+)?["']?[\w.-]+["']?:\s+)(.*?)(\s*)$/);
    return m && m[2] ? m[1] + maskValue(m[2]) + m[3] : line;
  }).join("\n");
}

export async function putServerFiles(E, R, files, label) {
  await checkR2Bucket(E, R);
  // sanity check of what the VM will get, values masked
  for (const [key, file] of Object.entries(files)) {
    const kind = key.endsWith(".env") ? "env" : "yml";
    console.log(`\n----- ${key}  (from ${path.basename(file)}, values masked)`);
    console.log(maskedText(fs.readFileSync(file, "utf8"), kind).split("\n").map((l) => `  ${l}`).join("\n"));
    console.log(`----- end of ${key}\n`);
  }
  const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID };
  for (const [key, file] of Object.entries(files)) {
    wrangler(["r2", "object", "put", `${E.R2_BUCKET}/${key}`, "--file", file], w);
    if (!DRY) {
      const back = path.join(BUILD, "readback");
      wrangler(["r2", "object", "get", `${E.R2_BUCKET}/${key}`, "--file", back], w);
      const same = fs.readFileSync(back).equals(fs.readFileSync(file));
      fs.rmSync(back);
      if (!same) { R.fail(key, "uploaded, but what R2 returns differs"); continue; }
    }
    R.ok(key, `${label}: ${path.basename(file)} (${fs.statSync(file).size} bytes)`);
  }
}

// Before wrangler touches R2: can this token see the bucket in this account? Gives a clear reason
// (wrong token permission / account / bucket name) instead of wrangler's short failure.
export async function checkR2Bucket(E, R) {
  const cf = cfApi(E.CF_API_TOKEN);
  let list;
  try {
    list = (await cf("GET", `/accounts/${E.CF_ACCOUNT_ID}/r2/buckets`)).buckets || [];
  } catch (e) {
    const why = e.status === 403 || /10000|auth/i.test(e.message)
      ? "the token can't use R2 in this account: give it Account > Workers R2 Storage Edit (for this account), and check CF_ACCOUNT_ID"
      : e.status === 404 ? "no such account: check CF_ACCOUNT_ID (03-cloudflare-dns prints it)" : "see the message";
    R.fail("R2 access", `${e.message} -> ${why}`);
    throw new Error("can't reach R2 with this token / account");
  }
  if (!list.some((b) => b.name === E.R2_BUCKET)) {
    R.fail("R2 bucket", `"${E.R2_BUCKET}" not found in this account (buckets: ${list.map((b) => b.name).join(", ") || "none"}) - create it, or fix R2_BUCKET`);
    throw new Error("bucket not found");
  }
  R.ok("R2 bucket", `${E.R2_BUCKET} found, the token can use it`);
}

// Removes only the two server/ files - never the saved game state (configs_sync/) or rate-limit marks.
// Does this R2 object exist? (wrangler's "get" fails with "The specified key does not exist" when
// it's missing; any other failure is a real error.) Dry run: treated as missing.
export function r2Exists(E, key) {
  if (DRY) return false;
  const back = path.join(BUILD, "exists-check");
  try {
    wrangler(["r2", "object", "get", `${E.R2_BUCKET}/${key}`, "--file", back], { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID });
    return true;
  } catch (e) {
    if (/specified key does not exist|NoSuchKey|10007/i.test(e.message)) return false;
    throw e;
  } finally { fs.rmSync(back, { force: true }); }
}

// The website's data (steps 05a / 05b, after the VM's files): site/urls.json from the step's link
// settings and site/s3files.json from DeployProjects/SiteData. The page gets them from the worker
// only after its captcha. Kept if already in R2 (edit them there) unless OVERWRITE_SITE=yes.
export function putSiteFiles(E, R) {
  const urls = Object.fromEntries(Object.entries({ discord: E.DISCORD_INVITE, github: E.GITHUB_URL, download: E.DOWNLOAD_URL }).filter(([, v]) => v));
  const files = JSON.parse(fs.readFileSync(path.join(SRC, "SiteData", "s3files.json"), "utf8")); // broken JSON stops here, not on the site
  if (!Array.isArray(files.files)) throw new Error("SiteData/s3files.json needs a \"files\" list");
  const bad = files.files.filter((f) => !f || typeof f.key !== "string" || !f.key).length;
  if (bad) throw new Error(`SiteData/s3files.json: ${bad} entr${bad === 1 ? "y has" : "ies have"} no "key"`);
  fs.mkdirSync(BUILD, { recursive: true });
  const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID };
  const put = (key, obj, what) => {
    if (E.OVERWRITE_SITE !== "yes" && r2Exists(E, key)) return R.ok(key, "already in R2 - kept (OVERWRITE_SITE=yes replaces it)");
    if (key.endsWith("urls.json")) for (const k of ["discord", "download"]) if (!urls[k]) R.warn(k, "no link set: the page hides that button");
    const f = path.join(BUILD, path.basename(key));
    fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
    wrangler(["r2", "object", "put", `${E.R2_BUCKET}/${key}`, "--file", f, "--content-type", "application/json"], w);
    R.ok(key, `${DRY ? "(dry run) " : ""}uploaded: ${what}`);
  };
  put("site/urls.json", urls, Object.keys(urls).join(", ") || "no links");
  put("site/s3files.json", files, `${files.files.length} archive file${files.files.length === 1 ? "" : "s"}`);
}

export async function deleteServerFiles(E, R) {
  await checkR2Bucket(E, R);
  const w = { token: E.CF_API_TOKEN, account: E.CF_ACCOUNT_ID };
  for (const key of SERVER_KEYS) {
    try { wrangler(["r2", "object", "delete", `${E.R2_BUCKET}/${key}`], w); R.ok(key, "deleted"); }
    catch (e) { R.warn(key, e.message); }
  }
}

export function copyDir(from, to, skip = ["node_modules", ".wrangler", ".dev.vars", "server.env", "README.md"]) {
  const st = fs.statSync(from);
  if (!st.isDirectory()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); return; }
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) if (!skip.includes(n)) copyDir(path.join(from, n), path.join(to, n), skip);
}
