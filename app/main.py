"""HTTP layer. Starlette + uvicorn; the React UI is prebuilt into app/web."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import mimetypes
import os
import re
import shutil
import time
import urllib.parse
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import (FileResponse, HTMLResponse, JSONResponse, Response,
                                 StreamingResponse)
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import __version__, config, db, links, storage, trash
from .links import LinkError
from .storage import StorageError

WEB_DIR = Path(__file__).resolve().parent / "web"
mimetypes.add_type("application/manifest+json", ".webmanifest")
THUMB_DIR = config.DATA_DIR / "thumbs"
CHUNK = 256 * 1024
SWEEP_INTERVAL = 30 * 60

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
_DEVICE_ID_RE = re.compile(r"[^A-Za-z0-9_-]")


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
    return JSONResponse({"ok": False, "error": message}, status_code=status)


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


def serve_file(path: Path, request: Request, download: bool) -> Response:
    """Send a file, honouring Range so audio/video can seek."""
    try:
        size = path.stat().st_size
    except OSError:
        return fail("File not found", 404)

    kind = storage.kind_of(path)
    inline = (not download) and storage.is_inline_kind(kind)
    mime = storage.mime_of(path)
    if kind == "text" and inline:
        mime = "text/plain; charset=utf-8"

    headers = {
        "Content-Disposition": content_disposition(path.name, inline),
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=0, must-revalidate",
    }

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
        return StreamingResponse(file_iterator(path, start, length), status_code=206,
                                 media_type=mime, headers=headers)

    headers["Content-Length"] = str(size)
    return StreamingResponse(file_iterator(path), media_type=mime, headers=headers)


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


def _zip_file(zf: zipfile.ZipFile, sink: _ZipSink, src: Path, arc: str) -> Iterator[bytes]:
    try:
        with zf.open(arc, "w") as dest, open(src, "rb") as fh:
            while True:
                block = fh.read(CHUNK)
                if not block:
                    break
                dest.write(block)
                if sink.buffer:
                    yield sink.drain()
    except OSError:
        return
    if sink.buffer:
        yield sink.drain()


def zip_stream(targets: List[Path]) -> Iterator[bytes]:
    """Stream a ZIP of files and whole folders without buffering the archive."""
    sink = _ZipSink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for target in targets:
            top = target.name or "files"
            if target.is_file():
                yield from _zip_file(zf, sink, target, top)
                continue
            for dirpath, dirnames, filenames in os.walk(str(target)):
                dirnames[:] = [d for d in dirnames if d != storage.TRASH_DIRNAME]
                dirnames.sort(key=str.lower)
                for name in sorted(filenames, key=str.lower):
                    src = Path(dirpath) / name
                    if storage.is_hidden(src):
                        continue
                    arc = (Path(top) / src.relative_to(target)).as_posix()
                    yield from _zip_file(zf, sink, src, arc)
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
        elif path in ("sw.js", "manifest.webmanifest"):
            response.headers["Cache-Control"] = "no-cache"
        return response


# ---------------------------------------------------------------------------
# Routes: settings
# ---------------------------------------------------------------------------

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
        return fail(str(exc), 404)
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
    data = await body_json(request)
    name = storage.clean_name(data.get("name", ""))
    try:
        parent = storage.safe_join(data.get("path", ""))
    except StorageError as exc:
        return fail(str(exc))
    if not parent.is_dir():
        return fail("Folder not found", 404)
    target = parent / name
    if target.exists():
        return fail("A folder with that name already exists", 409)
    try:
        target.mkdir()
    except OSError as exc:
        return fail(f"Could not create folder: {exc.strerror or exc}")
    db.touch(storage.rel_of(target), 0, device=device_of(request))
    return ok({"item": storage.entry(target, config.load())})


async def api_upload(request: Request) -> Response:
    """Raw-body upload: the browser streams one file per request.

    Avoids multipart parsing entirely, so nothing is buffered twice and a
    4 GB video costs the Pi the same memory as a 4 KB note.
    """
    params = request.query_params
    name = storage.clean_name(urllib.parse.unquote(params.get("name", "")))
    try:
        folder = storage.safe_join(params.get("path", ""))
        # An upload may carry a relative folder path (drag-dropped directory).
        sub = str(params.get("dir", "")).replace("\\", "/").strip("/")
        if sub:
            parts = [storage.clean_name(p) for p in sub.split("/") if p not in ("", ".", "..")]
            folder = storage.safe_join("/".join(filter(None, [storage.rel_of(folder), *parts])))
            folder.mkdir(parents=True, exist_ok=True)
    except StorageError as exc:
        return fail(str(exc))
    if not folder.is_dir():
        return fail("Folder not found", 404)

    declared = int(request.headers.get("content-length") or 0)
    try:
        storage.check_room(declared)
    except StorageError as exc:
        return fail(str(exc), 413)

    if params.get("overwrite") == "1":
        target = folder / name
    else:
        target = storage.unique_path(folder, name)
    partial = target.with_name(target.name + storage.PART_SUFFIX)

    cfg = config.load()
    quota = cfg["quota_bytes"]
    used = storage.usage()["bytes"]
    disk_cap = storage.disk()["free"] - cfg["keep_free_bytes"]
    written = 0

    try:
        with open(partial, "wb") as fh:
            async for chunk in request.stream():
                if not chunk:
                    continue
                written += len(chunk)
                if quota is not None and used + written > quota:
                    raise StorageError("Storage limit reached")
                if written > disk_cap:
                    raise StorageError("Not enough space on the disk")
                fh.write(chunk)
    except StorageError as exc:
        partial.unlink(missing_ok=True)
        return fail(str(exc), 413)
    except Exception:
        partial.unlink(missing_ok=True)
        return fail("Upload failed", 500)

    try:
        partial.replace(target)
    except OSError as exc:
        partial.unlink(missing_ok=True)
        return fail(f"Could not save file: {exc.strerror or exc}")

    rel = storage.rel_of(target)
    db.touch(rel, written, device=device_of(request))
    storage.invalidate_usage()
    return ok({"item": storage.entry(target, cfg), "stats": storage.stats()})


async def api_rename(request: Request) -> Response:
    data = await body_json(request)
    try:
        source = storage.safe_join(data.get("path", ""))
    except StorageError as exc:
        return fail(str(exc))
    if source == storage.root():
        return fail("Cannot rename the home folder")
    if not source.exists():
        return fail("Not found", 404)

    name = storage.clean_name(data.get("name", ""))
    target = source.with_name(name)
    if target == source:
        return ok({"item": storage.entry(source, config.load())})
    if target.exists():
        return fail("Something with that name already exists", 409)
    old_rel = storage.rel_of(source)
    try:
        source.rename(target)
    except OSError as exc:
        return fail(f"Could not rename: {exc.strerror or exc}")
    db.rename(old_rel, storage.rel_of(target))
    return ok({"item": storage.entry(target, config.load())})


async def api_move(request: Request) -> Response:
    data = await body_json(request)
    paths = paths_from(data)
    try:
        dest = storage.safe_join(data.get("to", ""))
    except StorageError as exc:
        return fail(str(exc))
    if not dest.is_dir():
        return fail("Destination folder not found", 404)

    moved = 0
    for raw in paths:
        try:
            source = storage.safe_join(raw)
        except StorageError:
            continue
        if source == storage.root() or not source.exists():
            continue
        if source.is_dir() and (dest == source or source in dest.parents):
            return fail("Cannot move a folder into itself")
        if source.parent == dest:
            continue
        target = storage.unique_path(dest, source.name)
        old_rel = storage.rel_of(source)
        try:
            shutil.move(str(source), str(target))
        except (OSError, shutil.Error) as exc:
            return fail(f"Could not move: {exc}")
        db.rename(old_rel, storage.rel_of(target))
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
            target = storage.safe_join(raw)
        except StorageError:
            continue
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
                record = await asyncio.to_thread(trash.bin_path, target, who)
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
        target = storage.safe_join(data.get("path", ""))
    except StorageError as exc:
        return fail(str(exc))
    if not target.exists() or target.is_dir():
        return fail("Only files can be kept", 400)
    rel = storage.rel_of(target)
    if db.get(rel) is None:
        db.touch(rel, target.stat().st_size, target.stat().st_mtime)
    pinned = bool(data.get("pinned", True))
    db.set_pinned(rel, pinned)
    return ok({"item": storage.entry(target, config.load())})


async def api_purge(request: Request) -> Response:
    result = await asyncio.to_thread(storage.sweep)
    return ok({**result, "stats": storage.stats()})


# ---------------------------------------------------------------------------
# Routes: file content
# ---------------------------------------------------------------------------

async def api_file(request: Request) -> Response:
    download = request.url.path.endswith("/download")
    try:
        target = storage.safe_join(request.query_params.get("path", ""))
    except StorageError as exc:
        return fail(str(exc))
    if not target.exists() or target.is_dir():
        return fail("File not found", 404)
    return serve_file(target, request, download)


async def api_zip(request: Request) -> Response:
    """ZIP one folder (`path`) or any mix of files and folders (repeated `paths`)."""
    raw = request.query_params.getlist("paths") or [request.query_params.get("path", "")]
    targets: List[Path] = []
    for rel in raw:
        try:
            target = storage.safe_join(rel)
        except StorageError as exc:
            return fail(str(exc))
        if not target.exists():
            return fail("Not found", 404)
        targets.append(target)
    if not targets:
        return fail("Nothing to download")
    if len(targets) == 1 and targets[0].is_dir():
        name = (targets[0].name or config.get("app_name") or "pupload") + ".zip"
    else:
        name = f"{config.get('app_name') or 'pupload'}-{time.strftime('%Y%m%d-%H%M')}.zip"
    headers = {
        "Content-Disposition": content_disposition(name, False),
        "X-Content-Type-Options": "nosniff",
    }
    return StreamingResponse(zip_stream(targets), media_type="application/zip", headers=headers)


async def api_thumb(request: Request) -> Response:
    """Small JPEG preview for images. Falls back to the original when Pillow is absent."""
    try:
        target = storage.safe_join(request.query_params.get("path", ""))
    except StorageError as exc:
        return fail(str(exc))
    if not target.exists() or target.is_dir() or storage.kind_of(target) != "image":
        return fail("No preview", 404)
    if not config.get("thumbnails"):
        return serve_file(target, request, False)

    try:
        from PIL import Image  # type: ignore
    except Exception:
        return serve_file(target, request, False)

    st = target.stat()
    key = hashlib.sha1(f"{storage.rel_of(target)}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()
    cached = THUMB_DIR / f"{key}.jpg"
    if not cached.exists():
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        try:
            with Image.open(target) as im:
                im.draft("RGB", (640, 640))
                im = im.convert("RGB")
                im.thumbnail((420, 420))
                im.save(cached, "JPEG", quality=78, optimize=True)
        except Exception:
            return serve_file(target, request, False)
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
    for trash_id in data.get("ids") or []:
        try:
            restored.append(await asyncio.to_thread(trash.restore, str(trash_id)))
        except (StorageError, OSError, shutil.Error) as exc:
            errors.append(str(exc))
    if errors and not restored:
        return fail(errors[0])
    return ok({"restored": restored, "errors": errors, "stats": storage.stats()})


async def api_trash_delete(request: Request) -> Response:
    data = await body_json(request)
    freed = count = 0
    for trash_id in data.get("ids") or []:
        freed += await asyncio.to_thread(trash.delete_forever, str(trash_id))
        count += 1
    return ok({"count": count, "freed": freed, "stats": storage.stats()})


async def api_trash_empty(request: Request) -> Response:
    result = await asyncio.to_thread(trash.empty)
    return ok({**result, "stats": storage.stats()})


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
    task = asyncio.create_task(_sweeper())
    try:
        yield
    finally:
        task.cancel()


routes: List[Any] = [
    Route("/", index),
    Route("/share", index),   # PWA share target: links shared from other apps
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
    Route("/api/raw", api_file),
    Route("/api/download", api_file),
    Route("/api/zip", api_zip),
    Route("/api/thumb", api_thumb),
    Mount("/", WebFiles(directory=str(WEB_DIR), check_dir=False), name="web"),
]

app = Starlette(routes=routes, lifespan=lifespan)
