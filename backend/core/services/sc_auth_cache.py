"""Module-level TTL cache for SoundCloud Client-Credentials OAuth tokens.

``OAuthManager.get_access_token()`` hits disk (and occasionally the network)
on every call. The stream-URL and BPM endpoints both need the same token on
hot paths, so we memoize it here with a conservative TTL.

Tokens from SoundCloud typically live ~1 hour; we default to 55 minutes and
force a refresh 5 minutes before the cached deadline.

Callers pass in the ``settings`` object and the ``OAuthManager`` class so
individual modules can monkeypatch those in their own namespaces (tests
already do this on ``backend.api.soundcloud``).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Protocol

logger = logging.getLogger(__name__)

_DEFAULT_TTL_SECONDS = 55 * 60
_REFRESH_BUFFER_SECONDS = 5 * 60

_lock = threading.Lock()
_token: str | None = None
_expires_at: float = 0.0


class _OAuthManagerLike(Protocol):
    """Structural type for ``OAuthManager`` — only the bits we use."""

    def __init__(self, client_id: str, client_secret: str) -> None: ...

    def get_access_token(self) -> str: ...


def get_cached_access_token(
    settings: Any,
    oauth_manager_cls: type[_OAuthManagerLike],
    *,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> str:
    """Return a cached Client-Credentials access token, refreshing as needed.

    Parameters
    ----------
    settings : Any
        Object exposing ``client_id``, ``client_secret``, and
        ``has_oauth_credentials()``.
    oauth_manager_cls : type
        The ``OAuthManager`` class to instantiate on miss.
    ttl_seconds : int
        Max time to trust a cached token. Refreshed 5 min before expiry.

    Returns
    -------
    str
        A valid access token suitable for ``Authorization: OAuth <token>``.

    Raises
    ------
    RuntimeError
        If no SoundCloud OAuth credentials are configured.
    """
    global _token, _expires_at

    now = time.time()
    with _lock:
        if _token is not None and _expires_at - now > _REFRESH_BUFFER_SECONDS:
            return _token

        if not settings.has_oauth_credentials():
            raise RuntimeError("SoundCloud OAuth credentials not configured")

        token = oauth_manager_cls(settings.client_id, settings.client_secret).get_access_token()
        _token = token
        _expires_at = now + ttl_seconds
        return token


def reset_cache() -> None:
    """Clear the cached token. Intended for tests."""
    global _token, _expires_at
    with _lock:
        _token = None
        _expires_at = 0.0
