"""AuthService (/AuthService/AuthService.asmx) - hands out the login certificate.

The certificate is the one the old ZSI mock sent (taken from its run_log.txt),
but with the real account's userid / profileid / nick, so Competition reports
can be matched to players even when they all share one IP. Note the odd encoding: peerkeymodulus / peerkeyexponent /
serverdata are the hex text hex-encoded *again*, while signature and
peerkeyprivate are plain hex. That is what the game accepted, so it is kept.
"""
from __future__ import annotations

import binascii

from . import log
from .config import Config
from .soap import E, Node, envelope

NS = "http://gamespy.net/AuthService/"

_MODULUS = ("95375465E3FAC4900FC912E7B30EF7171B0546DF4D185DB04F21C79153CE091859DF2EBDDFE5047D80C2EF86A2169B05A933AE2EAB"
            "2962F7B32CFE3CB0C25E7E3A26BB6534C9CF19640F1143735BD0CEAA7AA88CD64ACEC6EEB037007567F1EC51D00C1D2F1FFCFECB53"
            "00C93D6D6A50C1E3BDF495FC17601794E5655C476819")
_EXPONENT = "010001"
_SERVERDATA = ("908EA21B9109C45591A1A011BF84A18940D22E032601A1B2DD235E278A9EF131404E6B07F7E2BE8BF4A658E2CB2DDE27E09354B"
               "7127C8A05D10BB4298837F96518CCB412497BE01ABA8969F9F46D23EBDE7CC9BE6268F0E6ED8209AD79727BC8E0274F6725A67CA"
               "B91AC87022E5871040BF856E541A76BB57C07F4B9BE4C6316")
_SIGNATURE = ("181A4E679AC27D83543CECB8E1398243113EF6322D630923C6CD26860F265FC031C2C61D4F9D86046C07BBBF9CF86894903BD867E"
              "3CB59A0D9EFDADCB34A7FB3CC8BC7650B48E8913D327C38BB31E0EEB06E1FC1ACA2CFC52569BE8C48840627783D7FFC4A506B1D23"
              "A1C4AEAF12724DEB12B5036E0189E48A0FCB2832E1FB00")
_TIMESTAMP = "U3VuZGF5LCBPY3RvYmVyIDE4LCAyMDA5IDE6MTk6NTMgQU0="
_PRIVATE = ("8818DA2AC0E0956E0C67CA8D785CFAF3A11A9404D1ED9A6E580EA8569E087B75316B85D77B2208916BE2E0D37C7D7FD18EFD6B2E77"
            "C11CDA6E1B689BF460A40BBAF861D800497822004880024B4E7F98A020B1896F536D7219E67AB24B17D60A7BDD7D42E3501BB2FA50BB0"
            "71EF7A80F29870FFD7C409C0B7BB7A8F70489D04D")

def _hex_of_text(s: str) -> str:
    return binascii.hexlify(s.encode("ascii")).decode("ascii")


def certificate(userid: int, profileid: int, nick: str) -> E:
    return E("certificate",
             E("length", 303), E("version", 1), E("partnercode", Config.PARTNER_CODE), E("namespaceid", 2),
             E("userid", userid), E("profileid", profileid), E("expiretime", 0),
             E("profilenick", nick), E("uniquenick", nick), E("cdkeyhash", "1234"),
             E("peerkeymodulus", _hex_of_text(_MODULUS)), E("peerkeyexponent", _hex_of_text(_EXPONENT)),
             E("serverdata", _hex_of_text(_SERVERDATA)), E("signature", _SIGNATURE), E("timestamp", _TIMESTAMP))


LOGIN_OPS = {"LoginUniqueNick", "LoginProfile", "LoginUser", "LoginRemoteAuth", "LoginPs3Cert", "LoginTicket"}


def handle(op: Node, ctx, ip: str) -> bytes | None:
    name = op.name
    nick = op.get("uniquenick") or op.get("profilenick") or op.get("nick") or op.get("email")
    if name in LOGIN_OPS:
        acct = ctx.db.login.get_user(nick) if nick else None
        if acct:
            uid, pid, cnick = acct["userid"], acct["profileid"], acct["name"]
            ctx.db.stats.add_login("auth", None, acct["profileid"], acct["name"], ip)
        else:
            # Unknown nick: still answer (the old mock always did), but with profileid 0,
            # so nothing this client reports can be credited to anybody.
            uid, pid, cnick = 0, 0, nick or ""
        log.event("AUTH", name.upper(), "INFO" if acct else "WARN",
                  "certificate issued" + ("" if acct else " with profileid 0 - nick not in login DB, "
                                          "this player's stats will NOT be saved"),
                  user=nick, ip=ip, cert_profileid=pid, cert_nick=cnick,
                  partnercode=op.get("partnercode"), namespaceid=op.get("namespaceid"))
        return envelope(NS, E(f"{name}Response", E(f"{name}Result",
                                                   E("responseCode", 0), certificate(uid, pid, cnick),
                                                   E("peerkeyprivate", _PRIVATE))))
    log.event("AUTH", name.upper(), "WARN", "AuthService operation not implemented - returning empty response",
              user=nick, ip=ip, request=op.to_dict())
    return envelope(NS, E(f"{name}Response", E(f"{name}Result", E("responseCode", 0))))
