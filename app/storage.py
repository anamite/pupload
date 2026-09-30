"""Filesystem layer: safe paths, listings, quota accounting and expiry.

Paths from the browser are *logical*: inside a secure folder they carry the
real names. On disk those names are encrypted (see vault.py). `locate` turns a
logical path into a `Loc` (where it is on disk plus what it is), `locate_path`
goes the other way. `rel_of` gives the on-disk relative path, which is what
the database is keyed by, so it never holds a secure file's real name.
"""
from __future__ import annotations

import mimetypes
import os
import re
import shutil
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import config, db, vault
from .errors import NotFound, StorageError, VaultLocked  # noqa: F401  (re-exported)

DAY = 86400.0
PART_SUFFIX = ".pupload-part"
# Recycle bin lives inside the storage root so deleting is a cheap rename on
# the same disk. It is never listed, searched, browsed or zipped.
TRASH_DIRNAME = ".pupload-trash"
# Uploads in progress are assembled here and only moved into place once
# complete, so a dropped connection never leaves a half file in a folder.
UPLOADS_DIRNAME = ".pupload-uploads"
# Voice memos of the private space, encrypted like secure files.
PRIVATE_DIRNAME = ".pupload-private"
INTERNAL_DIRS = frozenset({TRASH_DIRNAME, UPLOADS_DIRNAME, PRIVATE_DIRNAME})
INTERNAL_FILES = frozenset({vault.MARKER})
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
    if name.endswith(PART_SUFFIX) or name in INTERNAL_DIRS or name in INTERNAL_FILES:
        name += "_"
    return name[:180]


def fit_name(name: str, limit: int = vault.NAME_MAX_BYTES - 8) -> str:
    """Shorten a name to `limit` UTF-8 bytes, keeping its extension. Encrypted
    names are longer on disk, so secure folders allow a little less."""
    if len(name.encode("utf-8")) <= limit:
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem or len(ext.encode("utf-8")) > 16:
        stem, ext = name, ""
    suffix = f".{ext}" if ext else ""
    budget = limit - len(suffix.encode("utf-8"))
    return stem.encode("utf-8")[:budget].decode("utf-8", "ignore").rstrip() + suffix


@dataclass(frozen=True)
class Loc:
    """Something in storage: where it is on disk and what the browser calls it."""

    path: Path          # on disk
    rel: str            # logical path, real names
    secure: bool        # inside a secure folder: its name and contents are encrypted
    vault: bool         # the top folder of a secure folder

    @property
    def sealed(self) -> bool:
        """Whatever goes in here is encrypted."""
        return self.secure or self.vault

    @property
    def name(self) -> str:
        return self.rel.rsplit("/", 1)[-1]


def is_vault_dir(path: Path) -> bool:
    return (path / vault.MARKER).is_file()


def _split(rel: str) -> List[str]:
    rel = str(rel or "").replace("\\", "/").strip("/")
    parts: List[str] = []
    for part in rel.split("/"):
        if part in ("", "."):
            continue
        if part == ".." or part in INTERNAL_FILES:
            raise StorageError("Invalid path")
        parts.append(part)
    if parts and parts[0] in INTERNAL_DIRS:
        raise StorageError("Invalid path")
    return parts


def _inside(base: Path, target: Path) -> Path:
    target = Path(os.path.realpath(str(target)))
    base_real = Path(os.path.realpath(str(base)))
    if target != base_real and base_real not in target.parents:
        raise StorageError("Invalid path")
    return target


def locate(rel: str) -> Loc:
    """Resolve a browser-supplied logical path inside the storage root.

    Anything below a secure folder's top needs the vault unlocked for this
    request (VaultLocked otherwise); the top folder itself does not. Where
    secure folders are hidden (a basic remote sign-in) they don't exist at all.
    """
    base = root()
    parts = _split(rel)
    current = base
    secure = is_vault = False
    for part in parts:
        if secure or is_vault:
            current = current / vault.require().enc_name(part)
            secure, is_vault = True, False
        else:
            current = current / part
            is_vault = is_vault_dir(current)
            if is_vault and vault.HIDDEN.get():
                raise NotFound()
    return Loc(_inside(base, current), "/".join(parts), secure, is_vault)


