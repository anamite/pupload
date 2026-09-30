"""Secure folders: one master password unlocks every secure folder.

What sits on the disk is useless without the password. Inside a secure
folder, file contents *and* names are encrypted, and the key that decrypts
them is stored only in wrapped form (data/vault.json):

    password ──scrypt──► KEK ──unwraps──► data key ──HKDF──► name / file keys
    recovery key ─HKDF─► RKEK ─unwraps──┘

Unlocking puts the data key in memory and gives that browser a session
cookie. Only requests carrying a live session can see or touch secure
folders; other devices on the network still see them locked. When the last
session ends (it expires, someone presses Lock, or the Pi restarts) the key
is dropped from memory again.

File format (streamed, seekable, authenticated):

    "PUPSEC1\\n" | 16-byte salt | segment 0 | segment 1 | ... | final segment

Each segment is AES-256-GCM over at most 64 KiB with its own tag. The nonce is
the segment number plus a "last segment" flag, so segments cannot be swapped,
dropped or cut off unnoticed. Every file gets its own key, HKDF(file key, salt).

Names are encrypted deterministically (SIV style: an HMAC-SHA256 of the name
is the IV for AES-CTR, and doubles as its integrity check), then base32. The
same name always gives the same on-disk name, so renames, moves and the
recycle bin keep working as plain filesystem operations.
"""
from __future__ import annotations

import base64
import binascii
import collections
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import unicodedata
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Dict, Iterator, Optional, Tuple

from . import config
from .errors import StorageError, VaultLocked

try:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    AVAILABLE = True
except Exception:  # pragma: no cover - the installer normally provides it
    AVAILABLE = False

VAULT_PATH = config.DATA_DIR / "vault.json"
MARKER = ".pupload-secure"          # present in the top folder of every secure folder
COOKIE = "pupload_vault"
MIN_PASSWORD = 8

MAGIC = b"PUPSEC1\n"
SALT = 16
HEADER = len(MAGIC) + SALT
SEG = 64 * 1024
TAG = 16
# base32 of (16-byte IV + name) must fit a 255-byte filename: 143 bytes of name.
NAME_MAX_BYTES = 143

SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}      # ~32 MiB, well under a second on a Pi 4
RECOVERY_BYTES = 20                           # 160 bits, shown as 8 groups of 4
THUMB_CACHE = 300

# Set per request by the session middleware: may this request use the vault?
ACCESS: ContextVar[bool] = ContextVar("pupload_vault_access", default=False)
# ...and should secure folders not even be shown? (a basic remote sign-in)
HIDDEN: ContextVar[bool] = ContextVar("pupload_vault_hidden", default=False)

_lock = threading.RLock()
_keys: Optional["Keys"] = None
_sessions: Dict[str, Dict[str, Any]] = {}          # sha256(token) -> session
_failures: Dict[str, Tuple[int, float]] = {}       # ip -> (failed attempts, last failure)
_thumbs: "collections.OrderedDict[str, bytes]" = collections.OrderedDict()


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------

def _hkdf(key: bytes, info: bytes, salt: Optional[bytes] = None) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(key)


