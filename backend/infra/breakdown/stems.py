"""Stem separation with Demucs, run as a subprocess in its own Python env.

Demucs needs PyTorch, which is too heavy to bundle with the backend, so it
lives in a separate environment: the app-managed install from
:mod:`demucs_env`, or the interpreter in ``STARLIB_DEMUCS_PYTHON``.
"""

from __future__ import annotations

import asyncio
import os
import platform
import re
import shutil
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

from backend.infra.breakdown import demucs_env

MODEL = "htdemucs"
STEM_NAMES = ("drums", "bass", "other", "vocals")
# Demucs reports progress as tqdm bars on stderr, e.g. " 45%|████     |".
_PERCENT = re.compile(rb"(\d{1,3})%\|")

# Demucs saturates the GPU; running two at once only slows both down.
_separation_lock = asyncio.Lock()


class StemsUnavailableError(RuntimeError):
    """Raised when no Demucs environment is configured or separation fails."""


def demucs_python() -> str | None:
    """Return the Demucs interpreter, if one is set up."""
    if override := os.environ.get("STARLIB_DEMUCS_PYTHON"):
        return str(Path(override).expanduser())
    return str(demucs_env.python_path()) if demucs_env.is_installed() else None


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


async def separate(
    audio: Path,
    stems_dir: Path,
    on_progress: Callable[[float], None] = lambda _: None,
) -> dict[str, Path]:
    """Split ``audio`` into stems, reusing ``stems_dir`` when already populated.

    Args:
        audio: Source audio file.
        stems_dir: Destination directory for ``<stem>.flac`` files.
        on_progress: Called with the fraction done, 0 to 1.

    Returns:
        Stem name to FLAC path.

    Raises:
        StemsUnavailableError: Demucs isn't configured or exited with an error.
    """
    cached = cached_stems(stems_dir)
    if cached:
        return cached
    python = demucs_python()
    if python is None:
        raise StemsUnavailableError("Stem separation isn't set up yet.")
    stems_dir.mkdir(parents=True, exist_ok=True)
    async with _separation_lock:
        with tempfile.TemporaryDirectory(dir=stems_dir.parent) as tmp:
            argv = [python, "-m", "demucs", "-n", MODEL, "-d", _device(), "--flac", "-o", tmp, str(audio)]
            stderr = await _run(argv, on_progress)
            out_dir = Path(tmp) / MODEL / audio.stem
            if not out_dir.is_dir():
                raise StemsUnavailableError(f"demucs failed: {stderr[-512:]}")
            for name in STEM_NAMES:
                shutil.move(out_dir / f"{name}.flac", stems_dir / f"{name}.flac")
    return {name: stems_dir / f"{name}.flac" for name in STEM_NAMES}


async def _run(argv: list[str], on_progress: Callable[[float], None]) -> str:
    """Run demucs, reporting its progress; kill it if the task is cancelled."""
    proc = await asyncio.create_subprocess_exec(
        *argv, env=demucs_env.environment(), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    assert proc.stderr is not None
    output = bytearray()
    try:
        while chunk := await proc.stderr.read(4096):
            output += chunk
            if percents := _PERCENT.findall(chunk):
                on_progress(min(int(percents[-1]), 100) / 100)
        await proc.wait()
    except BaseException:
        proc.kill()
        await proc.wait()
        raise
    if proc.returncode != 0:
        raise StemsUnavailableError(f"demucs exited {proc.returncode}: {output.decode(errors='replace')[-512:]}")
    return output.decode(errors="replace")
