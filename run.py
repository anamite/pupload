#!/usr/bin/env python3
"""pupload launcher.  Usage:  python run.py [--host H] [--port P]"""
from __future__ import annotations

import argparse
import os
import socket


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="pupload - local file drop")
    ap.add_argument("--host", default=os.environ.get("PUPLOAD_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PUPLOAD_PORT", "8080")))
    args = ap.parse_args()

    import uvicorn

    from app import config

    cfg = config.load()
    print("")
    print(f"  {cfg['app_name']}  ->  http://{lan_ip()}:{args.port}")
    print(f"  storage: {cfg['storage_root']}")
    print("")
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
