"""DIME message parsing and the GameSpy ATLAS (Competition) binary report format.

Layout taken from the public GameSpy SDK (nitrocaster/GameSpy, src/GameSpy/sc:
sciReport.h/.c, sciMain.c, sciSerialize.c). All integers big-endian except
FLOAT values, which the SDK memcpy's in host (little-endian) order.

  header (68 bytes)
    u32 protocol (2), u32 developer version, u8[16] md5 checksum,
    u32 game status (0 complete,1 partial,2 broken), u32 flags,
    u16 players, u16 teams, u16 game keys, u16 player keys, u16 team keys, u16 reserved,
    u32 roster len, u32 auth len, u32 results len, u32 game len, u32 player len, u32 team len
  roster   20 bytes / player : 16-byte connection GUID (ccid) + i32 team id
  auth     16 bytes / player : (zeros in the SDK)
  results  i32 / player, then i32 / team  (0 win,1 loss,2 draw,3 disconnect,4 desync,5 none)
  game     key/values until section end (no count prefix)
  players  per player: u16 key count + key/values
  teams    per team:   u16 key count + key/values
  key/value: u16 key id, u16 type, value
    type 0 INT32 (4), 1 INT16 (2), 2 BYTE (1), 3 STRING (len prefix, no NUL), 4 FLOAT (4, LE), 5 INT64 (8)
    string length prefix = (len//127 + 1) bytes, each equal to len & 0xFF
"""
from __future__ import annotations

import hashlib
import struct
import uuid

HEADER = struct.Struct(">II16sIIHHHHHHIIIIII")
assert HEADER.size == 68

KEYTYPES = {0: "INT32", 1: "INT16", 2: "BYTE", 3: "STRING", 4: "FLOAT", 5: "INT64"}
STATUS = {0: "COMPLETE", 1: "PARTIAL", 2: "BROKEN"}
RESULTS = {0: "WIN", 1: "LOSS", 2: "DRAW", 3: "DISCONNECT", 4: "DESYNC", 5: "NONE"}
FLAGS = {1: "AUTHORITATIVE", 2: "NON_RELATIVE_RESULT", 4: "MATCHLESS_SESSION"}


# ------------------------------------------------------------------ DIME ----

def parse_dime(body: bytes) -> list[dict]:
    recs = []
    pos = 0

    def pad(n: int) -> int:
        return (n + 3) & ~3

    while pos + 12 <= len(body):
        b0, b1, optlen, idlen, typelen, datalen = struct.unpack(">BBHHHI", body[pos:pos + 12])
        pos += 12
        pos += pad(optlen)
        rid = body[pos:pos + idlen].decode("latin-1"); pos += pad(idlen)
        rtype = body[pos:pos + typelen].decode("latin-1"); pos += pad(typelen)
        data = body[pos:pos + datalen]; pos += pad(datalen)
        recs.append({"version": b0 >> 3, "mb": bool(b0 & 4), "me": bool(b0 & 2), "cf": bool(b0 & 1),
                     "type_t": b1 >> 4, "id": rid, "type": rtype, "data": data})
        if b0 & 2:
            break
    return recs


# ---------------------------------------------------------------- report ----

class ReportError(Exception):
    pass


def _kv_section(buf: bytes, pos: int, end: int, count: int | None) -> tuple[dict[int, object], list[dict], int]:
    """Read key/values. count=None -> until end. Returns (values, details, newpos)."""
    vals: dict[int, object] = {}
    details: list[dict] = []
    n = 0
    while (pos < end) if count is None else (n < count):
        if pos + 4 > end:
            raise ReportError(f"key header past section end at {pos}")
        key, ktype = struct.unpack(">HH", buf[pos:pos + 4])
        pos += 4
        if ktype == 0:
            v = struct.unpack(">i", buf[pos:pos + 4])[0]; pos += 4
        elif ktype == 1:
            v = struct.unpack(">h", buf[pos:pos + 2])[0]; pos += 2
        elif ktype == 2:
            v = buf[pos]; pos += 1
        elif ktype == 3:
            first = buf[pos]
            # SDK writes (len//127 + 1) copies of (len & 0xff); find the first length consistent with that
            slen, nlen = first, 1
            for m in range(4):
                cand = first + 256 * m
                need = cand // 127 + 1
                if all(pos + j < end and buf[pos + j] == first for j in range(need)) and pos + need + cand <= end:
                    slen, nlen = cand, need
                    break
            pos += nlen
            v = buf[pos:pos + slen].decode("latin-1"); pos += slen
        elif ktype == 4:
            v = struct.unpack("<f", buf[pos:pos + 4])[0]; pos += 4
        elif ktype == 5:
            v = struct.unpack(">q", buf[pos:pos + 8])[0]; pos += 8
        else:
            raise ReportError(f"unknown key type {ktype} for key {key} at {pos - 4}")
        if pos > end:
            raise ReportError(f"value of key {key} runs past section end")
        vals[key] = v
        details.append({"key": key, "key_hex": f"0x{key:x}", "type": KEYTYPES[ktype], "value": v})
        n += 1
    return vals, details, pos


