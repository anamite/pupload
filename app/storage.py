"""Filesystem layer: safe paths, listings, quota accounting and expiry."""
from __future__ import annotations

import mimetypes
import os
import re
import shutil
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import config, db

DAY = 86400.0
PART_SUFFIX = ".pupload-part"
# Recycle bin lives inside the storage root so deleting is a cheap rename on
# the same disk. It is never listed, searched, browsed or zipped.
TRASH_DIRNAME = ".pupload-trash"
# Uploads in progress are assembled here and only moved into place once
# complete, so a dropped connection never leaves a half file in a folder.
UPLOADS_DIRNAME = ".pupload-uploads"
INTERNAL_DIRS = frozenset({TRASH_DIRNAME, UPLOADS_DIRNAME})
UPLOAD_KEEP_SECONDS = 24 * 3600   # unfinished uploads can be resumed for a day

KINDS: Dict[str, Tuple[str, ...]] = {
    "image": ("jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic", "ico", "tiff"),
    "video": ("mp4", "m4v", "mkv", "webm", "mov", "avi", "mpg", "mpeg", "wmv", "flv", "3gp"),
    "audio": ("mp3", "flac", "wav", "m4a", "aac", "ogg", "oga", "opus", "wma", "aiff", "alac"),
    "pdf": ("pdf",),
    "doc": ("doc", "docx", "odt", "rtf", "ppt", "pptx", "odp", "xls", "xlsx", "ods", "csv"),
    "text": ("txt", "md", "log", "json", "xml", "yml", "yaml", "ini", "conf", "py", "js",
             "ts", "html", "css", "sh", "c", "h", "cpp", "java", "rs", "go", "sql"),
    "archive": ("zip", "tar", "gz", "bz2", "xz", "7z", "rar", "iso", "img", "deb", "rpm"),
}
EXT_TO_KIND: Dict[str, str] = {ext: kind for kind, exts in KINDS.items() for ext in exts}

# Only these are ever served inline; everything else downloads, so a stray
# .html upload can never run script against this origin.
INLINE_KINDS = {"image", "video", "audio", "pdf", "text"}

_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

_usage_lock = threading.Lock()
_usage_cache: Dict[str, Any] = {"root": None, "bytes": 0, "files": 0, "folders": 0,
                                "trash": 0, "at": 0.0}
USAGE_TTL = 20.0


class StorageError(Exception):
    """Something the user should see as a 4xx."""


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def root() -> Path:
    return config.storage_root()


def clean_name(name: str) -> str:
    """Turn arbitrary client input into one safe filename component."""
    name = unicodedata.normalize("NFC", str(name or "")).strip()
    name = name.replace("\\", "/").split("/")[-1]
    name = _BAD_CHARS.sub("_", name).strip(" .")
    if name in ("", ".", ".."):
        name = "untitled"
    if name.endswith(PART_SUFFIX) or name in INTERNAL_DIRS:
        name += "_"
    return name[:180]


def safe_join(rel: str) -> Path:
    """Resolve a client-supplied relative path inside the storage root."""
    base = root()
    rel = str(rel or "").replace("\\", "/").strip("/")
    if rel in ("", "."):
        return base
    parts: List[str] = []
    for part in rel.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise StorageError("Invalid path")
        parts.append(part)
    if parts and parts[0] in INTERNAL_DIRS:
        raise StorageError("Invalid path")
    target = Path(os.path.realpath(str(base.joinpath(*parts))))
    base_real = Path(os.path.realpath(str(base)))
    if target != base_real and base_real not in target.parents:
        raise StorageError("Invalid path")
    return target


def rel_of(path: Path) -> str:
    base = Path(os.path.realpath(str(root())))
    try:
        rel = Path(os.path.realpath(str(path))).relative_to(base)
    except ValueError:
        return ""
    return "" if str(rel) == "." else rel.as_posix()


def unique_path(folder: Path, name: str) -> Path:
    """`report.pdf` -> `report (2).pdf` when the name is taken."""
    candidate = folder / name
    if not candidate.exists():
        return candidate
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for n in range(2, 1000):
        suffix = f" ({n})"
        trial = folder / (f"{stem}{suffix}.{ext}" if ext else f"{stem}{suffix}")
        if not trial.exists():
            return trial
    return folder / f"{int(time.time())}-{name}"


def kind_of(path: Path) -> str:
    if path.is_dir():
        return "folder"
    ext = path.suffix.lower().lstrip(".")
    return EXT_TO_KIND.get(ext, "file")


