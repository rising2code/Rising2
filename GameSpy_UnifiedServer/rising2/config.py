"""All settings come from environment variables (see README / docker-compose.yml)."""
from __future__ import annotations

import os


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


class Config:
    BIND = _env("R2_BIND", "0.0.0.0")
    DATA_DIR = _env("R2_DATA_DIR", "/data")

    # Login database: same schema as the old C# LoginDatabase.db3, so an
    # existing file can be dropped in unchanged.
    LOGIN_DB = _env("R2_LOGIN_DB", os.path.join(DATA_DIR, "LoginDatabase.db3"))
    # Stats / sessions / reports / sake records live in a separate file.
    STATS_DB = _env("R2_STATS_DB", os.path.join(DATA_DIR, "rising2_stats.db"))
    REPORTS_DIR = _env("R2_REPORTS_DIR", os.path.join(DATA_DIR, "reports"))
    LOG_DIR = _env("R2_LOG_DIR", os.path.join(DATA_DIR, "logs"))
    RULES = _env("R2_RULES", "")              # path to rules.py, empty = <app>/config/rules.py
    MISSING_DIR = _env("R2_MISSING_DIR", "")  # empty = "missing" folder next to rules.py

    LOG_LEVEL = _env("R2_LOG_LEVEL", "DEBUG")
    LOG_HEX = _env_bool("R2_LOG_HEX", True)          # hex dump every packet
    LOG_HEX_MAX = _env_int("R2_LOG_HEX_MAX", 4096)    # bytes per dump
    LOG_HTTP_BODY = _env_bool("R2_LOG_HTTP_BODY", True)
    # warn when a TCP client connected but has not sent a byte after this many seconds (0 = off)
    NO_DATA_WARN = _env_int("R2_NO_DATA_WARN", 10)

    GAMENAME = _env("R2_GAMENAME", "risingeaglepc")
    SECRET_KEY = _env("R2_SECRET_KEY", "9cy8vc")
    PARTNER_CODE = _env_int("R2_PARTNER_CODE", 11067)

    PORT_GPCM = _env_int("R2_PORT_GPCM", 29900)
    PORT_GPSP = _env_int("R2_PORT_GPSP", 29901)
    PORT_SB = _env_int("R2_PORT_SB", 28910)
    PORT_QR = _env_int("R2_PORT_QR", 27900)
    PORT_NATNEG = _env_int("R2_PORT_NATNEG", 27901)
    PORT_CDKEY = _env_int("R2_PORT_CDKEY", 29910)
    PORT_HTTP = _env_int("R2_PORT_HTTP", 80)

    ENABLE_NATNEG_LOGGER = _env_bool("R2_ENABLE_NATNEG_LOGGER", True)

    # Answer the QR2 "is this game available" packet (0x09). GameSpy answered
    # it for every live game; the old C# server only answered "battlefield2".
    QR_ANSWER_AVAILABILITY = _env_bool("R2_QR_ANSWER_AVAILABILITY", True)
    QR_SERVER_TIMEOUT = _env_int("R2_QR_SERVER_TIMEOUT", 30)  # seconds without ping
    # If set, game servers are listed with this IP instead of the source IP the
    # mock saw (useful behind Docker Desktop NAT, where every source is the gateway).
    SB_OVERRIDE_SERVER_IP = _env("R2_SB_OVERRIDE_SERVER_IP", "")

    MOTD = _env("R2_MOTD", "Welcome to Rising2")
