"""
Backend configuration for FastAPI application.

Environment variables and settings for the backend server.
"""

from functools import lru_cache
from pathlib import Path

from platformdirs import user_config_path
from pydantic_settings import BaseSettings

# Platform-specific user config directory used when running as a bundled desktop app.
# ~/.config/starlib/ on Linux, ~/Library/Application Support/starlib/ on macOS,
# %LOCALAPPDATA%/starlib/ on Windows.
_APP_CONFIG_DIR = user_config_path("starlib", ensure_exists=True)


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

    # CORS Settings — in production only the Tauri webview origin is needed.
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000", "tauri://localhost"]
    cors_credentials: bool = True
    cors_methods: list[str] = ["*"]
    cors_headers: list[str] = ["*"]

    # Music Library Settings (from main settings)
    root_music_folder: Path = Path.home() / "Music"

    # Cache Settings
    cache_dir: Path = _APP_CONFIG_DIR / ".cache"

    model_config = {
        "extra": "ignore",
        "env_prefix": "BACKEND_",
        # In development: load from .env at repo root.
        # In production (Tauri sidecar): env vars are set by the Tauri shell plugin.
        "env_file": ".env",
    }


@lru_cache
def get_backend_settings() -> BackendSettings:
    """Get cached backend settings."""
    return BackendSettings()