def parse_report(buf: bytes) -> dict:
    if len(buf) < HEADER.size:
        raise ReportError(f"report too short ({len(buf)} bytes)")
    (proto, devver, checksum, status, flags, nplayers, nteams, ngamekeys, nplayerkeys, nteamkeys, _res,
     roster_len, auth_len, results_len, game_len, player_len, team_len) = HEADER.unpack_from(buf, 0)

    zeroed = buf[:8] + b"\x00" * 16 + buf[24:]
    checksum_ok = hashlib.md5(zeroed).digest() == checksum

    out: dict = {
        "header": {
            "protocol": proto, "developer_version": devver, "checksum": checksum.hex(), "checksum_ok": checksum_ok,
            "game_status": status, "game_status_name": STATUS.get(status, "?"), "flags": flags,
            "flag_names": [n for b, n in FLAGS.items() if flags & b],
            "players": nplayers, "teams": nteams, "game_keys": ngamekeys, "player_keys": nplayerkeys,
            "team_keys": nteamkeys,
            "sections": {"roster": roster_len, "auth": auth_len, "results": results_len, "game": game_len,
                         "player": player_len, "team": team_len},
        },
        "warnings": [],
    }
    if proto != 2:
        out["warnings"].append(f"protocol {proto} (expected 2)")
    total = HEADER.size + roster_len + auth_len + results_len + game_len + player_len + team_len
    if total != len(buf):
        out["warnings"].append(f"section lengths add up to {total}, report is {len(buf)} bytes")

    pos = HEADER.size
    players = []
    for i in range(nplayers):
        g = buf[pos + 20 * i: pos + 20 * i + 16]
        team = struct.unpack(">i", buf[pos + 20 * i + 16: pos + 20 * i + 20])[0]
        players.append({"idx": i, "ccid": str(uuid.UUID(bytes=g)) if len(g) == 16 else g.hex(), "team": team})
    pos += roster_len
    pos += auth_len
    rstart = pos
    for i, p in enumerate(players):
        if rstart + 4 * i + 4 <= len(buf):
            r = struct.unpack(">i", buf[rstart + 4 * i: rstart + 4 * i + 4])[0]
            p["result"], p["result_name"] = r, RESULTS.get(r, "?")
    teams = []
    for t in range(nteams):
        o = rstart + 4 * nplayers + 4 * t
        r = struct.unpack(">i", buf[o:o + 4])[0] if o + 4 <= len(buf) else None
        teams.append({"idx": t, "result": r, "result_name": RESULTS.get(r, "?")})
    pos += results_len

    gend = pos + game_len
    out["game"], out["game_details"], _ = _kv_section(buf, pos, gend, None)
    pos = gend

    pend = pos + player_len
    for p in players:
        if pos >= pend:
            out["warnings"].append(f"player section ended before player {p['idx']}")
            p["keys"], p["key_details"] = {}, []
            continue
        cnt = struct.unpack(">H", buf[pos:pos + 2])[0]
        pos += 2
        p["keys"], p["key_details"], pos = _kv_section(buf, pos, pend, cnt)
    pos = pend

    tend = pos + team_len
    for t in teams:
        if pos >= tend:
            t["keys"], t["key_details"] = {}, []
            continue
        cnt = struct.unpack(">H", buf[pos:pos + 2])[0]
        pos += 2
        t["keys"], t["key_details"], pos = _kv_section(buf, pos, tend, cnt)

    out["players"] = players
    out["teams"] = teams
    return out


# ------------------------------------------------- builder (for self tests) ---

def build_report(players: list[dict], teams: list[dict], game: dict, status: int = 0, flags: int = 1,
                 devver: int = 1) -> bytes:
    """players: [{ccid, team, result, keys:{id:(type,value)}}]  teams: [{result, keys}]  game: {id:(type,value)}"""

    def kv(d: dict) -> bytes:
        b = b""
        for k, (t, v) in d.items():
            b += struct.pack(">HH", k, t)
            if t == 0:
                b += struct.pack(">i", v)
            elif t == 1:
                b += struct.pack(">h", v)
            elif t == 2:
                b += bytes([v])
            elif t == 3:
                raw = v.encode("latin-1")
                b += bytes([len(raw) & 0xFF]) * (len(raw) // 127 + 1) + raw
            elif t == 4:
                b += struct.pack("<f", v)
            elif t == 5:
                b += struct.pack(">q", v)
        return b

    roster = b"".join(uuid.UUID(p["ccid"]).bytes + struct.pack(">i", p["team"]) for p in players)
    auth = b"\x00" * 16 * len(players)
    results = b"".join(struct.pack(">i", p["result"]) for p in players) + \
        b"".join(struct.pack(">i", t["result"]) for t in teams)
    gsec = kv(game)
    psec = b"".join(struct.pack(">H", len(p["keys"])) + kv(p["keys"]) for p in players)
    tsec = b"".join(struct.pack(">H", len(t["keys"])) + kv(t["keys"]) for t in teams)
    nplayerkeys = max((len(p["keys"]) for p in players), default=0)
    nteamkeys = max((len(t["keys"]) for t in teams), default=0)
    hdr = HEADER.pack(2, devver, b"\x00" * 16, status, flags, len(players), len(teams), len(game), nplayerkeys,
                      nteamkeys, 0, len(roster), len(auth), len(results), len(gsec), len(psec), len(tsec))
    buf = hdr + roster + auth + results + gsec + psec + tsec
    digest = hashlib.md5(buf).digest()
    return buf[:8] + digest + buf[24:]


def build_dime(soap_xml: bytes, report: bytes) -> bytes:
    def rec(flags: int, type_t: int, rid: bytes, rtype: bytes, data: bytes) -> bytes:
        def pad(b: bytes) -> bytes:
            return b + b"\x00" * ((4 - len(b) % 4) % 4)
        return struct.pack(">BBHHHI", 0x08 | flags, type_t, 0, len(rid), len(rtype), len(data)) + \
            pad(rid) + pad(rtype) + pad(data)

    return rec(0x04, 0x20, b"cid:id0", b"http://schemas.xmlsoap.org/soap/envelope/", soap_xml) + \
        rec(0x02, 0x10, b"report", b"application/bin", report)
