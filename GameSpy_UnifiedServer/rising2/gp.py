"""GameSpy Presence: GPCM (client manager, 29900) and GPSP (search manager, 29901).

Behaviour ported from PRMasterServer LoginServer.cs / LoginServerMessages.cs,
but commands are accepted in any state (the C# state machine silently dropped
out-of-order commands; here every command is at least logged and answered).
"""
from __future__ import annotations

import asyncio

from . import gs_crypto as gc
from .config import Config
from .db import now, password_valid

LT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ]["


def parse_kv(message: str) -> tuple[str, dict[str, str]]:
    """'\\login\\\\challenge\\abc\\id\\1' -> ('login', {'login': '', 'challenge': 'abc', 'id': '1'})"""
    parts = message.split("\\")
    if len(parts) < 2:
        return "", {}
    query = parts[1]
    kv: dict[str, str] = {}
    for i in range(1, len(parts) - 1, 2):
        kv[parts[i].lower()] = parts[i + 1]
    return query.lower(), kv


def err(code: int, msg: str, fatal: bool = True) -> str:
    return f"\\error\\\\err\\{code}\\{'fatal' if fatal else ''}\\\\errmsg\\{msg}\\id\\1\\final\\"


def password_from_kv(kv: dict[str, str]) -> str:
    if "passenc" in kv:
        return gc.decrypt_passenc(kv["passenc"])
    return kv.get("pass", "")


class _GpBase:
    """Message framing shared by GPCM and GPSP: messages end with \\final\\."""

    def _init_gp(self):
        self.buf = ""

    async def _feed(self, data: bytes) -> None:
        self.buf += data.decode("latin-1")
        while "\\final\\" in self.buf:
            msg, self.buf = self.buf.split("\\final\\", 1)
            if not msg:
                continue
            query, kv = parse_kv(msg)
            self.ev("CMD", "DEBUG", f"command '{query}'", keys=",".join(k for k in kv if k not in ("passenc", "pass", "response")))
            if not query:
                self.ev("CMD", "WARN", f"unparseable message: {msg!r}")
                continue
            if "gamename" in kv and kv["gamename"].lower() != Config.GAMENAME:
                self.ev("CMD", "WARN", f"ignored: gamename '{kv['gamename']}' is not {Config.GAMENAME}")
                continue
            await self.handle(query, kv)

    async def send_text(self, text: str, note: str = "") -> None:
        await self.send(text.encode("latin-1", "replace"), note=note)


from .net import TcpSession  # noqa: E402  (after helpers to keep the file readable)


class GpcmSession(TcpSession, _GpBase):
    SERVICE = "GPCM"

    async def on_connect(self) -> None:
        self._init_gp()
        self.server_challenge = gc.random_string(10)
        self.client_challenge = ""
        self.account: dict | None = None
        self.ka_task: asyncio.Task | None = None
        await self.send_text(f"\\lc\\1\\challenge\\{self.server_challenge}\\id\\1\\final\\", note="server challenge")

    async def on_data(self, data: bytes) -> None:
        await self._feed(data)

    async def on_close(self) -> None:
        if self.ka_task:
            self.ka_task.cancel()
        if self.account:
            self.ev("LOGOUT", "INFO", "player session ended", profileid=self.account["profileid"])
            # logout, crash or dropped connection: a managed password stays valid for PASS_TTL_IDLE more
            self.ctx.db.login.roll_expiry(self.account["name"], now() + Config.PASS_TTL_IDLE)

    async def handle(self, query: str, kv: dict[str, str]) -> None:
        db = self.ctx.db
        if query == "login":
            await self.login(kv)
        elif query == "newuser":
            await self.newuser(kv)
        elif query == "getprofile":
            await self.getprofile(kv)
        elif query == "updatepro":
            if not self.account:
                self.ev("UPDATEPRO", "WARN", "updatepro before login, ignored")
                return
            country = kv.get("countrycode", "??").upper()
            db.login.set_country(self.account["name"], country)
            self.ev("UPDATEPRO", "INFO", "profile updated", country=country)
        elif query == "logout":
            self.ev("LOGOUT", "INFO", "client sent logout")
            self.close("logout")
        elif query == "ka":
            self.ev("KEEPALIVE", "DEBUG", "client keep-alive")
        elif query == "status":
            self.ev("STATUS", "INFO", "status update (not stored)", status=kv.get("status"),
                    statstring=kv.get("statstring"), locstring=kv.get("locstring"))
        else:
            self.ev("CMD", "WARN", f"unhandled GPCM command '{query}' (no reply sent)", raw=kv)

    async def login(self, kv: dict[str, str]) -> None:
        name = kv.get("uniquenick", "")
        self.user = name or None
        if not (name and "challenge" in kv and "response" in kv):
            self.ev("LOGIN", "ERROR", "login rejected: missing uniquenick/challenge/response", keys=",".join(kv))
            await self.send_text(err(0, "Invalid Query!"))
            return
        self.client_challenge = kv["challenge"]
        acct = self.ctx.db.login.get_user(name)
        if not acct:
            self.ev("LOGIN", "WARN", "login rejected: unknown user")
            await self.send_text(err(265, f"Username [{name}] doesn't exist!"))
            return
        if not password_valid(acct):
            self.ev("LOGIN", "WARN", "login rejected: password expired (get a new one from the account system)",
                    profileid=acct["profileid"], expired=acct["expires"])
            await self.send_text(err(260, "The password provided is incorrect."))
            return
        md5pass = acct["passwordenc"]
        expected = gc.gp_response(md5pass, name, self.client_challenge, self.server_challenge)
        if kv["response"] != expected:
            self.ev("LOGIN", "WARN", "login rejected: wrong password", profileid=acct["profileid"])
            await self.send_text(err(260, "The password provided is incorrect."))
            return
        self.account = acct
        self.user = acct["name"]
        sesskey = gc.gp_session_key(name)
        proof = gc.gp_response(md5pass, name, self.server_challenge, self.client_challenge)
        lt = gc.random_string(22, LT_ALPHABET) + "__"
        self.ctx.db.login.log_login(name, self.ip)
        self.ctx.db.login.roll_expiry(name, now() + Config.PASS_TTL_LOGIN)  # managed accounts only
        self.ctx.db.stats.add_login("gp", lt, acct["profileid"], acct["name"], self.ip)
        self.ev("LOGIN", "INFO", "login accepted", profileid=acct["profileid"], userid=acct["userid"],
                sesskey=sesskey, ticket=lt)
        await self.send_text(
            f"\\lc\\2\\sesskey\\{sesskey}\\proof\\{proof}\\userid\\{acct['userid']}\\profileid\\{acct['profileid']}"
            f"\\uniquenick\\{name}\\lt\\{lt}\\id\\1\\final\\", note="login proof")
        if self.ka_task is None:
            self.ka_task = asyncio.create_task(self.keepalive_loop())

    async def keepalive_loop(self) -> None:
        n = 0
        try:
            while not self.closed:
                await asyncio.sleep(120)
                n += 1
                self.ev("KEEPALIVE", "DEBUG", "sending keep-alive")
                await self.send_text("\\ka\\\\final\\", note="keep-alive")
                if n % 2 == 0:
                    await self.send_text(f"\\lt\\{gc.random_string(22, LT_ALPHABET)}__\\final\\", note="heartbeat")
        except asyncio.CancelledError:
            pass

    async def newuser(self, kv: dict[str, str]) -> None:
        await _newuser(self, kv, gpcm=True)

    async def getprofile(self, kv: dict[str, str]) -> None:
        acct = self.account
        if "profileid" in kv and (not acct or str(acct["profileid"]) != kv["profileid"]):
            other = self.ctx.db.login.get_by_profileid(int(kv["profileid"])) if kv["profileid"].isdigit() else None
            acct = other or acct
        if not acct:
            self.ev("GETPROFILE", "WARN", "getprofile but no logged-in user / unknown profile", target=kv.get("profileid"))
            await self.send_text(err(265, f"Username [{self.user}] doesn't exist!"))
            return
        self.ev("GETPROFILE", "INFO", "profile sent", profileid=acct["profileid"], target_nick=acct["name"])
        await self.send_text(
            f"\\pi\\\\profileid\\{acct['profileid']}\\nick\\{acct['name']}\\userid\\{acct['userid']}"
            f"\\email\\{acct['email']}\\sig\\{gc.random_string(32, '0123456789abcdef')}\\uniquenick\\{acct['name']}"
            f"\\pid\\0\\countrycode\\{acct['country']}\\lon\\0.000000\\lat\\0.000000\\id\\{kv.get('id', '1')}\\final\\",
            note="profile")


async def _newuser(sess, kv: dict[str, str], gpcm: bool) -> None:
    nick, email = kv.get("nick"), kv.get("email")
    if Config.DISABLE_NEWUSER:
        sess.ev("NEWUSER", "WARN", "rejected: in-game account creation is disabled (R2_DISABLE_NEWUSER)",
                nick=nick, email=email)
        await sess.send_text(err(0, "Account creation is disabled on this server."))
        return
    if not nick or not email or ("passenc" not in kv and "pass" not in kv):
        sess.ev("NEWUSER", "ERROR", "rejected: missing nick/email/password", keys=",".join(kv))
        await sess.send_text(err(0, "Invalid Query!"))
        return
    sess.user = nick
    db = sess.ctx.db.login
    if db.exists(nick):
        sess.ev("NEWUSER", "WARN", "rejected: nick already in use", email=email)
        await sess.send_text(err(516, "This account name is already in use!"))
        return
    md5pass = gc.md5_hex(password_from_kv(kv))
    acct = db.create_user(nick, md5pass, email, "??", sess.ip)
    if not acct:
        sess.ev("NEWUSER", "ERROR", "database insert failed")
        await sess.send_text(err(0, "Error creating account!"))
        return
    sess.ev("NEWUSER", "INFO", "account created", email=email, profileid=acct["profileid"], userid=acct["userid"])
    await sess.send_text(f"\\nur\\0\\pid\\{acct['profileid']}\\final\\", note="new user")


class GpspSession(TcpSession, _GpBase):
    SERVICE = "GPSP"

    async def on_connect(self) -> None:
        self._init_gp()

    async def on_data(self, data: bytes) -> None:
        await self._feed(data)

    async def handle(self, query: str, kv: dict[str, str]) -> None:
        db = self.ctx.db.login
        if query == "nicks":
            email = kv.get("email")
            if not email or ("passenc" not in kv and "pass" not in kv):
                self.ev("NICKS", "ERROR", "rejected: missing email/password")
                await self.send_text(err(0, "Invalid Query!"))
                return
            users = db.users_by_email_and_password(email, gc.md5_hex(password_from_kv(kv)))
            if not users:
                self.ev("NICKS", "WARN", "no profiles for email/password", email=email)
                await self.send_text(err(551, "Unable to get any associated profiles."))
                return
            msg = f"\\nr\\{len(users)}" + "".join(f"\\nick\\{u['name']}\\uniquenick\\{u['name']}" for u in users)
            self.ev("NICKS", "INFO", f"returned {len(users)} nick(s)", email=email, nicks=",".join(u["name"] for u in users))
            await self.send_text(msg + "\\ndone\\final\\")
        elif query == "check":
            name = kv.get("uniquenick") or kv.get("nick")
            self.user = name
            if not name:
                await self.send_text(err(0, "Invalid Query!"))
                return
            acct = db.get_user(name)
            if not acct:
                self.ev("CHECK", "WARN", "unknown user")
                await self.send_text(err(265, f"Username [{name}] doesn't exist!"))
                return
            expired = not password_valid(acct)
            ok = not expired and gc.md5_hex(password_from_kv(kv)) == acct["passwordenc"]
            self.ev("CHECK", "INFO" if ok else "WARN",
                    "password " + ("correct" if ok else "EXPIRED" if expired else "WRONG"), profileid=acct["profileid"])
            await self.send_text(f"\\cur\\{0 if ok else 3587}\\pid\\{acct['profileid']}\\final\\")
        elif query == "search":
            if "uniquenick" in kv:
                u = db.get_user(kv["uniquenick"])
                users = [u] if u else []
                body = "".join(f"\\bsr\\{u['profileid']}\\nick\\{u['name']}\\uniquenick\\{u['name']}\\namespaceid\\2" for u in users)
            elif "email" in kv:
                users = db.users_by_email(kv["email"])
                body = "".join(
                    f"\\bsr\\{u['profileid']}\\nick\\{u['name']}\\uniquenick\\{u['name']}\\email\\{u['email']}\\namespaceid\\2"
                    for u in users)
            else:
                await self.send_text(err(0, "Invalid Query!"))
                return
            self.ev("SEARCH", "INFO", f"{len(users)} result(s)", nick=kv.get("uniquenick"), email=kv.get("email"))
            await self.send_text(body + "\\bsrdone\\final\\more\\0\\")
        elif query == "newuser":
            await _newuser(self, kv, gpcm=False)
        else:
            self.ev("CMD", "WARN", f"unhandled GPSP command '{query}' (no reply sent)", raw=kv)
