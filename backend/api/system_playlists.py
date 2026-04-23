"""SoundCloud system playlist endpoints.

Exposes the user's generated mixes (Weekly Wave, Daily Drops, Your Mix 1..N)
to the frontend. These live exclusively on SoundCloud's internal
``api-v2.soundcloud.com``; the public API does not index them. Access
requires the web-session ``oauth_token`` cookie, which the desktop shell
captures via :func:`backend.api.auth.save_session_cookie`.

If no ``OAUTH_TOKEN`` is configured, every endpoint here returns 404 so
the frontend can cleanly hide the "Mixes" section.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Path, status
from pydantic import BaseModel

from backend.api.setup import read_config, write_config
from soundcloud_tools.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/soundcloud/system-playlists", tags=["soundcloud"])

_API_V2 = "https://api-v2.soundcloud.com"
_HTTP_TIMEOUT = 15.0

# Only surface mixes the user actually recognizes as "their" playlists.
# ``mixed-selections`` returns a superset; we whitelist the two selections
# that map to the official personalized-playlist surface on web/mobile.
_SELECTION_URNS = (
    "soundcloud:selections:made-for-you",  # Weekly Wave, Daily Drops
    "soundcloud:selections:your-moods",  # Your Mix 1..10
)


class SystemPlaylistSummary(BaseModel):
    """Slim representation of a system playlist for tree display."""

    urn: str
    title: str
    short_title: str | None = None
    description: str | None = None
    artwork_url: str | None = None
    track_count: int
    last_updated: str | None = None
    permalink_url: str | None = None
    # Numeric track ids — the frontend hydrates these lazily via /tracks.
    track_ids: list[int]


class SystemPlaylistsResponse(BaseModel):
    playlists: list[SystemPlaylistSummary]


class SystemPlaylistTracksResponse(BaseModel):
    tracks: list[dict[str, Any]]


def _oauth_token_or_404() -> str:
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


def _clear_oauth_token() -> None:
    """Remove ``OAUTH_TOKEN`` from config.env after an api-v2 401.

    Keeps the frontend from retrying against a dead token on every page
    load; the user will see the "Reconnect for Mixes" CTA until the login
    flow runs again.
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


async def _api_v2_get(path: str, token: str, **params: Any) -> dict[str, Any]:
    """GET ``/path`` on api-v2 with the session cookie as an OAuth header."""
    url = f"{_API_V2}{path}"
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        resp = await client.get(
            url,
            params=params or None,
            headers={"Authorization": f"OAuth {token}"},
        )
    if resp.status_code == 401:
        _clear_oauth_token()
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
    token = _oauth_token_or_404()
    data = await _api_v2_get("/mixed-selections", token, limit=50)

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
    token = _oauth_token_or_404()
    if not urn.startswith("soundcloud:system-playlists:"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="urn must be a soundcloud:system-playlists: URN",
        )

    sp = await _api_v2_get(f"/system-playlists/{urn}", token)
    slim_tracks = sp.get("tracks") or []
    ids = [t["id"] for t in slim_tracks if isinstance(t, dict) and isinstance(t.get("id"), int)]
    if not ids:
        return SystemPlaylistTracksResponse(tracks=[])

    # api-v2 /tracks tolerates ~50 ids per request; our mixes cap at 30 so
    # a single call always suffices.
    ids_param = ",".join(str(i) for i in ids)
    hydrated = await _api_v2_get("/tracks", token, ids=ids_param)
    tracks = hydrated if isinstance(hydrated, list) else hydrated.get("collection") or []

    # Preserve the order api-v2 returned on the system-playlist resource —
    # /tracks?ids re-orders by numeric id, which would shuffle the mix.
    by_id = {t["id"]: t for t in tracks if isinstance(t, dict) and isinstance(t.get("id"), int)}
    ordered = [by_id[i] for i in ids if i in by_id]
    return SystemPlaylistTracksResponse(tracks=ordered)
