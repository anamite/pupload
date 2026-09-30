"""The private space: notes, voice memos, lists and a calendar.

It only exists for a request that may open secure folders (a device that
unlocked them at home, or a full remote sign-in). Everywhere else it is not
listed, not searched and not in the recycle bin: a basic sign-in gets 404,
a locked home device 423 (so an unlock that ran out can be renewed).

Every record is one row of `private`, its JSON sealed with a key derived from
the secure folders' data key and bound to its id and kind. Voice memos'
audio sits in `<storage>/.pupload-private/<id>.pmemo`, in the same streamed,
seekable format as files in secure folders. What the disk shows is how many
records of each kind there are, when they last changed and how big memos are.

Times follow the calendar's convention: a plain date ("2026-10-01") is a
whole day in whatever zone the viewer is in; anything with a time is a UTC
instant ("2026-10-01T10:30:00Z").
"""
from __future__ import annotations

import datetime as dt
import json
import re
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import db, storage, vault
from .errors import NotFound, StorageError

KINDS = ("note", "list", "event", "memo")
LABELS = {"note": "Notes", "list": "Lists", "event": "Calendar", "memo": "Voice memos"}
COLORS = ("", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink")
FREQS = ("daily", "weekly", "monthly", "yearly")

MAX_NOTE = 400_000          # characters of markdown
MAX_TITLE = 300
MAX_ITEMS = 2000            # per list
MAX_ITEM_TEXT = 2000
MAX_ALERTS = 5
MAX_MEMO_BYTES = 512 * 1024 * 1024
MEMO_MIMES = ("audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/wav",
              "audio/x-wav", "audio/x-m4a", "audio/m4a", "audio/3gpp", "audio/amr", "audio/flac")

ID_RE = re.compile(r"^[a-z0-9]{6,40}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INSTANT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(\.\d+)?Z$")


def new_id() -> str:
    return secrets.token_hex(8)


def keys() -> vault.Keys:
    """The keys for this request, or the reason it can't see the private space."""
    if vault.HIDDEN.get() or not vault.configured():
        raise NotFound()
    return vault.require()


# ---------------------------------------------------------------------------
# Cleaning what the browser sends
# ---------------------------------------------------------------------------

def _text(value: Any, limit: int) -> str:
    text = value if isinstance(value, str) else ""
    return text.replace("\x00", "")[:limit]


def _line(value: Any, limit: int = MAX_TITLE) -> str:
    return re.sub(r"\s+", " ", _text(value, limit * 2)).strip()[:limit]


def _day(value: Any) -> Optional[str]:
    if isinstance(value, str) and DAY_RE.match(value):
        try:
            return dt.date.fromisoformat(value).isoformat()
        except ValueError:
            return None
    return None


def _instant(value: Any) -> Optional[str]:
    """ISO UTC instant normalised to whole seconds."""
    if not isinstance(value, str):
        return None
    m = INSTANT_RE.match(value)
    if not m:
        return None
    try:
        moment = dt.datetime.strptime(m.group(1) + (m.group(2) or ":00"), "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _when(value: Any) -> Optional[str]:
    """A due date: a plain day or an instant."""
    return _day(value) or _instant(value)


def _color(value: Any) -> str:
    return value if value in COLORS else ""


def _id(value: Any) -> str:
    return value if isinstance(value, str) and ID_RE.match(value) else new_id()


def _stamp(value: Any, default: float) -> float:
    return float(value) if isinstance(value, (int, float)) and 0 < value < 1e11 else default


def auto_title(body: str) -> str:
    """The first two words of a note, without markdown decoration."""
    for line in body.splitlines():
        plain = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", lambda m: m.group(2) or m.group(1).rsplit("/", 1)[-1], line)
        plain = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", plain)
        plain = re.sub(r"^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)", "", plain)
        plain = re.sub(r"[*_`~#>]", "", plain)
        words = plain.split()
        if words:
            return " ".join(words[:2])[:MAX_TITLE]
    return ""


def clean_note(raw: Dict[str, Any], old: Optional[Dict[str, Any]], now: float) -> Dict[str, Any]:
    body = _text(raw.get("body"), MAX_NOTE)
    title_auto = bool(raw.get("title_auto", True))
    title = auto_title(body) if title_auto else _line(raw.get("title"))
    if not title_auto and not title:
        title_auto, title = True, auto_title(body)
    return {
        "id": old["id"] if old else _id(raw.get("id")),
        "title": title,
        "title_auto": title_auto,
        "body": body,
        "pinned": bool(raw.get("pinned")),
        "color": _color(raw.get("color")),
        "created": old["created"] if old else now,
        "updated": now,
    }


def clean_list(raw: Dict[str, Any], old: Optional[Dict[str, Any]], now: float) -> Dict[str, Any]:
    before = {i["id"]: i for i in (old or {}).get("items", [])}
    items: List[Dict[str, Any]] = []
    seen = set()
    for entry in (raw.get("items") or [])[:MAX_ITEMS]:
        if not isinstance(entry, dict):
            continue
        text = _line(entry.get("text"), MAX_ITEM_TEXT)
        if not text:
            continue
        item_id = _id(entry.get("id"))
        if item_id in seen:
            item_id = new_id()
        seen.add(item_id)
        prev = before.get(item_id) or {}
        done = bool(entry.get("done"))
        items.append({
            "id": item_id,
            "text": text,
            "done": done,
            "due": _when(entry.get("due")),
            "note": _text(entry.get("note"), 4000),
            "created": _stamp(prev.get("created") or entry.get("created"), now),
            "done_at": (prev.get("done_at") or now) if done else None,
        })
    return {
        "id": old["id"] if old else _id(raw.get("id")),
        "name": _line(raw.get("name")) or "Untitled list",
        "items": items,
        "pinned": bool(raw.get("pinned")),
        "color": _color(raw.get("color")),
        "created": old["created"] if old else now,
        "updated": now,
    }


def _repeat(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict) or raw.get("freq") not in FREQS:
        return None
    rule: Dict[str, Any] = {"freq": raw["freq"]}
    try:
        rule["interval"] = max(1, min(999, int(raw.get("interval") or 1)))
    except (TypeError, ValueError):
        rule["interval"] = 1
    if isinstance(raw.get("count"), int) and raw["count"] > 0:
        rule["count"] = min(10000, raw["count"])
    until = _when(raw.get("until"))
    if until and "count" not in rule:
        rule["until"] = until
    if rule["freq"] == "weekly" and isinstance(raw.get("byday"), list):
        days = sorted({d for d in raw["byday"] if isinstance(d, int) and 0 <= d <= 6})
        if days:
            rule["byday"] = days
    return rule


def clean_event(raw: Dict[str, Any], old: Optional[Dict[str, Any]], now: float) -> Dict[str, Any]:
    all_day = bool(raw.get("all_day"))
    if all_day:
        start, end = _day(raw.get("start")), _day(raw.get("end"))
    else:
        start, end = _instant(raw.get("start")), _instant(raw.get("end"))
    if not start:
        raise StorageError("The event needs a valid start")
    if not end or end < start:
        end = start
    alerts = []
    for minutes in raw.get("alerts") or []:
        if isinstance(minutes, (int, float)) and 0 <= minutes <= 60 * 24 * 60:
            alerts.append(int(minutes))
    return {
        "id": old["id"] if old else _id(raw.get("id")),
        "title": _line(raw.get("title")) or "Untitled event",
        "notes": _text(raw.get("notes"), 20000),
        "location": _line(raw.get("location")),
        "all_day": all_day,
        "start": start,
        "end": end,
        "alerts": sorted(set(alerts))[:MAX_ALERTS],
        "repeat": _repeat(raw.get("repeat")),
        "color": _color(raw.get("color")),
        # Where it came from: "local", an imported .ics file, and later a synced calendar.
        "source": (old or {}).get("source") or (raw.get("source") if raw.get("source") in ("ics",) else "local"),
        "uid": (old or {}).get("uid") or _line(raw.get("uid"), 300),
        "created": old["created"] if old else now,
        "updated": now,
    }


def clean_memo(raw: Dict[str, Any], old: Optional[Dict[str, Any]], now: float) -> Dict[str, Any]:
    if not old:
        raise StorageError("Record a voice memo first")
    return {**old, "title": _line(raw.get("title")) or old.get("title") or "Voice memo",
            "note": _text(raw.get("note"), 20000), "pinned": bool(raw.get("pinned")), "updated": now}


CLEANERS = {"note": clean_note, "list": clean_list, "event": clean_event, "memo": clean_memo}


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------

def _label(kind: str, item_id: str) -> bytes:
    return f"pupload private {kind} {item_id}".encode("utf-8")


def seal(k: vault.Keys, kind: str, doc: Dict[str, Any]) -> bytes:
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return k.seal_doc(data, _label(kind, doc["id"]))


def unseal(k: vault.Keys, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    plain = k.open_doc(bytes(row["blob"]), _label(row["kind"], row["id"]))
    if plain is None:
        return None     # sealed by another key (secure folders were set up again)
    try:
        doc = json.loads(plain.decode("utf-8"))
    except ValueError:
        return None
    return doc if isinstance(doc, dict) else None


def everything(k: vault.Keys) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {kind: [] for kind in KINDS}
    for row in db.private_rows():
        if row["kind"] not in out:
            continue
        doc = unseal(k, row)
        if doc is not None:
            out[row["kind"]].append(doc)
    for docs in out.values():
        docs.sort(key=lambda d: d.get("updated") or 0, reverse=True)
    return out


def get(k: vault.Keys, kind: str, item_id: str) -> Optional[Dict[str, Any]]:
    row = db.private_get(item_id) if isinstance(item_id, str) else None
    if row is None or row["kind"] != kind:
        return None
    return unseal(k, row)


def save(k: vault.Keys, kind: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    if kind not in CLEANERS:
        raise StorageError("Unknown kind")
    old = get(k, kind, raw.get("id")) if raw.get("id") else None
    if old is None and isinstance(raw.get("id"), str) and db.private_get(raw["id"]) is not None:
        raw = {**raw, "id": new_id()}      # never overwrite a record of another kind
    doc = CLEANERS[kind](raw, old, time.time())
    db.private_put(doc["id"], kind, seal(k, kind, doc))
    return doc


def put(k: vault.Keys, kind: str, doc: Dict[str, Any]) -> None:
    db.private_put(doc["id"], kind, seal(k, kind, doc))


def title_of(kind: str, doc: Dict[str, Any]) -> str:
    return (doc.get("name") if kind == "list" else doc.get("title")) or LABELS.get(kind, "Item")


# ---------------------------------------------------------------------------
# Voice memo audio
# ---------------------------------------------------------------------------

def memo_dir() -> Path:
    path = storage.root() / storage.PRIVATE_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def memo_path(file_name: str) -> Path:
    if not re.fullmatch(r"[a-z0-9]{6,40}\.pmemo", file_name or ""):
        raise StorageError("Invalid memo")
    return memo_dir() / file_name


def memo_mime(value: str) -> str:
    base = (value or "").split(";", 1)[0].strip().lower()
    return base if base in MEMO_MIMES else "audio/webm"


MEMO_EXT = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
            "audio/m4a": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/wav": "wav",
            "audio/x-wav": "wav", "audio/3gpp": "3gp", "audio/amr": "amr", "audio/flac": "flac"}


def memo_download_name(doc: Dict[str, Any]) -> str:
    stem = storage.clean_name(doc.get("title") or "Voice memo")
    return f"{stem}.{MEMO_EXT.get(doc.get('mime') or '', 'webm')}"