def safe_join(rel: str) -> Path:
    return locate(rel).path


def physical(rel: str) -> Path:
    """An on-disk relative path (as stored in the database) to a Path."""
    base = root()
    parts = [p for p in str(rel or "").split("/") if p not in ("", ".")]
    if ".." in parts:
        raise StorageError("Invalid path")
    return _inside(base, base.joinpath(*parts))


def locate_path(path: Path) -> Optional[Loc]:
    """The Loc of something on disk; None if it is in a secure folder this
    request cannot open."""
    phys = rel_of(path)
    current = root()
    names: List[str] = []
    secure = is_vault = False
    for part in phys.split("/") if phys else []:
        current = current / part
        if secure or is_vault:
            keys = vault.current()
            name = keys.dec_name(part) if keys else None
            if name is None:
                return None
            names.append(name)
            secure, is_vault = True, False
        else:
            names.append(part)
            is_vault = is_vault_dir(current)
            if is_vault and vault.HIDDEN.get():
                return None
    return Loc(path, "/".join(names), secure, is_vault)


def logical_rel(phys: str) -> str:
    """Best-effort real names for an on-disk path whose folders may be gone
    (recycle bin). Parts that don't decrypt are shown as they are."""
    keys = vault.current()
    if not keys:
        return phys
    return "/".join(keys.dec_name(p) or p for p in phys.split("/")) if phys else ""


def guard(loc: Loc) -> None:
    """Changing a secure folder (even its top) needs it unlocked."""
    if loc.sealed:
        vault.require()


def holds_vault(path: Path) -> bool:
    """Is there a secure folder somewhere below this (plain) folder?"""
    if not path.is_dir():
        return False
    for dirpath, dirnames, filenames in os.walk(str(path)):
        dirnames[:] = [d for d in dirnames if d not in INTERNAL_DIRS]
        if dirpath != str(path) and vault.MARKER in filenames:
            return True
    return False


def guard_delete(loc: Loc) -> None:
    """Deleting a folder that holds a secure folder deletes that too, so it
    needs secure folders unlocked, like deleting the secure folder itself."""
    guard(loc)
    if loc.sealed or not holds_vault(loc.path):
        return
    if vault.HIDDEN.get():
        raise StorageError("This folder can't be deleted with the basic password")
    if vault.current() is None:
        raise VaultLocked("This folder holds a secure folder. Unlock secure folders to delete it")


def mark_vault(folder: Path) -> None:
    (folder / vault.MARKER).write_text('{"v": 1}\n', "utf-8")


def rel_of(path: Path) -> str:
    base = Path(os.path.realpath(str(root())))
    try:
        rel = Path(os.path.realpath(str(path))).relative_to(base)
    except ValueError:
        return ""
    return "" if str(rel) == "." else rel.as_posix()


def unique_path(folder: Path, name: str, keys: Optional["vault.Keys"] = None) -> Path:
    """`report.pdf` -> `report (2).pdf` when the name is taken. With `keys`,
    `folder` is inside a secure folder and names are encrypted."""
    def at(n: str) -> Path:
        return folder / (keys.enc_name(fit_name(n, vault.NAME_MAX_BYTES)) if keys else n)

    candidate = at(name)
    if not candidate.exists():
        return candidate
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for n in range(2, 1000):
        suffix = f" ({n})"
        trial = at(f"{stem}{suffix}.{ext}" if ext else f"{stem}{suffix}")
        if not trial.exists():
            return trial
    return at(f"{int(time.time())}-{name}")


def kind_for(name: str, is_dir: bool = False) -> str:
    if is_dir:
        return "folder"
    ext = name.rpartition(".")[2].lower() if "." in name else ""
    return EXT_TO_KIND.get(ext, "file")


def mime_for(name: str) -> str:
    guess, _ = mimetypes.guess_type(name)
    if guess:
        return guess
    return "text/plain" if kind_for(name) == "text" else "application/octet-stream"


def kind_of(path: Path) -> str:
    return kind_for(path.name, path.is_dir())


