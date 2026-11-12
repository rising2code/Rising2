"""Managed accounts: the HTTP endpoints another system (the account website) calls.

  POST /rising2/admin/create   {"nick": "...", "email": "...", "password": "..."}
  POST /rising2/admin/reset    {"nick": "...", "password": "..."}
  Authorization: Bearer <R2_ADMIN_TOKEN>

Both store md5(password) like every other account and set expires = now + R2_PASS_TTL_IDLE;
from then on every login moves it to now + R2_PASS_TTL_LOGIN and every logout / dropped
connection back to now + R2_PASS_TTL_IDLE (see gp.py). Without R2_ADMIN_TOKEN both answer 404.
Request bodies of these paths are never logged (they hold the plain password).
"""
from __future__ import annotations

import hmac
import json

from . import gs_crypto as gc
from . import log
from .config import Config
from .db import now

PATHS = ("/rising2/admin/create", "/rising2/admin/reset")
MAX_LEN = 64


def _text(v, name: str, allow_space: bool) -> str:
    """Printable ASCII without '\\' (the GameSpy field separator)."""
    if not isinstance(v, str) or not 1 <= len(v) <= MAX_LEN:
        raise ValueError(f"{name}: 1-{MAX_LEN} characters required")
    low = 0x20 if allow_space else 0x21
    if any(not low <= ord(c) <= 0x7E or c == "\\" for c in v):
        raise ValueError(f"{name}: only printable ASCII, no backslash" + ("" if allow_space else ", no spaces"))
    return v


def _authorized(headers: dict) -> bool:
    auth = headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return False
    return hmac.compare_digest(auth[7:].strip().encode(), Config.ADMIN_TOKEN.encode())


def handle(lpath: str, method: str, headers: dict, body: bytes, ctx, ip: str) -> tuple[int, dict]:
    """-> (HTTP status, JSON answer)."""
    if not Config.ADMIN_TOKEN:
        return 404, {"error": "not found"}
    if not _authorized(headers):
        log.event("ADMIN", "DENIED", "WARN", "admin call without a valid bearer token", ip=ip, path=lpath)
        return 401, {"error": "unauthorized"}
    if method != "POST":
        return 405, {"error": "POST only"}
    try:
        req = json.loads(body or b"{}")
        if not isinstance(req, dict):
            raise ValueError("JSON object expected")
        nick = _text(req.get("nick"), "nick", allow_space=False)
        password = _text(req.get("password"), "password", allow_space=True)
        email = _text(req.get("email"), "email", allow_space=False) if lpath.endswith("/create") else None
        if email is not None and "@" not in email:
            raise ValueError("email: not an email address")
    except ValueError as e:  # json.JSONDecodeError is a ValueError too
        log.event("ADMIN", "BADREQUEST", "WARN", f"rejected: {e}", ip=ip, path=lpath)
        return 400, {"error": str(e)}

    db = ctx.db.login
    expires = now() + Config.PASS_TTL_IDLE
    md5pass = gc.md5_hex(password)
    if lpath.endswith("/create"):
        if db.exists(nick):
            log.event("ADMIN", "CREATE", "WARN", "rejected: nick already in use", ip=ip, nick=nick)
            return 409, {"error": "nick already in use"}
        acct = db.create_user(nick, md5pass, email, "??", ip, expires=expires)
        log.event("ADMIN", "CREATE", "INFO", "managed account created", ip=ip, nick=nick,
                  profileid=acct["profileid"], expires=expires)
    else:
        if not db.set_password(nick, md5pass, expires):
            log.event("ADMIN", "RESET", "WARN", "rejected: unknown nick", ip=ip, nick=nick)
            return 404, {"error": "unknown nick"}
        acct = db.get_user(nick)
        log.event("ADMIN", "RESET", "INFO", "password reset", ip=ip, nick=acct["name"],
                  profileid=acct["profileid"], expires=expires)
    return 200, {"nick": acct["name"], "profileid": acct["profileid"], "userid": acct["userid"], "expires": expires}
