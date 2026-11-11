"""Admin / debugging CLI (works on the same SQLite files, server may keep running).

  python -m rising2.admin users
  python -m rising2.admin stats <nick>
  python -m rising2.admin set <nick> <Column> <value>     e.g.  set Bob Rank 3
  python -m rising2.admin add-xp <nick> <amount>
  python -m rising2.admin reports [N]
  python -m rising2.admin report <id>
  python -m rising2.admin keys [nick]                     raw report key totals per player
  python -m rising2.admin rebuild --yes                   wipe all player stats and re-run config/rules.py
                                                          over every stored report (oldest first).
                                                          A JSON backup of the old stats is written first;
                                                          manual 'set' / 'add-xp' changes are NOT replayed.

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
from .rules_api import rank_from_xp
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


def _report_players(ctx, rid: int) -> list[dict]:
    players = []
    for p in ctx.db.stats.q("SELECT * FROM comp_report_players WHERE report_id=? ORDER BY idx", (rid,)):
        keys = {int(d["key"]): d["value"] for d in json.loads(p["keys_json"] or "[]")}
        players.append({"idx": p["idx"], "ccid": p["ccid"], "profileid": p["profileid"], "nick": p["nick"],
                        "team": p["team"], "result": p["result"], "keys": keys})
    return players


def rebuild(ctx) -> None:
    st = ctx.db.stats
    old = st.q("SELECT * FROM player_stats")
    backup = os.path.join(os.path.dirname(os.path.abspath(Config.STATS_DB)),
                          f"player_stats_backup_{time.strftime('%Y%m%d-%H%M%S')}.json")
    with open(backup, "w", encoding="utf-8") as f:
        json.dump(old, f, indent=1)
    print(f"backup of {len(old)} player row(s): {backup}")
    st.x("DELETE FROM player_stats")
    reports = st.q("SELECT id, parsed_json FROM comp_reports WHERE parse_ok=1 ORDER BY id")
    for r in reports:
        apply_report(ctx, r["id"], json.loads(r["parsed_json"]), _report_players(ctx, r["id"]), record_missing=False)
    log.event("STATS", "REBUILD", "INFO", f"player stats rebuilt from {len(reports)} report(s) with {ctx.rules.path}",
              backup=backup)
    print(f"rebuilt from {len(reports)} report(s) using {ctx.rules.path}")


def main(argv: list[str]) -> int:
    log.setup(console_level="WARN")  # admin actions still go to logs/rising2.log
    if not argv:
        print(__doc__)
        return 1
    ctx = _Ctx()
    cmd, args = argv[0], argv[1:]
    if cmd == "users":
        for u in ctx.db.login.all_users():
            r = player_row(ctx, u["profileid"], u["name"])
            print(f"{u['name']:<20} profileid={u['profileid']} email={u['email']} lastip={u['lastip']} "
                  f"TotalSkill={r.get('TotalSkill')} Rank={r.get('Rank')} sessions={r.get('TotalSessions')}")
    elif cmd == "stats":
        u = _user(ctx, args[0])
        print(json.dumps(player_row(ctx, u["profileid"], u["name"]), indent=2))
    elif cmd in ("set", "add-xp"):
        u = _user(ctx, args[0])
        row = player_row(ctx, u["profileid"], u["name"])
        if cmd == "set":
            col, val = args[1], args[2]
            row[col] = int(val) if val.lstrip("-").isdigit() else val
        else:
            rules = ctx.rules.get()
            row["TotalSkill"] = int(row.get("TotalSkill", 0)) + int(args[1])
            row["Rank"] = rank_from_xp(row["TotalSkill"], getattr(rules, "RANK_THRESHOLDS", [(0, 1)]))
        ctx.db.stats.put_stats(u["profileid"], u["name"], row)
        log.event("STATS", "ADMIN", "INFO", f"manual change: {' '.join(argv)}", user=u["name"], profileid=u["profileid"])
        print(json.dumps(row, indent=2))
    elif cmd == "reports":
        n = int(args[0]) if args else 20
        for r in ctx.db.stats.q("SELECT id, csid, received, submitter_ip, raw_size, parse_ok, parse_error, player_count, "
                                "applied FROM comp_reports ORDER BY id DESC LIMIT ?", (n,)):
            print(r)
    elif cmd == "report":
        r = ctx.db.stats.q1("SELECT * FROM comp_reports WHERE id=?", (args[0],))
        print(json.dumps(r, indent=2, default=str))
        for p in ctx.db.stats.q("SELECT * FROM comp_report_players WHERE report_id=?", (args[0],)):
            print(json.dumps(p, indent=2))
    elif cmd == "rebuild":
        if "--yes" not in args:
            print("This replaces ALL player stats with a fresh run of config/rules.py over every stored report.\n"
                  "Manual set/add-xp changes are lost (a JSON backup is written). Run again with --yes.")
            return 1
        rebuild(ctx)
    elif cmd == "keys":
        sql, a = "SELECT * FROM player_key_totals", ()
        if args:
            sql, a = sql + " WHERE profileid=?", (_user(ctx, args[0])["profileid"],)
        for r in ctx.db.stats.q(sql + " ORDER BY profileid, key_id", a):
            print(r)
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
