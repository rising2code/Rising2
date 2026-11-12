"""Which map a match was played on (docs/map_tracking.md).

The match report carries no map. QR2 heartbeats do, but QR2 never says which GP
account a game server uses, and Competition calls carry only the account. The admin
links the two with R2_SERVER_ACCOUNTS=IP:HOSTPORT=NICK,...  Without that setting
this module is off and report.map is "".

Heartbeats are kept in memory only: the last HISTORY per configured server.
"""
from __future__ import annotations

import time
from collections import Counter, deque

from . import log
from .config import Config

HISTORY = 5


class Snapshot:
    __slots__ = ("time", "map", "gametype", "players")

    def __init__(self, t: float, map_: str, gametype: str, players: set[str]) -> None:
        self.time = t
        self.map = map_
        self.gametype = gametype
        self.players = players


def parse_setting(text: str) -> tuple[dict[tuple[str, int], str], list[str]]:
    """'1.2.3.4:27015=srv_eu1,...' -> ({(ip, hostport): nick}, [errors])."""
    servers: dict[tuple[str, int], str] = {}
    errors: list[str] = []
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        addr, sep, nick = part.partition("=")
        ip, sep2, port = addr.strip().rpartition(":")
        ip = ip.strip("[]")
        nick = nick.strip()
        if not sep or not sep2 or not ip or not nick:
            errors.append(f"'{part}': expected IP:HOSTPORT=NICK")
            continue
        try:
            p = int(port)
        except ValueError:
            errors.append(f"'{part}': port '{port}' is not a number")
            continue
        if not 0 < p <= 65535:
            errors.append(f"'{part}': port {p} out of range")
            continue
        if (ip, p) in servers:
            errors.append(f"'{part}': {ip}:{p} listed twice, keeping '{servers[(ip, p)]}'")
            continue
        servers[(ip, p)] = nick
    return servers, errors


def _player_names(players: list[dict]) -> set[str]:
    names = set()
    for p in players:
        n = p.get("player_") or p.get("player") or next((v for k, v in p.items() if k.startswith("player")), "")
        if n and n.strip():
            names.add(n.strip().lower())
    return names


def _name_hits(report_nicks: set[str], snap_names: set[str]) -> int:
    """Report nicks seen in a heartbeat. Loose (either name inside the other), since in-game
    names may carry a clan tag or be cut short. Only a sanity check, never decides the map."""
    return sum(1 for n in report_nicks
               if any(n == s or (min(len(n), len(s)) >= 3 and (n in s or s in n)) for s in snap_names))


