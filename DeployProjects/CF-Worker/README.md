# Rising2 CF-Worker

No npm packages; Wrangler bundles the ES modules in `src/` into one worker, with
`../LazyServer/cloud_init.sh` as the VM's userData.

| File | What |
|---|---|
| [src/worker.js](src/worker.js) | entry: every inbound call (the API list below) and the token check |
| [src/web.js](src/web.js) | website: the Start button (Turnstile) |
| [src/discord.js](src/discord.js) | Discord: slash commands, webhook posts |
| [src/server.js](src/server.js) | VM life cycle: start checks, stop, teardown, status log |
| [src/ovh.js](src/ovh.js) | OVH API: signed requests, instances, this month's cost |
| [src/cloudflare.js](src/cloudflare.js) | R2 (status, stop flag, rate limit, VM files), DNS, Turnstile |
| [src/util.js](src/util.js) | small shared helpers |

## Endpoints (`https://rising2.net/api/...`)

| Path | Who | What |
|---|---|---|
| `GET /status` | public | `{state, updated, log[10]}`; state = `off` `starting` `up` `stopping` `error` |
| `POST /start` | public, Turnstile | form with `cf-turnstile-response`; 409 if any VM exists in the project or a start is in progress, 403 if the monthly budget is reached, 502 if OVH can't be asked; else once per IP per `START_COOLDOWN_HOURS` |
| `POST /discord` | Discord | interactions endpoint: `/start` `/status` `/stop` |
| `POST /event` | VM (token) | `{msg, state?}` -> status log (+ Discord webhook if set) |
| `POST /dns` | VM (token) | `ip.rising2.net` -> the caller's IP; returns `{ip}` |
| `GET /should-stop` | VM (token) | `{stop: bool}`, polled every minute |
| `POST /teardown` | VM (token) | delete the VM, DNS -> 127.0.0.1 |
| `GET /r2/server/<f>` | VM (token) | compose file / `.env` |
| `GET,PUT /r2/configs_sync/<f>` | VM (token) | saved state (PUT keeps one `.prev`) |
| `POST /admin/start`, `/admin/stop` | token | the [Deploy](../Deploy/) test loop (step 10): start / graceful stop with the same checks, no captcha or cooldown |

Discord: `/start` has the same daily cooldown per user; members with `DISCORD_ADMIN_ROLE`
skip it and may `/stop`, which asks the VM to sync and shut down (within ~1 min).

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
| `OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_CONSUMER_KEY` | a key made on your account's OVH site (`ca.api.ovh.com/createToken/` for OVHcloud Canada, `eu.api.ovh.com/createToken/` for EU) with `GET /cloud/project/PROJECT_ID/*`, `POST /cloud/project/PROJECT_ID/instance`, `DELETE /cloud/project/PROJECT_ID/instance/*` (your real project id, see [Deploy](../Deploy/README.md)); set `OVH_ENDPOINT` to the same site |
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

## Monthly budget

`MAX_COST_CURRENT` / `MAX_COST_FORECAST` (EUR, `wrangler.toml`): before every start (web and Discord,
admins too) the worker reads this month's OVH Public Cloud usage for the whole project
(`/usage/current` and `/usage/forecast`: VMs, the Game.zip bucket, traffic...) and refuses if either
is at or over its limit. The numbers go to Discord only, never to the public status.
After each teardown it posts "This month's server cost so far: ..." to the Discord webhook.
OVH adds usage up hourly, so the last hour or two may be missing; compare the first real post with
the project's Billing control page in the OVH panel.
