# Dedicated server options: profile vs launcher

Which settings of `Official_DedicatedServer_131.exe` (v1.3.1) can come from a saved profile in `bin/DedicatedServer.ini`,
which ones `r2launch` can set, and which ones only a person at the window can set today.

How this was checked (2026-11-16):

* The settings list (control 1010) was read from a running test server, before and after selecting profiles.
* The exe was decompiled with Ghidra. The ini loader is at `0x407800`, profile save at `0x408C30`, Start at `0x40E120`,
  the settings sent to the game at Start at `0x40AA20`, and the rotation at Start at `0x423870`.
* A saved map rotation was loaded on a test server with window messages.

Columns:

* **Profile:** the `DedicatedServer.ini` key. The server reads it when the profile is selected and writes it on "Save Current Profile".
* **r2launch:** what the launcher can do today.

## Main settings list (28 rows)

| # | Row in the window | Profile (ini key) | r2launch | Notes |
|---|---|---|---|---|
| 0 | Server name | `ServerName` | via `--profile` | |
| 1 | Password (optional) | `Password` | via `--profile` | join password for players |
| 2 | Server type | `ServerType` | via `--profile` | Internet / LAN |
| 3 | My I.P is | — | — | filled in automatically; display only, never read by Start |
| 4 | Location | `Location` | via `--profile` | |
| 5 | Level | `LevelName` | via `--profile` | Start refuses an empty level ("No level selected.") |
| 6 | Mission type | `MissionType` | via `--profile` | Conquest / Frag / Search & Destroy |
| 7 | Gaming style | `GamingStyle` | via `--profile` | |
| 8 | Server message | `ServerMessage` + `ServerMessageSize` | via `--profile` | multi-line; Size = character count |
| 9 | Time limit (minutes) | `TimeLimit` | via `--profile` | |
| 10 | Allow friendly fire | `AllowFriendlyFire` | via `--profile` | |
| 11 | Balance sides | `BalanceSides` | via `--profile` | |
| 12 | Maximum players | `MaximumPlayers` | via `--profile` | |
| 13 | Restrict skill | `RestrictSkill` | via `--profile` | |
| 14 | Minimum Skill | `SkillAbove` | via `--profile` | |
| 15 | Maximum Skill | `SkillBelow` | via `--profile` | |
| 16 | Unlimited Spawn | `UnlimitedSpawn` | via `--profile` | |
| 17 | Num of spawn | `NumOfSpawn` | via `--profile` | |
| 18 | Spawn delay | `SpawnDelay` | via `--profile` | |
| 19 | Autoreload | `Autoreload` | via `--profile` | |
| 20 | Order of battle | `OrderOfBattle` | via `--profile` | name of a set in `bin/oob.n2` (see below) |
| 21 | Voice over IP | `VoIP` | via `--profile` | |
| **22** | **Game Port** | **— (not saved)** | **`--port`** | **always 29023 at startup; used at Start; valid 29023–65000** |
| 23 | Team kills tolerated | `ExcessiveTeamKill` | via `--profile` | |
| 24 | Reshuffle positions (sessions) | `ReshufflePositions` | via `--profile` | |
| 25 | Remote Game Admin | `RemoteAdmin` | via `--profile` (+ `--admin-pass`) | **Enabled needs an admin password that isn't in the profile** (see below) |
| 26 | Tournament Web Page Address | — | — | not saved, and nothing in the dialog code reads it: appears to do nothing |
| **27** | **AFK Time (seconds)** | **— (not saved)** | **`--afk-time`** | **always 0 at startup; used at Start** |

Any row can also be set for one run with `--row "LABEL=VALUE"` (or the row number); the launcher reads each one back.

So 24 of the 28 rows come from the profile. Two rows that matter, **Game Port** and **AFK Time**, can't be saved: they reset on every start.

## Outside the settings list

| Setting | Where it lives | Profile | r2launch | Notes |
|---|---|---|---|---|
| Server account (nickname + password) | login page | — | ✅ `--nick` / `--pass` | "Remember Password" stores accounts in the `serverdata` registry value (see [server_files.md](server_files.md)); not needed, the launcher types them |
| Profile choice | combo at the bottom | — | ✅ `--profile` | `Default` won't start (no server name) |
| **Map rotation ("Roaming Maps List")** | `[RoamingProfile]` section of the ini | saved, **but not loaded at startup** | **`--rotation`** | see below |
| **Remote admin password** | admin page, edit 1096 | — | **`--admin-pass`** | Start shows "You have to insert admin password." if Remote Game Admin is Enabled and this is empty |
| Order of battle contents | `bin/oob.n2` (via the OOB dialog) | the profile names the set | n/a | file on disk, edit once and keep |
| Ban list | `bin/serverblacklist.txt` | — | `--seed-blacklist` | rewritten whole by the server; seed a copy per server |
| Kick / ban / warn / message / pause / end session | admin page | — | n/a | live actions while running, not settings |
| Hide Clan Tags | admin page checkbox | — | — | not saved; unchecked at startup |

### Map rotation

