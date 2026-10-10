"""Per-track breakdown cache and the ``analyser-stream breakdown`` adapter.

Each analysed track gets ``<cache_dir>/breakdown/tracks/<audio hash>/`` with
its stems and ``features.json``. The hash covers decoded audio only, so tag
edits don't invalidate the cache.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from backend.config import get_backend_settings
from backend.infra.audio.track_handler import _find_binary
from backend.infra.breakdown import binary as binary_locator
from backend.infra.breakdown.pipeline import run_binary


class MeasureError(RuntimeError):
    """Raised when the breakdown binary fails."""


async def audio_hash(path: Path) -> str:
    """Return the SHA-256 of the decoded audio stream of ``path``.

    Args:
        path: Audio file.

    Returns:
        Hex digest.

    Raises:
        MeasureError: ffmpeg could not decode the file.
    """
    proc = await asyncio.create_subprocess_exec(
        _find_binary("ffmpeg"),
        "-v",
        "error",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-f",
        "hash",
        "-hash",
        "sha256",
        "-",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise MeasureError(f"ffmpeg hash failed for {path}: {stderr.decode(errors='replace')[:512]}")
    return stdout.decode().strip().removeprefix("SHA256=")


def track_dir(digest: str) -> Path:
    """Cache directory for the track with audio hash ``digest``."""
    return get_backend_settings().cache_dir / "breakdown" / "tracks" / digest


async def measure(
    mix: Path,
    stems: Mapping[str, Path],
    out: Path,
    on_stage: Callable[[str], None] = lambda _: None,
) -> dict[str, Any]:
    """Run ``analyser-stream breakdown`` and return the parsed features.

    Args:
        mix: Full-mix audio file.
        stems: Stem name to audio file.
        out: Where the binary writes ``features.json``.
        on_stage: Called with each source name as the binary reaches it.

    Returns:
        The features document.

    Raises:
        MeasureError: The binary exited with an error.
    """
    argv = [binary_locator.find_analyser_binary(), "breakdown", "--input", str(mix), "--out", str(out)]
    for name, path in stems.items():
        argv += ["--stem", f"{name}={path}"]
    errors: list[str] = []

    async def listener(event: dict) -> None:
        if event.get("type") == "breakdown.stage":
            on_stage(event["source"])
        elif event.get("type") == "error":
            errors.append(str(event.get("message")))

    rc = await run_binary(argv, listener)
    if rc != 0:
        raise MeasureError(errors[0] if errors else f"analyser-stream exited {rc}")
    return json.loads(out.read_text())
