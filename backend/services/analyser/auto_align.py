"""Suggest where an identified track sits in its mix, from the audio itself."""

from __future__ import annotations

from pathlib import Path

from backend.domain.track_alignment import MIN_CONFIDENCE, rate_hints, search_window
from backend.infra.analyser import align, db, peaks
from backend.infra.analyser import cache as audio_cache
from backend.services.analyser.original_bpm import original_bpm


async def suggest_alignment(job_id: str, track_id: int, soundcloud_id: int, original: Path) -> align.AlignResult | None:
    """Locate the track's original audio in the mix near where it was detected.

    Args:
        job_id: Analyser job.
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
