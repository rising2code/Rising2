"""
Rising2 stats rules - THE place where match reports become player stats.

This file is reloaded automatically when you save it (no restart needed).
Changed rules count from the next match on; games already played are not re-scored.

How it works
------------
After every match the official dedicated server sends a report. For every
player in it, on_player(report, player, row) is called, and it runs three steps:

    1. default_columns()      report keys -> the plain counter columns (kills, hacks, medals, ...)
                              You will rarely need to touch this.
    2. total_skill_change()   THE SECRET SAUCE: how much TotalSkill this match is worth.
                              Seasons / crazy rules go here. Everything else follows from it.
    3. official_rank()        the game's own rank formula (copied from the exe). DON'T CHANGE IT,
                              see the warning there.

    player.keys      {key_id: value}  the raw numbers the game sent (ids 5..45),
                                      meanings (read from the server exe): docs/report_keys.md
    player.key(5)    value of key 5, or 0 if the game did not send it. Use the K.* names below.
    player.result    "WIN" / "LOSS" / "DRAW" / "DISCONNECT" / "DESYNC" / "NONE"
    player.team      team id
    player.nick, player.profileid     (profileid is None if the player could not be matched)

    report.id, report.status ("COMPLETE" / "PARTIAL" / "BROKEN")
    report.game      {key_id: value}  game-wide keys (the official server sends none)
    report.teams     [team.keys, team.result, ...]
    report.players   all players

    row              this player's PlayerStats_v1 row (what the game client shows).
                     Change it in place. Column names are the ones the client asks
                     for, e.g. row["HeadShotKills"]. A new column name you set here
                     becomes available to the client too.

Then on_report(report, rows) runs once with rows = {profileid: row} for things
that compare players (best score of the match, ...).

Seasons
-------
Every season keeps its own stats; a new season starts every player from zero.
    config/seasons/current.txt      name of the current season (default: "preseason")
    config/seasons/<season>.py      that season's rules, run ON TOP of this file: whatever
                                    it defines (usually just total_skill_change) replaces
                                    the version here, for that season only.
So this file is the default for every season, and total_skill_change() below is the
fallback when a season file does not define its own. SEASON (a string) is the season the
rules are running for. Example: config/seasons/example-pistols.py.

Helpers: add(row, col, n)  keep_max(row, col, n)  keep_min(row, col, n)

Missing stats
-------------
Every report key that this file never reads (and that is not in IGNORED_KEYS)
is written to config/missing/report_key_<id>.log after each match, and every
column the client asks for that no row has is written to
config/missing/sake_column_<table>.<column>.log.
"""
from rising2.rules_api import add, keep_max, keep_min  # noqa: F401


class K:
    """Report key ids by name (what each one means: docs/report_keys.md).
    "non-zero" keys are only sent when not 0; player.key() returns 0 for them otherwise."""
    HEADSHOT_KILLS = 5          # non-zero
    BODY_KILLS = 6              # non-zero, every kill that is not a headshot
    WON = 7                     # 1 when the player won (same as player.result == "WIN")
    PLAYED = 8                  # always 1
    TEAM_KILLS = 9              # non-zero
    WON_AS_PLATOON_LEADER = 10  # non-zero
    WON_AS_SQUAD_LEADER = 11    # non-zero
    HACKS = 12                  # non-zero, enemy objects hacked
    CLOCK_SECONDS = 13          # always, server clock at match end (see default_columns)
    SKILL_TROOPER = 14          # always, can be negative (class skill this match, see below)
    SKILL_HACKER = 15
    SKILL_SNIPER = 16
    SKILL_PLATOON_LEADER = 17
    SKILL_SQUAD_LEADER = 18
    SKILL_ABE = 19
    HIGHEST_HACK_LEVEL = 20     # always
    KILLS = 21                  # always, = HEADSHOT_KILLS + BODY_KILLS (team kills included)
    QUALIFICATIONS = 23         # BYTE, only when the client sent a real value
    SERVER_RANK = 24            # BYTE, rank the server computed itself
    MVP = 25                    # non-zero
    MEDAL_TIER1 = 26            # non-zero
    MEDAL_TIER2 = 27            # non-zero
    MEDAL_TIER3 = 28            # non-zero
    HACKS_ABOVE_LEVEL0 = 29     # non-zero
    SNIPER_HEADSHOTS = 30       # non-zero, sniper-rifle headshot kills
    PL_WIN_AWARD = 31           # non-zero
    HANDGUN_KILLS = 32          # kills per weapon, all non-zero, enemies only
    ASSAULT_RIFLE_KILLS = 33
    MACHINE_GUN_KILLS = 34
    GRENADE_LAUNCHER_KILLS = 35
    SNIPER_RIFLE_KILLS = 36
    SHOULDER_MISSILE_KILLS = 37
    SPIDER_CHARGE_KILLS = 38
    HAND_GRENADE_KILLS = 39
    HAMMER_KILLS = 40
    HAND2HAND_KILLS = 41        # kick / punch
    ABE_VEHICLE_KILLS = 42      # ABE and vehicle weapons
    VIEW_MY_PROFILE = 44        # BYTE, not a stat
    SL_WIN_AWARD = 45           # non-zero


