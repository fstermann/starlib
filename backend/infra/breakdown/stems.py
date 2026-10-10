"""Stem separation with Demucs, run as a subprocess in its own Python env.

Demucs needs PyTorch, which is too heavy to bundle with the backend, so it
lives in a separate environment: the app-managed install from
:mod:`demucs_env`, or the interpreter in ``STARLIB_DEMUCS_PYTHON``. The drums
stem is then split again into kick, snare and hats with DrumSep.
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

from backend.infra.audio.track_handler import _find_binary
from backend.infra.breakdown import demucs_env

MODEL = "htdemucs"
STEM_NAMES = ("drums", "bass", "other", "vocals")
DRUM_PART_NAMES = ("kick", "snare", "hats")
# DrumSep's sources per drum part. On electronic kicks DrumSep puts most of the
# kick in "toms", so both go to the kick; real toms are rare in techno.
_DRUMSEP_SOURCES = {"kick": ("bombo", "toms"), "snare": ("redoblante",), "hats": ("platillos",)}
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


def cached_drum_parts(stems_dir: Path) -> dict[str, Path] | None:
    """Return the drum parts in ``stems_dir`` if all of them exist.

    Args:
        stems_dir: Directory holding ``<part>.flac`` files.

    Returns:
        Part name to path, or ``None`` when any part is missing.
    """
    paths = {name: stems_dir / f"{name}.flac" for name in DRUM_PART_NAMES}
    return paths if all(p.exists() for p in paths.values()) else None


async def separate_drums(
    drums: Path,
    stems_dir: Path,
    on_progress: Callable[[float], None] = lambda _: None,
) -> dict[str, Path]:
    """Split the drums stem into kick, snare and hats, reusing cached parts.

    Args:
        drums: The drums stem.
        stems_dir: Destination directory for ``<part>.flac`` files.
        on_progress: Called with the fraction done, 0 to 1.

    Returns:
        Part name to FLAC path.

    Raises:
        StemsUnavailableError: Demucs or the drum model isn't set up, or
            separation failed.
    """
    cached = cached_drum_parts(stems_dir)
    if cached:
        return cached
    python = demucs_python()
    model_dir = demucs_env.drum_model_dir()
    if python is None or not (model_dir / f"{demucs_env.DRUM_MODEL}.th").exists():
        raise StemsUnavailableError("Drum separation isn't set up yet.")
    async with _separation_lock:
        with tempfile.TemporaryDirectory(dir=stems_dir.parent) as tmp:
            argv = [
                python, "-m", "demucs", "--repo", str(model_dir), "-n", demucs_env.DRUM_MODEL,
                "-d", _device(), "--flac", "-o", tmp, str(drums),
            ]  # fmt: skip
            stderr = await _run(argv, on_progress)
            out_dir = Path(tmp) / demucs_env.DRUM_MODEL / drums.stem
            if not out_dir.is_dir():
                raise StemsUnavailableError(f"drum separation failed: {stderr[-512:]}")
            for part, sources in _DRUMSEP_SOURCES.items():
                await _mix([out_dir / f"{s}.flac" for s in sources], stems_dir / f"{part}.flac")
    return {name: stems_dir / f"{name}.flac" for name in DRUM_PART_NAMES}


async def _mix(sources: list[Path], out: Path) -> None:
    """Sum ``sources`` sample by sample into the FLAC ``out``."""
    inputs = [arg for source in sources for arg in ("-i", str(source))]
    mix = ["-filter_complex", f"amix=inputs={len(sources)}:normalize=0"] if len(sources) > 1 else []
    proc = await asyncio.create_subprocess_exec(
        _find_binary("ffmpeg"), "-v", "error", "-y", *inputs, *mix, "-c:a", "flac", str(out),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )  # fmt: skip
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise StemsUnavailableError(f"ffmpeg couldn't write {out.name}: {stderr.decode(errors='replace')[-256:]}")


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
