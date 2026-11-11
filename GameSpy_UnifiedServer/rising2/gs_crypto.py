"""GameSpy crypto / encoding helpers.

Ported from the C# PRMasterServer (Zenchreal_rising-eagle-master) and from
Luigi Auriemma's public GameSpy research (enctypex).
All strings on the wire are treated as latin-1 (one byte per char), the same
as DataFunctions.StringToBytes in the C# server.
"""
from __future__ import annotations

import hashlib
import os
import random
import string


def md5_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("latin-1")
    return hashlib.md5(data).hexdigest()


def random_string(length: int, alphabet: str = string.ascii_letters + string.digits) -> str:
    return "".join(random.choice(alphabet) for _ in range(length))


# --------------------------------------------------------------------------
# GP password "passenc" decoding (gsBase64 + gsEncode XOR stream)
# --------------------------------------------------------------------------

_B64_GS = {}
for _i, _c in enumerate(string.ascii_uppercase + string.ascii_lowercase + string.digits):
    _B64_GS[ord(_c)] = _i
# GameSpy accepts both standard and its own alphabet for 62/63
_B64_GS[ord("+")] = 62
_B64_GS[ord("/")] = 63
_B64_GS[ord("[")] = 62
_B64_GS[ord("]")] = 63


def gs_base64_decode(s: str) -> bytes:
    out = bytearray()
    a = b = 0
    step = 0
    for ch in s.encode("latin-1"):
        if ch in (ord("="), ord("_")):
            break
        if ch <= 0x20 or ch > 0x7F:
            continue
        v = _B64_GS.get(ch, 0)
        k = step & 3
        if k == 0:
            a = v
        elif k == 1:
            b = v
            out.append(((a << 2) | (b >> 4)) & 0xFF)
        elif k == 2:
            a = v
            out.append((((b & 15) << 4) | (a >> 2)) & 0xFF)
        else:
            out.append((((a & 3) << 6) | v) & 0xFF)
        step += 1
    return bytes(out)


def _gs_lame(num: int) -> int:
    def to_i32(x: int) -> int:
        x &= 0xFFFFFFFF
        return x - 0x100000000 if x & 0x80000000 else x

    c = (num >> 16) & 0xFFFF
    a = num & 0xFFFF
    c = to_i32(c * 0x41A7)
    a = to_i32(a * 0x41A7)
    a = to_i32(a + ((c & 0x7FFF) << 16))
    if a < 0:
        a = (a & 0x7FFFFFFF) + 1
    a = to_i32(a + (c >> 15))
    if a < 0:
        a = (a & 0x7FFFFFFF) + 1
    return a


def gs_encode(data: bytes) -> bytes:
    num = 0x79707367 & 0x7FFFFFFF  # "gspy"
    out = bytearray(data)
    for i in range(len(out)):
        num = _gs_lame(num)
        out[i] ^= (num % 0xFF) & 0xFF
    return bytes(out)


def decrypt_passenc(passenc: str) -> str:
    return gs_encode(gs_base64_decode(passenc)).decode("latin-1")


# --------------------------------------------------------------------------
# GP session key (CRC16 of the nick) - same table as the C# server
# --------------------------------------------------------------------------

def _crc16_table() -> list[int]:
    table = []
    for i in range(256):
        crc = i
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
        table.append(crc)
    return table


_CRC16 = _crc16_table()


def gp_session_key(name: str) -> int:
    session = 0
    for ch in name.encode("latin-1", "replace"):
        session = _CRC16[(ch ^ session) & 0xFF] ^ (session >> 8)
    return session & 0xFFFF


def gp_response(md5pass: str, name: str, first_challenge: str, second_challenge: str) -> str:
    """GP login proof: md5(md5pass + 48 spaces + user + chal1 + chal2 + md5pass)."""
    return md5_hex(md5pass + " " * 48 + name + first_challenge + second_challenge + md5pass)


# --------------------------------------------------------------------------
# CD key server XOR ("gamespy")
# --------------------------------------------------------------------------

def xor_gamespy(data: bytes) -> bytes:
    key = b"gamespy"
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