CLASS_SKILLS = ((K.SKILL_TROOPER, "SkillByTrooper"), (K.SKILL_HACKER, "SkillByHacker"),
                (K.SKILL_SNIPER, "SkillBySniper"), (K.SKILL_PLATOON_LEADER, "SkillByPlatoonLeader"),
                (K.SKILL_SQUAD_LEADER, "SkillBySquadLeader"), (K.SKILL_ABE, "SkillByABE"))

WEAPON_KILLS = ((K.HANDGUN_KILLS, "HandGunMaster"), (K.ASSAULT_RIFLE_KILLS, "AssaultRifleMaster"),
                (K.MACHINE_GUN_KILLS, "MachineGunMaster"), (K.GRENADE_LAUNCHER_KILLS, "GrenadeLauncherMaster"),
                (K.SNIPER_RIFLE_KILLS, "SniperRifleMaster"), (K.SHOULDER_MISSILE_KILLS, "ShoulderMissileMaster"),
                (K.SPIDER_CHARGE_KILLS, "SpiderChargeMaster"), (K.HAND_GRENADE_KILLS, "HandGrenadeMaster"),
                (K.HAMMER_KILLS, "SledgeHammerMaster"), (K.HAND2HAND_KILLS, "Hand2HandMaster"),
                (K.ABE_VEHICLE_KILLS, "AbePlatformMaster"))

# Report key ids you looked at and decided not to use. They stop showing up in config/missing/.
#   7  WON          same as player.result == "WIN" (used below)
#   8  PLAYED       always 1, same as the TotalSessions +1 below
#   23 QUALIFICATIONS  not stored yet: the Qualifications column is served as a string, but the
#                      client reads it as one byte (docs/report_keys.md "problems found")
#   24 SERVER_RANK  our Rank comes from official_rank()
#   44 VIEW_MY_PROFILE  not a stat
IGNORED_KEYS = {K.WON, K.PLAYED, K.QUALIFICATIONS, K.SERVER_RANK, K.VIEW_MY_PROFILE}
IGNORED_GAME_KEYS = set()
IGNORED_TEAM_KEYS = set()

# If one of the report keys turns out to carry the player's profileid, put its id here.
# Players are then matched by it instead of by certificate / IP.
PROFILE_ID_KEY = None

# Only count fully finished games? (status COMPLETE). False = also PARTIAL / BROKEN games.
ONLY_COMPLETE_GAMES = False


