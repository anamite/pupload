"""Saved links: validation and best-effort page-title lookup."""
from __future__ import annotations

import html
import re
import urllib.parse
import urllib.request
from typing import Any, List, Optional

from . import db

# Schemes a saved link may use. Anything else (javascript:, data:, file:) is
# refused so a saved link can never run script when clicked.
SCHEMES = ("http", "https", "ftp", "sftp", "smb", "magnet", "mailto", "tel")
MAX_TAGS = 12

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
_OG_RE = re.compile(
    r"<meta[^>]+(?:property|name)=[\"'](?:og:title|twitter:title)[\"'][^>]+content=[\"']([^\"']+)", re.I)


class LinkError(Exception):
    pass


def normalize_url(raw: Any) -> str:
    url = str(raw or "").strip()
    if not url:
        raise LinkError("Enter a link")
    if len(url) > 4000:
        raise LinkError("That link is too long")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url):
        url = "https://" + url
    scheme = url.split(":", 1)[0].lower()
    if scheme not in SCHEMES:
        raise LinkError(f"Links starting with {scheme}: are not allowed")
    if scheme in ("http", "https"):
        parsed = urllib.parse.urlsplit(url)
        if not parsed.netloc:
            raise LinkError("That does not look like a web address")
    return url


def clean_text(raw: Any, limit: int) -> str:
    return str(raw or "").strip()[:limit]


def clean_tags(raw: Any) -> List[str]:
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for tag in raw:
        tag = re.sub(r"\s+", " ", str(tag or "")).strip().lstrip("#")[:32]
        if tag and tag.lower() not in (t.lower() for t in out):
            out.append(tag)
    return out[:MAX_TAGS]


def fetch_title(url: str) -> Optional[str]:
    if not url.lower().startswith(("http://", "https://")):
        return None
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (pupload link saver)",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    })
    try:
        with urllib.request.urlopen(req, timeout=6) as res:
            if "html" not in (res.headers.get("Content-Type") or "html"):
                return None
            body = res.read(256 * 1024)
            charset = res.headers.get_content_charset() or "utf-8"
    except Exception:
        return None
    text = body.decode(charset, errors="replace")
    match = _OG_RE.search(text) or _TITLE_RE.search(text)
    if not match:
        return None
    title = re.sub(r"\s+", " ", html.unescape(match.group(1))).strip()
    return title[:300] or None


def fill_title(link_id: int, url: str) -> None:
    """Run in a worker thread after a link without a title is saved."""
    title = fetch_title(url)
    if title:
        db.link_set_title_if_empty(link_id, title)
