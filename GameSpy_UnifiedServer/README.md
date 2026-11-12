# Rising2 GameSpy Unified Server

One Python server (stdlib only, one Docker container) that stands in for every
GameSpy service **Rising Eagle** uses, and **saves player stats/rank** from the
official dedicated server's Competition (ATLAS) reports.

It replaces the two older mocks:

| Old | What it did | Now |
|---|---|---|
| `Zenchreal_rising-eagle-master` (C#) | GP login, server list, QR2, CD key | ported 1:1 (same DB, same bytes) |
| `Zenchreal_rising-eagle-soap` (Python 2 / ZSI) | Auth, Sake (5 fixed fake rows), **empty** Competition | Auth as before, Sake backed by SQLite, **Competition implemented** |

## Services and ports

| Service | Port | Proto | Log tag |
|---|---|---|---|
| GP client manager (login, profile) | 29900 | TCP | `GPCM` |
| GP search manager (nicks, new user, check) | 29901 | TCP | `GPSP` |
| Server browser list (enctypex) | 28910 | TCP | `SB` |
| QR2: game servers report themselves | 27900 | UDP | `QR2` |
| CD key (accepts every key) | 29910 | UDP | `CDKEY` |
| NAT negotiation: **logged only, no reply** | 27901 | UDP | `NATNEG` |
| HTTP: motd, AuthService, Sake, Competition, `/rising2/*` | 80 | TCP | `HTTP` `AUTH` `SAKE` `COMP` |

The game reaches these through the `*.reagspy.com` names in the patched exe, so
the hosts file (`Official Files/hosts`) on every player PC and on the dedicated
server must point them at this server's IP.

## Quick start

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

Data lives in `./data` (mounted at `/data`):

```
data/LoginDatabase.db3        accounts, same schema as the old C# server (drop the old file in)
data/rising2_stats.db         sessions, reports, stats, Sake records
data/reports/*.bin            every raw SubmitReport (HTTP body + report) as received (kept 7 days)
data/logs/rising2.log         rotating log, every line in full (the console shortens long ones)
data/create_empty_db.py       + schema_*.sql: copied here on every start
config/rules.py               stats logic (Python), reloaded automatically when saved
config/missing/               stats we receive or are asked for but don't handle yet (see below)
```

Nothing here grows forever: see [Cleanup](#cleanup).

To make empty databases: `python data/create_empty_db.py --out some/folder`
(`--force` replaces existing files and keeps a `.bak`).

`docker-compose.yml` uses `network_mode: host`, like the old setup, so the server
sees each game server's real IP. On Docker Desktop without host networking, use the
commented `ports:` block and set `R2_SB_OVERRIDE_SERVER_IP` (see below).

## Logging

Every connection, packet and HTTP request produces a log line, written before it
is parsed. **No log line means nothing reached the server.**

```
<time> [Service] [Action] [LEVEL] [#conn] what happened | user=<player or server name> ip=<source ip:port> | other targets
2026-11-11 19:11:56.429 [GPCM] [LOGIN] [INFO] [#5] login accepted | user=alice ip=10.0.0.5:1370 | profileid=100000001 sesskey=30592
2026-11-11 19:11:56.479 [QR2] [REGISTERED] [INFO] [#9] challenge answered, server registered and listed | user=My Server ip=10.0.0.9:29023
2026-11-11 19:11:57.102 [COMP] [PLAYER] [INFO] [#24] #0 team=1 result=WIN matched_by=certificate | user=alice | report=1 profileid=100000001 keys=5(INT32)=7 ...
2026-11-11 19:11:57.110 [STATS] [RANKUP] [INFO] [#24] rank changed 1 -> 2 | user=alice | profileid=100000001 xp=120
```

* `[#N]` is the connection number, so `grep '\[#24\]'` shows everything about one connection.
  * TCP: one number per connection. Lines written while handling it carry it too, e.g. the stats lines of the report that HTTP connection delivered.
  * UDP: one number per remote ip:port. A `[PEER]` line announces it the first time the address sends.
  * `[#-]`: not tied to a connection (startup, timers).
* `R2_LOG_LEVEL=DEBUG` (default) adds hex dumps of every packet and the full SOAP request/response bodies.
* `R2_LOG_LEVEL=INFO` gives one line per event.
* The console (and `docker compose logs`) shortens long lines; `data/logs/rising2.log` has them in full:
  * a message over 1024 characters: `first 400 ....[+N chars, see rising2.log].... last 400`
  * a hex dump over 512 bytes: its first and last 8 lines, `....[+N lines / N bytes, see rising2.log]....` between
  * Limits that apply to the file too, so a flood of huge packets can't fill the disk: hex dumps stop at
    `R2_LOG_HEX_MAX` bytes (4096), the readable line of a packet at 600 bytes, a SOAP body at 20000 characters.
* GP password fields (`passenc` can be reversed) are shown as `<redacted>`.
* Missing traffic is flagged too:
  * `[NO-DATA]` / `[NO-REPLY]`: a TCP client sent nothing within `R2_NO_DATA_WARN` seconds (default 10).
  * `[RETRY]`: a UDP client re-sent a packet we had already answered.
  * `[CORE] [NAT]`: traffic is arriving through Docker's NAT gateway.

## How rank gets saved

1. The **official** dedicated server calls `CreateSession`. It only does this once the stats gate passes; see the exe patch below.
2. The server and each client call `SetReportIntention`. Each gets a connection id (ccid), and the ccid is matched to an account.
3. At the end of the session the server calls `SubmitReport`: a DIME message holding the binary ATLAS report.
4. The report is saved raw, parsed, and stored (`comp_reports`, `comp_report_players`). Every raw key value is added to `player_key_totals`.
5. `config/rules.py` turns it into the `PlayerStats_v1` row (counter columns, `TotalSkill`, and `Rank` from the game's own formula).
6. The game reads `PlayerStats_v1` through Sake, and the server answers from the database.

### Matching players to reports

The AuthService certificate carries the player's real profileid, and the game
sends it back with its report, so players are matched even when they all share
one IP (confirmed with the real game). There is no matching by IP: a player
whose certificate has no known profileid is **not** credited, and a WARN line says so.

### Stats rules: `config/rules.py`

All stats logic is one Python file. For each player in a match report the server calls
`on_player(report, player, row)`, then `on_report(report, rows)` once per match:

```python
def on_player(report, player, row):
    add(row, "HeadShotKills", player.key(5))            # total over all games
    keep_max(row, "MostKillsInSession", player.key(6))  # best single game
    if player.result == "WIN":
        add(row, "SessionsWon", 1)
```

* `player.keys` are the raw numbers the game sent; `row` is what the client reads.
* Setting a new column name makes it available to the client too.
* The file is **reloaded when you save it**: the log shows `[STATS] [RULES] RELOADED`. A syntax error keeps the previous rules and logs an ERROR.
* Changed rules count from the next match on. Games already played are not re-scored (match reports are only kept 7 days, for debugging).

The default rules have three steps (what every report key means, with exe addresses:
[docs/report_keys.md](docs/report_keys.md)):

1. `default_columns()`: report keys into the counter columns (kills, hacks, medals,
   per-weapon kills, class skills, ...).
2. `total_skill_change()`: how much `TotalSkill` a match is worth. **This is the place for
   custom rules** (seasons, bonuses). The default is what the original game did: the sum of
   the six class skills of the match. `TotalSkill` never goes below 0.
3. `official_rank()`: an exact copy of the game's own rank formula. The game client has the
   same function and recomputes the rank it shows from `TotalSkill`, `SkillBySquadLeader`,
   `SkillByPlatoonLeader` and `Qualifications`, so **do not change it**: change
   `total_skill_change()` instead.

The Rank values are the client's own labels; what a new player needs:

| Rank | Label | Needs |
|---|---|---|
| 0 | Pvt | `TotalSkill` < 300 |
| 1 | PFC | 300 |
| 2 | Cpl | 600 |
| 3 | Sgt | 1,000 |
| 4 | GS | 2,000 |
| 5 | MC | 3,000 |
| 6 | Lt | 4,000 and `SkillBySquadLeader` or `SkillByPlatoonLeader` >= 500 |
| 7 | Cpt | 6,000 and either >= 1,000 |
| 8 | Mjr | 10,000 and `SkillByPlatoonLeader` >= 2,000 |

A player's current rank lowers the thresholds for keeping it, so a rank doesn't drop right
away. The full formula is in `config/rules.py` and `docs/report_keys.md`.

### Seasons: `config/seasons/`

Every season keeps its own stats, and a new season starts every player from zero.

| File | Meaning |
|---|---|
| `config/seasons/current.txt` | the current season's name: the first line that is not empty or a `#` comment. Letters, digits, `_ . -` (e.g. `2027-pistols`) |
| `config/seasons/<season>.py` | optional rules for that season. They run **on top of** `config/rules.py`: whatever the file defines (usually just `total_skill_change`) replaces the `rules.py` version, for that season only |

* Without `current.txt` (or with an empty or invalid one) the season is `preseason`.
  Without a season file, `config/rules.py` alone is used: its `total_skill_change` is the fallback.
* Saving `current.txt` switches the season **at once**, no restart. The log shows `[STATS] [SEASON] SEASON CHANGED`.
* Every match session gets the current season when the game server starts it; its report
  counts for that season even if you switch seasons before the match ends.
* The game only ever sees the current season: a player with no stats in it gets the
  new-player row (Pvt, all zeros). Old seasons' player stats stay in the database; naming an old season
  in `current.txt` again brings its stats back. Their raw report key totals (`player_key_totals`) are deleted
  when the season changes.
* Data from before seasons existed is season `preseason` (the database is migrated on the first start).
* Example: `config/seasons/example-pistols.py`.

### What's missing: `config/missing/`

Check this folder after a game: every file in it is one stat that needs attention.

| File | Meaning |
|---|---|
| `report_key_<id>.log` | a player value in the match report that `rules.py` never reads. It is stored, but **not shown in game** |
| `report_game_key_<id>.log`, `report_team_key_<id>.log` | the same, for game-wide and team values |
| `sake_column_<table>.<column>.log` | the client asked for a column no row has, so it got an empty value |
| `sake_table_<table>.log` | the client read a table that has never had any data |

Each line records when it happened, the report or player, the value and its type,
or who asked and with which filter.

* A key counts as handled once `rules.py` reads it (`player.key(5)`, `player.keys[5]`, or looping over all keys).
* Keys you decide not to use go in `IGNORED_KEYS`.
* Once something is handled, delete its `.log` file. It only comes back if it is missing again.
* The cleanup keeps the last 50 lines of each file and deletes files that have not been hit for 30 days.

The same items are also in the main log as `[STATS] [MISSING] [WARN]` and on `/rising2/missing`.

## Stats gate: patching the official dedicated server

The official server starts a stats session only when both sides have players
**and two players have different addresses**. To test with everyone on one
machine or one IP, patch a **copy** of the exe (the input file is never changed):

```bash
python tools/patch_dedicated_server.py "path/to/Official_DedicatedServer_131.exe"
```

* Mode `A` (default): removes only the address rule. A player is still needed on each side.
* `--mode B`: removes every condition, so one player is enough (testing only).
* `--check`: shows which patches a file already has.

Only the official server sends reports; the unofficial `DedicatedServer.exe` has that code stubbed out.

## Managed accounts

Another system (your account website) can own the accounts. It creates them and hands out short-lived game passwords,
so a leaked password or a leaked `LoginDatabase.db3` is only useful for a little while.

Turn it on by setting `R2_ADMIN_TOKEN`. Without it the endpoints answer 404. Both calls need
`Authorization: Bearer <R2_ADMIN_TOKEN>` and a JSON body:

| Call | Body | Answer |
|---|---|---|
| `POST /rising2/admin/create` | `{"nick", "email", "password"}` | `200 {"nick", "profileid", "userid", "expires"}`, `409` if the nick is taken |
| `POST /rising2/admin/reset` | `{"nick", "password"}` | `200` as above, `404` for an unknown nick |

Other answers: `400` for bad input (each field is 1-64 printable ASCII characters with no `\`; nick and email have no spaces),
and `401` for a missing or wrong token. These request bodies are never logged.

The password is stored as `md5(password)`, the same as every other account, and `users.expires` gets set:

* create / reset: `expires = now + R2_PASS_TTL_IDLE` (1h). A password nobody uses dies after that.
* every successful login: `expires = now + R2_PASS_TTL_LOGIN` (6h).
* every logout, crash or dropped connection: `expires = now + R2_PASS_TTL_IDLE`.

So while a player keeps playing (the game logs out and back in after every match), the password keeps rolling.
After they leave the game they have 1h to come back. After that, they need a new password from your system (reset).
The expiry is only checked at login: a live session is never cut off.

When the password has expired, GPCM `login` and GPSP `check` fail with "password incorrect", GPSP `nicks` returns no
profiles, and AuthService gives a certificate with profileid 0, so no stats are credited. The account itself stays
visible everywhere else (leaderboards, profiles, search).

Accounts with an empty `expires` never expire. These are accounts from before this feature and accounts from the game's
own "create account". Resetting one turns it into a managed account. Set `R2_DISABLE_NEWUSER=1` to refuse in-game
account creation, so accounts only come from your system.

The admin endpoints share the public HTTP port with the game services, so the token is their only protection: use a long random one.

## Admin and debugging

```bash
docker compose exec rising2 python -m rising2.admin users
```

```bash
docker compose exec rising2 python -m rising2.admin set <nick> Rank 3
```

Other commands: `seasons`, `stats <nick>`, `add-xp <nick> <n>`, `reports`, `report <id>`, `keys [nick]`,
`cleanup` (run every cleanup job now). Stats commands work on the current season; add `--season <name>` for another.

JSON pages: `http://<server>/rising2/status` (includes the current `season` and every season with data),
`/rising2/players[?season=S]`, `/rising2/reports`, `/rising2/report?id=N`, `/rising2/sessions`,
`/rising2/keys[?season=S]`, `/rising2/missing`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `R2_LOG_LEVEL` | `DEBUG` | `DEBUG` / `INFO` / `WARN` |
| `R2_LOG_HEX` | `1` | hex dump every packet (at DEBUG) |
| `R2_LOG_HTTP_BODY` | `1` | log SOAP bodies (at DEBUG) |
| `R2_DATA_DIR` | `/data` | base for DBs, reports, logs |
| `R2_LOGIN_DB` / `R2_STATS_DB` | `$DATA/LoginDatabase.db3` / `$DATA/rising2_stats.db` | |
| `R2_RULES` | `config/rules.py` | stats logic |
| `R2_MISSING_DIR` | `config/missing` | missing-stat files |
| `R2_SEASONS_DIR` | `config/seasons` | `current.txt` and the season rule files |
| `R2_SB_OVERRIDE_SERVER_IP` | empty | list game servers with this IP (for Docker NAT) |
| `R2_QR_ANSWER_AVAILABILITY` | `1` | answer the QR2 0x09 "is the game up" packet |
| `R2_QR_SERVER_TIMEOUT` | `30` | seconds before a silent game server is dropped |
| `R2_ENABLE_NATNEG_LOGGER` | `1` | listen on 27901 just to log |
| `R2_MOTD` | `Welcome to Rising2` | message of the day |
| `R2_ADMIN_TOKEN` | empty | bearer token for `/rising2/admin/*`; empty = endpoints off ([Managed accounts](#managed-accounts)) |
| `R2_DISABLE_NEWUSER` | `0` | `1` = refuse the game's own account creation |
| `R2_PASS_TTL_IDLE` | `1h` | managed password: life after create/reset and after each logout |
| `R2_PASS_TTL_LOGIN` | `6h` | managed password: life after each login |
| `R2_PORT_*` | standard | `GPCM GPSP SB QR NATNEG CDKEY HTTP` |
| `R2_LOG_HEX_MAX` | `4096` | bytes per hex dump (console and file) |
| `R2_JOB_<NAME>_EVERY`, `R2_JOB_<NAME>_KEEP`, ... | see [Cleanup](#cleanup) | cleanup jobs |

## Cleanup

Everything the server writes that only piles up is deleted by cleanup jobs (`rising2/maintenance.py`).

* **On every start all jobs run**, so restarting the container is a cleanup.
* Then each job runs again on its own interval. When a job last ran is stored in the database
  (`maintenance_runs`), so a job that came due while the server was asleep or stopped runs as soon as it is back.
* `key_totals` also runs when the season changes.
* Run them all by hand: `docker compose exec rising2 python -m rising2.admin cleanup`.
* Each job logs a start line, one line per table or folder it cleaned, and an end line:

```
[CORE] [CLEANUP] [INFO] [#-] reports: start (startup) | every=1h keep=7d keep_failed=30d
[CORE] [CLEANUP] [INFO] [#-] reports: comp_report_players: deleted 6 row(s)
[CORE] [CLEANUP] [INFO] [#-] reports: comp_reports: deleted 3 row(s) | keep=7d keep_failed=30d
[CORE] [CLEANUP] [INFO] [#-] reports: raw report files: deleted 6 file(s), 0.1 MB | folder=/data/reports
[CORE] [CLEANUP] [INFO] [#-] reports: done in 0.01s: 9 row(s), 6 file(s) deleted
```

| Job | Every | Deletes |
|---|---|---|
| `logs` | 1h | rotated `rising2.log.N` files older than 14 days, then the oldest until all logs together are at most 200 MB (`MAX_MB`) |
| `reports` | 1h | match reports (`comp_reports`, `comp_report_players`) and their `.bin` files older than 7 days; reports that failed to parse after 30 days (`KEEP_FAILED`) |
| `missing` | 1h | `config/missing/` files not hit for 30 days; the others are cut to their last 50 lines (`LINES`) |
| `handshake` | 1h | `comp_sessions`, `comp_intentions` older than 2 days (only needed until the match report arrives) |
| `logins` | 1d | `logins` rows (login history) older than 30 days |
| `key_totals` | 1d + season change | `player_key_totals` of every season except the current one |
| `backups` | 1d | `*.bak` and old `player_stats_backup_*.json` files next to the databases, older than 30 days |
| `vacuum` | 1d | shrinks `rising2_stats.db` (SQLite keeps deleted space otherwise). Runs at start, and later only once 1000 rows (`MIN_ROWS`) were deleted |

Kept forever: accounts (`LoginDatabase.db3`), Sake records, and every season's player stats.

Settings: `R2_JOB_<NAME>_<SETTING>`, e.g. `R2_JOB_REPORTS_KEEP=3d`, `R2_JOB_LOGS_EVERY=30m`, `R2_JOB_LOGS_MAX_MB=500`.
Durations are `30s`, `10m`, `2h`, `7d` (a plain number is seconds). `R2_JOB_<NAME>_EVERY=0` turns a job off.

Docker keeps its own copy of the console output; `docker-compose.yml` limits it to 5 files of 50 MB.

## Self test

`tools/selftest.py` talks to a running server the way the game does. It runs new
user, login, QR2 register, server list decrypt, CD key, Auth, Sake, and a full
Competition flow with a DIME report, then checks that `TotalSkill` and sessions changed.
Run inside the container it also switches to a temporary season (and back) to check that
players start from zero and a match keeps the season it started in.
`tools/selftest_accounts.py` tests [Managed accounts](#managed-accounts) (about 40 seconds; the
instance needs short expiry times; see the commands in the script's header).
**Point it at a throw-away instance**, because it creates accounts:

```bash
docker run -d --name r2test rising2/gamespy-unified:latest
```

```bash
docker exec r2test python tools/selftest.py
```

## Known gaps

* No real game has talked to this server yet. The protocol pieces were checked against the old servers' code and logs, and the enctypex encryption against the original `Reality.Net.dll`.
* The report key meanings and the original rank formula are unknown; see "Stats rules".
* NAT negotiation, peerchat (6667) and gamestats (29920) are not implemented. The old servers didn't have them either.
* The GameSpy SDK's encoding of strings of 256+ characters inside reports is ambiguous; those are parsed best-effort.
