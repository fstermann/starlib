"""OAuth 2.1 authentication manager for SoundCloud API.

Implements Client Credentials flow with automatic token refresh and caching.
"""

import base64
import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TypedDict

import requests

logger = logging.getLogger(__name__)


class TokenData(TypedDict):
    """OAuth token data structure."""

    access_token: str
    refresh_token: str | None
    expires_at: str  # ISO format timestamp
    token_type: str
    scope: str


class OAuthManager:
    """Manages OAuth 2.1 authentication with automatic token refresh.

    Supports Client Credentials flow for accessing public SoundCloud resources.
    Tokens are cached locally and automatically refreshed before expiry.

    Parameters
    ----------
    client_id : str
        SoundCloud app client ID
    client_secret : str
        SoundCloud app client secret
    cache_file : Path | None
        Optional custom cache file path
    """

    TOKEN_URL = "https://secure.soundcloud.com/oauth/token"
    CACHE_FILE = Path(".oauth_cache.json")
    REFRESH_BUFFER = timedelta(minutes=5)  # Refresh 5 minutes before expiry

    def __init__(self, client_id: str, client_secret: str, cache_file: Path | None = None):
        self.client_id = client_id
        self.client_secret = client_secret
        self.cache_file = cache_file or self.CACHE_FILE
        self._token_data: TokenData | None = None

        # Try to load cached token
        self._load_cache()

    def _load_cache(self) -> None:
        """Load cached token from file if available and valid."""
        if not self.cache_file.exists():
            return

        try:
            with open(self.cache_file) as f:
                self._token_data = json.load(f)
                logger.info("Loaded cached OAuth token")
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"Failed to load token cache: {e}")
            self._token_data = None

    def _save_cache(self) -> None:
        """Save current token to cache file."""
        if not self._token_data:
            return

        try:
            with open(self.cache_file, "w") as f:
                json.dump(self._token_data, f, indent=2)
            logger.info("Saved OAuth token to cache")
        except OSError as e:
            logger.warning(f"Failed to save token cache: {e}")

    def _is_token_expired(self) -> bool:
        """Check if current token is expired or will expire soon."""
        if not self._token_data:
            return True

        try:
            expires_at = datetime.fromisoformat(self._token_data["expires_at"])
            return datetime.now(UTC) >= (expires_at - self.REFRESH_BUFFER)
        except (KeyError, ValueError):
            return True

    def _create_basic_auth_header(self) -> str:
        """Create Basic Authorization header for token requests."""
        credentials = f"{self.client_id}:{self.client_secret}"
        encoded = base64.b64encode(credentials.encode()).decode()
        return f"Basic {encoded}"

    def _request_client_credentials_token(self) -> TokenData:
        """Request new token using Client Credentials flow.

        Returns
        -------
        TokenData
            Token data including access_token and expiration
        """
        logger.info("Requesting new OAuth token via Client Credentials flow")

        headers = {
            "accept": "application/json; charset=utf-8",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": self._create_basic_auth_header(),
        }

        data = {"grant_type": "client_credentials"}

        response = requests.post(self.TOKEN_URL, headers=headers, data=data)
        response.raise_for_status()

        token_response = response.json()

        # Calculate expiration time
        expires_in = token_response.get("expires_in", 3600)  # Default 1 hour
        expires_at = datetime.now(UTC) + timedelta(seconds=expires_in)

        token_data: TokenData = {
            "access_token": token_response["access_token"],
            "refresh_token": token_response.get("refresh_token"),
            "expires_at": expires_at.isoformat(),
            "token_type": token_response.get("token_type", "Bearer"),
            "scope": token_response.get("scope", ""),
        }

        logger.info(f"Successfully obtained OAuth token (expires: {expires_at})")
        return token_data

    def _refresh_token(self) -> TokenData:
        """Refresh access token using refresh token.

        Returns
        -------
        TokenData
            New token data

        Raises
        ------
        ValueError
            If no refresh token available
        """
        if not self._token_data or not self._token_data.get("refresh_token"):
            raise ValueError("No refresh token available")

        logger.info("Refreshing OAuth token")

        headers = {
            "accept": "application/json; charset=utf-8",
            "Content-Type": "application/x-www-form-urlencoded",
        }

        data = {
            "grant_type": "refresh_token",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "refresh_token": self._token_data["refresh_token"],
        }

        response = requests.post(self.TOKEN_URL, headers=headers, data=data)
        response.raise_for_status()

        token_response = response.json()

        # Calculate expiration time
        expires_in = token_response.get("expires_in", 3600)
        expires_at = datetime.now(UTC) + timedelta(seconds=expires_in)

        token_data: TokenData = {
            "access_token": token_response["access_token"],
            "refresh_token": token_response.get("refresh_token", self._token_data["refresh_token"]),
            "expires_at": expires_at.isoformat(),
            "token_type": token_response.get("token_type", "Bearer"),
            "scope": token_response.get("scope", ""),
        }

        logger.info(f"Successfully refreshed OAuth token (expires: {expires_at})")
        return token_data

    def get_access_token(self) -> str:
        """Get valid access token, refreshing if necessary.

        Returns:
            Valid access token

        Raises:
            ValueError: If no token could be obtained
            requests.HTTPError: If token request/refresh fails
        """
        # Check if we need a new token
        if self._is_token_expired():
            try:
                # Try to refresh if we have a refresh token
                if self._token_data and self._token_data.get("refresh_token"):
                    self._token_data = self._refresh_token()
                else:
                    # Request new token
                    self._token_data = self._request_client_credentials_token()
                self._save_cache()
            except requests.HTTPError as e:
                # If refresh fails, try getting a new token
                if e.response and e.response.status_code in (401, 400):
                    logger.warning("Token refresh failed, requesting new token")
                    self._token_data = self._request_client_credentials_token()
                    self._save_cache()
                else:
                    raise

        if not self._token_data:
            raise ValueError("Failed to obtain access token")
        return self._token_data["access_token"]

    def invalidate_cache(self) -> None:
        """Invalidate cached token and remove cache file."""
        self._token_data = None
        if self.cache_file.exists():
            self.cache_file.unlink()
            logger.info("Invalidated OAuth token cache")
