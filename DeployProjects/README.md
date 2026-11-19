# Rising2 DeployProjects

Three small projects that run the Rising2 game servers for ~0$ while nobody plays:
the VM exists only while people are playing.

| Project | Runs on | What |
|---|---|---|
| [LandingPage](LandingPage/) | Cloudflare Pages | `rising2.net`: Hebrew/English info page, live server status, captcha-protected **Start** |
| [CF-Worker](CF-Worker/) | Cloudflare Worker + R2 | `rising2.net/api/*`: start/stop the OVH VM, status log, DNS, Discord commands, R2 access for the VM |
| [LazyServer](LazyServer/) | OVH Public Cloud VM | `cloud_init.sh` userData + `docker-compose.yml`: GameSpy mock + official + fun dedicated servers |

No frameworks and no npm packages: plain HTML/JS, one worker file, one bash script
(`wrangler` is only used through `npx` to deploy).

## Flow

```
Player (web + Turnstile) ─┐                    ┌─> OVH API: create VM (userData = cloud_init.sh)
Discord /start /stop ─────┼─> CF-Worker ───────┤
                          │      │  R2         └─> Cloudflare DNS: ip.rising2.net -> VM IP
                          │      ▼
VM (cloud_init.sh) ───────┴─> /api/event, /api/dns, /api/r2/*, /api/should-stop, /api/teardown
```

1. **Start** (web or Discord) -> worker checks the cooldown, checks no VM exists, creates one
   (`c3-8`, falls back to `b3-16`).
2. **First boot** (`cloud_init.sh`): Docker -> compose file and `.env` from R2 -> pull images ->
   download + unzip `Game.zip` from the OVH bucket -> restore SQLite/config from R2 ->
   `ip.rising2.net` -> this VM -> `docker compose up`. Every step posts a status line.
3. **Every minute** (systemd timer): stop requested? Every 15 min: sync SQLite/config to R2,
   and tear down if 0 players twice in a row, or if it's 05:xx Israel time.
4. **Teardown**: stop containers, final sync, call the worker, which deletes the VM and points
   `ip.rising2.net` back at `127.0.0.1`.

## Cloudflare setup

DNS (zone `rising2.net`):

| Record | Type | Value |
|---|---|---|
| `rising2.net`, `www` | Pages custom domain | LandingPage project |
| `ip` | A, DNS only (grey), TTL 60 | set by the worker (`127.0.0.1` while off) |
| `*` | CNAME, DNS only | `ip.rising2.net` (so `*.rising2.net` reaches the VM) |

Cloudflare allows TTL 30 only on Enterprise zones, so `DNS_TTL` is 60.

R2 bucket `rising2`:

| Key | Written by | Cleanup |
|---|---|---|
| `functions/vm_status.txt` | worker | one object, last 10 events |
| `functions/stop_request` | worker | deleted at teardown / next start |
| `ratelimit/<ip_or_discord_id>` | worker | **lifecycle rule: delete after 1 day** |
| `configs_sync/state.tar.gz` (+ `.prev`) | VM | overwritten each sync |
| `server/docker-compose.yml`, `server/.env` | you (`LazyServer/upload.sh`) | - |

```powershell
npx wrangler r2 bucket create rising2
```

```powershell
npx wrangler r2 bucket lifecycle add rising2 ratelimit-1d ratelimit/ --expire-days 1
```

Game files: `Game.zip` in an OVH Object Storage bucket (free egress inside OVH), its URL in
`GAME_ZIP_URL` in `CF-Worker/wrangler.toml`. The zip's root must hold `bin/` and `data/`.
`runzip` (https://github.com/therootcompany/runzip) can list/pull single files from it without a full download.

## Accounts / secrets

See each project's README. One random **shared token** (`openssl rand -hex 32`) is known
only to the worker (secret) and the VM (put into userData by the worker).
