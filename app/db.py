"""Tiny SQLite side-table holding the metadata the filesystem cannot keep.

The filesystem is the source of truth for what exists; `meta` only remembers
when a file was uploaded, by which device, when it was last read, and whether
it is pinned (pinned files never expire).

`links` holds saved bookmarks (they never expire), and `trash` is the recycle
bin index: one row per deleted file, folder or link.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .config import DATA_DIR

DB_PATH = DATA_DIR / "pupload.db"

_local = threading.local()
_write_lock = threading.Lock()

# The original (v1) table. Everything after it is a numbered migration.
BASE_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    path        TEXT PRIMARY KEY,
    created_at  REAL NOT NULL,
    accessed_at REAL NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    pinned      INTEGER NOT NULL DEFAULT 0,
    downloads   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meta_created ON meta(created_at);
"""


def _add_column(cx: sqlite3.Connection, table: str, name: str, decl: str) -> None:
    have = {row[1] for row in cx.execute(f"PRAGMA table_info({table})")}
    if name not in have:
        cx.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def _m1_devices_links_trash(cx: sqlite3.Connection) -> None:
    """2.0: uploader device on files, saved links, recycle bin."""
    for name, decl in (("device_id", "TEXT NOT NULL DEFAULT ''"),
                       ("device_name", "TEXT NOT NULL DEFAULT ''"),
                       ("device_ip", "TEXT NOT NULL DEFAULT ''"),
                       ("expiry_from", "REAL")):
        _add_column(cx, "meta", name, decl)
    cx.executescript("""
    CREATE TABLE IF NOT EXISTS links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        url         TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        pinned      INTEGER NOT NULL DEFAULT 0,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL,
        device_id   TEXT NOT NULL DEFAULT '',
        device_name TEXT NOT NULL DEFAULT '',
        device_ip   TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS trash (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,            -- file | folder | link
        name        TEXT NOT NULL,
        original    TEXT NOT NULL DEFAULT '', -- relative path it was deleted from
        blob        TEXT NOT NULL DEFAULT '', -- absolute path of the stored copy
        size        INTEGER NOT NULL DEFAULT 0,
        items       INTEGER NOT NULL DEFAULT 0,
        deleted_at  REAL NOT NULL,
        deleted_by  TEXT NOT NULL DEFAULT '',
        payload     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_meta_device ON meta(device_id);
    """)


# Schema changes, applied in order exactly once and recorded in PRAGMA
# user_version. To change the schema: append a function here — never edit or
# reorder an existing one. Each must be safe on a database that already has
# the change (use _add_column / IF NOT EXISTS).
MIGRATIONS: List[Callable[[sqlite3.Connection], None]] = [
    _m1_devices_links_trash,
]
SCHEMA_VERSION = len(MIGRATIONS)


def _backup(cx: sqlite3.Connection, label: str) -> None:
    """Consistent copy of the database into data/backups (keeps the last 10)."""
    folder = DATA_DIR / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    dest = sqlite3.connect(str(folder / f"pupload-{time.strftime('%Y%m%d-%H%M%S')}-{label}.db"))
    try:
        cx.backup(dest)
    finally:
        dest.close()
    for old in sorted(folder.glob("pupload-*.db"))[:-10]:
        try:
            old.unlink()
        except OSError:
            pass


def _migrate(cx: sqlite3.Connection) -> None:
    cx.executescript(BASE_SCHEMA)
    version = cx.execute("PRAGMA user_version").fetchone()[0]
    if version >= SCHEMA_VERSION:
        return
    has_data = cx.execute("SELECT EXISTS (SELECT 1 FROM meta)").fetchone()[0]
    if has_data or version:
        _backup(cx, f"before-schema-{SCHEMA_VERSION}")
    for number, step in enumerate(MIGRATIONS, start=1):
        if number <= version:
            continue
        with cx:  # each step commits on its own, so a failure leaves a known version
            step(cx)
            cx.execute(f"PRAGMA user_version = {number}")


def conn() -> sqlite3.Connection:
    existing = getattr(_local, "conn", None)
    if existing is not None:
        return existing
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cx = sqlite3.connect(str(DB_PATH), timeout=10, check_same_thread=False)
    cx.row_factory = sqlite3.Row
    cx.execute("PRAGMA journal_mode=WAL")
    cx.execute("PRAGMA synchronous=NORMAL")
    with _write_lock:
        _migrate(cx)
    _local.conn = cx
    return cx


# ---------------------------------------------------------------------------
# File metadata
# ---------------------------------------------------------------------------

def get(path: str) -> Optional[Dict[str, Any]]:
    row = conn().execute("SELECT * FROM meta WHERE path = ?", (path,)).fetchone()
    return dict(row) if row else None


