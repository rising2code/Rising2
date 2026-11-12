"""QR2 - dedicated servers report themselves here (UDP 27900).

Ported from PRMasterServer ServerListReport.cs, with two fixes:
 * the availability packet (0x09) is answered for risingeaglepc too;
 * details from the very first heartbeat are kept, so a server shows up in
   the list right after the challenge instead of after the *next* heartbeat.
"""
from __future__ import annotations

import asyncio
import time

from . import log
from .config import Config
from .net import UdpService

# Hard-coded challenge the C# server sent (it never validated the answer either).
CHALLENGE_TAIL = bytes([0x44, 0x3D, 0x73, 0x7E, 0x6A, 0x59, 0x30, 0x30, 0x37, 0x43, 0x39, 0x35,
                        0x41, 0x42, 0x42, 0x35, 0x37, 0x34, 0x43, 0x43, 0x00])

QR_NAMES = {0x00: "QUERY", 0x01: "CHALLENGE", 0x02: "ECHO", 0x03: "HEARTBEAT", 0x04: "ADDERROR",
            0x05: "ECHO_RESPONSE", 0x06: "CLIENT_MESSAGE", 0x07: "CLIENT_MESSAGE_ACK", 0x08: "KEEPALIVE",
            0x09: "AVAILABLE", 0x0A: "CLIENT_REGISTERED"}


class GameServer:
    def __init__(self, ip: str, port: int) -> None:
        self.ip = ip
        self.query_port = port
        self.valid = False          # challenge passed + required keys present
        self.registered = False     # challenge passed
        self.keys: dict[str, str] = {}
        self.players: list[dict] = []
        self.teams: list[dict] = []
        self.last_ping = time.time()
        self.first_seen = time.time()

    @property
    def key(self) -> str:
        return f"{self.ip}:{self.query_port}"

    @property
    def name(self) -> str:
        return self.keys.get("hostname") or self.key

    def check_valid(self) -> bool:
        k = self.keys
        try:
            hostport = int(k.get("hostport", "0"))
            maxplayers = int(k.get("maxplayers", "0"))
        except ValueError:
            return False
        return bool(
            k.get("gamename", "").lower() == Config.GAMENAME
            and k.get("hostname", "").strip()
            and k.get("gametype", "").strip()
            and k.get("mapname", "").strip()
            and 1024 < hostport <= 65535
            and maxplayers > 0
        )


def _cstr(data: bytes, pos: int) -> tuple[str, int]:
    end = data.index(b"\x00", pos)
    return data[pos:end].decode("latin-1"), end + 1


def parse_heartbeat(body: bytes) -> tuple[dict[str, str], list[dict], list[dict], str]:
    """Parse key/values, then (best effort) player and team sections."""
    keys: dict[str, str] = {}
    pos = 0
    while pos < len(body):
        k, pos = _cstr(body, pos)
        if k == "":
            break
        v, pos = _cstr(body, pos)
        keys[k] = v
    players: list[dict] = []
    teams: list[dict] = []
    note = ""
    try:
        for target in (players, teams):
            if pos + 2 > len(body):
                break
            count = int.from_bytes(body[pos:pos + 2], "big")
            pos += 2
            names = []
            while True:
                n, pos = _cstr(body, pos)
                if n == "":
                    break
                names.append(n)
            for _ in range(count):
                row = {}
                for n in names:
                    row[n], pos = _cstr(body, pos)
                target.append(row)
    except (ValueError, IndexError) as e:
        note = f"player/team section not fully parsed ({e})"
    return keys, players, teams, note


