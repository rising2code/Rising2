// The game VM's life cycle: may we start one, start, stop, tear down, and the status log.
// Uses ovh.js for the VM itself, cloudflare.js for state in R2 + DNS, discord.js to tell the channel.
import { listInstances, findInstance, createInstance, deleteInstance, monthCost, fmtCost } from "./ovh.js";
import { readStatus, writeStatus, cooldown, setStopRequest, clearStopRequest, stopRequestedAt, setDns } from "./cloudflare.js";
import { discordPost } from "./discord.js";
import { maskIps } from "./util.js";

const LOG_KEEP = 10;                 // events kept in the public status log
const STARTING_GRACE_MS = 15 * 60e3; // a "starting" state younger than this blocks a new start

// Order matters: the "already running" and budget checks come before the cooldown, so pressing
// Start while the server is up doesn't use up the visitor's one start for the day.
// cooldownKey = null skips the cooldown (Discord admins).
export async function startVm(env, ctx, by, cooldownKey) {
  // 1. Any VM at all in the OVH project (any name, any region) -> no new one. Fails closed:
  //    if OVH can't be asked, nothing is created.
  let vms;
  try {
    vms = await listInstances(env);
  } catch (e) {
    return { ok: false, error: "ovh", message: "can't check for a running VM, try again later" };
  }
  const st = await readStatus(env);
  if (vms.length) {
    return { ok: false, error: "already running", message: `a VM already exists (${vms.map((v) => `${v.name}: ${v.status}`).join(", ")})`, state: st.state };
  }
  // 2. A start in the last minutes whose VM OVH doesn't list yet (double click, two people at once).
  if (st.state === "starting" && Date.now() - st.updated < STARTING_GRACE_MS) {
    return { ok: false, error: "already running", message: "a start is already in progress", state: st.state };
  }
  // 3. The month's OVH bill: over either limit -> no start, for anyone (admins too).
  let cost;
  try {
    cost = await monthCost(env);
  } catch (e) {
    return { ok: false, error: "ovh", message: "can't read this month's cost, try again later" };
  }
  const maxNow = Number(env.MAX_COST_CURRENT), maxFc = Number(env.MAX_COST_FORECAST);
  if ((maxNow && cost.current >= maxNow) || (maxFc && cost.forecast >= maxFc)) {
    await discordPost(env, `Start refused: this month's budget is used up (${fmtCost(cost)}).`);
    return { ok: false, error: "budget", message: "this month's server budget is used up" };
  }
  // 4. Only now count it against the caller's daily start.
  if (cooldownKey) {
    const wait = await cooldown(env, cooldownKey);
    if (wait) return { ok: false, error: "cooldown", retryAfterHours: wait };
  }

  await clearStopRequest(env);
  await addEvent(env, wrap(by, (s) => `Start requested (${s})`), "starting");
  ctx.waitUntil(
    createInstance(env, (msg) => addEvent(env, msg, "starting"), (msg) => addEvent(env, msg))
      .catch((e) => addEvent(env, `Start failed: ${e.message}`, "off")),
  );
  return { ok: true, state: "starting" };
}

// The status as the website and Discord /status show it. A stop flag older than an hour while the
// state still says "stopping" means the stop is long done - or there was no VM to stop (a /stop with
// nothing running): nothing else would ever end that "stopping", and the site hides Start while it
// lasts. So: clear the flag, call it off. Costs one R2 HEAD, and only in the "stopping" state.
// (STOP_STALE_MIN is only for testing; a VM still alive after that is caught by /start's OVH check.)
export async function currentStatus(env) {
  const st = await readStatus(env);
  if (st.state !== "stopping") return st;
  const at = await stopRequestedAt(env);
  if (at === null || Date.now() - at < Number(env.STOP_STALE_MIN || 60) * 60e3) return st;
  await clearStopRequest(env);
  await addEvent(env, "The stop request is over an hour old: the server is off", "off");
  return readStatus(env);
}

// Graceful: the VM sees the flag within a minute, syncs to R2, then calls /teardown.
export async function requestStop(env, why) {
  await setStopRequest(env, forWeb(why));
  await addEvent(env, wrap(why, (s) => `${s}: stopping after a final sync...`), "stopping");
}

// Called by the VM after its final sync: delete it and park the DNS name.
export async function teardown(env, why) {
  const inst = await findInstance(env);
  if (inst) await deleteInstance(env, inst.id);
  await clearStopRequest(env);
  await setDns(env, "127.0.0.1").catch(() => {}); // don't leave the name on an IP someone else may get
  await addEvent(env, `${why}: VM deleted`, "off");
  // tell the community what running it costs (Discord only, not the public status log)
  const cost = await monthCost(env).catch(() => null);
  if (cost) await discordPost(env, `This month's server cost so far: ${fmtCost(cost)}. Thanks for keeping it fan-funded!`);
}

// The VM's player count (POST /players, only when it changes). Anything but a sane whole number is
// stored as null = unknown. No log line and no Discord post: it changes too often for that.
export async function setPlayers(env, n) {
  const st = await readStatus(env);
  st.players = Number.isInteger(n) && n >= 0 && n < 10000 ? n : null;
  st.playersAt = Date.now();
  await writeStatus(env, st);
}

// A log line can read differently per audience: { web, discord }, where Discord gets clickable
// <@user> / <#channel> mentions and the website plain names. A plain string is the same for both.
export const forWeb = (m) => maskIps(typeof m === "string" ? m : m?.web ?? "");
const forDiscord = (m) => maskIps(typeof m === "string" ? m : m?.discord ?? m?.web ?? "");
const wrap = (m, f) => ({ web: f(forWeb(m)), discord: f(forDiscord(m)) });

// One line in the public status log (and the Discord channel), optionally a new state.
export async function addEvent(env, msg, state) {
  const st = await readStatus(env);
  if (state) st.state = state;
  if (state && state !== "up") { delete st.players; delete st.playersAt; } // a count only means something while up
  st.updated = Date.now();
  if (forWeb(msg)) st.log = [...st.log, { t: st.updated, msg: forWeb(msg) }].slice(-LOG_KEEP);
  await writeStatus(env, st);
  if (forDiscord(msg)) await discordPost(env, `\`[${st.state}]\` ${forDiscord(msg)}`);
}
