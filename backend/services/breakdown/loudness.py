"""Loudness report for a Set Breakdown job: whole-mix readings, tonal balance and per-track levels.

Per-track levels need the tracklist. Detected sections are no stand-in: they
rarely line up with track changes, and fixed windows would flag every
breakdown as too quiet.
"""

from __future__ import annotations

from dataclasses import asdict

from backend.domain.loudness import (
    ABSOLUTE_GATE_LUFS,
    EVEN_OUT_TOLERANCE_LU,
    FRAME_S,
    LOW_END_TOLERANCE_LU,
    TRANSITION_JUMP_LU,
    TRANSITION_WINDOW_S,
    even_out,
    low_end_reference,
    partition,
    summarise,
    transitions,
)
from backend.domain.spectrum import band_levels, octave_curve
from backend.infra.breakdown import db
from backend.infra.breakdown import loudness as meter
from backend.infra.breakdown.cache import set_audio_path

# The short-term curve is sent at one point per second: plenty for a set-wide chart.
_CURVE_STEP_S = 1.0


class AudioUnavailableError(LookupError):
    """The job's audio isn't on disk: a moved local file, or a set not downloaded yet."""


async def measure_job(job_id: str, min_matches: int = 1) -> dict:
    """Meter the job's audio (cached per file) and build its report.

    Args:
        job_id: Breakdown job.
        min_matches: Shazam tracks found in fewer scan windows don't split the set, as in the tracklist's filter.

    Returns:
        The report.

    Raises:
        AudioUnavailableError: When the job's audio isn't on disk.
    """
    job = _job(job_id)
    path = set_audio_path(local_path=job.local_path, soundcloud_id=job.soundcloud_id)
    if path is None:
        raise AudioUnavailableError(job_id)
    return _report(job, await meter.get_or_measure(path), min_matches)


def cached_report(job_id: str, min_matches: int = 1) -> dict | None:
    """The job's report if its audio was metered before, else ``None``.

    Args:
        job_id: Breakdown job.
        min_matches: As in :func:`measure_job`.

    Returns:
        The report, or ``None``.
    """
    job = _job(job_id)
    path = set_audio_path(local_path=job.local_path, soundcloud_id=job.soundcloud_id)
    if path is None:
        return None
    measurement = meter.cached_measurement(path)
    return None if measurement is None else _report(job, measurement, min_matches)


def measuring_progress(job_id: str) -> float | None:
    """How far a running measurement of the job's audio is, from 0 to 1.

    Args:
        job_id: Breakdown job.

    Returns:
        The fraction done, or ``None`` when it isn't being measured.
    """
    job = _job(job_id)
    path = set_audio_path(local_path=job.local_path, soundcloud_id=job.soundcloud_id)
    return None if path is None else meter.measuring_progress(path)


def _shown_tracks(job_id: str, min_matches: int) -> list[db.TrackRow]:
    """The tracks the tracklist shows: hand-placed, confirmed, or found in at least ``min_matches`` scan windows."""
    tracks = db.list_tracks(job_id)
    if min_matches <= 1:
        return tracks
    windows: dict[str, set[float]] = {}
    for scan in db.list_shazam_scans(job_id):
        if scan.title is not None and scan.shazam_id is not None:
            windows.setdefault(scan.shazam_id, set()).add(scan.scan_s)
    return [t for t in tracks if t.shazam_id is None or t.confirmed or len(windows.get(t.shazam_id, ())) >= min_matches]


def _job(job_id: str) -> db.JobRow:
    job = db.get_job(job_id)
    if job is None:
        raise LookupError(f"job {job_id} not found")
    return job


def _report(job: db.JobRow, measurement: meter.Measurement, min_matches: int) -> dict:
    frames = measurement.frames
    duration_s = job.duration_s or len(frames.momentary) * FRAME_S
    tracks = _shown_tracks(job.id, min_matches)
    starts = [(t.start_s, " - ".join(p for p in (t.artist, t.title) if p)) for t in tracks]
    segments = partition(starts, duration_s)
    reference, levels = even_out(frames, segments)
    step = round(_CURVE_STEP_S / FRAME_S)
    # The frame stamped at each whole second is the (step-1)th of that second.
    curve = [max(v, ABSOLUTE_GATE_LUFS) for v in frames.short_term[step - 1 :: step]]
    peaks = [max(max(frames.true_peak[i * step : (i + 1) * step]), ABSOLUTE_GATE_LUFS) for i in range(len(curve))]
    summary = summarise(frames)
    spectrum = measurement.spectrum
    centres_hz, levels_db = octave_curve(spectrum) if spectrum else ([], [])
    return {
        "integrated_lufs": measurement.integrated_lufs,
        "loudness_range_lu": measurement.loudness_range_lu,
        "true_peak_dbtp": measurement.true_peak_dbtp,
        "short_term_max_lufs": summary.short_term_max_lufs,
        "short_term_min_lufs": summary.short_term_min_lufs,
        "momentary_max_lufs": summary.momentary_max_lufs,
        "curve": {
            "step_s": _CURVE_STEP_S,
            "floor_lufs": ABSOLUTE_GATE_LUFS,
            "short_term_lufs": curve,
            "true_peak_dbtp": peaks,
        },
        "reference_lufs": reference,
        "tolerance_lu": EVEN_OUT_TOLERANCE_LU,
        "segments": [asdict(level) for level in levels],
        "low_end_reference_lu": low_end_reference(levels),
        "low_end_tolerance_lu": LOW_END_TOLERANCE_LU,
        "transitions": [{**asdict(change), "jump_lu": change.jump_lu} for change in transitions(frames, segments)],
        "transition_window_s": TRANSITION_WINDOW_S,
        "transition_jump_lu": TRANSITION_JUMP_LU,
        "spectrum": {"centres_hz": centres_hz, "level_db": levels_db} if spectrum else None,
        "bands": [asdict(band) for band in band_levels(spectrum)] if spectrum else [],
    }
