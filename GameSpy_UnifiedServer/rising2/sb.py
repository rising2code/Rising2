"""Server browser (TCP 28910): clients ask for the list of game servers.

Byte layout of the reply and the encryption are ported from PRMasterServer
ServerListRetrieve.cs (enctypex verified against the original Reality.Net.dll).
Filters are evaluated by SQLite on a throw-away in-memory table, with an
authorizer that only allows reading that table.
"""
from __future__ import annotations

import re
import socket
import sqlite3
import struct

from . import gs_crypto as gc
from .config import Config
from .net import TcpSession

_SQL_WORDS = {"and", "or", "not", "like", "null", "is", "in", "between", "glob", "escape", "true", "false"}
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_STRINGS = re.compile(r"'[^']*'|\"[^\"]*\"")


def _num(v: str):
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return v


def filter_servers(servers, flt: str) -> tuple[list, str]:
    """Returns (matching servers, note). On any filter error all servers are returned (old C# behaviour)."""
    if not flt.strip():
        return list(servers), ""
    flt_sql = flt.replace("&&", " and ").replace("||", " or ").replace("==", "=")
    idents = {m.group(0) for m in _IDENT.finditer(_STRINGS.sub("''", flt_sql))} - _SQL_WORDS
    cols = sorted({k for s in servers for k in s.keys} | {i for i in idents if i.lower() not in _SQL_WORDS} | {"country"})
    bad = [c for c in cols if not _IDENT.fullmatch(c)]
    cols = [c for c in cols if c not in bad]
    con = sqlite3.connect(":memory:")
    try:
        con.execute("CREATE TABLE s (_i INTEGER, " + ", ".join(f'"{c}"' for c in cols) + ")")
        for i, s in enumerate(servers):
            vals = [_num(s.keys.get(c, "??" if c == "country" else "")) if c in s.keys or c == "country" else None for c in cols]
            con.execute(f"INSERT INTO s VALUES (?{', ?' * len(cols)})", [i, *vals])

        def authorizer(action, arg1, arg2, dbname, source):
            if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and arg1 == "s":
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY

        con.set_authorizer(authorizer)
        rows = con.execute(f"SELECT _i FROM s WHERE {flt_sql}").fetchall()
        srv = list(servers)
        return [srv[r[0]] for r in rows], f"filter matched {len(rows)}/{len(srv)}"
    except sqlite3.Error as e:
        return list(servers), f"filter could not be evaluated ({e}); returning ALL servers"
    finally:
        con.close()


class SbSession(TcpSession):
    SERVICE = "SB"

    async def on_connect(self) -> None:
        self.buf = b""

    async def on_data(self, data: bytes) -> None:
        self.buf += data
        while len(self.buf) >= 2:
            length = int.from_bytes(self.buf[:2], "big")
            if length < 3:
                self.ev("REQUEST", "WARN", f"bad length prefix {length}, dropping buffer")
                self.buf = b""
                return
            if len(self.buf) < length:
                self.ev("REQUEST", "DEBUG", f"waiting for more data ({len(self.buf)}/{length})")
                return
            req, self.buf = self.buf[:length], self.buf[length:]
            await self.handle(req)
            if self.closed:
                return

    async def handle(self, req: bytes) -> None:
        rtype = req[2]
        if rtype != 0x00:
            names = {1: "SERVER_INFO", 2: "SEND_MESSAGE", 3: "KEEPALIVE_REPLY", 4: "MAPLOOP", 5: "PLAYERSEARCH"}
            self.ev("REQUEST", "WARN", f"unhandled request type {rtype} ({names.get(rtype, '?')}), no reply")
            return
        try:
            protover, encver = req[3], req[4]
            gamever = struct.unpack(">I", req[5:9])[0]
            pos = 9

            def cstr(p):
                e = req.index(b"\x00", p)
                return req[p:e].decode("latin-1"), e + 1

            query_game, pos = cstr(pos)
            from_game, pos = cstr(pos)
            validate = req[pos:pos + 8]
            pos += 8
            flt, pos = cstr(pos)
            fields_s, pos = cstr(pos)
            options = struct.unpack(">I", req[pos:pos + 4])[0] if pos + 4 <= len(req) else 0
        except (ValueError, IndexError, struct.error) as e:
            self.ev("LIST", "ERROR", f"could not parse list request: {e!r}")
            return

        fields = [f for f in fields_s.split("\\") if f]
        self.ev("LIST", "INFO", "server list request", game=query_game, from_game=from_game,
                filter=repr(flt), fields=",".join(fields), options=hex(options), protover=protover,
                encver=encver, gamever=gamever)
        if query_game.lower() != Config.GAMENAME or from_game.lower() not in (Config.GAMENAME, "gslive"):
            self.ev("LIST", "WARN", "unknown game in request, no reply (same as old server)")
            return

        qr = self.ctx.qr2
        servers, note = filter_servers(qr.listed_servers(), flt)
        if note:
            self.ev("LIST", "WARN" if "ALL" in note else "DEBUG", note)

        plain = self.pack(servers, fields)
        enc = gc.enctypex_encode(Config.SECRET_KEY.encode(), validate, plain)
        self.ev("LIST", "INFO", f"sending {len(servers)} server(s)",
                servers="; ".join(f"{s.name}@{self.list_ip(s)}:{s.query_port}" for s in servers) or "-",
                plain_bytes=len(plain), encrypted_bytes=len(enc))
        await self.send(enc, note="encrypted server list")
        self.close("list sent (same as old server)")

    def list_ip(self, s) -> str:
        return Config.SB_OVERRIDE_SERVER_IP or s.ip

    def pack(self, servers, fields: list[str]) -> bytes:
        out = bytearray()
        try:
            out += socket.inet_aton(self.ip)
        except OSError:
            out += b"\x00\x00\x00\x00"
        out += struct.pack(">H", 6500)
        out.append(len(fields) & 0xFF)
        out.append(0)
        for f in fields:
            out += f.encode("latin-1") + b"\x00\x00"
        for s in servers:
            out.append(81)  # 0x51: UNSOLICITED_UDP | NONSTANDARD_PORT | HAS_KEYS
            out += socket.inet_aton(self.list_ip(s))
            out += struct.pack(">H", s.query_port)
            out.append(255)
            for i, f in enumerate(fields):
                val = s.keys.get(f, "??" if f == "country" else "")
                out += val.encode("latin-1", "replace")
                if i < len(fields) - 1:
                    out += b"\x00\xff"
            out.append(0)
        out += b"\x00\xff\xff\xff\xff"
        return bytes(out)
