#!/usr/bin/env python3
"""End-to-end smoke test: talks to a running Rising2 server like the game would.

  python tools/selftest.py [--host 127.0.0.1] [--http-port 80]

Creates two throw-away accounts (random names), logs in, registers a fake
game server via QR2, fetches + decrypts the server list, checks a CD key, runs
a full Competition flow (CreateSession, SetReportIntention x3, SubmitReport
with a DIME report) and verifies that PlayerStats_v1 changed.

Season test (when config/seasons/ of the server is reachable from here, e.g. run
inside the container): switches to a new season, checks players start from zero,
checks a match keeps the season it started in, then restores current.txt.

Run it against a server with a THROW-AWAY data dir.
"""
from __future__ import annotations

import argparse
import base64
import http.client
import os
import random
import re
import socket
import string
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rising2 import gs_crypto as gc  # noqa: E402
from rising2.report import build_dime, build_report  # noqa: E402

OK, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
results: list[tuple[str, bool]] = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    results.append((name, cond))
    print(f"[{OK if cond else FAIL}] {name} {detail}")
    return cond


def passenc(pw: str) -> str:
    return base64.b64encode(gc.gs_encode(pw.encode())).decode().replace("+", "[").replace("/", "]").replace("=", "_")


def tcp_exchange(host, port, send: bytes | None, until: bytes = b"\\final\\", first_read=False, timeout=5) -> bytes:
    s = socket.create_connection((host, port), timeout=timeout)
    data = b""
    try:
        if send:
            s.sendall(send)
        while until not in data:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    finally:
        s.close()
    return data


def soap(host, port, path, action, body_xml: str | bytes, ctype="text/xml", raw=False) -> str:
    c = http.client.HTTPConnection(host, port, timeout=10)
    body = body_xml.encode() if isinstance(body_xml, str) else body_xml
    c.request("POST", path, body=body, headers={"SOAPAction": f'"{action}"', "Content-Type": ctype,
                                                 "User-Agent": "GameSpyHTTP/1.0"})
    r = c.getresponse()
    out = r.read().decode("utf-8", "replace")
    c.close()
    return out


def env(ns_prefix, ns, inner) -> str:
    return (f'<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" '
            f'xmlns:{ns_prefix}="{ns}"><SOAP-ENV:Body>{inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>')


