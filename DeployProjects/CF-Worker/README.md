# Rising2 CF-Worker

One file, [src/worker.js](src/worker.js), no npm packages. Bundles `../LazyServer/cloud_init.sh`
as the VM's userData.

## Endpoints (`https://rising2.net/api/...`)

| Path | Who | What |
|---|---|---|
| `GET /status` | public | `{state, updated, log[10]}`; state = `off` `starting` `up` `stopping` `error` |
| `POST /start` | public, Turnstile | form with `cf-turnstile-response`; once per IP per `START_COOLDOWN_HOURS` |
| `POST /discord` | Discord | interactions endpoint: `/start` `/status` `/stop [force]` |
| `POST /event` | VM (token) | `{msg, state?}` -> status log (+ Discord webhook if set) |
| `POST /dns` | VM (token) | `ip.rising2.net` -> the caller's IP; returns `{ip}` |
| `GET /should-stop` | VM (token) | `{stop: bool}`, polled every minute |
| `POST /teardown` | VM (token) | delete the VM, DNS -> 127.0.0.1 |
| `GET /r2/server/<f>` | VM (token) | compose file / `.env` |
| `GET,PUT /r2/configs_sync/<f>` | VM (token) | saved state (PUT keeps one `.prev`) |

Discord: `/start` has the same daily cooldown per user; members with `DISCORD_ADMIN_ROLE`
skip it and may `/stop`. `/stop` asks the VM to sync and shut down (within ~1 min);
`/stop force:true` deletes the VM at once.

## Deploy

```powershell
npx wrangler deploy
```

Secrets (`npx wrangler secret put <NAME>`):

| Name | Where from |
|---|---|
| `SHARED_TOKEN` | `openssl rand -hex 32` |
| `TURNSTILE_SECRET` | Cloudflare dashboard -> Turnstile -> widget for rising2.net |
| `CF_API_TOKEN`, `CF_ZONE_ID` | API token with *Zone.DNS: Edit* on rising2.net |
| `OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_CONSUMER_KEY` | https://eu.api.ovh.com/createToken/ with `GET/POST/DELETE /cloud/project/*` |
| `OVH_PROJECT` | Public Cloud project id |
| `DISCORD_PUBLIC_KEY` | Discord developer portal -> app -> General |
| `DISCORD_WEBHOOK_URL` | optional: channel webhook that gets every status line |

Plain settings are in [wrangler.toml](wrangler.toml) `[vars]` (region, flavors, image, game zip URL...).

Discord app: set *Interactions Endpoint URL* to `https://rising2.net/api/discord`, then once:

```powershell
$env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="..."; node register-commands.mjs
```

Local run (`.dev.vars` holds the secrets, gitignored):

```powershell
npx wrangler dev
```
