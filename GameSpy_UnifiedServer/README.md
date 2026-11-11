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
data/reports/*.bin            every raw SubmitReport (HTTP body + report) as received
data/logs/rising2.log         rotating log, same lines as the console
data/create_empty_db.py       + schema_*.sql: copied here on every start
config/rules.py               stats logic (Python), reloaded automatically when saved
config/missing/               stats we receive or are asked for but don't handle yet (see below)
```

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
5. `config/rules.py` turns it into the `PlayerStats_v1` row (XP into `TotalSkill`, `Rank` from XP thresholds, plus whatever you map).
6. The game reads `PlayerStats_v1` through Sake, and the server answers from the database.

### Matching players to reports (`R2_CERT_MODE`)

* `per_user` (default): the AuthService certificate carries the player's real profileid, so matching works even when every player shares one IP.
* `canned`: the old mock's certificate, byte for byte (profileid 22222 for everyone). Players are then matched by the IP they logged in from. If several accounts logged in from the same IP, the player is **not** credited, and a WARN line says so.

If the game ever rejects logins with `per_user`, switch to `canned`.

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
* To apply changed rules to games already played, run `python -m rising2.admin rebuild --yes`. It recomputes every player from all stored reports and writes a JSON backup first. Manual `set` changes are not replayed.

The default rules give XP per match plus a win bonus, count `TotalSessions` and
`SessionsWon`, and set `Rank` with `compute_rank(row)`.

The Rank values are the client's own labels (read from `RisingEagle.exe`):

| Rank | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| Label | Pvt | PFC | Cpl | Sgt | GS | MC | Lt | Cpt | Mjr |

The thresholds are our own estimate, scaled to a 2008 leader board:

| Rank | Needs |
|---|---|
| Pvt | 0 general skill (`TotalSkill`) |
| PFC | 1,000 |
| Cpl | 5,000 |
| Sgt | 15,000 |
| GS | 30,000 |
| MC | 50,000 |
| Lt | MC plus 10,000 `SkillBySquadLeader` |
| Cpt | MC plus 25,000 `SkillBySquadLeader` |
| Mjr | Cpt plus 50,000 `SkillByPlatoonLeader` |

Squad leading gets you to Lt and Cpt; only platoon leading makes a Captain a Major.
Both leader skills stay 0 until report keys are mapped to them, so until then nobody
gets past MC. The same table is at the top of `config/rules.py`.

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

## Admin and debugging

```bash
docker compose exec rising2 python -m rising2.admin users
```

```bash
docker compose exec rising2 python -m rising2.admin set <nick> Rank 3
```

Other commands: `stats <nick>`, `add-xp <nick> <n>`, `reports`, `report <id>`, `keys [nick]`, `rebuild --yes`.

JSON pages: `http://<server>/rising2/status`, `/rising2/players`, `/rising2/reports`,
`/rising2/report?id=N`, `/rising2/sessions`, `/rising2/keys`, `/rising2/missing`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `R2_LOG_LEVEL` | `DEBUG` | `DEBUG` / `INFO` / `WARN` |
| `R2_LOG_HEX` | `1` | hex dump every packet (at DEBUG) |
| `R2_LOG_HTTP_BODY` | `1` | log SOAP bodies (at DEBUG) |
| `R2_CERT_MODE` | `per_user` | see "Matching players" |
| `R2_DATA_DIR` | `/data` | base for DBs, reports, logs |
| `R2_LOGIN_DB` / `R2_STATS_DB` | `$DATA/LoginDatabase.db3` / `$DATA/rising2_stats.db` | |
| `R2_RULES` | `config/rules.py` | stats logic |
| `R2_MISSING_DIR` | `config/missing` | missing-stat files |
| `R2_SB_OVERRIDE_SERVER_IP` | empty | list game servers with this IP (for Docker NAT) |
| `R2_QR_ANSWER_AVAILABILITY` | `1` | answer the QR2 0x09 "is the game up" packet |
| `R2_QR_SERVER_TIMEOUT` | `30` | seconds before a silent game server is dropped |
| `R2_ENABLE_NATNEG_LOGGER` | `1` | listen on 27901 just to log |
| `R2_MOTD` | `Welcome to Rising2` | message of the day |
| `R2_PORT_*` | standard | `GPCM GPSP SB QR NATNEG CDKEY HTTP` |

## Self test

`tools/selftest.py` talks to a running server the way the game does. It runs new
user, login, QR2 register, server list decrypt, CD key, Auth, Sake, and a full
Competition flow with a DIME report, then checks that XP and rank changed.
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
