# Rising2 Deploy

One script, [deploy.mjs](deploy.mjs), sets up the whole flow on your own accounts and can run one
real start/stop loop. It runs in a small Docker image (node + wrangler), so nothing gets installed
on your machine. The code is mounted, not baked in: edit and rerun, no rebuild.

It uses what's already in `DeployProjects/`:

| Piece | From |
|---|---|
| Worker (`/api/*`) | [../CF-Worker](../CF-Worker) |
| Landing page | [../LandingPage](../LandingPage) |
| The VM's compose file + settings | [../LazyServer/docker-compose.yml](../LazyServer/docker-compose.yml), `../LazyServer/server.env` (from `server.env.example`) |

## What it does

1. **Inputs**: checks `deploy.env`; whatever is missing goes in the report.
2. **OVH**: API key and its rules; finds the Public Cloud project by name (`OVH_CREATE_PROJECT=yes`
   orders one if missing); region, flavors, image; this month's cost; VMs already running; `GAME_ZIP_URL` answers.
3. **Cloudflare**: zone; Turnstile widget; DNS (`ip` A 127.0.0.1 grey, `*` -> `ip` grey,
   apex + `www` -> Pages, existing records are never changed); R2 bucket + the 1-day `ratelimit/` rule;
   `server/docker-compose.yml` + `server/.env` in R2; the worker with your domain and all its secrets;
   the landing page with its Turnstile key / Discord invite / download link; then waits for `/api/status`.
4. **Discord** (optional): webhook check, slash commands, interactions URL.
5. **Test loop** (`TEST_VM=yes`): starts a VM through the worker, follows its status lines until
   "up", checks `ip.<domain>` points at it, stops it, waits until it's deleted and the DNS is parked.
   If the VM doesn't tear itself down in 10 min, the script deletes it through the OVH API so it can't keep billing.

Every step prints as it runs; `out/report.md` (and `report.json`) has the results and a
**Missing settings** table. `out/generated.env` keeps what the script made up or looked up (shared token,
Turnstile keys, OVH project id), so a rerun reuses them. `deploy.env` and `out/` are git-ignored.

## Run

From `DeployProjects/`:

```powershell
Copy-Item Deploy/deploy.env.example Deploy/deploy.env
```

Fill in `Deploy/deploy.env` (and `LazyServer/server.env` for the game servers' passwords), then:

```powershell
docker build -t rising2-deploy Deploy
```

```powershell
docker run --rm --env-file Deploy/deploy.env -v "${PWD}:/app:ro" -v "${PWD}/Deploy/out:/out" rising2-deploy
```

Run it again any time: every step checks first and only creates what's missing.
Set `TEST_VM=yes` in `deploy.env` for the real loop (a few minutes of VM time).

`DRY_RUN=1` prints the wrangler commands instead of running them (the API checks still run).
For testing the script itself, `CF_API_BASE`, `OVH_ENDPOINT`, `DISCORD_API_BASE` and `WORKER_TEST_URL`
can point at stand-ins.

## Notes

* The worker's test start/stop (`POST /api/admin/start`, `/api/admin/stop`) need the shared token,
  like the VM's own calls; they skip the captcha and the daily cooldown, not the "a VM exists" or budget checks.
* The worker gets the same OVH keys as the script unless you set `WORKER_OVH_APP_KEY` /
  `WORKER_OVH_APP_SECRET` / `WORKER_OVH_CONSUMER_KEY` (a key limited to `/cloud/project/*` is safer),
  and `CF_API_TOKEN` unless you set `CF_DNS_TOKEN` (DNS Edit on the zone is all it needs).
* Ordering an OVH project and the R2 lifecycle call are best effort: if OVH or Cloudflare want
  something more, the report says what to do in their panel; then rerun.
