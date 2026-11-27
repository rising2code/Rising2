# Rising2 LazyServer

The OVH VM that exists only while people play. Bash + the `python3` that every cloud image
already has (cloud-init needs it); the only thing installed is Docker.

| File | Where it goes |
|---|---|
| [cloud_init.sh](cloud_init.sh) | bundled into the worker, sent as OVH userData; copies itself to `/opt/rising2/r2.sh` |
| [docker-compose.yml](docker-compose.yml) | R2 `server/docker-compose.yml` -> `/opt/rising2/` (Deploy step 05b) |
| `server.env` (from [server.env.example](server.env.example)) | R2 `server/.env` -> `/opt/rising2/.env` (Deploy step 05b) |
| [upload.sh](upload.sh) | the same upload by hand, plus `seed` (the first saved state) |
| [test-server/](test-server/) | a stand-in compose (hello page + Dozzle logs, `TEST_PLAYERS` fake players) to test the VM loop: Deploy step 05a |

The images come from Docker Hub: Deploy step **04a** makes the repos once, **04b** builds and pushes
`<user>/rising2-gamespy-mock-server` and `<user>/rising2-re-dedicated-server` after each change
(`rising2-server-dl-manager` is next: it will download Game.zip for the game servers).

The VM has no SSH key unless the worker has `SSH_PUBLIC_KEY` (Deploy step 08): then `cloud_init.sh`
lets that one key in as `root` and `debian` (key only, no passwords) before anything else, so even a
failed start can be looked at: `ssh root@ip.<domain>`. `GAME_ZIP_URL=none` skips the game files.

## On the VM

```
/opt/rising2/
  r2.sh                    this script (init | tick | sync | teardown)
  docker-compose.yml .env  from R2 (+ PUBLIC_IP appended)
  gamespy/data/            LoginDatabase.db3, rising2_stats.db   <- synced with R2
  gamespy/config/          rules.py, seasons/                    <- synced with R2
/srv/rising2/game/         unzipped Game.zip, mounted at /game in both dedicated servers
```

Containers (all `network_mode: host`):

* `gamespy` - [GameSpy_UnifiedServer](../../GameSpy_UnifiedServer) (login, server list, stats)
* `official` - [ServerLauncher](../../ServerLauncher) image, official profile (ranked)
* `fun` - same image, a second profile on another port

The dedicated servers get `*.reagspy.com -> PUBLIC_IP` through `extra_hosts`.

`rising2-tick.timer` runs `r2.sh tick` every minute:

* `GET /api/should-stop` -> if set: teardown
* the player count -> `POST /api/players`, only when it changed (the site and Discord `/status` show it)
* minutes 00/15/30/45 (by the clock): SQLite backup (live-safe) + config -> `configs_sync/state.tar.gz`
* 05:xx Israel time -> teardown; 0 players on two checks in a row -> teardown
  (players = sum over `http://127.0.0.1/rising2/status` servers)

Teardown = `docker compose stop`, final sync, `POST /api/teardown` (the worker deletes the VM).

Every status line (`say`) goes to the worker, which shows it on the site and in Discord with IPs
masked (`135.125.x.x`); the VM's own logs keep them whole.

Logs: `/var/log/rising2-init.log`, `journalctl -t rising2`, `docker compose logs`.

## Before the first start

1. Push the images (Deploy steps **04a** once, then **04b** after each change); `server.env` names them
   (`IMG_GAMESPY`, `IMG_DEDICATED`, which 04b prints).
2. `cp server.env.example server.env`, fill in the server accounts and profiles
   (`FUN_PROFILE` must exist in the game's `bin/DedicatedServer.ini`).
3. `./upload.sh seed` once (packs the repo's `GameSpy_UnifiedServer` config + login DB as the
   first saved state), then Deploy step **05b** (`.\Deploy\step.ps1 05b`) after every change to
   `docker-compose.yml` or `server.env` (it replaces the test server of 05a).

Assumptions to check: both servers share one game folder (split it if they clash in `bin/`),
and `OFFICIAL_PORT`/`FUN_PORT` are the game ports used in `R2_SERVER_ACCOUNTS`.
