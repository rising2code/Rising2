# Ports and protocols

Three players only:

* **Client**: the game, `RisingEagle.exe`
* **Server**: the dedicated game server, `Official_DedicatedServer_131.exe` / `DedicatedServer.exe`
* **GameSpy**: this repo, the GameSpy replacement. Its parts are written `GameSpy[part]`, e.g. `GameSpy[CDKey]`.

Sources: disassembly of the Client and Server exes (`Install_4/bin/win32`), this repo's code,
`Official Files/hosts`, and `data/logs/rising2.log`. Code addresses are in the Client exe unless
marked "Server exe".

## 1. Who listens where

| Who | Proto | Port | What |
|---|---|---|---|
| **Server** | UDP | **29023** (can be set 29023-65000) | Game traffic |
| **Server** | UDP | first free of **27900-27999** | Server's QR2 socket (heartbeats out, info queries in) |
| **Client** | UDP | **28023**, then **28024, 28025...** (Server picks it) | Game traffic |
| **Client** | TCP | random | GameSpy buddy messages from other Clients |
| GameSpy[GP login] | TCP | **29900** | Login, profile |
| GameSpy[GP search] | TCP | **29901** | Nick search, new account |
| GameSpy[Server list] | TCP | **28910** | Server list for the Client |
| GameSpy[QR2] | UDP | **27900** | Server heartbeats; "available" check |
| GameSpy[CDKey] | UDP | **29910** | CD key checks |
| GameSpy[NatNeg] | UDP | **27901** | NAT negotiation (logged only, never answered) |
| GameSpy[HTTP] | TCP | **80** | MOTD, Auth, Sake (stats), Competition (match reports) |

## 2. Who talks to whom

| From | To | Proto / port | What |
|---|---|---|---|
| Client | Server | UDP 28023+ -> 29023 | Game traffic (GameSpy GT2 + game messages) |
| Client | GameSpy[GP login] | TCP 29900 | Login |
| Client | GameSpy[GP search] | TCP 29901 | Nick check, create account |
| Client | GameSpy[Server list] | TCP 28910 | Internet server list (also tells the Client its public IP) |
| Client | LAN broadcast | UDP 27900-28000 | LAN server search |
| Client | GameSpy[QR2] | UDP 27900 | "Available" check |
| Client | Server | UDP -> 27900-27999 | Ask a listed Server for its info / ping |
| Client | GameSpy[NatNeg] | UDP 27901 | NAT negotiation (not used in practice) |
| Client | GameSpy[HTTP] | TCP 80 | MOTD, Auth (login certificate), Sake (read stats), Competition |
| Server | GameSpy[QR2] | UDP 27900-27999 -> 27900 | Heartbeats: name, map, players, `hostport` = game port |
| Server | GameSpy[GP login] | TCP 29900 | The Server logs in with its own account |
| Server | GameSpy[CDKey] | UDP 29910 | Check each joining Client's CD key; keep-alive |
| Server | GameSpy[HTTP] | TCP 80 | Auth, Competition (CreateSession, SubmitReport = ranks) |

Clients never talk to each other directly, except GameSpy buddy messages (TCP, random port).

## 3. Firewall

| Machine | Open inbound |
|---|---|
| GameSpy | TCP 80, 28910, 29900, 29901; UDP 27900, 29910 (27901 optional) |
| Server | UDP **29023** (or the port you set) and UDP **27900-27999** (so it shows in the list with ping/details). If Server and GameSpy run on the same machine, GameSpy holds 27900/27901 and the Server's QR2 lands on 27902. |
| Client | nothing |

Every Client and the Server need the `*.reagspy.com` names from `Official Files/hosts` pointing
at GameSpy's IP (for a remote test: the remote IP, not 127.0.0.1).

## 4. How a Client joins (Client <-> Server, UDP)

Library: GameSpy GT2 (reliable UDP), built into both exes. Plain UDP socket, no `SO_REUSEADDR`.

1. **Client** opens UDP **28023** and connects to **Server**:29023 (`0x5a5123`, 10 s timeout).
   The hello text carries the Client's LAN IP, the port it opened, and its public IP (from
   GameSpy[Server list]).
2. **Server** sees port 28023, so it picks a port: the first one from **28024** up that no
   Client **already in the game from the same IP** uses. It rejects the hello with message
   `0x0B` + that port (`0x5a8160`; same code in the Server exe at `0x4d897c`).
3. **Client** closes 28023, opens the given port, and connects again (`0x5a528f`).
4. **Server** finds the matching pending entry (same IP + same port written in the hello) and
   accepts: "Accepted connection from ...". No match gets reject `0x0D`.

Results:

* 1st Client from an IP ends on 28024, 2nd on 28025, ... 28023 is only used for a moment.
* The Server matches by IP + the port written **inside** the hello, not by the UDP source
  port, so home-router NAT is fine.