class Keys:
    """Everything derived from the data key. Lives only in memory."""

    def __init__(self, data_key: bytes) -> None:
        self.data_key = data_key        # kept so remote access can wrap it too
        self.id = _hkdf(data_key, b"pupload vault id")[:8].hex()
        self._name_enc = _hkdf(data_key, b"pupload name enc")
        self._name_mac = _hkdf(data_key, b"pupload name mac")
        self._file = _hkdf(data_key, b"pupload file")
        self._stage = AESGCM(_hkdf(data_key, b"pupload stage"))
        self._private = AESGCM(_hkdf(data_key, b"pupload private"))

    def _ctr(self, iv: bytes):
        return Cipher(algorithms.AES(self._name_enc), modes.CTR(iv))

    def _mac(self, data: bytes) -> bytes:
        return hmac.new(self._name_mac, data, hashlib.sha256).digest()[:16]

    def enc_name(self, name: str) -> str:
        data = name.encode("utf-8")
        iv = self._mac(data)
        body = self._ctr(iv).encryptor().update(data)
        return base64.b32encode(iv + body).decode("ascii").rstrip("=").lower()

    def dec_name(self, stored: str) -> Optional[str]:
        """The real name, or None for anything this key did not encrypt."""
        try:
            raw = base64.b32decode(stored.upper() + "=" * (-len(stored) % 8))
        except (ValueError, binascii.Error):
            return None
        if len(raw) < 17:
            return None
        iv, body = raw[:16], raw[16:]
        data = self._ctr(iv).decryptor().update(body)
        if not hmac.compare_digest(self._mac(data), iv):
            return None
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return None

    def file_cipher(self, salt: bytes) -> "AESGCM":
        return AESGCM(_hkdf(self._file, b"pupload file key", salt=salt))

    def seal_stage(self, data: bytes, label: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._stage.encrypt(nonce, data, label)

    def open_stage(self, blob: bytes, label: bytes) -> bytes:
        try:
            return self._stage.decrypt(blob[:12], blob[12:], label)
        except (InvalidTag, ValueError):
            raise StorageError("The unfinished upload is damaged; start it again")

    def seal_doc(self, data: bytes, label: bytes) -> bytes:
        """A private-space record (note, list, event, memo). `label` binds it to its id."""
        nonce = os.urandom(12)
        return nonce + self._private.encrypt(nonce, data, label)

    def open_doc(self, blob: bytes, label: bytes) -> Optional[bytes]:
        try:
            return self._private.decrypt(blob[:12], blob[12:], label)
        except (InvalidTag, ValueError):
            return None


def current() -> Optional[Keys]:
    """The keys, if this request may use them."""
    return _keys if ACCESS.get() else None


def require() -> Keys:
    keys = current()
    if keys is None:
        raise VaultLocked()
    return keys


def data_key() -> bytes:
    return require().data_key


# ---------------------------------------------------------------------------
# Encrypted files
# ---------------------------------------------------------------------------

def _nonce(index: int, final: bool) -> bytes:
    return index.to_bytes(11, "big") + (b"\x01" if final else b"\x00")


class Encryptor:
    """Plaintext in, encrypted segments out. `feed` only emits whole segments;
    `finish` seals the rest (possibly nothing) as the final one."""

    def __init__(self, keys: Keys, salt: Optional[bytes] = None, index: int = 0,
                 pending: bytes = b"") -> None:
        self.salt = salt or os.urandom(SALT)
        self.index = index
        self.pending = pending
        self._aead = keys.file_cipher(self.salt)

    @property
    def header(self) -> bytes:
        return MAGIC + self.salt

    def feed(self, data: bytes) -> bytes:
        buf = self.pending + data if self.pending else bytes(data)
        whole = len(buf) // SEG
        out = []
        for i in range(whole):
            out.append(self._aead.encrypt(_nonce(self.index, False), buf[i * SEG:(i + 1) * SEG], None))
            self.index += 1
        self.pending = buf[whole * SEG:]
        return b"".join(out)

    def finish(self) -> bytes:
        out = self._aead.encrypt(_nonce(self.index, True), self.pending, None)
        self.index += 1
        self.pending = b""
        return out


def layout(cipher_size: int) -> Optional[Tuple[int, int]]:
    """(whole segments, bytes in the final segment), or None if malformed."""
    body = cipher_size - HEADER - TAG
    if body < 0:
        return None
    whole = body // (SEG + TAG)
    last = body - whole * (SEG + TAG)
    if last >= SEG:
        return None
    return whole, last


def plain_size(cipher_size: int) -> int:
    shape = layout(cipher_size)
    return 0 if shape is None else shape[0] * SEG + shape[1]


def is_encrypted(path: Path) -> bool:
    try:
        with open(path, "rb") as fh:
            head = fh.read(HEADER)
    except OSError:
        return False
    return len(head) == HEADER and head[:len(MAGIC)] == MAGIC and layout(path.stat().st_size) is not None


def read_plain(path: Path, keys: Keys, start: int = 0, length: Optional[int] = None) -> Iterator[bytes]:
    """Decrypt `length` bytes from `start`, touching only the segments needed."""
    with open(path, "rb") as fh:
        head = fh.read(HEADER)
        shape = layout(os.fstat(fh.fileno()).st_size)
        if len(head) != HEADER or head[:len(MAGIC)] != MAGIC or shape is None:
            raise StorageError("This file is damaged")
        aead = keys.file_cipher(head[len(MAGIC):])
        whole, last = shape
        total = whole * SEG + last
        end = total if length is None else min(total, start + length)
        if start >= end:
            return
        seg = start // SEG
        skip = start - seg * SEG
        pos = start
        fh.seek(HEADER + seg * (SEG + TAG))
        while pos < end:
            final = seg == whole
            block = fh.read((last if final else SEG) + TAG)
            try:
                plain = aead.decrypt(_nonce(seg, final), block, None)
            except InvalidTag:
                raise StorageError("This file is damaged or was changed outside pupload")
            piece = plain[skip:skip + (end - pos)]
            skip = 0
            pos += len(piece)
            seg += 1
            yield piece


def encrypt_file(src: Path, dst: Path, keys: Keys) -> None:
    enc = Encryptor(keys)
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        fout.write(enc.header)
        while True:
            block = fin.read(1024 * 1024)
            if not block:
                break
            fout.write(enc.feed(block))
        fout.write(enc.finish())
    st = src.stat()
    os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns))


