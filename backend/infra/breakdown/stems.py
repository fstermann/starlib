"""Stem separation with Demucs, run as a subprocess in its own Python env.

Demucs needs PyTorch, which is too heavy to bundle with the backend, so it
lives in a separate environment whose interpreter ``STARLIB_DEMUCS_PYTHON``
points at.
"""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path

MODEL = "htdemucs"
STEM_NAMES = ("drums", "bass", "other", "vocals")


class StemsUnavailableError(RuntimeError):
    """Raised when no Demucs environment is configured or separation fails."""


def _demucs_python() -> str:
    python = os.environ.get("STARLIB_DEMUCS_PYTHON")
    if not python:
        raise StemsUnavailableError("set STARLIB_DEMUCS_PYTHON to a Python with demucs installed")
    return python


def _device() -> str:
    return "mps" if sys.platform == "darwin" and platform.machine() == "arm64" else "cpu"


def cached_stems(stems_dir: Path) -> dict[str, Path] | None:
    """Return the stems in ``stems_dir`` if all of them exist.

    Args:
        stems_dir: Directory holding ``<stem>.flac`` files.

    Returns:
        Stem name to path, or ``None`` when any stem is missing.
    """
    paths = {name: stems_dir / f"{name}.flac" for name in STEM_NAMES}
    return paths if all(p.exists() for p in paths.values()) else None


async def separate(audio: Path, stems_dir: Path) -> dict[str, Path]:
    """Split ``audio`` into stems, reusing ``stems_dir`` when already populated.

    Args:
        audio: Source audio file.
        stems_dir: Destination directory for ``<stem>.flac`` files.

    Returns:
        Stem name to FLAC path.

    Raises:
        StemsUnavailableError: Demucs isn't configured or exited with an error.
        asyncio.CancelledError: The task was cancelled; demucs is killed first.
    """
    cached = cached_stems(stems_dir)
    if cached:
        return cached
    stems_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=stems_dir.parent) as tmp:
        proc = await asyncio.create_subprocess_exec(
            _demucs_python(),
            "-m",
            "demucs",
            "-n",
            MODEL,
            "-d",
            _device(),
            "--flac",
            "-o",
            tmp,
            str(audio),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await proc.communicate()
        except asyncio.CancelledError:
            proc.kill()
            await proc.wait()
            raise
        if proc.returncode != 0:
            raise StemsUnavailableError(f"demucs exited {proc.returncode}: {stderr.decode(errors='replace')[-512:]}")
        out_dir = Path(tmp) / MODEL / audio.stem
        for name in STEM_NAMES:
            shutil.move(out_dir / f"{name}.flac", stems_dir / f"{name}.flac")
    return {name: stems_dir / f"{name}.flac" for name in STEM_NAMES}
