// Discord: the /start /status /stop commands, the interactions URL (-> the worker), webhook check.
import { F, DISCORD_API } from "../../lib.mjs";
import { S } from "../../specs.mjs";

const COMMANDS = [
  { name: "start", description: "Start the Rising2 game server (once a day per player)" },
  { name: "status", description: "Show the game server state and its last events" },
  { name: "stop", description: "Save and stop the game server (admins)" },
];

export default {
  title: "Discord: slash commands + interactions URL",
  manual: [
    "a Discord application with a bot (discord.com/developers/applications)",
    "the bot invited to your server with the applications.commands scope",
    "08-repeated-cloudflare-worker deployed WITH DISCORD_PUBLIC_KEY (Discord checks the URL with a signed request)",
  ],
  waitMin: 2,
  env: [
    { name: "DISCORD_APP_ID", f: F.snowflake, required: true, about: "Application ID (General Information)" },
    { name: "DISCORD_BOT_TOKEN", f: F.discordToken, required: true, about: "the bot's token (Bot > Reset Token, shown once)" },
    { name: "DISCORD_GUILD_ID", f: F.snowflake, about: "your server's id: commands show there at once (else global, up to ~1 h)" },
    S.DOMAIN,
    { name: "DISCORD_WEBHOOK_URL", f: F.webhook, about: "the channel webhook the worker posts to (only checked here)" },
  ],

  async deploy(E, R) {
    const H = { authorization: `Bot ${E.DISCORD_BOT_TOKEN}`, "content-type": "application/json" };
    const d = async (method, p, body) => {
      const r = await fetch(`${DISCORD_API()}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      if (!r.ok) throw new Error(`Discord ${method} ${p}: ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };
    const app = await d("GET", "/applications/@me");
    if (app.id !== E.DISCORD_APP_ID) R.warn("app", `the bot token belongs to app ${app.id}, not DISCORD_APP_ID ${E.DISCORD_APP_ID}`);
    R.ok("app", `"${app.name}"`);
    R.output("DISCORD_PUBLIC_KEY", app.verify_key);

    const cmdPath = E.DISCORD_GUILD_ID ? `/applications/${app.id}/guilds/${E.DISCORD_GUILD_ID}/commands` : `/applications/${app.id}/commands`;
    await d("PUT", cmdPath, COMMANDS);
    R.ok("commands", `/start /status /stop ${E.DISCORD_GUILD_ID ? "in your server" : "global (can take up to an hour to show)"}`);

    const url = `https://${E.DOMAIN}/api/discord`;
    try {
      await d("PATCH", "/applications/@me", { interactions_endpoint_url: url });
      R.ok("interactions URL", url);
    } catch (e) {
      R.fail("interactions URL", `${e.message} - Discord sends a signed PING there: the worker must be live with DISCORD_PUBLIC_KEY = ${app.verify_key}`);
    }

    if (E.DISCORD_WEBHOOK_URL) {
      const r = await fetch(E.DISCORD_WEBHOOK_URL);
      if (r.ok) { const w = await r.json(); R.ok("webhook", `"${w.name}" in channel ${w.channel_id}`); }
      else R.fail("webhook", `answered ${r.status} - wrong or deleted webhook`);
    } else R.skip("webhook", "DISCORD_WEBHOOK_URL not set");
  },

  async undeploy(E, R) {
    const H = { authorization: `Bot ${E.DISCORD_BOT_TOKEN}`, "content-type": "application/json" };
    const call = (method, p, body) => fetch(`${DISCORD_API()}${p}`, { method, headers: H, body: JSON.stringify(body) });
    const cmdPath = E.DISCORD_GUILD_ID ? `/applications/${E.DISCORD_APP_ID}/guilds/${E.DISCORD_GUILD_ID}/commands` : `/applications/${E.DISCORD_APP_ID}/commands`;
    const r1 = await call("PUT", cmdPath, []);
    r1.ok ? R.ok("commands", "removed") : R.fail("commands", `${r1.status}`);
    const r2 = await call("PATCH", "/applications/@me", { interactions_endpoint_url: null });
    r2.ok ? R.ok("interactions URL", "cleared") : R.fail("interactions URL", `${r2.status}`);
  },
};
