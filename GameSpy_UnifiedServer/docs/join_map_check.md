# How the game checks a joining player's maps

When a player joins, the dedicated server makes sure both sides run the same level.
Read from `Official_DedicatedServer_131.exe` (server) and `RisingEagle.exe` (client) by
static disassembly. Addresses are virtual addresses in those exes.

Short version: the client must have a **byte-identical `bin/gameserver.tcl`**, the same
**shader files**, and the same **`*.n2` files for the level that is running right now**.
The server never sends a map name or a list of maps: only a CRC and a level **index**.

## The steps

All CRCs are the game's CRC16 (`frontline/crc.cc`; the same one as the terrain `.setcrc`).

### 1. Connect: `gameserver.tcl` (server `0x825E80`)

The client's connect request carries its CRC of `home:bin/gameserver.tcl` (read in text
mode). The server computes the CRC of its own copy **at that moment** and, if they differ,
refuses with error 2 and the text `bin/gameserver.tcl mismatch.`

### 2. Server asks for a check (server `0x81AAA0`)

The server sends message `0x1F`:

| Field | Meaning |
|---|---|
| `u16` | CRC of the server's `gameserver.tcl` (computed now) |
| `i32` | **index of the running level** in the server's level list |
| `double` | server time |

The level list is every `.addlevel` line in `gameserver.tcl`, **in file order**
(`.addlevel 0 "home:data/levels/france/eiffel/eiffel.n2"` appends to it; the first number
is not the index). So the index only means the same level on both sides if both files list
the levels in the same order.

### 3. Client checks and answers (client `0x8153B0`, log line `SendCrcList -> sending crc data.`)

1. It CRCs its own `gameserver.tcl` again and compares with the server's. If they differ, it
   shows `CRC Error: "gameserver.tcl" mismatch.` and sends nothing.
2. **Data files**: the CRC of every file in the data list. That is ~34 hard-coded shaders
   (`home:common/shaders/2.0/*.fx`, server `0x822C40`) plus every file added with
   `.addcheck "path"` in `gameserver.tcl`.
3. **Level files**: it takes **level number INDEX from its own list**, goes into that level's
   folder and CRCs every `*.n2` file there (`0x815090`, a `*.n2` file search, not recursive).
4. It sends the counts and CRCs back, with the level index it used.

### 4. Server compares (server `0x825480`)

| Check | Error code | Text sent to the client |
|---|---|---|
| number of data files differs | 2 | `Directory structure invalid.` |
| a data file CRC differs | 2 | the data file's path |
| number of `*.n2` files in the level folder differs | 1 | `Level directory structure invalid.` |
| a `*.n2` CRC differs | 1 | **the server's own path of that file** |

If the client's reported level index is no longer the server's current level (the map
changed meanwhile), the server simply sends step 2 again.

### 5. Client shows the error (client `0x80B0A0`)

Message `0x1A` is `[i32 error code][u16 length][text]`. The client turns the code into the
bold line (table at `0x809A40`: 1 `Level files differ.`, 2 `Data files differ.`, 3 nickname
taken, 4 banned, 5 connection lost, 6 server full, 7 password, 8 version mismatch) and
shows the server's text above it.

## Example: "Level files differ" with eiffel's full path

What happened on 2026-11-15:

1. Client and dedicated server ran from **the same install folder**, so they read the
   **same** `bin/gameserver.tcl`.
2. The server started with eiffel as the 2nd `.addlevel` line (index 1) and was running eiffel.
3. The eiffel line was then commented out in that shared file, and the client was started.
   In the client's list, index 1 is now `full_contact`.
4. The `gameserver.tcl` checks passed: both sides CRC the file when the check runs, and it
   was the same (edited) file.
5. The server asked for "level index 1". The client CRC'd `france/full_contact/*.n2`.
6. One `.n2` on each side, so the counts matched, but the CRC did not. The server sent back
   error 1 with **its** file for index 1: `home:data/levels/france/eiffel/eiffel.n2`.

With separate installs the same edit would have stopped at step 1 with
`bin/gameserver.tcl mismatch.`

## What is NOT checked

* Any other level file: meshes, textures, terrain, lightmaps, sounds. Only the level folder's
  `*.n2` files are compared, and only for the level being played.
* Levels that are not running.
* Game files outside the shader list, unless the server adds them with `.addcheck`.

## What this means for the Rising2 launcher

* **The server's `gameserver.tcl` is the map list, and the game already enforces it.** A
  player can only join if their copy is byte-identical, including the order of `.addlevel`
  lines. Distributing that exact file is mandatory, not optional.
* **The game protocol cannot be asked "which maps do you have?"** It only carries a CRC and
  an index. Any "download what you're missing" has to come from outside the game.
* **`.addcheck "path"`** makes the server require more files to match, e.g. a map pack's
  version file, or a level's textures/meshes if a pack should be enforced completely.

### Keeping clients and servers in sync

1. **Never change a published level in place.** An edited level gets a new folder name
   (`eiffel2_v3`); the client can hold only one version per path.
2. **The server publishes what it really runs.** `r2launch` (Rising2_ServerLauncher) reads
   the server's `gameserver.tcl` at start, hashes it and every level folder it lists
   (SHA-256 over all files, not just `*.n2`), and sends that manifest to the master server,
   authenticated by the server's GP account. The master shows it with the server list.
3. **Files are stored by hash** (e.g. `maps/<sha256>.zip` on S3). `r2launch` uploads any
   level whose hash is missing, so a server can never run something players can't get.
4. **The client launcher syncs before starting the game**: for every live community server
   (or the one the player picks), fetch the manifest, download missing level folders by hash,
   and install that server's `gameserver.tcl`.
   * Since `gameserver.tcl` must match exactly and there is only one per install, a player
     can match one "server family" at a time. Community servers that share one
     `gameserver.tcl` (one map pack) avoid switching; otherwise the launcher swaps the file
     (or keeps one install folder per pack) before launching.

Because the manifest is computed from the files the server actually loads, it can't go out of
sync with a forgotten config entry.

## Note: local mods change what you see, not what the server simulates

Since meshes, textures and the rest of the level are not CRC-checked, a player can change
them locally and still join. That only changes **their own rendering** (e.g. a wall they can
see through). The server loads its own copy of the level and runs its own physics and
collision for every soldier, so the player cannot change the physics the server
experiences: a wall that exists in the server's level still blocks them. Details and what is
still unverified: [server_client_auth_physics.md](server_client_auth_physics.md).
