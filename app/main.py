"""HTTP layer. Starlette + uvicorn; the React UI is prebuilt into app/web."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import time
import urllib.parse
import zipfile
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Iterator, List, Optional

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import ClientDisconnect, Request
from starlette.responses import (FileResponse, HTMLResponse, JSONResponse, Response,
                                 StreamingResponse)
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import __version__, config, db, links, storage, trash, vault
from .errors import StorageError, VaultLocked
from .links import LinkError
from .storage import Loc

WEB_DIR = Path(__file__).resolve().parent / "web"
mimetypes.add_type("application/manifest+json", ".webmanifest")
THUMB_DIR = config.DATA_DIR / "thumbs"
CHUNK = 256 * 1024
SWEEP_INTERVAL = 30 * 60
SECURE_THUMB_MAX = 40 * 1024 * 1024     # decrypting bigger images for a preview isn't worth it
NO_CRYPTO = ("Secure folders need the 'cryptography' Python package. "
             "Run the installer again to add it.")

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
_DEVICE_ID_RE = re.compile(r"[^A-Za-z0-9_-]")
_UPLOAD_ID_RE = re.compile(r"^[a-f0-9]{16,64}$")
# A sender that goes quiet this long (phone asleep, Wi-Fi gone) is dropped, so
# a dead connection never holds an upload open for hours.
IDLE_TIMEOUT = 60
_upload_locks: Dict[str, asyncio.Lock] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ok(payload: Any = None, **extra: Any) -> JSONResponse:
    body: Dict[str, Any] = {"ok": True}
    if isinstance(payload, dict):
        body.update(payload)
    elif payload is not None:
        body["data"] = payload
    body.update(extra)
    return JSONResponse(body)


def fail(message: str, status: int = 400) -> JSONResponse:
    body: Dict[str, Any] = {"ok": False, "error": message}
    if status == 423:
        body["locked"] = True
    return JSONResponse(body, status_code=status)


def err(exc: Exception, status: int = 400) -> JSONResponse:
    """A StorageError as a reply; a locked secure folder is always 423."""
    return fail(str(exc), getattr(exc, "status", None) or status)


async def body_json(request: Request) -> Dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def device_of(request: Request) -> Dict[str, str]:
    """Who is calling: the browser sends a random per-device id and a friendly name."""
    raw_name = urllib.parse.unquote(request.headers.get("x-device-name") or "")
    name = re.sub(r"\s+", " ", raw_name).strip()[:60]
    return {
        "id": _DEVICE_ID_RE.sub("", request.headers.get("x-device-id") or "")[:64],
        "name": name or "Unknown device",
        "ip": request.client.host if request.client else "",
    }


def paths_from(data: Dict[str, Any]) -> List[str]:
    paths = data.get("paths") or ([data["path"]] if data.get("path") else [])
    return [str(p) for p in paths if isinstance(p, (str, int))]


def content_disposition(name: str, inline: bool) -> str:
    kind = "inline" if inline else "attachment"
    ascii_name = name.encode("ascii", "ignore").decode("ascii").replace('"', "") or "file"
    quoted = urllib.parse.quote(name, safe="")
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"


def file_iterator(path: Path, start: int = 0, length: Optional[int] = None) -> Iterator[bytes]:
    remaining = length
    with open(path, "rb") as fh:
        fh.seek(start)
        while remaining is None or remaining > 0:
            size = CHUNK if remaining is None else min(CHUNK, remaining)
            data = fh.read(size)
            if not data:
                break
            if remaining is not None:
                remaining -= len(data)
            yield data


def serve_file(loc: Loc, request: Request, download: bool) -> Response:
    """Send a file, honouring Range so audio/video can seek. Secure files are
    decrypted on the fly, touching only the parts a range needs."""
    path = loc.path
    keys = vault.require() if loc.secure else None
    try:
        size = path.stat().st_size
    except OSError:
        return fail("File not found", 404)
    if keys is not None:
        if not vault.is_encrypted(path):
            return fail("This file is damaged", 500)
        size = vault.plain_size(size)

    name = loc.name or path.name
    kind = storage.kind_for(name)
    inline = (not download) and storage.is_inline_kind(kind)
    mime = storage.mime_for(name)
    if kind == "text" and inline:
        mime = "text/plain; charset=utf-8"

    headers = {
        "Content-Disposition": content_disposition(name, inline),
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        # Decrypted content never goes into the browser's disk cache.
        "Cache-Control": "no-store" if keys else "private, max-age=0, must-revalidate",
    }

    def body(start: int = 0, length: Optional[int] = None) -> Iterator[bytes]:
        if keys is not None:
            return vault.read_plain(path, keys, start, length)
        return file_iterator(path, start, length)

    rel = storage.rel_of(path)
    if rel:
        db.mark_access(rel)

    match = _RANGE_RE.fullmatch((request.headers.get("range") or "").strip())
    if match and size:
        raw_start, raw_end = match.group(1), match.group(2)
        if raw_start == "":
            length = min(int(raw_end or 0), size)
            start = size - length
            end = size - 1
        else:
            start = int(raw_start)
            end = min(int(raw_end), size - 1) if raw_end else size - 1
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        length = end - start + 1
        headers.update({
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        })
        return StreamingResponse(body(start, length), status_code=206,
                                 media_type=mime, headers=headers)

    headers["Content-Length"] = str(size)
    return StreamingResponse(body(), media_type=mime, headers=headers)


class _ZipSink:
    """Unseekable sink so zipfile streams instead of buffering the archive."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.offset = 0

    def write(self, data: bytes) -> int:
        self.buffer.extend(data)
        self.offset += len(data)
        return len(data)

    def tell(self) -> int:
        return self.offset

    def flush(self) -> None:
        pass

    def seekable(self) -> bool:
        return False

    def drain(self) -> bytes:
        out = bytes(self.buffer)
        self.buffer.clear()
        return out


