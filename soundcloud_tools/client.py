# mypy: disable-error-code="empty-body"
import base64
import json
import logging
import re
import time
import urllib.parse as urlparse
import warnings
from collections.abc import Callable
from typing import Any

import requests
from pydantic import BaseModel, Field, TypeAdapter
from starlette.routing import compile_path

from soundcloud_tools import models as scm
from soundcloud_tools.models.playlist import PlaylistUpdateImageRequest, PlaylistUpdateImageResponse, UserPlaylists
from soundcloud_tools.models.request import PlaylistCreateRequest
from soundcloud_tools.settings import get_settings
from soundcloud_tools.utils import chunk_list, generate_random_user_agent, get_default_kwargs

logger = logging.getLogger(__name__)
warnings.filterwarnings("ignore", message="Unverified HTTPS request is being made")


class SplitParams(BaseModel):
    client: Any
    path_params: dict = Field(default_factory=dict)
    query_params: dict = Field(default_factory=dict)
    data: dict | None = None
    content: str | None = None
    kwargs: dict = Field(default_factory=dict)

    @classmethod
    async def from_route(cls, client: Any, endpoint: Callable, path: str, **kwargs):
        full_kwargs = get_default_kwargs(endpoint) | kwargs
        params = cls(client=client)

        additional_params = await endpoint(client, **kwargs) or {}
        _, _, path_param_names = compile_path(path)
        expected_path_params = set(path_param_names)

        params.kwargs = full_kwargs.pop("kwargs", {})
        # Use kwargs defined in endpoint
        params.kwargs.update(additional_params.pop("kwargs", {}))
        params.data = full_kwargs.pop("data", None) or additional_params.get("data")
        if params.data and (data_type := endpoint.__annotations__.get("data")):
            # Store the data as a JSON String, in order to get the validation
            # benefits from the TypeAdapter
            params.content = TypeAdapter(data_type).dump_json(params.data)
        params.path_params = {k: v for k, v in full_kwargs.items() if k in expected_path_params}
        params.query_params = {k: v for k, v in full_kwargs.items() if k not in expected_path_params}
        params.query_params.update(additional_params.get("query", {}))
        # If query params are passed as a dict, move them to the query_params
        params.query_params.update(params.query_params.pop("params", {}))
        return params


def route(method: str, path: str, response_model: BaseModel | None = None):
    def wrapper(endpoint_func):
        async def caller(self, **kwargs):
            split_params = await SplitParams.from_route(client=self, endpoint=endpoint_func, path=path, **kwargs)
            url = self.make_url(path, **split_params.path_params)
            params = self.json_dump(split_params.query_params)
            logger.info(f"Making request to {url}")
            logger.info(f"Content: {split_params.content}")
            # Set Content-Type header for JSON data
            request_kwargs = split_params.kwargs.copy()
            if split_params.content:
                request_kwargs.setdefault("headers", {})
                request_kwargs["headers"]["Content-Type"] = "application/json"

            response = await self.make_request(
                method,
                url,
                data=split_params.content,
                params=params,
                **request_kwargs,
            )
            try:
                response_data = response.json()
            except json.decoder.JSONDecodeError:
                logger.error(f"Failed to decode response (status: {response.status_code})\n{response.content}")
                return
            if not response_model:
                return response_data
            return TypeAdapter(response_model).validate_python(response_data)

        return caller

    return wrapper


