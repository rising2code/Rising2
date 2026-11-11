"""Small asyncio helpers that guarantee every connection / packet is logged.

Besides logging what arrives, they also warn about what does NOT arrive:
  * TCP: a client that connected but never sent a byte within R2_NO_DATA_WARN
    seconds (e.g. it never got our challenge, or its data never reaches us);
  * UDP: a client that re-sends the same packet after we answered it, which
    means our answer probably never reached it;
  * a source address that is a Docker NAT gateway (no host networking).
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import os
import time
import traceback

from . import log
from .config import Config

_nat_warned: set[str] = set()


def check_nat(service: str, ip: str) -> None:
    """Warn once per gateway IP when traffic arrives through Docker's NAT."""
    if ip in _nat_warned:
        return
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return
    in_docker = os.path.exists("/.dockerenv")
    if in_docker and a.version == 4 and a in ipaddress.ip_network("172.16.0.0/12") and ip.endswith(".1"):
        _nat_warned.add(ip)
        log.event("CORE", "NAT", "WARN",
                  f"traffic arrives from {ip}, which is Docker's NAT gateway: the container is NOT on host networking. "
                  "Real client IPs are hidden and every reply goes back through Docker's port forwarding. "
                  "Docker Desktop on Windows is known to lose UDP replies and stall TCP on LAN IPs this way - "
                  "if clients time out, use host networking or run the server without Docker (python -m rising2).",
                  service=service, ip=ip)


class TcpSession:
    """Base class for one TCP client. Subclasses implement on_connect / on_data."""

    SERVICE = "TCP"

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, ctx) -> None:
        self.reader = reader
        self.writer = writer
        self.ctx = ctx  # shared App object (databases, registries)
        self.addr = writer.get_extra_info("peername") or ("?", 0)
        self.local = writer.get_extra_info("sockname") or ("?", 0)
        self.ip = self.addr[0]
        self.conn_id = log.next_conn_id()
        self.user: str | None = None
        self.closed = False
        self.started = time.time()
        self.bytes_in = 0
        self.bytes_out = 0
        self.sends = 0
        self._watchdog: asyncio.Task | None = None

    # -- logging helpers ------------------------------------------------------
    def ev(self, action: str, level: str, text: str = "", **targets) -> None:
        log.event(self.SERVICE, action, level, text, user=self.user, ip=self.addr, conn=self.conn_id, **targets)

    def _connected(self) -> None:
        self.ev("CONNECT", "INFO", "new TCP connection", local=log.peer(self.local))
        check_nat(self.SERVICE, self.ip)
        self._watchdog = asyncio.create_task(self._no_data_watchdog())

    def note_recv(self, n: int) -> None:
        self.bytes_in += n

    async def _no_data_watchdog(self) -> None:
        wait = Config.NO_DATA_WARN
        if wait <= 0:
            return
        try:
            await asyncio.sleep(wait)
            if self.closed or self.bytes_in:
                return
            if self.sends:
                self.ev("NO-REPLY", "WARN",
                        f"we sent {self.bytes_out} bytes {wait}s ago and the client has not sent a single byte back - "
                        "our data is probably not reaching the client (NAT / port forwarding / firewall)")
            else:
                self.ev("NO-DATA", "WARN",
                        f"client connected {wait}s ago but sent nothing - its data is probably not reaching us "
                        "(NAT / port forwarding / firewall)")
        except asyncio.CancelledError:
            pass

    def _finished(self) -> None:
        if self._watchdog:
            self._watchdog.cancel()
        dur = time.time() - self.started
        level = "WARN" if self.bytes_in == 0 else "INFO"
        self.ev("CLOSED", level, f"connection finished after {dur:.1f}s, received {self.bytes_in} bytes, "
                f"sent {self.bytes_out} bytes" + (" - the client never sent anything" if self.bytes_in == 0 else ""))

    # -- io -------------------------------------------------------------------
    async def send(self, data: bytes, note: str = "") -> None:
        if self.closed:
            self.ev("SEND", "WARN", f"dropped {len(data)} bytes, connection already closed", note=note)
            return
        log.packet(self.SERVICE, "SEND", data, user=self.user, ip=self.addr, conn=self.conn_id, note=note)
        try:
            self.writer.write(data)
            await self.writer.drain()
            self.bytes_out += len(data)
            self.sends += 1
        except (ConnectionError, OSError) as e:
            self.ev("SEND", "ERROR", f"send failed: {e!r}")
            self.closed = True

    def close(self, reason: str) -> None:
        if not self.closed:
            self.ev("CLOSE", "INFO", f"closing by server: {reason}")
        self.closed = True
        try:
            self.writer.close()
        except Exception:
            pass

    async def on_connect(self) -> None:
        pass

    async def on_data(self, data: bytes) -> None:
        raise NotImplementedError

    async def on_close(self) -> None:
        pass

    async def run(self) -> None:
        self._connected()
        try:
            await self.on_connect()
            while not self.closed:
                try:
                    data = await self.reader.read(65536)
                except (ConnectionError, OSError) as e:
                    self.ev("DISCONNECT", "INFO", f"connection error: {e!r}")
                    break
                if not data:
                    self.ev("DISCONNECT", "INFO", "client closed the connection")
                    break
                self.note_recv(len(data))
                log.packet(self.SERVICE, "RECV", data, user=self.user, ip=self.addr, conn=self.conn_id)
                try:
                    await self.on_data(data)
                except Exception as e:
                    self.ev("ERROR", "ERROR", f"handler crashed: {e!r}\n{traceback.format_exc()}")
        finally:
            self.closed = True
            try:
                await self.on_close()
            except Exception as e:
                self.ev("ERROR", "ERROR", f"on_close crashed: {e!r}")
            try:
                self.writer.close()
            except Exception:
                pass
            self._finished()