def mime_of(path: Path) -> str:
    guess, _ = mimetypes.guess_type(path.name)
    if guess:
        return guess
    kind = kind_of(path)
    return "text/plain" if kind == "text" else "application/octet-stream"


def is_inline_kind(kind: str) -> bool:
    return kind in INLINE_KINDS


def is_hidden(path: Path) -> bool:
    return path.name.startswith(".") or path.name.endswith(PART_SUFFIX)


def is_internal(path: Path) -> bool:
    """Things that are never shown, even with 'show hidden files' on."""
    return path.name in INTERNAL_DIRS or path.name.endswith(PART_SUFFIX)


def keep_dirs(dirnames: List[str], show_hidden: bool) -> List[str]:
    return [d for d in dirnames
            if d not in INTERNAL_DIRS and (show_hidden or not d.startswith("."))]


# ---------------------------------------------------------------------------
# Entries and listings
# ---------------------------------------------------------------------------

def expires_at(created: float, accessed: float, pinned: bool, cfg: Dict[str, Any],
               restarted: Optional[float] = None) -> Optional[float]:
    """`restarted` is set when a file comes back from the recycle bin."""
    days = cfg.get("expiry_days") or 0
    if pinned or days <= 0:
        return None
    if cfg.get("expiry_mode") == "accessed":
        anchor = max(accessed, restarted or 0)
    else:
        anchor = max(created, restarted or 0)
    return anchor + days * DAY


def meta_expiry(meta: Dict[str, Any], cfg: Dict[str, Any]) -> Optional[float]:
    return expires_at(float(meta["created_at"]), float(meta["accessed_at"]), bool(meta["pinned"]),
                      cfg, meta.get("expiry_from"))


def entry(path: Path, cfg: Dict[str, Any], meta: Optional[Dict[str, Any]] = None,
          stat: Optional[os.stat_result] = None) -> Dict[str, Any]:
    rel = rel_of(path)
    try:
        st = stat or path.stat()
    except OSError:
        st = None
    is_dir = path.is_dir()
    size = 0 if is_dir or st is None else st.st_size
    mtime = st.st_mtime if st else time.time()

    if meta is None:
        meta = db.get(rel)
    created = float(meta["created_at"]) if meta else mtime
    accessed = float(meta["accessed_at"]) if meta else mtime
    pinned = bool(meta["pinned"]) if meta else False
    restarted = meta.get("expiry_from") if meta else None

    item: Dict[str, Any] = {
        "name": path.name,
        "path": rel,
        "parent": rel.rsplit("/", 1)[0] if "/" in rel else "",
        "is_dir": is_dir,
        "kind": kind_of(path),
        "mime": "" if is_dir else mime_of(path),
        "size": size,
        "modified": mtime,
        "created": created,
        "pinned": pinned,
        "expires": None if is_dir else expires_at(created, accessed, pinned, cfg, restarted),
        "downloads": int(meta["downloads"]) if meta else 0,
        "device_id": (meta or {}).get("device_id") or "",
        "device_name": (meta or {}).get("device_name") or "",
        "device_ip": (meta or {}).get("device_ip") or "",
    }
    if is_dir:
        try:
            item["children"] = sum(1 for _ in os.scandir(path))
        except OSError:
            item["children"] = 0
    return item


def sort_entries(items: List[Dict[str, Any]], how: str) -> List[Dict[str, Any]]:
    keys = {
        "name": lambda e: e["name"].lower(),
        "new": lambda e: -e["created"],
        "old": lambda e: e["created"],
        "size": lambda e: -e["size"],
        "expiry": lambda e: (e["expires"] is None, e["expires"] or 0),
    }
    key = keys.get(how, keys["name"])
    folders = [e for e in items if e["is_dir"]]
    files = [e for e in items if not e["is_dir"]]
    folders.sort(key=keys["name"] if how in ("size", "expiry") else key)
    files.sort(key=key)
    return folders + files


def listdir(rel: str, sort: str = "name") -> Dict[str, Any]:
    cfg = config.load()
    folder = safe_join(rel)
    if not folder.exists():
        raise StorageError("Folder not found")
    if not folder.is_dir():
        raise StorageError("Not a folder")

    paths: List[Tuple[Path, os.stat_result]] = []
    with os.scandir(folder) as it:
        for de in it:
            path = Path(de.path)
            if is_internal(path) or (is_hidden(path) and not cfg["show_hidden"]):
                continue
            try:
                paths.append((path, de.stat()))
            except OSError:
                continue

    metas = db.get_many(rel_of(p) for p, _ in paths)
    items = [entry(p, cfg, metas.get(rel_of(p)), st) for p, st in paths]
    return {"path": rel_of(folder), "items": sort_entries(items, sort)}


