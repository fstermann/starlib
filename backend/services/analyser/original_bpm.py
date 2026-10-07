"""Tempo of an original SoundCloud track, from the most trusted source."""

from __future__ import annotations

import logging
from typing import Literal

import httpx

from backend.infra import cache as db_cache
from backend.infra.soundcloud import client, token_cache
from backend.infra.soundcloud.oauth import OAuthManager
from backend.infra.soundcloud.settings import get_settings

logger = logging.getLogger(__name__)

BpmSource = Literal["corrected", "soundcloud", "detected"]

# A listed tempo never changes, so one lookup per track per run is enough.
_listed: dict[int, float | None] = {}


async def listed_bpm(soundcloud_id: int) -> float | None:
    """The tempo SoundCloud lists for the track, cached for the process."""
    if soundcloud_id in _listed:
        return _listed[soundcloud_id]
    settings = get_settings()
    if not settings.has_oauth_credentials():
        return None
    try:
        token = token_cache.get_cached_access_token(settings, OAuthManager)
    except Exception:
        logger.exception("analyser: no SoundCloud token for the listed BPM")
        return None
    try:
        bpm = await client.get_track_bpm(soundcloud_id, token=token)
    except httpx.HTTPError:
        logger.warning("analyser: SoundCloud BPM lookup failed for %s", soundcloud_id)
        return None
    _listed[soundcloud_id] = bpm
    return bpm


async def original_bpm(soundcloud_id: int, detected: float | None) -> tuple[float | None, BpmSource]:
    """Pick the tempo to trust: the user's correction, then SoundCloud's, then ours.

    Args:
        soundcloud_id: The original's SoundCloud id.
        detected: Tempo detected from the audio, if any.

    Returns:
        ``(bpm, source)``; ``bpm`` is ``None`` only when no source has one.
    """
    corrected = db_cache.get_sc_bpm_override(soundcloud_id)
    if corrected is not None:
        return corrected, "corrected"
    listed = await listed_bpm(soundcloud_id)
    if listed is not None:
        return listed, "soundcloud"
    return detected, "detected"
