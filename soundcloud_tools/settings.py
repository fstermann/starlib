from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_nested_delimiter="__", env_file=".env")

    base_url: str = "https://api.soundcloud.com"

    # OAuth tokens - support both naming conventions
    oauth_token: str = ""
    soundcloud_oauth_token: str = ""  # Alternative: SOUNDCLOUD_OAUTH_TOKEN
    soundcloud_access_token: str = ""  # Alternative: SOUNDCLOUD_ACCESS_TOKEN
    refresh_token: str = ""
    soundcloud_refresh_token: str = ""  # Alternative: SOUNDCLOUD_REFRESH_TOKEN

    # Client credentials - support both naming conventions
    client_id: str = ""
    soundcloud_client_id: str = ""  # Alternative: SOUNDCLOUD_CLIENT_ID
    client_secret: str = ""
    soundcloud_client_secret: str = ""  # Alternative: SOUNDCLOUD_CLIENT_SECRET

    user_id: int = 0
    datadome_clientid: str = ""
    sc_a_id: str = ""

    proxy: str | None = None

    root_music_folder: str = "~/Music/tracks"

    weekly_archive_artists: str = ""
    """Weekly archive artist filtering (comma-separated permalinks)"""

    version: str = "1.0"

    @property
    def access_token(self) -> str:
        """Get access token from any supported env var name"""
        return self.soundcloud_access_token or self.soundcloud_oauth_token or self.oauth_token

    @property
    def user_refresh_token(self) -> str:
        """Get refresh token from any supported env var name"""
        return self.soundcloud_refresh_token or self.refresh_token

    @property
    def effective_client_id(self) -> str:
        """Get client ID from any supported env var name"""
        return self.soundcloud_client_id or self.client_id

    @property
    def effective_client_secret(self) -> str:
        """Get client secret from any supported env var name"""
        return self.soundcloud_client_secret or self.client_secret


@lru_cache(maxsize=1)
def get_settings():
    return Settings()
