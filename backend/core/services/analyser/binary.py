"""Locate the ``analyser-stream`` Rust subprocess binary.

The binary is built from ``starlib_audio/`` and lives under the cargo
``target/`` directory in dev, or alongside the bundled FastAPI sidecar in a
PyInstaller build. Mirrors :func:`backend.core.services.metadata._find_ffmpeg`'s
search strategy.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_BINARY_NAME = "analyser-stream"

# Cargo target directories (in priority order) used in dev. Only the workspace
# target is checked — desktop/src-tauri/target is for Tauri's own crate.
_DEV_CANDIDATES = ("target/release", "target/debug")


def _repo_root() -> Path | None:
    # Walk up from this file until we find the workspace ``Cargo.toml``.
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").exists() and (parent / "starlib_audio").is_dir():
            return parent
    return None


def find_analyser_binary() -> str:
    """Return the path to ``analyser-stream``.

    Priority:
    1. ``STARLIB_ANALYSER_BIN`` env var (test override / packaging escape hatch).
    2. PyInstaller bundle dir when running as a frozen sidecar.
    3. Cargo workspace ``target/release`` / ``target/debug``.
    4. Whatever ``shutil.which`` finds on PATH.

    Returns
    -------
    str
        Resolved binary path. Caller still gets to handle a non-zero exit if
        the binary turns out to be missing — we don't pre-validate executable
        bits to keep this function side-effect free.
    """
    override = os.environ.get("STARLIB_ANALYSER_BIN")
    if override:
        return override

    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / _BINARY_NAME  # type: ignore[attr-defined]
        if bundled.exists():
            return str(bundled)

    repo = _repo_root()
    if repo is not None:
        for sub in _DEV_CANDIDATES:
            cand = repo / sub / _BINARY_NAME
            if cand.exists():
                return str(cand)

    found = shutil.which(_BINARY_NAME)
    if found:
        return found

    # Final fallback: hand back the bare name and let the subprocess call
    # surface the FileNotFoundError to the API layer with a useful message.
    logger.warning("analyser-stream binary not found on PATH; will retry at job start")
    return _BINARY_NAME
