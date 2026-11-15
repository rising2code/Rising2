# Keeping clients in sync: seasons, maps and meshes

Builds on [join_map_check.md](join_map_check.md) (what the game checks when a player joins)
and [server_client_auth_physics.md](server_client_auth_physics.md) (the server runs its own
physics). Measurements below are from the `Install_4` install.

## What has to match between a client and a server

The game enforces exactly two things:

1. **`bin/gameserver.tcl` is byte-identical** (same CRC16). This also guarantees the same
   level indexes, because a level's index is just the order of its `.addlevel` line. Everything
   else in that file (weapon lists, `.addcheck` entries, ...) must match too.
2. **The top-level `*.n2` files of the level being played** have the same CRCs. Only the
   running level is checked, on join and on every map change.

There is no need to keep `.n2` CRCs unique across maps: the client never looks a level up by
its CRC, only by index.

Everything else (meshes, textures, terrain, lightmaps, sounds, other levels) can differ
**without any error**. That is convenient, but it also means an outdated or modified file goes
unnoticed by the game; keeping installs identical is the launcher's job (see
`join_map_check.md`, "Keeping clients and servers in sync").

## Seasons

A season (or any map pack) is simply its own `gameserver.tcl` plus the level folders it lists.

* A player can join a server when their `gameserver.tcl` matches that server's, and they have
  the running level's `*.n2` files.
* Season 1 and season 2 servers can run side by side with different files. A player's install
  has one `gameserver.tcl`, so the launcher has to install the matching one (or keep one
  install folder per season) before starting the game.
* Never edit a published level in place. A changed level gets a new folder name, so one path
  always means one version.

## Meshes

### Where they are and how many

Level folders hold only the terrain mesh. Buildings and props are shared files under
`data/meshes`, referenced from the level's `.n2` as `meshes:...nvx2`:

| | Mesh files referenced | Size |
|---|---|---|
| smallest level (`france/spartan_hill`) | 65 | |
| `france/eiffel` | 227 | 12 MB |
| largest level (`china/guardians_of_the_people`) | 335 | |
| all 16 stock levels together | 1,532 | 132 MB |
| everything in `data/meshes` | 3,089 | 283 MB |

`data/physics` holds 13 Karma `.ka` files (soldier, ABE, barrel, grenade, ...).

### Can `.addcheck` protect them?

`.addcheck "path"` in `gameserver.tcl` adds a file to the "data files" list (server `0x858FC0`,
next to the ~34 hard-coded shaders). On every check the client sends a CRC16 of each listed
file and the server compares them with its own.

* **One global list, not per map.** The list comes from `gameserver.tcl` and is checked in
  full on every join and map change. A different list per season (per `gameserver.tcl`) is
  possible; per map is not. Checking all stock meshes means ~1,500 files / 132 MB read per
  check.
* **It would only cover the start of each mesh.** Data-file CRCs are computed with the file
  opened in **text mode**: both client (`0x81553F`) and server (`0x825529`) pass flag 1 to the
  CRC function, and flag 1 opens the file with `fopen(..., "r")` (client `0x83BEDC`, mode
  string at `0x96F5D8`). The Microsoft C runtime treats byte `0x1A` as end-of-file in text
  mode (standard CRT behaviour, not traced in this exe). Binary `.nvx2` files contain `0x1A`
  very early: between byte 16 and ~24,000 in samples, usually within the first few hundred
  bytes. So the CRC covers the header, not the geometry, and an edited wall still passes.
* **CRC16 is weak.** Even over a whole file, a matching CRC can be forced by changing two
  bytes.
* **Buffer limit.** The client builds its reply in a fixed stack area of about 12 KB
  (`0x8153B0`, frame `0x2F90`, message from `esp+0xC0`), 2 bytes per CRC, so roughly 5,900
  checks at most. No bounds check was seen. The network message size limit is untested.

### Hardening options

| Option | Stops | Does not stop |
|---|---|---|
| Patch both exes so data files are CRC'd in **binary** mode (change the `push 1` to `push 0` at client `0x81553F` and server `0x825529`; the `gameserver.tcl` check uses other call sites and is unaffected), then `.addcheck` the level meshes | casual edits of listed files | forged CRC16 matches, unlisted files, file-free cheats |
| Rising2 launcher verifies SHA-256 of game files before starting | accidental or outdated files, casual edits | a modified or skipped launcher, file-free cheats |

Not tested: the binary-mode patch, whether ~1,500 entries fit the network message, and how
long the check takes on a cold disk.

### What can't be fixed

A modified mesh or texture only changes what **that player sees**. Cheats that change no
files at all (a graphics hook drawing in wireframe, memory edits) are not affected by any file
check. Real wallhack protection would need the server to decide what each player may see,
which this game doesn't do.

What a local edit can't do is change the server's physics: the server loads its own level and
moves soldiers with its own collision, so a wall that exists on the server still blocks the
player (see `server_client_auth_physics.md` for what is and isn't verified).
