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
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        return await client.request(
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
