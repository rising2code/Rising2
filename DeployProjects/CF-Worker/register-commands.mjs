// One-time: register the /start /stop /status slash commands for the Discord app.
// Usage: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node register-commands.mjs
// (Node 18+, no packages.) With DISCORD_GUILD_ID the commands show up at once in that server.
const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild } = process.env;
if (!app || !token) throw new Error("set DISCORD_APP_ID and DISCORD_BOT_TOKEN");

const commands = [
  { name: "start", description: "Start the Rising2 game server (once a day per player)" },
  { name: "status", description: "Show the game server state and its last events" },
  { name: "stop", description: "Save and stop the game server (admins)" },
];

const url = guild
  ? `https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`
  : `https://discord.com/api/v10/applications/${app}/commands`;
const r = await fetch(url, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(r.status, await r.text());
