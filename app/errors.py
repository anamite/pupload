"""Errors the HTTP layer turns into 4xx replies."""
from __future__ import annotations

from typing import Optional


class StorageError(Exception):
    """Something the user should see as a 4xx."""

    status: Optional[int] = None   # None: the route picks the status


class NotFound(StorageError):
    """Missing, or a secure folder this request must not even know about."""

    status = 404

    def __init__(self, message: str = "Not found") -> None:
        super().__init__(message)


class VaultLocked(StorageError):
    """The request needs secure folders unlocked on this device."""

    status = 423

    def __init__(self, message: str = "Unlock secure folders first") -> None:
        super().__init__(message)