async def start_tcp(service: str, port: int, session_cls, ctx) -> asyncio.base_events.Server:
    async def handler(reader, writer):
        session = session_cls(reader, writer, ctx)
        # every log line written while handling this connection (Auth/Sake/Competition,
        # stats, ...) carries its number; each client runs in its own task, so this is per client
        log.current_conn.set(session.conn_id)
        await session.run()

    server = await asyncio.start_server(handler, Config.BIND, port, reuse_address=True)
    log.event(service, "LISTEN", "INFO", f"TCP listening on {Config.BIND}:{port}")
    return server


class UdpService(asyncio.DatagramProtocol):
    """Base class for UDP services. Subclasses implement on_packet(data, addr)."""

    SERVICE = "UDP"
    RETRY_WINDOW = 15.0  # seconds

    def __init__(self, ctx) -> None:
        self.ctx = ctx
        self.transport: asyncio.DatagramTransport | None = None
        # addr -> (digest of last packet, time it arrived, did we answer it)
        self._last: dict = {}
        # addr -> connection number (UDP has no connection: one number per remote ip:port)
        self._peer_ids: dict = {}

    def connection_made(self, transport) -> None:
        self.transport = transport

    def conn_for(self, addr) -> int:
        addr = (addr[0], int(addr[1]))
        cid = self._peer_ids.get(addr)
        if cid is None:
            if len(self._peer_ids) > 20000:
                self._peer_ids.clear()
            cid = self._peer_ids[addr] = log.next_conn_id()
            log.event(self.SERVICE, "PEER", "INFO", "first packet from this UDP address, numbered for the log",
                      user=self.name_for(addr), ip=addr, conn=cid)
        return cid

    def datagram_received(self, data: bytes, addr) -> None:
        token = log.current_conn.set(self.conn_for(addr))
        try:
            self.receive(data, addr)
        finally:
            log.current_conn.reset(token)

    def receive(self, data: bytes, addr) -> None:
        log.packet(self.SERVICE, "RECV", data, user=self.name_for(addr), ip=addr)
        check_nat(self.SERVICE, addr[0])
        self._check_retry(data, addr)
        try:
            self.on_packet(data, addr)
        except Exception as e:
            log.event(self.SERVICE, "ERROR", "ERROR", f"handler crashed: {e!r}\n{traceback.format_exc()}", ip=addr)

    def _check_retry(self, data: bytes, addr) -> None:
        digest = hashlib.md5(data).digest()
        now = time.time()
        prev = self._last.get(addr)
        if prev and prev[0] == digest and prev[2] and now - prev[1] < self.RETRY_WINDOW:
            log.event(self.SERVICE, "RETRY", "WARN",
                      f"client re-sent the same packet {now - prev[1]:.1f}s after we answered it - "
                      "our answer probably never reached it (NAT / Docker UDP forwarding / firewall)",
                      user=self.name_for(addr), ip=addr)
        self._last[addr] = [digest, now, False]
        if len(self._last) > 5000:
            self._last.clear()

    def error_received(self, exc) -> None:
        log.event(self.SERVICE, "ERROR", "WARN", f"socket error: {exc!r}")

    def name_for(self, addr) -> str | None:
        return None

    def mark_answered(self, addr) -> None:
        if addr in self._last:
            self._last[addr][2] = True

    def send(self, data: bytes, addr, note: str = "") -> None:
        log.packet(self.SERVICE, "SEND", data, user=self.name_for(addr), ip=addr, note=note)
        self.transport.sendto(data, addr)
        self.mark_answered(addr)

    def on_packet(self, data: bytes, addr) -> None:
        raise NotImplementedError


async def start_udp(service: str, port: int, proto_factory) -> asyncio.DatagramTransport:
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(proto_factory, local_addr=(Config.BIND, port))
    log.event(service, "LISTEN", "INFO", f"UDP listening on {Config.BIND}:{port}")
    return transport
