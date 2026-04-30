"""Subprocess orchestration for the analyser-stream Rust CLI.

Owns the lifetime of one ``analyser-stream`` subprocess: spawns it, parses
JSON-lines events from stdout, dispatches each event to the controller's
listener, and propagates the final exit status.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AnalyserBinaryOptions:
    """CLI options forwarded to ``analyser-stream``."""

    window_s: float | None = None
    hop_s: float | None = None
    target_sr: int | None = None
    min_bpm: float | None = None
    max_bpm: float | None = None
    bpm_range: tuple[float, float] | None = None
    octave_correction: bool | None = None
    sections_enabled: bool = True
    bands: int | None = None
    kernel_half_s: float | None = None
    min_gap_s: float | None = None
    peak_threshold: float | None = None
    start_s: float | None = None
    end_s: float | None = None

    def to_argv(self, *, input_path: Path) -> list[str]:
        argv: list[str] = ["analyse", "--input", str(input_path)]
        argv += self._bpm_argv()
        argv += self._segment_argv()
        argv += self._region_argv()
        return argv

    def _bpm_argv(self) -> list[str]:
        argv: list[str] = []
        for flag, value in (
            ("--window-s", self.window_s),
            ("--hop-s", self.hop_s),
            ("--target-sr", self.target_sr),
        ):
            if value is not None:
                argv += [flag, str(value)]
        if self.bpm_range is not None:
            lo, hi = self.bpm_range
            argv += ["--bpm-range", f"{lo}-{hi}"]
        else:
            if self.min_bpm is not None:
                argv += ["--min-bpm", str(self.min_bpm)]
            if self.max_bpm is not None:
                argv += ["--max-bpm", str(self.max_bpm)]
        if self.octave_correction is False:
            argv += ["--no-octave-correction"]
        return argv

    def _segment_argv(self) -> list[str]:
        argv: list[str] = []
        if not self.sections_enabled:
            argv += ["--no-sections"]
        for flag, value in (
            ("--bands", self.bands),
            ("--kernel-half-s", self.kernel_half_s),
            ("--min-gap-s", self.min_gap_s),
            ("--peak-threshold", self.peak_threshold),
        ):
            if value is not None:
                argv += [flag, str(value)]
        return argv

    def _region_argv(self) -> list[str]:
        argv: list[str] = []
        if self.start_s is not None:
            argv += ["--start-s", str(self.start_s)]
        if self.end_s is not None:
            argv += ["--end-s", str(self.end_s)]
        return argv


# Listener callback receives one parsed JSON-line dict per emit. Returning
# `False` (or raising) tells the runner to terminate the subprocess early.
EventListener = Callable[[dict], Awaitable[None]]


async def run_analyser_subprocess(
    *,
    binary_path: str,
    input_path: Path,
    options: AnalyserBinaryOptions,
    listener: EventListener,
) -> int:
    """Spawn ``analyser-stream`` and dispatch its JSON-line events.

    Returns the subprocess exit code. Any exception inside the listener
    propagates after best-effort subprocess termination.
    """
    argv = [binary_path, *options.to_argv(input_path=input_path)]
    logger.info("analyser: spawning %s", " ".join(argv))
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    stderr_task = asyncio.create_task(_drain_stderr(proc))

    try:
        await _read_stdout(proc, listener)
    except Exception:
        proc.kill()
        await proc.wait()
        await stderr_task
        raise

    rc = await proc.wait()
    await stderr_task
    return rc


async def _read_stdout(proc: asyncio.subprocess.Process, listener: EventListener) -> None:
    assert proc.stdout is not None
    while True:
        line_bytes = await proc.stdout.readline()
        if not line_bytes:
            break
        line = line_bytes.decode(errors="replace").strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("analyser: non-JSON line skipped: %r", line[:200])
            continue
        if not isinstance(payload, dict):
            continue
        await listener(payload)


async def _drain_stderr(proc: asyncio.subprocess.Process) -> None:
    """Forward stderr lines into the backend logger without buffering."""
    if proc.stderr is None:
        return
    while True:
        line = await proc.stderr.readline()
        if not line:
            break
        logger.info("analyser-stream[stderr]: %s", line.decode(errors="replace").rstrip())


def _summarise_section_for_shazam(
    section_start_s: float,
    section_end_s: float,
    target_window_s: float = 12.0,
) -> tuple[float, float]:
    """Pick the Shazam-query offset/length for a section.

    Aims for a centred window (most genre-confusable parts tend to be
    sections' middle, away from transitions). Falls back to the full
    section when it's shorter than ``target_window_s``.
    """
    section_len = max(0.0, section_end_s - section_start_s)
    if section_len <= target_window_s:
        return section_start_s, max(0.5, section_len)
    midpoint = (section_start_s + section_end_s) / 2.0
    return midpoint - target_window_s / 2.0, target_window_s


def select_pitch_offsets(
    *,
    section_bpm: float,
    target_bpm: float | None,
    bpm_range: Sequence[float] | None,
    strategy: str,
) -> list[float]:
    """Translate a pitch strategy into a list of semitone offsets to try.

    ``strategy``:
      - ``"none"``   → ``[0.0]`` (query Shazam unmodified).
      - ``"single"`` → one shift to ``target_bpm``.
      - ``"range"``  → fan out across the BPM range (3 candidates by default).
    """
    if strategy == "none" or section_bpm <= 0.0:
        return [0.0]
    if strategy == "single" and target_bpm:
        return [_bpm_to_semitones(section_bpm, target_bpm)]
    if strategy == "range" and bpm_range and len(bpm_range) == 2:
        lo, hi = float(bpm_range[0]), float(bpm_range[1])
        if hi <= lo:
            return [0.0]
        # Three evenly-spaced candidates inside the band.
        candidates = [lo, (lo + hi) / 2.0, hi]
        return [_bpm_to_semitones(section_bpm, c) for c in candidates]
    return [0.0]


def _bpm_to_semitones(from_bpm: float, to_bpm: float) -> float:
    """Semitone shift required to retune ``from_bpm`` so it plays at ``to_bpm``.

    Pitch and tempo are coupled when you simply scale the playback rate
    (no time-stretching), so ``shift = 12 * log2(to/from)``.
    """
    import math

    if from_bpm <= 0 or to_bpm <= 0:
        return 0.0
    return 12.0 * math.log2(to_bpm / from_bpm)
