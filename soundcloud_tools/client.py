# mypy: disable-error-code="empty-body"
import json
import logging
import re
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
from soundcloud_tools.oauth import OAuthManager
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
            response = await self.make_request(
                method,
                url,
                data=split_params.content,
                params=params,
                **split_params.kwargs,
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
        self.settings = get_settings()

        # Initialize OAuth manager if credentials are available
        self.oauth_manager: OAuthManager | None = None
        if self.settings.has_oauth_credentials():
            logger.info("Initializing OAuth manager with Client Credentials flow")
            self.oauth_manager = OAuthManager(
                client_id=self.settings.client_id,
                client_secret=self.settings.client_secret,
            )
        elif self.settings.has_manual_token():
            logger.warning(
                "Using manual OAuth token (deprecated). Configure CLIENT_SECRET in .env for automatic token management."
            )
        else:
            logger.error(
                "No authentication credentials found. "
                "Either set OAUTH_TOKEN (manual) or CLIENT_ID + CLIENT_SECRET (automatic) in .env"
            )

        # Base headers (Authorization will be added per-request)
        self.base_headers = {
            "User-Agent": generate_random_user_agent(),
            "x-datadome-clientid": self.settings.datadome_clientid,
        }

        self.params = {
            "client_id": self.settings.client_id,
            "app_version": "1767966453",
            "app_locale": "en",
        }
        self.proxies = {"https://": "https://" + self.settings.proxy} if self.settings.proxy else {}

    def _get_auth_header(self) -> str:
        """Get current valid authorization header value.

        Returns
        -------
        str
            Authorization header value (e.g., "OAuth token123")

        Raises
        ------
        ValueError
            If no valid token is available
        requests.HTTPError
            If OAuth token refresh fails
        """
        if self.oauth_manager:
            # Get fresh token from OAuth manager (auto-refreshes if needed)
            try:
                access_token = self.oauth_manager.get_access_token()
                return f"OAuth {access_token}"
            except requests.HTTPError as e:
                logger.error(f"Failed to obtain OAuth token: {e}")
                # Fall back to manual token if available
                if self.settings.has_manual_token():
                    logger.warning("Falling back to manual OAuth token")
                    return f"OAuth {self.settings.oauth_token}"
                raise
        elif self.settings.has_manual_token():
            return f"OAuth {self.settings.oauth_token}"
        else:
            raise ValueError("No authentication credentials available")

    @property
    def headers(self) -> dict[str, str]:
        """Get request headers with current authorization."""
        return {
            **self.base_headers,
            "Authorization": self._get_auth_header(),
        }

    def json_dump(self, data: Any):
        return data if not isinstance(data, BaseModel) else data.model_dump(mode="json")

    async def make_request(self, method: str, url: str, **kwargs):
        # Build headers with fresh auth token
        kwargs["headers"] = kwargs.get("headers", {}) | self.headers
        kwargs["params"] = kwargs.get("params", {}) | self.params
        if self.settings.proxy:
            kwargs.setdefault("proxies", self.proxies)
        kwargs.setdefault("verify", False)
        logger.info(f"Making request {method} {url}")
        response = requests.request(method, url, **kwargs)
        logger.info(f"Response {response.status_code} for {method} {response.url}")
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
        offset = urlparse.parse_qs(parsed.query).get("offset") or None
        return offset and offset[0]

    async def get_track_id(self, url: str) -> int | None:
        regex = r'content="soundcloud://sounds:(\d+)"'
        response = await self.make_request("GET", url)
        match = re.search(regex, response.text)
        return int(match.group(1)) if match else None

    @route("POST", "playlists", response_model=scm.Playlist)
    async def post_playlist(self, data: PlaylistCreateRequest) -> scm.Playlist: ...

    @route("GET", "playlists/{playlist_id}", response_model=scm.Playlist)
    async def get_playlist(self, playlist_id: int, show_tracks: bool = True): ...

    @route("GET", "users/{user_id}/likes", response_model=scm.Likes)
    async def get_user_likes(
        self,
        user_id: int,
        limit: int = 100,
        offset: str | None = None,
        linked_partitioning: bool = True,
    ): ...
    @route("GET", "users/{user_id}/comments", response_model=scm.Comments)
    async def get_user_comments(
        self,
        user_id: int,
        limit: int = 100,
        offset: str | None = None,
        linked_partitioning: bool = True,
        threaded: int = 0,
    ): ...

    @route("GET", "stream/users/{user_id}/reposts", response_model=scm.Reposts)
    async def get_user_reposts(
        self,
        user_id: int,
        limit: int = 100,
        offset: str | None = None,
        linked_partitioning: bool = True,
    ): ...

    @route("GET", "users/{user_id}/followings/ids", response_model=scm.Followings)
    async def get_user_followings_ids(self, user_id: int, limit: int = 5000, linked_partitioning: bool = True): ...

    @route("GET", "users/{user_id}/followers/ids")
    async def get_user_followers_ids(self, user_id: int, limit: int = 5000, linked_partitioning: bool = True): ...

    @route("GET", "tracks/{track_id}", response_model=scm.Track)
    async def get_track(self, track_id: int): ...

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

    @route("GET", "search", response_model=scm.Search)
    async def search(self, q: str, limit: int = 20, offset: int = 0): ...

    @route("GET", "me/artist-shortcuts", response_model=scm.ArtistShortcuts)
    async def get_artist_shortcuts(
        self, limit: int = 1000, offset: str | None = None, linked_partitioning: bool = True
    ) -> scm.ArtistShortcuts: ...

    @route("GET", "me/artist-shortcuts/stories/{user_urn}", response_model=scm.ArtistShortcutStories)
    async def get_artist_shortcut_stories(self, user_urn: str) -> scm.ArtistShortcutStories: ...

    @route("PUT", "playlists/{playlist_urn}/artwork", response_model=PlaylistUpdateImageResponse)
    async def update_playlist_image(self, playlist_urn: str, data: PlaylistUpdateImageRequest): ...

    @route("GET", "users/{user_id}/playlists_without_albums", response_model=UserPlaylists)
    async def get_user_playlists(
        self,
        user_id: int,
        offset: int = 0,
        limit: int = 12,
        linked_partitioning: bool = True,
    ) -> UserPlaylists: ...

    @route("GET", "tracks", response_model=list[scm.Track])
    async def get_tracks(self, ids: str) -> list[scm.Track]: ...

    @staticmethod
    def prepare_track_ids(ids: list[int]) -> str:
        return ",".join(map(str, ids))

    async def get_all_tracks(self, track_ids: list[int], chunk_size: int = 30) -> list[scm.Track]:
        return [
            track
            for track_ids_chunk in chunk_list(track_ids, n=chunk_size)
            for track in await self.get_tracks(ids=self.prepare_track_ids(track_ids_chunk))
        ]