class Client:
    def __init__(self, base_url: str = get_settings().base_url):
        self.base_url = base_url
        settings = get_settings()
        self._access_token = settings.access_token
        self._refresh_token = settings.user_refresh_token or None
        self._token_expires_at = 0

        # User OAuth tokens use "OAuth" prefix, Client Credentials use "Bearer"
        self._token_type = "OAuth" if self._refresh_token else "Bearer"

        # If user token provided, assume it's valid (will refresh if needed)
        # Otherwise use Client Credentials Flow
        if not self._access_token and settings.effective_client_id and settings.effective_client_secret:
            self._authenticate()

        self.headers = {
            "Authorization": f"{self._token_type} {self._access_token}",
            # "User-Agent": generate_random_user_agent(),
        }
        self.params = {}
        self.proxies = {"https://": "https://" + get_settings().proxy} if get_settings().proxy else {}

    def _authenticate(self):
        """Authenticate using Client Credentials Flow"""
        settings = get_settings()

        # Encode client_id:client_secret in base64 for Basic Authentication
        credentials = f"{settings.effective_client_id}:{settings.effective_client_secret}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()

        auth_headers = {
            "accept": "application/json; charset=utf-8",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {encoded_credentials}",
        }

        data = {"grant_type": "client_credentials"}

        logger.info("Authenticating with Client Credentials Flow")
        response = requests.post(
            "https://secure.soundcloud.com/oauth/token",
            headers=auth_headers,
            data=data,
            verify=False,
        )

        if response.status_code != 200:
            logger.error(f"Authentication failed: {response.status_code} - {response.text}")
            raise Exception(f"Failed to authenticate: {response.text}")

        token_data = response.json()
        logger.info(f"Authentication response: {token_data}")
        self._access_token = token_data.get("access_token")
        self._refresh_token = token_data.get("refresh_token")
        self._token_type = token_data.get("token_type", "Bearer")
        expires_in = token_data.get("expires_in", 3600)
        self._token_expires_at = time.time() + expires_in

        logger.info("Successfully authenticated with SoundCloud API")

    def _refresh_access_token(self):
        """Refresh the access token using the refresh token"""
        if not self._refresh_token:
            logger.warning("No refresh token available, re-authenticating")
            self._authenticate()
            return

        settings = get_settings()

        auth_headers = {
            "accept": "application/json; charset=utf-8",
            "Content-Type": "application/x-www-form-urlencoded",
        }

        data = {
            "grant_type": "refresh_token",
            "client_id": settings.effective_client_id,
            "client_secret": settings.effective_client_secret,
            "refresh_token": self._refresh_token,
        }

        logger.info("Refreshing access token")
        response = requests.post(
            "https://secure.soundcloud.com/oauth/token",
            headers=auth_headers,
            data=data,
            verify=False,
        )

        if response.status_code != 200:
            logger.error(f"Token refresh failed: {response.status_code} - {response.text}")
            # If refresh fails, try to re-authenticate
            self._authenticate()
            return

        token_data = response.json()
        self._access_token = token_data.get("access_token")
        self._refresh_token = token_data.get("refresh_token")
        expires_in = token_data.get("expires_in", 3600)
        self._token_expires_at = time.time() + expires_in

        logger.info("Successfully refreshed access token")

    def _ensure_valid_token(self):
        """Ensure the access token is valid, refresh if needed"""
        # Check if token is about to expire (with 60 second buffer)
        if time.time() >= (self._token_expires_at - 60):
            logger.info("Token expired or about to expire, refreshing")
            self._refresh_access_token()
            # Update the Authorization header with the new token
            self.headers["Authorization"] = f"OAuth {self._access_token}"

    def get_auth_status(self) -> dict[str, Any]:
        """Get current authentication status information"""
        settings = get_settings()

        # Determine auth method
        if settings.access_token:
            auth_method = "User OAuth Token (write enabled)" if self._refresh_token else "Manual OAuth Token"
        elif settings.effective_client_id and settings.effective_client_secret:
            auth_method = "Auto (Client Credentials - read only)"
        else:
            auth_method = "Not Configured"

        # Calculate time until expiration
        time_until_expiry = None
        if self._token_expires_at > 0:
            remaining = self._token_expires_at - time.time()
            if remaining > 0:
                time_until_expiry = int(remaining)

        return {
            "auth_method": auth_method,
            "has_access_token": bool(self._access_token),
            "has_refresh_token": bool(self._refresh_token),
            "token_expires_at": self._token_expires_at if self._token_expires_at > 0 else None,
            "time_until_expiry_seconds": time_until_expiry,
            "client_id": settings.effective_client_id[:8] + "..." if settings.effective_client_id else None,
        }

    def json_dump(self, data: Any):
        return data if not isinstance(data, BaseModel) else data.model_dump(mode="json")

    async def make_request(self, method: str, url: str, **kwargs):
        # Ensure token is valid before making request
        self._ensure_valid_token()

        kwargs["params"] = kwargs.get("params", {}) | self.params
        kwargs["headers"] = kwargs.get("headers", {}) | self.headers
        if get_settings().proxy:
            kwargs.setdefault("proxies", self.proxies)
        kwargs.setdefault("verify", False)
        logger.info(f"Making request {method} {url}")
        logger.info(f"Request kwargs: {kwargs}")
        response = requests.request(method, url, **kwargs)
        logger.info(f"Response {response.status_code} for {method} {response.url}")
        if response.status_code >= 400:
            logger.error("\n" * 3)
            logger.error(f"Error response: {response.status_code} - {response.text}")
            logger.error("\n" * 3)
            # Raise exception for HTTP errors
            response.raise_for_status()
        return response

    def _make_request(self, *arg, **kwargs):
        return self.make_request(*arg, **kwargs)

    def make_url(self, path: str, **path_params: str) -> str:
        return f"{self.base_url}/{path.format(**path_params)}"

    @staticmethod
    def get_next_offset(href: str | None) -> str | None:
        if not href:
            return None
        parsed = urlparse.urlparse(href)
        query_params = urlparse.parse_qs(parsed.query)
        # Try cursor first (used by likes endpoint), then fall back to offset
        cursor = query_params.get("cursor")
        if cursor:
            return cursor[0]
        offset = query_params.get("offset")
        return offset[0] if offset else None

    async def get_track_id(self, url: str) -> int | None:
        regex = r'content="soundcloud://sounds:(\d+)"'
        response = await self.make_request("GET", url)
        match = re.search(regex, response.text)
        return int(match.group(1)) if match else None

    @route("POST", "playlists", response_model=scm.Playlist)
    async def post_playlist(self, data: PlaylistCreateRequest) -> scm.Playlist: ...

    async def get_playlist(
        self,
        playlist_urn: str | None = None,
        playlist_id: int | None = None,
        show_tracks: bool = True,
        secret_token: str | None = None,
    ) -> scm.Playlist:
        """Get a playlist by URN or ID (backward compatible)"""
        # Convert playlist_id to playlist_urn for backward compatibility
        if playlist_id is not None and playlist_urn is None:
            playlist_urn = f"soundcloud:playlists:{playlist_id}"
        elif playlist_urn is None:
            raise ValueError("Either playlist_urn or playlist_id must be provided")

        url = self.make_url("playlists/{playlist_urn}", playlist_urn=playlist_urn)
        params = {"show_tracks": show_tracks}
        if secret_token:
            params["secret_token"] = secret_token
        response = await self.make_request("GET", url, params=params)

        try:
            response_data = response.json()
        except json.decoder.JSONDecodeError:
            logger.error(f"Failed to decode response (status: {response.status_code})\n{response.content}")
            return None

        return TypeAdapter(scm.Playlist).validate_python(response_data)

    async def get_user_likes(
        self,
        user_urn: str | None = None,
        user_id: int | None = None,
        limit: int = 100,
        offset: str | None = None,  # Can be either cursor or offset depending on API
        linked_partitioning: bool = True,
    ):
        """Get user's liked tracks by URN or ID (backward compatible)

        Note: The API uses cursor-based pagination for this endpoint.
        The offset parameter will be used as 'cursor' if provided.
        """
        # Convert user_id to user_urn for backward compatibility
        if user_id is not None and user_urn is None:
            user_urn = f"soundcloud:users:{user_id}"
        elif user_urn is None:
            raise ValueError("Either user_urn or user_id must be provided")

        url = self.make_url("users/{user_urn}/likes/tracks", user_urn=user_urn)
        params = {"linked_partitioning": linked_partitioning}

        # Use page_size instead of limit for cursor-based pagination
        if limit:
            params["page_size"] = limit

        # The API uses cursor parameter for pagination, not offset
        if offset:
            params["cursor"] = offset

        response = await self.make_request("GET", url, params=params)

        try:
            response_data = response.json()
        except json.decoder.JSONDecodeError:
            logger.error(f"Failed to decode response (status: {response.status_code})\n{response.content}")
            return None

        # API returns Tracks collection, not Likes
        return TypeAdapter(scm.Tracks).validate_python(response_data)

    @route("GET", "users/{user_urn}/comments", response_model=scm.Comments)
    async def get_user_comments(
        self,
        user_urn: str,
        limit: int = 100,
        offset: str | None = None,
        linked_partitioning: bool = True,
        threaded: int = 0,
    ): ...

    @route("GET", "stream/users/{user_urn}/reposts", response_model=scm.Reposts)
    async def get_user_reposts(
        self,
        user_urn: str,
        limit: int = 100,
        offset: str | None = None,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "users/{user_urn}/followings/ids", response_model=scm.Followings)
    async def get_user_followings_ids(self, user_urn: str, limit: int = 5000, linked_partitioning: bool = True): ...

    @route("GET", "users/{user_urn}/followers/ids")
    async def get_user_followers_ids(self, user_urn: str, limit: int = 5000, linked_partitioning: bool = True): ...

    async def get_track(
        self,
        track_urn: str | None = None,
        track_id: int | None = None,
        secret_token: str | None = None,
    ) -> scm.Track:
        """Get a track by URN or ID (backward compatible)"""
        # Convert track_id to track_urn for backward compatibility
        if track_id is not None and track_urn is None:
            track_urn = f"soundcloud:tracks:{track_id}"
        elif track_urn is None:
            raise ValueError("Either track_urn or track_id must be provided")

        url = self.make_url("tracks/{track_urn}", track_urn=track_urn)
        params = {"secret_token": secret_token} if secret_token else {}
        response = await self.make_request("GET", url, params=params)

        try:
            response_data = response.json()
        except json.decoder.JSONDecodeError:
            logger.error(f"Failed to decode response (status: {response.status_code})\n{response.content}")
            return None

        return TypeAdapter(scm.Track).validate_python(response_data)

    @route("GET", "stream", response_model=scm.Stream)
    async def get_stream(
        self,
        user_urn: str,
        sc_a_id: str = get_settings().sc_a_id,
        promoted_playlist: bool = True,
        limit: int = 100,
        offset: int = 0,
        linked_partitioning: bool = True,
    ): ...

    # Search endpoints - according to official API, search is now split into separate endpoints
    @route("GET", "tracks", response_model=scm.Tracks)
    async def search_tracks(
        self,
        q: str | None = None,
        ids: str | None = None,
        urns: str | None = None,
        genres: str | None = None,
        tags: str | None = None,
        bpm: dict | None = None,
        duration: dict | None = None,
        created_at: dict | None = None,
        access: str | None = None,
        limit: int = 50,
        offset: int = 0,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "playlists", response_model=scm.Playlists)
    async def search_playlists(
        self,
        q: str | None = None,
        access: str | None = None,
        show_tracks: bool = False,
        limit: int = 50,
        offset: int = 0,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "users", response_model=scm.Users)
    async def search_users(
        self,
        q: str | None = None,
        ids: str | None = None,
        urns: str | None = None,
        limit: int = 50,
        offset: int = 0,
        linked_partitioning: bool = True,
    ): ...

    async def search(self, q: str, limit: int = 20, offset: int = 0):
        """
        DEPRECATED: Use search_tracks(), search_playlists(), or search_users() instead.

        Legacy search method that searches tracks, playlists, and users.
        For backward compatibility, this returns tracks by default.
        """
        logger.warning("search() is deprecated. Use search_tracks(), search_playlists(), or search_users() instead.")
        return await self.search_tracks(q=q, limit=limit, offset=offset)

    @route("GET", "me", response_model=scm.Me)
    async def get_me(self) -> scm.Me: ...

    @route("GET", "me/artist-shortcuts", response_model=scm.ArtistShortcuts)
    async def get_artist_shortcuts(
        self, limit: int = 1000, offset: str | None = None, linked_partitioning: bool = True
    ) -> scm.ArtistShortcuts: ...

    @route("GET", "me/artist-shortcuts/stories/{user_urn}", response_model=scm.ArtistShortcutStories)
    async def get_artist_shortcut_stories(self, user_urn: str) -> scm.ArtistShortcutStories: ...

    @route("PUT", "playlists/{playlist_urn}/artwork", response_model=PlaylistUpdateImageResponse)
    async def update_playlist_image(self, playlist_urn: str, data: PlaylistUpdateImageRequest): ...

    @route("GET", "users/{user_urn}/playlists_without_albums", response_model=UserPlaylists)
    async def get_user_playlists(
        self,
        user_urn: str,
        offset: int = 0,
        limit: int = 12,
        linked_partitioning: bool = True,
    ) -> UserPlaylists: ...

    @route("GET", "tracks", response_model=scm.Tracks)
    async def get_tracks(
        self,
        ids: str | None = None,
        urns: str | None = None,
    ) -> scm.Tracks:
        """
        Get tracks by IDs or URNs.

        Args:
            ids: Comma-separated list of track IDs (e.g., "1,2,3")
            urns: Comma-separated list of track URNs (e.g., "soundcloud:tracks:1,soundcloud:tracks:2")
        """
        ...

    # Official API endpoints from spec

    @route("GET", "me/activities", response_model=scm.Activities)
    async def get_me_activities(
        self,
        limit: int = 50,
        access: str | None = None,
    ) -> scm.Activities: ...

    @route("GET", "me/likes/tracks", response_model=scm.Tracks)
    async def get_me_likes_tracks(
        self,
        limit: int = 50,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "me/likes/playlists", response_model=scm.Playlists)
    async def get_me_likes_playlists(
        self,
        limit: int = 50,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "me/followings", response_model=scm.Followings)
    async def get_me_followings(
        self,
        limit: int = 50,
        offset: int = 0,
    ): ...

    @route("GET", "me/tracks")
    async def get_me_tracks(
        self,
        limit: int = 50,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "me/playlists")
    async def get_me_playlists(
        self,
        limit: int = 50,
        linked_partitioning: bool = True,
        show_tracks: bool = True,
    ): ...

    @route("GET", "users/{user_urn}", response_model=scm.User)
    async def get_user(self, user_urn: str) -> scm.User: ...

    @route("GET", "users/{user_urn}/tracks")
    async def get_user_tracks(
        self,
        user_urn: str,
        limit: int = 50,
        linked_partitioning: bool = True,
        access: str | None = None,
    ): ...

    @route("GET", "users/{user_urn}/playlists")
    async def get_user_playlists_official(
        self,
        user_urn: str,
        limit: int = 50,
        linked_partitioning: bool = True,
        access: str | None = None,
        show_tracks: bool = True,
    ): ...

    @route("GET", "users/{user_urn}/likes/playlists", response_model=scm.Playlists)
    async def get_user_likes_playlists(
        self,
        user_urn: str,
        limit: int = 50,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "users/{user_urn}/followers")
    async def get_user_followers(
        self,
        user_urn: str,
        limit: int = 50,
    ): ...

    @route("GET", "users/{user_urn}/followings")
    async def get_user_followings(
        self,
        user_urn: str,
        limit: int = 50,
    ): ...

    @route("GET", "users/{user_urn}/web-profiles", response_model=scm.WebProfiles)
    async def get_user_web_profiles(
        self,
        user_urn: str,
        limit: int = 50,
    ) -> scm.WebProfiles: ...

    @route("GET", "tracks/{track_urn}/comments", response_model=scm.Comments)
    async def get_track_comments(
        self,
        track_urn: str,
        limit: int = 50,
        offset: int = 0,
        linked_partitioning: bool = True,
    ) -> scm.Comments: ...

    @route("POST", "tracks/{track_urn}/comments")
    async def post_track_comment(
        self,
        track_urn: str,
        body: str,
        timestamp: int | str | None = None,
    ): ...

    @route("GET", "tracks/{track_urn}/streams", response_model=scm.Streams)
    async def get_track_streams(
        self,
        track_urn: str,
        secret_token: str | None = None,
    ) -> scm.Streams: ...

    @route("GET", "tracks/{track_urn}/favoriters")
    async def get_track_favoriters(
        self,
        track_urn: str,
        limit: int = 50,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "tracks/{track_urn}/reposters")
    async def get_track_reposters(
        self,
        track_urn: str,
        limit: int = 50,
    ): ...

    @route("GET", "tracks/{track_urn}/related")
    async def get_track_related(
        self,
        track_urn: str,
        limit: int = 50,
        offset: int = 0,
        linked_partitioning: bool = True,
        access: str | None = None,
    ): ...

    @route("GET", "playlists/{playlist_urn}/tracks")
    async def get_playlist_tracks(
        self,
        playlist_urn: str,
        secret_token: str | None = None,
        access: str | None = None,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "playlists/{playlist_urn}/reposters")
    async def get_playlist_reposters(
        self,
        playlist_urn: str,
        limit: int = 50,
    ): ...

    @route("POST", "likes/tracks/{track_urn}")
    async def like_track(self, track_urn: str): ...

    @route("DELETE", "likes/tracks/{track_urn}")
    async def unlike_track(self, track_urn: str): ...

    @route("POST", "likes/playlists/{playlist_urn}")
    async def like_playlist(self, playlist_urn: str): ...

    @route("DELETE", "likes/playlists/{playlist_urn}")
    async def unlike_playlist(self, playlist_urn: str): ...

    @route("POST", "reposts/tracks/{track_urn}")
    async def repost_track(self, track_urn: str): ...

    @route("DELETE", "reposts/tracks/{track_urn}")
    async def delete_repost_track(self, track_urn: str): ...

    @route("POST", "reposts/playlists/{playlist_urn}")
    async def repost_playlist(self, playlist_urn: str): ...

    @route("DELETE", "reposts/playlists/{playlist_urn}")
    async def delete_repost_playlist(self, playlist_urn: str): ...

    @staticmethod
    def prepare_track_ids(ids: list[int]) -> str:
        return ",".join(map(str, ids))

    async def get_all_tracks(self, track_ids: list[int], chunk_size: int = 30) -> list[scm.Track]:
        """Get multiple tracks by their IDs, chunked to avoid API limits"""
        all_tracks = []
        for track_ids_chunk in chunk_list(track_ids, n=chunk_size):
            tracks_response = await self.get_tracks(ids=self.prepare_track_ids(track_ids_chunk))
            if tracks_response and tracks_response.collection:
                all_tracks.extend(tracks_response.collection)
        return all_tracks
