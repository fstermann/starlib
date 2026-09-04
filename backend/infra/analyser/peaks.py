"""High-resolution waveform peaks for cached SoundCloud audio.

Decodes a cached set/track (downloaded by :mod:`backend.infra.analyser.cache`)
to mono PCM via ffmpeg and reduces it to a normalized peak envelope. The
SoundCloud ``waveform_url`` is far too coarse (~1 sample / 100 ms) for kick-
level alignment; decoding the actual audio gives the same fidelity as the
mix strip.

Results are cached on disk as JSON, keyed by soundcloud id and invalidated
when the source audio file is newer than the cache.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from pathlib import Path
from statistics import median

from backend.config import get_backend_settings
from backend.domain.audio import reduce_peaks
from backend.infra.analyser import binary as binary_locator
from backend.infra.analyser.cache import _find_ffmpeg
from backend.infra.analyser.pipeline import (
    AnalyserBinaryOptions,
    run_analyser_subprocess,
)

logger = logging.getLogger(__name__)

# BPM search range for the original track. Wide enough for dance music; the
# analyser binary applies its own octave correction.
_BPM_RANGE = (70.0, 200.0)

# Decode density and peak-count envelope. The alignment dialog zooms to
# ~240 px/s and draws a bar every ~3 px (~80 bars/s), so the envelope needs
# at least that many peaks per second to stay crisp when fully zoomed in;
# 120/s gives headroom. Clamped so very short or very long tracks stay sane.
# 8 kHz mono is plenty for an amplitude envelope.
_DECODE_SAMPLE_RATE = 8000
_PEAKS_PER_SECOND = 120
_MIN_PEAKS = 2000
_MAX_PEAKS = 60000
_DECODE_TIMEOUT_S = 180
# Bumped whenever the peak density changes so stale on-disk caches (baked at
# a lower resolution) are recomputed rather than served.
_CACHE_VERSION = 2


def _peaks_dir() -> Path:
    base = get_backend_settings().cache_dir / "analyser" / "peaks"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _peaks_cache_path(soundcloud_id: int) -> Path:
    return _peaks_dir() / f"{soundcloud_id}.json"


def _decode_pcm_f32(path: Path) -> bytes:
    """Decode ``path`` to mono ``f32le`` PCM at the decode sample rate."""
    cmd = [
        _find_ffmpeg(),
        "-i",
        str(path),
        "-ac",
        "1",
        "-ar",
        str(_DECODE_SAMPLE_RATE),
        "-f",
        "f32le",
        "-v",
        "quiet",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=_DECODE_TIMEOUT_S)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed ({proc.returncode}) for {path}")
    return proc.stdout


async def detect_bpm(path: Path) -> float | None:
    """Detect the track's tempo by running the analyser binary over ``path``.

    Collects the per-window BPMs the binary streams (section detection off)
    and returns their median — a stable single estimate for a track that
    holds one tempo. Returns ``None`` if the binary is unavailable, fails, or
    emits no BPM windows, so the caller can fall back to a pitch-based ratio.

    Parameters
    ----------
    path : Path
        The cached audio file to analyse.

    Returns
    -------
    float | None
        Median detected BPM, or ``None`` when detection was not possible.
    """
    bpms: list[float] = []

    async def listener(line: dict) -> None:
        if line.get("type") == "window.bpm":
            try:
                bpms.append(float(line["bpm"]))
            except (KeyError, TypeError, ValueError):
                pass

    options = AnalyserBinaryOptions(sections_enabled=False, bpm_range=_BPM_RANGE)
    try:
        binary_path = binary_locator.find_analyser_binary()
        rc = await run_analyser_subprocess(
            binary_path=binary_path,
            input_path=path,
            options=options,
            listener=listener,
        )
    except Exception:
        logger.warning("BPM detection failed for %s", path, exc_info=True)
        return None
    if rc != 0 or not bpms:
        return None
    return float(median(bpms))


async def get_or_compute_peaks(
    path: Path,
    soundcloud_id: int,
    *,
    force: bool = False,
) -> tuple[list[float], float, float | None]:
    """Return ``(peaks, duration_s, bpm)`` for a cached audio file.

    Serves a valid on-disk cache entry when present; otherwise decodes the
    audio (peaks) and detects the tempo concurrently, then caches both.

    Parameters
    ----------
    path : Path
        The cached audio file to decode.
    soundcloud_id : int
        Track id; keys the on-disk peaks cache.
    force : bool, optional
        Skip the on-disk cache and recompute peaks + BPM. Used by reanalyse.

    Returns
    -------
    tuple[list[float], float, float | None]
        Normalized peaks in ``[0, 1]``, the audio duration in seconds, and the
        detected BPM (``None`` if detection was not possible).
    """
    source_mtime = path.stat().st_mtime
    if not force:
        cached = _load_cached(soundcloud_id, source_mtime)
        if cached is not None:
            return cached

    pcm, bpm = await asyncio.gather(
        asyncio.to_thread(_decode_pcm_f32, path),
        detect_bpm(path),
    )
    sample_count = len(pcm) // 4
    duration_s = sample_count / _DECODE_SAMPLE_RATE if sample_count else 0.0
    num_peaks = max(
        _MIN_PEAKS,
        min(_MAX_PEAKS, round(duration_s * _PEAKS_PER_SECOND)),
    )
    peaks = reduce_peaks(pcm, num_peaks)
    _save_cached(soundcloud_id, peaks, duration_s, bpm, source_mtime)
    return peaks, duration_s, bpm


def read_cached_bpm(soundcloud_id: int) -> tuple[bool, float | None]:
    """Return ``(cached, bpm)`` from the on-disk cache without decoding.

    A cheap lookup for callers that only need the detected tempo (e.g.
    reverting a BPM correction) and shouldn't trigger an audio re-fetch or a
    full decode. ``cached`` is ``False`` when no usable cache entry exists, so
    the caller can fall back to :func:`get_or_compute_peaks`. The source-mtime
    check is skipped on purpose — the detected tempo is a property of the
    audio content, and a re-fetch just to revalidate it defeats the point.

    Parameters
    ----------
    soundcloud_id : int
        Track id; keys the on-disk peaks cache.

    Returns
    -------
    tuple[bool, float | None]
        ``(True, bpm)`` when a cache entry of the current version exists
        (``bpm`` may be ``None`` if detection had failed); ``(False, None)``
        otherwise.
    """
    cache_path = _peaks_cache_path(soundcloud_id)
    if not cache_path.exists():
        return False, None
    try:
        data = json.loads(cache_path.read_text())
        if data.get("version") != _CACHE_VERSION:
            return False, None
        bpm = data.get("bpm")
        return True, (float(bpm) if bpm is not None else None)
    except (OSError, ValueError, TypeError):
        return False, None


def _load_cached(soundcloud_id: int, source_mtime: float) -> tuple[list[float], float, float | None] | None:
    cache_path = _peaks_cache_path(soundcloud_id)
    if not cache_path.exists():
        return None
    try:
        data = json.loads(cache_path.read_text())
        if data.get("source_mtime") != source_mtime:
            return None
        if data.get("version") != _CACHE_VERSION:
            return None
        bpm = data.get("bpm")
        return (
            list(data["peaks"]),
            float(data["duration_s"]),
            float(bpm) if bpm is not None else None,
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _save_cached(
    soundcloud_id: int,
    peaks: list[float],
    duration_s: float,
    bpm: float | None,
    source_mtime: float,
) -> None:
    payload = {
        "peaks": peaks,
        "duration_s": duration_s,
        "bpm": bpm,
        "source_mtime": source_mtime,
        "version": _CACHE_VERSION,
    }
    try:
        _peaks_cache_path(soundcloud_id).write_text(json.dumps(payload))
    except OSError:
        logger.warning("Failed to write peaks cache for %s", soundcloud_id)
