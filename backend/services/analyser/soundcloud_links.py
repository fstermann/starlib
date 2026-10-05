"""Link Shazam-recognised analyser tracks to their SoundCloud upload.

A Shazam match carries no track length, so the timeline can't size the band.
Searching SoundCloud for title + artist and storing the matched upload's id,
permalink and duration fixes that, and lets the align dialog stream it.
"""

from __future__ import annotations

import asyncio
import logging

from backend.domain.track_matching import pick_soundcloud_match, search_query
from backend.infra.analyser import db
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
        logger.exception("analyser: no SoundCloud token for track linking")
        return None


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
        duration_s=match["duration"] / 1000,
        artwork_url=track.artwork_url or match.get("artwork_url"),
    )


async def link_unlinked_tracks(job_id: str) -> int:
    """Search SoundCloud for every track without a link and store matches.

    Rows the user already linked, that have a known duration, or that are
    unreleased or have an unknown ("ID") title or artist are left alone. No-op without SoundCloud API credentials.

    Args:
        job_id: Analyser job whose tracks to link.

    Returns:
        Number of tracks that were linked.
    """
    pending = [
        t
        for t in db.list_tracks(job_id)
        if t.soundcloud_id is None
        and t.duration_s is None
        and not t.unreleased
        and UNKNOWN_TITLE not in (t.title, t.artist)
    ]
    if not pending:
        return 0
    token = _token()
    if token is None:
        return 0
    gate = asyncio.Semaphore(_CONCURRENCY)
    linked = await asyncio.gather(*(_link(job_id, t, token, gate) for t in pending))
    return sum(linked)
