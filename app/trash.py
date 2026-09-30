"""Recycle bin: deleted files, folders and links wait here before they are gone.

Files and folders are moved into `<storage root>/.pupload-trash/<id>/<name>`
(same disk, so deleting a 10 GB folder is an instant rename). Their metadata
rows travel with them in the bin record, so restoring brings back who uploaded
what and which files were pinned. Links are stored in the record itself.

Deleted secure items stay encrypted in the bin, under their encrypted names.
Only a device that has unlocked secure folders sees what they are, and only
such a device can restore them or delete them for good.
"""
from __future__ import annotations

import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config, db, storage, vault
from .storage import DAY, TRASH_DIRNAME, StorageError


def bin_root() -> Path:
    path = storage.root() / TRASH_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def _measure(path: Path) -> Dict[str, int]:
    if path.is_dir():
        size, files, folders = storage.tree_size(str(path))
        return {"size": size, "items": files + folders}
    try:
        return {"size": path.stat().st_size, "items": 1}
    except OSError:
        return {"size": 0, "items": 1}


def bin_path(target: Path, deleted_by: str, loc: Optional[storage.Loc] = None) -> Dict[str, Any]:
    """Move a file or folder into the bin and record it."""
    rel = storage.rel_of(target)
    if not rel:
        raise StorageError("Cannot delete the home folder")
    trash_id = uuid.uuid4().hex
    holder = bin_root() / trash_id
    holder.mkdir()
    blob = holder / target.name
    is_dir = target.is_dir()
    measured = _measure(target)
    if loc and loc.secure and not is_dir:
        measured["size"] = vault.plain_size(measured["size"])

    # Metadata keyed relative to the item, so it can be restored anywhere.
    rows = []
    for row in db.rows_under(rel):
        row = dict(row)
        row["path"] = "" if row["path"] == rel else row["path"][len(rel) + 1:]
        rows.append(row)

    try:
        shutil.move(str(target), str(blob))
    except (OSError, shutil.Error):
        shutil.rmtree(holder, ignore_errors=True)
        raise
    db.forget(rel)

    record = {
        "id": trash_id,
        "kind": "folder" if is_dir else "file",
        "name": target.name,
        "original": rel,
        "blob": str(blob),
        "size": measured["size"],
        "items": measured["items"],
        "deleted_at": time.time(),
        "deleted_by": deleted_by,
        "payload": {"meta": rows, "secure": bool(loc and loc.secure), "vault": bool(loc and loc.vault),
                    "vault_root": _vault_root(rel) if loc and loc.secure else "",
                    # a plain folder with a secure folder inside: treated as secure in the bin
                    "holds_secure": bool(is_dir and not (loc and loc.sealed) and storage.holds_vault(blob))},
    }
    db.trash_add(record)
    storage.invalidate_usage()
    return record


def _vault_root(rel: str) -> str:
    """The (plain-named) secure folder an on-disk path is inside."""
    current = storage.root()
    parts = rel.split("/")
    for i, part in enumerate(parts):
        current = current / part
        if storage.is_vault_dir(current):
            return "/".join(parts[:i + 1])
    return ""


def bin_link(link: Dict[str, Any], deleted_by: str) -> Dict[str, Any]:
    record = {
        "id": uuid.uuid4().hex,
        "kind": "link",
        "name": link.get("title") or link.get("url", ""),
        "original": link.get("url", ""),
        "blob": "",
        "size": 0,
        "items": 1,
        "deleted_at": time.time(),
        "deleted_by": deleted_by,
        "payload": {"link": link},
    }
    db.link_delete(int(link["id"]))
    db.trash_add(record)
    return record


def is_secure(row: Dict[str, Any]) -> bool:
    payload = row.get("payload") or {}
    return bool(payload.get("secure") or payload.get("vault") or payload.get("holds_secure"))


def describe(row: Dict[str, Any], cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or config.load()
    days = cfg["trash_days"]
    payload = row.get("payload") or {}
    link = payload.get("link") or {}
    name, original = row["name"], row["original"]
    secure = is_secure(row)
    keys = vault.current()
    locked = secure and keys is None
    if secure:
        if keys and payload.get("secure"):
            name = keys.dec_name(name) or name
        original = storage.logical_rel(original)
        if locked and payload.get("secure"):
            # Show which secure folder it came from, but nothing below it.
            name = "Locked item"
            original = f"{payload.get('vault_root') or 'Secure folder'}/{name}"
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": name,
        "original": original,
        "secure": secure,
        "locked": locked,
        "size": row["size"],
        "items": row["items"],
        "deleted_at": row["deleted_at"],
        "deleted_by": row["deleted_by"],
        "purge_at": row["deleted_at"] + days * DAY if days > 0 else None,
        "file_kind": storage.kind_for(name) if row["kind"] == "file" and not locked else row["kind"],
        "url": link.get("url") if row["kind"] == "link" else None,
    }


