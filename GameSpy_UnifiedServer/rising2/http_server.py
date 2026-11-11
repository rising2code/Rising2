"""HTTP on port 80: motd, AuthService, Sake, Competition and /rising2/* debug pages.

A raw asyncio HTTP/1.x server (no framework) so that every byte can be logged,
including DIME bodies and requests to paths nobody expected.
"""
from __future__ import annotations

import json
import traceback
import urllib.parse

from . import auth, comp, log, sake
from .config import Config
from .net import TcpSession
from .soap import fault, parse_envelope

MAX_BODY = 8 * 1024 * 1024


class HttpSession(TcpSession):
    SERVICE = "HTTP"

    async def run(self) -> None:  # own loop: request/response, not a stream
        self._connected()
        try:
            while not self.closed:
                try:
                    head = await self.reader.readuntil(b"\r\n\r\n")
                except Exception as e:
                    if not isinstance(e, (ConnectionError,)) and getattr(e, "partial", b""):
                        self.ev("RECV", "WARN", f"incomplete HTTP header: {log.printable(e.partial)}")
                    break
                self.note_recv(len(head))
                lines = head.decode("latin-1").split("\r\n")
                try:
                    method, target, version = lines[0].split(" ", 2)
                except ValueError:
                    self.ev("RECV", "ERROR", f"bad request line: {lines[0]!r}")
                    break
                headers = {}
                for ln in lines[1:]:
                    if ":" in ln:
                        k, v = ln.split(":", 1)
                        headers[k.strip().lower()] = v.strip()
                body = b""
                if headers.get("transfer-encoding", "").lower() == "chunked":
                    while True:
                        size = int((await self.reader.readuntil(b"\r\n")).strip().split(b";")[0], 16)
                        if size == 0:
                            await self.reader.readuntil(b"\r\n")
                            break
                        body += await self.reader.readexactly(size)
                        await self.reader.readexactly(2)
                elif "content-length" in headers:
                    n = int(headers["content-length"])
                    if n > MAX_BODY:
                        self.ev("RECV", "ERROR", f"body too large ({n})")
                        break
                    body = await self.reader.readexactly(n)
                self.note_recv(len(body))
                keep = version.upper() == "HTTP/1.1" and headers.get("connection", "").lower() != "close"
                await self.handle(method, target, version, headers, body)
                if not keep:
                    break
        finally:
            self.closed = True
            try:
                self.writer.close()
            except Exception:
                pass
            self._finished()

    async def reply(self, status: int, body: bytes, ctype: str = "text/xml; charset=utf-8", note: str = "") -> None:
        reason = {200: "OK", 404: "Not Found", 500: "Internal Server Error", 400: "Bad Request"}.get(status, "OK")
        head = (f"HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
                f"Server: Rising2-GameSpy\r\nConnection: keep-alive\r\n\r\n").encode("latin-1")
        self.ev("RESPONSE", "INFO" if status == 200 else "WARN", f"{status} {reason}, {len(body)} bytes {note}".strip())
        if Config.LOG_HTTP_BODY and body:
            self.ev("RESPONSE-BODY", "DEBUG", body[:20000].decode("utf-8", "replace"))
        try:
            self.writer.write(head + body)
            await self.writer.drain()
            self.bytes_out += len(head) + len(body)
            self.sends += 1
        except (ConnectionError, OSError) as e:
            self.ev("SEND", "ERROR", f"send failed: {e!r}")
            self.closed = True

    async def handle(self, method: str, target: str, version: str, headers: dict, body: bytes) -> None:
        url = urllib.parse.urlsplit(target)
        path = url.path
        lpath = path.lower()
        action = headers.get("soapaction", "").strip('"')
        ctype = headers.get("content-type", "")
        self.ev("REQUEST", "INFO", f"{method} {target}", host=headers.get("host"), soapaction=action or None,
                content_type=ctype or None, length=len(body), agent=headers.get("user-agent"))
        if Config.LOG_HTTP_BODY and body:
            if body.lstrip()[:1] == b"<":
                self.ev("REQUEST-BODY", "DEBUG", body[:20000].decode("utf-8", "replace"))
            else:
                self.ev("REQUEST-BODY", "DEBUG", "binary body:\n" + log.hexdump(body))
        try:
            if lpath.startswith("/motd"):
                q = dict(urllib.parse.parse_qsl(url.query))
                log.event("HTTP", "MOTD", "INFO", "message of the day requested", ip=self.addr,
                          userid=q.get("userid"), gamename=q.get("gamename"), productid=q.get("productid"))
                await self.reply(200, Config.MOTD.encode("utf-8"), "text/html")
            elif lpath == "/authservice/authservice.asmx":
                op = parse_envelope(body)
                await self.reply(200, auth.handle(op, self.ctx, self.ip), note=f"AuthService.{op.name}")
            elif lpath == "/sakestorageserver/storageserver.asmx":
                op = parse_envelope(body)
                await self.reply(200, sake.handle(op, self.ctx, self.ip), note=f"Sake.{op.name}")
            elif lpath == "/competitionservice/competitionservice.asmx":
                op, attachment = comp.parse_request(body, ctype)
                op.attachment = attachment
                await self.reply(200, comp.handle(op, self.ctx, self.ip, body, ctype), note=f"Competition.{op.name}")
            elif lpath.startswith("/rising2"):
                await self.debug_page(lpath, url.query)
            else:
                self.ev("UNKNOWN", "WARN", f"no handler for {method} {path} - answering 404",
                        host=headers.get("host"), soapaction=action or None)
                await self.reply(404, b"<error>Not Found</error>")
        except Exception as e:
            self.ev("ERROR", "ERROR", f"request failed: {e!r}\n{traceback.format_exc()}", path=path, soapaction=action)
            await self.reply(500, fault(str(e)))

    # ------------------------------------------------------------ debug ----
    async def debug_page(self, lpath: str, query: str) -> None:
        st = self.ctx.db.stats
        if lpath in ("/rising2", "/rising2/", "/rising2/status"):
            data = {
                "servers": [{"name": s.name, "addr": s.key, "listed": s.valid, "keys": s.keys, "players": s.players}
                            for s in self.ctx.qr2.servers.values()],
                "pending_challenge": [s.key for s in self.ctx.qr2.pending.values()],
                "users": len(self.ctx.db.login.all_users()),
                "reports": st.q1("SELECT COUNT(*) AS n FROM comp_reports")["n"],
                "sessions": st.q1("SELECT COUNT(*) AS n FROM comp_sessions")["n"],
                "endpoints": ["/rising2/status", "/rising2/players", "/rising2/reports", "/rising2/report?id=N",
                              "/rising2/sessions", "/rising2/keys", "/rising2/missing"],
            }
        elif lpath == "/rising2/players":
            from .stats import player_row
            data = [player_row(self.ctx, u["profileid"], u["name"]) | {"lastip": u["lastip"]}
                    for u in self.ctx.db.login.all_users()]
        elif lpath == "/rising2/reports":
            data = st.q("SELECT id, csid, ccid, received, submitter_ip, raw_size, parse_ok, parse_error, game_status, "
                        "player_count, team_count, applied FROM comp_reports ORDER BY id DESC LIMIT 200")
        elif lpath == "/rising2/report":
            rid = dict(urllib.parse.parse_qsl(query)).get("id", "0")
            r = st.q1("SELECT * FROM comp_reports WHERE id=?", (rid,))
            if r and r.get("parsed_json"):
                r["parsed"] = json.loads(r.pop("parsed_json"))
            data = {"report": r, "players": st.q("SELECT * FROM comp_report_players WHERE report_id=?", (rid,))}
        elif lpath == "/rising2/sessions":
            data = {"sessions": st.q("SELECT * FROM comp_sessions ORDER BY created DESC LIMIT 100"),
                    "intentions": st.q("SELECT * FROM comp_intentions ORDER BY id DESC LIMIT 300")}
        elif lpath == "/rising2/missing":
            data = {"folder": self.ctx.missing.dir, "items": self.ctx.missing.items()}
        elif lpath == "/rising2/keys":
            data = st.q("SELECT * FROM player_key_totals ORDER BY profileid, key_id")
        else:
            await self.reply(404, b'{"error":"unknown debug page"}', "application/json")
            return
        log.event("HTTP", "DEBUGPAGE", "INFO", lpath, ip=self.addr)
        await self.reply(200, json.dumps(data, indent=2, default=str).encode("utf-8"), "application/json")
