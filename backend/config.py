"""
Backend configuration for FastAPI application.

Environment variables and settings for the backend server.
"""

import logging
import shutil
from functools import lru_cache
from pathlib import Path

from platformdirs import user_config_path
from pydantic_settings import BaseSettings

_logger = logging.getLogger(__name__)

_APP_NAME = "com.starlib.Starlib"

# Directories used by previous versions that should be migrated.
_OLD_DIRS = [
    user_config_path("starlib"),  # Python backend (pre-rename)
    user_config_path("com.fstermann.starlib"),  # Tauri store (old identifier)
]


def _migrate_old_dirs(new_dir: Path) -> None:
    """Move files from legacy config directories into *new_dir*.

    Only copies files that don't already exist at the destination.
    Removes old directories after a successful migration.
    """
    for old_dir in _OLD_DIRS:
        if not old_dir.is_dir() or old_dir == new_dir:
            continue
        _logger.info("Migrating data from %s to %s", old_dir, new_dir)
        for src in old_dir.rglob("*"):
            if not src.is_file():
                continue
            dest = new_dir / src.relative_to(old_dir)
            if dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        shutil.rmtree(old_dir, ignore_errors=True)


# Platform-specific user config directory used when running as a bundled desktop app.
# ~/.config/com.starlib.Starlib/ on Linux,
# ~/Library/Application Support/com.starlib.Starlib/ on macOS,
# %LOCALAPPDATA%/com.starlib.Starlib/ on Windows.
_APP_CONFIG_DIR = user_config_path(_APP_NAME, ensure_exists=True)
_migrate_old_dirs(_APP_CONFIG_DIR)


class BackendSettings(BaseSettings):
    """Backend configuration settings."""

    # API Settings
    api_title: str = "Starlib API"
    api_version: str = "0.1.0"
    api_description: str = "Backend API for Starlib music management"

    # Server Settings
    host: str = "127.0.0.1"
    port: int = 8000
    # reload must be False in production (PyInstaller / Tauri sidecar) because the
    # reloader spawns a subprocess, which breaks inside a frozen binary.
    reload: bool = False

    # CORS Settings — the origin allowlist is a regex defined in
    # backend/main.py; see the comment there.
    cors_methods: list[str] = ["*"]
    cors_headers: list[str] = ["*"]

    # Cache Settings
    cache_dir: Path = _APP_CONFIG_DIR / ".cache"

    model_config = {
        "extra": "ignore",
        "env_prefix": "BACKEND_",
        # In development: load from .env at repo root, then from user config.env.
        # In production (Tauri sidecar): env vars are set by the Tauri shell plugin.
        "env_file": (".env", str(_APP_CONFIG_DIR / "config.env")),
    }


@lru_cache
def get_backend_settings() -> BackendSettings:
    """Get cached backend settings."""
    return BackendSettings()
