import logging
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

from soundcloud_tools.models.track import Track, TrackID, TrackSlim
from soundcloud_tools.models.user import User

logger = logging.getLogger(__name__)


class TrackReference(BaseModel):
    """Track reference for playlist creation - API expects {"urn": track_id}"""

    urn: str

    @field_validator("urn", mode="before")
    @classmethod
    def validate_urn(cls, v):
        if isinstance(v, int):
            return f"soundcloud:tracks:{v}"
        return v


class PlaylistCreate(BaseModel):
    title: str
    description: str
    sharing: Literal["public", "private"] = "private"
    tracks: list[TrackReference] = []
    tag_list: str = ""

    @field_validator("tracks", mode="before")
    def validate_tracks(cls, tracks: list[TrackReference | int]):
        """Convert list of IDs to list of TrackReference objects"""
        if not tracks:
            raise ValueError("At least one track is required for the playlist")
        if len(tracks) > 500:
            logger.warning("Playlist has more than 500 tracks, truncating track list")
            tracks = tracks[:500]

        # Convert integers to TrackReference objects
        return [TrackReference(urn=t) for t in tracks]


class PlaylistUpdateImageRequest(BaseModel):
    image_data: str


class PlaylistUpdateImageResponse(BaseModel):
    artwork_url: str


class Playlist(BaseModel):
    """SoundCloud Playlist Object from official API"""

    # Required fields
    title: str
    urn: str
    kind: Literal["playlist"]
    permalink: str
    permalink_url: str
    uri: str
    user: User
    created_at: str  # API returns string

    # Common fields
    artwork_url: str | None = None
    description: str | None = None
    duration: int | None = None
    downloadable: bool | None = None
    embeddable_by: str | None = None
    ean: str | None = None  # European Article Number
    genre: str | None = None
    label_id: int | None = None  # Label user identifier
    label_name: str | None = None
    last_modified: str | None = None  # API returns string
    license: str | None = None
    likes_count: int | None = None
    playlist_type: str | None = None
    purchase_title: str | None = None
    purchase_url: str | None = None
    release: str | None = None
    release_day: int | None = None
    release_month: int | None = None
    release_year: int | None = None
    sharing: str | None = None  # "private" or "public"
    streamable: bool | None = None
    tag_list: str | None = None
    track_count: int | None = None
    tracks: list[Track] = []  # List of tracks
    type: str | None = None  # Playlist type
    user_urn: str | None = None  # User identifier

    # Additional URIs and fields
    label: User | None = None  # Can be null or User object
    tracks_uri: str | None = None  # Tracks URI
    tags: str | None = None  # Can be null

    # Extended fields (not in minimal schema but exist in full responses)
    id: int | None = None
    public: bool | None = None
    release_date: str | None = None
    reposts_count: int | None = None
    secret_token: str | None = None
    set_type: str | None = None
    is_album: bool | None = None
    published_at: str | None = None
    display_date: str | None = None
    user_id: int | None = None
    managed_by_feeds: bool | None = None

    @property
    def hq_artwork_url(self) -> str | None:
        return self.artwork_url and self.artwork_url.replace("-large.", "-t500x500.")


class Seed(BaseModel):
    urn: str
    permalink: str


class SystemPlaylist(BaseModel):
    urn: str
    query_urn: str | None
    permalink: str
    permalink_url: str
    title: str
    description: str
    short_title: str
    short_description: str
    tracking_feature_name: str
    playlist_type: str
    last_updated: str | None
    artwork_url: str
    calculated_artwork_url: str
    likes_count: int
    seed: Seed | None = None
    tracks: list[TrackSlim]
    is_public: bool
    made_for: User | None
    user: User
    kind: Literal["system-playlist"]
    id: str


class UserPlaylistBaseItem(BaseModel):
    created_at: datetime
    type: str
    user: User
    uuid: str
    caption: str | None = None


class UserPlaylistItem(UserPlaylistBaseItem):
    playlist: Playlist
    type: Literal["playlist"]


class UserPlaylistLikeItem(UserPlaylistBaseItem):
    playlist: Playlist
    type: Literal["playlist-like"]


class UserSystemPlaylistLikeItem(UserPlaylistBaseItem):
    system_playlist: SystemPlaylist
    type: Literal["system-playlist-like"]


PlaylistItem = Annotated[
    Playlist | SystemPlaylist,
    # UserPlaylistItem | UserPlaylistLikeItem | UserSystemPlaylistLikeItem,
    Field(discriminator="kind"),
]


class UserPlaylists(BaseModel):
    collection: list[PlaylistItem]
    next_href: str | None
    query_urn: str | None


class Playlists(BaseModel):
    """Collection of playlists from official API (search results, user playlists, etc.)"""

    collection: list[Playlist]
    next_href: str | None = None
    query_urn: str | None = None
