#!/usr/bin/env python3
"""pupload launcher.

Usage:  python run.py [--host H] [--port P] [--strict-port] [--remote-port R] [--remote-host H]

Serves two ports from one process: the home-network port (no login) and the
remote port for a tunnel such as Cloudflare Tunnel (password + authenticator
code; see Settings -> Remote access). --remote-port 0 turns the second one off.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys

PORT_SEARCH = 50   # how far past the requested port to look for a free one


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def port_free(host: str, port: int) -> bool:
    """True if nothing answers on the port and we could listen on host:port."""
    for probe in ("127.0.0.1", "::1"):
        try:
            socket.create_connection((probe, port), timeout=1).close()
            return False
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def pick_port(host: str, wanted: int, strict: bool, avoid: int = 0) -> int:
    if strict or (wanted != avoid and port_free(host, wanted)):
        return wanted
    for port in range(wanted + 1, min(wanted + PORT_SEARCH, 65535) + 1):
        if port != avoid and port_free(host, port):
            print(f"  ! port {wanted} is in use by another program, using {port} instead", flush=True)
            return port
    sys.exit(f"No free port between {wanted} and {wanted + PORT_SEARCH}; pass --port")


def pick_remote_port(host: str, wanted: int, avoid: int, saved: "os.PathLike[str]") -> int:
    """The remote port, or 0 (off). Like the home-network port it moves to the
    next free one when taken, but only the first time: after that it is saved
    and kept, because a tunnel points at it. Asking for another port starts over."""
    from pathlib import Path

    from app import remote

    if not 0 < wanted < 65536:
        return 0
    record = Path(saved)
    try:
        asked, chosen = (int(n) for n in record.read_text("utf-8").split())
    except (OSError, ValueError):
        asked = chosen = 0
    if asked == wanted and chosen:
        if chosen != avoid and port_free(host, chosen):
            return chosen
        remote.LISTEN["error"] = (f"port {chosen}, where your tunnel points, is used by another program. "
                                  f"Stop that program, or delete data/remote-port to let pupload pick a new one")
        print(f"  ! remote access is off: port {chosen} is used by another program", flush=True)
        return 0
    for port in range(wanted, min(wanted + PORT_SEARCH, 65535) + 1):
        if port != avoid and port_free(host, port):
            if port != wanted:
                print(f"  ! port {wanted} is in use by another program, remote access uses {port}", flush=True)
            try:
                record.write_text(f"{wanted} {port}\n", "utf-8")
            except OSError:
                pass
            return port
    remote.LISTEN["error"] = f"no free port between {wanted} and {wanted + PORT_SEARCH}"
    print(f"  ! remote access is off: {remote.LISTEN['error']}", flush=True)
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="pupload - local file drop")
    ap.add_argument("--host", default=os.environ.get("PUPLOAD_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PUPLOAD_PORT", "8080")))
    ap.add_argument("--strict-port", action="store_true",
                    help="fail instead of moving to the next free port when the port is taken")
    ap.add_argument("--remote-port", type=int, default=int(os.environ.get("PUPLOAD_REMOTE_PORT", "8090")),
                    help="preferred port for remote access through a tunnel (0 = off). If taken the first "
                         "time, the next free one is used and kept from then on (data/remote-port)")
    ap.add_argument("--remote-host", default=os.environ.get("PUPLOAD_REMOTE_HOST", "127.0.0.1"),
                    help="address for the remote port; keep 127.0.0.1 so only the tunnel can reach it")
    args = ap.parse_args()

    import uvicorn

    from app import config, remote

    port = pick_port(args.host, args.port, args.strict_port, avoid=args.remote_port)
    cfg = config.load()
    # Tell the installer (and anyone curious) where we actually ended up.
    try:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        (config.DATA_DIR / "port").write_text(f"{port}\n", "utf-8")
    except OSError:
        pass

    remote_port = pick_remote_port(args.remote_host, args.remote_port, port, config.DATA_DIR / "remote-port")
    if remote_port:
        remote.LISTEN.update(host=args.remote_host, port=remote_port)

    print("")
    print(f"  {cfg['app_name']}  ->  http://{lan_ip()}:{port}", flush=True)
    if remote_port:
        state = "set up" if remote.configured() else "not set up yet: Settings -> Remote access"
        print(f"  remote access (for a tunnel)  ->  http://{args.remote_host}:{remote_port}  ({state})")
    print(f"  storage: {cfg['storage_root']}")
    print("")

    from app.main import app, remote_app

    servers = [uvicorn.Server(uvicorn.Config(app, host=args.host, port=port, log_level="info",
                                             access_log=False))]
    if remote_port:
        # No lifespan: background jobs run once, with the home-network server.
        servers.append(uvicorn.Server(uvicorn.Config(remote_app, host=args.remote_host, port=remote_port,
                                                     log_level="info", access_log=False,
                                                     lifespan="off", proxy_headers=False)))
    asyncio.run(serve(servers))


async def serve(servers: list) -> None:
    """Run the servers side by side; when one stops (Ctrl+C, systemd), stop all."""
    async def run(server) -> None:
        try:
            await server.serve()
        except SystemExit:           # could not start (port grabbed meanwhile)
            if server is servers[0]:
                raise
            print(f"  ! remote access could not start on port {server.config.port}", flush=True)
            from app import remote
            remote.LISTEN.update(port=None, error=f"could not listen on port {server.config.port}")

    tasks = [asyncio.create_task(run(s)) for s in servers]
    await tasks[0]
    for server in servers[1:]:
        server.should_exit = True
    await asyncio.gather(*tasks[1:], return_exceptions=True)


if __name__ == "__main__":
    main()
