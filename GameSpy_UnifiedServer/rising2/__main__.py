"""Rising2 GameSpy Unified Server - entry point:  python -m rising2"""
from __future__ import annotations

import asyncio
import signal
import sys

from . import log
from .cdkey import CdKeyService, NatNegLogger
from .config import Config
from .db import Databases
from .gp import GpcmSession, GpspSession
from .http_server import HttpSession
from .net import start_tcp, start_udp
from .qr2 import Qr2Service
from .sb import SbSession
from .missing import MissingTracker
from .rules_engine import Rules
from .maintenance import Maintenance

BANNER = r"""
 ____  _     _             ____
|  _ \(_)___(_)_ __   __ _|___ \   GameSpy Unified Server
| |_) | / __| | '_ \ / _` | __) |  GP login, server list, QR2, CD key,
|  _ <| \__ \ | | | | (_| |/ __/   Auth, Sake, Competition (ATLAS) stats
|_| \_\_|___/_|_| |_|\__, |_____|
                     |___/          for Rising Eagle (gamename risingeaglepc)
"""


class App:
    def __init__(self) -> None:
        self.db = Databases()
        self.rules = Rules()
        self.missing = MissingTracker()
        self.qr2 = Qr2Service(self)
        self.maintenance = Maintenance(self)


async def main() -> int:
    log.setup()
    for line in BANNER.strip("\n").splitlines():
        log.event("CORE", "BANNER", "INFO", line)
    cfg = {k: getattr(Config, k) for k in dir(Config) if k.isupper()}
    log.event("CORE", "CONFIG", "INFO", " ".join(f"{k}={v}" for k, v in cfg.items()))

    app = App()
    failures = []

    async def guarded(name, coro):
        try:
            return await coro
        except OSError as e:
            failures.append(name)
            log.event(name, "LISTEN", "ERROR", f"could not bind: {e} - this service is DOWN")

    await guarded("GPCM", start_tcp("GPCM", Config.PORT_GPCM, GpcmSession, app))
    await guarded("GPSP", start_tcp("GPSP", Config.PORT_GPSP, GpspSession, app))
    await guarded("SB", start_tcp("SB", Config.PORT_SB, SbSession, app))
    await guarded("HTTP", start_tcp("HTTP", Config.PORT_HTTP, HttpSession, app))
    await guarded("QR2", start_udp("QR2", Config.PORT_QR, lambda: app.qr2))
    await guarded("CDKEY", start_udp("CDKEY", Config.PORT_CDKEY, lambda: CdKeyService(app)))
    if Config.ENABLE_NATNEG_LOGGER:
        await guarded("NATNEG", start_udp("NATNEG", Config.PORT_NATNEG, lambda: NatNegLogger(app)))

    asyncio.create_task(app.qr2.cleanup_loop())
    asyncio.create_task(app.qr2.summary_loop())
    asyncio.create_task(app.maintenance.loop())  # cleanup jobs: all at startup, then each on its interval

    if failures:
        log.event("CORE", "READY", "ERROR", f"started WITH FAILURES: {', '.join(failures)} could not bind")
    else:
        log.event("CORE", "READY", "INFO", "all services up - every connection and packet is logged below")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass  # Windows
    await stop.wait()
    log.event("CORE", "SHUTDOWN", "INFO", "stopping")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