def _zip_file(zf: zipfile.ZipFile, sink: _ZipSink, src: Path, arc: str,
              keys: Optional["vault.Keys"]) -> Iterator[bytes]:
    try:
        with zf.open(arc, "w") as dest:
            for block in (vault.read_plain(src, keys) if keys else file_iterator(src)):
                dest.write(block)
                if sink.buffer:
                    yield sink.drain()
    except (OSError, StorageError):
        return
    if sink.buffer:
        yield sink.drain()


def zip_stream(targets: List[Loc], keys: Optional["vault.Keys"]) -> Iterator[bytes]:
    """Stream a ZIP of files and whole folders without buffering the archive.
    Secure files are decrypted into it; locked secure folders are left out."""
    sink = _ZipSink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for target in targets:
            top = target.name or config.get("app_name") or "files"
            if target.path.is_file():
                yield from _zip_file(zf, sink, target.path, top, keys if target.secure else None)
                continue
            skip = len(target.rel) + 1 if target.rel else 0
            for node in storage.walk(target, False, keys):
                if node.is_dir:
                    continue
                arc = f"{top}/{node.loc.rel[skip:]}"
                yield from _zip_file(zf, sink, node.loc.path, arc, keys if node.loc.secure else None)
    if sink.buffer:
        yield sink.drain()


# ---------------------------------------------------------------------------
# Routes: pages
# ---------------------------------------------------------------------------

NOT_BUILT = """<!doctype html><meta charset=utf-8><title>pupload</title>
<body style="font:15px system-ui;padding:40px;max-width:560px;margin:auto;line-height:1.5">
<h2>The web interface has not been built yet</h2>
<p>Run <code>./install.sh</code> again, or build it by hand:</p>
<pre style="background:#eee;padding:12px;border-radius:8px">cd frontend && npm install && npm run build</pre>
</body>"""


async def index(request: Request) -> Response:
    page = WEB_DIR / "index.html"
    if not page.exists():
        return HTMLResponse(NOT_BUILT, status_code=503)
    return HTMLResponse(page.read_text("utf-8"), headers={"Cache-Control": "no-cache"})


class WebFiles(StaticFiles):
    """Built assets have content hashes in their names, so cache them hard."""

    async def get_response(self, path: str, scope: Any) -> Response:
        response = await super().get_response(path, scope)
        if path.startswith("assets/") and response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path in ("sw.js", "manifest.webmanifest", "build-info.json"):
            response.headers["Cache-Control"] = "no-cache"
        return response


# ---------------------------------------------------------------------------
# Routes: settings
# ---------------------------------------------------------------------------

async def api_ping(request: Request) -> Response:
    """Lets the installer tell pupload apart from other programs on a port."""
    return ok({"app": "pupload", "version": __version__})


async def api_config(request: Request) -> Response:
    return ok({"settings": config.load(), "stats": storage.stats(), "version": __version__})


async def api_settings(request: Request) -> Response:
    patch = await body_json(request)

    if "storage_root" in patch:
        wanted = Path(str(patch["storage_root"]).strip()).expanduser()
        if not wanted.is_absolute():
            return fail("Storage path must be an absolute path")
        try:
            wanted.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return fail(f"Cannot use that folder: {exc.strerror or exc}")
        if not os.access(str(wanted), os.W_OK):
            return fail("That folder is not writable")

    cfg = config.update(patch)
    storage.invalidate_usage()
    return ok({"settings": cfg, "stats": storage.stats()})


async def api_storage_options(request: Request) -> Response:
    return ok({"options": config.storage_options()})


async def api_stats(request: Request) -> Response:
    return ok({"stats": storage.stats()})


# ---------------------------------------------------------------------------
# Routes: browsing
# ---------------------------------------------------------------------------

async def api_list(request: Request) -> Response:
    rel = request.query_params.get("path", "")
    sort = request.query_params.get("sort") or config.get("sort")
    try:
        listing = storage.listdir(rel, sort)
    except StorageError as exc:
        return err(exc, 404)
    return ok({**listing, "stats": storage.stats()})


