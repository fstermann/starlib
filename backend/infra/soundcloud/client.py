"""HTTP transport for the SoundCloud APIs.

One place that knows how to talk to SoundCloud over HTTP: the timeout, the
``Authorization: OAuth <token>`` header shape, and the two base URLs. Both
``api.soundcloud.com`` (public API, Client-Credentials tokens) and
``api-v2.soundcloud.com`` (web API, session token) go through here.

Deliberately *not* handled here: mapping upstream status codes to
``HTTPException``. What a 401 or 404 means to the caller differs per endpoint
— a missing session token hides a whole UI section, an expired user token is a
re-auth prompt — so that stays in the routers.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

# Client-Credentials OAuth tokens are rejected by api-v2.soundcloud.com; the
# public API at api.soundcloud.com accepts them.
PUBLIC_API_BASE = "https://api.soundcloud.com"
API_V2_BASE = "https://api-v2.soundcloud.com"

# HTTP timeout for upstream SoundCloud calls. Overridable via env var for ops.
TIMEOUT_SECONDS: float = float(os.environ.get("STARLIB_SC_HTTP_TIMEOUT", "15"))

# One client for the process, so connections (and their TLS handshakes) are
# reused across calls. Building a fresh AsyncClient per request throws the
# pool away every time and makes every call pay a new handshake.
_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    """Return the shared client, creating it on first use."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
    return _client


async def close_client() -> None:
    """Close the shared client. Called on application shutdown."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def _headers(token: str, *, accept_json: bool) -> dict[str, str]:
    headers = {"Authorization": f"OAuth {token}"}
    if accept_json:
        headers["Accept"] = "application/json"
    return headers


async def request(
    method: str,
    url: str,
    *,
    token: str,
    params: dict[str, Any] | None = None,
    follow_redirects: bool = False,
    accept_json: bool = True,
) -> httpx.Response:
    """Send an authenticated request to SoundCloud and return the raw response.

    Uses only the ``Authorization: OAuth <token>`` header — deliberately omits
    the web-client ``client_id``/``app_version`` query params, because the
    public API drops the Authorization header and returns 401 when those are
    present.
    """
    return await get_client().request(
        method,
        url,
        params=params or None,
        headers=_headers(token, accept_json=accept_json),
        follow_redirects=follow_redirects,
    )


async def get(
    url: str,
    *,
    token: str,
    params: dict[str, Any] | None = None,
    follow_redirects: bool = False,
    accept_json: bool = True,
) -> httpx.Response:
    """GET helper over :func:`request`."""
    return await request(
        "GET",
        url,
        token=token,
        params=params,
        follow_redirects=follow_redirects,
        accept_json=accept_json,
    )
