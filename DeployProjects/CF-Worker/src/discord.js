// Discord-facing: the /start /stop /status slash commands, and posts to the channel webhook.
import { startVm, requestStop } from "./server.js";
import { readStatus } from "./cloudflare.js";
import { json, unhex } from "./util.js";

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
  const reply = (content) => json({ type: 4, data: { content, allowed_mentions: { parse: [] } } });
  const where = it.channel?.name ? ` in #${it.channel.name}` : it.guild_id ? "" : " in DMs";

  switch (it.data?.name) {
    case "status": {
      const st = await readStatus(env);
      const log = st.log.map((l) => `<t:${Math.floor(l.t / 1000)}:t> ${l.msg}`).join("\n");
      return reply(`**State:** ${st.state}\n${log || "(no events yet)"}`);
    }
    case "start": {
      const res = await startVm(env, ctx, `Discord: ${user.username}${where}`, isAdmin ? null : `discord_${user.id}`);
      if (res.error === "cooldown") return reply(`You already used Start today. Try again in ~${res.retryAfterHours}h.`);
      return reply(res.ok ? "Starting the server... follow with `/status`." : `Not started: ${res.message || res.error}.`);
    }
    case "stop": {
      if (!isAdmin) return reply("Only admins can stop the server.");
      await requestStop(env, `Stop by ${user.username}${where}`);
      return reply("The server will sync and shut down within a minute or two.");
    }
  }
  return reply("Unknown command.");
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
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  }).catch(() => {});
}