class Qr2Service(UdpService):
    SERVICE = "QR2"

    def __init__(self, ctx) -> None:
        super().__init__(ctx)
        self.servers: dict[str, GameServer] = {}
        self.pending: dict[str, GameServer] = {}

    def name_for(self, addr) -> str | None:
        s = self.servers.get(f"{addr[0]}:{addr[1]}") or self.pending.get(f"{addr[0]}:{addr[1]}")
        return s.name if s else None

    def on_packet(self, data: bytes, addr) -> None:
        key = f"{addr[0]}:{addr[1]}"
        if not data:
            return
        ptype = data[0]
        tname = QR_NAMES.get(ptype, f"UNKNOWN_0x{ptype:02x}")
        user = self.name_for(addr)

        if ptype == 0x09:
            game = data[5:].split(b"\x00")[0].decode("latin-1", "replace")
            log.event("QR2", "AVAILABLE", "INFO", f"availability check for game '{game}'", ip=addr)
            if Config.QR_ANSWER_AVAILABILITY or game == "battlefield2":
                self.send(b"\xfe\xfd\x09\x00\x00\x00\x00", addr, note="available=0 (game is up)")
            else:
                log.event("QR2", "AVAILABLE", "INFO", "not answered (R2_QR_ANSWER_AVAILABILITY=0)", ip=addr)
            return

        if len(data) < 5:
            log.event("QR2", tname, "WARN", "packet too short, ignored", user=user, ip=addr)
            return
        inst = data[1:5]

        if ptype == 0x03:
            keys, players, teams, note = parse_heartbeat(data[5:])
            srv = self.servers.get(key)
            log.event("QR2", "HEARTBEAT", "INFO",
                      f"{len(keys)} keys, {len(players)} players, {len(teams)} teams" + (f" ({note})" if note else ""),
                      user=keys.get("hostname") or user, ip=addr, statechanged=keys.get("statechanged"),
                      map=keys.get("mapname"), gametype=keys.get("gametype"),
                      players=f"{keys.get('numplayers', '?')}/{keys.get('maxplayers', '?')}",
                      hostport=keys.get("hostport"), gamename=keys.get("gamename"))
            log.event("QR2", "HEARTBEAT", "DEBUG", "keys: " + " ".join(f"{k}={v!r}" for k, v in keys.items()), ip=addr)
            if players:
                log.event("QR2", "PLAYERS", "INFO", "; ".join(
                    " ".join(f"{k}={v}" for k, v in p.items()) for p in players), user=keys.get("hostname"), ip=addr)
            if not keys:
                # plain heartbeat without keys: just a refresh
                if srv:
                    srv.last_ping = time.time()
                return
            if keys.get("gamename", "").lower() != Config.GAMENAME:
                log.event("QR2", "HEARTBEAT", "WARN", f"ignored: gamename '{keys.get('gamename')}'", ip=addr)
                return
            tracker = getattr(self.ctx, "maptrack", None)
            if tracker:
                tracker.on_heartbeat(addr[0], keys, players)
            if srv is None:
                srv = self.pending.get(key) or GameServer(addr[0], addr[1])
                srv.keys, srv.players, srv.teams = keys, players, teams
                self.pending[key] = srv
                log.event("QR2", "CHALLENGE", "INFO", "new server, sending challenge", user=srv.name, ip=addr)
                self.send(b"\xfe\xfd\x01" + inst + CHALLENGE_TAIL, addr, note="challenge")
                return
            srv.keys, srv.players, srv.teams = keys, players, teams
            srv.last_ping = time.time()
            was_valid = srv.valid
            srv.valid = srv.check_valid()
            if srv.valid and not was_valid:
                log.event("QR2", "LISTED", "INFO", "server is now valid and listed", user=srv.name, ip=addr)
            elif not srv.valid:
                log.event("QR2", "HEARTBEAT", "WARN",
                          "server not listed: needs gamename/hostname/gametype/mapname, hostport>1024, maxplayers>0",
                          user=srv.name, ip=addr)
            return

        if ptype == 0x01:
            # challenge response - accepted without checking (same as C#)
            srv = self.pending.pop(key, None) or self.servers.get(key) or GameServer(addr[0], addr[1])
            srv.registered = True
            srv.last_ping = time.time()
            srv.valid = srv.check_valid()
            self.servers[key] = srv
            log.event("QR2", "REGISTERED", "INFO",
                      "challenge answered, server registered" + (" and listed" if srv.valid else " (not yet listed: missing keys)"),
                      user=srv.name, ip=addr, response=data[5:].split(b"\x00")[0].decode("latin-1", "replace"))
            self.send(b"\xfe\xfd\x0a" + inst, addr, note="client registered")
            return

        if ptype == 0x08:
            srv = self.servers.get(key)
            if srv:
                srv.last_ping = time.time()
                log.event("QR2", "KEEPALIVE", "DEBUG", "keep-alive", user=srv.name, ip=addr)
            else:
                log.event("QR2", "KEEPALIVE", "WARN", "keep-alive from unknown server", ip=addr)
            return

        if ptype == 0x07:
            log.event("QR2", "CLIENT_MESSAGE_ACK", "INFO", "server acked a client message", user=user, ip=addr)
            return

        log.event("QR2", tname, "WARN", "unhandled QR2 packet type (no reply)", user=user, ip=addr)

    # -- list for the server browser ---------------------------------------
    def listed_servers(self) -> list[GameServer]:
        return [s for s in self.servers.values() if s.valid]

    def server_conn(self, srv: GameServer) -> int | None:
        """Log number of a game server's UDP address (lines from timers have no packet context)."""
        return self._peer_ids.get((srv.ip, srv.query_port))

    async def cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(10)
            limit = time.time() - Config.QR_SERVER_TIMEOUT
            for key, srv in list(self.servers.items()):
                if srv.last_ping < limit:
                    log.event("QR2", "EXPIRED", "INFO",
                              f"removed: no heartbeat/keep-alive for {Config.QR_SERVER_TIMEOUT}s", user=srv.name, ip=key,
                              conn=self.server_conn(srv))
                    del self.servers[key]
            for key, srv in list(self.pending.items()):
                if srv.first_seen < time.time() - 120:
                    log.event("QR2", "EXPIRED", "WARN", "never answered the challenge, dropped", user=srv.name, ip=key,
                              conn=self.server_conn(srv))
                    del self.pending[key]

    async def summary_loop(self) -> None:
        while True:
            await asyncio.sleep(300)
            log.event("QR2", "SUMMARY", "INFO", f"{len(self.servers)} registered, {len(self.listed_servers())} listed, "
                      f"{len(self.pending)} waiting for challenge")
            for s in self.servers.values():
                log.event("QR2", "SUMMARY", "INFO", "listed" if s.valid else "not listed", user=s.name, ip=s.key,
                          conn=self.server_conn(s), map=s.keys.get("mapname"), players=f"{s.keys.get('numplayers', '?')}/{s.keys.get('maxplayers', '?')}",
                          hostport=s.keys.get("hostport"))

