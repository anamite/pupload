"""Settings persistence and storage-location discovery."""
from __future__ import annotations

import json
import os
import shutil
import string
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("PUPLOAD_DATA") or (BASE_DIR / "data")).resolve()
CONFIG_PATH = DATA_DIR / "config.json"

GB = 1024 ** 3
THEMES = ("system", "light", "slate", "ink")
VIEWS = ("grid", "list")
SORTS = ("name", "new", "old", "size", "expiry")
EXPIRY_MODES = ("created", "accessed")

DEFAULTS: Dict[str, Any] = {
    "app_name": "pupload",
    "storage_root": str(DATA_DIR / "files"),
    "quota_bytes": 5 * GB,          # None -> unlimited
    "expiry_days": 30,              # 0 -> never expire
    "expiry_mode": "created",       # or "accessed": countdown restarts on download
    "trash_days": 30,               # recycle bin retention; 0 -> keep until emptied
    "theme": "system",
    "view": "grid",
    "sort": "name",
    "confirm_delete": True,
    "show_hidden": False,
    "thumbnails": True,
    "keep_free_bytes": 512 * 1024 * 1024,   # never fill the disk past this
}

# Filesystems that are never interesting as a storage target.
PSEUDO_FS = {
    "autofs", "bpf", "cgroup", "cgroup2", "configfs", "debugfs", "devpts",
    "devtmpfs", "efivarfs", "fuse.gvfsd-fuse", "fusectl", "hugetlbfs",
    "mqueue", "overlay", "proc", "pstore", "ramfs", "securityfs",
    "selinuxfs", "squashfs", "sysfs", "tracefs",
}

_lock = threading.RLock()
_cache: Optional[Dict[str, Any]] = None


def _as_int(value: Any, default: int, minimum: int = 0, maximum: Optional[int] = None) -> int:
    try:
        out = int(float(value))
    except (TypeError, ValueError):
        return default
    if out < minimum:
        out = minimum
    if maximum is not None and out > maximum:
        out = maximum
    return out


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def sanitize(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Merge user input over the defaults, clamping everything to something sane."""
    cfg = dict(DEFAULTS)
    for key, value in (raw or {}).items():
        if key in DEFAULTS:
            cfg[key] = value

    cfg["app_name"] = str(cfg["app_name"]).strip()[:40] or DEFAULTS["app_name"]

    root = str(cfg["storage_root"]).strip() or DEFAULTS["storage_root"]
    cfg["storage_root"] = str(Path(root).expanduser())

    quota = cfg["quota_bytes"]
    if quota in (None, "", "unlimited", "none", 0, "0"):
        cfg["quota_bytes"] = None
    else:
        cfg["quota_bytes"] = _as_int(quota, DEFAULTS["quota_bytes"], 64 * 1024 * 1024)

    cfg["expiry_days"] = _as_int(cfg["expiry_days"], DEFAULTS["expiry_days"], 0, 3650)
    cfg["expiry_mode"] = cfg["expiry_mode"] if cfg["expiry_mode"] in EXPIRY_MODES else "created"
    cfg["trash_days"] = _as_int(cfg["trash_days"], DEFAULTS["trash_days"], 0, 3650)
    cfg["theme"] = cfg["theme"] if cfg["theme"] in THEMES else DEFAULTS["theme"]
    cfg["view"] = cfg["view"] if cfg["view"] in VIEWS else DEFAULTS["view"]
    cfg["sort"] = cfg["sort"] if cfg["sort"] in SORTS else DEFAULTS["sort"]
    cfg["confirm_delete"] = _as_bool(cfg["confirm_delete"], True)
    cfg["show_hidden"] = _as_bool(cfg["show_hidden"], False)
    cfg["thumbnails"] = _as_bool(cfg["thumbnails"], True)
    cfg["keep_free_bytes"] = _as_int(cfg["keep_free_bytes"], DEFAULTS["keep_free_bytes"], 0)
    return cfg


def load() -> Dict[str, Any]:
    global _cache
    with _lock:
        if _cache is None:
            try:
                raw = json.loads(CONFIG_PATH.read_text("utf-8"))
            except (OSError, ValueError):
                raw = {}
            _cache = sanitize(raw)
            if not CONFIG_PATH.exists():
                _write(_cache)
        return dict(_cache)


def _write(cfg: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2), "utf-8")
    tmp.replace(CONFIG_PATH)


def update(patch: Dict[str, Any]) -> Dict[str, Any]:
    global _cache
    with _lock:
        cfg = sanitize({**load(), **(patch or {})})
        _write(cfg)
        _cache = cfg
        return dict(cfg)


def get(key: str) -> Any:
    return load().get(key)


def storage_root() -> Path:
    path = Path(load()["storage_root"])
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


# ---------------------------------------------------------------------------
# Storage-location discovery, so the UI can offer other disks / partitions
# ---------------------------------------------------------------------------

def _linux_mounts() -> List[Dict[str, str]]:
    found: List[Dict[str, str]] = []
    try:
        with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 3:
                    continue
                device, mount, fstype = parts[0], parts[1].replace("\\040", " "), parts[2]
                if fstype in PSEUDO_FS:
                    continue
                if not (device.startswith("/dev/") or mount.startswith(("/media/", "/mnt/", "/srv"))):
                    continue
                found.append({"mount": mount, "device": device, "fstype": fstype})
    except OSError:
        pass
    return found


def _windows_drives() -> List[Dict[str, str]]:
    found: List[Dict[str, str]] = []
    for letter in string.ascii_uppercase:
        mount = letter + ":\\"
        if os.path.exists(mount):
            found.append({"mount": mount, "device": letter + ":", "fstype": ""})
    return found


def _nearest_existing(path: Path) -> Path:
    probe = path
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    return probe


def _writable(path: Path) -> bool:
    return os.access(str(_nearest_existing(path)), os.W_OK)


def _usage(path: Path) -> Dict[str, int]:
    try:
        total, _used, free = shutil.disk_usage(str(_nearest_existing(path)))
        return {"total": total, "free": free}
    except OSError:
        return {"total": 0, "free": 0}


def storage_options() -> List[Dict[str, Any]]:
    """Candidate folders the user can point storage at, one per real disk."""
    current = str(Path(load()["storage_root"]))
    options: List[Dict[str, Any]] = []
    seen = set()

    def add(path: str, label: str, mount: str = "") -> None:
        key = str(Path(path))
        if key in seen:
            return
        seen.add(key)
        info = _usage(Path(path))
        options.append({
            "path": key,
            "label": label,
            "mount": mount,
            "total": info["total"],
            "free": info["free"],
            "writable": _writable(Path(path)),
            "current": key == current,
            "exists": Path(path).exists(),
        })

    add(current, "Current location")
    add(str(DATA_DIR / "files"), "Default (inside the app folder)")

    for item in (_windows_drives() if os.name == "nt" else _linux_mounts()):
        mount = item["mount"]
        base = Path(mount)
        if mount == "/":
            add(str(Path.home() / "pupload-files"), "System disk (home folder)", mount)
            continue
        if os.name == "nt":
            label = f"Disk {item['device']}"
        else:
            name = base.name or mount
            label = f"{name} ({item['device']})" if item["device"] else str(name)
        add(str(base / "pupload"), label, mount)

    return options