# ============================================================================
# 1. DEFAULT COLUMNS - report keys straight into the counter columns
# ============================================================================
def default_columns(report, player, row):
    add(row, "TotalSessions", 1)
    if player.result == "WIN":
        add(row, "SessionsWon", 1)

    # kills
    add(row, "HeadShotKills", player.key(K.HEADSHOT_KILLS))
    add(row, "BodyKills", player.key(K.BODY_KILLS))
    add(row, "FriendlyFireKills", player.key(K.TEAM_KILLS))
    keep_max(row, "MostKillsInSession", player.key(K.KILLS))

    # leader wins and their awards (the exe counts both the same way: leader class on the winning
    # team; the award keys only if still connected at the end)
    add(row, "SessionsWonAsPLeader", player.key(K.WON_AS_PLATOON_LEADER))
    add(row, "SessionsWonAsSLeader", player.key(K.WON_AS_SQUAD_LEADER))
    add(row, "GiftedLeaderAward", player.key(K.PL_WIN_AWARD))
    add(row, "GiftedSquadLeaderAward", player.key(K.SL_WIN_AWARD))

    # hacking
    add(row, "SuccessfulHacks", player.key(K.HACKS))
    keep_max(row, "HighestLevelHacked", player.key(K.HIGHEST_HACK_LEVEL))
    add(row, "MasterHackerAward", player.key(K.HACKS_ABOVE_LEVEL0))
    add(row, "MasterSniperAward", player.key(K.SNIPER_HEADSHOTS))

    # Server clock in seconds when the end-of-match snapshot was taken (49 in the 1v1 test), the
    # same for everyone still there. Only equals time played if the clock restarts per level.
    add(row, "TotalTimePlayed", player.key(K.CLOCK_SECONDS))

    # class skills (kill +2, team kill -10, team won +1 (+2 as SL/PL), team lost -1,
    # hack of level > 0 +1). The exe floors them at 0. SkillBySquadLeader and
    # SkillByPlatoonLeader also gate the officer ranks in official_rank().
    for key, col in CLASS_SKILLS:
        add(row, col, player.key(key))
        if row[col] < 0:
            row[col] = 0
    # The report has no "score" key: the best session score is the best match class-skill total.
    keep_max(row, "BestSessionScore", sum(player.key(key) for key, _ in CLASS_SKILLS))

    add(row, "MostValuablePlayer", player.key(K.MVP))
    # medals: tier 1 = no team kills, >= 8 enemies, kills/enemies > 34.9 %;
    # tier 2 = every 15th tier 1; tier 3 = every 30th. The client reads these three column names.
    add(row, "DistinguishedServiceMedal", player.key(K.MEDAL_TIER1))
    add(row, "ExceptionalServiceMedal", player.key(K.MEDAL_TIER2))
    add(row, "MedalOfValor", player.key(K.MEDAL_TIER3))

    for key, col in WEAPON_KILLS:
        add(row, col, player.key(key))


# ============================================================================
# 2. TOTAL SKILL - the secret sauce
#
# Return how much TotalSkill this match adds (negative = takes away). TotalSkill never
# goes below 0. The rank follows from TotalSkill (plus SkillBySquadLeader /
# SkillByPlatoonLeader for the officer ranks), so this function decides who climbs.
#
# Everything is available here:
#   player.key(K.xxx)    any report key, e.g. player.key(K.HANDGUN_KILLS)
#   player.result        "WIN" / "LOSS" / ...
#   row                  the row AFTER default_columns() ran (lifetime totals incl. this match)
#   before               the row as it was BEFORE this match
#   report.players       everyone in the match (compare against others)
#
# The default is what the original game did: the sum of the six class skills of the match.
# It is the fallback for every season whose config/seasons/<season>.py does not define its own.
# ============================================================================
def total_skill_change(report, player, row, before):
    official = sum(player.key(key) for key, _ in CLASS_SKILLS)
    return official

    # ---- season ideas (move one above the return to use it) ----
    #
    # Pistol season: only handgun kills count.
    #   return 5 * player.key(K.HANDGUN_KILLS) + (2 if player.result == "WIN" else 0)
    #
    # Grenade season: frag grenades are worth triple, everything else normal.
    #   return official + 2 * 2 * player.key(K.HAND_GRENADE_KILLS)
    #
    # "No more than 5 kills": more than 5 kills in one match and the match is worth nothing.
    #   return 0 if player.key(K.KILLS) > 5 else official
    #
    # Headshots bonus: +1 per headshot on top of the normal skill.
    #   return official + player.key(K.HEADSHOT_KILLS)


