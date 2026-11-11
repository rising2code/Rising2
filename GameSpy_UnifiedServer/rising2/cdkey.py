"""CD key server (UDP 29910) - accepts every key, like the old C# CDKeyServer.

Packets are XORed with "gamespy". Known messages:
  \\ka\\                  keep-alive from a game server (every ~20 s)
  \\auth\\\\pid\\...       validate a player's CD key  -> \\uok\\
  \\disc\\...             player disconnected
"""
from __future__ import annotations

import re

from . import gs_crypto as gc
from . import log
from .net import UdpService, check_nat

# [A-z] (not [A-Za-z]) on purpose: identical to the C# regex, which also allows []^_`
_AUTH = re.compile(
    r"^\\auth\\\\pid\\(?P<pid>\d+)\\ch\\(?P<ch>[A-z0-9]{8,10})\\resp\\(?P<resp>[A-z0-9]{72})"
    r"\\ip\\(?P<ip>\d+)\\skey\\(?P<skey>\d+)(\\reqproof\\[01]\\)?$")


def _kv(s: str) -> dict[str, str]:
    p = s.split("\\")
    return {p[i]: p[i + 1] for i in range(1, len(p) - 1, 2)}


class CdKeyService(UdpService):
    SERVICE = "CDKEY"

    def receive(self, data: bytes, addr) -> None:
        # Log decrypted text instead of the XORed bytes (raw hex still logged at DEBUG).
        check_nat("CDKEY", addr[0])
        self._check_retry(data, addr)
        try:
            text = gc.xor_gamespy(data).decode("latin-1")
        except Exception:
            text = ""
        if text == "\\ka\\":
            log.event("CDKEY", "KEEPALIVE", "DEBUG", "game server keep-alive", ip=addr)
            return
        log.event("CDKEY", "RECV", "INFO", f"{len(data)} bytes, decrypted: {log.printable(text.encode('latin-1'))}", ip=addr)
        log.event("CDKEY", "RECV-HEX", "DEBUG", "\n" + log.hexdump(data), ip=addr)
        try:
            self.handle(text, addr)
        except Exception as e:
            log.event("CDKEY", "ERROR", "ERROR", f"handler crashed: {e!r}", ip=addr)

    def handle(self, text: str, addr) -> None:
        m = _AUTH.match(text)
        if m:
            kv = _kv(text)
            reply = f"\\uok\\\\cd\\{m.group('resp')[:32]}\\skey\\{m.group('skey')}"
            log.event("CDKEY", "AUTH", "INFO", "CD key accepted (all keys are accepted)", ip=addr,
                      pid=m.group("pid"), skey=m.group("skey"), player_ip=_int_ip(m.group("ip")),
                      cdkey_hash=m.group("resp")[:32], reqproof=kv.get("reqproof"))
            self.send_plain(reply, addr)
            return
        if text.startswith("\\disc\\"):
            kv = _kv(text)
            log.event("CDKEY", "DISCONNECT", "INFO", "player CD key released", ip=addr, skey=kv.get("skey"), pid=kv.get("pid"))
            return
        if text.startswith("\\auth\\"):
            log.event("CDKEY", "AUTH", "WARN", "auth request in an unexpected format, NOT answered", ip=addr, raw=text)
            return
        log.event("CDKEY", "UNKNOWN", "WARN", "unknown CD key message, NOT answered", ip=addr, raw=text)

    def send_plain(self, text: str, addr) -> None:
        log.event("CDKEY", "SEND", "INFO", f"plain: {text}", ip=addr)
        self.transport.sendto(gc.xor_gamespy(text.encode("latin-1")), addr)
        self.mark_answered(addr)


def _int_ip(s: str) -> str:
    try:
        n = int(s)
        return ".".join(str((n >> (8 * i)) & 0xFF) for i in range(4))  # little-endian dword
    except ValueError:
        return s


class NatNegLogger(UdpService):
    """UDP 27901: NAT negotiation is NOT implemented (the old servers had none
    either). Every packet is logged so you can see whether the game uses it."""

    SERVICE = "NATNEG"

    def on_packet(self, data: bytes, addr) -> None:
        names = {0: "INIT", 1: "INITACK", 2: "ERTTEST", 3: "ERTACK", 4: "STATEUPDATE", 5: "CONNECT",
                 6: "CONNECT_ACK", 7: "CONNECT_PING", 8: "BACKUP_TEST", 9: "BACKUP_ACK", 10: "ADDRESS_CHECK",
                 11: "ADDRESS_REPLY", 12: "NATIFY_REQUEST", 13: "REPORT", 14: "REPORT_ACK"}
        if data[:6] == b"\xfd\xfc\x1e\x66\x6a\xb2" and len(data) > 7:
            t = data[7]
            cookie = int.from_bytes(data[8:12], "big") if len(data) >= 12 else None
            log.event("NATNEG", names.get(t, f"TYPE_{t}"), "WARN",
                      "NAT negotiation packet received - natneg is not implemented, no reply", ip=addr,
                      version=data[6], cookie=cookie)
        else:
            log.event("NATNEG", "UNKNOWN", "WARN", "non-natneg packet on natneg port, no reply", ip=addr)
