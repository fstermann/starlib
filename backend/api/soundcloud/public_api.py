"""Shared helpers for the public SoundCloud API at ``api.soundcloud.com``.

The public API authenticates with the app's Client-Credentials token. Its
Track payloads carry ``bpm`` and ``key_signature``, which api-v2 omits, so
endpoints that discover tracks on api-v2 hydrate them here.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, status

from backend.infra.soundcloud import client, token_cache
from backend.infra.soundcloud.oauth import OAuthManager
from backend.infra.soundcloud.settings import get_settings

logger = logging.getLogger(__name__)

# The public /tracks endpoint returns at most 50 tracks per request.
_HYDRATE_BATCH = 50
# Without this the public API silently drops preview-only and blocked tracks.
_ANY_ACCESS = "playable,preview,blocked"


def public_api_token() -> str:
    """Return a Client-Credentials token for the public SoundCloud API."""
    settings = get_settings()
    if not settings.has_oauth_credentials():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud OAuth credentials not configured",
        )
    try:
        return token_cache.get_cached_access_token(settings, OAuthManager)
    except Exception as exc:
        logger.exception("Failed to acquire SoundCloud OAuth token")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud auth unavailable",
        ) from exc


async def hydrate_tracks(ids: list[int]) -> dict[int, dict[str, Any]]:
    """Fetch full public-API Track payloads for ``ids``, keyed by id."""
    token = public_api_token()
    by_id: dict[int, dict[str, Any]] = {}
    for start in range(0, len(ids), _HYDRATE_BATCH):
        batch = ids[start : start + _HYDRATE_BATCH]
        response = await client.get(
            f"{client.PUBLIC_API_BASE}/tracks",
            token=token,
            params={
                "urns": ",".join(f"soundcloud:tracks:{i}" for i in batch),
                "access": _ANY_ACCESS,
                "limit": _HYDRATE_BATCH,
            },
        )
        if response.status_code != 200:
            logger.warning("SoundCloud public /tracks returned %s", response.status_code)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="SoundCloud upstream error",
            )
        data = response.json()
        tracks = data if isinstance(data, list) else data.get("collection") or []
        by_id.update({t["id"]: t for t in tracks if isinstance(t, dict) and isinstance(t.get("id"), int)})
    return by_id