def get_many(paths: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    paths = list(paths)
    if not paths:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    cx = conn()
    for i in range(0, len(paths), 400):
        chunk = paths[i:i + 400]
        marks = ",".join("?" * len(chunk))
        for row in cx.execute(f"SELECT * FROM meta WHERE path IN ({marks})", chunk):
            out[row["path"]] = dict(row)
    return out


def touch(path: str, size: int, created_at: Optional[float] = None,
          device: Optional[Dict[str, str]] = None) -> None:
    """Record (or refresh) a file we just wrote, and which device sent it."""
    now = time.time()
    created = created_at if created_at is not None else now
    dev = device or {}
    with _write_lock:
        cx = conn()
        if dev:
            cx.execute(
                "INSERT INTO meta (path, created_at, accessed_at, size, device_id, device_name, device_ip) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET size = excluded.size, accessed_at = excluded.accessed_at, "
                "created_at = excluded.created_at, expiry_from = NULL, device_id = excluded.device_id, "
                "device_name = excluded.device_name, device_ip = excluded.device_ip",
                (path, created, now, int(size), dev.get("id", ""), dev.get("name", ""), dev.get("ip", "")),
            )
        else:
            cx.execute(
                "INSERT INTO meta (path, created_at, accessed_at, size) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET size = excluded.size, accessed_at = excluded.accessed_at",
                (path, created, now, int(size)),
            )
        cx.commit()


def mark_access(path: str) -> None:
    with _write_lock:
        cx = conn()
        cx.execute(
            "UPDATE meta SET accessed_at = ?, downloads = downloads + 1 WHERE path = ?",
            (time.time(), path),
        )
        cx.commit()


def set_pinned(path: str, pinned: bool) -> None:
    with _write_lock:
        cx = conn()
        cx.execute("UPDATE meta SET pinned = ? WHERE path = ?", (1 if pinned else 0, path))
        cx.commit()


def rows_under(path: str) -> List[Dict[str, Any]]:
    """Every metadata row for `path` and anything beneath it."""
    cx = conn()
    rows = cx.execute("SELECT * FROM meta WHERE path = ? OR path LIKE ? ESCAPE '!'", (path, _like_prefix(path)))
    return [dict(r) for r in rows]


def put_rows(rows: Iterable[Dict[str, Any]]) -> None:
    """Re-insert rows captured by `rows_under` (used when restoring from the bin)."""
    rows = list(rows)
    if not rows:
        return
    with _write_lock:
        cx = conn()
        for row in rows:
            cols = [c for c in row.keys() if c in _meta_cols(cx)]
            marks = ",".join("?" * len(cols))
            cx.execute(f"INSERT OR REPLACE INTO meta ({','.join(cols)}) VALUES ({marks})",
                       [row[c] for c in cols])
        cx.commit()


def forget(path: str) -> None:
    """Drop a path and anything beneath it (used after delete)."""
    with _write_lock:
        cx = conn()
        cx.execute("DELETE FROM meta WHERE path = ? OR path LIKE ? ESCAPE '!'", (path, _like_prefix(path)))
        cx.commit()


def rename(old: str, new: str) -> None:
    """Re-key a path and everything beneath it (used after rename/move)."""
    with _write_lock:
        cx = conn()
        cx.execute("DELETE FROM meta WHERE path = ? OR path LIKE ? ESCAPE '!'", (new, _like_prefix(new)))
        cx.execute("UPDATE meta SET path = ? WHERE path = ?", (new, old))
        cx.execute(
            "UPDATE meta SET path = ? || substr(path, ?) WHERE path LIKE ? ESCAPE '!'",
            (new, len(old) + 1, _like_prefix(old)),
        )
        cx.commit()


def rekey(pairs: Iterable[Tuple[str, str]]) -> None:
    """Re-key individual rows (old, new), for moves where names below change too."""
    with _write_lock:
        cx = conn()
        for old, new in pairs:
            cx.execute("UPDATE OR REPLACE meta SET path = ? WHERE path = ?", (new, old))
        cx.commit()


def all_paths() -> List[str]:
    return [row["path"] for row in conn().execute("SELECT path FROM meta")]


def paths_for_device(device_id: str) -> List[str]:
    rows = conn().execute("SELECT path FROM meta WHERE device_id = ? ORDER BY created_at DESC", (device_id,))
    return [row["path"] for row in rows]


def prune(paths: Iterable[str]) -> None:
    """Remove rows for files that no longer exist on disk."""
    paths = list(paths)
    if not paths:
        return
    with _write_lock:
        cx = conn()
        for i in range(0, len(paths), 400):
            chunk = paths[i:i + 400]
            marks = ",".join("?" * len(chunk))
            cx.execute(f"DELETE FROM meta WHERE path IN ({marks})", chunk)
        cx.commit()


def _like_prefix(path: str) -> str:
    escaped = path.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return escaped + "/%"


_META_COLS: Optional[set] = None


def _meta_cols(cx: sqlite3.Connection) -> set:
    global _META_COLS
    if _META_COLS is None:
        _META_COLS = {row["name"] for row in cx.execute("PRAGMA table_info(meta)")}
    return _META_COLS


# ---------------------------------------------------------------------------
# Links
# ---------------------------------------------------------------------------

def _link(row: sqlite3.Row) -> Dict[str, Any]:
    item = dict(row)
    try:
        item["tags"] = json.loads(item.get("tags") or "[]")
    except ValueError:
        item["tags"] = []
    item["pinned"] = bool(item["pinned"])
    return item


def links() -> List[Dict[str, Any]]:
    rows = conn().execute("SELECT * FROM links ORDER BY pinned DESC, created_at DESC")
    return [_link(r) for r in rows]


def link_get(link_id: int) -> Optional[Dict[str, Any]]:
    row = conn().execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone()
    return _link(row) if row else None


def link_add(url: str, title: str, note: str, tags: List[str], device: Dict[str, str]) -> int:
    now = time.time()
    with _write_lock:
        cx = conn()
        cur = cx.execute(
            "INSERT INTO links (url, title, note, tags, created_at, updated_at, device_id, device_name, device_ip) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (url, title, note, json.dumps(tags), now, now,
             device.get("id", ""), device.get("name", ""), device.get("ip", "")),
        )
        cx.commit()
        return int(cur.lastrowid)


