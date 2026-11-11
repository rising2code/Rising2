"""Loads the stats rules and runs them on reports.

Rules for a season = config/rules.py, then config/seasons/<season>.py run on top of it
(anything the season file defines replaces the rules.py version, e.g. total_skill_change).
The active season is the first line of config/seasons/current.txt. Missing season file ->
rules.py alone; missing / empty current.txt -> Config.DEFAULT_SEASON. Every file is
re-read when it changes (no restart needed).
"""
from __future__ import annotations

import copy
import os
import re
import shutil
import traceback
import types

from . import log
from .config import Config
from .rules_api import ReportView
from .stats import default_row, player_row

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RULES = os.path.join(_HERE, "defaults", "rules.py")  # copy baked into the Docker image
SEASON_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_UNREAD = object()


def rules_path() -> str:
    return Config.RULES or os.path.join(_HERE, "config", "rules.py")


def _mtime(path: str | None):
    try:
        return os.path.getmtime(path) if path else None
    except OSError:
        return None


class Rules:
    def __init__(self) -> None:
        self.path = rules_path()
        self.seasons_dir = Config.SEASONS_DIR or os.path.join(os.path.dirname(self.path), "seasons")
        self.current_file = os.path.join(self.seasons_dir, "current.txt")
        self._modules: dict[str, tuple[tuple, types.ModuleType | None]] = {}  # season -> (file mtimes, module)
        self._current_mtime = _UNREAD
        self._current = Config.DEFAULT_SEASON
        if not os.path.exists(self.path) and os.path.exists(DEFAULT_RULES):
            try:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                shutil.copyfile(DEFAULT_RULES, self.path)
                log.event("STATS", "RULES", "WARN", f"{self.path} did not exist - copied the default rules there")
            except OSError as e:
                log.event("STATS", "RULES", "ERROR", f"could not create {self.path}: {e}")
        self.get()

    # ---- seasons -------------------------------------------------------------
    def current_season(self) -> str:
        """The active season: first line of current.txt (re-read when the file changes)."""
        mtime = _mtime(self.current_file)
        if mtime == self._current_mtime:
            return self._current
        first = self._current_mtime is _UNREAD
        season, why, level = Config.DEFAULT_SEASON, f"no {self.current_file}, using the default", "INFO"
        if mtime is not None:
            try:
                with open(self.current_file, encoding="utf-8") as f:
                    lines = [ln.strip() for ln in f if ln.strip() and not ln.strip().startswith("#")]
                if lines and SEASON_NAME.match(lines[0]):
                    season, why = lines[0], f"from {self.current_file}"
                elif lines:
                    why, level = (f"INVALID season name {lines[0]!r} in {self.current_file} "
                                  "(letters, digits, _ . - only), using the default"), "ERROR"
                else:
                    why = f"{self.current_file} names no season, using the default"
            except OSError as e:
                why, level = f"could not read {self.current_file}: {e}, using the default", "ERROR"
        changed = season != self._current
        self._current_mtime, self._current = mtime, season
        if first or changed or level == "ERROR":
            f = self.season_file(season)
            log.event("STATS", "SEASON", level,
                      ("current season" if first or not changed else "SEASON CHANGED to") + f" '{season}' ({why})",
                      season_rules=f"rules.py + {f}" if os.path.exists(f) else "rules.py alone (no season file)")
        return season

    def season_file(self, season: str) -> str:
        return os.path.join(self.seasons_dir, f"{season}.py")

    # ---- rules -----------------------------------------------------------------
    def get(self, season: str | None = None) -> types.ModuleType:
        """The rules module for `season` (default: the current season)."""
        season = season or self.current_season()
        sfile = self.season_file(season) if SEASON_NAME.match(season) else None
        sig = (_mtime(self.path), _mtime(sfile))
        cached = self._modules.get(season)
        if cached is None or cached[0] != sig:
            self._load(season, sfile, sig, cached[1] if cached else None)
        return self._modules[season][1] or types.ModuleType("empty_rules")

    def _load(self, season: str, sfile: str | None, sig: tuple, previous) -> None:
        files = [self.path] + ([sfile] if sig[1] is not None else [])
        try:
            mod = types.ModuleType("rising2_rules_" + re.sub(r"\W", "_", season))
            mod.__file__ = files[-1]
            mod.SEASON = season
            mod.SEASON_FILE = sfile if sig[1] is not None else None
            for path in files:  # rules.py first, then the season file on top of it
                with open(path, encoding="utf-8") as f:
                    exec(compile(f.read(), path, "exec"), mod.__dict__)
            if not hasattr(mod, "on_player"):
                raise AttributeError("no on_player(report, player, row) function")
            action = "loaded" if previous is None else "RELOADED (file changed)"
            self._modules[season] = (sig, mod)
            log.event("STATS", "RULES", "INFO", f"{action} rules for season '{season}': " + " + ".join(files),
                      ignored_keys=sorted(getattr(mod, "IGNORED_KEYS", set())) or None,
                      profile_id_key=getattr(mod, "PROFILE_ID_KEY", None))
        except Exception as e:
            self._modules[season] = (sig, previous)  # don't retry until a file changes again
            keep = "keeping the previously loaded rules" if previous else \
                "NO rules active: reports are stored but stats are not updated (fix it; reports that arrive meanwhile are not counted)"
            log.event("STATS", "RULES", "ERROR", f"rules for season '{season}' failed to load ({' + '.join(files)}): "
                      f"{e!r} - {keep}\n{traceback.format_exc()}")


def apply_report(ctx, report_id: int, parsed: dict, players: list[dict], season: str) -> None:
    """players: [{idx, ccid, profileid, nick, team, result, keys:{id:value}}]. Stats go to `season`."""
    rules = ctx.rules.get(season)
    if not hasattr(rules, "on_player"):
        log.event("STATS", "APPLY", "ERROR", f"report {report_id} not applied: no working rules for season '{season}'",
                  report=report_id, season=season)
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
            row = player_row(ctx, pv.profileid, pv.nick, season)
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
        ctx.db.stats.put_stats(season, pid, row.get("PlayerUnickName"), row)
        pv = next(p for p in rv.players if p.profileid == pid)
        changes = ", ".join(f"{c}:{b.get(c)}->{row[c]}" for c in row if b.get(c) != row[c]) or "none"
        log.event("STATS", "APPLY", "INFO", f"stats saved, result={pv.result}", user=row.get("PlayerUnickName"),
                  report=report_id, season=season, profileid=pid, changes=changes)
        if b.get("Rank") != row.get("Rank"):
            log.event("STATS", "RANKUP", "INFO", f"rank changed {b.get('Rank')} -> {row.get('Rank')}",
                      user=row.get("PlayerUnickName"), season=season, profileid=pid,
                      total_skill=row.get("TotalSkill"))

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
