"""Measure a mix's loudness with ffmpeg's EBU R128 meter (``ebur128`` filter).

The meter logs one line per 100 ms frame with momentary and short-term
loudness and the frame's true peak, then a summary with integrated loudness,
loudness range and overall true peak. A second, cheaper pass meters the mix
low-passed at :data:`LOW_BAND_HZ` for the bass balance, and a third decodes it
to PCM for the average spectrum. Results are cached as JSON under
``<cache_dir>/breakdown/loudness/``, keyed by the file's path, size and
modification time, so an edited or re-exported file is measured again.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
import subprocess
import tempfile
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from backend.config import get_backend_settings
from backend.domain.loudness import FRAME_S, LoudnessFrames
from backend.domain.spectrum import SAMPLE_RATE, SpectrumMeter
from backend.infra.breakdown.cache import _find_ffmpeg

logger = logging.getLogger(__name__)

# Bumped when the cached JSON's shape changes, so old entries are measured again.
_CACHE_VERSION = 3
# Kick and sub bass sit below this; two cascaded 2-pole filters give 24 dB/octave.
LOW_BAND_HZ = 150
# A 2 h set meters in about 30 s on Apple Silicon; leave room for slow disks.
_MEASURE_TIMEOUT_S = 15 * 60

_FRAME_LINE = re.compile(r"\bt:\s*\S+\s+TARGET:\S+\s+LUFS\s+M:\s*(\S+)\s+S:\s*(\S+).*?\bFTPK:\s*(.*?)\s*dBFS")
_DURATION = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_FRAME_TIME = re.compile(r"\bt:\s*(\d+(?:\.\d+)?)")
# Share of the work in each pass: the full band's true-peak oversampling makes it the slowest.
_FULL_PASS_SHARE = 0.7
_LOW_PASS_SHARE = 0.15
# About 1.5 s of stereo float samples per read from ffmpeg.
_PCM_CHUNK_BYTES = 2**16 * 2 * 4
_MOMENTARY_LINE = re.compile(r"\bt:\s*\S+\s+TARGET:\S+\s+LUFS\s+M:\s*(\S+)")
_SUMMARY_I = re.compile(r"Integrated loudness:\s*I:\s*(\S+)\s*LUFS")
_SUMMARY_LRA = re.compile(r"Loudness range:\s*LRA:\s*(\S+)\s*LU")
_SUMMARY_PEAK = re.compile(r"True peak:\s*Peak:\s*(\S+)\s*dBFS")

# Silence reads as -inf; JSON has no infinity, and this sits far below every gate.
_SILENCE = -200.0

_locks: dict[str, asyncio.Lock] = {}
_progress: dict[str, float] = {}


@dataclass(frozen=True, slots=True)
class Measurement:
    """The meter's output for one file."""

    frames: LoudnessFrames
    integrated_lufs: float | None
    loudness_range_lu: float | None
    true_peak_dbtp: float | None
    # Mean power per FFT bin over the audible windows; empty when not metered or silent.
    spectrum: Sequence[float] = ()


async def get_or_measure(path: Path) -> Measurement:
    """Cached measurement of ``path``, metering it first if needed.

    Concurrent calls for the same file share one ffmpeg run.

    Args:
        path: Audio file.

    Returns:
        The measurement.
    """
    key = _cache_key(path)
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = cached_measurement(path)
        if cached is not None:
            return cached
        _progress[key] = 0.0
        try:
            measurement = await asyncio.to_thread(measure, path, lambda done: _progress.__setitem__(key, done))
        finally:
            _progress.pop(key, None)
        _write_cache(key, measurement)
        return measurement


def measuring_progress(path: Path) -> float | None:
    """How far a running measurement of ``path`` is, from 0 to 1.

    Args:
        path: Audio file.

    Returns:
        The fraction done, or ``None`` when ``path`` isn't being measured.
    """
    return _progress.get(_cache_key(path))


