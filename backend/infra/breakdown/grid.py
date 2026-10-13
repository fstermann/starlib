"""Run ``analyser-stream grid`` to detect a track's beatgrid and phrases."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from pathlib import Path

from backend.infra.breakdown import binary as binary_locator
from backend.infra.breakdown.cache import _find_ffmpeg

logger = logging.getLogger(__name__)

# Must match ``starlib_audio::grid::GRID_SR``.
_GRID_SR = 22050
_TIMEOUT_S = 120


async def _decode_to_wav(source: Path, out: Path) -> None:
    # ffmpeg applies the mp4 edit list, trimming the AAC encoder priming.
    proc = await asyncio.create_subprocess_exec(
        _find_ffmpeg(), "-y", "-v", "quiet", "-i", str(source), "-ac", "1", "-ar", str(_GRID_SR), str(out)
    )
    if await proc.wait() != 0:
        raise RuntimeError(f"ffmpeg decode failed for {source}")


async def detect_grid(source: Path, bpm: float) -> dict | None:
    """Detect the beatgrid and phrases of ``source``, given its tempo.

    Args:
        source: Cached track audio.
        bpm: The track's tempo; the binary refines it within a few percent.

    Returns:
        ``{"bpm", "confidence", "beats": [{"time_s", "beat"}], "phrases":
        [{"kind", "label", "start_s", "end_s"}]}``, or ``None`` when the
        binary failed.
    """
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "track.wav"
        await _decode_to_wav(source, wav)
        argv = [binary_locator.find_analyser_binary(), "grid", "--input", str(wav), "--bpm", f"{bpm:.3f}"]
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), _TIMEOUT_S)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            logger.warning("breakdown: grid timed out for %s", source)
            return None
    if proc.returncode != 0:
        logger.warning("breakdown: grid failed (%s): %s", proc.returncode, stderr.decode(errors="replace")[:500])
        return None
    for line in stdout.decode(errors="replace").splitlines():
        event = json.loads(line)
        if event.get("type") == "grid":
            event.pop("type")
            return event
    return None