def mime_of(path: Path) -> str:
    return mime_for(path.name)


def is_inline_kind(kind: str) -> bool:
    return kind in INLINE_KINDS


def is_hidden(path: Path) -> bool:
    return hidden_name(path.name)


def hidden_name(name: str) -> bool:
    return name.startswith(".") or name.endswith(PART_SUFFIX)


def internal_name(name: str) -> bool:
    """Things that are never shown, even with 'show hidden files' on."""
    return name in INTERNAL_DIRS or name in INTERNAL_FILES or name.endswith(PART_SUFFIX)


def is_internal(path: Path) -> bool:
    return internal_name(path.name)


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
          stat: Optional[os.stat_result] = None, loc: Optional[Loc] = None) -> Dict[str, Any]:
    if loc is None:
        loc = locate_path(path)
        if loc is None:
            raise VaultLocked()
    rel = loc.rel
    try:
        st = stat or path.stat()
    except OSError:
        st = None
    is_dir = path.is_dir()
    size = 0 if is_dir or st is None else st.st_size
    if loc.secure and not is_dir:
        size = vault.plain_size(size)
    mtime = st.st_mtime if st else time.time()

    if meta is None:
        meta = db.get(rel_of(path))
    created = float(meta["created_at"]) if meta else mtime
    accessed = float(meta["accessed_at"]) if meta else mtime
    pinned = bool(meta["pinned"]) if meta else False
    restarted = meta.get("expiry_from") if meta else None
    # Secure files are never auto-expired: nobody should lose them to a timer.
    expires = None if is_dir or loc.secure else expires_at(created, accessed, pinned, cfg, restarted)

    item: Dict[str, Any] = {
        "name": loc.name,
        "path": rel,
        "parent": rel.rsplit("/", 1)[0] if "/" in rel else "",
        "is_dir": is_dir,
        "kind": kind_for(loc.name, is_dir),
        "mime": "" if is_dir else mime_for(loc.name),
        "size": size,
        "modified": mtime,
        "created": created,
        "pinned": pinned,
        "expires": expires,
        "downloads": int(meta["downloads"]) if meta else 0,
        "device_id": (meta or {}).get("device_id") or "",
        "device_name": (meta or {}).get("device_name") or "",
        "device_ip": (meta or {}).get("device_ip") or "",
        "secure": loc.sealed,
        "vault": loc.vault,
        "locked": loc.vault and vault.current() is None,
    }
    if is_dir:
        try:
            item["children"] = sum(1 for de in os.scandir(path) if not internal_name(de.name))
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


@dataclass(frozen=True)
class Node:
    loc: Loc
    is_dir: bool
    stat: os.stat_result


def children(folder: Loc, show_hidden: bool, keys: Optional["vault.Keys"]) -> List[Node]:
    """What is directly inside `folder`, with real names, sorted by name.
    `keys` must be given when `folder` is sealed."""
    out: List[Node] = []
    try:
        entries = list(os.scandir(folder.path))
    except OSError:
        return out
    for de in entries:
        if internal_name(de.name):
            continue
        if folder.sealed:
            name = keys.dec_name(de.name) if keys else None
            if name is None:
                continue
        else:
            name = de.name
        if not show_hidden and hidden_name(name):
            continue
        try:
            is_dir = de.is_dir()
            st = de.stat()
        except OSError:
            continue
        path = Path(de.path)
        rel = f"{folder.rel}/{name}" if folder.rel else name
        top = (not folder.sealed) and is_dir and is_vault_dir(path)
        if top and vault.HIDDEN.get():
            continue
        out.append(Node(Loc(path, rel, folder.sealed, top), is_dir, st))
    out.sort(key=lambda n: n.loc.name.lower())
    return out


def walk(start: Loc, show_hidden: bool, keys: Optional["vault.Keys"]) -> Iterator[Node]:
    """Everything below `start`, depth first in name order. Secure folders are
    only entered when `keys` is given; their top folder is always listed."""
    if start.sealed and keys is None:
        return
    stack = children(start, show_hidden, keys)[::-1]
    while stack:
        node = stack.pop()
        yield node
        if not node.is_dir:
            continue
        if node.loc.sealed and keys is None:
            continue
        try:
            if node.loc.path.is_symlink():
                continue
        except OSError:
            continue
        stack.extend(children(node.loc, show_hidden, keys)[::-1])


