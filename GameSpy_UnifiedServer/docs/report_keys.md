# ATLAS / Competition report keys (per player)

What every per-player key in the official dedicated server's `SubmitReport` means,
read from `Official_DedicatedServer_131.exe` (32-bit, image base 0x400000) by static
disassembly. All addresses below are **virtual addresses** (file offset = VA - 0x400000
for `.text`).

Only per-player keys exist: the server never writes game-level or team-level keys
(the only callers of the SDK value writers are in the one function below).

## Slots, keys, and who sends what

**Slot** = one of 35 counters the dedicated server keeps in its own memory for each player
during a match (headshot kills, deaths, Sniper skill, ...). Slots never leave the server.

**Key** = a numbered value in the end-of-match report the server sends to GameSpy (our mock).
When building the report, the server copies most slots into keys, but the numbers are different
(slot 6 headshot kills is sent as key 5, slot 7 body kills as key 6, ...). A few keys are not slots
at all (key 8 is always 1, key 13 is the clock). Slots 8 (deaths), 9 and 10 are counted but never
copied to any key, which is what "not reported" means.

One match, start to end:

1. **Client -> mock (Sake)**: at login the game client reads its own `PlayerStats_v1` row
   (skills, rank, qualifications, medals, ...) from our mock.
2. **Client -> dedicated server**: on joining, the client sends that profile to the server
   (`SetPlayerData`, plus the ViewMyProfile flag). The server keeps it but does not change it.
3. **Dedicated server, during the match**: the server alone counts what happens (kills, hacks,
   wins, ...) in the slots. Clients don't send stats; the server is the authority.
4. **Dedicated server -> mock (Competition `SubmitReport`)**: at the end the server turns slots
   into keys, adds a few values computed from step 2's profile (key 23 qualifications, key 24 rank,
   key 44 ViewMyProfile), and submits the report.
5. **Mock**: `config/rules.py` turns the keys into changes to each player's `PlayerStats_v1` row,
   which the client reads again at step 1 next time.

Nothing goes from the server to the client about stats; the client only sees new stats by reading
them from the mock. (This document only covers what the dedicated server sends; whether game
clients also submit reports of their own was not checked.)

## Where the report is built

| VA | What |
|---|---|
| `0x484F40` -> `0x4AE680` | SDK `scReportAddIntValue(report, key, int32)` (writes type 0) |
| `0x484F50` -> `0x4AE750` | SDK `scReportAddByteValue(report, key, byte)` (writes type 2) |
| `0x429600` | **Report builder**: loops over players, writes every key below |
| `0x428810` | `GetStat(name, slot)`: reads `int stats[35]` at player-record +0x30 (record size 0x194) |
| `0x822230` | `AddStat(name, slot, delta)`: the only writer of those 35 stat slots |

Each key is just a copy of one stat slot (or a value derived from the player's
end-of-match snapshot). The table maps key -> slot -> the game code that changes the slot.

Player classes (`0x41BD50`): 1 Trooper APGM, 2 Trooper Rifleman, 3 Trooper Demolitions,
4 Trooper Grenadier, 5 Trooper MG, 6 Sniper, 7 ABE, 8 Battle Hacker, 9 Drone,
10 Squad Leader, 11 Platoon Leader. Class -> skill slot (`0x80EA50`): PL->0, SL->1,
Sniper->3, Hacker->4, ABE->5, everything else (troopers, drone)->2.

## Key table

"Sent" = always, or only when the value is non-zero (`if (GetStat(..)) AddInt(..)` in 0x429600).