* The Server only skips ports of Clients **already in the game**, not ones still joining. Two
  Clients from one IP that join within one round trip both get the same port.
* Ranks: the Server only starts a Competition session (rank saving) when two players have
  **different public IPs** (Server exe `0x82cba0..0x82d03b`). Two Clients on one PC share one,
  so those matches **don't save ranks**.

## 5. GameSpy details

| Part | Notes |
|---|---|
| GameSpy[QR2] | Server calls `qr2_init(baseport 27900, "risingeaglepc")` (`0x954250`), binds the first free port of 27900-27999 on a socket separate from the game socket. GameSpy[Server list] gives Clients that port as the "query port" and `hostport` as the game port. |
| GameSpy[Server list] | TCP 28910, encrypted list. LAN search instead broadcasts `FE FD 02 00 00 00 00 00` to ports 27900-28000 (`0x437dd1`). Those are the "non-natneg packet" warnings in GameSpy's log. |
| GameSpy[QR2] available | Client sends `09 00 00 00 00 risingeaglepc` to 27900 at startup. |
| GameSpy[GP login] | Client also opens a random TCP listen port for buddy messages and tells GP its number. |
| GameSpy[CDKey] | Only the Server talks to it; the Client's key answer travels inside the game connection. Accepts every key. |
| GameSpy[NatNeg] | Names natneg1/2/3. Never answered, never needed so far: no real NatNeg packet (`FD FC 1E 66 6A B2`) seen in the logs. |
| GameSpy[HTTP] | Plain HTTP (the patched Client changed Auth from `https://` to `http://`). |

## 6. Two Clients on one PC + remote Server: why it may crash

Not proven yet. In the local test, Client, Server and GameSpy were on one PC (or one LAN):
round trips under 1 ms and **no router (NAT)** between Client and Server. A remote Server adds
both: round trips of 30-150 ms, and a home router that rewrites the Clients' addresses. Each
scenario below needs one of those two, which is why it never happened locally.

### Scenario 1: the same port is given twice (timing)

**What happens:** the Server reserves a port (28024, 28025, ...) only once a Client is **in**
the game. While Client 1 is between its first hello (28023) and its second hello (28024),
28024 still looks free. If Client 2's first hello arrives in that gap, Client 2 also gets
28024. Client 2 then can't open 28024 on the PC (Client 1 holds it, and the socket isn't
shareable) and carries on with a broken socket, so Client 2 crashes or hangs.

**Why not locally:** the gap is one round trip plus reopening a socket, under 1 ms on one PC,
so Client 2 practically can't land in it. Remotely it's 2 round trips (60-300 ms), plus GT2
resends if a packet is lost, and longer if the Server is busy loading.

**Fits if:** it only crashes when both Clients join at almost the same time (e.g. a script
starts both, or both auto-join after a map change). If it crashes even when Client 2 joins a
minute after Client 1, this is **not** it.

**Fix:**
* Simple: join one at a time. Wait until Client 1's log shows `Connection established.` before
  Client 2 joins. The Client accepts `-connect ip:port` and `-login user,pass` on the command
  line, so a launcher can start `RisingEagle.exe_DUP00.exe`, wait for that line in
  `RisingEagle.l00`, then start `..._DUP01.exe`.
* Proper: patch the Server so it also skips ports of Clients that are still joining (the
  port-pick loop at `0x5a82d0` in the Client exe; same code near `0x4d8994` in the Server exe).

### Scenario 2: the router mixes up the two Clients (NAT)

**What happens:** the Server knows each Client only by the address the router shows it: the
public IP plus a port the router picked. Both Clients start from the same local port 28023. A
router that doesn't keep port numbers (many map 28023 to 28023, some don't) may show Client 2's
hello on an outside port the Server still links to Client 1, either Client 1's old rejected
28023 connection or its live one. The Server then feeds Client 2's packets into Client 1's
connection, and the Server, Client 1 or Client 2 gets garbage and crashes.

**Why not locally:** there's no router in between. The Server sees the Clients' real addresses
(`127.0.0.1:28024`, `127.0.0.1:28025`), and those never overlap.

**Fits if:** a Wireshark capture **on the Server** (section 7) shows Client 2's packets coming
from an outside port the Server already used for Client 1. Or if it works once the router is
out of the way (VPN, section 7 step 3).

**Fix:**
* Put the Clients and the Server on one virtual LAN, e.g. Tailscale or ZeroTier (free). With no
  NAT in between, the Server sees real, distinct addresses. Good for testing alone. Real players
  each have their own router and only one Client each, so they aren't affected.
* Or give each Client its own outside address: one through the home router, the other
  through a phone hotspot or a VPN.