async def api_collect(request: Request) -> Response:
    mode = request.query_params.get("mode", "recent")
    if mode not in ("recent", "media", "expiring", "mine"):
        return fail("Unknown view")
    items = await asyncio.to_thread(storage.collect, mode, 300, device_of(request)["id"])
    return ok({"path": "", "mode": mode, "items": items, "stats": storage.stats()})


async def api_search(request: Request) -> Response:
    query = request.query_params.get("q", "")
    items = await asyncio.to_thread(storage.search, query)
    return ok({"path": "", "query": query, "items": items, "stats": storage.stats()})


async def api_folders(request: Request) -> Response:
    return ok({"folders": storage.folder_tree()})


# ---------------------------------------------------------------------------
# Routes: mutations
# ---------------------------------------------------------------------------

async def api_mkdir(request: Request) -> Response:
    """New folder; with `secure`, a new secure folder (needs secure folders
    set up and unlocked on this device)."""
    data = await body_json(request)
    name = storage.clean_name(data.get("name", ""))
    secure = bool(data.get("secure"))
    try:
        parent = storage.locate(data.get("path", ""))
        if secure and not vault.configured():
            return fail("Set up secure folders first", 409)
        keys = vault.require() if (parent.sealed or secure) else None
    except StorageError as exc:
        return err(exc)
    if not parent.path.is_dir():
        return fail("Folder not found", 404)
    if parent.sealed:
        name = storage.fit_name(name)
        target = parent.path / keys.enc_name(name)
    else:
        target = parent.path / name
    if target.exists():
        return fail("A folder with that name already exists", 409)
    try:
        target.mkdir()
        if secure and not parent.sealed:
            storage.mark_vault(target)
    except OSError as exc:
        return fail(f"Could not create folder: {exc.strerror or exc}")
    db.touch(storage.rel_of(target), 0, device=device_of(request))
    return ok({"item": storage.entry(target, config.load())})


def upload_folder(params: Any, create: bool) -> Loc:
    """Target folder for an upload, including a dropped directory's sub-path."""
    folder = storage.locate(params.get("path", ""))
    sub = str(params.get("dir", "")).replace("\\", "/").strip("/")
    if sub:
        parts = [storage.clean_name(p) for p in sub.split("/") if p not in ("", ".", "..")]
        if folder.sealed:
            parts = [storage.fit_name(p) for p in parts]
        folder = storage.locate("/".join(filter(None, [folder.rel, *parts])))
        if create:
            folder.path.mkdir(parents=True, exist_ok=True)
    return folder


async def body_chunks(request: Request) -> AsyncIterator[bytes]:
    """The request body, giving up if the sender stalls for IDLE_TIMEOUT seconds."""
    stream = request.stream().__aiter__()
    while True:
        try:
            chunk = await asyncio.wait_for(stream.__anext__(), IDLE_TIMEOUT)
        except StopAsyncIteration:
            return
        if chunk:
            yield chunk


async def discard_body(request: Request) -> None:
    """Read and drop an unwanted body, so the client gets our reply instead of
    a reset connection (a browser would report that as a network error)."""
    try:
        async for _ in body_chunks(request):
            pass
    except Exception:
        pass


def room_for(remaining: int) -> Optional[str]:
    """Why `remaining` more bytes cannot be stored, or None if they fit."""
    cfg = config.load()
    info = storage.usage()
    quota = cfg["quota_bytes"]
    if quota is not None and info["bytes"] + remaining > quota:
        hint = " (emptying the recycle bin frees space)" if info["trash"] else ""
        return "Storage limit reached" + hint
    if remaining > storage.disk()["free"] - cfg["keep_free_bytes"]:
        return "Not enough space on the disk"
    return None


def _staged(upload_id: str) -> Dict[str, Path]:
    base = storage.uploads_dir()
    return {"plain": base / f"{upload_id}.part",
            "secure": base / f"{upload_id}.spart",
            "tail": base / f"{upload_id}.stail"}


