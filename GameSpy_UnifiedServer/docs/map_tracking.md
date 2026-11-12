# Which map was a match played on?

`config/rules.py` gets `report.map` and `report.gametype`. This page explains why that
is not simple, which options were considered, and how it works now.

## The problem: no message has both the map and the match

Each GameSpy service sees only its own piece, and they share nothing but an IP address:

| Service | What it carries | Identifies the game server by | Has the map? | Has the account? |
|---|---|---|---|---|
| **QR2** heartbeat (UDP 27900) | hostname, `mapname`, `gametype`, `hostport`, players (names), teams | source IP + random source port; the `hostport` key inside (fixed game port) | **yes** | no |
| **GP** login (TCP 29900) | the dedicated server logs in with a GP account | IP + its own TCP port | no | **yes** |
| **Competition** `CreateSession` (HTTP) | certificate of the server's account, gameid | IP only (new random port per HTTP request) | no | **yes** |
| **Competition** `SetReportIntention` (HTTP) | csid, ccid, the caller's certificate | IP only | no | yes (each player's) |
| **Competition** `SubmitReport` (HTTP + DIME) | csid, ccid, server certificate, binary report | IP only | **no** | yes |

The match report itself has only per-player keys (see `docs/report_keys.md`): no map,
no mode, no match length. The server never writes game-level or team-level keys.

Ids that are *not* a link:

* `csid` (one per match) and `ccid` (one per participant in a match) are made by this
  server in `CreateSession` / `SetReportIntention`. They exist only inside Competition.
* The 16-byte id at the start of the binary report is a per-session id from the game; it
  appears nowhere else.
* The HTTP source port is new for every request.
* The `[#N]` in log lines is this server's own connection counter.

So "this report" and "this QR2 server" share only the source IP, and several game servers
can run behind one IP (or behind one NAT gateway).

**LAN games** never talk to QR2 at all (they are found by broadcast), so for them the map
is never known.

## Options that were considered

1. **IP only**: take the QR2 server with the submitter's IP. Breaks as soon as two
   servers share an IP, or every server sits behind the same NAT gateway.
2. **Player names**: pick the QR2 server whose heartbeat player lists contain the
   report's players. Works without configuration, but the names in heartbeats are in-game
   names (may differ from the GP nick), and at the end of a match the list may already be
   empty.
3. **Learned link**: match by IP or names once, then remember `account -> QR2 server`.
   Needs no configuration, but is guesswork until the first good match.
4. **Configured link (chosen)**: the admin states which game server uses which GP
   account. With one GP account per dedicated server, the certificate in
   `CreateSession` / `SubmitReport` tells exactly which server it is.

## How it works now

Every dedicated server logs in with **its own GP account**. The admin lists them:

```
R2_SERVER_ACCOUNTS=1.2.3.4:27015=srv_eu1,1.2.3.4:27016=srv_eu2
```

* `IP` = the address this server sees the game server's heartbeats from.
* `PORT` = the server's **game port** (`hostport` key in its heartbeat, the port players
  join on, set in the server's config). Not the random QR2 source port, so the setting
  survives restarts.
* `NICK` = the GP account that dedicated server logs in with.

The chain:

```
QR2 heartbeat   -> source IP + hostport (from its content) -> map, gametype, players
R2_SERVER_ACCOUNTS: IP:hostport = srv_eu1                  -> nick
login DB:       srv_eu1                                    -> profileid
SubmitReport certificate                                   -> profileid  => same server => map
```

### Choosing the map

For every configured server the last **5 heartbeats** (time, map, gametype, player
names) are kept **in memory only**. At `SubmitReport` the match window is
`CreateSession` time .. now:

1. Heartbeats inside the window are the candidates. If some of them list at least one of
   the report's players, only those count (at the end of a match the server may already
   show the *next* map, often with players gone).
2. The map seen most often among the candidates wins; on a tie, the earliest (the map at
   the start of the match).
3. No heartbeat inside the window (a very short match): the last heartbeat before
   `CreateSession`.
4. If none of the report's players ever appear in that server's heartbeats, a WARN is
   logged, but the map is still used: the configured link is authoritative, the player
   check is only a sanity check.

The result is stored on the report (`comp_reports.map`, `comp_reports.gametype`) and
handed to the rules as `report.map` / `report.gametype`.

### When the map is unknown

`report.map` and `report.gametype` are then `""` (empty string, so `if report.map:` works),
and one log line says why:

* tracking is off: `R2_SERVER_ACCOUNTS` is not set (logged once at startup),
* the submitting account is not in `R2_SERVER_ACCOUNTS`,
* the configured server has sent no heartbeat (LAN game, not listed, or this server was
  restarted during the match, since heartbeats are kept in memory only).

### Logs

| Line | Meaning |
|---|---|
| `[MAP] [TRACKING] [INFO]` | at startup: disabled (no setting) or enabled with N servers |
| `[MAP] [CONFIG] [WARN]` | an entry in `R2_SERVER_ACCOUNTS` is malformed, or its nick is not in the login DB |
| `[MAP] [UNMAPPED] [INFO]` | a game server heartbeats that is not in the setting (once per server) |
| `[MAP] [MATCH] [INFO]` | `CreateSession`: map running when the match started |
| `[MAP] [REPORT] [INFO/WARN]` | `SubmitReport`: which map was chosen and why, or why it is unknown |
