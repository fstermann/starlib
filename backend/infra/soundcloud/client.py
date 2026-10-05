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

import asyncio
import os
from typing import Any

import httpx

# Client-Credentials OAuth tokens are rejected by api-v2.soundcloud.com; the
# public API at api.soundcloud.com accepts them.
PUBLIC_API_BASE = "https://api.soundcloud.com"
API_V2_BASE = "https://api-v2.soundcloud.com"

# HTTP timeout for upstream SoundCloud calls. Overridable via env var for ops.
TIMEOUT_SECONDS: float = float(os.environ.get("STARLIB_SC_HTTP_TIMEOUT", "15"))

# One client per event loop, so connections (and their TLS handshakes) are
# reused across calls. Building a fresh AsyncClient per request throws the
# pool away every time and makes every call pay a new handshake.
#
# The client is keyed on the running loop, not just cached: its pooled
# connections are bound to the loop that opened them, so handing a client from
# a finished loop to a new one raises "Event loop is closed". The app has a
# single long-lived loop; tests and scripts do not.
_client: httpx.AsyncClient | None = None
_client_loop: asyncio.AbstractEventLoop | None = None


def get_client() -> httpx.AsyncClient:
    """Return the shared client for the running loop, creating it on first use."""
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client.is_closed or _client_loop is not loop:
        _client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
        _client_loop = loop
    return _client


async def close_client() -> None:
    """Close the shared client. Called on application shutdown."""
    global _client, _client_loop
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None
    _client_loop = None


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


async def search_tracks(query: str, *, token: str, limit: int = 10) -> list[dict[str, Any]]:
    """Return public-API ``/tracks`` search results, or ``[]`` on any failure."""
    try:
        response = await get(f"{PUBLIC_API_BASE}/tracks", token=token, params={"q": query, "limit": limit})
    except httpx.HTTPError:
        return []
    if response.status_code != 200:
        return []
    data = response.json()
    collection = data.get("collection") if isinstance(data, dict) else data
    return [t for t in collection or [] if isinstance(t, dict)]


async def get_track_bpm(track_id: int, *, token: str) -> float | None:
    """Return the tempo SoundCloud lists for a track, or ``None`` if unset or unreachable."""
    try:
        response = await get(f"{PUBLIC_API_BASE}/tracks/{track_id}", token=token, follow_redirects=True)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    bpm = response.json().get("bpm")
    return float(bpm) if isinstance(bpm, int | float) and bpm > 0 else None
