"""Beatgrid and phrase analysis for SoundCloud tracks, cached per track."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from backend.infra import cache as db_cache
from backend.infra.breakdown import grid as grid_infra
from backend.infra.breakdown import peaks as peaks_infra
from backend.services.breakdown.original_bpm import original_bpm

# Share of audible beats that must sit on an onset. Four-on-the-floor tracks
# measured 0.65-0.99; below this the track has no steady grid to mix on.
MIN_CONFIDENCE = 0.5

_locks: dict[int, asyncio.Lock] = {}


async def track_grid(track_id: int, resolve_audio: Callable[[], Awaitable[Path]]) -> dict | None:
    """Return the track's beatgrid analysis, detecting and caching it on a miss.

    Args:
        track_id: SoundCloud track id.
        resolve_audio: Returns the track's cached audio, downloading it first
            if needed. Only called on a cache miss.

    Returns:
        The analysis (see :func:`backend.infra.breakdown.grid.detect_grid`), or
        ``None`` when no tempo is known or detection failed.
    """
    cached = db_cache.get_sc_grid(track_id)
    if cached is not None:
        return cached
    lock = _locks.setdefault(track_id, asyncio.Lock())
    async with lock:
        cached = db_cache.get_sc_grid(track_id)
        if cached is not None:
            return cached
        path = await resolve_audio()
        bpm, _source = await original_bpm(track_id, None)
        if bpm is None:
            bpm = await peaks_infra.detect_bpm(path)
        if bpm is None:
            return None
        analysis = await grid_infra.detect_grid(path, bpm)
        if analysis is None:
            return None
        db_cache.upsert_sc_grid(track_id, analysis, time.time())
        return analysis


def is_usable(analysis: dict) -> bool:
    """Whether the grid is steady enough to beat-match on."""
    return analysis["confidence"] >= MIN_CONFIDENCE and bool(analysis["beats"])