* Router side: a router or mode that keeps port numbers ("full cone" or "endpoint-independent"
  NAT, sometimes shown as "NAT type: open"). Depends on the router model; not always possible.

### Scenario 3: something compares the IP the Client reports with the IP the Server sees

**What happens:** each Client's hello also carries its **LAN IP** and **public IP** as text,
and the Server stores that text per player. Some Server code only runs with **2 or more
players**. One example is the rank-session check (Server exe `0x82cba0`), which compares the
players' stored text. If code like that looks a player up by the text, or compares it with the
IP the Server actually sees, it can get "not found" and crash on the empty result.

**Why not locally:** locally the LAN IP the Client reports **is** the IP the Server sees, and
the public IP from GameSpy is the same local address, so every lookup succeeds. Remotely the
Client reports `192.168.x.x` while the Server sees the router's public IP, so the text never
matches. A single remote Client doesn't hit it, because the 2+ player code never runs.

**Fits if:** it crashes when the **second player appears** or at **match start or end** (when
the rank code runs), not while joining, and the crash address (section 7 step 1) is in the
Server's player or stats code rather than the network code.

**Fix:** needs the crash address first. Then either patch that check, or make the reported text
match. The public-IP part comes from GameSpy[Server list], so GameSpy could report a value that
matches what the Server sees. Decide once the crash address is known.

## 7. How to decide and fix

Do the steps in order. Each one is cheap and rules scenarios in or out.

### Step 1: find out who crashes, and where

* Note which window dies: Client 1, Client 2, or the Server.
* Open Windows **Event Viewer** -> Windows Logs -> Application, and find the **Application
  Error** event at that time. It names the exe and gives a **fault offset**. Fault offset +
  `0x400000` = the code address in that exe (e.g. offset `0x154502` -> `0x554502`). In the
  Client exe, network code (GT2) is at `0x953000-0x957000` and join/port code at
  `0x5a4000-0x5a9000`.
* Keep the logs of the instance that crashed: `RisingEagle.l0N` for `RisingEagle.exe_DUP0N.exe`,
  `RisingEagleDS.log` for the Server, and GameSpy's `data/logs/rising2.log`.

| Crash in... | Points to |
|---|---|
| Client 2, while joining, in network/join code | Scenario 1 (or 2) |
| Server or Client 1, when Client 2 joins | Scenario 2 |
| Server, when the 2nd player appears or at match start/end, in game/stats code | Scenario 3 |

### Step 2: timing test (Scenario 1)

Join with Client 1, wait until it's in the game, wait a minute, then join with Client 2.

* No crash -> **Scenario 1**. Fix: join one at a time (scripted launcher), or patch the Server.
* Still crashes -> not Scenario 1. Go on.

### Step 3: take the router out (Scenario 2)

Connect the same two Clients to the same remote Server, but with no NAT in between: install
Tailscale or ZeroTier on the Client PC and the Server machine, and join the Server at its VPN
address. The GameSpy names in `hosts` can stay as they are.

* No crash -> **Scenario 2**. Fix: VPN for testing alone (or two outside addresses).
* Still crashes -> **Scenario 3**. The crash address from step 1 says where to patch.

### Step 4: confirm with Wireshark (any scenario)

Wireshark Portable is in `ALL_FILES/11_EXTRA` (it needs npcap from the same folder). Capture on
**both** ends if you can, the Client PC and the Server machine.

Filter on the Client PC:

```
udp portrange 28023-28100 or udp port 29023
```

Filter on the Server:

```
udp port 29023
```

What to look for:

| You see | Means |
|---|---|
| Two replies from the Server containing `0b 78 6d 00 00` (the "use port 28024" message; `78 6d` = 28024). Filter: `udp contains 0b:78:6d:00:00` | **Scenario 1**: the same port given twice |
| One reply with `0b 78 6d 00 00` and one with `0b 79 6d 00 00` (28025) | The port handout was fine: not Scenario 1 |
| On the Server: Client 2's packets arrive from the same public IP **and the same outside port** the Server used for Client 1 | **Scenario 2** |
| On the Server: two different outside ports, both join fine, the crash comes later | **Scenario 3** |
| A Server reply to Client 2 containing `0d` (the "no match" reject) | Client 2's second hello didn't match its pending entry: the router or the reported text changed between the two hellos (Scenario 2 or 3) |

### Summary

| Scenario | Decided by | Quick fix | Proper fix |
|---|---|---|---|
| 1. Same port twice | Step 2 timing test | Join one at a time | Patch the Server to also skip ports of Clients still joining |
| 2. Router mixes up Clients | Step 3 VPN test | Tailscale/ZeroTier, or 2 outside addresses | Router with port-keeping NAT |
| 3. Reported vs seen IP | Steps 1 + 4 | - | Patch the check at the crash address, or have GameSpy report a matching IP |