def walk_files(base: Optional[Path] = None) -> Iterator[Tuple[Path, os.stat_result]]:
    cfg = config.load()
    show_hidden = cfg["show_hidden"]
    for dirpath, dirnames, filenames in os.walk(str(base or root())):
        dirnames[:] = keep_dirs(dirnames, show_hidden)
        for name in filenames:
            path = Path(dirpath) / name
            if is_internal(path) or (not show_hidden and is_hidden(path)):
                continue
            try:
                yield path, path.stat()
            except OSError:
                continue


def collect(mode: str, limit: int = 300, device_id: str = "") -> List[Dict[str, Any]]:
    """Virtual folders: recent uploads, media, soonest to expire, from this device."""
    cfg = config.load()
    found: List[Dict[str, Any]] = []
    if mode == "mine":
        for rel in db.paths_for_device(device_id):
            try:
                path = safe_join(rel)
            except StorageError:
                continue
            if path.exists() and path != root():
                found.append(entry(path, cfg))
            if len(found) >= limit:
                break
        found.sort(key=lambda e: -e["created"])
        return found
    for path, st in walk_files():
        item = entry(path, cfg, stat=st)
        if mode == "media" and item["kind"] not in ("audio", "video", "image"):
            continue
        if mode == "expiring" and item["expires"] is None:
            continue
        found.append(item)
    if mode == "recent":
        found.sort(key=lambda e: -e["created"])
    elif mode == "expiring":
        found.sort(key=lambda e: e["expires"] or 0)
    else:
        found.sort(key=lambda e: (e["kind"], e["name"].lower()))
    return found[:limit]


def search(query: str, limit: int = 300) -> List[Dict[str, Any]]:
    needle = query.strip().lower()
    if not needle:
        return []
    cfg = config.load()
    hits: List[Dict[str, Any]] = []
    base = root()
    for dirpath, dirnames, filenames in os.walk(str(base)):
        dirnames[:] = keep_dirs(dirnames, cfg["show_hidden"])
        for name in list(dirnames) + filenames:
            if needle not in name.lower():
                continue
            path = Path(dirpath) / name
            if is_internal(path) or (not cfg["show_hidden"] and is_hidden(path)):
                continue
            hits.append(entry(path, cfg))
            if len(hits) >= limit:
                return hits
    return hits


def folder_tree(limit: int = 2000) -> List[Dict[str, Any]]:
    """Flat list of every folder, for the 'move to' picker."""
    cfg = config.load()
    out = [{"path": "", "name": "Home", "depth": 0}]
    base = root()
    for dirpath, dirnames, _files in os.walk(str(base)):
        dirnames[:] = keep_dirs(dirnames, cfg["show_hidden"])
        dirnames.sort(key=str.lower)
        for name in dirnames:
            rel = rel_of(Path(dirpath) / name)
            if not rel:
                continue
            out.append({"path": rel, "name": name, "depth": rel.count("/") + 1})
            if len(out) >= limit:
                return out
    return out


# ---------------------------------------------------------------------------
# Quota
# ---------------------------------------------------------------------------

def invalidate_usage() -> None:
    with _usage_lock:
        _usage_cache["at"] = 0.0


def tree_size(base: str) -> Tuple[int, int, int]:
    """(bytes, files, folders) below `base`, skipping the recycle bin and upload staging."""
    total = files = folders = 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in INTERNAL_DIRS]
        folders += len(dirnames)
        for name in filenames:
            try:
                total += (Path(dirpath) / name).stat().st_size
                files += 1
            except OSError:
                continue
    return total, files, folders


def usage(force: bool = False) -> Dict[str, int]:
    """Bytes used. `bytes` includes the recycle bin and unfinished uploads,
    which still occupy the disk."""
    base = str(root())
    keys = ("bytes", "files", "folders", "trash")
    with _usage_lock:
        fresh = (_usage_cache["root"] == base
                 and not force
                 and (time.time() - _usage_cache["at"]) < USAGE_TTL)
        if fresh:
            return {k: _usage_cache[k] for k in keys}

    live, files, folders = tree_size(base)
    binned = tree_size(os.path.join(base, TRASH_DIRNAME))[0]
    staging = tree_size(os.path.join(base, UPLOADS_DIRNAME))[0]
    result = {"bytes": live + binned + staging, "files": files, "folders": folders, "trash": binned}

    with _usage_lock:
        _usage_cache.update({"root": base, "at": time.time(), **result})
    return result