| Key | Type | Sent | Meaning (slot / evidence) | Column | Conf. |
|---|---|---|---|---|---|
| 5 | INT32 | non-zero | **Headshot kills** (slot 6). Kill handler `0x8320C2`: killer gets slot `6 + (headshot != 1)` +1 at `0x83237C`; the same flag adds ", Headshot" to the kill message at `0x83273E`. Counts team kills too. | HeadShotKills | high |
| 6 | INT32 | non-zero | **Body (non-headshot) kills** (slot 7). Same code as key 5; the 2nd kill path `0x831330` (no hit location: explosions, vehicles...) always uses slot 7 (`0x83180C`). | BodyKills | high |
| 7 | INT32 | only when won | Constant 1 when the player's result is WIN (`0x4298CC`, result code 0 computed at `0x4296C0`). | SessionsWon (== player.result) | high |
| 8 | INT32 | always | Constant 1 (`0x429846`): "played this session". | TotalSessions | high |
| 9 | INT32 | non-zero | **Team kills** (slot 11): killer and victim on same team, `0x8323B5` / `0x83184E`. Each also costs 10 class-skill points (see 14-19). | FriendlyFireKills | high |
| 10 | INT32 | non-zero | **Won as Platoon Leader** (slot 12): end of match `0x82965B`, class 11 on the winning team. | SessionsWonAsPLeader | high |
| 11 | INT32 | non-zero | **Won as Squad Leader** (slot 13): `0x8295D6`, class 10 on the winning team. | SessionsWonAsSLeader | high |
| 12 | INT32 | non-zero | **Successful hacks** (slot 14): hack handler `0x828B5F`, Battle Hacker (class 8) hacks an enemy-team object, +1 per hack (`0x828D7E`). | SuccessfulHacks | high |
| 13 | INT32 | always | Server clock (nTimeServer, whole seconds) when the end-of-match player snapshot is taken: `0x82B520` stores its time argument at record +0xF0; callers `0x82CFD1` / `0x82DFDB` pass `(int)nTimeServer::GetTime()`. Same value for everyone present at the end (49 / 49 in the test match). It is NOT "time since this player joined"; it is only match length if the clock restarts per level. | TotalTimePlayed (approx.) | medium |
| 14 | INT32 | always | **Trooper skill** this match (slot 2), can be negative. | SkillByTrooper | high |
| 15 | INT32 | always | **Hacker skill** (slot 4). | SkillByHacker | high |
| 16 | INT32 | always | **Sniper skill** (slot 3). | SkillBySniper | high |
| 17 | INT32 | always | **Platoon Leader skill** (slot 0). | SkillByPlatoonLeader | high |
| 18 | INT32 | always | **Squad Leader skill** (slot 1). | SkillBySquadLeader | high |
| 19 | INT32 | always | **ABE skill** (slot 5). | SkillByABE | high |
| 20 | INT32 | always | **Highest hack level** this match (slot 15): set to the hacked object's level byte (+0x3E8) when higher (`0x828C2D`..`0x828C7E`). | HighestLevelHacked (keep max) | high |
| 21 | INT32 | always | **Kills this match** = slot 6 + slot 7 (`0x4298A1`), i.e. key5 + key6 incl. team kills. | MostKillsInSession (keep max) | high |
| 23 | BYTE | only if known | **Qualifications bitmask after this match** (record +0x118, sent only when >= 0, i.e. the client sent a real value, `0x429D27`). Bits (`0x82A720` table): 0x01 trooper classes, 0x02 Sniper, 0x04 ABE, 0x08 Battle Hacker, 0x10 Squad Leader, 0x20 Platoon Leader (Drone: none). A bit is earned by playing that class in a match with >= 1 kill and 0 team kills (`0x82949B`..`0x829536`). | Qualifications | high |
| 24 | BYTE | always | **Rank the server computed** with the official formula `0x80EAB0(currentRank, qualifications, TotalSkill, SkillBySquadLeader, SkillByPlatoonLeader)` using the profile values the client sent at join plus this match's skills (`0x4297CA`..`0x4297FD`). See "Official rank formula". | (Rank - do not trust while the inputs are wrong) | high |
| 25 | INT32 | non-zero | **MVP**: +1 for the single player with the highest skill total of the match (sum of slots 0-5), no tie, > 0 (`0x82A68D`..`0x82A6E9`). | MostValuablePlayer | high |
| 26 | INT32 | non-zero | **Medal tier 1** (slot 17): no team kills, >= 8 players on the enemy team, and kills*100/(X+1)/enemyCount > 34.9 (`0x829AB5`..`0x829BB2`; X = server field +0x45C). | DistinguishedServiceMedal | medium (name) |
| 27 | INT32 | non-zero | **Medal tier 2** (slot 18): every 15th tier-1 medal (`0x829CB7`..`0x829D19`). | ExceptionalServiceMedal | medium (name) |
| 28 | INT32 | non-zero | **Medal tier 3** (slot 19): every 30th tier-1 medal (`0x829D42`..`0x829DA0`). | MedalOfValor | medium (name) |
| 29 | INT32 | non-zero | **Hacks of a level > 0** (slot 20, `0x828CA6`); each also gives +1 Hacker skill. | MasterHackerAward | medium |
| 30 | INT32 | non-zero | **Sniper-rifle headshot kills** (slot 21): weapon flag 4/8 and headshot flag (`0x825163`..`0x825180`). | MasterSniperAward | medium |
| 31 | INT32 | non-zero | Platoon Leader on the winning team, still connected at the end (slot 22, `0x829E99`..`0x82A049`). | GiftedLeaderAward | medium |
| 32 | INT32 | non-zero | Kills with **handgun** (slot 24). | HandGunMaster | high |
| 33 | INT32 | non-zero | Kills with **assault rifle** (slot 25). | AssaultRifleMaster | high |
| 34 | INT32 | non-zero | Kills with **machine gun** (Ultimax-100, M244 LMG, HK MG4) (slot 26). | MachineGunMaster | high |
| 35 | INT32 | non-zero | Kills with **grenade launcher** (slot 27). | GrenadeLauncherMaster | high |
| 36 | INT32 | non-zero | Kills with **sniper rifle** (slot 28). | SniperRifleMaster | high |
| 37 | INT32 | non-zero | Kills with **guided missile** on foot (slot 29). | ShoulderMissileMaster | high |
| 38 | INT32 | non-zero | Kills with **spider charge** (slot 30). | SpiderChargeMaster | high |
| 39 | INT32 | non-zero | Kills with **frag grenade** (slot 31). | HandGrenadeMaster | high |
| 40 | INT32 | non-zero | Kills with **hammer** (slot 32). | SledgeHammerMaster | high |
| 41 | INT32 | non-zero | Kills by **kick / punch** (slot 33). | Hand2HandMaster | high |
| 42 | INT32 | non-zero | Kills with **ABE / vehicle weapons** (heavy MG, autocannon, mounted GL, rocket, lock-on missile, demolition hammer, guided missile fired as ABE) (slot 34). | AbePlatformMaster | high |
| 44 | BYTE | always | The player's **ViewMyProfile** flag (record +0x164 <- profile +0x6C <- player info +0x100, set by `SetPlayerProfileView` `0x821632`, copied in `SetPlayerData` `0x83338D`). Not a stat. | none (ignore) | high |
| 45 | INT32 | non-zero | Squad Leader on the winning team, still connected at the end (slot 23, `0x82A12A`..`0x82A33B`). | GiftedSquadLeaderAward | medium |