def decrypt_file(src: Path, dst: Path, keys: Keys) -> None:
    with open(dst, "wb") as fout:
        for piece in read_plain(src, keys):
            fout.write(piece)
    st = src.stat()
    os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns))


class Stage:
    """An encrypted upload in progress, resumable like a plain one.

    Whole segments go to `<id>.spart`; the unfinished tail (under 64 KiB) is
    sealed on its own in `<id>.stail`, so no plaintext ever touches the disk
    and the browser can resume from any byte.
    """

    def __init__(self, keys: Keys, part: Path, tail: Path, upload_id: str) -> None:
        self.keys, self.part, self.tail = keys, part, tail
        self.label = upload_id.encode("ascii")
        salt, index, pending = None, 0, b""
        if part.exists():
            with open(part, "rb") as fh:
                head = fh.read(HEADER)
            if len(head) != HEADER or head[:len(MAGIC)] != MAGIC:
                raise StorageError("The unfinished upload is damaged; start it again")
            salt = head[len(MAGIC):]
            index = (part.stat().st_size - HEADER) // (SEG + TAG)
            if tail.exists():
                pending = keys.open_stage(tail.read_bytes(), self.label)
        self.enc = Encryptor(keys, salt, index, pending)
        if salt is None:
            with open(part, "wb") as fh:
                fh.write(self.enc.header)

    @property
    def offset(self) -> int:
        return self.enc.index * SEG + len(self.enc.pending)

    def feed(self, fh, data: bytes) -> None:
        fh.write(self.enc.feed(data))

    def settle(self) -> None:
        """End of a request: keep the tail so the upload can resume. If a write
        failed half-way the staged copy is thrown away and the browser starts over."""
        try:
            size = self.part.stat().st_size
        except OSError:
            size = -1
        if size != HEADER + self.enc.index * (SEG + TAG):
            self.part.unlink(missing_ok=True)
            self.tail.unlink(missing_ok=True)
            self.enc = Encryptor(self.keys)
            return
        self.save_tail()

    def save_tail(self) -> None:
        if not self.enc.pending:
            self.tail.unlink(missing_ok=True)
            return
        tmp = self.tail.with_suffix(".tmp")
        tmp.write_bytes(self.keys.seal_stage(self.enc.pending, self.label))
        os.replace(tmp, self.tail)

    def finish(self) -> None:
        with open(self.part, "ab") as fh:
            fh.write(self.enc.finish())
        self.tail.unlink(missing_ok=True)


def staged_offset(part: Path, tail: Path) -> int:
    """How much of an encrypted upload has arrived (no key needed)."""
    if not part.exists():
        return 0
    whole = max(0, part.stat().st_size - HEADER) // (SEG + TAG)
    extra = max(0, tail.stat().st_size - 12 - TAG) if tail.exists() else 0
    return whole * SEG + extra


# ---------------------------------------------------------------------------
# The vault file: wrapped data key, never the key itself
# ---------------------------------------------------------------------------

