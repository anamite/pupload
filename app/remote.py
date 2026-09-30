"""Remote access: a second port, meant for a tunnel (Cloudflare Tunnel, say),
where nothing opens without a password *and* an authenticator code.

The home-network port is unchanged: no login, as before. The remote port
(127.0.0.1:8090 by default, so only a tunnel running on the Pi can reach it)
serves the sign-in page and nothing else until someone signs in with

    basic password + code  ->  files, links, recycle bin. Secure folders are
                               hidden: not shown, not listed, not reachable.
    full password  + code  ->  everything, with secure folders unlocked.

Both passwords go through the same checks, one scrypt computation per try
(one salt, so it costs the same whichever password is typed), and the same
reply for any mistake, so a wrong try never says which part was wrong or which
password came close. The full password is not stored in any checkable form:
it wraps the secure folders' data key, exactly like the master password in
vault.json does, and signing in with it *is* unwrapping that key.

    password --scrypt(salt)--> K --HMAC------> matches "basic"?  -> basic session
                                 +--AES-GCM--> unwraps data key? -> full session

data/remote.json holds the salt, the basic check, the wrapped key, the TOTP
secret and the (hashed) basic sessions, so a restart keeps phones signed in.
Full sessions live only in memory, like the vault key itself.
"""
from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import json
import os
import secrets
import struct
import threading
import time
import unicodedata
import urllib.parse
from typing import Any, Deque, Dict, List, Optional, Tuple

from . import config, vault
from .errors import StorageError

REMOTE_PATH = config.DATA_DIR / "remote.json"
COOKIE = "pupload_remote"
DEFAULT_PORT = 8090
MIN_PASSWORD = 10
MAX_SESSIONS = 50

SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}
TOTP_STEP = 30
TOTP_DIGITS = 6
SETUP_SECONDS = 15 * 60          # an unconfirmed authenticator secret is kept this long

# Guessing protection, on top of scrypt and the second factor.
FREE_TRIES = 5                   # per address, then an exponential wait (max 15 min)
GLOBAL_WINDOW = 10 * 60
GLOBAL_FREE = 20                 # failures from all addresses in the window, then...
GLOBAL_GAP = 10                  # ...one try every 10 s, whoever it comes from

# Where the remote port listens; set by run.py, shown in the settings.
LISTEN: Dict[str, Any] = {"host": None, "port": None, "error": ""}

_lock = threading.RLock()
_sessions: Dict[str, Dict[str, Any]] = {}      # sha256(token) -> session
_loaded = False
_pending: Dict[str, Tuple[bytes, float]] = {}  # setup id -> (TOTP secret, created)
_last_step = 0                                  # codes are single use
_failures: Dict[str, Tuple[int, float]] = {}   # ip -> (failures, last failure)
_recent: Deque[float] = collections.deque()    # every failure, for the global limit
_last_try = 0.0


# ---------------------------------------------------------------------------
# TOTP (RFC 6238), the codes authenticator apps show
# ---------------------------------------------------------------------------

def _totp(secret: bytes, step: int) -> str:
    mac = hmac.new(secret, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    value = struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10 ** TOTP_DIGITS).zfill(TOTP_DIGITS)


def _clean_code(code: Any) -> str:
    return "".join(ch for ch in str(code or "") if ch.isdigit())


def _code_step(secret: bytes, code: str, after: int = 0) -> Optional[int]:
    """The time step `code` belongs to (now, or one step either side for clock
    drift), or None. Steps at or before `after` were used already."""
    code = _clean_code(code)
    if len(code) != TOTP_DIGITS:
        return None
    now = int(time.time() // TOTP_STEP)
    found = None
    for step in (now - 1, now, now + 1):
        if hmac.compare_digest(_totp(secret, step), code) and step > after:
            found = step
    return found


def _b32(secret: bytes) -> str:
    return base64.b32encode(secret).decode("ascii").rstrip("=")


def begin_setup(label: str) -> Dict[str, str]:
    """A fresh authenticator secret to scan. It is only saved by `setup`,
    once a code from it has been typed back."""
    secret = secrets.token_bytes(20)
    setup_id = secrets.token_urlsafe(16)
    now = time.time()
    with _lock:
        for key in [k for k, (_s, t) in _pending.items() if now - t > SETUP_SECONDS]:
            del _pending[key]
        _pending[setup_id] = (secret, now)
    issuer = config.get("app_name") or "pupload"
    uri = "otpauth://totp/{}?{}".format(
        urllib.parse.quote(f"{issuer}:{label}"),
        urllib.parse.urlencode({"secret": _b32(secret), "issuer": issuer, "algorithm": "SHA1",
                                "digits": TOTP_DIGITS, "period": TOTP_STEP}),
    )
    return {"setup_id": setup_id, "secret": _b32(secret), "uri": uri}


# ---------------------------------------------------------------------------
# The remote.json file
# ---------------------------------------------------------------------------

def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def configured() -> bool:
    return REMOTE_PATH.is_file()


def _read() -> Dict[str, Any]:
    try:
        return json.loads(REMOTE_PATH.read_text("utf-8"))
    except (OSError, ValueError):
        raise StorageError("Remote access is not set up")


def _write(doc: Dict[str, Any]) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = REMOTE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2), "utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, REMOTE_PATH)


