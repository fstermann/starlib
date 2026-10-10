"""A self-contained Demucs install that the app sets up and removes on request.

Everything lives under ``<cache_dir>/demucs``: a ``uv`` binary (a
system ``uv`` is used when present), a uv-managed Python, a venv with
PyTorch + Demucs, and the Hugging Face cache holding the model weights. No
system Python is needed. Removing the folder frees all of it.
"""

from __future__ import annotations

import asyncio
import io
import os
import platform
import shutil
import tarfile
from collections.abc import Callable
from pathlib import Path

import httpx

from backend.config import get_backend_settings

MODEL = "htdemucs"
PYTHON_VERSION = "3.12"
PACKAGES = ("demucs", "soundfile")
_UV_URL = "https://github.com/astral-sh/uv/releases/latest/download/uv-{arch}-apple-darwin.tar.gz"
_UV_CANDIDATES = ("/opt/homebrew/bin/uv", "/usr/local/bin/uv", str(Path.home() / ".local/bin/uv"))


class InstallError(RuntimeError):
    """Raised when a setup step fails."""


def root() -> Path:
    """Folder holding the whole install."""
    return get_backend_settings().cache_dir / "demucs"


def python_path() -> Path:
    """Interpreter of the Demucs venv."""
    return root() / "env" / "bin" / "python"


def _ready_marker() -> Path:
    return root() / ".ready"


def is_installed() -> bool:
    """Whether setup finished, including the model download."""
    return _ready_marker().exists() and python_path().exists()


def size_bytes() -> int:
    """Disk used by the install."""
    if not root().exists():
        return 0
    return sum(p.stat().st_size for p in root().rglob("*") if p.is_file() and not p.is_symlink())


def environment() -> dict[str, str]:
    """Environment for running the install's Python, keeping caches inside it."""
    return {
        **os.environ,
        "HF_HOME": str(root() / "hf"),
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TORCH_HOME": str(root() / "torch"),
    }


def remove() -> None:
    """Delete the install."""
    shutil.rmtree(root(), ignore_errors=True)


async def install(on_stage: Callable[[str], None]) -> None:
    """Set up uv, Python, PyTorch + Demucs and the model, skipping finished steps.

    A failing step raises :class:`InstallError`.

    Args:
        on_stage: Called with ``uv``, ``python``, ``packages`` and ``model``.
    """
    root().mkdir(parents=True, exist_ok=True)
    on_stage("uv")
    uv = await _uv()
    uv_env = {
        **environment(),
        "UV_PYTHON_INSTALL_DIR": str(root() / "python"),
        "UV_PYTHON_PREFERENCE": "only-managed",
        "UV_NO_CACHE": "1",
    }
    on_stage("python")
    if not python_path().exists():
        await _run([uv, "venv", "--python", PYTHON_VERSION, str(root() / "env")], uv_env)
    on_stage("packages")
    await _run([uv, "pip", "install", "--python", str(python_path()), *PACKAGES], uv_env)
    on_stage("model")
    await _run(
        [str(python_path()), "-c", f"from demucs.pretrained import get_model; get_model({MODEL!r})"],
        environment(),
    )
    _ready_marker().touch()


async def _uv() -> str:
    """Return a uv binary, downloading the standalone build if none is installed."""
    for candidate in (shutil.which("uv"), *_UV_CANDIDATES):
        if candidate and Path(candidate).exists():
            return candidate
    bundled = root() / "uv"
    if bundled.exists():
        return str(bundled)
    arch = "aarch64" if platform.machine() == "arm64" else "x86_64"
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=120) as client:
            response = await client.get(_UV_URL.format(arch=arch))
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise InstallError(f"Couldn't download uv: {exc}") from exc
    with tarfile.open(fileobj=io.BytesIO(response.content), mode="r:gz") as archive:
        member = next(m for m in archive.getmembers() if m.name.endswith("/uv"))
        extracted = archive.extractfile(member)
        assert extracted is not None
        bundled.write_bytes(extracted.read())
    bundled.chmod(0o755)
    return str(bundled)


async def _run(argv: list[str], env: dict[str, str]) -> None:
    proc = await asyncio.create_subprocess_exec(
        *argv, env=env, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    try:
        _, stderr = await proc.communicate()
    except BaseException:
        proc.kill()
        await proc.wait()
        raise
    if proc.returncode != 0:
        raise InstallError(f"{Path(argv[0]).name} failed: {stderr.decode(errors='replace')[-400:]}")
