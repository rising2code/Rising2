"""Admin / debugging CLI (works on the same SQLite files, server may keep running).

  python -m rising2.admin seasons                         every season with data, and which one is current
  python -m rising2.admin users
  python -m rising2.admin stats <nick>
  python -m rising2.admin set <nick> <Column> <value>     e.g.  set Bob Rank 3
  python -m rising2.admin add-xp <nick> <amount>          add to TotalSkill and recompute Rank
  python -m rising2.admin reports [N]
  python -m rising2.admin report <id>
  python -m rising2.admin keys [nick]                     raw report key totals per player
  python -m rising2.admin rebuild --yes                   wipe the season's player stats and re-run its rules
                                                          (config/rules.py + config/seasons/<season>.py)
                                                          over every stored report of that season (oldest first).
                                                          A JSON backup of the old stats is written first;
                                                          manual 'set' / 'add-xp' changes are NOT replayed.
  python -m rising2.admin rebuild --yes --all-seasons     the same for every season

Stats commands work on the CURRENT season (config/seasons/current.txt); add
--season <name> to any of them for another season.

In Docker:  docker compose exec rising2 python -m rising2.admin users
"""
from __future__ import annotations

import json
import os
import sys
import time

from . import log
from .config import Config
from .db import Databases
from .missing import MissingTracker
from .rules_engine import Rules, apply_report
from .stats import player_row


class _Ctx:
    def __init__(self):
        self.db = Databases()
        self.rules = Rules()
        self.missing = MissingTracker()


def _user(ctx, nick):
    u = ctx.db.login.get_user(nick)
    if not u:
        sys.exit(f"no such user: {nick}")
    return u


