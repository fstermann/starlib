"""Shared helpers for SoundCloud ``api-v2.soundcloud.com`` access.

Both the Mixes (system-playlist) and track-station endpoints read from
SoundCloud's internal api-v2, which the public API does not index. Access
requires the web-session ``oauth_token`` cookie captured during login. These
helpers centralize token gating and the 401 handling so each endpoint module
doesn't duplicate it.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, status

from backend.api.setup import read_config, write_config
from backend.infra.soundcloud import client
from backend.infra.soundcloud.settings import get_settings

logger = logging.getLogger(__name__)

_API_V2 = client.API_V2_BASE


def oauth_token_or_404() -> str:
    """Return the configured web-session token, or raise 404.

    404 rather than 401/403 because the absence of the token means the
    *feature* is unavailable on this install — not that a request was
    unauthorized. The frontend uses 404 to hide the section entirely.
    """
    tok = get_settings().oauth_token
    if not tok:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="SoundCloud session cookie not configured",
        )
    return tok


def clear_oauth_token() -> None:
    """Remove ``OAUTH_TOKEN`` from config.env after an api-v2 401.

    Keeps the frontend from retrying against a dead token on every page
    load; the user will see the "Reconnect" CTA until the login flow runs
    again.
    """
    try:
        cfg = read_config()
        if "OAUTH_TOKEN" in cfg:
            del cfg["OAUTH_TOKEN"]
            write_config(cfg)
            get_settings.cache_clear()
            logger.info("Cleared expired SoundCloud session cookie")
    except OSError:
        logger.exception("Failed to clear OAUTH_TOKEN from config")


async def api_v2_get(path: str, token: str, **params: Any) -> dict[str, Any]:
    """GET ``/path`` on api-v2 with the session cookie as an OAuth header."""
    url = f"{_API_V2}{path}"
    resp = await client.get(url, token=token, params=params or None, accept_json=False)
    if resp.status_code == 401:
        clear_oauth_token()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SoundCloud session expired; reconnect required",
        )
    if resp.status_code >= 400:
        logger.warning("api-v2 %s failed: %s %s", path, resp.status_code, resp.text[:300])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud api-v2 error: {resp.status_code}",
        )
    return resp.json()
