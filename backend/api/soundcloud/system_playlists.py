"""SoundCloud system playlist endpoints.

Exposes the user's generated mixes (Weekly Wave, Daily Drops, Your Mix 1..N)
to the frontend. These live exclusively on SoundCloud's internal
``api-v2.soundcloud.com``; the public API does not index them. Access
requires the web-session ``oauth_token`` cookie, which the desktop shell
captures via :func:`backend.api.soundcloud.auth.save_session_cookie`.

If no ``OAUTH_TOKEN`` is configured, every endpoint here returns 404 so
the frontend can cleanly hide the "Mixes" section.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Path, status

from backend.api.soundcloud.api_v2 import api_v2_get, oauth_token_or_404
from backend.schemas.soundcloud import SystemPlaylistsResponse, SystemPlaylistSummary, SystemPlaylistTracksResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud/system-playlists", tags=["soundcloud"])

# Only surface mixes the user actually recognizes as "their" playlists.
# ``mixed-selections`` returns a superset; we whitelist the two selections
# that map to the official personalized-playlist surface on web/mobile.
_SELECTION_URNS = (
    "soundcloud:selections:made-for-you",  # Weekly Wave, Daily Drops
    "soundcloud:selections:your-moods",  # Your Mix 1..10
)


def _to_summary(sp: dict[str, Any]) -> SystemPlaylistSummary | None:
    """Normalize an api-v2 system-playlist payload to our summary shape.

    Returns ``None`` if the payload is malformed enough to skip (defensive
    against api-v2 schema drift — one broken playlist shouldn't 500 the
    whole list).
    """
    urn = sp.get("urn")
    title = sp.get("title")
    if not urn or not title:
        return None
    tracks = sp.get("tracks") or []
    track_ids = [t["id"] for t in tracks if isinstance(t, dict) and isinstance(t.get("id"), int)]
    return SystemPlaylistSummary(
        urn=urn,
        title=title,
        short_title=sp.get("short_title"),
        description=sp.get("description"),
        artwork_url=sp.get("calculated_artwork_url") or sp.get("artwork_url"),
        track_count=len(track_ids),
        last_updated=sp.get("last_updated"),
        permalink_url=sp.get("permalink_url"),
        track_ids=track_ids,
    )


@router.get("", response_model=SystemPlaylistsResponse)
async def list_system_playlists() -> SystemPlaylistsResponse:
    """Return the user's system playlists in a stable display order.

    One api-v2 call (``/mixed-selections``) bootstraps every mix with
    inline slim tracks; track hydration is deferred to per-playlist fetch.
    """
    token = oauth_token_or_404()
    data = await api_v2_get("/mixed-selections", token, limit=50)

    playlists: list[SystemPlaylistSummary] = []
    for selection in data.get("collection") or []:
        if selection.get("urn") not in _SELECTION_URNS:
            continue
        items = (selection.get("items") or {}).get("collection") or []
        for item in items:
            sp = item.get("system_playlist") or item
            if not isinstance(sp, dict):
                continue
            summary = _to_summary(sp)
            if summary is not None:
                playlists.append(summary)
    return SystemPlaylistsResponse(playlists=playlists)


@router.get("/{urn:path}/tracks", response_model=SystemPlaylistTracksResponse)
async def get_system_playlist_tracks(
    urn: str = Path(..., description="System playlist URN, e.g. soundcloud:system-playlists:weekly:123"),
) -> SystemPlaylistTracksResponse:
    """Hydrate a system playlist's tracks to full Track payloads.

    api-v2 returns slim tracks on the system-playlist resource itself;
    we ``/tracks?ids=...`` to get full metadata (title, artwork, user).
    """
    token = oauth_token_or_404()
    if not urn.startswith("soundcloud:system-playlists:"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="urn must be a soundcloud:system-playlists: URN",
        )

    sp = await api_v2_get(f"/system-playlists/{urn}", token)
    slim_tracks = sp.get("tracks") or []
    ids = [t["id"] for t in slim_tracks if isinstance(t, dict) and isinstance(t.get("id"), int)]
    if not ids:
        return SystemPlaylistTracksResponse(tracks=[])

    # api-v2 /tracks tolerates ~50 ids per request; our mixes cap at 30 so
    # a single call always suffices.
    ids_param = ",".join(str(i) for i in ids)
    hydrated = await api_v2_get("/tracks", token, ids=ids_param)
    tracks = hydrated if isinstance(hydrated, list) else hydrated.get("collection") or []

    # Preserve the order api-v2 returned on the system-playlist resource —
    # /tracks?ids re-orders by numeric id, which would shuffle the mix.
    by_id = {t["id"]: t for t in tracks if isinstance(t, dict) and isinstance(t.get("id"), int)}
    ordered = [by_id[i] for i in ids if i in by_id]
    return SystemPlaylistTracksResponse(tracks=ordered)