async def api_upload_chunk(request: Request) -> Response:
    """Resumable upload: the browser sends a file in pieces, each at an offset.

    Pieces are appended to `<storage>/.pupload-uploads/<id>.part`. If the
    connection drops, the browser asks how much arrived and continues from
    there — even after a page reload, as the id is derived from the file. The
    file only appears in its folder once the last byte is in, and unfinished
    uploads are cleaned away after a day.

    Into a secure folder, pieces are encrypted as they arrive (vault.Stage),
    so not even an unfinished upload leaves plaintext on the disk.
    """
    params = request.query_params
    upload_id = params.get("id", "")
    if not _UPLOAD_ID_RE.match(upload_id):
        return fail("Bad upload id")
    try:
        total = int(params.get("size", ""))
        offset = int(params.get("offset", ""))
    except ValueError:
        return fail("Bad size or offset")
    if total < 0 or offset < 0 or offset > total:
        return fail("Bad size or offset")
    try:
        folder = upload_folder(params, create=False)   # reject a bad target before taking data
        keys = vault.require() if folder.sealed else None
    except VaultLocked as exc:
        await discard_body(request)
        return err(exc)
    except StorageError as exc:
        return err(exc)

    files = _staged(upload_id)
    part = files["secure"] if keys else files["plain"]
    lock = _upload_locks.setdefault(upload_id, asyncio.Lock())
    async with lock:
        # The destination changed sides since this upload started: start over.
        stale = files["plain"] if keys else files["secure"]
        if stale.exists():
            stale.unlink(missing_ok=True)
            files["tail"].unlink(missing_ok=True)
        if keys:
            have = vault.staged_offset(part, files["tail"])
        else:
            have = part.stat().st_size if part.exists() else 0
        if offset != have:
            await discard_body(request)
            return JSONResponse({"ok": False, "error": "Resuming from the server's copy", "offset": have},
                                status_code=409)
        problem = room_for(total - have)
        if problem:
            await discard_body(request)
            return fail(problem, 413)

        stage: Optional[vault.Stage] = None
        written = 0
        interrupted = False
        try:
            if keys:
                stage = vault.Stage(keys, part, files["tail"], upload_id)
            with open(part, "ab") as fh:
                async for chunk in body_chunks(request):
                    if have + written + len(chunk) > total:
                        return fail("More data than the file size", 400)
                    if stage:
                        stage.feed(fh, chunk)
                    else:
                        fh.write(chunk)
                    written += len(chunk)
        except (asyncio.TimeoutError, ClientDisconnect, OSError):
            interrupted = True
        except StorageError as exc:          # a damaged staged copy: start over
            part.unlink(missing_ok=True)
            files["tail"].unlink(missing_ok=True)
            return JSONResponse({"ok": False, "error": str(exc), "offset": 0}, status_code=409)
        finally:
            if stage:
                stage.settle()
        storage.invalidate_usage()
        done = stage.offset if stage else have + written
        if interrupted:
            return JSONResponse({"ok": False, "error": "Upload interrupted", "offset": done},
                                status_code=408)
        if done < total:
            return ok({"done": False, "offset": done})

        try:
            folder = upload_folder(params, create=True)
            if not folder.path.is_dir():
                return fail("Folder not found", 404)
            name = storage.clean_name(params.get("name", ""))
            if keys:
                name = storage.fit_name(name)
            target = storage.unique_path(folder.path, name, keys)
            if stage:
                stage.finish()
            os.replace(part, target)
        except StorageError as exc:
            return err(exc)
        except OSError as exc:
            return fail(f"Could not save file: {exc.strerror or exc}")
        _upload_locks.pop(upload_id, None)

    db.touch(storage.rel_of(target), total, device=device_of(request))
    storage.invalidate_usage()
    return ok({"done": True, "offset": total, "item": storage.entry(target, config.load()),
               "stats": storage.stats()})


async def api_upload_status(request: Request) -> Response:
    upload_id = request.query_params.get("id", "")
    if not _UPLOAD_ID_RE.match(upload_id):
        return fail("Bad upload id")
    files = _staged(upload_id)
    if files["secure"].exists():
        return ok({"offset": vault.staged_offset(files["secure"], files["tail"])})
    part = files["plain"]
    return ok({"offset": part.stat().st_size if part.exists() else 0})


async def api_upload_cancel(request: Request) -> Response:
    data = await body_json(request)
    upload_id = str(data.get("id", ""))
    if not _UPLOAD_ID_RE.match(upload_id):
        return fail("Bad upload id")
    for path in _staged(upload_id).values():
        path.unlink(missing_ok=True)
    _upload_locks.pop(upload_id, None)
    storage.invalidate_usage()
    return ok()


async def api_upload(request: Request) -> Response:
    """Single-request upload of a whole file (handy for curl and scripts).

    The browser uses the resumable /api/upload/chunk instead.
    """
    params = request.query_params
    try:
        folder = upload_folder(params, create=True)
        keys = vault.require() if folder.sealed else None
    except StorageError as exc:
        return err(exc)
    if not folder.path.is_dir():
        return fail("Folder not found", 404)

    declared = int(request.headers.get("content-length") or 0)
    problem = room_for(declared)
    if problem:
        return fail(problem, 413)

    name = storage.clean_name(params.get("name", ""))
    if keys:
        name = storage.fit_name(name)
    part = storage.uploads_dir() / f"single-{os.getpid()}-{time.time_ns()}.part"
    cfg = config.load()
    quota = cfg["quota_bytes"]
    used = storage.usage()["bytes"]
    disk_cap = storage.disk()["free"] - cfg["keep_free_bytes"]
    enc = vault.Encryptor(keys) if keys else None
    written = 0

    try:
        with open(part, "wb") as fh:
            if enc:
                fh.write(enc.header)
            async for chunk in body_chunks(request):
                written += len(chunk)
                if quota is not None and used + written > quota:
                    raise StorageError("Storage limit reached")
                if written > disk_cap:
                    raise StorageError("Not enough space on the disk")
                fh.write(enc.feed(chunk) if enc else chunk)
            if enc:
                fh.write(enc.finish())
    except StorageError as exc:
        part.unlink(missing_ok=True)
        return fail(str(exc), 413)
    except Exception:
        # Disconnect, stall or disk error: nothing half-written is left behind.
        part.unlink(missing_ok=True)
        return fail("Upload failed", 500)

    target = storage.unique_path(folder.path, name, keys)
    try:
        os.replace(part, target)
    except OSError as exc:
        part.unlink(missing_ok=True)
        return fail(f"Could not save file: {exc.strerror or exc}")

    db.touch(storage.rel_of(target), written, device=device_of(request))
    storage.invalidate_usage()
    return ok({"item": storage.entry(target, cfg), "stats": storage.stats()})


