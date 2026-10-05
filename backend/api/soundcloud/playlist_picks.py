"""Playlist-picks endpoint: tracks that share many playlists with a seed track.

SoundCloud's track page lists the public playlists a track is in. Tracks that
recur across many of those playlists are likely a good match for the seed, so
this endpoint scans those playlists and ranks their tracks by occurrence
count. The reverse lookup only exists on api-v2, so it needs the web-session
token (like Mixes) and returns 404 without it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Path, status

from backend.api.soundcloud.api_v2 import api_v2_get, oauth_token_or_404
from backend.domain.playlist_picks import rank_by_playlist_occurrence
from backend.schemas.soundcloud import PlaylistPick, PlaylistPicksResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud/playlist-picks", tags=["soundcloud"])

_MAX_PLAYLISTS = 50
_MAX_PICKS = 100
_CONCURRENCY = 8
# api-v2 /tracks tolerates ~50 ids per request.
_HYDRATE_BATCH = 50


def _ids(items: Any) -> list[int]:
    return [t["id"] for t in items or [] if isinstance(t, dict) and isinstance(t.get("id"), int)]


async def _playlist_track_ids(playlist_id: int, token: str, gate: asyncio.Semaphore) -> list[int]:
    """Return a playlist's track ids, or ``[]`` if it can't be read."""
    async with gate:
        try:
            playlist = await api_v2_get(f"/playlists/{playlist_id}", token)
        except HTTPException as exc:
            if exc.status_code == status.HTTP_401_UNAUTHORIZED:
                raise
            logger.info("Skipping unreadable playlist %s", playlist_id)
            return []
    return _ids(playlist.get("tracks"))


async def _hydrate(ids: list[int], token: str) -> dict[int, dict[str, Any]]:
    """Fetch full Track payloads for ``ids``, keyed by id."""
    by_id: dict[int, dict[str, Any]] = {}
    for start in range(0, len(ids), _HYDRATE_BATCH):
        batch = ids[start : start + _HYDRATE_BATCH]
        data = await api_v2_get("/tracks", token, ids=",".join(str(i) for i in batch))
        tracks = data if isinstance(data, list) else data.get("collection") or []
        by_id.update({t["id"]: t for t in tracks if isinstance(t, dict) and isinstance(t.get("id"), int)})
    return by_id


@router.get("/{seed_track_id}", response_model=PlaylistPicksResponse)
async def get_playlist_picks(
    seed_track_id: int = Path(..., description="Numeric id of the seed track"),
) -> PlaylistPicksResponse:
    """Rank tracks from the public playlists containing ``seed_track_id``.

    Scans up to 50 playlists and returns up to 100 tracks, most frequent first.
    """
    token = oauth_token_or_404()
    listing = await api_v2_get(
        f"/tracks/{seed_track_id}/playlists_without_albums",
        token,
        limit=_MAX_PLAYLISTS,
        representation="mini",
    )
    playlist_ids = _ids(listing.get("collection"))[:_MAX_PLAYLISTS]

    gate = asyncio.Semaphore(_CONCURRENCY)
    playlists = await asyncio.gather(*(_playlist_track_ids(pid, token, gate) for pid in playlist_ids))
    ranked = rank_by_playlist_occurrence(playlists, exclude=seed_track_id, limit=_MAX_PICKS)

    tracks = await _hydrate([track_id for track_id, _ in ranked], token)
    picks = [PlaylistPick(count=count, track=tracks[tid]) for tid, count in ranked if tid in tracks]
    return PlaylistPicksResponse(playlist_count=len(playlist_ids), picks=picks)
