-- Rising2 stats database (rising2_stats.db)
-- Competition (ATLAS) sessions and reports, computed player stats, and every
-- other Sake record the game writes.
--
-- Seasons: everything that feeds ranking carries a `season` (a name like
-- 'preseason' or '2027-pistols', chosen in config/seasons/current.txt). A new
-- season starts every player from zero; old seasons stay in the tables.

-- One row per CreateSession / CreateMatchlessSession (sent by the game server)
CREATE TABLE IF NOT EXISTS comp_sessions (
    csid        TEXT PRIMARY KEY,
    host_ccid   TEXT,
    created     INTEGER NOT NULL,
    host_ip     TEXT,
    host_profileid INTEGER,
    host_nick   TEXT,
    gameid      INTEGER,
    matchless   INTEGER NOT NULL DEFAULT 0,
    season      TEXT    NOT NULL DEFAULT 'preseason'   -- season when the session started
);

-- One row per SetReportIntention (server and every client). Maps the
-- connection id (ccid) that appears in the report roster to a player.
CREATE TABLE IF NOT EXISTS comp_intentions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    csid          TEXT NOT NULL,
    ccid          TEXT NOT NULL,
    profileid     INTEGER,
    nick          TEXT,
    ip            TEXT,
    authoritative INTEGER,
    resolved_by   TEXT,
    created       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_intent_ccid ON comp_intentions(ccid);

-- One row per SubmitReport. The raw binary is also saved under reports/.
CREATE TABLE IF NOT EXISTS comp_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    csid          TEXT,
    ccid          TEXT,
    received      INTEGER NOT NULL,
    submitter_ip  TEXT,
    authoritative INTEGER,
    raw_file      TEXT,
    raw_size      INTEGER,
    parse_ok      INTEGER NOT NULL DEFAULT 0,
    parse_error   TEXT,
    game_status   INTEGER,
    flags         INTEGER,
    player_count  INTEGER,
    team_count    INTEGER,
    applied       INTEGER NOT NULL DEFAULT 0,
    parsed_json   TEXT,
    season        TEXT    NOT NULL DEFAULT 'preseason', -- the session's season
    map           TEXT    NOT NULL DEFAULT '',          -- from QR2 heartbeats, '' = unknown (docs/map_tracking.md)
    gametype      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_reports_season ON comp_reports(season, id);

-- Per player inside a report
CREATE TABLE IF NOT EXISTS comp_report_players (
    report_id  INTEGER NOT NULL,
    idx        INTEGER NOT NULL,
    ccid       TEXT,
    profileid  INTEGER,
    nick       TEXT,
    team       INTEGER,
    result     INTEGER,
    keys_json  TEXT,
    season     TEXT    NOT NULL DEFAULT 'preseason',
    PRIMARY KEY (report_id, idx)
);

-- Running totals of every raw report key per player and season
-- (what the keys mean: docs/report_keys.md).
CREATE TABLE IF NOT EXISTS player_key_totals (
    season    TEXT    NOT NULL DEFAULT 'preseason',
    profileid INTEGER NOT NULL,
    key_id    INTEGER NOT NULL,
    sum_value REAL NOT NULL DEFAULT 0,
    max_value REAL,
    last_value TEXT,
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (season, profileid, key_id)
);

-- The PlayerStats_v1 Sake row of each player per season (JSON object column -> value)
CREATE TABLE IF NOT EXISTS player_stats (
    season    TEXT    NOT NULL DEFAULT 'preseason',
    profileid INTEGER NOT NULL,
    nick      TEXT,
    data_json TEXT NOT NULL,
    updated   INTEGER NOT NULL,
    PRIMARY KEY (season, profileid)
);

-- Generic Sake storage for every other table (PersonalInfo, ...).
-- data_json = {"Field": ["typeValue", value], ...}
CREATE TABLE IF NOT EXISTS sake_records (
    table_id  TEXT NOT NULL,
    recordid  INTEGER NOT NULL,
    ownerid   INTEGER,
    data_json TEXT NOT NULL,
    updated   INTEGER NOT NULL,
    PRIMARY KEY (table_id, recordid)
);
CREATE INDEX IF NOT EXISTS ix_sake_owner ON sake_records(table_id, ownerid);

-- Who logged in from where (GP login tickets + AuthService logins).
-- Used to map Sake loginTicket -> owner and Competition ccid -> player.
CREATE TABLE IF NOT EXISTS logins (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    source    TEXT NOT NULL,      -- 'gp' or 'auth'
    ticket    TEXT,
    profileid INTEGER,
    nick      TEXT,
    ip        TEXT,
    created   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_logins_ticket ON logins(ticket);
CREATE INDEX IF NOT EXISTS ix_logins_ip ON logins(ip);
CREATE INDEX IF NOT EXISTS ix_logins_created ON logins(created);

-- When each cleanup job (rising2/maintenance.py) last ran, so a job that came due
-- while the server was asleep or stopped runs as soon as it is back.
CREATE TABLE IF NOT EXISTS maintenance_runs (
    job         TEXT PRIMARY KEY,
    last_run    INTEGER NOT NULL,
    last_result TEXT
);
