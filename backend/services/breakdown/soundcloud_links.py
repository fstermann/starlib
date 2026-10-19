"""Link Shazam-recognised breakdown tracks to their SoundCloud upload.

A Shazam match carries no track length, so the timeline can't size the band.
Searching SoundCloud for title + artist and storing the matched upload's id,
permalink and duration fixes that, and lets the align dialog stream it.
Tracks that arrive already linked, such as from a CUE sheet whose files carry
a SoundCloud id, only need their artwork and duration fetched.
"""

from __future__ import annotations

import asyncio
import logging

from backend.domain.track_matching import pick_soundcloud_match, search_query
from backend.infra.breakdown import db
from backend.infra.soundcloud import client, token_cache
from backend.infra.soundcloud.oauth import OAuthManager
from backend.infra.soundcloud.settings import get_settings

logger = logging.getLogger(__name__)

_CONCURRENCY = 4
# DJ-tracklist name for an unidentified title or artist; searching for it only finds noise.
UNKNOWN_TITLE = "ID"


def _token() -> str | None:
    settings = get_settings()
    if not settings.has_oauth_credentials():
        return None
    try:
        return token_cache.get_cached_access_token(settings, OAuthManager)
    except Exception:
        logger.exception("breakdown: no SoundCloud token for track linking")
        return None


def _full_length_s(upload: dict) -> float | None:
    """The upload's length, unless SoundCloud only serves a preview, whose length is the snippet's."""
    duration_ms = upload.get("duration")
    if upload.get("access") == "preview" or not isinstance(duration_ms, int | float):
        return None
    return duration_ms / 1000


async def _link(job_id: str, track: db.TrackRow, token: str, gate: asyncio.Semaphore) -> bool:
    if not track.title:
        return False
    async with gate:
        results = await client.search_tracks(search_query(track.title, track.artist), token=token)
    match = pick_soundcloud_match(track.title, track.artist, results)
    if match is None or not isinstance(match.get("id"), int):
        return False
    return db.update_track(
        job_id,
        track.id,
        soundcloud_id=match["id"],
        soundcloud_permalink_url=match.get("permalink_url"),
        duration_s=track.duration_s or _full_length_s(match),
        artwork_url=track.artwork_url or match.get("artwork_url"),
    )


async def _fill_details(job_id: str, track: db.TrackRow, token: str, gate: asyncio.Semaphore) -> bool:
    assert track.soundcloud_id is not None
    async with gate:
        found = await client.get_track(track.soundcloud_id, token=token)
    if found is None:
        return False
    return db.update_track(
        job_id,
        track.id,
        soundcloud_permalink_url=track.soundcloud_permalink_url or found.get("permalink_url"),
        duration_s=track.duration_s or _full_length_s(found),
        artwork_url=track.artwork_url or found.get("artwork_url"),
    )


async def link_track(job_id: str, track_id: int) -> int | None:
    """Link one track to its SoundCloud upload, searching if it has no link.

    Args:
        job_id: Breakdown job.
        track_id: Track row to link.

    Returns:
        The linked SoundCloud id, or ``None`` when nothing matched.
    """
    track = next((t for t in db.list_tracks(job_id) if t.id == track_id), None)
    if track is None:
        return None
    if track.soundcloud_id is not None:
        return track.soundcloud_id
    if track.unreleased or UNKNOWN_TITLE in (track.title, track.artist):
        return None
    token = _token()
    if token is None or not await _link(job_id, track, token, asyncio.Semaphore(1)):
        return None
    return next(t.soundcloud_id for t in db.list_tracks(job_id) if t.id == track_id)


async def link_unlinked_tracks(job_id: str) -> int:
    """Search SoundCloud for every track without a link and store matches.

    Rows that have a known duration, or that are unreleased or have an
    unknown ("ID") title or artist are not searched. Rows already linked but
    missing artwork or duration get those from their upload. No-op without
    SoundCloud API credentials.

    Args:
        job_id: Breakdown job whose tracks to link.

    Returns:
        Number of tracks that were linked or filled in.
    """
    tracks = db.list_tracks(job_id)
    pending = [
        t
        for t in tracks
        if t.soundcloud_id is None
        and t.duration_s is None
        and not t.unreleased
        and UNKNOWN_TITLE not in (t.title, t.artist)
    ]
    incomplete = [t for t in tracks if t.soundcloud_id is not None and (t.artwork_url is None or t.duration_s is None)]
    if not pending and not incomplete:
        return 0
    token = _token()
    if token is None:
        return 0
    gate = asyncio.Semaphore(_CONCURRENCY)
    done = await asyncio.gather(
        *(_link(job_id, t, token, gate) for t in pending),
        *(_fill_details(job_id, t, token, gate) for t in incomplete),
    )
    return sum(done)
