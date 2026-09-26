#!/usr/bin/env python3
"""Fingerprint of the web UI sources.

The installer compares it with app/web/build-info.json to decide whether the
interface needs rebuilding. frontend/vite.config.ts computes the same value
when it builds — keep the two in step. Line endings are normalised so a
Windows checkout and a Pi checkout agree.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "frontend"
DIRS = ("src", "public")
FILES = ("index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "components.json")


def source_hash(root: Path = ROOT) -> str:
    paths = [root / f for f in FILES if (root / f).is_file()]
    for d in DIRS:
        paths += [p for p in (root / d).rglob("*") if p.is_file()]
    digest = hashlib.sha256()
    for rel in sorted(p.relative_to(root).as_posix() for p in paths):
        digest.update(rel.encode("utf-8") + b"\0")
        digest.update((root / rel).read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return digest.hexdigest()[:16]


if __name__ == "__main__":
    sys.stdout.write(source_hash() + "\n")
