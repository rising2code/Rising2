"""config/missing/: one .log file per stat we received or were asked for but
don't know what to do with. A missing stat only appends one line to its file.

  report_key_<id>.log            player key in a match report that config/rules.py never reads
  report_game_key_<id>.log       game-wide key in a report that rules.py never reads
  report_team_key_<id>.log       team key in a report that rules.py never reads
  sake_column_<table>.<col>.log  column the game client asked for that no row has
  sake_table_<table>.log         table the game client asked for that has no data at all

Delete a file (or the whole folder) once handled; it is recreated only if the
stat shows up as missing again.
"""
from __future__ import annotations

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
        try:
            os.makedirs(self.dir, exist_ok=True)
            log.event("CORE", "MISSING", "INFO", f"missing-stat files go to {self.dir}")
        except OSError as e:
            log.event("CORE", "MISSING", "ERROR", f"cannot use {self.dir}: {e} - missing stats only in the main log")
            self.enabled = False

    def note(self, kind: str, name: str, impact: str, **context) -> None:
        """kind: report_key / report_game_key / report_team_key / sake_column / sake_table"""
        item = f"{kind}_{_SAFE.sub('_', str(name))}"
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
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {ctx}\n")
        except OSError as e:
            log.event("STATS", "MISSING", "ERROR", f"could not write {path}: {e}")

    def items(self) -> dict[str, dict]:
        """Current missing items, read from the folder (for /rising2/missing)."""
        out: dict[str, dict] = {}
        try:
            names = sorted(n for n in os.listdir(self.dir) if n.endswith(".log"))
        except OSError:
            return out
        for n in names:
            try:
                with open(os.path.join(self.dir, n), encoding="utf-8") as f:
                    lines = [ln.rstrip("\n") for ln in f if ln.strip()]
            except OSError:
                continue
            entries = [ln for ln in lines if not ln.startswith("#")]
            impact = next((ln[len("# impact: "):] for ln in lines if ln.startswith("# impact: ")), "")
            out[n[:-4]] = {"count": len(entries), "impact": impact,
                           "first": entries[0] if entries else None, "last": entries[-1] if entries else None}
        return out