def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def configured() -> bool:
    return VAULT_PATH.is_file()


def _read() -> Dict[str, Any]:
    try:
        return json.loads(VAULT_PATH.read_text("utf-8"))
    except (OSError, ValueError):
        raise StorageError("Secure folders are not set up")


def _write(doc: Dict[str, Any]) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = VAULT_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2), "utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, VAULT_PATH)


def _password_kek(password: str, salt: bytes, params: Dict[str, int]) -> bytes:
    secret = unicodedata.normalize("NFC", password).encode("utf-8")
    n, r, p = int(params["n"]), int(params["r"]), int(params["p"])
    return hashlib.scrypt(secret, salt=salt, n=n, r=r, p=p, maxmem=256 * r * n + 1024 * 1024, dklen=32)


def _normal_recovery(code: str) -> bytes:
    text = "".join(ch for ch in code.upper() if ch.isalnum())
    return text.replace("0", "O").replace("1", "I").replace("8", "B").encode("ascii")


def _recovery_kek(code: str, salt: bytes) -> bytes:
    return _hkdf(_normal_recovery(code), b"pupload recovery", salt=salt)


def _wrap(kek: bytes, data_key: bytes, **extra: Any) -> Dict[str, Any]:
    nonce = os.urandom(12)
    return {**extra, "nonce": _b64(nonce),
            "wrapped": _b64(AESGCM(kek).encrypt(nonce, data_key, b"pupload vault"))}


def _unwrap(kek: bytes, rec: Dict[str, Any]) -> Optional[bytes]:
    try:
        return AESGCM(kek).decrypt(_unb64(rec["nonce"]), _unb64(rec["wrapped"]), b"pupload vault")
    except (InvalidTag, KeyError, ValueError):
        return None


def _wrap_password(password: str, data_key: bytes) -> Dict[str, Any]:
    salt = os.urandom(16)
    return _wrap(_password_kek(password, salt, SCRYPT), data_key, kdf="scrypt", salt=_b64(salt), **SCRYPT)


def password_problem(password: str) -> Optional[str]:
    if len(password or "") < MIN_PASSWORD:
        return f"Use at least {MIN_PASSWORD} characters"
    if len(password) > 1024:
        return "That password is too long"
    return None


def _from_password(password: str) -> Optional[bytes]:
    rec = _read().get("password") or {}
    try:
        kek = _password_kek(password or "", _unb64(rec["salt"]), rec)
    except (KeyError, ValueError):
        return None
    return _unwrap(kek, rec)


def opens(password: str) -> bool:
    """Is this the master password?"""
    return _from_password(password) is not None


def _from_recovery(code: str) -> Optional[bytes]:
    rec = _read().get("recovery") or {}
    try:
        kek = _recovery_kek(code or "", _unb64(rec["salt"]))
    except (KeyError, ValueError):
        return None
    return _unwrap(kek, rec)


def setup(password: str, hours: int, device: str) -> Tuple[str, str, float]:
    """Create the vault and unlock it for the caller.

    Returns (recovery key, session token, expiry). The recovery key is shown once.
    """
    with _lock:
        if configured():
            raise StorageError("Secure folders are already set up")
        data_key = secrets.token_bytes(32)
        raw = secrets.token_bytes(RECOVERY_BYTES)
        code = base64.b32encode(raw).decode("ascii")
        code = "-".join(code[i:i + 4] for i in range(0, len(code), 4))
        salt = os.urandom(16)
        _write({
            "version": 1,
            "created": time.time(),
            "password": _wrap_password(password, data_key),
            "recovery": _wrap(_recovery_kek(code, salt), data_key, kdf="hkdf", salt=_b64(salt)),
        })
        token, expires = _open(data_key, hours, device)
        return code, token, expires


def unlock(password: str, hours: int, device: str) -> Optional[Tuple[str, float]]:
    """(session token, expiry), or None for a wrong password."""
    data_key = _from_password(password)
    if data_key is None:
        return None
    return _open(data_key, hours, device)


