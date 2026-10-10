"""Run ``analyser-stream align`` to locate an original track inside a mix."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path

from backend.infra.breakdown import binary as binary_locator
from backend.infra.breakdown.cache import _find_ffmpeg

logger = logging.getLogger(__name__)

_ALIGN_SR = 11025
_TIMEOUT_S = 120


@dataclass(frozen=True, slots=True)
class AlignResult:
    """Where the original sits, in mix time."""

    start_s: float
    rate: float
    key_lock: bool
    confidence: float
    enter_s: float
    exit_s: float
    # Per chunk of the original: start_s/end_s (original seconds), uniqueness
    # within the track (0-1) and whether it agrees with the match.
    chunks: tuple[dict, ...] = ()


async def _extract_window(source: Path, start_s: float, end_s: float, out: Path) -> None:
    proc = await asyncio.create_subprocess_exec(
        _find_ffmpeg(),
        "-y",
        "-v",
        "quiet",
        "-ss",
        f"{start_s:.3f}",
        "-t",
        f"{end_s - start_s:.3f}",
        "-i",
        str(source),
        "-ac",
        "1",
        "-ar",
        str(_ALIGN_SR),
        str(out),
    )
    if await proc.wait() != 0:
        raise RuntimeError(f"ffmpeg window extraction failed for {source}")


async def align_track(
    mix: Path, original: Path, *, window: tuple[float, float], rate_hints: list[float]
) -> AlignResult | None:
    """Locate ``original`` inside ``window`` of ``mix``.

    Args:
        mix: Cached set audio.
        original: Cached audio of the identified track.
        window: ``(start_s, end_s)`` of the mix to search.
        rate_hints: Candidate playback rates of the original in the mix.

    Returns:
        The match in absolute mix time, or ``None`` when the original wasn't
        found or the binary failed.
    """
    start_s, end_s = window
    with tempfile.TemporaryDirectory() as tmp:
        clip = Path(tmp) / "window.wav"
        await _extract_window(mix, start_s, end_s, clip)
        argv = [binary_locator.find_analyser_binary(), "align", "--mix", str(clip), "--original", str(original)]
        for rate in rate_hints:
            argv += ["--rate-hint", f"{rate:.6f}"]
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), _TIMEOUT_S)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            logger.warning("breakdown: align timed out for %s", original)
            return None
    if proc.returncode != 0:
        logger.warning("breakdown: align failed (%s): %s", proc.returncode, stderr.decode(errors="replace")[:500])
        return None
    for line in stdout.decode(errors="replace").splitlines():
        event = json.loads(line)
        if event.get("type") == "alignment":
            return AlignResult(
                start_s=start_s + event["start_s"],
                rate=event["rate"],
                key_lock=event["key_lock"],
                confidence=event["confidence"],
                enter_s=start_s + event["enter_s"],
                exit_s=start_s + event["exit_s"],
                chunks=tuple(event.get("chunks", ())),
            )
    return None