def disk() -> Dict[str, int]:
    try:
        total, used, free = shutil.disk_usage(str(root()))
    except OSError:
        return {"total": 0, "free": 0, "used": 0}
    return {"total": total, "free": free, "used": used}


def stats() -> Dict[str, Any]:
    cfg = config.load()
    use = usage()
    disk_info = disk()
    quota = cfg["quota_bytes"]
    free_disk = max(0, disk_info["free"] - cfg["keep_free_bytes"])
    limit = free_disk + use["bytes"] if quota is None else quota
    return {
        "used": use["bytes"],
        "trash_bytes": use["trash"],
        "files": use["files"],
        "folders": use["folders"],
        "quota": quota,
        "limit": limit,
        "available": max(0, min(limit - use["bytes"], free_disk)),
        "disk_total": disk_info["total"],
        "disk_free": disk_info["free"],
        "root": str(root()),
        "expiry_days": cfg["expiry_days"],
        "expiry_mode": cfg["expiry_mode"],
        "trash_days": cfg["trash_days"],
    }


def check_room(incoming: int) -> None:
    """Raise if `incoming` bytes would break the quota or fill the disk."""
    cfg = config.load()
    info = usage()
    quota = cfg["quota_bytes"]
    if quota is not None and info["bytes"] + incoming > quota:
        hint = " (emptying the recycle bin frees space)" if info["trash"] else ""
        raise StorageError("Storage limit reached" + hint)
    free = disk()["free"] - cfg["keep_free_bytes"]
    if incoming > free:
        raise StorageError("Not enough space on the disk")


# ---------------------------------------------------------------------------
# Expiry
# ---------------------------------------------------------------------------

def all_folders() -> set:
    out = set()
    for dirpath, dirnames, _files in os.walk(str(root())):
        dirnames[:] = [d for d in dirnames if d not in INTERNAL_DIRS]
        for name in dirnames:
            out.add(rel_of(Path(dirpath) / name))
    return out


def sweep() -> Dict[str, Any]:
    """Move expired files to the recycle bin, then empty bin items past retention.

    Folders and pinned files never expire.
    """
    from . import trash  # imported late: trash builds on this module

    cfg = config.load()
    removed: List[str] = []
    binned = 0
    now = time.time()
    known = set()

    for path, st in walk_files():
        rel = rel_of(path)
        known.add(rel)
        if cfg["expiry_days"] <= 0:
            continue
        meta = db.get(rel)
        if meta is None:
            db.touch(rel, st.st_size, st.st_mtime)
            continue
        due = meta_expiry(meta, cfg)
        if due is not None and due <= now:
            try:
                trash.bin_path(path, "Auto-expiry")
            except (OSError, StorageError):
                continue
            removed.append(rel)
            binned += st.st_size

    known |= all_folders()
    db.prune([p for p in db.all_paths() if p not in known])
    purged = trash.purge_old()
    stale = cleanup_partials(max_age=UPLOAD_KEEP_SECONDS)
    if removed or purged["count"] or stale:
        invalidate_usage()
    return {"removed": removed, "count": len(removed), "binned_bytes": binned,
            "purged": purged["count"], "freed": purged["bytes"]}


def uploads_dir() -> Path:
    path = root() / UPLOADS_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def cleanup_partials(max_age: float = 0) -> int:
    """Remove unfinished uploads nobody has touched for `max_age` seconds.

    With max_age=0 (server start) only legacy in-folder `.pupload-part` files
    go: their upload died with the old process. Staged resumable uploads are
    kept so the browser can pick up where it left off.
    """
    now = time.time()
    removed = 0
    staging = root() / UPLOADS_DIRNAME
    if max_age and staging.is_dir():
        for entry in os.scandir(staging):
            try:
                if entry.is_file() and now - entry.stat().st_mtime > max_age:
                    os.unlink(entry.path)
                    removed += 1
            except OSError:
                continue
    for dirpath, dirnames, filenames in os.walk(str(root())):
        dirnames[:] = [d for d in dirnames if d not in INTERNAL_DIRS]
        for name in filenames:
            if not name.endswith(PART_SUFFIX):
                continue
            path = Path(dirpath) / name
            try:
                if not max_age or now - path.stat().st_mtime > 3600:
                    path.unlink()
                    removed += 1
            except OSError:
                pass
    if removed:
        invalidate_usage()
    return removed