Keys 22 and 43 are never written by the dedicated server. Slot 8 (deaths, `0x8321DB` / `0x831791`) and slots 9, 10
exist but are **not reported**, so deaths cannot be tracked from the report.

### Profile-update report (sent by the client, not the server)

The profile page's **Update** button (client `RisingEagle.exe`, handler around `0x6E97C8`) does not
write the clan tag through Sake. The client opens its **own** Competition session and submits a
one-player report (team result DRAW) with only these keys:

| Key | Type | Meaning |
|---|---|---|
| 43 | STRING | the player's nick |
| 44 | BYTE | "Allow others to view my profile" checkbox |
| 46 | STRING | **clan tag** (`PlayerClanNameTag`) |

Match reports always carry key 8 (constant 1) and never 43/46, so `rising2/comp.py`
(`is_profile_report`) tells them apart. A profile report is not a played session and does not go
through `rules.py`: the clan tag and ViewMyProfile are stored in the player's PersonalInfo record
(only for the certificate's own profile), are the same in every season, and are copied into every
`PlayerStats_v1` row. The leaderboard asks for both columns (ViewMyProfile as an int).

### Weapon kill details (`0x824FC0`)

Only kills of an enemy-team soldier count (`0x8250AF`). Weapon flag -> slot
(flag names from the kill-message function `0x80F110`):

| Flag | Weapon | Slot / key |
|---|---|---|
| 0x1 | assault rifle; machine gun if the weapon is "Ultimax-100"/"M244 LMG"/"HK MG4" | 25/33; 26/34 |
| 0x2 | handgun | 24/32 |
| 0x4, 0x8 | sniper rifle (+ slot 21/key 30 on headshot) | 28/36 |
| 0x200, 0x800 | grenade launcher | 27/35 |
| 0x2000 | guided missile (as ABE class: slot 34) | 29/37 |
| 0x80000 | spider charge | 30/38 |
| 0x8000 | frag grenade | 31/39 |
| 0x20000 | hammer | 32/40 |
| 0x8000000, 0x10000000, 0x20000000 | kick, kick, punch | 33/41 |
| 0x10-0x100, 0x400, 0x1000, 0x4000, 0x40000 | heavy MG, autocannon, mounted GL, rocket, lock-on missile, demolition hammer | 34/42 |
| 0x800000, 0x4000000 | air strike, 2nd handgun type | not counted |

### Class skill (keys 14-19) changes

| Event | Change | Where |
|---|---|---|
| Kill an enemy | +2 to the killer's class skill | `0x8323C5`..`0x8323FE`, `0x831858`..`0x831891` |
| Team kill | -10 to the killer's class skill | same |
| Team won | +1 (Squad / Platoon Leader: +2) | `0x829578`, `0x8295E0`, `0x829667` |
| Team lost (there was a winner) | -1 | `0x8296A4` |
| Hack of level > 0 | +1 Hacker skill | `0x828CB1` |
| Conquest victory point captured | +1 to each capturing soldier's class skill | `0x82A750` (called from the victory-point code `0x43ECDA`) |

Test match check: winner (Squad Leader, 1 headshot kill with an assault rifle, won)
gets SL skill 2 + 1 + 1 = **4** (key 18), key 5/21/33 = 1, key 11/45 = 1, key 25 (MVP) = 1.
Loser (trooper, lost) gets trooper skill **-1** (key 14). This matches the real report exactly.

## Official rank formula (`0x80EAB0`)

The exe has the original rank rule. The client uses it too: after loading
PlayerStats_v1 it recomputes `Rank` from the skills (`0x4866BD`) and shows that.
Arguments: current rank r (0-8, makes promotions stick: lower thresholds when demoting),
qualification bits q, TotalSkill T, SkillBySquadLeader S, SkillByPlatoonLeader P.
For a new player (r = 0):

| Rank | Needs |
|---|---|
| 0 Pvt | T < 300 |
| 1 PFC | T >= 300 |
| 2 Cpl | T >= 600 (or q has 0x10 Squad Leader qual.: at least Cpl) |
| 3 Sgt | T >= 1000 (or q has 0x20 Platoon Leader qual.: at least Sgt) |
| 4 GS | T >= 2000 |
| 5 MC | T >= 3000 |
| 6 Lt | T >= 4000 and (S >= 500 or P >= 500) |
| 7 Cpt | T >= 6000 and (S >= 1000 or P >= 1000) |
| 8 Mjr | T >= 10000 and P >= 2000 |

With a higher current rank the lower thresholds drop (e.g. r=8 keeps PFC from T>=100,
Cpl 350, Sgt 650, GS 1100, MC 2100, Lt 3200, Cpt 4200, ...). TotalSkill here is the
sum of the six class skills (prior TotalSkill + keys 14..19, floored at 0, `0x4297B0`).

## Things this explains / problems found

* **Key 24 = 3 for both players in the test match**: the client sends `Qualifications`
  as one byte read from the Sake value union (`0x486372`: `mov al, byte ptr [ebp+8]`).
  Our server declares `Qualifications` as `asciiStringValue`, so the client takes the
  low byte of a string pointer (or keeps the default 0xFF when absent, `0x40164E`).
  0xFF has bit 0x20 set -> "Platoon Leader qualified" -> rank floor 3. Fix: serve
  `Qualifications` as an integer type (intValue, default 0), and store key 23 in it.
* The client derives the displayed rank from TotalSkill/SkillBySquadLeader/
  SkillByPlatoonLeader with the table above. `config/rules.py` therefore uses an exact copy
  of this function (`official_rank`, checked against the exe code in an emulator: 308,672
  input combinations, 0 differences) and does custom ranking only through TotalSkill
  (`total_skill_change`).
* Deaths are not in the report; BestSessionScore has no key (the server never computes
  a "score" other than the class skills).

## All 35 slots the server counts

Every slot, who changes it (the `AddStat` call sites, `0x822230`), and how the report builder
`0x429600` turns it into a key.

**Patching hint** (a long shot, for changing which slot a key carries): in the report builder each
key reads its slot with `push <slot>` (`6A xx`, 2 bytes) before `call 0x428810`. The "slot push"
column gives the VA of that instruction; the slot number is the byte at VA+1 (file offset =
VA - 0x400000 + 1). Keys sent "only when non-zero" read the slot twice (test, then value), so both
pushes must be changed. Slots 8, 9, 10 have no key, so their numbers can be put in a key's
pushes to send them (e.g. slot 8 = deaths).

| Slot | What it counts | Changed at (VA) | Key | Slot push(es) in 0x429600 |
|---|---|---|---|---|
| 0 | Platoon Leader skill | kills `0x8323FE` `0x831891`; win/loss `0x82957E` `0x8295E6` `0x82966D` `0x8296AA`; victory point `0x82A7DA` (all through class -> slot `0x80EA50`) | 17 | `0x429CC3` |
| 1 | Squad Leader skill | same as slot 0 | 18 | `0x429CDC` |
| 2 | Trooper (and Drone) skill | same as slot 0 | 14 | `0x429D0E` |
| 3 | Sniper skill | same as slot 0 | 16 | `0x429CAA` |
| 4 | Hacker skill | same as slot 0, plus hack of level > 0 `0x828CBA` | 15 | `0x429C91` |
| 5 | ABE skill | same as slot 0 | 19 | `0x429CF5` |
| 6 | Headshot kills | `0x83237C` | 5 (and 21) | `0x429853` `0x429861` (key 21: `0x4298AB`) |
| 7 | Body kills | `0x83237C` `0x83180C` | 6 (and 21) | `0x42987A` `0x429888` (key 21: `0x4298A1`) |
| 8 | **Deaths** (victim) | `0x8321DB` `0x831791` | none | - |
| 9 | never changed | - | none | - |
| 10 | never changed | - | none | - |
| 11 | Team kills | `0x8323B5` `0x83184E` | 9 | `0x42992E` `0x42993C` |
| 12 | Won as Platoon Leader | `0x829662` | 10 | `0x4298E0` `0x4298EE` |
| 13 | Won as Squad Leader | `0x8295DB` | 11 | `0x429907` `0x429915` |
| 14 | Successful hacks | `0x828D7E` | 12 | `0x429955` `0x429963` |
| 15 | Highest hack level | `0x828C5A` `0x828C7E` | 20 | `0x429C78` |
| 16 | MVP | `0x82A6E9` | 25 | `0x42997C` `0x42998A` |
| 17 | Medal tier 1 | `0x829BB2` | 26 | `0x4299A3` `0x4299B1` |
| 18 | Medal tier 2 | `0x829D19` | 27 | `0x4299CA` `0x4299D8` |
| 19 | Medal tier 3 | `0x829DA0` | 28 | `0x4299F1` `0x4299FF` |
| 20 | Hacks of level > 0 | `0x828CA6` | 29 | `0x429A18` `0x429A26` |
| 21 | Sniper-rifle headshot kills | `0x825180` | 30 | `0x429A3F` `0x429A4D` |
| 22 | Won as PL, connected at end | `0x82A049` | 31 | `0x429A66` `0x429A74` |
| 23 | Won as SL, connected at end | `0x82A33B` | 45 | `0x429A8D` `0x429A9B` |
| 24 | Handgun kills | `0x82510D` | 32 | `0x429AB4` `0x429AC2` |
| 25 | Assault rifle kills | `0x8251FC` | 33 | `0x429ADB` `0x429AE9` |
| 26 | Machine gun kills | `0x825231` | 34 | `0x429B02` `0x429B10` |
| 27 | Grenade launcher kills | `0x8252BC` | 35 | `0x429B29` `0x429B37` |
| 28 | Sniper rifle kills | `0x825140` | 36 | `0x429B50` `0x429B5E` |
| 29 | Guided missile kills | `0x82532F` | 37 | `0x429B77` `0x429B85` |
| 30 | Spider charge kills | `0x8253F8` | 38 | `0x429B9E` `0x429BAC` |
| 31 | Frag grenade kills | `0x8253B3` | 39 | `0x429BC5` `0x429BD3` |
| 32 | Hammer kills | `0x825382` | 40 | `0x429BEC` `0x429BFA` |
| 33 | Kick / punch kills | `0x82542D` | 41 | `0x429C13` `0x429C21` |
| 34 | ABE / vehicle weapon kills | `0x82527D` | 42 | `0x429C3A` `0x429C48` |

Keys that are not slots: 7 (won, `0x4298CC`), 8 (constant 1, `0x429846`), 13 (clock, `0x429C61`),
23 / 24 / 44 (bytes from the player's profile, `0x429D27` / `0x429D4A` / `0x429D5D`).