async def api_rename(request: Request) -> Response:
    data = await body_json(request)
    try:
        source = storage.locate(data.get("path", ""))
        storage.guard(source)
    except StorageError as exc:
        return err(exc)
    if source.path == storage.root():
        return fail("Cannot rename the home folder")
    if not source.path.exists():
        return fail("Not found", 404)

    name = storage.clean_name(data.get("name", ""))
    if source.secure:
        name = storage.fit_name(name)
        target = source.path.with_name(vault.require().enc_name(name))
    else:
        target = source.path.with_name(name)
    if target == source.path:
        return ok({"item": storage.entry(source.path, config.load(), loc=source)})
    if target.exists():
        return fail("Something with that name already exists", 409)
    old_rel = storage.rel_of(source.path)
    try:
        source.path.rename(target)
    except OSError as exc:
        return fail(f"Could not rename: {exc.strerror or exc}")
    db.rename(old_rel, storage.rel_of(target))
    return ok({"item": storage.entry(target, config.load())})


async def api_move(request: Request) -> Response:
    """Move items into a folder. Moving into or out of a secure folder
    encrypts or decrypts them on the way."""
    data = await body_json(request)
    paths = paths_from(data)
    try:
        dest = storage.locate(data.get("to", ""))
        storage.guard(dest)
    except StorageError as exc:
        return err(exc)
    if not dest.path.is_dir():
        return fail("Destination folder not found", 404)

    moved = 0
    for raw in paths:
        try:
            source = storage.locate(raw)
            storage.guard(source)
        except VaultLocked as exc:
            return err(exc)
        except StorageError:
            continue
        if source.path == storage.root() or not source.path.exists():
            continue
        if source.path.is_dir() and (dest.path == source.path or source.path in dest.path.parents):
            return fail("Cannot move a folder into itself")
        if source.path.parent == dest.path:
            continue
        try:
            await asyncio.to_thread(storage.move_into, source, dest)
        except StorageError as exc:
            return err(exc)
        except (OSError, shutil.Error) as exc:
            return fail(f"Could not move: {exc}")
        moved += 1

    storage.invalidate_usage()
    return ok({"moved": moved, "stats": storage.stats()})


async def api_delete(request: Request) -> Response:
    """Move items to the recycle bin (or remove them outright with `permanent`)."""
    data = await body_json(request)
    permanent = bool(data.get("permanent"))
    who = device_of(request)["name"]
    removed = 0
    trash_ids: List[str] = []
    for raw in paths_from(data):
        try:
            loc = storage.locate(raw)
            storage.guard(loc)
        except VaultLocked as exc:
            return err(exc)
        except StorageError:
            continue
        target = loc.path
        if target == storage.root() or not target.exists():
            continue
        rel = storage.rel_of(target)
        try:
            if permanent:
                if target.is_dir():
                    await asyncio.to_thread(shutil.rmtree, target)
                else:
                    target.unlink()
                db.forget(rel)
            else:
                record = await asyncio.to_thread(trash.bin_path, target, who, loc)
                trash_ids.append(record["id"])
        except (OSError, shutil.Error, StorageError) as exc:
            return fail(f"Could not delete: {getattr(exc, 'strerror', None) or exc}")
        removed += 1
    storage.invalidate_usage()
    return ok({"removed": removed, "permanent": permanent, "trash_ids": trash_ids,
               "stats": storage.stats()})


async def api_pin(request: Request) -> Response:
    data = await body_json(request)
    try:
        loc = storage.locate(data.get("path", ""))
        storage.guard(loc)
    except StorageError as exc:
        return err(exc)
    target = loc.path
    if not target.exists() or target.is_dir():
        return fail("Only files can be kept", 400)
    rel = storage.rel_of(target)
    if db.get(rel) is None:
        db.touch(rel, target.stat().st_size, target.stat().st_mtime)
    pinned = bool(data.get("pinned", True))
    db.set_pinned(rel, pinned)
    return ok({"item": storage.entry(target, config.load(), loc=loc)})