def _derive(password: str, salt: bytes, params: Dict[str, Any]) -> bytes:
    secret = unicodedata.normalize("NFC", password or "").encode("utf-8")
    n, r, p = int(params["n"]), int(params["r"]), int(params["p"])
    return hashlib.scrypt(secret, salt=salt, n=n, r=r, p=p, maxmem=256 * r * n + 1024 * 1024, dklen=32)


def _basic_check(key: bytes) -> bytes:
    return hmac.new(key, b"pupload remote basic", hashlib.sha256).digest()


def _vault_stamp() -> str:
    """Identifies the current vault.json, so a full password made for secure
    folders that were since replaced is not mistaken for a working one."""
    try:
        return str(json.loads(vault.VAULT_PATH.read_text("utf-8")).get("created", ""))
    except (OSError, ValueError):
        return ""


def password_problem(password: str) -> Optional[str]:
    if len(password or "") < MIN_PASSWORD:
        return f"Use at least {MIN_PASSWORD} characters"
    if len(password) > 1024:
        return "That password is too long"
    return None


def setup(setup_id: str, code: str, basic: str, full: str, data_key: bytes) -> None:
    """Save both passwords and the authenticator. Signs out every remote device."""
    with _lock:
        pending = _pending.get(setup_id)
    if pending is None or time.time() - pending[1] > SETUP_SECONDS:
        raise StorageError("The setup timed out. Start again")
    secret = pending[0]
    if _code_step(secret, code) is None:
        raise StorageError("That code is not right. Check the phone's clock, and use the newest code")
    salt = os.urandom(16)
    key_basic = _derive(basic, salt, SCRYPT)
    key_full = _derive(full, salt, SCRYPT)
    nonce = os.urandom(12)
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    doc = {
        "version": 1,
        "created": time.time(),
        "kdf": {"alg": "scrypt", "salt": _b64(salt), **SCRYPT},
        "basic": _b64(_basic_check(key_basic)),
        "full": {"nonce": _b64(nonce),
                 "wrapped": _b64(AESGCM(key_full).encrypt(nonce, data_key, b"pupload remote full"))},
        "vault": _vault_stamp(),
        "totp": _b32(secret),
        "sessions": {},
    }
    with _lock:
        _pending.pop(setup_id, None)
        _write(doc)
        _drop_all()


def disable() -> None:
    with _lock:
        REMOTE_PATH.unlink(missing_ok=True)
        _drop_all()


def _totp_secret(doc: Dict[str, Any]) -> bytes:
    text = str(doc.get("totp") or "")
    return base64.b32decode(text + "=" * (-len(text) % 8))


def check(password: str, code: str) -> Optional[Tuple[str, Optional[bytes]]]:
    """("basic", None) or ("full", data key) for a right password and code;
    None for anything wrong. Slow on purpose (scrypt): run it in a thread."""
    global _last_step
    try:
        doc = _read()
        secret = _totp_secret(doc)
        kdf = doc["kdf"]
        salt = _unb64(kdf["salt"])
    except (StorageError, KeyError, ValueError):
        return None
    with _lock:
        step = _code_step(secret, code, _last_step)
    if step is None:
        return None
    key = _derive(password, salt, kdf)
    tier: Optional[str] = None
    data_key: Optional[bytes] = None
    if hmac.compare_digest(_basic_check(key), _unb64(doc.get("basic") or "")):
        tier = "basic"
    else:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        full = doc.get("full") or {}
        try:
            data_key = AESGCM(key).decrypt(_unb64(full["nonce"]), _unb64(full["wrapped"]),
                                           b"pupload remote full")
            tier = "full"
        except (InvalidTag, KeyError, ValueError):
            return None
    with _lock:
        if step <= _last_step:       # someone else used this code meanwhile
            return None
        _last_step = step
    return tier, data_key


def full_is_current() -> bool:
    """False when secure folders were set up again after remote access was."""
    try:
        return _read().get("vault") == _vault_stamp()
    except StorageError:
        return False


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "ignore")).hexdigest()