def listing() -> List[Dict[str, Any]]:
    cfg = config.load()
    hidden = vault.HIDDEN.get()
    return [describe(r, cfg) for r in db.trash_list() if not (hidden and is_secure(r))]


def restore(trash_id: str) -> Dict[str, Any]:
    row = db.trash_get(trash_id)
    if row is None or (vault.HIDDEN.get() and is_secure(row)):
        raise StorageError("Already gone from the recycle bin")
    payload = row.get("payload") or {}

    if row["kind"] == "link":
        db.link_put(payload.get("link") or {})
        db.trash_remove(trash_id)
        return {"kind": "link", "path": ""}

    keys = vault.require() if is_secure(row) else None
    blob = Path(row["blob"])
    if not blob.exists():
        db.trash_remove(trash_id)
        raise StorageError("The deleted copy is missing, so it cannot be restored")

    original = row["original"]
    parent_rel = original.rsplit("/", 1)[0] if "/" in original else ""
    parent = storage.physical(parent_rel)
    if payload.get("secure"):
        # Its encrypted name only means something inside a secure folder.
        home = storage.locate_path(parent) if parent.is_dir() else None
        if home is None or not home.sealed:
            raise StorageError("Restore the secure folder it was in first")
        real = keys.dec_name(blob.name) or "Restored item"
        target = storage.unique_path(parent, real, keys)
    else:
        where = storage.locate_path(parent)
        if where is None or where.sealed:
            raise StorageError("Its old place is now a secure folder, so it cannot go back there")
        parent.mkdir(parents=True, exist_ok=True)
        target = storage.unique_path(parent, storage.clean_name(blob.name))
    shutil.move(str(blob), str(target))
    shutil.rmtree(blob.parent, ignore_errors=True)

    new_rel = storage.rel_of(target)
    now = time.time()
    rows = []
    for meta in payload.get("meta") or []:
        meta = dict(meta)
        meta["path"] = new_rel if not meta["path"] else f"{new_rel}/{meta['path']}"
        meta["expiry_from"] = now   # a restored file gets a fresh expiry countdown
        rows.append(meta)
    db.put_rows(rows)
    db.trash_remove(trash_id)
    storage.invalidate_usage()
    shown = storage.locate_path(target)
    return {"kind": row["kind"], "path": shown.rel if shown else ""}


def _destroy(row: Dict[str, Any]) -> int:
    freed = 0
    if row["kind"] != "link" and row.get("blob"):
        blob = Path(row["blob"])
        holder = blob.parent
        # Only ever delete inside a bin folder we created.
        if holder.parent.name == TRASH_DIRNAME and holder.name == row["id"]:
            freed = int(row.get("size") or 0)
            if blob.is_dir() and not blob.is_symlink():
                shutil.rmtree(blob, ignore_errors=True)
            else:
                try:
                    blob.unlink()
                except OSError:
                    pass
            shutil.rmtree(holder, ignore_errors=True)
    db.trash_remove(row["id"])
    return freed


def delete_forever(trash_id: str) -> int:
    row = db.trash_get(trash_id)
    if row is None or (vault.HIDDEN.get() and is_secure(row)):
        return 0
    if is_secure(row):
        vault.require()
    freed = _destroy(row)
    storage.invalidate_usage()
    return freed


def empty() -> Dict[str, int]:
    """Delete everything in the bin, except secure items unless unlocked here."""
    count = freed = kept = 0
    unlocked = vault.current() is not None
    for row in db.trash_list():
        if is_secure(row) and not unlocked:
            kept += 1
            continue
        freed += _destroy(row)
        count += 1
    _clean_orphans()
    storage.invalidate_usage()
    return {"count": count, "bytes": freed, "kept": 0 if vault.HIDDEN.get() else kept}


def purge_old() -> Dict[str, int]:
    """Permanently remove bin items older than the retention setting."""
    days = config.load()["trash_days"]
    count = freed = 0
    if days > 0:
        for row in db.trash_older_than(time.time() - days * DAY):
            freed += _destroy(row)
            count += 1
    return {"count": count, "bytes": freed}


def _clean_orphans() -> None:
    """Drop bin folders with no record (left behind by a crash mid-delete)."""
    base = storage.root() / TRASH_DIRNAME
    if not base.is_dir():
        return
    known = {r["id"] for r in db.trash_list()}
    for entry in os.scandir(base):
        if entry.is_dir(follow_symlinks=False) and entry.name not in known and len(entry.name) == 32:
            shutil.rmtree(entry.path, ignore_errors=True)
