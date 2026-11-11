"""Small asyncio helpers that guarantee every connection / packet is logged."""
from __future__ import annotations

import asyncio
import traceback

from . import log
from .config import Config


class TcpSession:
    """Base class for one TCP client. Subclasses implement on_connect / on_data."""

    SERVICE = "TCP"

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, ctx) -> None:
        self.reader = reader
        self.writer = writer
        self.ctx = ctx  # shared App object (databases, registries)
        self.addr = writer.get_extra_info("peername") or ("?", 0)
        self.ip = self.addr[0]
        self.conn_id = log.next_conn_id()
        self.user: str | None = None
        self.closed = False

    # -- logging helpers ------------------------------------------------------
    def ev(self, action: str, level: str, text: str = "", **targets) -> None:
        log.event(self.SERVICE, action, level, text, user=self.user, ip=self.addr, conn=self.conn_id, **targets)

    # -- io -------------------------------------------------------------------
    async def send(self, data: bytes, note: str = "") -> None:
        if self.closed:
            self.ev("SEND", "WARN", f"dropped {len(data)} bytes, connection already closed", note=note)
            return
        log.packet(self.SERVICE, "SEND", data, user=self.user, ip=self.addr, conn=self.conn_id, note=note)
        try:
            self.writer.write(data)
            await self.writer.drain()
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
        self.ev("CONNECT", "INFO", "new TCP connection")
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
            self.ev("CLOSED", "INFO", "connection finished")


async def start_tcp(service: str, port: int, session_cls, ctx) -> asyncio.base_events.Server:
    async def handler(reader, writer):
        await session_cls(reader, writer, ctx).run()

    server = await asyncio.start_server(handler, Config.BIND, port, reuse_address=True)
    log.event(service, "LISTEN", "INFO", f"TCP listening on {Config.BIND}:{port}")
    return server


class UdpService(asyncio.DatagramProtocol):
    """Base class for UDP services. Subclasses implement on_packet(data, addr)."""

    SERVICE = "UDP"

    def __init__(self, ctx) -> None:
        self.ctx = ctx
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport) -> None:
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:
        log.packet(self.SERVICE, "RECV", data, user=self.name_for(addr), ip=addr)
        try:
            self.on_packet(data, addr)
        except Exception as e:
            log.event(self.SERVICE, "ERROR", "ERROR", f"handler crashed: {e!r}\n{traceback.format_exc()}", ip=addr)

    def error_received(self, exc) -> None:
        log.event(self.SERVICE, "ERROR", "WARN", f"socket error: {exc!r}")

    def name_for(self, addr) -> str | None:
        return None

    def send(self, data: bytes, addr, note: str = "") -> None:
        log.packet(self.SERVICE, "SEND", data, user=self.name_for(addr), ip=addr, note=note)
        self.transport.sendto(data, addr)

    def on_packet(self, data: bytes, addr) -> None:
        raise NotImplementedError


async def start_udp(service: str, port: int, proto_factory) -> asyncio.DatagramTransport:
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(proto_factory, local_addr=(Config.BIND, port))
    log.event(service, "LISTEN", "INFO", f"UDP listening on {Config.BIND}:{port}")
    return transport
