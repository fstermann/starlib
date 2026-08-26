"""SoundCloud track-station endpoints.

A *track station* is SoundCloud's endless related-tracks stream seeded from a
single track (web URL ``/discover/sets/track-stations:<track_id>``). The web
station queue is built from the track's related tracks, which api-v2 exposes at
``/tracks/{id}/related``. Like the Mixes, this reads from the internal
``api-v2.soundcloud.com`` and requires the web-session ``oauth_token`` cookie;
if it isn't configured every endpoint here returns 404 so the frontend can hide
the feature.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Path

from backend.api.soundcloud.api_v2 import api_v2_get, oauth_token_or_404
from backend.schemas.soundcloud import StationTracksResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud/stations", tags=["soundcloud"])

# Enough to fill a station view without paginating.
_LIMIT = 50


@router.get("/{seed_track_id}/tracks", response_model=StationTracksResponse)
async def get_station_tracks(
    seed_track_id: int = Path(..., description="Numeric id of the seed track"),
) -> StationTracksResponse:
    """Return the track-station stream seeded by ``seed_track_id``.

    Reads api-v2 ``/tracks/{id}/related`` — the same related-tracks feed the
    web station queue is built from — and returns the full Track payloads in
    the order api-v2 gives them.
    """
    token = oauth_token_or_404()

    data = await api_v2_get(f"/tracks/{seed_track_id}/related", token, limit=_LIMIT)
    collection = data.get("collection") if isinstance(data, dict) else data
    tracks: list[dict[str, Any]] = [t for t in (collection or []) if isinstance(t, dict)]
    return StationTracksResponse(title=None, tracks=tracks)