def cached_measurement(path: Path) -> Measurement | None:
    """The cached measurement of ``path``, or ``None`` when it hasn't been metered.

    Args:
        path: Audio file.

    Returns:
        The measurement, or ``None``.
    """
    file = _cache_dir() / f"{_cache_key(path)}.json"
    try:
        data = json.loads(file.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if data.get("version") != _CACHE_VERSION:
        return None
    return Measurement(
        frames=LoudnessFrames(
            momentary=data["momentary"],
            short_term=data["short_term"],
            true_peak=data["true_peak"],
            low_band=data["low_band"],
        ),
        integrated_lufs=data["integrated_lufs"],
        loudness_range_lu=data["loudness_range_lu"],
        true_peak_dbtp=data["true_peak_dbtp"],
        spectrum=data["spectrum"],
    )


def measure(path: Path, on_progress: Callable[[float], None] | None = None) -> Measurement:
    """Run the EBU R128 meter over the whole file, full band and low band, then its spectrum.

    Args:
        path: Audio file.
        on_progress: Called with the fraction done, from 0 to 1, as the meter advances.

    Returns:
        The measurement.
    """
    report = on_progress or (lambda _done: None)
    full = parse_meter_log(
        _run_meter(path, "ebur128=peak=true:framelog=info", lambda done: report(done * _FULL_PASS_SHARE))
    )
    low_pass = f"lowpass=f={LOW_BAND_HZ},lowpass=f={LOW_BAND_HZ}"
    low_band = parse_momentary_log(
        _run_meter(
            path,
            f"{low_pass},ebur128=framelog=info",
            lambda done: report(_FULL_PASS_SHARE + done * _LOW_PASS_SHARE),
        )
    )
    spectrum_start = _FULL_PASS_SHARE + _LOW_PASS_SHARE
    spectrum = _run_spectrum(
        path,
        len(full.frames.momentary) * FRAME_S,
        lambda done: report(spectrum_start + done * (1 - spectrum_start)),
    )
    # Both passes frame the same samples; trim in case a decoder flushes one frame more.
    frames = full.frames
    n = min(len(frames.momentary), len(low_band))
    return replace(
        full,
        frames=LoudnessFrames(
            momentary=frames.momentary[:n],
            short_term=frames.short_term[:n],
            true_peak=frames.true_peak[:n],
            low_band=low_band[:n],
        ),
        spectrum=spectrum,
    )


def _run_meter(path: Path, audio_filter: str, on_progress: Callable[[float], None]) -> str:
    """Run ffmpeg with ``audio_filter`` over the file's first audio stream.

    Args:
        path: Audio file.
        audio_filter: ffmpeg filter chain ending in ``ebur128``.
        on_progress: Called with the fraction of the file metered so far.

    Returns:
        ffmpeg's stderr, which carries the meter's log.

    Raises:
        RuntimeError: When ffmpeg fails or runs past the timeout.
    """
    cmd = [
        _find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-filter:a",
        audio_filter,
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    timer = threading.Timer(_MEASURE_TIMEOUT_S, proc.kill)
    timer.start()
    lines: list[str] = []
    duration_s: float | None = None
    try:
        assert proc.stderr is not None
        for line in proc.stderr:
            lines.append(line)
            if duration_s is None:
                duration_s = _duration_s(line)
            elif (match := _FRAME_TIME.search(line)) is not None:
                on_progress(min(1.0, float(match.group(1)) / duration_s))
        returncode = proc.wait()
    finally:
        timer.cancel()
    log = "".join(lines)
    if returncode != 0:
        tail = log.strip().splitlines()[-1:] or ["no output"]
        raise RuntimeError(f"ffmpeg loudness meter failed ({returncode}): {tail[0]}")
    return log


def _run_spectrum(path: Path, duration_s: float, on_progress: Callable[[float], None]) -> list[float]:
    """Decode the file to stereo PCM at the spectrum's sample rate and average its power spectrum.

    Args:
        path: Audio file.
        duration_s: The file's length, for progress.
        on_progress: Called with the fraction of the file read so far.

    Returns:
        Mean power per FFT bin, empty when the file is silent.

    Raises:
        RuntimeError: When ffmpeg fails or runs past the timeout.
    """
    cmd = [
        _find_ffmpeg(),
        "-v",
        "error",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "-",
    ]
    meter = SpectrumMeter()
    total_frames = max(duration_s * SAMPLE_RATE, 1.0)
    read_frames = 0
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors)
        timer = threading.Timer(_MEASURE_TIMEOUT_S, proc.kill)
        timer.start()
        try:
            assert proc.stdout is not None
            while chunk := proc.stdout.read(_PCM_CHUNK_BYTES):
                # A pipe read can end mid-sample; the meter only takes whole stereo frames.
                usable = len(chunk) - len(chunk) % 8
                meter.add(np.frombuffer(chunk[:usable], dtype="<f4").reshape(-1, 2))
                read_frames += usable // 8
                on_progress(min(1.0, read_frames / total_frames))
            returncode = proc.wait()
        finally:
            timer.cancel()
        if returncode != 0:
            errors.seek(0)
            tail = errors.read().decode(errors="replace").strip().splitlines()[-1:] or ["no output"]
            raise RuntimeError(f"ffmpeg spectrum decode failed ({returncode}): {tail[0]}")
    return meter.mean_power()


def _duration_s(line: str) -> float | None:
    """The input's length from ffmpeg's ``Duration:`` header line, if this is that line."""
    match = _DURATION.search(line)
    if match is None:
        return None
    hours, minutes, seconds = match.groups()
    total = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return total if total > 0 else None


def parse_meter_log(log: str) -> Measurement:
    """Parse the ``ebur128`` filter's log into frames and summary.

    Args:
        log: ffmpeg's stderr with ``framelog=info``.

    Returns:
        The measurement.
    """
    momentary: list[float] = []
    short_term: list[float] = []
    true_peak: list[float] = []
    for match in _FRAME_LINE.finditer(log):
        momentary.append(_frame_value(match.group(1)))
        short_term.append(_frame_value(match.group(2)))
        # One reading per channel; the frame's peak is the loudest channel.
        true_peak.append(max((_frame_value(v) for v in match.group(3).split()), default=_SILENCE))
    summary = log[log.rfind("Summary:") :]
    return Measurement(
        frames=LoudnessFrames(momentary=momentary, short_term=short_term, true_peak=true_peak),
        integrated_lufs=_summary_value(_SUMMARY_I, summary),
        loudness_range_lu=_summary_value(_SUMMARY_LRA, summary),
        true_peak_dbtp=_summary_value(_SUMMARY_PEAK, summary),
    )


def parse_momentary_log(log: str) -> list[float]:
    """Momentary loudness per frame from an ``ebur128`` log without true peak.

    Args:
        log: ffmpeg's stderr with ``framelog=info``.

    Returns:
        One reading per 100 ms frame.
    """
    return [_frame_value(match.group(1)) for match in _MOMENTARY_LINE.finditer(log)]


def _number(text: str) -> float | None:
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _frame_value(text: str) -> float:
    value = _number(text)
    return _SILENCE if value is None else round(value, 2)


def _summary_value(pattern: re.Pattern[str], summary: str) -> float | None:
    match = pattern.search(summary)
    return None if match is None else _number(match.group(1))


def _cache_dir() -> Path:
    path = get_backend_settings().cache_dir / "breakdown" / "loudness"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _cache_key(path: Path) -> str:
    try:
        stat = path.stat()
        identity = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
    except OSError:
        identity = str(path)
    return hashlib.sha256(identity.encode()).hexdigest()[:32]


def _write_cache(key: str, measurement: Measurement) -> None:
    frames = measurement.frames
    data = {
        "version": _CACHE_VERSION,
        "integrated_lufs": measurement.integrated_lufs,
        "loudness_range_lu": measurement.loudness_range_lu,
        "true_peak_dbtp": measurement.true_peak_dbtp,
        "momentary": list(frames.momentary),
        "short_term": list(frames.short_term),
        "true_peak": list(frames.true_peak),
        "low_band": list(frames.low_band),
        "spectrum": list(measurement.spectrum),
    }
    try:
        (_cache_dir() / f"{key}.json").write_text(json.dumps(data, separators=(",", ":")))
    except OSError:
        logger.warning("breakdown: could not cache loudness measurement %s", key, exc_info=True)