async def api_purge(request: Request) -> Response:
    result = await asyncio.to_thread(storage.sweep)
    return ok({**result, "stats": storage.stats()})


# ---------------------------------------------------------------------------
# Routes: file content
# ---------------------------------------------------------------------------

async def api_file(request: Request) -> Response:
    download = request.url.path.endswith("/download")
    try:
        loc = storage.locate(request.query_params.get("path", ""))
        if not loc.path.exists() or loc.path.is_dir():
            return fail("File not found", 404)
        return serve_file(loc, request, download)
    except StorageError as exc:
        return err(exc)


async def api_zip(request: Request) -> Response:
    """ZIP one folder (`path`) or any mix of files and folders (repeated `paths`)."""
    raw = request.query_params.getlist("paths") or [request.query_params.get("path", "")]
    targets: List[Loc] = []
    for rel in raw:
        try:
            loc = storage.locate(rel)
            if loc.sealed:
                vault.require()
        except StorageError as exc:
            return err(exc)
        if not loc.path.exists():
            return fail("Not found", 404)
        targets.append(loc)
    if not targets:
        return fail("Nothing to download")
    if len(targets) == 1 and targets[0].path.is_dir():
        name = (targets[0].name or config.get("app_name") or "pupload") + ".zip"
    else:
        name = f"{config.get('app_name') or 'pupload'}-{time.strftime('%Y%m%d-%H%M')}.zip"
    headers = {
        "Content-Disposition": content_disposition(name, False),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
    }
    return StreamingResponse(zip_stream(targets, vault.current()), media_type="application/zip",
                             headers=headers)


def _jpeg_thumb(source: Any) -> bytes:
    from PIL import Image  # type: ignore
    with Image.open(source) as im:
        im.draft("RGB", (640, 640))
        im = im.convert("RGB")
        im.thumbnail((420, 420))
        out = io.BytesIO()
        im.save(out, "JPEG", quality=78, optimize=True)
    return out.getvalue()


def _secure_thumb(path: Path, keys: "vault.Keys") -> bytes:
    return _jpeg_thumb(io.BytesIO(b"".join(vault.read_plain(path, keys))))