def home() -> Loc:
    return Loc(root(), "", False, False)


def listdir(rel: str, sort: str = "name") -> Dict[str, Any]:
    cfg = config.load()
    loc = locate(rel)
    if not loc.path.exists():
        raise StorageError("Folder not found")
    if not loc.path.is_dir():
        raise StorageError("Not a folder")
    keys = vault.require() if loc.sealed else None

    nodes = children(loc, cfg["show_hidden"], keys)
    metas = db.get_many(rel_of(n.loc.path) for n in nodes)
    items = [entry(n.loc.path, cfg, metas.get(rel_of(n.loc.path)), n.stat, n.loc) for n in nodes]
    return {"path": loc.rel, "items": sort_entries(items, sort),
            "folder": {"secure": loc.sealed, "vault": loc.vault}}


def collect(mode: str, limit: int = 300, device_id: str = "") -> List[Dict[str, Any]]:
    """Virtual folders: recent uploads, media, soonest to expire, from this device.
    Secure files show up only on a device that has unlocked them."""
    cfg = config.load()
    found: List[Dict[str, Any]] = []
    if mode == "mine":
        for rel in db.paths_for_device(device_id):
            try:
                path = physical(rel)
            except StorageError:
                continue
            if not path.exists() or path == root():
                continue
            loc = locate_path(path)
            if loc is None:
                continue
            found.append(entry(path, cfg, loc=loc))
            if len(found) >= limit:
                break
        found.sort(key=lambda e: -e["created"])
        return found
    for node in walk(home(), cfg["show_hidden"], vault.current()):
        if node.is_dir:
            continue
        item = entry(node.loc.path, cfg, stat=node.stat, loc=node.loc)
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
    for node in walk(home(), cfg["show_hidden"], vault.current()):
        if needle not in node.loc.name.lower():
            continue
        hits.append(entry(node.loc.path, cfg, stat=node.stat, loc=node.loc))
        if len(hits) >= limit:
            break
    return hits


def folder_tree(limit: int = 2000) -> List[Dict[str, Any]]:
    """Every folder in tree order, for the 'move to' picker. Locked secure
    folders are listed (so they can be seen) but not entered."""
    cfg = config.load()
    keys = vault.current()
    out: List[Dict[str, Any]] = [{"path": "", "name": "Home", "depth": 0, "secure": False, "locked": False}]
    for node in walk(home(), cfg["show_hidden"], keys):
        if not node.is_dir:
            continue
        loc = node.loc
        out.append({"path": loc.rel, "name": loc.name, "depth": loc.rel.count("/") + 1,
                    "secure": loc.sealed, "locked": loc.vault and keys is None})
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Moving across a secure folder's edge
# ---------------------------------------------------------------------------

def move_into(src: Loc, dest: Loc) -> Path:
    """Move `src` into the folder `dest` and return where it landed.

    Within plain storage, or within secure folders (one key for all of them),
    this is a rename. Going in or out of a secure folder re-encrypts or
    decrypts the contents into a staging copy, which then replaces the original.
    """
    keys = vault.require() if (src.sealed or dest.sealed) else None
    name = fit_name(src.name) if dest.sealed else src.name
    target = unique_path(dest.path, name, keys if dest.sealed else None)
    old_rel = rel_of(src.path)

    if src.vault or src.secure == dest.sealed:
        shutil.move(str(src.path), str(target))
        if src.vault and dest.sealed:
            # One secure folder dropped into another: same key, so everything
            # inside stays as it is; it simply stops being a separate top.
            (target / vault.MARKER).unlink(missing_ok=True)
        db.rename(old_rel, rel_of(target))
        invalidate_usage()
        return target

    check_room(tree_size(str(src.path))[0] if src.path.is_dir() else src.path.stat().st_size)
    staging = uploads_dir() / f"move-{uuid.uuid4().hex}"
    pairs: List[Tuple[str, str]] = []
    try:
        _convert(src.path, staging, dest.sealed, keys, "", pairs)
        os.replace(staging, target)
    except BaseException:
        if staging.is_dir():
            shutil.rmtree(staging, ignore_errors=True)
        else:
            staging.unlink(missing_ok=True)
        raise
    if src.path.is_dir():
        shutil.rmtree(src.path, ignore_errors=True)
    else:
        src.path.unlink(missing_ok=True)
    new_rel = rel_of(target)
    db.rekey([(old, f"{new_rel}/{sub}" if sub else new_rel) for old, sub in pairs])
    db.forget(old_rel)
    invalidate_usage()
    return target


