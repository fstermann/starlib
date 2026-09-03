"""SoundCloud track-station endpoints.

A *track station* is SoundCloud's endless related-tracks stream seeded from a
single track (web URL ``/discover/sets/track-stations:<track_id>``). SoundCloud
exposes the related-tracks feed through its public API, so stations use the
app's Client-Credentials token rather than the private api-v2 web session.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Path, status

from backend.infra.soundcloud import client, token_cache
from backend.infra.soundcloud.oauth import OAuthManager
from backend.infra.soundcloud.settings import get_settings
from backend.schemas.soundcloud import StationTracksResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud/stations", tags=["soundcloud"])

# Enough to fill a station view without paginating.
_LIMIT = 50


def _public_api_token() -> str:
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


@router.get("/{seed_track_id}/tracks", response_model=StationTracksResponse)
async def get_station_tracks(
    seed_track_id: int = Path(..., description="Numeric id of the seed track"),
) -> StationTracksResponse:
    """Return the track-station stream seeded by ``seed_track_id``.

    Reads the documented public ``/tracks/{track_urn}/related`` endpoint and
    returns the full Track payloads in SoundCloud's order.
    """
    token = _public_api_token()
    track_urn = f"soundcloud:tracks:{seed_track_id}"
    url = f"{client.PUBLIC_API_BASE}/tracks/{track_urn}/related"

    try:
        response = await client.get(
            url,
            token=token,
            params={"limit": _LIMIT, "linked_partitioning": True},
        )
    except Exception as exc:  # pragma: no cover - network transport
        logger.exception("SoundCloud related-tracks request failed for %s", track_urn)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud upstream error",
        ) from exc

    if response.status_code == 404:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="SoundCloud track not found",
        )
    if response.status_code != 200:
        logger.warning(
            "SoundCloud /tracks/%s/related returned %s",
            track_urn,
            response.status_code,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud returned {response.status_code}",
        )

    data = response.json()
    collection = data.get("collection") if isinstance(data, dict) else data
    tracks: list[dict[str, Any]] = [t for t in (collection or []) if isinstance(t, dict)]
    return StationTracksResponse(title=None, tracks=tracks)