def recover(code: str, new_password: str, hours: int, device: str) -> Optional[Tuple[str, float]]:
    """Set a new password with the recovery key (which stays valid) and unlock."""
    data_key = _from_recovery(code)
    if data_key is None:
        return None
    new_wrap = _wrap_password(new_password, data_key)
    with _lock:
        doc = _read()
        doc["password"] = new_wrap
        _write(doc)
    return _open(data_key, hours, device)


def change_password(current_password: str, new_password: str) -> bool:
    data_key = _from_password(current_password)
    if data_key is None:
        return False
    new_wrap = _wrap_password(new_password, data_key)
    with _lock:
        doc = _read()
        doc["password"] = new_wrap
        _write(doc)
    return True


# ---------------------------------------------------------------------------
# Sessions: which browsers have unlocked, and for how long
# ---------------------------------------------------------------------------

def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "ignore")).hexdigest()


def open_session(data_key: bytes, hours: int, device: str) -> Tuple[str, float]:
    """Unlock with a data key unwrapped elsewhere (a full remote sign-in)."""
    return _open(data_key, hours, device)


def _open(data_key: bytes, hours: int, device: str) -> Tuple[str, float]:
    """Load the key (if it is not already) and start a session, in one step so a
    concurrent prune can never drop the key in between."""
    global _keys
    token = secrets.token_urlsafe(32)
    now = time.time()
    expires = now + max(1, int(hours)) * 3600
    with _lock:
        if _keys is None:
            _keys = Keys(data_key)
        _sessions[_digest(token)] = {"created": now, "expires": expires, "device": device}
    return token, expires


def _wipe() -> None:
    global _keys
    _keys = None
    _thumbs.clear()


def prune() -> None:
    """Forget expired sessions; with none left, drop the key from memory."""
    now = time.time()
    with _lock:
        for key in [k for k, s in _sessions.items() if s["expires"] <= now]:
            del _sessions[key]
        if not _sessions:
            _wipe()


def session(token: Optional[str]) -> Optional[Dict[str, Any]]:
    if not token or _keys is None:
        return None
    with _lock:
        found = _sessions.get(_digest(token))
        if found is None:
            return None
        if found["expires"] <= time.time():
            prune()
            return None
        return found


def end_session(token: Optional[str]) -> None:
    with _lock:
        if token:
            _sessions.pop(_digest(token), None)
        if not _sessions:
            _wipe()


def lock_everywhere() -> None:
    with _lock:
        _sessions.clear()
        _wipe()


def status(token: Optional[str]) -> Dict[str, Any]:
    if HIDDEN.get():
        return {"available": AVAILABLE, "configured": False, "unlocked": False, "expires": None,
                "hours": config.get("vault_hours"), "hidden": True}
    found = session(token)
    return {
        "available": AVAILABLE,
        "configured": configured(),
        "unlocked": found is not None,
        "expires": found["expires"] if found else None,
        "hours": config.get("vault_hours"),
    }


# ---------------------------------------------------------------------------
# Guessing protection: scrypt makes each try slow, this makes many tries slower
# ---------------------------------------------------------------------------

FREE_TRIES = 5


def throttled(ip: str) -> int:
    """Seconds this address must wait before trying another password."""
    with _lock:
        count, last = _failures.get(ip, (0, 0.0))
    if count < FREE_TRIES:
        return 0
    left = last + min(15 * 60, 5 * 2 ** (count - FREE_TRIES)) - time.time()
    return int(left) + 1 if left > 0 else 0


def note_failure(ip: str) -> None:
    with _lock:
        count, _ = _failures.get(ip, (0, 0.0))
        _failures[ip] = (count + 1, time.time())


def note_success(ip: str) -> None:
    with _lock:
        _failures.pop(ip, None)


# ---------------------------------------------------------------------------
# Thumbnails of secure images are kept in memory only, never on disk
# ---------------------------------------------------------------------------

def thumb_get(key: str) -> Optional[bytes]:
    with _lock:
        data = _thumbs.get(key)
        if data is not None:
            _thumbs.move_to_end(key)
        return data


def thumb_put(key: str, data: bytes) -> None:
    with _lock:
        if _keys is None:
            return
        _thumbs[key] = data
        while len(_thumbs) > THUMB_CACHE:
            _thumbs.popitem(last=False)
