"""
Rising2 stats rules - THE place where match reports become player stats.

This file is reloaded automatically when you save it (no restart needed).
To apply changed rules to games that were already played:
    docker compose exec rising2 python -m rising2.admin rebuild --yes

How it works
------------
After every match the official dedicated server sends a report. For every
player in it, on_player(report, player, row) is called:

    player.keys      {key_id: value}  the raw numbers the game sent (ids 5..45),
                                      meaning unknown until you map them here
    player.key(5)    value of key 5, or 0 if the game did not send it
    player.result    "WIN" / "LOSS" / "DRAW" / "DISCONNECT" / "DESYNC" / "NONE"
    player.team      team id
    player.nick, player.profileid     (profileid is None if the player could not be matched)

    report.id, report.status ("COMPLETE" / "PARTIAL" / "BROKEN")
    report.game      {key_id: value}  game-wide keys (map, duration, ...)
    report.teams     [team.keys, team.result, ...]
    report.players   all players

    row              this player's PlayerStats_v1 row (what the game client shows).
                     Change it in place. Column names are the ones the client asks
                     for, e.g. row["HeadShotKills"]. A new column name you set here
                     becomes available to the client too.

Then on_report(report, rows) runs once with rows = {profileid: row} for things
that compare players (MVP, best score of the match, ...).

Helpers: add(row, col, n)  keep_max(row, col, n)  keep_min(row, col, n)
         rank_from_xp(xp, RANK_THRESHOLDS)

Missing stats
-------------
Every report key that this file never reads (and that is not in IGNORED_KEYS)
is written to config/missing/report_key_<id>.log after each match, and every
column the client asks for that no row has is written to
config/missing/sake_column_<table>.<column>.log.
"""
from rising2.rules_api import add, keep_max, keep_min, rank_from_xp  # noqa: F401

# Report key ids you looked at and decided not to use. They stop showing up in config/missing/.
IGNORED_KEYS = set()          # e.g. {12, 13}
IGNORED_GAME_KEYS = set()
IGNORED_TEAM_KEYS = set()

# If one of the report keys turns out to carry the player's profileid, put its id here.
# Players are then matched by it instead of by certificate / IP.
PROFILE_ID_KEY = None

# Only count fully finished games? (status COMPLETE). False = also PARTIAL / BROKEN games.
ONLY_COMPLETE_GAMES = False

XP_PER_MATCH = 10
XP_WIN = 20
XP_DRAW = 5
XP_LOSS = 0

# [xp needed, Rank value]. The game guide says ranks go from Private to Major; the
# exact numbers the client expects are a guess - try them with
#   python -m rising2.admin set <nick> Rank <n>
RANK_THRESHOLDS = [(0, 1), (100, 2), (250, 3), (500, 4), (1000, 5), (2000, 6), (4000, 7), (8000, 8)]


def on_player(report, player, row):
    add(row, "TotalSessions", 1)

    xp = XP_PER_MATCH
    if player.result == "WIN":
        add(row, "SessionsWon", 1)
        xp += XP_WIN
    elif player.result == "DRAW":
        xp += XP_DRAW
    elif player.result == "LOSS":
        xp += XP_LOSS

    # ---- map report keys to columns here, examples (key ids are made up) ----
    # add(row, "HeadShotKills", player.key(5))              # total over all games
    # keep_max(row, "MostKillsInSession", player.key(6))    # best single game
    # add(row, "SkillBySniper", player.key(7))
    # xp += player.key(8)                                   # key 8 = score of this match
    # if row["HeadShotKills"] >= 100:
    #     row["MasterSniperAward"] = 1                      # award if the client doesn't do it itself

    add(row, "TotalSkill", xp)
    row["Rank"] = rank_from_xp(row["TotalSkill"], RANK_THRESHOLDS)


def on_report(report, rows):
    # Example: count an MVP for the player with the highest key 8 this match
    # best = max(report.players, key=lambda p: p.key(8), default=None)
    # if best and best.profileid in rows:
    #     add(rows[best.profileid], "MostValuablePlayer", 1)
    pass
