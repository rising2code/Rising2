"""config/missing/: one .log file per stat we received or were asked for but
don't know what to do with, plus _SUMMARY.txt with all of them at a glance.

  report_key_<id>.log            player key in a match report that config/rules.py never reads
  report_game_key_<id>.log       game-wide key in a report that rules.py never reads
  report_team_key_<id>.log       team key in a report that rules.py never reads
  sake_column_<table>.<col>.log  column the game client asked for that no row has
  sake_table_<table>.log         table the game client asked for that has no data at all

Delete a file (or the whole folder) once handled; it is recreated only if the
stat shows up as missing again.
"""
from __future__ import annotations

import json
import os
import re
import time

from . import log
from .config import Config

_SAFE = re.compile(r"[^A-Za-z0-9_.-]")
MAX_FILE_BYTES = 2 * 1024 * 1024


class MissingTracker:
    def __init__(self, directory: str | None = None) -> None:
        if not directory and not Config.MISSING_DIR:
            from .rules_engine import rules_path
            directory = os.path.join(os.path.dirname(os.path.abspath(rules_path())), "missing")
        self.dir = directory or Config.MISSING_DIR
        self.enabled = True
        self.state_path = os.path.join(self.dir, "_summary.json")
        self.state: dict[str, dict] = {}
        try:
            os.makedirs(self.dir, exist_ok=True)
            if os.path.exists(self.state_path):
                with open(self.state_path, encoding="utf-8") as f:
                    self.state = json.load(f)
            log.event("CORE", "MISSING", "INFO", f"missing-stat files go to {self.dir}", known=len(self.state))
        except (OSError, ValueError) as e:
            log.event("CORE", "MISSING", "ERROR", f"cannot use {self.dir}: {e} - missing stats only in the main log")
            self.enabled = False

    def note(self, kind: str, name: str, impact: str, **context) -> None:
        """kind: report_key / report_game_key / report_team_key / sake_column / sake_table"""
        item = f"{kind}_{_SAFE.sub('_', str(name))}"
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        ctx = " ".join(f"{k}={v}" for k, v in context.items() if v is not None and v != "")
        log.event("STATS", "MISSING", "WARN", f"{kind} '{name}': {impact}", file=f"missing/{item}.log", **context)
        if not self.enabled:
            return
        path = os.path.join(self.dir, item + ".log")
        try:
            new_file = not os.path.exists(path)
            if not new_file and os.path.getsize(path) > MAX_FILE_BYTES:
                os.replace(path, path + ".old")
                new_file = True
            with open(path, "a", encoding="utf-8") as f:
                if new_file:
                    f.write(f"# {kind} '{name}'\n# impact: {impact}\n# one line per occurrence, newest last\n")
                f.write(f"{now}  {ctx}\n")
            if new_file:
                self.state.pop(item, None)  # file was deleted (handled) or rotated: start counting again
            st = self.state.setdefault(item, {"kind": kind, "name": str(name), "impact": impact,
                                              "first_seen": now, "count": 0})
            st["count"] += 1
            st["last_seen"] = now
            st["last_example"] = ctx
            st["impact"] = impact
            self._write_summary()
        except OSError as e:
            log.event("STATS", "MISSING", "ERROR", f"could not write {path}: {e}")

    def _write_summary(self) -> None:
        # forget items whose .log file was deleted by the user (= handled)
        for item in list(self.state):
            if not os.path.exists(os.path.join(self.dir, item + ".log")):
                del self.state[item]
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(self.state, f, indent=1, sort_keys=True)
        lines = [
            "Rising2 - stats we don't know what to do with yet",
            f"updated {time.strftime('%Y-%m-%d %H:%M:%S')}   ({len(self.state)} item(s))",
            "Handle them in config/rules.py (or IGNORED_*), then delete the .log file.",
            "",
            f"{'item':<44} {'count':>6}  {'first seen':<19}  {'last seen':<19}  impact / last example",
            "-" * 140,
        ]
        for item, st in sorted(self.state.items()):
            lines.append(f"{item:<44} {st['count']:>6}  {st['first_seen']:<19}  {st['last_seen']:<19}  {st['impact']}")
            lines.append(f"{'':<44} {'':>6}  {'':<19}  {'':<19}  e.g. {st.get('last_example', '')}")
        with open(os.path.join(self.dir, "_SUMMARY.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
