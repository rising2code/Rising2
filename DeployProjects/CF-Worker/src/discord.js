// Discord-facing: the /start /stop /status slash commands, and posts to the channel webhook.
import { startVm, requestStop } from "./server.js";
import { readStatus } from "./cloudflare.js";
import { json, unhex, maskIps } from "./util.js";

// POST /discord: Discord's interactions endpoint (signed with the app's Ed25519 key).
export async function discordInteraction(req, env, ctx) {
  const body = await req.text();
  if (!(await signatureOk(env, req, body))) return new Response("bad signature", { status: 401 });
  const it = JSON.parse(body);
  if (it.type === 1) return json({ type: 1 }); // PING

  const user = it.member?.user || it.user || {};
  const isAdmin = !!env.DISCORD_ADMIN_ROLE && (it.member?.roles || []).includes(env.DISCORD_ADMIN_ROLE);
  // Replies are public in the channel the command was typed in (Discord shows "X used /start" above
  // them), refusals included: support can see what happened right there.
  // Who/where, twice: plain names for the website's log, mentions for Discord (clickable there,
  // and no one is pinged: every post has allowed_mentions parse: []).
  const where = {
    web: it.channel?.name ? ` in #${it.channel.name}` : it.guild_id ? "" : " in DMs",
    discord: it.guild_id && it.channel_id ? ` in <#${it.channel_id}>` : it.guild_id ? "" : " in DMs",
  };
  user.ref = { web: user.username, discord: user.id ? `<@${user.id}>` : user.username };
  const cmd = it.data?.name;

  // Discord waits only 3 s for an answer, and /start asks OVH (VM list, month's cost) first. So we
  // answer "thinking..." at once (type 5) and edit that message with the result when the work is done.
  ctx.waitUntil((async () => {
    let content;
    try {
      content = await runCommand(env, ctx, cmd, user, where, isAdmin);
    } catch (e) {
      console.error(`/${cmd} failed:`, e.stack || e);
      content = `Something went wrong: ${String(e.message || e).slice(0, 300)}`;
    }
    const r = await fetch(`https://discord.com/api/v10/webhooks/${it.application_id}/${it.token}/messages/@original`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: maskIps(content), allowed_mentions: { parse: [] } }),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) console.error(`/${cmd}: editing the reply failed: ${r.status} ${await r.text()}`);
  })());
  return json({ type: 5 });
}

async function runCommand(env, ctx, cmd, user, where, isAdmin) {
  switch (cmd) {
    case "status": {
      const st = await readStatus(env);
      const log = st.log.map((l) => `<t:${Math.floor(l.t / 1000)}:t> ${l.msg}`).join("\n");
      const who = st.state === "up" && Number.isInteger(st.players) ? ` - ${st.players} player${st.players === 1 ? "" : "s"} online` : "";
      return `**State:** ${st.state}${who}\n${log || "(no events yet)"}`;
    }
    case "start": {
      const by = { web: `Discord: ${user.ref.web}${where.web}`, discord: `Discord: ${user.ref.discord}${where.discord}` };
      const res = await startVm(env, ctx, by, isAdmin ? null : `discord_${user.id}`);
      if (res.error === "cooldown") return `You already used Start today. Try again in ~${res.retryAfterHours}h.`;
      return res.ok ? "Starting the server... follow with `/status`." : `Not started: ${res.message || res.error}.`;
    }
    case "stop": {
      if (!isAdmin) return "Only admins can stop the server.";
      await requestStop(env, { web: `Stop by ${user.ref.web}${where.web}`, discord: `Stop by ${user.ref.discord}${where.discord}` });
      return "The server will sync and shut down within a minute or two.";
    }
  }
  return "Unknown command.";
}

async function signatureOk(env, req, body) {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;
  const key = await crypto.subtle.importKey("raw", unhex(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, unhex(sig), new TextEncoder().encode(ts + body));
}

// A message in the community channel (DISCORD_WEBHOOK_URL, optional). Never fails the caller.
export async function discordPost(env, content) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: maskIps(content), allowed_mentions: { parse: [] } }),
  }).catch(() => {});
}