class MapTracker:
    def __init__(self, ctx) -> None:
        self.ctx = ctx
        self.servers, errors = parse_setting(Config.SERVER_ACCOUNTS)
        self.enabled = bool(self.servers)
        self.history: dict[tuple[str, int], deque] = {k: deque(maxlen=HISTORY) for k in self.servers}
        self._unmapped_seen: set[tuple[str, int]] = set()
        for e in errors:
            log.event("MAP", "CONFIG", "WARN", f"R2_SERVER_ACCOUNTS entry ignored: {e}")

    def start(self) -> None:
        if not self.enabled:
            why = "R2_SERVER_ACCOUNTS is not set" if not Config.SERVER_ACCOUNTS.strip() else \
                "R2_SERVER_ACCOUNTS has no valid entry"
            log.event("MAP", "TRACKING", "INFO", f"map tracking DISABLED: {why} - report.map will be \"\"")
            return
        for (ip, port), nick in self.servers.items():
            acct = self.ctx.db.login.get_user(nick)
            if acct:
                log.event("MAP", "CONFIG", "INFO", "game server linked to account", user=nick, ip=f"{ip}:{port}",
                          profileid=acct["profileid"])
            else:
                log.event("MAP", "CONFIG", "WARN", "account not in login DB (yet) - its reports get no map until it exists",
                          user=nick, ip=f"{ip}:{port}")
        log.event("MAP", "TRACKING", "INFO", f"map tracking ENABLED for {len(self.servers)} game server(s), "
                  f"keeping the last {HISTORY} heartbeats each (memory only)")

    # -- QR2 side ------------------------------------------------------------
    def on_heartbeat(self, ip: str, keys: dict[str, str], players: list[dict]) -> None:
        if not self.enabled:
            return
        try:
            hostport = int(keys.get("hostport", ""))
        except ValueError:
            return
        k = (ip, hostport)
        hist = self.history.get(k)
        if hist is None:
            if k not in self._unmapped_seen:
                self._unmapped_seen.add(k)
                log.event("MAP", "UNMAPPED", "INFO", "heartbeat from a game server not in R2_SERVER_ACCOUNTS "
                          "(its matches get no map)", user=keys.get("hostname"), ip=f"{ip}:{hostport}",
                          map=keys.get("mapname"))
            return
        snap = Snapshot(time.time(), keys.get("mapname", "") or "", keys.get("gametype", "") or "",
                        _player_names(players))
        if hist and hist[-1].map != snap.map:
            log.event("MAP", "CHANGED", "INFO", f"map changed {hist[-1].map!r} -> {snap.map!r}",
                      user=self.servers[k], ip=f"{ip}:{hostport}", gametype=snap.gametype)
        hist.append(snap)

    # -- Competition side ------------------------------------------------------
    def _server_for(self, profileid: int | None, nick: str | None) -> tuple[tuple[str, int] | None, str]:
        if not profileid:
            return None, "no profileid in the server's certificate"
        u = self.ctx.db.login.get_by_profileid(profileid)
        name = (u["name"] if u else nick or "").lower()
        hits = [k for k, n in self.servers.items() if n.lower() == name]
        if not hits:
            return None, f"account '{u['name'] if u else nick}' is not in R2_SERVER_ACCOUNTS"
        if len(hits) > 1:
            return None, "account listed for several servers in R2_SERVER_ACCOUNTS: " + \
                ", ".join(f"{ip}:{p}" for ip, p in hits)
        return hits[0], ""

    def current(self, profileid: int | None, nick: str | None) -> tuple[str, str]:
        """Map running right now on this account's server (for the CreateSession log line)."""
        if not self.enabled:
            return "", ""
        k, _ = self._server_for(profileid, nick)
        hist = self.history.get(k) if k else None
        return (hist[-1].map, hist[-1].gametype) if hist else ("", "")

    def for_report(self, profileid: int | None, nick: str | None, started: float | None,
                   report_nicks: set[str], **ctx_fields) -> tuple[str, str]:
        """(map, gametype) of the match a report belongs to, or ("", "") with a log line saying why."""
        if not self.enabled:
            log.event("MAP", "REPORT", "INFO", "map unknown: tracking disabled (R2_SERVER_ACCOUNTS not set)",
                      user=nick, **ctx_fields)
            return "", ""
        k, why = self._server_for(profileid, nick)
        if not k:
            log.event("MAP", "REPORT", "WARN", f"map unknown: {why}", user=nick, **ctx_fields)
            return "", ""
        addr = f"{k[0]}:{k[1]}"
        hist = list(self.history[k])
        if not hist:
            log.event("MAP", "REPORT", "WARN", "map unknown: no heartbeat from this game server since start "
                      "(LAN game, not listed, or this server restarted during the match)",
                      user=nick, server=addr, **ctx_fields)
            return "", ""
        now = time.time()
        start = started if started else now
        nicks = {n.lower() for n in report_nicks if n}
        window = [s for s in hist if start <= s.time <= now]
        with_players = [s for s in window if nicks and _name_hits(nicks, s.players)]
        if window:
            cands = with_players or window
            counts = Counter(s.map for s in cands)
            best = max(counts.values())
            chosen = next(s for s in cands if counts[s.map] == best)  # earliest among the most common
            how = (f"{counts[chosen.map]}/{len(cands)} heartbeats during the match"
                   + (" that list its players" if with_players else ""))
        else:
            before = [s for s in hist if s.time < start]
            chosen = before[-1] if before else hist[0]
            how = "last heartbeat before the match started" if before else "first heartbeat after the window"
        seen_anywhere = any(_name_hits(nicks, s.players) for s in hist) if nicks else False
        maps_seen = ",".join(dict.fromkeys(s.map for s in window)) or "-"
        last_age = int(now - hist[-1].time)
        level = "INFO"
        notes = []
        if nicks and not seen_anywhere:
            level = "WARN"
            notes.append("none of the report's players appear in this server's heartbeats (map used anyway)")
        if last_age > max(Config.QR_SERVER_TIMEOUT, 60) * 2:
            level = "WARN"
            notes.append(f"last heartbeat was {last_age}s ago")
        log.event("MAP", "REPORT", level, f"map {chosen.map!r} ({how})" + ("; " + "; ".join(notes) if notes else ""),
                  user=nick, server=addr, gametype=chosen.gametype, maps_during_match=maps_seen,
                  match_secs=int(now - start) if started else None, **ctx_fields)
        return chosen.map, chosen.gametype
