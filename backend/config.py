"""
Backend configuration for FastAPI application.

Environment variables and settings for the backend server.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


class BackendSettings(BaseSettings):
    """Backend configuration settings."""

    # API Settings
    api_title: str = "Starlib API"
    api_version: str = "0.1.0"
    api_description: str = "Backend API for Starlib music management"

    # Server Settings
    host: str = "127.0.0.1"
    port: int = 8000
    reload: bool = True  # Development only

    # CORS Settings
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    cors_credentials: bool = True
    cors_methods: list[str] = ["*"]
    cors_headers: list[str] = ["*"]

    # Music Library Settings (from main settings)
    root_music_folder: Path = Path.home() / "Music"

    # Cache Settings
    cache_dir: Path = Path(__file__).parent.parent.parent / ".cache"

    model_config = {
        "extra": "ignore",
        "env_prefix": "BACKEND_",
        "env_file": ".env",
    }


@lru_cache
def get_backend_settings() -> BackendSettings:
    """Get cached backend settings."""
    return BackendSettings()
