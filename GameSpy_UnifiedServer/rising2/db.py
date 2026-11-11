"""SQLite access. Everything runs on the asyncio thread, so one connection per DB is enough."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time

from . import log
from .config import Config

USER_ID_OFFSET = 200000000
PROFILE_ID_OFFSET = 100000000

SCHEMA_DIR = os.environ.get(
    "R2_SCHEMA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db")
)
TEMPLATE_FILES = ("create_empty_db.py", "schema_login.sql", "schema_stats.sql")


def now() -> int:
    return int(time.time())


def _open(path: str, schema_file: str, migrate=None) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    existed = os.path.exists(path)
    con = sqlite3.connect(path, isolation_level=None)  # autocommit
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    after = migrate(con) if migrate else None
    with open(os.path.join(SCHEMA_DIR, schema_file), encoding="utf-8") as f:
        con.executescript(f.read())  # all statements are IF NOT EXISTS
    if after:
        after(con)
    log.event("CORE", "DB", "INFO", ("opened" if existed else "created new") + f" database {path}")
    return con


def _columns(con: sqlite3.Connection, table: str) -> list[str] | None:
    cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})")]
    return cols or None  # None = table does not exist


def _migrate_seasons(con: sqlite3.Connection):
    """Databases from before seasons: add a `season` column (old data -> DEFAULT_SEASON).
    Runs before the schema script; returns a step to run after it (or None)."""
    legacy = Config.DEFAULT_SEASON
    for t in ("comp_sessions", "comp_reports", "comp_report_players"):
        cols = _columns(con, t)
        if cols and "season" not in cols:
            con.execute(f"ALTER TABLE {t} ADD COLUMN season TEXT NOT NULL DEFAULT '{legacy}'")
            log.event("CORE", "DB", "WARN", f"migrated {t}: added season column, old rows -> season '{legacy}'")
    # these two get season in their primary key, so they are rebuilt: rename now, copy after
    renamed = []
    for t in ("player_stats", "player_key_totals"):
        cols = _columns(con, t)
        if cols and "season" not in cols:
            con.execute(f"ALTER TABLE {t} RENAME TO {t}_pre_season")
            renamed.append((t, cols))
    if not renamed:
        return None

    def copy_rows(con: sqlite3.Connection) -> None:
        for t, cols in renamed:
            names = ", ".join(cols)
            con.execute("BEGIN")
            con.execute(f"INSERT INTO {t} (season, {names}) SELECT ?, {names} FROM {t}_pre_season", (legacy,))
            con.execute(f"DROP TABLE {t}_pre_season")
            con.execute("COMMIT")
            log.event("CORE", "DB", "WARN", f"migrated {t}: season added to the key, old rows -> season '{legacy}'")
    return copy_rows


def _migrate_login(con: sqlite3.Connection):
    """Older login databases have no `created` column: add it, best guess = last login time."""
    cols = _columns(con, "users")
    if cols and "created" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN created INTEGER NULL DEFAULT '0'")
        con.execute("UPDATE users SET created=lasttime")
        log.event("CORE", "DB", "WARN", "migrated users: added created column (old accounts -> their last login time)")
    return None


def copy_templates() -> None:
    """Keep create_empty_db.py + schema files next to the live databases."""
    for target_dir in {os.path.dirname(os.path.abspath(Config.LOGIN_DB)),
                       os.path.dirname(os.path.abspath(Config.STATS_DB))}:
        try:
            os.makedirs(target_dir, exist_ok=True)
            for name in TEMPLATE_FILES:
                shutil.copyfile(os.path.join(SCHEMA_DIR, name), os.path.join(target_dir, name))
            log.event("CORE", "DB", "INFO", f"db template script + schemas copied to {target_dir}")
        except OSError as e:
            log.event("CORE", "DB", "WARN", f"could not copy db templates to {target_dir}: {e}")


def _user(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    d["passwordenc"] = d.get("password")
    d["userid"] = d["id"] + USER_ID_OFFSET
    d["profileid"] = d["id"] + PROFILE_ID_OFFSET
    return d


class LoginDB:
    def __init__(self, path: str) -> None:
        self.con = _open(path, "schema_login.sql", _migrate_login)

    def get_user(self, name: str) -> dict | None:
        return _user(self.con.execute("SELECT * FROM users WHERE name=? COLLATE NOCASE", (name,)).fetchone())

    def get_by_profileid(self, profileid: int) -> dict | None:
        return _user(self.con.execute("SELECT * FROM users WHERE id=?", (int(profileid) - PROFILE_ID_OFFSET,)).fetchone())

    def users_by_email_and_password(self, email: str, md5pass: str) -> list[dict]:
        rows = self.con.execute("SELECT * FROM users WHERE email=? COLLATE NOCASE AND password=?", (email, md5pass))
        return [_user(r) for r in rows]

    def users_by_email(self, email: str) -> list[dict]:
        return [_user(r) for r in self.con.execute("SELECT * FROM users WHERE email=? COLLATE NOCASE", (email,))]

    def all_users(self) -> list[dict]:
        return [_user(r) for r in self.con.execute("SELECT * FROM users ORDER BY id")]

    def exists(self, name: str) -> bool:
        return self.get_user(name) is not None

    def create_user(self, name: str, md5pass: str, email: str, country: str, ip: str) -> dict | None:
        self.con.execute(
            "INSERT INTO users (name, password, email, country, lastip, lasttime, created) VALUES (?,?,?,?,?,?,?)",
            (name, md5pass, email.lower(), country, ip, now(), now()),
        )
        return self.get_user(name)

    def set_country(self, name: str, country: str) -> None:
        self.con.execute("UPDATE users SET country=? WHERE name=? COLLATE NOCASE", (country.upper(), name))

    def log_login(self, name: str, ip: str) -> None:
        self.con.execute("UPDATE users SET lastip=?, lasttime=? WHERE name=? COLLATE NOCASE", (ip, now(), name))


class StatsDB:
    def __init__(self, path: str) -> None:
        self.con = _open(path, "schema_stats.sql", _migrate_seasons)

    def q(self, sql: str, args: tuple = ()) -> list[dict]:
        return [dict(r) for r in self.con.execute(sql, args)]

    def q1(self, sql: str, args: tuple = ()) -> dict | None:
        r = self.con.execute(sql, args).fetchone()
        return dict(r) if r else None

    def x(self, sql: str, args: tuple = ()) -> int:
        cur = self.con.execute(sql, args)
        return cur.lastrowid

    # ---- logins -----------------------------------------------------------
    def add_login(self, source: str, ticket: str | None, profileid: int | None, nick: str | None, ip: str) -> None:
        self.x("INSERT INTO logins (source, ticket, profileid, nick, ip, created) VALUES (?,?,?,?,?,?)",
               (source, ticket, profileid, nick, ip, now()))

    def login_by_ticket(self, ticket: str) -> dict | None:
        return self.q1("SELECT * FROM logins WHERE ticket=? ORDER BY id DESC LIMIT 1", (ticket,))

    # ---- player stats (one row per season and player) -----------------------
    def get_stats(self, season: str, profileid: int) -> dict | None:
        r = self.q1("SELECT * FROM player_stats WHERE season=? AND profileid=?", (season, profileid))
        if not r:
            return None
        r["data"] = json.loads(r["data_json"])
        return r

    def all_stats(self, season: str) -> dict[int, dict]:
        return {r["profileid"]: json.loads(r["data_json"])
                for r in self.q("SELECT * FROM player_stats WHERE season=?", (season,))}

    def put_stats(self, season: str, profileid: int, nick: str | None, data: dict) -> None:
        self.x(
            "INSERT INTO player_stats (season, profileid, nick, data_json, updated) VALUES (?,?,?,?,?) "
            "ON CONFLICT(season, profileid) DO UPDATE SET nick=excluded.nick, data_json=excluded.data_json, "
            "updated=excluded.updated",
            (season, profileid, nick, json.dumps(data, sort_keys=True), now()),
        )

    def seasons(self) -> list[dict]:
        """Every season that has data, oldest first: name, reports, players, first/last report time."""
        return self.q(
            "SELECT s.season, COALESCE(r.reports, 0) AS reports, COALESCE(p.players, 0) AS players, "
            "r.first_report, r.last_report FROM "
            "(SELECT season FROM comp_sessions UNION SELECT season FROM comp_reports "
            " UNION SELECT season FROM player_stats) s "
            "LEFT JOIN (SELECT season, COUNT(*) AS reports, MIN(received) AS first_report, MAX(received) AS last_report "
            "           FROM comp_reports GROUP BY season) r ON r.season = s.season "
            "LEFT JOIN (SELECT season, COUNT(*) AS players FROM player_stats GROUP BY season) p ON p.season = s.season "
            "ORDER BY COALESCE(r.first_report, 9e18), s.season")

    # ---- generic sake -------------------------------------------------------
    def sake_records(self, table_id: str) -> list[dict]:
        out = []
        for r in self.q("SELECT * FROM sake_records WHERE table_id=? ORDER BY recordid", (table_id,)):
            r["data"] = json.loads(r["data_json"])
            out.append(r)
        return out

    def sake_get(self, table_id: str, recordid: int) -> dict | None:
        r = self.q1("SELECT * FROM sake_records WHERE table_id=? AND recordid=?", (table_id, recordid))
        if r:
            r["data"] = json.loads(r["data_json"])
        return r

    def sake_get_by_owner(self, table_id: str, ownerid: int) -> dict | None:
        r = self.q1("SELECT * FROM sake_records WHERE table_id=? AND ownerid=? ORDER BY recordid LIMIT 1",
                    (table_id, ownerid))
        if r:
            r["data"] = json.loads(r["data_json"])
        return r

    def sake_put(self, table_id: str, recordid: int | None, ownerid: int | None, data: dict) -> int:
        if recordid is None:
            m = self.q1("SELECT MAX(recordid) AS m FROM sake_records WHERE table_id=?", (table_id,))
            recordid = (m["m"] or 0) + 1
        self.x(
            "INSERT INTO sake_records (table_id, recordid, ownerid, data_json, updated) VALUES (?,?,?,?,?) "
            "ON CONFLICT(table_id, recordid) DO UPDATE SET ownerid=COALESCE(excluded.ownerid, ownerid), "
            "data_json=excluded.data_json, updated=excluded.updated",
            (table_id, recordid, ownerid, json.dumps(data, sort_keys=True), now()),
        )
        return recordid

    def sake_delete(self, table_id: str, recordid: int) -> None:
        self.x("DELETE FROM sake_records WHERE table_id=? AND recordid=?", (table_id, recordid))


class Databases:
    login: LoginDB
    stats: StatsDB

    def __init__(self) -> None:
        copy_templates()
        self.login = LoginDB(Config.LOGIN_DB)
        self.stats = StatsDB(Config.STATS_DB)