# ============================================================================
# 3. OFFICIAL RANK - copied from the game (Official_DedicatedServer_131.exe 0x80EAB0)
#
#   !!!  IMPORTANT WARNING  !!!
#   The game client has its OWN copy of this exact function. After loading PlayerStats_v1
#   it recomputes the rank it shows from TotalSkill / SkillBySquadLeader /
#   SkillByPlatoonLeader / Qualifications, using the stored Rank only as "current rank".
#   If you change this function the stored Rank and what the client shows go OUT OF SYNC
#   (some screens show one, some the other), and a stored Rank outside 0..8 has no label
#   in the game and may CRASH the client. To change who gets which rank, change
#   total_skill_change() instead and leave this alone.
#
# current_rank makes promotions stick: the higher your current rank, the lower the
# thresholds to keep it. Qualification bits 0x10 (Squad Leader) / 0x20 (Platoon Leader)
# give a minimum rank of Cpl / Sgt.
#
#   Rank  Label            new player (current_rank 0) needs
#    0    Pvt  Private     TotalSkill < 300
#    1    PFC              300
#    2    Cpl  Corporal    600
#    3    Sgt  Sergeant    1,000
#    4    GS               2,000
#    5    MC               3,000
#    6    Lt   Lieutenant  4,000 and (SkillBySquadLeader or SkillByPlatoonLeader >= 500)
#    7    Cpt  Captain     6,000 and (SkillBySquadLeader or SkillByPlatoonLeader >= 1,000)
#    8    Mjr  Major       10,000 and SkillByPlatoonLeader >= 2,000
# ============================================================================
# TotalSkill needed for ranks 0..5 -> next rank, per current rank (index = current_rank)
_RANK_STEPS = (
    (300, 600, 1000, 2000, 3000, 4000),     # current rank 0
    (100, 600, 1000, 2000, 3000, 4000),     # 1
    (100, 350, 1000, 2000, 3000, 4000),     # 2
    (100, 350, 650, 2000, 3000, 4000),      # 3
    (100, 350, 650, 1100, 3000, 4000),      # 4
    (100, 350, 650, 1100, 2100, 4000),      # 5
    (100, 350, 650, 1100, 2100, 3200),      # 6
    (100, 350, 650, 1100, 2100, 3200),      # 7
    (100, 350, 650, 1100, 2100, 3200),      # 8
)


def official_rank(current_rank, qualifications, total, squad, platoon):
    """Exact copy of the game's rank function. All values are ints."""
    r = current_rank
    if not 0 <= r <= 8:
        return r                            # the game returns an unknown current rank unchanged
    if qualifications & 0x20 and total < 1000:
        return 3
    if qualifications & 0x10 and total < 600:
        return 2
    for rank, need in enumerate(_RANK_STEPS[r]):
        if total < need:
            return rank
    if r <= 5:                              # Lt needs leader skill
        if squad < 500 and platoon < 500:
            return 5
    if r <= 6:
        if total < 6000:
            return 6
        if squad < 1000 and platoon < 1000:
            return 6
        if total < 10000:
            return 7
        return 8 if platoon >= 2000 else 7
    if total < 4200:                        # current rank 7 or 8
        return 6
    if r == 7:
        if total < 10000:
            return 7
        return 8 if platoon >= 2000 else 7
    return 7 if total < 6200 else 8


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def on_player(report, player, row):
    before = dict(row)
    default_columns(report, player, row)

    add(row, "TotalSkill", total_skill_change(report, player, row, before))
    if row["TotalSkill"] < 0:
        row["TotalSkill"] = 0

    # Qualifications is a string column today (unknown -> 0 here; see IGNORED_KEYS note).
    row["Rank"] = official_rank(_int(before.get("Rank")), _int(row.get("Qualifications")),
                                _int(row["TotalSkill"]), _int(row.get("SkillBySquadLeader")),
                                _int(row.get("SkillByPlatoonLeader")))


def on_report(report, rows):
    # Example: a "top killer" count for the most kills of the match
    # best = max(report.players, key=lambda p: p.key(K.KILLS), default=None)
    # if best and best.profileid in rows:
    #     add(rows[best.profileid], "TopKiller", 1)
    pass