def _load() -> None:
    """Basic sessions survive a restart; full ones never do (the key is gone)."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        saved = _read().get("sessions") or {}
    except StorageError:
        return
    now = time.time()
    for digest, rec in saved.items():
        if isinstance(rec, dict) and rec.get("tier") == "basic" and float(rec.get("expires", 0)) > now:
            _sessions[digest] = {**rec, "vault_token": None}


def _save() -> None:
    try:
        doc = _read()
    except StorageError:
        return
    doc["sessions"] = {d: {k: v for k, v in s.items() if k != "vault_token"}
                       for d, s in _sessions.items() if s["tier"] == "basic"}
    _write(doc)


def _drop_all() -> None:
    for rec in _sessions.values():
        if rec.get("vault_token"):
            vault.end_session(rec["vault_token"])
    _sessions.clear()
    if configured():
        _save()


def start(tier: str, data_key: Optional[bytes], device: str, ip: str) -> Tuple[str, float]:
    """A new remote session; a full one also opens secure folders."""
    token = secrets.token_urlsafe(32)
    now = time.time()
    rec: Dict[str, Any] = {"tier": tier, "created": now, "device": device, "ip": ip,
                           "seen": now, "vault_token": None}
    if tier == "full" and data_key is not None:
        vault_token, expires = vault.open_session(data_key, config.get("vault_hours"), f"{device} (remote)")
        rec["vault_token"] = vault_token
    else:
        expires = now + config.get("remote_days") * 86400
    rec["expires"] = expires
    with _lock:
        _load()
        _sessions[_digest(token)] = rec
        while len(_sessions) > MAX_SESSIONS:
            oldest = min(_sessions, key=lambda d: _sessions[d]["seen"])
            _end(oldest)
        _save()
    return token, expires


def session(token: Optional[str]) -> Optional[Dict[str, Any]]:
    """The live session for a cookie. A full session whose secure-folder unlock
    ended (it expired, or someone pressed "Lock every device") is over too."""
    if not token or not configured():
        return None
    with _lock:
        _load()
        digest = _digest(token)
        rec = _sessions.get(digest)
        if rec is None:
            return None
        now = time.time()
        dead = rec["expires"] <= now or (rec["tier"] == "full" and vault.session(rec["vault_token"]) is None)
        if dead:
            _end(digest)
            _save()
            return None
        rec["seen"] = now
        return rec


def _end(digest: str) -> None:
    rec = _sessions.pop(digest, None)
    if rec and rec.get("vault_token"):
        vault.end_session(rec["vault_token"])


def end(token: Optional[str]) -> None:
    if not token:
        return
    with _lock:
        _load()
        if _digest(token) in _sessions:
            _end(_digest(token))
            _save()


def end_all() -> int:
    with _lock:
        _load()
        count = len(_sessions)
        _drop_all()
    return count


def listing() -> List[Dict[str, Any]]:
    with _lock:
        _load()
        now = time.time()
        live = [s for s in _sessions.values()
                if s["expires"] > now and (s["tier"] == "basic" or vault.session(s["vault_token"]))]
        return sorted(({k: v for k, v in s.items() if k != "vault_token"} for s in live),
                      key=lambda s: -s["seen"])


def status() -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "configured": configured(),
        "port": LISTEN["port"],
        "host": LISTEN["host"],
        "error": LISTEN["error"],
        "days": config.get("remote_days"),
        "hours": config.get("vault_hours"),
        "min_password": MIN_PASSWORD,
    }
    if info["configured"]:
        try:
            info["created"] = _read().get("created")
        except StorageError:
            info["created"] = None
        info["full_ok"] = full_is_current()
        info["sessions"] = listing()
    return info


# ---------------------------------------------------------------------------
# Guessing protection: per address, and across all addresses (a botnet
# spreading its tries over many addresses still only gets a trickle)
# ---------------------------------------------------------------------------

def throttled(ip: str) -> int:
    """Seconds before `ip` may try again (0: go ahead)."""
    now = time.time()
    with _lock:
        while _recent and now - _recent[0] > GLOBAL_WINDOW:
            _recent.popleft()
        wait = 0.0
        count, last = _failures.get(ip, (0, 0.0))
        if count >= FREE_TRIES:
            wait = last + min(15 * 60, 5 * 2 ** (count - FREE_TRIES)) - now
        if len(_recent) >= GLOBAL_FREE:
            wait = max(wait, _last_try + GLOBAL_GAP - now)
        if wait > 0:
            return int(wait) + 1
        return 0


def note_try() -> None:
    global _last_try
    with _lock:
        _last_try = time.time()


def note_failure(ip: str) -> None:
    now = time.time()
    with _lock:
        count, _ = _failures.get(ip, (0, 0.0))
        _failures[ip] = (count + 1, now)
        _recent.append(now)
        if len(_failures) > 10_000:           # don't let a botnet grow this forever
            for key in sorted(_failures, key=lambda k: _failures[k][1])[:5_000]:
                del _failures[key]


def note_success(ip: str) -> None:
    with _lock:
        _failures.pop(ip, None)