def _convert(src: Path, dst: Path, encrypt: bool, keys: "vault.Keys", sub: str,
             pairs: List[Tuple[str, str]]) -> None:
    """Copy `src` to `dst`, encrypting (or decrypting) contents and names below it.
    Records (old on-disk rel, new rel below the target) for the database."""
    pairs.append((rel_of(src), sub))
    if not src.is_dir():
        if encrypt:
            vault.encrypt_file(src, dst, keys)
        elif vault.is_encrypted(src):
            vault.decrypt_file(src, dst, keys)
        else:
            shutil.copy2(str(src), str(dst))
        return
    dst.mkdir()
    for de in os.scandir(src):
        child = Path(de.path)
        if internal_name(de.name):
            continue
        if encrypt:
            new_name = unique_path(dst, fit_name(de.name), keys).name
        else:
            real = keys.dec_name(de.name)
            new_name = unique_path(dst, clean_name(real)).name if real else de.name
        target = dst / new_name
        child_sub = f"{sub}/{new_name}" if sub else new_name
        if encrypt and de.is_dir() and is_vault_dir(child):
            # A secure folder inside a plain folder that is being secured:
            # its contents are encrypted already, only its own name changes.
            shutil.move(str(child), str(target))
            (target / vault.MARKER).unlink(missing_ok=True)
            for row in db.rows_under(rel_of(child)):
                rest = row["path"][len(rel_of(child)):]
                pairs.append((row["path"], child_sub + rest))
            continue
        _convert(child, target, encrypt, keys, child_sub, pairs)


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
            except OSError:
                continue
            if name not in INTERNAL_FILES:
                files += 1
    return total, files, folders


def usage(force: bool = False) -> Dict[str, int]:
    """Bytes used. `bytes` includes the recycle bin, unfinished uploads and
    voice memos, which all occupy the disk."""
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
    memos = tree_size(os.path.join(base, PRIVATE_DIRNAME))[0]
    result = {"bytes": live + binned + staging + memos, "files": files, "folders": folders, "trash": binned}

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

def _all_files(show_hidden: bool) -> Iterator[Tuple[Path, os.stat_result, bool]]:
    """Every file on disk as (path, stat, inside a secure folder). Works on the
    encrypted names, so it needs no key."""
    sealed_dirs = set()
    for dirpath, dirnames, filenames in os.walk(str(root())):
        dirnames[:] = [d for d in dirnames if d not in INTERNAL_DIRS]
        sealed = dirpath in sealed_dirs or vault.MARKER in filenames
        if sealed:
            sealed_dirs.update(os.path.join(dirpath, d) for d in dirnames)
        for name in filenames:
            if internal_name(name) or (not sealed and not show_hidden and hidden_name(name)):
                continue
            path = Path(dirpath) / name
            try:
                yield path, path.stat(), sealed
            except OSError:
                continue


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

    for path, st, sealed in _all_files(cfg["show_hidden"]):
        rel = rel_of(path)
        known.add(rel)
        if cfg["expiry_days"] <= 0 or sealed:   # secure files never expire
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
                if now - entry.stat().st_mtime <= max_age:
                    continue
                if entry.is_file():
                    os.unlink(entry.path)
                    removed += 1
                elif entry.is_dir() and entry.name.startswith("move-"):
                    shutil.rmtree(entry.path, ignore_errors=True)   # a move cut short
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
