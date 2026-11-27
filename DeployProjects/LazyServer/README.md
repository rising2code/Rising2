# Rising2 LazyServer

The OVH VM that exists only while people play. Bash + the `python3` that every cloud image
already has (cloud-init needs it); the only thing installed is Docker.

| File | Where it goes |
|---|---|
| [cloud_init.sh](cloud_init.sh) | bundled into the worker, sent as OVH userData; copies itself to `/opt/rising2/r2.sh` |
| [docker-compose.yml](docker-compose.yml) | R2 `server/docker-compose.yml` -> `/opt/rising2/` |
| `server.env` (from [server.env.example](server.env.example)) | R2 `server/.env` -> `/opt/rising2/.env` |
| [upload.sh](upload.sh) | run by you: pushes the two files above to R2 (or Deploy step 05b) |
| [test-server/](test-server/) | a stand-in compose (hello page + Dozzle logs) to test the VM loop: Deploy step 05a |

The VM has no SSH key unless the worker has `SSH_PUBLIC_KEY`: then `cloud_init.sh` lets that one key in
for the image's default user (`debian`) before anything else, so even a failed start can be looked at.
`GAME_ZIP_URL=none` skips the game files.

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
* minutes 00/15/30/45: SQLite backup (live-safe) + config -> `configs_sync/state.tar.gz`
* 05:xx Israel time -> teardown; 0 players on two checks in a row -> teardown
  (players = sum over `http://127.0.0.1/rising2/status` servers)

Teardown = `docker compose stop`, final sync, `POST /api/teardown` (the worker deletes the VM).

Logs: `/var/log/rising2-init.log`, `journalctl -t rising2`, `docker compose logs`.

## Before the first start

1. Push the images (Deploy steps **04a** once, then **04b** after each change); `server.env` names them
   (`IMG_GAMESPY`, `IMG_DEDICATED`, which 04b prints).
2. `cp server.env.example server.env`, fill in the server accounts and profiles
   (`FUN_PROFILE` must exist in the game's `bin/DedicatedServer.ini`).
3. `./upload.sh seed` once (packs the repo's `GameSpy_UnifiedServer` config + login DB as the
   first saved state), then `./upload.sh` after every change.

Assumptions to check: both servers share one game folder (split it if they clash in `bin/`),
and `OFFICIAL_PORT`/`FUN_PORT` are the game ports used in `R2_SERVER_ACCOUNTS`.
