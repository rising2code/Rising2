#!/usr/bin/env python3
"""Managed accounts test: admin endpoint, rolling password expiry, in-game newuser switch.

Needs a THROW-AWAY server started with short expiry times, for example:

  docker run -d --name r2acc -e R2_ADMIN_TOKEN=testtoken -e R2_DISABLE_NEWUSER=1 \\
      -e R2_PASS_TTL_IDLE=4s -e R2_PASS_TTL_LOGIN=10s rising2/gamespy-unified:latest
  docker exec r2acc python tools/selftest_accounts.py --token testtoken --idle 4 --login 10

Takes about 40 seconds (it waits for passwords to expire).
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import random
import re
import socket
import string
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from selftest import check, passenc, results, tcp_exchange  # noqa: E402
from rising2 import gs_crypto as gc  # noqa: E402

A: argparse.Namespace


def admin(path: str, body: dict | bytes, token: str | None) -> tuple[int, dict]:
    c = http.client.HTTPConnection(A.host, A.http_port, timeout=5)
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    c.request("POST", path, body if isinstance(body, bytes) else json.dumps(body), headers)
    r = c.getresponse()
    data = r.read()
    try:
        return r.status, json.loads(data)
    except ValueError:
        return r.status, {"raw": data.decode("latin-1")}


def gp_login(nick: str, pw: str) -> tuple[bool, str, socket.socket]:
    s = socket.create_connection((A.host, 29900), timeout=5)
    schal = re.search(r"\\challenge\\([^\\]+)", s.recv(4096).decode("latin-1")).group(1)
    cchal = gc.random_string(32)
    resp = gc.gp_response(gc.md5_hex(pw), nick, cchal, schal)
    s.sendall(f"\\login\\\\challenge\\{cchal}\\uniquenick\\{nick}\\response\\{resp}\\port\\0\\productid\\11067"
              f"\\gamename\\risingeaglepc\\namespaceid\\2\\sdkrevision\\3\\id\\1\\final\\".encode())
    data = b""
    while b"\\final\\" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    t = data.decode("latin-1")
    return "\\lc\\2\\" in t, t, s


def logout(s: socket.socket) -> None:
    s.sendall(b"\\logout\\\\sesskey\\1\\final\\")
    time.sleep(0.3)  # let the server run on_close before the next step
    s.close()


def crash(s: socket.socket) -> None:
    s.close()  # no logout: like the game crashing or the network dropping
    time.sleep(0.3)


def login_once(nick: str, pw: str) -> tuple[bool, str]:
    ok, t, s = gp_login(nick, pw)
    if ok:
        logout(s)
    else:
        s.close()
    return ok, t


def gpsp_check(nick: str, pw: str) -> bytes:
    return tcp_exchange(A.host, 29901, f"\\check\\\\nick\\{nick}\\passenc\\{passenc(pw)}"
                                       f"\\gamename\\risingeaglepc\\final\\".encode())


def gpsp_nicks(email: str, pw: str) -> bytes:
    return tcp_exchange(A.host, 29901, f"\\nicks\\\\email\\{email}\\passenc\\{passenc(pw)}"
                                       f"\\namespaceid\\0\\gamename\\risingeaglepc\\final\\".encode())


def cert_profileid(nick: str) -> int | None:
    body = ('<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/'
            'soap/envelope/" xmlns:ns1="http://gamespy.net/AuthService/"><SOAP-ENV:Body><ns1:LoginUniqueNick>'
            f'<ns1:version>1</ns1:version><ns1:partnercode>11067</ns1:partnercode><ns1:namespaceid>2</ns1:namespaceid>'
            f'<ns1:uniquenick>{nick}</ns1:uniquenick><ns1:password><ns1:Value>00</ns1:Value></ns1:password>'
            '</ns1:LoginUniqueNick></SOAP-ENV:Body></SOAP-ENV:Envelope>')
    c = http.client.HTTPConnection(A.host, A.http_port, timeout=5)
    c.request("POST", "/AuthService/AuthService.asmx", body,
              {"Content-Type": "text/xml", "SOAPAction": "http://gamespy.net/AuthService/LoginUniqueNick"})
    m = re.search(rb"<ns1:profileid>(\d+)</ns1:profileid>", c.getresponse().read())
    return int(m.group(1)) if m else None


def main() -> int:
    global A
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=80)
    ap.add_argument("--token", default="", help="the server's R2_ADMIN_TOKEN (empty: only check the endpoint is off)")
    ap.add_argument("--idle", type=float, default=4, help="the server's R2_PASS_TTL_IDLE in seconds")
    ap.add_argument("--login", type=float, default=10, help="the server's R2_PASS_TTL_LOGIN in seconds")
    A = ap.parse_args()
    tag = "".join(random.choice(string.ascii_lowercase) for _ in range(5))

    if not A.token:
        st, _ = admin("/rising2/admin/create", {"nick": "x", "email": "x@x", "password": "x"}, "anything")
        check("admin endpoint off without R2_ADMIN_TOKEN (404)", st == 404, str(st))
        return summary()

    nick, email, pw = f"carol_{tag}", f"carol_{tag}@test.local", "Tmp-" + gc.random_string(12)
    # ------------------------------------------------------------ admin endpoint
    st, _ = admin("/rising2/admin/create", {"nick": nick, "email": email, "password": pw}, None)
    check("admin: no token -> 401", st == 401, str(st))
    st, _ = admin("/rising2/admin/create", {"nick": nick, "email": email, "password": pw}, "wrong")
    check("admin: wrong token -> 401", st == 401, str(st))
    st, r = admin("/rising2/admin/create", b"not json", A.token)
    check("admin: bad JSON -> 400", st == 400, str(r))
    st, r = admin("/rising2/admin/create", {"nick": nick, "email": email, "password": "a\\b"}, A.token)
    check("admin: backslash in password -> 400", st == 400, str(r))
    st, r = admin("/rising2/admin/create", {"nick": nick, "email": email, "password": pw}, A.token)
    check("admin: create managed account", st == 200 and r.get("nick") == nick
          and abs(r.get("expires", 0) - (time.time() + A.idle)) < 3, str(r))
    pid = r.get("profileid")
    st, r = admin("/rising2/admin/create", {"nick": nick.upper(), "email": email, "password": pw}, A.token)
    check("admin: same nick again -> 409", st == 409, str(r))
    st, r = admin("/rising2/admin/reset", {"nick": f"nobody_{tag}", "password": pw}, A.token)
    check("admin: reset unknown nick -> 404", st == 404, str(r))

    # ------------------------------------------------------------ in-game newuser off
    r = tcp_exchange(A.host, 29901, f"\\newuser\\\\email\\x_{tag}@test.local\\nick\\x_{tag}\\passenc\\{passenc('pw')}"
                                    f"\\productid\\11067\\gamename\\risingeaglepc\\id\\1\\final\\".encode())
    check("in-game newuser refused (R2_DISABLE_NEWUSER)", b"\\error\\" in r and b"disabled" in r, r.decode("latin-1"))

    # ------------------------------------------------------------ the game's normal flow
    check("GPSP check with the new password", gpsp_check(nick, pw).startswith(b"\\cur\\0\\"))
    check("GPSP nicks with the new password", nick.encode() in gpsp_nicks(email, pw))
    ok, t, s = gp_login(nick, pw)
    check("GPCM login with the new password", ok, t)
    check("AuthService certificate has the real profileid", cert_profileid(nick) == pid)
    ok2, t2 = login_once(nick, "wrong-password")
    check("GPCM login with a wrong password is refused", not ok2 and "\\err\\260" in t2, t2)

    # live session outlasts the login expiry: nobody is kicked; logout then gives IDLE more
    print(f"... staying logged in {A.login + 2:.0f}s (past the login expiry)")
    time.sleep(A.login + 2)
    logout(s)
    ok, t = login_once(nick, pw)
    check("after a long session: logout -> immediate re-login works (after-match re-login)", ok, t)

    # crash: connection dropped without logout -> still IDLE to come back
    ok, t, s = gp_login(nick, pw)
    crash(s)
    time.sleep(A.idle / 2)
    ok, t = login_once(nick, pw)
    check("after a crash: re-login within the idle time works", ok, t)

    # rolling: several logouts/logins each shorter than IDLE, total longer than IDLE
    ok_all = True
    for _ in range(3):
        time.sleep(A.idle * 0.6)
        ok, t = login_once(nick, pw)
        ok_all &= ok
    check(f"rolling: 3 re-logins {A.idle * 0.6:.1f}s apart (longer than idle in total) all work", ok_all)

    # gone longer than IDLE -> everything that checks the password fails
    print(f"... away {A.idle + 2:.0f}s (past the idle expiry)")
    time.sleep(A.idle + 2)
    ok, t = login_once(nick, pw)
    check("expired: GPCM login refused (err 260)", not ok and "\\err\\260" in t, t)
    check("expired: GPSP check refused", gpsp_check(nick, pw).startswith(b"\\cur\\3587\\"))
    check("expired: GPSP nicks returns no profiles", b"\\err\\551" in gpsp_nicks(email, pw))
    check("expired: AuthService certificate gets profileid 0", cert_profileid(nick) == 0)
    r = tcp_exchange(A.host, 29901, f"\\search\\\\uniquenick\\{nick}\\gamename\\risingeaglepc\\final\\".encode(),
                     until=b"\\bsrdone\\")
    check("expired: account still exists for search (not hidden)", str(pid).encode() in r, r.decode("latin-1"))

    # reset -> new password works, old one does not
    pw2 = "Tmp-" + gc.random_string(12)
    st, r = admin("/rising2/admin/reset", {"nick": nick, "password": pw2}, A.token)
    check("admin: reset", st == 200 and r.get("profileid") == pid, str(r))
    ok, t = login_once(nick, pw2)
    check("after reset: new password works", ok, t)
    ok, t = login_once(nick, pw)
    check("after reset: old password refused", not ok, t)
    check("after reset: certificate has the real profileid again", cert_profileid(nick) == pid)

    # a password nobody uses expires after IDLE
    pw3 = "Tmp-" + gc.random_string(12)
    admin("/rising2/admin/reset", {"nick": nick, "password": pw3}, A.token)
    time.sleep(A.idle + 2)
    ok, t = login_once(nick, pw3)
    check("unused reset password expires after the idle time", not ok, t)
    return summary()


def summary() -> int:
    bad = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed" + (f", FAILED: {bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
