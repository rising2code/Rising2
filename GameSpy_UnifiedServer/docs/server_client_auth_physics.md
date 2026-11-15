# Who decides where a soldier is: server physics vs. client messages

Question: if a player edits their local level (e.g. removes a wall's collision), can they
walk through that wall, or only see through it?

Short answer: the dedicated server runs its own physics and collision for every soldier,
and clients send queued events (inputs and actions) that the server applies on its own
tick. Nothing found so far lets a client set its own position. **This is not fully
proven**: only part of the client event handlers were read (see the end).

Read from `Official_DedicatedServer_131.exe` (32-bit PE, image base `0x400000`) by static
disassembly (Python + capstone). Addresses are virtual addresses in that exe. The client
`RisingEagle.exe` contains the same game code (`nGameServer` is shared), at different
addresses.

## The physics engine

The server links a full physics and collision engine, wrapped by Nebula2's
`nPhysiqueServer` (`\Rising Eagle\code\nebula2\src\physiq\nphysique_main.cc`):

| Piece | Evidence (strings in the exe) |
|---|---|
| MathEngine **Karma** dynamics | `nPhysiqueServer::Tick(...): MdtWorldStepSafeTime` (`Mdt` = Karma dynamics toolkit) |
| Karma **collision** | `McdSpacePathUpdate`, `Invalid McdSpaceID.`, `McdModelPairs in McdSpace` (`Mcd` = Karma collision), and `Your evaluation version of the Collision library has timed out.` |
| **OPCODE** ray collision | `SkipPrimitiveTests not possible for RayCollider !` |
| Soldier physics | `MblSoldier::TriggerPhysics(...)`, `PostTriggerPhysics(): %s is not in model space!!!`, fall/climb/crouch states (`STATE_FALLWALK`, `STATE_CLIMBRUN`, ...) |
| Level geometry on the server | the server log shows `nGameServer::LoadLevel` and `TerrainNode::Init() started`; it imports `d3d9.dll` / `d3dx9_29.dll` (likely why it needs DirectX 9 to load levels) |

## The server's main loop runs physics every tick

* `nGameServer::Run` at `0x83A120` (error texts `ERROR: nGameServer::Run(...): 1 : %d`) is the
  main loop. In **both** of its branches it calls, per pass:
  1. `0x839D40`: drain the queue of client events (below)
  2. `0x82E2E0`: game update / network sends
  3. `0x816990`: **`nGameServer::TriggerPhysics(double dt)`** (error text
     `ERROR2: nGameServer::TriggerPhysics(...): %d`)
* `0x816990` walks two soldier lists on the game server object (`+0x53C`, count `+0x544`, and
  `+0x514`, count `+0x51C`, most likely the two teams) and calls each soldier's virtual method
  at vtable `+0x130` with `dt` (the soldier's own physics step), then calls `0x812E00`.
* The byte at game server `+0x2E0` is the "session running" flag (set to 1 in
  `nGameServer::BeginSession` `0x82C43D`, cleared on unload). Several message handlers only
  act while it is 1.

## The server sends soldier state out

| Message | Built at | Goes to | Content |
|---|---|---|---|
| `0x44` | `0x816AB0` | everyone | for each soldier with health > 0 (`+0x380`): soldier id (`+0x2BE`), `+0x2088`, a time delta (`server +0x604` - `soldier +0x208C`), `+0x1DA8` (double sent as float), bytes `+0x7C2`, `+0x730`, then the soldier's packed state via vtable `+0x1EC` (arg 9) |
| `0x5D` | `0x827A60` | each connected client | loops over the client list (`+0x31C`, count `+0x324`, record size `0x118`, soldier at `+0x50`), packs that client's soldier via vtable `+0x1EC` |
| `0x64` | `0x81CD00` | one client | one soldier's packed state via vtable `+0x1EC` (arg `0x110`) |

Receivers unpack with the soldier's vtable `+0x1F0`: handlers `0x8148C0` (`0x44`),
`0x814B00` (`0x5D`), `0x8131C0` (`0x64`) and `0x813610` (queued event `0x65`). Each checks
the session flag and that the soldier slot's id (`+0x2BE`) matches before applying.

The meaning of the individual fields (`+0x2088`, `+0x208C`, `+0x1DA8`, ...) is **not
decoded**: they may be position, timing or orientation.

## What clients send, and what the server does with it

The message dispatcher is `0x838B60`: the first byte is the type, decoded through the byte
table at `0x8394FC` and the pointer table at `0x8393B4` (type - 1, 0x75 entries). Handlers
that receive the sender's connection (`[ebp+0x10]`) are the ones that make sense from a
client, e.g. `0x20` join (`0x825E80`), `0x01` CRC reply (`0x825480`, see
`join_map_check.md`).

**31 client message types all go to one handler, `0x812490`, which only queues them**
(`0x811AC0` appends to the queue at game server `+0x608`, each entry: tick, type, sender,
length, data):

`0x16 0x17 0x18 0x1B 0x1C 0x43 0x45 0x46 0x48 0x49 0x4A 0x4B 0x4C 0x4D 0x4F 0x50 0x51 0x52
0x53 0x54 0x55 0x56 0x57 0x58 0x59 0x5A 0x5B 0x62 0x63 0x65 0x6E`

The server drains the queue in `0x839D40`, once per main-loop pass, only events whose tick
(`entry`) is not later than the server's current tick (`+0x604`). The event type (`+0x620`)
minus `0x16` indexes the byte table `0x83A0B8` and pointer table `0x83A03C`:

| Event | Handler | | Event | Handler |
|---|---|---|---|---|
| `0x16` | `0x810120` | | `0x50` | `0x8142B0` |
| `0x17` | `0x81E1D0` (also gets `+0x624`) | | `0x51` | `0x814360` |
| `0x18` | `0x80D2D0` | | `0x52` | `0x814590` |
| `0x1B` | `0x81E860` | | `0x53` | `0x813F50` |
| `0x1C` | `0x81E660` | | `0x54` | `0x814080` |
| `0x45` | `0x8126C0` | | `0x55` | `0x8138A0` |
| `0x46` | `0x812570` | | `0x56` | `0x81D6C0` |
| `0x48` | `0x813DA0` | | `0x57` | `0x81D050` |
| `0x49` | `0x8137F0` | | `0x58` | `0x814F30` |
| `0x4A` | `0x813EA0` | | `0x59` | `0x8146C0` |
| `0x4B` | `0x813C50` | | `0x5A` | `0x839A40` |
| `0x4C` | `0x813AE0` | | `0x5B` | `0x81EAE0` |
| `0x4D` | `0x813BA0` | | `0x62` | `0x814DF0` |
| `0x4F` | `0x828AC0` | | `0x63` | `0x814EA0` |
| | | | `0x65` | `0x813610` |
| | | | `0x6E` | `0x814CB0` |

(`0x43` is queued but has no entry in this table.)

Handlers read so far:

* **`0x46` → `0x812570`**: reads a soldier id and slot id, two ints, a length-prefixed block,
  copies it, and applies it to that soldier through `0x80BD70` (only while the session flag is
  set and the slot id matches). The shape fits an input/animation-state event. The exe
  has name tables for these states (`IO_WALK`, `IO_PEEK`, `IO_UPDOWN`, `STATE_STANDWALK`,
  `STATE_CROUCHWALK`, `STATE_FALLRUN`, ...). The block's layout was not decoded.
* **`0x65` → `0x813610`**: takes **two** soldier ids, checks both slot ids, and calls
  `0x47BBD0` on both: a soldier-to-soldier interaction, not a position update.

## Conclusion so far

* The server has its own physics + collision world and steps every soldier in it each tick.
* Clients' gameplay messages are queued and applied by the server on its own tick; the server
  then sends the resulting soldier states to all clients.
* In the handlers read, nothing stores a position sent by the client. So a client that removes
  collision from its local level should not be able to move through a wall the server's level
  still has: it would see through it, but its soldier is moved by the server.

## What was NOT checked

* Only **2 of the ~30 queued event handlers** were read (`0x46`, `0x65`). Any of the others
  could carry a position or teleport that the server accepts. To finish: for each handler in
  the table, check whether it writes into the soldier's transform / physics body, or only
  sets inputs and triggers actions.
* The meaning of the soldier state fields and the packed state format (vtable `+0x1EC` /
  `+0x1F0`).
* The soldier physics step itself (vtable `+0x130`): whether it moves the soldier by
  velocity against Karma collision, or only resolves animation.
* An empirical test settles it fastest: edit a wall's collision in the client's level files
  only (not the level folder's top-level `*.n2`, which is CRC-checked at join, see
  `join_map_check.md`), try to cross it, and watch whether the soldier is snapped back and what
  other players see.

Tools used: `pefile` + `capstone`; helper scripts (string → xref, function disassembly,
jump-table decoding, byte-pattern search) are easy to rebuild from the steps above.
