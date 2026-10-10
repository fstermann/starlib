"""Install and remove the app-managed Demucs used for Track Breakdown stems."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from backend.infra.breakdown import demucs_env

logger = logging.getLogger(__name__)


@dataclass
class SetupState:
    """Where stem separation setup stands.

    Attributes:
        status: ``missing``, ``installing``, ``ready`` or ``error``.
        stage: Current install step while installing.
        error: Failure message after an error.
        size_bytes: Disk used by the install.
    """

    status: str
    stage: str | None = None
    error: str | None = None
    size_bytes: int = 0


_task: asyncio.Task[None] | None = None
_stage: str | None = None
_error: str | None = None


def state() -> SetupState:
    """Return the current setup state."""
    if _task is not None and not _task.done():
        return SetupState(status="installing", stage=_stage)
    if demucs_env.is_installed():
        return SetupState(status="ready", size_bytes=demucs_env.size_bytes())
    if _error is not None:
        return SetupState(status="error", error=_error)
    return SetupState(status="missing")


def start_install() -> SetupState:
    """Start installing in the background unless already installing or installed."""
    global _task, _error
    if state().status in ("installing", "ready"):
        return state()
    _error = None
    _task = asyncio.create_task(_install())
    return state()


async def _install() -> None:
    global _stage, _error

    def on_stage(stage: str) -> None:
        global _stage
        _stage = stage

    try:
        await demucs_env.install(on_stage)
    except demucs_env.InstallError as exc:
        _error = str(exc)
    except Exception as exc:
        logger.exception("stem separation setup failed")
        _error = f"Setup failed: {exc}"
    finally:
        _stage = None


def remove() -> SetupState:
    """Delete the install.

    Returns:
        The state afterwards.

    Raises:
        RuntimeError: Setup is still running.
    """
    if state().status == "installing":
        raise RuntimeError("setup is still running")
    demucs_env.remove()
    return state()
