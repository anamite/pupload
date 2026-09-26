#!/usr/bin/env python3
"""pupload launcher.  Usage:  python run.py [--host H] [--port P] [--strict-port]"""
from __future__ import annotations

import argparse
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


def pick_port(host: str, wanted: int, strict: bool) -> int:
    if port_free(host, wanted) or strict:
        return wanted
    for port in range(wanted + 1, min(wanted + PORT_SEARCH, 65535) + 1):
        if port_free(host, port):
            print(f"  ! port {wanted} is in use by another program, using {port} instead", flush=True)
            return port
    sys.exit(f"No free port between {wanted} and {wanted + PORT_SEARCH}; pass --port")


def main() -> None:
    ap = argparse.ArgumentParser(description="pupload - local file drop")
    ap.add_argument("--host", default=os.environ.get("PUPLOAD_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PUPLOAD_PORT", "8080")))
    ap.add_argument("--strict-port", action="store_true",
                    help="fail instead of moving to the next free port when the port is taken")
    args = ap.parse_args()

    import uvicorn

    from app import config

    port = pick_port(args.host, args.port, args.strict_port)
    cfg = config.load()
    # Tell the installer (and anyone curious) where we actually ended up.
    try:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        (config.DATA_DIR / "port").write_text(f"{port}\n", "utf-8")
    except OSError:
        pass

    print("")
    print(f"  {cfg['app_name']}  ->  http://{lan_ip()}:{port}", flush=True)
    print(f"  storage: {cfg['storage_root']}")
    print("")
    uvicorn.run("app.main:app", host=args.host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