def link_update(link_id: int, fields: Dict[str, Any]) -> None:
    allowed = {"url", "title", "note", "tags", "pinned"}
    sets, values = [], []
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key == "tags":
            value = json.dumps(value)
        if key == "pinned":
            value = 1 if value else 0
        sets.append(f"{key} = ?")
        values.append(value)
    if not sets:
        return
    sets.append("updated_at = ?")
    values.append(time.time())
    with _write_lock:
        cx = conn()
        cx.execute(f"UPDATE links SET {', '.join(sets)} WHERE id = ?", (*values, link_id))
        cx.commit()


def link_set_title_if_empty(link_id: int, title: str) -> None:
    with _write_lock:
        cx = conn()
        cx.execute("UPDATE links SET title = ? WHERE id = ? AND title = ''", (title, link_id))
        cx.commit()


def link_delete(link_id: int) -> None:
    with _write_lock:
        cx = conn()
        cx.execute("DELETE FROM links WHERE id = ?", (link_id,))
        cx.commit()


def link_put(row: Dict[str, Any]) -> None:
    """Re-insert a link captured in the recycle bin, keeping its id."""
    item = dict(row)
    item["tags"] = json.dumps(item.get("tags") or [])
    item["pinned"] = 1 if item.get("pinned") else 0
    cols = ["id", "url", "title", "note", "tags", "pinned", "created_at", "updated_at",
            "device_id", "device_name", "device_ip"]
    with _write_lock:
        cx = conn()
        cx.execute(f"INSERT OR REPLACE INTO links ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                   [item.get(c, "") if c not in ("id", "created_at", "updated_at") else item.get(c)
                    for c in cols])
        cx.commit()


# ---------------------------------------------------------------------------
# Recycle bin
# ---------------------------------------------------------------------------

def _trash(row: sqlite3.Row) -> Dict[str, Any]:
    item = dict(row)
    try:
        item["payload"] = json.loads(item.get("payload") or "{}")
    except ValueError:
        item["payload"] = {}
    return item


def trash_add(row: Dict[str, Any]) -> None:
    item = dict(row)
    item["payload"] = json.dumps(item.get("payload") or {})
    cols = ["id", "kind", "name", "original", "blob", "size", "items", "deleted_at", "deleted_by", "payload"]
    with _write_lock:
        cx = conn()
        cx.execute(f"INSERT INTO trash ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                   [item.get(c) for c in cols])
        cx.commit()


def trash_list() -> List[Dict[str, Any]]:
    return [_trash(r) for r in conn().execute("SELECT * FROM trash ORDER BY deleted_at DESC")]


def trash_get(trash_id: str) -> Optional[Dict[str, Any]]:
    row = conn().execute("SELECT * FROM trash WHERE id = ?", (trash_id,)).fetchone()
    return _trash(row) if row else None


def trash_older_than(cutoff: float) -> List[Dict[str, Any]]:
    rows = conn().execute("SELECT * FROM trash WHERE deleted_at <= ?", (cutoff,))
    return [_trash(r) for r in rows]


def trash_remove(trash_id: str) -> None:
    with _write_lock:
        cx = conn()
        cx.execute("DELETE FROM trash WHERE id = ?", (trash_id,))
        cx.commit()
