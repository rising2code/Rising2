# What the dedicated server writes (files and registry)

Where `Official_DedicatedServer_131.exe` (v1.3.1) writes, when, and whether it grows, so cleanup jobs know what to look at.
Paths are relative to the install root (the folder that holds `bin/` and `data/`; `/game` in Docker).

How this was found (2026-11-16):

* **Wine/Docker:** a full run (login, Start, about 60 s running), then `docker diff` on the container, `find -newer` on the game volume,
  and a diff of Wine's registry files against the clean image.
* **Windows:** a full run against a copy of the install. Every file under the install was compared by modification time, and the GameSpy and
  InvasionInteractive registry keys before and after.
* **Ghidra:** decompiled every place that names one of these files, to find the cases a normal run doesn't hit, and read each one's fopen mode.

## Files

| File | Written when | How | Grows? | Cleanup |
|---|---|---|---|---|
| `RisingEagleDS.log` | every server start (engine log) | rewritten each run; kept open while running | no (a few hundred bytes) | none needed |
| `StandAloneMessagesLog.txt` | when the window closes (Quit) | `fopen("w")`: the status box text, overwritten (`0x406200`) | no | none needed; not written when the process is killed (e.g. `docker stop`) |
| `bin/Dedicated_Server_Log_<Month>_<Year>.txt` | when the calendar month changes **while the server runs**: the status box text so far (`0x40C630`) | `fopen("w")` | **yes: one new file per month, never deleted** | delete old ones, e.g. keep 3–6 months (`bin/Dedicated_Server_Log_*.txt`) |
| `bin/serverblacklist.txt` | when bans change (ban, restore, ban expiry) (`0x816240`) | whole file rewritten; read-only flag cleared first | with the number of bans | none; r2launch `--seed-blacklist` replaces it at each start |
| `bin/DedicatedServer.ini` | only on window actions: Save/Add/Delete profile, rotation Save/Delete | whole file rewritten | no | none; never written in an unattended run |
| `bin/oob.n2` | only when the Order of Battle dialog is applied | whole file rewritten | no | none; never written in an unattended run |

The exact monthly file name is put together from `Dedicated_Server_Log_` + month name + `_` + year + `.txt` (the month-name table has a trailing space in each name).
Clean it up with a glob, not an exact name.

Not written by the server: anything under `data/`, `common/`, the exe folder, or Windows/Wine system folders (the `docker diff` showed none).
`RisingEagle.log` and `RisingEagle.l00`–`.l02` in the install root come from the **client** (`RisingEagle.exe`), not the server.

## Registry

| Key / value | Written when | Notes |
|---|---|---|
| `HKCU\Software\GameSpy\GameSpy 3D\Registration` → `Crypt` | first login on a machine without it | the GameSpy SDK's per-machine ID, about 20 characters. Seen in both Wine and Windows |
| `HKLM\Software\InvasionInteractive\RisingEagle\User` → `serverdata` | when a server account is saved ("Add Account" / "Remember Password" on the login page) (`0x418450`) | saved server accounts, credentials included. A 32-bit program without admin rights gets redirected by Windows to `HKCU\Software\Classes\VirtualStore\MACHINE\SOFTWARE\WOW6432Node\InvasionInteractive\RisingEagle\User`; that's where it is on this PC (next to the client's `gamedata`). r2launch doesn't need it: it types the account every time |
| `HKLM\Software\InvasionInteractive\RisingEagle\server\{BF289973-…}` → `Url`, `Version` | read only (update check) | not written |

## Docker / Wine specifics

* **The game volume (`/game`)** only gets `RisingEagleDS.log` in a normal run, plus `serverblacklist.txt` from `--seed-blacklist`,
  the monthly log if the server runs over a month change, and `StandAloneMessagesLog.txt` on a clean Quit (the container's stop doesn't do one).
* **The Wine registry lives in the container, not the volume** (`/wine/system.reg`, `user.reg`, `userdef.reg`).
  The only server value in it is the GameSpy `Crypt` ID. It survives `docker restart`, but a re-created container (`docker compose up` after a change)
  gets a new ID. Nothing seen depends on it staying the same.
* **Temporary files:** `/tmp/wine-*` (wineserver socket) and `/tmp/.X99-lock` / `/tmp/.X11-unix` (Xvfb), in the container layer, reset on re-create.
  The entrypoint deletes a stale `/tmp/.X99-lock` at start.
* **Console output** (launcher and `[server]` status lines) goes to Docker's log. `docker-compose.yml` caps it with `max-size` / `max-file`.

## Cleanup summary

Only one thing grows without limit: `bin/Dedicated_Server_Log_*.txt`, one small file per month. Everything else is either overwritten each time,
bounded by the ban list, or only changes when someone uses the window.