def cert_xml(cert_block: str) -> str:
    # reuse the certificate exactly as the AuthService returned it (ns1: -> gsc:)
    return cert_block.replace("ns1:", "gsc:")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=80)
    ap.add_argument("--seasons-dir", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                                          "config", "seasons"),
                    help="the server's config/seasons folder (season test runs only if it exists)")
    ap.add_argument("--no-season-test", action="store_true")
    ap.add_argument("--tag", help="fixed account suffix (alice_<tag>), e.g. to list alice_<tag> in R2_SERVER_ACCOUNTS")
    ap.add_argument("--expect-map", default="",
                    help="map the match report must get (x_range when the server runs with "
                         "R2_SERVER_ACCOUNTS=127.0.0.1:29023=alice_<tag>); default: map must be \"\"")
    a = ap.parse_args()
    H = a.host
    tag = a.tag or "".join(random.choice(string.ascii_lowercase) for _ in range(5))
    users = [(f"alice_{tag}", "pw_alice", f"alice_{tag}@test.local"), (f"bob_{tag}", "pw_bob", f"bob_{tag}@test.local")]
    profiles = {}

    # ---------------------------------------------------------------- GPSP
    for nick, pw, email in users:
        r = tcp_exchange(H, 29901, f"\\newuser\\\\email\\{email}\\nick\\{nick}\\passenc\\{passenc(pw)}\\productid\\11067\\gamename\\risingeaglepc\\id\\1\\final\\".encode())
        m = re.search(rb"\\nur\\0\\pid\\(\d+)", r)
        check(f"GPSP newuser {nick}", bool(m), r.decode("latin-1"))
        if m:
            profiles[nick] = int(m.group(1))
    r = tcp_exchange(H, 29901, f"\\nicks\\\\email\\{users[0][2]}\\passenc\\{passenc(users[0][1])}\\namespaceid\\0\\gamename\\risingeaglepc\\final\\".encode())
    check("GPSP nicks", users[0][0].encode() in r, r.decode("latin-1"))
    r = tcp_exchange(H, 29901, f"\\check\\\\nick\\{users[0][0]}\\passenc\\{passenc(users[0][1])}\\gamename\\risingeaglepc\\final\\".encode())
    check("GPSP check password", r.startswith(b"\\cur\\0\\"), r.decode("latin-1"))

    # ---------------------------------------------------------------- GPCM
    tickets = {}
    for nick, pw, email in users:
        s = socket.create_connection((H, 29900), timeout=5)
        hello = s.recv(4096).decode("latin-1")
        schal = re.search(r"\\challenge\\([^\\]+)", hello).group(1)
        cchal = gc.random_string(32)
        md5pw = gc.md5_hex(pw)
        resp = gc.gp_response(md5pw, nick, cchal, schal)
        s.sendall(f"\\login\\\\challenge\\{cchal}\\uniquenick\\{nick}\\response\\{resp}\\port\\0\\productid\\11067\\gamename\\risingeaglepc\\namespaceid\\2\\sdkrevision\\3\\id\\1\\final\\".encode())
        data = b""
        while b"\\final\\" not in data:
            data += s.recv(4096)
        t = data.decode("latin-1")
        proof_ok = f"\\proof\\{gc.gp_response(md5pw, nick, schal, cchal)}\\" in t
        check(f"GPCM login {nick}", "\\lc\\2\\" in t and proof_ok, t)
        lt = re.search(r"\\lt\\([^\\]+)", t)
        if lt:
            tickets[nick] = lt.group(1)
        s.sendall(f"\\getprofile\\\\sesskey\\1\\profileid\\{profiles.get(nick)}\\id\\2\\final\\".encode())
        data = b""
        while b"\\final\\" not in data:
            data += s.recv(4096)
        check(f"GPCM getprofile {nick}", b"\\pi\\" in data, data.decode("latin-1")[:120])
        s.sendall(b"\\logout\\\\sesskey\\1\\final\\")
        s.close()
    r = tcp_exchange(H, 29900, None)
    s = socket.create_connection((H, 29900), timeout=5); s.recv(4096)
    s.sendall(f"\\login\\\\challenge\\x\\uniquenick\\{users[0][0]}\\response\\deadbeef\\id\\1\\final\\".encode())
    check("GPCM wrong password rejected", b"\\err\\260" in s.recv(4096)); s.close()

    # ---------------------------------------------------------------- QR2
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.settimeout(3)
    u.sendto(b"\x09\x00\x00\x00\x00risingeaglepc\x00", (H, 27900))
    try:
        r, _ = u.recvfrom(1024)
        check("QR2 availability", r == b"\xfe\xfd\x09\x00\x00\x00\x00", r.hex())
    except socket.timeout:
        check("QR2 availability", False, "timeout")
    hostname = f"Rising2 selftest {tag}"
    keys = {"hostname": hostname, "gamename": "risingeaglepc", "gamever": "1.3.1", "mapname": "x_range",
            "gametype": "ctf", "numplayers": "2", "maxplayers": "32", "hostport": "29023", "password": "0",
            "statechanged": "1"}
    body = b"".join(k.encode() + b"\x00" + v.encode() + b"\x00" for k, v in keys.items()) + b"\x00"
    body += struct.pack(">H", 2) + b"player_\x00score_\x00\x00" + b"alice\x0010\x00bob\x005\x00"
    body += struct.pack(">H", 0) + b"team_t\x00\x00"
    inst = b"\x11\x22\x33\x44"
    u.sendto(b"\x03" + inst + body, (H, 27900))
    try:
        r, _ = u.recvfrom(1024)
        check("QR2 heartbeat -> challenge", r[:3] == b"\xfe\xfd\x01", r.hex())
    except socket.timeout:
        check("QR2 heartbeat -> challenge", False, "timeout")
    u.sendto(b"\x01" + inst + b"rbugJ44d4z+fax0/ttVVFdGbMz8A\x00", (H, 27900))
    try:
        r, _ = u.recvfrom(1024)
        check("QR2 challenge response -> registered", r == b"\xfe\xfd\x0a" + inst, r.hex())
    except socket.timeout:
        check("QR2 challenge response -> registered", False, "timeout")
    u.sendto(b"\x08" + inst, (H, 27900))

    # ---------------------------------------------------------------- SB
    validate = b"Ab3dEf7h"
    fields = "\\hostname\\gamever\\mapname\\numplayers\\maxplayers\\hostport"
    flt = "numplayers >= 0 and gametype like '%ctf%'"
    req = bytes([0, 1, 3]) + struct.pack(">I", 0) + b"risingeaglepc\x00risingeaglepc\x00" + validate + flt.encode() + b"\x00" + fields.encode() + b"\x00" + struct.pack(">I", 0)
    req = struct.pack(">H", len(req) + 2) + req
    enc = tcp_exchange(H, 28910, req, until=b"\xff\xff\xff\xff__never__", timeout=3)
    try:
        plain = gc.enctypex_decode(b"9cy8vc", validate, enc)
        check("SB list decrypts and contains our server", hostname.encode() in plain and plain.endswith(b"\x00\xff\xff\xff\xff"),
              f"{len(enc)} bytes")
    except Exception as e:
        check("SB list decrypts and contains our server", False, repr(e))

    # ---------------------------------------------------------------- CDKEY
    msg = "\\auth\\\\pid\\1059\\ch\\abcdefgh\\resp\\" + "a" * 72 + "\\ip\\16777343\\skey\\42\\reqproof\\1\\"
    u.sendto(gc.xor_gamespy(msg.encode()), (H, 29910))
    try:
        r, _ = u.recvfrom(1024)
        t = gc.xor_gamespy(r).decode()
        check("CDKEY auth -> uok", t.startswith("\\uok\\") and "\\skey\\42" in t, t)
    except socket.timeout:
        check("CDKEY auth -> uok", False, "timeout")
    u.sendto(b"\xfd\xfc\x1e\x66\x6a\xb2\x03\x00\x00\x00\x00\x01", (H, 27901))  # natneg: only logged

    # ---------------------------------------------------------------- HTTP
    c = http.client.HTTPConnection(H, a.http_port, timeout=5)
    c.request("GET", "/motd/motd.asp?userid=1&productid=11067&gamename=risingeaglepc")
    check("HTTP motd", c.getresponse().status == 200)
    c.close()

    certs = {}
    for nick, pw, _ in users:
        x = soap(H, a.http_port, "/AuthService/AuthService.asmx", "http://gamespy.net/AuthService/LoginUniqueNick",
                 env("ns1", "http://gamespy.net/AuthService/",
                     f"<ns1:LoginUniqueNick><ns1:version>1</ns1:version><ns1:partnercode>11067</ns1:partnercode>"
                     f"<ns1:namespaceid>2</ns1:namespaceid><ns1:uniquenick>{nick}</ns1:uniquenick>"
                     f"<ns1:password><ns1:Value>00</ns1:Value></ns1:password></ns1:LoginUniqueNick>"))
        m = re.search(r"<ns1:certificate>.*</ns1:certificate>", x, re.S)
        check(f"Auth LoginUniqueNick {nick}", bool(m) and "<ns1:responseCode>0<" in x)
        certs[nick] = cert_xml(m.group(0)) if m else ""
        check(f"Auth certificate carries {nick}'s profileid", f"<ns1:profileid>{profiles.get(nick)}<" in x)

    def sake_stats(nick):
        x = soap(H, a.http_port, "/SakeStorageServer/StorageServer.asmx", "http://gamespy.net/sake/SearchForRecords",
                 env("ns1", "http://gamespy.net/sake",
                     f"<ns1:SearchForRecords><ns1:gameid>1693</ns1:gameid><ns1:secretKey>9cy8vc</ns1:secretKey>"
                     f"<ns1:loginTicket>{tickets.get(nick, '')}</ns1:loginTicket><ns1:tableid>PlayerStats_v1</ns1:tableid>"
                     f"<ns1:filter>ownerid = {profiles.get(nick)}</ns1:filter><ns1:sort>TotalSkill desc</ns1:sort>"
                     f"<ns1:offset>0</ns1:offset><ns1:max>1</ns1:max><ns1:targetfilter/><ns1:surrounding>0</ns1:surrounding>"
                     f"<ns1:ownerids/><ns1:cacheFlag>0</ns1:cacheFlag><ns1:fields><ns1:string>ownerid</ns1:string>"
                     f"<ns1:string>TotalSkill</ns1:string><ns1:string>Rank</ns1:string><ns1:string>TotalSessions</ns1:string>"
                     f"<ns1:string>row</ns1:string><ns1:string>Rising2SelftestColumn</ns1:string></ns1:fields></ns1:SearchForRecords>"))
        vals = re.findall(r"<ns1:value>([^<]*)</ns1:value>", x)
        return vals, x

    before = {n: sake_stats(n)[0] for n, _, _ in users}
    v, x = sake_stats(users[0][0])
    check("Sake SearchForRecords PlayerStats_v1", len(v) == 5 and v[0] == str(profiles.get(users[0][0])) and "<ns1:RecordValue/>" in x,
          str(v))

    x = soap(H, a.http_port, "/SakeStorageServer/StorageServer.asmx", "http://gamespy.net/sake/UpdateRecord",
             env("ns1", "http://gamespy.net/sake",
                 f"<ns1:UpdateRecord><ns1:gameid>1693</ns1:gameid><ns1:secretKey>9cy8vc</ns1:secretKey>"
                 f"<ns1:loginTicket>{tickets.get(users[0][0], '')}</ns1:loginTicket><ns1:tableid>PersonalInfo</ns1:tableid>"
                 f"<ns1:recordid>{profiles[users[0][0]] - 100000000}</ns1:recordid><ns1:values><ns1:RecordField><ns1:name>LastGameDate</ns1:name>"
                 f"<ns1:value><ns1:dateAndTimeValue><ns1:value>2026-11-11T10:00:00Z</ns1:value></ns1:dateAndTimeValue></ns1:value>"
                 f"</ns1:RecordField></ns1:values></ns1:UpdateRecord>"))
    check("Sake UpdateRecord PersonalInfo.LastGameDate", "<ns1:UpdateRecordResult>Success<" in x)

    # ---------------------------------------------------------------- COMPETITION
    NS = "http://gamespy.net/competition/"
    host_cert = certs[users[0][0]]
    x = soap(H, a.http_port, "/CompetitionService/CompetitionService.asmx", NS + "CreateSession",
             env("gsc", NS, f"<gsc:CreateSession>{host_cert}<gsc:proof>0</gsc:proof><gsc:gameid>1693</gsc:gameid></gsc:CreateSession>"))
    csid = re.search(r"<ns1:csid>([^<]+)", x)
    hccid = re.search(r"<ns1:ccid>([^<]+)", x)
    check("Competition CreateSession", bool(csid and hccid) and "<ns1:result>0<" in x)
    csid, hccid = csid.group(1), hccid.group(1)

    def intention(cert, ccid=""):
        x = soap(H, a.http_port, "/CompetitionService/CompetitionService.asmx", NS + "SetReportIntention",
                 env("gsc", NS, f"<gsc:SetReportIntention>{cert}<gsc:proof>0</gsc:proof><gsc:csid>{csid}</gsc:csid>"
                                f"<gsc:ccid>{ccid}</gsc:ccid><gsc:gameid>1693</gsc:gameid><gsc:authoritative>1</gsc:authoritative>"
                                f"</gsc:SetReportIntention>"))
        return re.search(r"<ns1:ccid>([^<]+)", x).group(1)

    intention(host_cert, hccid)
    ccids = {n: intention(certs[n]) for n, _, _ in users}
    check("Competition SetReportIntention (server + 2 clients)", all(ccids.values()))

    def submit(csid, hccid, ccids) -> str:
        players = [
            # key 18 = Squad Leader skill, key 14 = Trooper skill this match (the default TotalSkill is their sum)
            {"ccid": ccids[users[0][0]], "team": 1, "result": 0,
             "keys": {5: (0, 7), 6: (0, 3), 7: (3, "sniper"), 8: (4, 1.5), 18: (0, 4)}},
            {"ccid": ccids[users[1][0]], "team": 2, "result": 1,
             "keys": {5: (0, 2), 6: (0, 9), 9: (2, 4), 14: (0, -1), 999: (0, 1)}},
        ]
        report = build_report(players, [{"result": 0, "keys": {1: (0, 100)}}, {"result": 1, "keys": {1: (0, 50)}}],
                              {1: (3, "x_range"), 2: (0, 600)})
        xml = env("gsc", NS, f"<gsc:SubmitReport>{host_cert}<gsc:proof>0</gsc:proof><gsc:csid>{csid}</gsc:csid>"
                             f"<gsc:ccid>{hccid}</gsc:ccid><gsc:gameid>1693</gsc:gameid><gsc:authoritative>1</gsc:authoritative>"
                             f"</gsc:SubmitReport>").encode()
        return soap(H, a.http_port, "/CompetitionService/CompetitionService.asmx", NS + "SubmitReport",
                    build_dime(xml, report), ctype="application/dime")

    x = submit(csid, hccid, ccids)
    check("Competition SubmitReport (DIME)", "<ns1:result>0<" in x)

    import json as _json
    c = http.client.HTTPConnection(H, a.http_port, timeout=5)
    c.request("GET", "/rising2/reports")
    reps = _json.loads(c.getresponse().read() or b"[]")
    c.close()
    got_map = next((r.get("map") for r in reps if r.get("csid") == csid), None)
    check(f"Report map is {a.expect_map!r} (map tracking)", got_map == a.expect_map, f"got {got_map!r}")

    after = {n: sake_stats(n)[0] for n, _, _ in users}
    a0, b0 = before[users[0][0]], after[users[0][0]]
    check("Winner gained class skill (TotalSkill +4) and a session",
          len(b0) >= 4 and int(b0[1]) == int(a0[1]) + 4 and int(b0[3]) == int(a0[3]) + 1, f"{a0} -> {b0}")
    a1, b1 = before[users[1][0]], after[users[1][0]]
    check("Loser's TotalSkill floored at 0 (skill -1) and a session",
          len(b1) >= 4 and int(b1[1]) == max(0, int(a1[1]) - 1) and int(b1[3]) == int(a1[3]) + 1, f"{a1} -> {b1}")

    # ------------------------------------------------ profile "Update" button (clan tag)
    # The client opens its OWN session and reports itself: 44 = ViewMyProfile, 43 = nick, 46 = clan tag.
    me = users[0][0]
    x = soap(H, a.http_port, "/CompetitionService/CompetitionService.asmx", NS + "CreateSession",
             env("gsc", NS, f"<gsc:CreateSession>{certs[me]}<gsc:proof>0</gsc:proof><gsc:gameid>1693</gsc:gameid></gsc:CreateSession>"))
    pcsid, pccid = re.search(r"<ns1:csid>([^<]+)", x).group(1), re.search(r"<ns1:ccid>([^<]+)", x).group(1)
    soap(H, a.http_port, "/CompetitionService/CompetitionService.asmx", NS + "SetReportIntention",
         env("gsc", NS, f"<gsc:SetReportIntention>{certs[me]}<gsc:proof>0</gsc:proof><gsc:csid>{pcsid}</gsc:csid>"
                        f"<gsc:ccid>{pccid}</gsc:ccid><gsc:gameid>1693</gsc:gameid><gsc:authoritative>1</gsc:authoritative>"
                        f"</gsc:SetReportIntention>"))
    clan = f"R2{tag[:3]}"
    report = build_report([{"ccid": pccid, "team": 1, "result": 2, "keys": {44: (2, 1), 43: (3, me), 46: (3, clan)}}],
                          [{"result": 2, "keys": {}}], {})
    xml = env("gsc", NS, f"<gsc:SubmitReport>{certs[me]}<gsc:proof>0</gsc:proof><gsc:csid>{pcsid}</gsc:csid>"
                         f"<gsc:ccid>{pccid}</gsc:ccid><gsc:gameid>1693</gsc:gameid><gsc:authoritative>1</gsc:authoritative>"
                         f"</gsc:SubmitReport>").encode()
    x = soap(H, a.http_port, "/CompetitionService/CompetitionService.asmx", NS + "SubmitReport",
             build_dime(xml, report), ctype="application/dime")
    check("Profile update report (clan tag) accepted", "<ns1:result>0<" in x)
    p_after = sake_stats(me)[0]
    check("Profile update is not counted as a session", p_after[3] == after[me][3], f"{after[me]} -> {p_after}")
    x = soap(H, a.http_port, "/SakeStorageServer/StorageServer.asmx", "http://gamespy.net/sake/SearchForRecords",
             env("ns1", "http://gamespy.net/sake",
                 f"<ns1:SearchForRecords><ns1:gameid>1693</ns1:gameid><ns1:secretKey>9cy8vc</ns1:secretKey>"
                 f"<ns1:loginTicket>{tickets.get(me, '')}</ns1:loginTicket><ns1:tableid>PlayerStats_v1</ns1:tableid>"
                 f"<ns1:filter>PlayerUnickName != ''</ns1:filter><ns1:sort>TotalSkill desc</ns1:sort>"
                 f"<ns1:offset>0</ns1:offset><ns1:max>50</ns1:max><ns1:targetfilter/><ns1:surrounding>0</ns1:surrounding>"
                 f"<ns1:ownerids/><ns1:cacheFlag>0</ns1:cacheFlag><ns1:fields><ns1:string>PlayerUnickName</ns1:string>"
                 f"<ns1:string>ViewMyProfile</ns1:string><ns1:string>PlayerClanNameTag</ns1:string>"
                 f"<ns1:string>ownerid</ns1:string></ns1:fields></ns1:SearchForRecords>"))
    rows = re.findall(r"<ns1:ArrayOfRecordValue>(.*?)</ns1:ArrayOfRecordValue>", x, re.S)
    mine = [re.findall(r"<ns1:value>([^<]*)</ns1:value>", r) for r in rows]
    mine = [r for r in mine if r and r[0] == me]
    check("Leaderboard row has the clan tag and ViewMyProfile=1",
          bool(mine) and mine[0][1:3] == ["1", clan] and "<ns1:RecordValue/>" not in x, str(mine))

    import json

    def status() -> dict:
        c = http.client.HTTPConnection(H, a.http_port, timeout=5)
        c.request("GET", "/rising2/status")
        r = c.getresponse()
        body = r.read()
        c.close()
        return json.loads(body) if r.status == 200 else {}

    old_season = status().get("season")
    check("Status page shows the current season", bool(old_season), f"season={old_season!r}")

    # ---------------------------------------------------------------- SEASONS
    cur_file = os.path.join(a.seasons_dir, "current.txt")
    if a.no_season_test or not os.path.isdir(a.seasons_dir):
        print(f"[SKIP] season test ({a.seasons_dir} not here; run inside the server container)")
    else:
        saved = open(cur_file, "rb").read() if os.path.exists(cur_file) else None
        stamp = [time.time()]

        def set_season(text: str | None) -> None:
            if text is None:
                if os.path.exists(cur_file):
                    os.remove(cur_file)
                return
            with open(cur_file, "wb") as f:
                f.write(text.encode())
            stamp[0] += 2  # make sure the server sees a new modification time
            os.utime(cur_file, (stamp[0], stamp[0]))

        new_season = f"selftest-{tag}"
        try:
            set_season(f"# selftest\n{new_season}\n")
            check("Season switch shows on the status page", status().get("season") == new_season,
                  f"season={status().get('season')!r}")
            fresh = sake_stats(users[0][0])[0]
            check("New season: player starts from zero", len(fresh) >= 4 and fresh[1] == "0" and fresh[3] == "0",
                  str(fresh))
            # a match that starts in the new season and ends after switching back still counts for the new season
            x = soap(H, a.http_port, "/CompetitionService/CompetitionService.asmx", NS + "CreateSession",
                     env("gsc", NS, f"<gsc:CreateSession>{host_cert}<gsc:proof>0</gsc:proof><gsc:gameid>1693</gsc:gameid>"
                                    f"</gsc:CreateSession>"))
            csid = re.search(r"<ns1:csid>([^<]+)", x).group(1)
            hccid = re.search(r"<ns1:ccid>([^<]+)", x).group(1)
            intention(host_cert, hccid)
            ccids2 = {n: intention(certs[n]) for n, _, _ in users}
            set_season(saved.decode() if saved is not None else None)
            check("Season switched back", status().get("season") == old_season, f"season={status().get('season')!r}")
            x = submit(csid, hccid, ccids2)
            check("Report of a match started in the other season accepted", "<ns1:result>0<" in x)
            back = sake_stats(users[0][0])[0]
            check("Old season untouched by it", back[1:4] == b0[1:4], f"{b0} -> {back}")
            set_season(f"{new_season}\n")
            ns = sake_stats(users[0][0])[0]
            check("The match counted for the season it started in (TotalSkill 4, 1 session)",
                  len(ns) >= 4 and ns[1] == "4" and ns[3] == "1", str(ns))
        finally:
            set_season(saved.decode() if saved is not None else None)
        check("current.txt restored", status().get("season") == old_season, f"season={status().get('season')!r}")

    # unread report keys / unknown requested columns must be listed as missing
    c = http.client.HTTPConnection(H, a.http_port, timeout=5)
    c.request("GET", "/rising2/missing")
    items = json.loads(c.getresponse().read()).get("items", {})
    c.close()
    # canaries no real rules.py would handle: report key 999 and column Rising2SelftestColumn
    want = ["report_key_999", "sake_column_PlayerStats_v1.Rising2SelftestColumn"]
    check("Missing stats recorded (unread key + unknown column)", all(w in items for w in want),
          "missing=" + ",".join(w for w in want if w not in items))
    check("Known columns NOT reported missing", not any(k.startswith("sake_column_PlayerStats_v1.TotalSkill") for k in items))

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
