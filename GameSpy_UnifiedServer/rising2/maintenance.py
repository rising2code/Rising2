"""Cleanup jobs: everything the server writes that only piles up gets deleted here.

When jobs run:
  * on every start, ALL jobs run (a restart is a cleanup)
  * then each job again every R2_JOB_<NAME>_EVERY; the time of the last run is kept in
    the stats DB (maintenance_runs), so a job that came due while the server was asleep
    or stopped runs as soon as it is back
  * key_totals also runs when the season changes

Settings per job (environment):
  R2_JOB_<NAME>_EVERY   how often, e.g. 30m, 1h, 1d (a plain number = seconds; 0 = job off)
  R2_JOB_<NAME>_KEEP    how old something may get before it is deleted, same format
  plus a few job-specific ones (R2_JOB_LOGS_MAX_MB, R2_JOB_REPORTS_KEEP_FAILED,
  R2_JOB_MISSING_LINES, R2_JOB_VACUUM_MIN_ROWS), listed in JOBS below.

Every job logs a start line, one line per table / folder it cleaned, and an end line:
  [CORE] [CLEANUP] [INFO] [#-] reports: start (startup) | keep=7d keep_failed=30d
  [CORE] [CLEANUP] [INFO] [#-] reports: comp_reports: deleted 3 row(s) | ...
  [CORE] [CLEANUP] [INFO] [#-] reports: done in 0.01s: 3 row(s), 6 file(s) deleted

The jobs run on the asyncio thread (SQLite connections are not shared across threads);
on a fan server's data each run takes milliseconds.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
import traceback

from . import log
from .config import Config

_DUR = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$", re.IGNORECASE)
_UNIT = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}

TICK = 60          # seconds between "is a job due?" checks
STARTUP_DELAY = 5  # seconds after the services are up, so the request that woke the server goes first


def parse_duration(text: str, default: float) -> float:
    m = _DUR.match(text or "")
    if not m:
        return default
    return float(m.group(1)) * _UNIT[m.group(2).lower()]


def fmt_duration(sec: float) -> str:
    if sec <= 0:
        return "0"
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if sec >= n and sec % n == 0:
            return f"{int(sec // n)}{unit}"
    return f"{int(sec)}s"


# name -> default settings. "every" and "keep" are durations, the rest numbers.
JOBS: dict[str, dict[str, str]] = {
    "logs":       {"every": "1h", "keep": "14d", "max_mb": "200"},
    "reports":    {"every": "1h", "keep": "7d", "keep_failed": "30d"},
    "missing":    {"every": "1h", "keep": "30d", "lines": "50"},
    "handshake":  {"every": "1h", "keep": "2d"},
    "logins":     {"every": "1d", "keep": "30d"},
    "key_totals": {"every": "1d"},
    "backups":    {"every": "1d", "keep": "30d"},
    "vacuum":     {"every": "1d", "min_rows": "1000"},
}
DURATION_SETTINGS = {"every", "keep", "keep_failed"}


def job_settings(name: str) -> dict[str, float]:
    out = {}
    for key, default in JOBS[name].items():
        raw = os.environ.get(f"R2_JOB_{name.upper()}_{key.upper()}", default)
        if key in DURATION_SETTINGS:
            out[key] = parse_duration(raw, parse_duration(default, 0))
        else:
            try:
                out[key] = float(raw)
            except ValueError:
                out[key] = float(default)
    return out


class JobRun:
    """Collects what one job deleted and writes its log lines."""

    def __init__(self, name: str, trigger: str, settings: dict[str, float]) -> None:
        self.name, self.trigger, self.settings = name, trigger, settings
        self.rows = 0
        self.files = 0
        self.bytes = 0
        self.t0 = time.monotonic()
        shown = {k: (fmt_duration(v) if k in DURATION_SETTINGS else f"{v:g}") for k, v in settings.items()}
        log.event("CORE", "CLEANUP", "INFO", f"{name}: start ({trigger})", **shown)

    def step(self, what: str, rows: int = 0, files: int | None = None, size: int = 0, **targets) -> None:
        """One table (rows=...) or one folder (files=..., size=...) that was cleaned."""
        self.rows += rows
        self.files += files or 0
        self.bytes += size
        if files is None:
            parts = [f"{rows} row(s)"]
        else:
            parts = [f"{files} file(s), {size / 1048576:.1f} MB"]
        log.event("CORE", "CLEANUP", "INFO", f"{self.name}: {what}: deleted {', '.join(parts)}", **targets)

    def note(self, text: str, level: str = "INFO", **targets) -> None:
        log.event("CORE", "CLEANUP", level, f"{self.name}: {text}", **targets)

    def done(self) -> str:
        summary = f"{self.rows} row(s), {self.files} file(s) deleted"
        log.event("CORE", "CLEANUP", "INFO", f"{self.name}: done in {time.monotonic() - self.t0:.2f}s: {summary}")
        return summary


def _remove(path: str) -> int:
    """Delete a file; returns its size, or -1 if it could not be deleted."""
    try:
        size = os.path.getsize(path)
        os.remove(path)
        return size
    except FileNotFoundError:
        return 0
    except OSError as e:
        log.event("CORE", "CLEANUP", "WARN", f"could not delete {path}: {e}")
        return -1


def _files(directory: str, pattern: re.Pattern | None = None) -> list[tuple[str, float, int]]:
    """(path, mtime, size) of the plain files in a folder, oldest first."""
    out = []
    try:
        names = os.listdir(directory)
    except OSError:
        return out
    for n in names:
        if pattern and not pattern.search(n):
            continue
        p = os.path.join(directory, n)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if os.path.isfile(p):
            out.append((p, st.st_mtime, st.st_size))
    return sorted(out, key=lambda f: f[1])


class Maintenance:
    def __init__(self, app) -> None:
        self.app = app
        self.st = app.db.stats
        self._season = None
        self._rows_since_vacuum = 0

    # ---- scheduling ---------------------------------------------------------------
    def _last_run(self, name: str) -> float:
        r = self.st.q1("SELECT last_run FROM maintenance_runs WHERE job=?", (name,))
        return float(r["last_run"]) if r else 0.0

    def _record(self, name: str, result: str) -> None:
        self.st.x("INSERT INTO maintenance_runs (job, last_run, last_result) VALUES (?,?,?) "
                  "ON CONFLICT(job) DO UPDATE SET last_run=excluded.last_run, last_result=excluded.last_result",
                  (name, int(time.time()), result))

    def run(self, name: str, trigger: str) -> None:
        settings = job_settings(name)
        if settings["every"] <= 0:
            return
        if name == "vacuum" and trigger != "startup" and self._rows_since_vacuum < settings["min_rows"]:
            self._record(name, f"skipped: {self._rows_since_vacuum} row(s) deleted since the last vacuum")
            return
        job = JobRun(name, trigger, settings)
        try:
            getattr(self, "job_" + name)(job)
            result = job.done()
        except Exception as e:  # one broken job must not stop the others
            result = f"FAILED: {e!r}"
            job.note(f"FAILED: {e!r}\n{traceback.format_exc()}", "ERROR")
        self._rows_since_vacuum += job.rows
        self._record(name, result)

    def run_all(self, trigger: str) -> None:
        log.event("CORE", "CLEANUP", "INFO", f"running every cleanup job ({trigger})")
        for name in JOBS:  # vacuum is last on purpose: it shrinks the file after the deletes
            self.run(name, trigger)

    def run_due(self) -> None:
        now = time.time()
        for name in JOBS:
            every = job_settings(name)["every"]
            if every > 0 and now - self._last_run(name) >= every:
                self.run(name, "every " + fmt_duration(every))

    def check_season(self) -> None:
        season = self.app.rules.current_season()
        if self._season is not None and season != self._season:
            self.run("key_totals", f"season changed {self._season} -> {season}")
        self._season = season

    async def loop(self) -> None:
        await asyncio.sleep(STARTUP_DELAY)
        try:
            self._season = self.app.rules.current_season()
            self.run_all("startup")
        except Exception as e:
            log.event("CORE", "CLEANUP", "ERROR", f"startup cleanup failed: {e!r}\n{traceback.format_exc()}")
        while True:
            await asyncio.sleep(TICK)
            try:
                self.check_season()
                self.run_due()
            except Exception as e:
                log.event("CORE", "CLEANUP", "ERROR", f"scheduler error: {e!r}\n{traceback.format_exc()}")

    # ---- jobs ---------------------------------------------------------------------
    def job_logs(self, job: JobRun) -> None:
        """Old rotated log files (rising2.log.1, .2, ...); the file being written is never touched."""
        cutoff = time.time() - job.settings["keep"]
        rotated = _files(Config.LOG_DIR, re.compile(r"^rising2\.log\.\d+$"))
        n = size = 0
        kept = []
        for path, mtime, fsize in rotated:
            if mtime < cutoff and _remove(path) >= 0:
                n, size = n + 1, size + fsize
            else:
                kept.append((path, mtime, fsize))
        job.step(f"files older than {fmt_duration(job.settings['keep'])}", files=n, size=size, folder=Config.LOG_DIR)

        limit = job.settings["max_mb"] * 1048576
        active = os.path.join(Config.LOG_DIR, "rising2.log")
        total = sum(f[2] for f in kept) + (os.path.getsize(active) if os.path.exists(active) else 0)
        n = size = 0
        for path, _mtime, fsize in kept:  # oldest first
            if total <= limit:
                break
            if _remove(path) >= 0:
                n, size, total = n + 1, size + fsize, total - fsize
        job.step(f"oldest files over {job.settings['max_mb']:g} MB in total", files=n, size=size,
                 total_mb=f"{total / 1048576:.1f}")

    def job_reports(self, job: JobRun) -> None:
        """Match reports: DB rows plus their raw .bin files (debug only; stats are already in player_stats)."""
        now = time.time()
        cutoff, cutoff_failed = now - job.settings["keep"], now - job.settings["keep_failed"]
        old = self.st.q("SELECT id, raw_file FROM comp_reports WHERE (parse_ok=1 AND received < ?) OR received < ?",
                        (cutoff, cutoff_failed))
        ids = [r["id"] for r in old]
        n_players = 0
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            n_players += self.st.con.execute(f"DELETE FROM comp_report_players WHERE report_id IN ({marks})",
                                             chunk).rowcount
            self.st.con.execute(f"DELETE FROM comp_reports WHERE id IN ({marks})", chunk)
        job.step("comp_report_players", rows=n_players)
        job.step("comp_reports", rows=len(ids), keep=fmt_duration(job.settings["keep"]),
                 keep_failed=fmt_duration(job.settings["keep_failed"]))

        # raw files: every file of a report still in the DB stays; anything else older than `keep` goes
        # (files of deleted reports, and files whose DB row never got written)
        keep_prefixes = {_report_prefix(r["raw_file"])
                         for r in self.st.q("SELECT raw_file FROM comp_reports WHERE raw_file IS NOT NULL")}
        n = size = 0
        for path, mtime, fsize in _files(Config.REPORTS_DIR, re.compile(r"\.bin$")):
            if _report_prefix(path) in keep_prefixes:
                continue
            if mtime < cutoff and _remove(path) >= 0:
                n, size = n + 1, size + fsize
        job.step("raw report files", files=n, size=size, folder=Config.REPORTS_DIR)

    def job_missing(self, job: JobRun) -> None:
        """config/missing/: drop files nobody hit for `keep`, trim the rest to the last N lines."""
        miss = self.app.missing
        if not getattr(miss, "enabled", False):
            job.note("missing folder not in use, nothing to do")
            return
        cutoff = time.time() - job.settings["keep"]
        lines = int(job.settings["lines"])
        n = size = 0
        trimmed = 0
        for path, mtime, fsize in _files(miss.dir):
            if path.endswith(".old"):  # left by older versions
                if _remove(path) >= 0:
                    n, size = n + 1, size + fsize
            elif path.endswith(".log") and mtime < cutoff:
                if _remove(path) >= 0:
                    n, size = n + 1, size + fsize
            elif path.endswith(".log"):
                trimmed += trim_lines(path, lines)
        job.step(f"files not seen for {fmt_duration(job.settings['keep'])}", files=n, size=size, folder=miss.dir)
        job.note(f"trimmed {trimmed} old line(s), each file keeps its last {lines}")

    def job_handshake(self, job: JobRun) -> None:
        """comp_sessions / comp_intentions: only needed until the match report arrives."""
        cutoff = time.time() - job.settings["keep"]
        for table in ("comp_intentions", "comp_sessions"):
            n = self.st.con.execute(f"DELETE FROM {table} WHERE created < ?", (cutoff,)).rowcount
            job.step(table, rows=n)

    def job_logins(self, job: JobRun) -> None:
        """logins: who logged in from where. Sake needs a GP ticket only while that game is open."""
        n = self.st.con.execute("DELETE FROM logins WHERE created < ?", (time.time() - job.settings["keep"],)).rowcount
        job.step("logins", rows=n)

    def job_key_totals(self, job: JobRun) -> None:
        """player_key_totals: raw report key sums. Only the current season's are kept."""
        season = self.app.rules.current_season()
        n = self.st.con.execute("DELETE FROM player_key_totals WHERE season != ?", (season,)).rowcount
        job.step("player_key_totals of other seasons", rows=n, current_season=season)

    def job_backups(self, job: JobRun) -> None:
        """Backup files next to the databases (create_empty_db.py --force, old rebuild backups)."""
        cutoff = time.time() - job.settings["keep"]
        pat = re.compile(r"(\.bak$|^player_stats_backup_.*\.json$)")
        for folder in sorted({os.path.dirname(os.path.abspath(Config.LOGIN_DB)),
                              os.path.dirname(os.path.abspath(Config.STATS_DB))}):
            n = size = 0
            for path, mtime, fsize in _files(folder, pat):
                if mtime < cutoff and _remove(path) >= 0:
                    n, size = n + 1, size + fsize
            job.step("backup files", files=n, size=size, folder=folder)

    def job_vacuum(self, job: JobRun) -> None:
        """Give the space of deleted rows back to the disk (SQLite keeps it otherwise)."""
        path = Config.STATS_DB
        before = _db_size(path)
        self.st.con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.st.con.execute("VACUUM")
        self.st.con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        after = _db_size(path)
        self._rows_since_vacuum = 0
        job.note(f"rising2_stats.db: {before / 1024:.0f} KB -> {after / 1024:.0f} KB")


def _report_prefix(path: str) -> str:
    """'.../20261111-191157_<csid>_<ccid>.report.bin' -> '20261111-191157_<csid>_<ccid>'"""
    name = os.path.basename(path)
    for suffix in (".report.bin", ".http_body.bin"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _db_size(path: str) -> int:
    return sum(os.path.getsize(p) for p in (path, path + "-wal") if os.path.exists(p))


def trim_lines(path: str, keep: int) -> int:
    """Keep the '#' header lines and the last `keep` other lines of a text file. Returns lines removed."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
    except OSError:
        return 0
    header = [ln for ln in all_lines if ln.startswith("#")]
    body = [ln for ln in all_lines if not ln.startswith("#")]
    if len(body) <= keep:
        return 0
    removed = len(body) - keep
    tmp = path + ".tmp"
    try:
        st = os.stat(path)
        with open(tmp, "w", encoding="utf-8") as f:
            f.writelines(header + body[-keep:] if keep > 0 else header)
        os.replace(tmp, path)
        os.utime(path, (st.st_atime, st.st_mtime))  # trimming is not a new occurrence: keep its age
    except OSError as e:
        log.event("CORE", "CLEANUP", "WARN", f"could not trim {path}: {e}")
        return 0
    return removed
