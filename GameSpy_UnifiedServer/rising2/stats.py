"""PlayerStats_v1 rows (what the game client reads through Sake).

The logic that changes them lives in config/rules.py (see rules_engine.py).
"""
from __future__ import annotations

from .db import PROFILE_ID_OFFSET

# Column -> Sake value type, as the old mock served them (game accepted these).
PLAYERSTATS_COLUMNS: dict[str, str] = {
    "ownerid": "intValue", "recordid": "intValue",
    "PlayerUnickName": "asciiStringValue", "PlayerClanNameTag": "asciiStringValue",
    "HeadShotKills": "intValue", "BodyKills": "intValue", "FriendlyFireKills": "intValue",
    "SessionsWonAsPLeader": "intValue", "SessionsWonAsSLeader": "intValue", "SuccessfulHacks": "intValue",
    "TotalTimePlayed": "intValue", "SkillByHacker": "intValue", "SkillBySniper": "intValue",
    "SkillByABE": "intValue", "HighestLevelHacked": "intValue", "MostKillsInSession": "intValue",
    "BestSessionScore": "intValue", "MostValuablePlayer": "intValue", "SkillByPlatoonLeader": "intValue",
    "SessionsWon": "intValue", "TotalSessions": "intValue", "SkillByTrooper": "intValue",
    "SkillBySquadLeader": "intValue", "GiftedLeaderAward": "intValue", "GiftedSquadLeaderAward": "intValue",
    "TotalSkill": "intValue", "Rank": "intValue",
    "HandGunMaster": "intValue", "AssaultRifleMaster": "intValue", "MachineGunMaster": "intValue",
    "GrenadeLauncherMaster": "intValue", "SniperRifleMaster": "intValue", "ShoulderMissileMaster": "intValue",
    "SpiderChargeMaster": "intValue", "HandGrenadeMaster": "intValue", "SledgeHammerMaster": "intValue",
    "Hand2HandMaster": "intValue", "AbePlatformMaster": "intValue", "MasterHackerAward": "intValue",
    "MasterSniperAward": "intValue", "Qualifications": "asciiStringValue",
}


def column_type(col: str, value) -> str:
    """Sake type for a column; columns invented in rules.py get a type from their value."""
    if col in PLAYERSTATS_COLUMNS:
        return PLAYERSTATS_COLUMNS[col]
    if isinstance(value, bool):
        return "booleanValue"
    if isinstance(value, int):
        return "intValue"
    if isinstance(value, float):
        return "floatValue"
    return "asciiStringValue"


def default_row(profileid: int, nick: str) -> dict:
    row = {c: (0 if t == "intValue" else "") for c, t in PLAYERSTATS_COLUMNS.items()}
    row.update(ownerid=profileid, recordid=profileid - PROFILE_ID_OFFSET, PlayerUnickName=nick, Rank=0)  # 0 = Pvt
    return row


def player_row(ctx, profileid: int, nick: str | None = None, season: str | None = None) -> dict:
    """The player's PlayerStats_v1 row in `season` (default: the current season).
    A player with no row in that season gets the blank new-player row."""
    stored = ctx.db.stats.get_stats(season or ctx.rules.current_season(), profileid)
    if nick is None:
        u = ctx.db.login.get_by_profileid(profileid)
        nick = u["name"] if u else (stored or {}).get("nick") or f"player{profileid}"
    row = default_row(profileid, nick)
    if stored:
        row.update(stored["data"])
    row["ownerid"] = profileid
    row["recordid"] = profileid - PROFILE_ID_OFFSET
    return row