def _int(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _report_players(ctx, rid: int) -> list[dict]:
    players = []
    for p in ctx.db.stats.q("SELECT * FROM comp_report_players WHERE report_id=? ORDER BY idx", (rid,)):
        keys = {int(d["key"]): d["value"] for d in json.loads(p["keys_json"] or "[]")}
        players.append({"idx": p["idx"], "ccid": p["ccid"], "profileid": p["profileid"], "nick": p["nick"],
                        "team": p["team"], "result": p["result"], "keys": keys})
    return players


def rebuild(ctx, season: str) -> None:
    st = ctx.db.stats
    old = st.q("SELECT * FROM player_stats WHERE season=?", (season,))
    backup = os.path.join(os.path.dirname(os.path.abspath(Config.STATS_DB)),
                          f"player_stats_backup_{season}_{time.strftime('%Y%m%d-%H%M%S')}.json")
    with open(backup, "w", encoding="utf-8") as f:
        json.dump(old, f, indent=1)
    print(f"season '{season}': backup of {len(old)} player row(s): {backup}")
    st.x("DELETE FROM player_stats WHERE season=?", (season,))
    reports = st.q("SELECT id, parsed_json FROM comp_reports WHERE parse_ok=1 AND season=? ORDER BY id", (season,))
    for r in reports:
        apply_report(ctx, r["id"], json.loads(r["parsed_json"]), _report_players(ctx, r["id"]), season,
                     record_missing=False)
    mod = ctx.rules.get(season)
    used = ctx.rules.path + (f" + {mod.SEASON_FILE}" if getattr(mod, "SEASON_FILE", None) else "")
    log.event("STATS", "REBUILD", "INFO", f"season '{season}': player stats rebuilt from {len(reports)} report(s) "
              f"with {used}", season=season, backup=backup)
    print(f"season '{season}': rebuilt from {len(reports)} report(s) using {used}")


def main(argv: list[str]) -> int:
    log.setup(console_level="WARN")  # admin actions still go to logs/rising2.log
    argv = list(argv)
    season_arg = None
    if "--season" in argv:
        i = argv.index("--season")
        if i + 1 >= len(argv):
            sys.exit("--season needs a season name")
        season_arg = argv[i + 1]
        del argv[i:i + 2]
    if not argv:
        print(__doc__)
        return 1
    ctx = _Ctx()
    season = season_arg or ctx.rules.current_season()
    cmd, args = argv[0], argv[1:]
    if cmd == "seasons":
        cur = ctx.rules.current_season()
        rows = {r["season"]: r for r in ctx.db.stats.seasons()}
        rows.setdefault(cur, {"season": cur, "reports": 0, "players": 0, "first_report": None, "last_report": None})
        for r in rows.values():
            sfile = ctx.rules.season_file(r["season"])
            fmt = lambda t: time.strftime("%Y-%m-%d", time.localtime(t)) if t else "-"  # noqa: E731
            print(f"{'*' if r['season'] == cur else ' '} {r['season']:<24} reports={r['reports']:<5} "
                  f"players={r['players']:<5} {fmt(r['first_report'])} .. {fmt(r['last_report'])}  "
                  f"rules: rules.py{' + ' + os.path.basename(sfile) if os.path.exists(sfile) else ''}")
        print(f"\n* = current season (set in {ctx.rules.current_file})")
    elif cmd == "users":
        print(f"season '{season}'")
        for u in ctx.db.login.all_users():
            r = player_row(ctx, u["profileid"], u["name"], season)
            print(f"{u['name']:<20} profileid={u['profileid']} email={u['email']} lastip={u['lastip']} "
                  f"TotalSkill={r.get('TotalSkill')} Rank={r.get('Rank')} sessions={r.get('TotalSessions')}")
    elif cmd == "stats":
        u = _user(ctx, args[0])
        print(json.dumps({"season": season} | player_row(ctx, u["profileid"], u["name"], season), indent=2))
    elif cmd in ("set", "add-xp"):
        u = _user(ctx, args[0])
        row = player_row(ctx, u["profileid"], u["name"], season)
        if cmd == "set":
            col, val = args[1], args[2]
            row[col] = int(val) if val.lstrip("-").isdigit() else val
        else:
            rules = ctx.rules.get(season)
            row["TotalSkill"] = max(0, _int(row.get("TotalSkill")) + int(args[1]))
            if hasattr(rules, "official_rank"):
                row["Rank"] = rules.official_rank(_int(row.get("Rank")), _int(row.get("Qualifications")),
                                                  row["TotalSkill"], _int(row.get("SkillBySquadLeader")),
                                                  _int(row.get("SkillByPlatoonLeader")))
        ctx.db.stats.put_stats(season, u["profileid"], u["name"], row)
        log.event("STATS", "ADMIN", "INFO", f"manual change: {' '.join(argv)}", user=u["name"], season=season,
                  profileid=u["profileid"])
        print(json.dumps({"season": season} | row, indent=2))
    elif cmd == "reports":
        n = int(args[0]) if args else 20
        for r in ctx.db.stats.q("SELECT id, season, csid, received, submitter_ip, raw_size, parse_ok, parse_error, "
                                "player_count, applied FROM comp_reports ORDER BY id DESC LIMIT ?", (n,)):
            print(r)
    elif cmd == "report":
        r = ctx.db.stats.q1("SELECT * FROM comp_reports WHERE id=?", (args[0],))
        print(json.dumps(r, indent=2, default=str))
        for p in ctx.db.stats.q("SELECT * FROM comp_report_players WHERE report_id=?", (args[0],)):
            print(json.dumps(p, indent=2))
    elif cmd == "rebuild":
        every = "--all-seasons" in args
        if "--yes" not in args:
            print(f"This replaces the player stats of {'EVERY season' if every else f'season {season!r}'} with a "
                  "fresh run of the rules over that season's stored reports.\n"
                  "Manual set/add-xp changes are lost (a JSON backup is written). Run again with --yes.")
            return 1
        for s in ([r["season"] for r in ctx.db.stats.seasons()] if every else [season]):
            rebuild(ctx, s)
    elif cmd == "keys":
        sql, a = "SELECT * FROM player_key_totals WHERE season=?", (season,)
        if args:
            sql, a = sql + " AND profileid=?", (season, _user(ctx, args[0])["profileid"])
        print(f"season '{season}'")
        for r in ctx.db.stats.q(sql + " ORDER BY profileid, key_id", a):
            print(r)
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
