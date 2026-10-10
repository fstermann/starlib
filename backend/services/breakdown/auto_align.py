"""Suggest where an identified track sits in its mix, from the audio itself."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from backend.domain.track_alignment import MIN_CONFIDENCE, fold_rate, rate_hints, search_window
from backend.infra.breakdown import align, db, peaks
from backend.infra.breakdown import cache as audio_cache
from backend.services.breakdown.original_bpm import original_bpm

logger = logging.getLogger(__name__)


async def suggest_alignment(job_id: str, track_id: int, soundcloud_id: int, original: Path) -> align.AlignResult | None:
    """Locate the track's original audio in the mix near where it was detected.

    Args:
        job_id: Breakdown job.
        track_id: Track row to align.
        soundcloud_id: The track's SoundCloud upload, which may not be saved
            on the row yet.
        original: Cached audio of that upload.

    Returns:
        The match, or ``None`` when the set audio isn't cached, the track is
        unknown, or no position beats its rivals clearly enough.
    """
    job = db.get_job(job_id)
    track = next((t for t in db.list_tracks(job_id) if t.id == track_id), None)
    if job is None or track is None or job.soundcloud_id is None:
        return None
    mix = audio_cache.cached_set_path(job.soundcloud_id)
    if mix is None:
        return None

    _peaks, duration_s, detected_bpm = await peaks.get_or_compute_peaks(original, soundcloud_id)
    bpm, _source = await original_bpm(soundcloud_id, detected_bpm)
    hints = rate_hints(track.set_bpm, bpm, track.pitch_offset)
    window = search_window(track.start_s, duration_s, min(hints), job.duration_s)
    result = await align.align_track(mix, original, window=window, rate_hints=hints)
    if result is None or result.confidence < MIN_CONFIDENCE:
        return None
    return result


# A match within this of the user's alignment, where the track is heard, is
# the same alignment.
_SAME_ALIGNMENT_S = 1.0


async def fill_mix_points(job_id: str, resolve_original: Callable[[int], Awaitable[Path]]) -> int:
    """Store where hand-aligned tracks are audible, from a fresh auto-align.

    Only for aligned tracks without mix points, and only when the match sits
    within :data:`_SAME_ALIGNMENT_S` of the user's alignment where the track
    is heard; a different answer is left alone rather than overriding the
    user. Compared where it plays, not at the original's 0:00: the two can
    assume slightly different speeds and drift apart before the track is in.

    Args:
        job_id: Breakdown job.
        resolve_original: ``async (soundcloud_id) -> Path`` for the original's
            cached audio.

    Returns:
        How many tracks got mix points.
    """
    filled = 0
    for track in db.list_tracks(job_id):
        if not track.aligned or track.mix_in_s is not None or track.soundcloud_id is None:
            continue
        try:
            original = await resolve_original(track.soundcloud_id)
            result = await suggest_alignment(job_id, track.id, track.soundcloud_id, original)
            saved_rate = await _saved_rate(track, original) if result is not None else None
        except Exception:
            logger.exception("breakdown: mix points failed for track %s", track.id)
            continue
        if result is None or not _agrees_with_saved(track, result, saved_rate):
            continue
        db.update_track(job_id, track.id, mix_in_s=result.enter_s, mix_out_s=result.exit_s)
        filled += 1
    return filled


async def _saved_rate(track: db.TrackRow, original: Path) -> float | None:
    """Playback rate the align dialog used when the user saved the start:
    set BPM over the original's BPM, octave-folded, as the dialog derives it."""
    if not track.set_bpm or track.soundcloud_id is None:
        return None
    _peaks, _duration, detected = await peaks.get_or_compute_peaks(original, track.soundcloud_id)
    bpm, _source = await original_bpm(track.soundcloud_id, detected)
    return fold_rate(track.set_bpm / bpm) if bpm else None


def _agrees_with_saved(track: db.TrackRow, result: align.AlignResult, saved_rate: float | None) -> bool:
    """Whether the match and the saved start put the track at the same mix
    time where it enters, plays and leaves."""
    rate = saved_rate or result.rate
    for mix_s in (result.enter_s, (result.enter_s + result.exit_s) / 2, result.exit_s):
        orig_s = (mix_s - result.start_s) * result.rate
        if abs(track.start_s + orig_s / rate - mix_s) > _SAME_ALIGNMENT_S:
            return False
    return True