* The ini can hold named rotations. Each `[RoamingProfile]` block lists entries: a full set of settings plus `Sessions` (rounds before moving on).
  The test install has one rotation, named `2`: Dynamics (1 session), then Eiffel (1 session), Server Name `S1`.
* At startup the rotation list is **empty**. A rotation is used only if someone opens the roaming page, picks its name and presses **Load** before Start.
* If the list has entries when Start is pressed, Start sends all of them, plus the roaming page's Server Name and Password fields, to the game (`0x423870`).
* Tested: picking `2` and pressing Load with window messages fills the list (2 rows) and the Server Name field. Starting a rotation end to end is tested (see below): use `--rotation NAME`.

### Remote admin

`RemoteAdmin = Enabled` in a profile is fine by itself. But Start then needs a non-empty password in the admin page (`0x413330` only checks that it isn't empty).
Without `--admin-pass` such a profile never starts: every Start attempt shows the message box, which the launcher counts as a failure and retries.

## Three kinds of setting

| Kind | Saved in the ini? | Applied automatically? | Examples | Launcher |
|---|---|---|---|---|
| Profile settings | ✅ in each `[Profile]` block | ✅ when the profile is selected | the 24 profile rows | `--profile` |
| Map rotation | ✅ in its own `[RoamingProfile]` section | ❌ only after Load | rotation "2": Dynamics → Eiffel | `--rotation` |
| Not saved at all | ❌ | ❌ | Game Port, AFK Time, admin password | `--port`, `--afk-time`, `--admin-pass` |

## Tested results (Wine container, 2026-11-16)

* `--row "Remote Game Admin=Enabled"` with no admin password: Start shows "You have to insert admin password.", and the launcher retries until the timeout.
  So Start really uses rows written by the launcher.
* The same plus `--admin-pass`: starts.
* `--port 29050 --afk-time 300`, no rotation: the server binds UDP 29050, and the master server lists `hostport=29050`.
* `--rotation 2` on profile Eiffel_server: the rotation loads (2 maps, server name S1), and the server starts **Dynamics** as **S1**.
  The rotation's first entry wins over the profile.
* `--rotation` together with `--port 29050`: the master server lists **hostport=29023**. With a rotation, every setting comes from the rotation's entries
  (they are read from the ini, which has no port), so `--port`, `--afk-time` and `--row` do nothing. The launcher warns about this combination.
* `--seed-blacklist`: the file is copied to `bin/serverblacklist.txt` before the server starts.
* An unknown `--row` name: the launcher lists all 28 rows once and retries.

## Ban list format

Decompiled writer at `0x816240`: it clears the read-only attribute, then writes every entry again (a whole-file rewrite, not an append):

```
[PLAYER]
[PLAYER_NAME]<nick>
[BANNED_FOR]<minutes, 0 = permanent>
[BANNED_TIME]<number, probably Unix time>
[/PLAYER]
```

## Windows results (2026-11-16, against the dev `rising2-gamespy`, account `server`)

* `--port 29050 --afk-time 300`, Tournament via `--row`, Remote Game Admin via `--row`, plus `--admin-pass` and `--seed-blacklist`:
  logged in and started, and the server bound UDP **29050**.
* `--row "Server type=Local Network"` (the LAN value; "Internet" heartbeats don't reach a local dev server) plus `--rotation 2`:
  the rotation loaded and started Dynamics.
* On Windows the first Login press is usually ignored; the retry handles it.

## What reaches players (master-server heartbeat keys)

Seen in the mock's debug log: `hostname`, `mapname`, `server_message`, `public_address`, `roaming_levels`, `password`, `gametype`, `timelimit`,
`friendly_fire`, `balance_sides`, `maxplayers`, `skill_restriction_above/below`, `server_type`, `voip`, `autoreload`, `hostport`, and others.
There is **no tournament key and no AFK key**. The Tournament address goes nowhere. AFK Time is applied inside the game (decompiled), but its effect
(kicking idle players) wasn't observed, since that needs a player.

## Rotation and port: why it can't be fixed from the window

* Rows set before Load or after Load make no difference: the port stays 29023.
* "Add to list" builds an entry from the current rows. Its handler (`0x40BFC0`) gathers the settings, and the entry copy (`0x422D80`) does copy the port field
  (`+0x1594`). An entry made that way with port 29050 still bound **29023** at Start.
* So in rotation mode the game ignores the port in the entries. The only ways around it are a separate IP per server, or patching a copy of the exe.

## Other findings

* **Hide Clan Tags** (admin page) only redraws the admin page's own player list. It's a display toggle, not a server setting.
* **Files the server writes:** `RisingEagleDS.log` (rewritten every run), `StandAloneMessagesLog.txt` (tiny), `bin/serverblacklist.txt`, and
  `bin/Dedicated_Server_Log_<Month Year>.txt`, written only when the month changes while the server runs (`0x40C630`): at most one small file per month.

## Still open

* **Rotation + port:** a rotation server always uses 29023. Options: one rotation server per IP, a separate IP per container, or a patched copy of the exe.
* **Monthly log files** (`Dedicated_Server_Log_*.txt`) are never cleaned up; they are small (one per month).
* **Tournament Web Page Address:** does nothing; left out on purpose.
