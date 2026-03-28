from functools import lru_cache

from platformdirs import user_config_path
from pydantic_settings import BaseSettings, SettingsConfigDict

# User config file written by the first-launch setup flow (desktop app)
_USER_CONFIG_FILE = user_config_path("starlib") / "config.env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_nested_delimiter="__",
        # Load from .env first (dev), then from the user config file (desktop app).
        # Later files win over earlier ones.
        env_file=(".env", str(_USER_CONFIG_FILE)),
        extra="ignore",
    )

    base_url: str = "https://api-v2.soundcloud.com"

    # Legacy manual token (deprecated - use client_id + client_secret instead)
    oauth_token: str = ""
    client_id: str = ""

    # OAuth 2.1 credentials (recommended)
    client_secret: str = ""
    soundcloud_redirect_uri: str = "http://localhost:3000/auth/soundcloud/callback"

    user_id: int = 0
    datadome_clientid: str = ""
    sc_a_id: str = ""

    proxy: str | None = None

    root_music_folder: str = "~/Music/tracks"

    weekly_archive_artists: str = ""
    """Weekly archive artist filtering (comma-separated permalinks)"""

    version: str = "1.0"

    def has_oauth_credentials(self) -> bool:
        """Check if OAuth credentials are configured for automatic token management."""
        return bool(self.client_id and self.client_secret)

    def has_manual_token(self) -> bool:
        """Check if manual OAuth token is configured (legacy method)."""
        return bool(self.oauth_token)


@lru_cache(maxsize=1)
def get_settings():
    return Settings()
