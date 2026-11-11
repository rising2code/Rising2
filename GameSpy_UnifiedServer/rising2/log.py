"""Logging: every connection, packet and request goes through here.

Line format (fields that are unknown are simply left out):

  2026-11-11 21:03:44.120 [GPCM] [LOGIN] [INFO] [#5] login accepted | user=Bob ip=10.0.0.5:51234 | profileid=100000001 sesskey=4242

  [Service] [Action] [LEVEL] [#conn] context text | {user/server name} {source ip} | {other targets}

[#conn] is the connection number: one per TCP connection (also inherited by
everything done while handling it, e.g. a SubmitReport's stats lines), one per
remote ip:port for UDP. [#-] = not tied to a connection (startup, timers).

Rule of thumb for this server: if something reached a socket, there is a log
line for it. Raw bytes are logged *before* any parsing so a malformed packet
still shows up.
"""
from __future__ import annotations

import contextvars
import itertools
import logging
import logging.handlers
import os
import re
import sys

from .config import Config

_conn_counter = itertools.count(1)
_log = logging.getLogger("rising2")

# Connection number of the code that is running right now. Set per TCP
# connection task / per UDP packet; asyncio copies it into child tasks.
current_conn: contextvars.ContextVar = contextvars.ContextVar("rising2_conn", default=None)


def next_conn_id() -> int:
    return next(_conn_counter)


# Console lines are shortened; the log file always gets the whole line.
CONSOLE_MAX_TEXT = 1024   # characters of a message
CONSOLE_MAX_HEX = 512     # bytes of a hex dump (16 per dump line)
CONSOLE_KEEP_TEXT = 400   # characters kept at each end
CONSOLE_KEEP_HEX_LINES = 8
_HEX_LINE = re.compile(r"^    [0-9a-f]{4,}  ")


def shorten_for_console(msg: str) -> str:
    """'start ....[+N chars, see rising2.log].... end' for long messages; long hex dumps keep
    their first and last lines. Hex dumps are judged by bytes, so a short dump stays whole."""
    lines = msg.split("\n")
    hex_idx = [i for i, ln in enumerate(lines) if _HEX_LINE.match(ln)]
    if hex_idx:
        if len(hex_idx) * 16 <= CONSOLE_MAX_HEX:
            return msg
        k = CONSOLE_KEEP_HEX_LINES
        first, last = hex_idx[0], hex_idx[-1]
        hidden = len(hex_idx) - 2 * k
        head = lines[:first + k]
        tail = lines[last - k + 1:]
        return "\n".join(head + [f"    ....[+{hidden} lines / {hidden * 16} bytes, see rising2.log]...."] + tail)
    if len(msg) <= CONSOLE_MAX_TEXT:
        return msg
    n = CONSOLE_KEEP_TEXT
    return f"{msg[:n]} ....[+{len(msg) - 2 * n} chars, see rising2.log].... {msg[-n:]}"


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        full = record.getMessage()
        short = shorten_for_console(full)
        if short is full:
            return super().format(record)
        copy = logging.makeLogRecord(record.__dict__)
        copy.msg, copy.args = short, None
        return super().format(copy)


def setup(console_level: str | None = None) -> None:
    datefmt = "%Y-%m-%d %H:%M:%S"
    fmt = logging.Formatter("%(asctime)s.%(msecs)03d %(message)s", datefmt=datefmt)
    root = logging.getLogger()
    root.setLevel(getattr(logging, Config.LOG_LEVEL.upper(), logging.DEBUG))
    for h in list(root.handlers):
        root.removeHandler(h)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(ConsoleFormatter("%(asctime)s.%(msecs)03d %(message)s", datefmt=datefmt))
    if console_level:
        sh.setLevel(_LEVELS.get(console_level, logging.WARNING))
    root.addHandler(sh)

    try:
        os.makedirs(Config.LOG_DIR, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            os.path.join(Config.LOG_DIR, "rising2.log"),
            maxBytes=50 * 1024 * 1024, backupCount=100,  # old files: maintenance 'logs' job
            encoding="utf-8",
        )
        fh.setFormatter(fmt)
        root.addHandler(fh)
    except OSError as e:  # read-only volume etc. - console logging still works
        event("CORE", "LOGFILE", "WARN", f"file logging disabled: {e}")


_LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARN": logging.WARNING,
    "ERROR": logging.ERROR,
}


def peer(addr) -> str:
    if not addr:
        return ""
    return f"{addr[0]}:{addr[1]}"


def _conn_tag(conn) -> str:
    c = conn if conn is not None else current_conn.get()
    return f"[#{c}]" if c is not None else "[#-]"


def event(service: str, action: str, level: str, text: str = "",
          user: str | None = None, ip=None, conn=None, **targets) -> None:
    """Main logging call.

    service : GPCM, GPSP, QR2, SB, CDKEY, NATNEG, HTTP, AUTH, SAKE, COMP, STATS, CORE
    action  : short verb, e.g. CONNECT, RECV, SEND, LOGIN, HEARTBEAT, SUBMIT
    level   : DEBUG / INFO / WARN / ERROR
    user    : player nick or game-server name if known
    ip      : "1.2.3.4:5678" or an (ip, port) tuple
    conn    : connection number; default = the one of the running connection
    targets : any other context (profileid=..., csid=..., table=...)
    """
    lvl = _LEVELS.get(level, logging.INFO)
    if not _log.isEnabledFor(lvl):
        return
    if isinstance(ip, tuple):
        ip = peer(ip)
    parts = [f"[{service}] [{action}] [{level}] {_conn_tag(conn)}"]
    if text:
        parts.append(text)
    who = " ".join(x for x in (f"user={user}" if user else "", f"ip={ip}" if ip else "") if x)
    if who:
        parts.append("| " + who)
    tg = " ".join(f"{k}={v}" for k, v in targets.items() if v is not None and v != "")
    if tg:
        parts.append("| " + tg)
    _log.log(lvl, " ".join(parts))


def printable(data: bytes, limit: int = 600) -> str:
    """GameSpy text protocols as a readable one-liner (non-printables as <xx>)."""
    out = []
    for o in data[:limit]:
        out.append(chr(o) if 0x20 <= o < 0x7F else f"<{o:02x}>")
    if len(data) > limit:
        out.append(f"...(+{len(data) - limit} bytes)")
    return "".join(out)


def hexdump(data: bytes) -> str:
    data = data[: Config.LOG_HEX_MAX]
    lines = []
    for off in range(0, len(data), 16):
        chunk = data[off : off + 16]
        hx = " ".join(f"{b:02x}" for b in chunk)
        asc = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in chunk)
        lines.append(f"    {off:04x}  {hx:<47}  {asc}")
    return "\n".join(lines)


_SECRET = re.compile(rb"(\\(?:passenc|pass|password|newpassword)\\)[^\\]*", re.IGNORECASE)


def redact(data: bytes) -> bytes:
    """Hide GP password fields (passenc is reversible, so it must not reach the logs)."""
    return _SECRET.sub(lambda m: m.group(1) + b"<redacted>", data)


def packet(service: str, direction: str, data: bytes, user: str | None = None, ip=None, conn=None,
           **targets) -> None:
    """direction: 'RECV' or 'SEND'. Logs a readable line plus (DEBUG) a hex dump."""
    if b"pass" in data.lower():
        data = redact(data)
    event(service, direction, "INFO", f"{len(data)} bytes: {printable(data)}", user=user, ip=ip, conn=conn, **targets)
    if Config.LOG_HEX and data and _log.isEnabledFor(logging.DEBUG):
        _log.debug("[%s] [%s-HEX] [DEBUG] %s\n%s", service, direction, _conn_tag(conn), hexdump(data))
