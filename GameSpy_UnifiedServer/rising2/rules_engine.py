"""Loads config/rules.py (reloading it when the file changes) and runs it on reports."""
from __future__ import annotations

import copy
import importlib.util
import os
import shutil
import traceback
import types

from . import log
from .config import Config
from .rules_api import ReportView
from .stats import default_row, player_row

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RULES = os.path.join(_HERE, "defaults", "rules.py")  # copy baked into the Docker image


def rules_path() -> str:
    return Config.RULES or os.path.join(_HERE, "config", "rules.py")


class Rules:
    def __init__(self) -> None:
        self.path = rules_path()
        self.module: types.ModuleType | None = None
        self.mtime = None
        if not os.path.exists(self.path) and os.path.exists(DEFAULT_RULES):
            try:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                shutil.copyfile(DEFAULT_RULES, self.path)
                log.event("STATS", "RULES", "WARN", f"{self.path} did not exist - copied the default rules there")
            except OSError as e:
                log.event("STATS", "RULES", "ERROR", f"could not create {self.path}: {e}")
        self.get()

    def get(self) -> types.ModuleType:
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            mtime = None
        if self.module is None or mtime != self.mtime:
            self._load(mtime)
        return self.module or types.ModuleType("empty_rules")

    def _load(self, mtime) -> None:
        try:
            spec = importlib.util.spec_from_file_location("rising2_user_rules", self.path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if not hasattr(mod, "on_player"):
                raise AttributeError("rules.py has no on_player(report, player, row) function")
            action = "loaded" if self.module is None else "RELOADED (file changed)"
            self.module, self.mtime = mod, mtime
            log.event("STATS", "RULES", "INFO", f"{action} {self.path}",
                      ignored_keys=sorted(getattr(mod, "IGNORED_KEYS", set())) or None,
                      profile_id_key=getattr(mod, "PROFILE_ID_KEY", None))
        except Exception as e:
            self.mtime = mtime  # don't retry until the file changes again
            keep = "keeping the previously loaded rules" if self.module else \
                "NO rules active: reports are stored but stats are not updated (fix it, then run admin rebuild)"
            log.event("STATS", "RULES", "ERROR", f"{self.path} failed to load: {e!r} - {keep}\n{traceback.format_exc()}")


def apply_report(ctx, report_id: int, parsed: dict, players: list[dict], record_missing: bool = True) -> None:
    """players: [{idx, ccid, profileid, nick, team, result, keys:{id:value}}]"""
    rules = ctx.rules.get()
    if not hasattr(rules, "on_player"):
        log.event("STATS", "APPLY", "ERROR", f"report {report_id} not applied: no working rules.py", report=report_id)
        return
    rv = ReportView(report_id, parsed, players)

    if getattr(rules, "ONLY_COMPLETE_GAMES", False) and rv.status != "COMPLETE":
        log.event("STATS", "APPLY", "WARN", f"report {report_id} not applied: game status {rv.status} "
                  "(ONLY_COMPLETE_GAMES = True in rules.py)", report=report_id)
        return

    rows: dict[int, dict] = {}
    before: dict[int, dict] = {}
    for pv in rv.players:
        if pv.profileid:
            row = player_row(ctx, pv.profileid, pv.nick)
            before[pv.profileid] = copy.deepcopy(row)
        else:
            row = default_row(0, pv.nick or "?")  # scratch row, so missing-key detection still works
        try:
            rules.on_player(rv, pv, row)
        except Exception as e:
            log.event("STATS", "RULES", "ERROR", f"on_player crashed for #{pv.idx}: {e!r}\n{traceback.format_exc()}",
                      user=pv.nick, report=report_id, profileid=pv.profileid)
            continue
        if pv.profileid:
            rows[pv.profileid] = row
        else:
            log.event("STATS", "APPLY", "WARN", "player in report could not be matched to an account - NOT saved",
                      user=pv.nick, report=report_id, idx=pv.idx, ccid=pv.ccid,
                      keys=" ".join(f"{k}={v!r}" for k, v in dict.items(pv.keys)))

    if hasattr(rules, "on_report"):
        try:
            rules.on_report(rv, rows)
        except Exception as e:
            log.event("STATS", "RULES", "ERROR", f"on_report crashed: {e!r}\n{traceback.format_exc()}", report=report_id)

    for pid, row in rows.items():
        b = before.get(pid, {})
        ctx.db.stats.put_stats(pid, row.get("PlayerUnickName"), row)
        pv = next(p for p in rv.players if p.profileid == pid)
        changes = ", ".join(f"{c}:{b.get(c)}->{row[c]}" for c in row if b.get(c) != row[c]) or "none"
        log.event("STATS", "APPLY", "INFO", f"stats saved, result={pv.result}", user=row.get("PlayerUnickName"),
                  report=report_id, profileid=pid, changes=changes)
        if b.get("Rank") != row.get("Rank"):
            log.event("STATS", "RANKUP", "INFO", f"rank changed {b.get('Rank')} -> {row.get('Rank')}",
                      user=row.get("PlayerUnickName"), profileid=pid, xp=row.get("TotalSkill"))

    if record_missing:
        _record_missing(ctx, rules, rv, parsed)


def _record_missing(ctx, rules, rv: ReportView, parsed: dict) -> None:
    miss = ctx.missing
    ignored = set(getattr(rules, "IGNORED_KEYS", set()))
    pkey = getattr(rules, "PROFILE_ID_KEY", None)
    if pkey is not None:
        ignored.add(int(pkey))
    for pv in rv.players:
        for k, v in dict.items(pv.keys):
            if k not in rv.seen_player_keys and k not in ignored:
                miss.note("report_key", k, "player value arrives in every report but rules.py never reads it - "
                          "stored in the DB, NOT shown in game", report=rv.id, player=pv.nick, profileid=pv.profileid,
                          result=pv.result, type=_type_of(parsed, pv.idx, k), value=repr(v))
    ig = set(getattr(rules, "IGNORED_GAME_KEYS", set()))
    for k, v in dict.items(rv.game):
        if k not in rv.seen_game_keys and k not in ig:
            miss.note("report_game_key", k, "game-wide value in the report that rules.py never reads",
                      report=rv.id, value=repr(v))
    ig = set(getattr(rules, "IGNORED_TEAM_KEYS", set()))
    for t in rv.teams:
        for k, v in dict.items(t.keys):
            if k not in rv.seen_team_keys and k not in ig:
                miss.note("report_team_key", k, "team value in the report that rules.py never reads",
                          report=rv.id, team=t.idx, result=t.result, value=repr(v))


def _type_of(parsed: dict, idx: int, key: int) -> str | None:
    for p in parsed.get("players", []):
        if p.get("idx") == idx:
            for d in p.get("key_details", []):
                if d.get("key") == key:
                    return d.get("type")
    return None