# --------------------------------------------------------------------------
# enctypex (GameSpy server browser v2 list encryption)
# --------------------------------------------------------------------------

class _EncTypeX:
    def __init__(self) -> None:
        self.k = bytearray(261)

    def _func5(self, cnt: int, ident: bytes, n: list[int]) -> int:
        if not cnt:
            return 0
        mask = 1
        if cnt > 1:
            while mask < cnt:
                mask = (mask << 1) + 1
        i = 0
        while True:
            n[0] = self.k[n[0] & 0xFF] + ident[n[1]]
            n[1] += 1
            if n[1] >= len(ident):
                n[1] = 0
                n[0] += len(ident)
            tmp = n[0] & mask
            i += 1
            if i > 11:
                tmp %= cnt
            if tmp <= cnt:
                return tmp

    def func4(self, ident: bytes) -> None:
        k = self.k
        if len(ident) < 1:
            return
        for i in range(256):
            k[i] = i
        n = [0, 0]
        for i in range(255, -1, -1):
            t1 = self._func5(i, ident, n) & 0xFF
            k[i], k[t1] = k[t1], k[i]
        k[256] = k[1]
        k[257] = k[3]
        k[258] = k[5]
        k[259] = k[7]
        k[260] = k[n[0] & 0xFF]

    def _core(self, d: int) -> tuple[int, int]:
        """Shared part of func7: returns (keystream-ish c, b) before the xor."""
        k = self.k
        a = k[256]
        b = k[257]
        c = k[a]
        k[256] = (a + 1) & 0xFF
        k[257] = (b + c) & 0xFF
        a = k[260]
        b = k[257]
        b = k[b]
        c = k[a]
        k[a] = b
        a = k[259]
        b = k[257]
        a = k[a]
        k[b] = a
        a = k[256]
        b = k[259]
        a = k[a]
        k[b] = a
        a = k[256]
        k[a] = c
        b = k[258]
        a = k[c]
        c = k[259]
        b = (b + a) & 0xFF
        k[258] = b
        a = b
        c = k[c]
        b = k[257]
        b = k[b]
        a = k[a]
        c = (c + b) & 0xFF
        b = k[260]
        b = k[b]
        c = (c + b) & 0xFF
        b = k[c]
        c = k[256]
        c = k[c]
        a = (a + c) & 0xFF
        c = k[b]
        b = k[a]
        return c, b

    def decrypt_byte(self, d: int) -> int:
        c, b = self._core(d)
        self.k[260] = d
        c ^= b ^ d
        self.k[259] = c
        return c

    def encrypt_byte(self, d: int) -> int:
        c, b = self._core(d)
        c ^= b ^ d
        self.k[260] = c
        self.k[259] = d
        return c

    def funcx(self, key: bytes, validate: bytes, salt: bytes) -> None:
        v = bytearray(validate[:8])
        for i in range(len(salt)):
            v[(key[i % len(key)] * i) & 7] ^= v[i & 7] ^ salt[i]
        self.func4(bytes(v))


def enctypex_encode(key: bytes, validate: bytes, data: bytes, salt_len: int = 14) -> bytes:
    """Encrypt a server list for the client (inverse of enctypex_decoder)."""
    # Same layout as Reality.Net GSEncoding (verified): 9-byte header
    # [ (9-2)^0xEC, 7 filler bytes, salt_len^0xEA ] followed by the salt.
    salt = os.urandom(salt_len)
    header = bytes([7 ^ 0xEC]) + os.urandom(7) + bytes([salt_len ^ 0xEA]) + salt
    st = _EncTypeX()
    st.funcx(key, validate, salt)
    return header + bytes(st.encrypt_byte(b) for b in data)


def enctypex_decode(key: bytes, validate: bytes, data: bytes) -> bytes:
    """Decrypt (used by the self test and for debugging captured lists)."""
    a = (data[0] ^ 0xEC) + 2
    b = data[a - 1] ^ 0xEA
    st = _EncTypeX()
    st.funcx(key, validate, data[a : a + b])
    return bytes(st.decrypt_byte(x) for x in data[a + b :])