async def api_thumb(request: Request) -> Response:
    """Small JPEG preview for images. Falls back to the original when Pillow is absent.
    Previews of secure images are made in memory and never written to disk."""
    try:
        loc = storage.locate(request.query_params.get("path", ""))
    except StorageError as exc:
        return err(exc)
    target = loc.path
    if not target.exists() or target.is_dir() or storage.kind_for(loc.name) != "image":
        return fail("No preview", 404)
    if not config.get("thumbnails"):
        return serve_file(loc, request, False)

    try:
        from PIL import Image  # type: ignore  # noqa: F401
    except Exception:
        return serve_file(loc, request, False)

    st = target.stat()
    key = hashlib.sha1(f"{storage.rel_of(target)}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()

    if loc.secure:
        try:
            keys = vault.require()
        except VaultLocked as exc:
            return err(exc)
        data = vault.thumb_get(key)
        if data is None:
            if vault.plain_size(st.st_size) > SECURE_THUMB_MAX:
                return fail("No preview", 404)
            try:
                data = await asyncio.to_thread(_secure_thumb, target, keys)
            except Exception:
                return serve_file(loc, request, False)
            vault.thumb_put(key, data)
        return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    cached = THUMB_DIR / f"{key}.jpg"
    if not cached.exists():
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        try:
            cached.write_bytes(await asyncio.to_thread(_jpeg_thumb, target))
        except Exception:
            return serve_file(loc, request, False)
    return FileResponse(cached, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=86400"})


# ---------------------------------------------------------------------------
# Routes: links (never expire; deleting sends them to the recycle bin)
# ---------------------------------------------------------------------------

def _link_id(data: Dict[str, Any]) -> int:
    try:
        return int(data.get("id"))
    except (TypeError, ValueError):
        return 0


async def api_links(request: Request) -> Response:
    return ok({"links": db.links()})


async def api_link_add(request: Request) -> Response:
    data = await body_json(request)
    try:
        url = links.normalize_url(data.get("url"))
    except LinkError as exc:
        return fail(str(exc))
    title = links.clean_text(data.get("title"), 300)
    link_id = db.link_add(url, title, links.clean_text(data.get("note"), 4000),
                          links.clean_tags(data.get("tags")), device_of(request))
    if not title:
        asyncio.get_running_loop().run_in_executor(None, links.fill_title, link_id, url)
    return ok({"link": db.link_get(link_id)})


async def api_link_update(request: Request) -> Response:
    data = await body_json(request)
    link_id = _link_id(data)
    if db.link_get(link_id) is None:
        return fail("Link not found", 404)
    fields: Dict[str, Any] = {}
    try:
        if "url" in data:
            fields["url"] = links.normalize_url(data["url"])
    except LinkError as exc:
        return fail(str(exc))
    if "title" in data:
        fields["title"] = links.clean_text(data["title"], 300)
    if "note" in data:
        fields["note"] = links.clean_text(data["note"], 4000)
    if "tags" in data:
        fields["tags"] = links.clean_tags(data["tags"])
    if "pinned" in data:
        fields["pinned"] = bool(data["pinned"])
    db.link_update(link_id, fields)
    link = db.link_get(link_id)
    if link and not link["title"] and "url" in fields:
        asyncio.get_running_loop().run_in_executor(None, links.fill_title, link_id, link["url"])
    return ok({"link": link})


async def api_link_delete(request: Request) -> Response:
    data = await body_json(request)
    ids = data.get("ids") or ([data["id"]] if data.get("id") is not None else [])
    who = device_of(request)["name"]
    removed = 0
    trash_ids: List[str] = []
    for raw in ids:
        try:
            link = db.link_get(int(raw))
        except (TypeError, ValueError):
            continue
        if link:
            trash_ids.append(trash.bin_link(link, who)["id"])
            removed += 1
    return ok({"removed": removed, "trash_ids": trash_ids})


# ---------------------------------------------------------------------------
# Routes: recycle bin
# ---------------------------------------------------------------------------

async def api_trash(request: Request) -> Response:
    return ok({"items": trash.listing(), "stats": storage.stats()})


async def api_trash_restore(request: Request) -> Response:
    data = await body_json(request)
    restored: List[Dict[str, Any]] = []
    errors: List[str] = []
    locked = False
    for trash_id in data.get("ids") or []:
        try:
            restored.append(await asyncio.to_thread(trash.restore, str(trash_id)))
        except VaultLocked as exc:
            locked = True
            errors.append(str(exc))
        except (StorageError, OSError, shutil.Error) as exc:
            errors.append(str(exc))
    if errors and not restored:
        return fail(errors[0], 423 if locked else 400)
    return ok({"restored": restored, "errors": errors, "stats": storage.stats()})


async def api_trash_delete(request: Request) -> Response:
    data = await body_json(request)
    freed = count = 0
    for trash_id in data.get("ids") or []:
        try:
            freed += await asyncio.to_thread(trash.delete_forever, str(trash_id))
        except VaultLocked as exc:
            return err(exc)
        count += 1
    return ok({"count": count, "freed": freed, "stats": storage.stats()})


async def api_trash_empty(request: Request) -> Response:
    result = await asyncio.to_thread(trash.empty)
    return ok({**result, "stats": storage.stats()})


# ---------------------------------------------------------------------------
# Routes: secure folders
# ---------------------------------------------------------------------------

def _token(request: Request) -> Optional[str]:
    return request.cookies.get(vault.COOKIE)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _with_session(response: Response, request: Request, token: str, expires: float) -> Response:
    response.set_cookie(vault.COOKIE, token, max_age=max(60, int(expires - time.time())),
                        path="/", httponly=True, samesite="strict",
                        secure=request.url.scheme == "https")
    return response


async def api_vault(request: Request) -> Response:
    return ok(vault.status(_token(request)))


async def api_vault_setup(request: Request) -> Response:
    """Choose the master password. Replies with the recovery key, once."""
    if not vault.AVAILABLE:
        return fail(NO_CRYPTO, 501)
    data = await body_json(request)
    password = str(data.get("password") or "")
    problem = vault.password_problem(password)
    if problem:
        return fail(problem)
    if vault.configured():
        return fail("Secure folders are already set up", 409)
    try:
        code, token, expires = await asyncio.to_thread(
            vault.setup, password, config.get("vault_hours"), device_of(request)["name"])
    except StorageError as exc:
        return err(exc, 409)
    return _with_session(ok({"recovery_key": code, **vault.status(token)}), request, token, expires)


async def api_vault_unlock(request: Request) -> Response:
    if not vault.AVAILABLE:
        return fail(NO_CRYPTO, 501)
    if not vault.configured():
        return fail("Secure folders are not set up yet", 409)
    ip = _client_ip(request)
    wait = vault.throttled(ip)
    if wait:
        return fail(f"Too many wrong passwords. Try again in {wait} s", 429)
    data = await body_json(request)
    result = await asyncio.to_thread(vault.unlock, str(data.get("password") or ""),
                                     config.get("vault_hours"), device_of(request)["name"])
    if result is None:
        vault.note_failure(ip)
        return fail("Wrong password", 403)
    vault.note_success(ip)
    token, expires = result
    return _with_session(ok(vault.status(token)), request, token, expires)


async def api_vault_lock(request: Request) -> Response:
    """Lock this device, or (from an unlocked device) every device."""
    data = await body_json(request)
    token = _token(request)
    if data.get("everywhere"):
        if vault.session(token) is None:
            return fail("Unlock first to lock every device", 423)
        vault.lock_everywhere()
    else:
        vault.end_session(token)
    response = ok(vault.status(None))
    response.delete_cookie(vault.COOKIE, path="/")
    return response


async def api_vault_password(request: Request) -> Response:
    """Change the master password, with the current one or the recovery key."""
    if not vault.AVAILABLE:
        return fail(NO_CRYPTO, 501)
    if not vault.configured():
        return fail("Secure folders are not set up yet", 409)
    ip = _client_ip(request)
    wait = vault.throttled(ip)
    if wait:
        return fail(f"Too many wrong attempts. Try again in {wait} s", 429)
    data = await body_json(request)
    new = str(data.get("new") or "")
    problem = vault.password_problem(new)
    if problem:
        return fail(problem)

    code = str(data.get("recovery_key") or "")
    if code:
        result = await asyncio.to_thread(vault.recover, code, new, config.get("vault_hours"),
                                         device_of(request)["name"])
        if result is None:
            vault.note_failure(ip)
            return fail("That recovery key is not right", 403)
        vault.note_success(ip)
        token, expires = result
        return _with_session(ok(vault.status(token)), request, token, expires)

    changed = await asyncio.to_thread(vault.change_password, str(data.get("current") or ""), new)
    if not changed:
        vault.note_failure(ip)
        return fail("The current password is wrong", 403)
    vault.note_success(ip)
    return ok(vault.status(_token(request)))


class VaultSession:
    """Marks every request as allowed, or not, to open secure folders, from
    its session cookie. Everything downstream asks vault.current()."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        allowed = vault.session(Request(scope).cookies.get(vault.COOKIE)) is not None
        mark = vault.ACCESS.set(allowed)
        try:
            await self.app(scope, receive, send)
        finally:
            vault.ACCESS.reset(mark)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

async def _sweeper() -> None:
    while True:
        try:
            await asyncio.to_thread(storage.sweep)
        except Exception:
            pass
        await asyncio.sleep(SWEEP_INTERVAL)


async def _vault_timer() -> None:
    """Drop the key within a minute of the last session running out."""
    while True:
        await asyncio.sleep(60)
        vault.prune()


@contextlib.asynccontextmanager
async def lifespan(_app: Starlette):
    config.load()
    storage.root()
    db.conn()
    try:
        await asyncio.to_thread(storage.cleanup_partials)
        await asyncio.to_thread(storage.sweep)
    except Exception:
        pass
    tasks = [asyncio.create_task(_sweeper()), asyncio.create_task(_vault_timer())]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()


routes: List[Any] = [
    Route("/", index),
    Route("/share", index),   # PWA share target: links shared from other apps
    Route("/api/ping", api_ping),
    Route("/api/config", api_config),
    Route("/api/settings", api_settings, methods=["POST", "PUT"]),
    Route("/api/storage-options", api_storage_options),
    Route("/api/stats", api_stats),
    Route("/api/list", api_list),
    Route("/api/collect", api_collect),
    Route("/api/search", api_search),
    Route("/api/folders", api_folders),
    Route("/api/mkdir", api_mkdir, methods=["POST"]),
    Route("/api/upload", api_upload, methods=["POST", "PUT"]),
    Route("/api/upload/chunk", api_upload_chunk, methods=["POST", "PUT"]),
    Route("/api/upload/status", api_upload_status),
    Route("/api/upload/cancel", api_upload_cancel, methods=["POST"]),
    Route("/api/rename", api_rename, methods=["POST"]),
    Route("/api/move", api_move, methods=["POST"]),
    Route("/api/delete", api_delete, methods=["POST"]),
    Route("/api/pin", api_pin, methods=["POST"]),
    Route("/api/purge", api_purge, methods=["POST"]),
    Route("/api/links", api_links),
    Route("/api/links/add", api_link_add, methods=["POST"]),
    Route("/api/links/update", api_link_update, methods=["POST"]),
    Route("/api/links/delete", api_link_delete, methods=["POST"]),
    Route("/api/trash", api_trash),
    Route("/api/trash/restore", api_trash_restore, methods=["POST"]),
    Route("/api/trash/delete", api_trash_delete, methods=["POST"]),
    Route("/api/trash/empty", api_trash_empty, methods=["POST"]),
    Route("/api/vault", api_vault),
    Route("/api/vault/setup", api_vault_setup, methods=["POST"]),
    Route("/api/vault/unlock", api_vault_unlock, methods=["POST"]),
    Route("/api/vault/lock", api_vault_lock, methods=["POST"]),
    Route("/api/vault/password", api_vault_password, methods=["POST"]),
    Route("/api/raw", api_file),
    Route("/api/download", api_file),
    Route("/api/zip", api_zip),
    Route("/api/thumb", api_thumb),
    Mount("/", WebFiles(directory=str(WEB_DIR), check_dir=False), name="web"),
]

app = Starlette(routes=routes, lifespan=lifespan, middleware=[Middleware(VaultSession)])
