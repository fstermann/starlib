from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel

from soundcloud_tools.models.user import User

type TrackID = int


class PublisherMetadata(BaseModel):
    id: int
    urn: str

    contains_music: bool | None = None
    artist: str | None = None
    isrc: str | None = None
    explicit: bool | None = None
    writer_composer: str | None = None


class Format(BaseModel):
    protocol: str
    mime_type: str


class Transcoding(BaseModel):
    url: str
    preset: str
    duration: int
    snipped: bool
    format: Format
    quality: str


class Media(BaseModel):
    transcodings: list[Transcoding]


class Visual(BaseModel):
    urn: str
    entry_time: int
    visual_url: str


class Visuals(BaseModel):
    urn: str
    enabled: bool
    visuals: list[Visual]
    tracking: Any | None


class TrackSlim(BaseModel):
    id: int
    kind: str
    monetization_model: str
    policy: str


class Track(BaseModel):
    """SoundCloud Track object from official API"""

    # Required fields
    title: str
    urn: str
    kind: Literal["track"]
    uri: str
    permalink_url: str
    created_at: str  # API returns string
    duration: int
    """Duration in milliseconds"""
    user: User

    # Common fields (mostly required but some may be null)
    artwork_url: str | None = None
    commentable: bool | None = None
    comment_count: int | None = None
    description: str | None = None
    downloadable: bool | None = None
    download_count: int | None = None
    download_url: str | None = None
    embeddable_by: str | None = None  # Can be null
    favoritings_count: int | None = None
    genre: str | None = None
    bpm: int | None = None
    isrc: str | None = None
    key_signature: str | None = None
    label_name: str | None = None
    license: str | None = None
    metadata_artist: str | None = None  # Optional artist name when different from user
    playback_count: int | None = None
    purchase_title: str | None = None
    purchase_url: str | None = None
    release: str | None = None
    release_day: int | None = None
    release_month: int | None = None
    release_year: int | None = None
    reposts_count: int | None = None
    secret_uri: str | None = None
    sharing: str | None = None  # "public" or "private"
    stream_url: str | None = None  # Deprecated
    streamable: bool | None = None
    tag_list: str | None = None
    user_favorite: bool | None = None  # Only set when fetching search results or single track
    user_playback_count: int | None = None
    waveform_url: str | None = None
    available_country_codes: list[str] | None = None  # List of country codes where track is available

    # Access field - critical for determining playback availability
    access: Literal["playable", "preview", "blocked"] | None = None

    # Extended fields (not in minimal schema but exist in full responses)
    id: int | None = None
    caption: str | None = None
    has_downloads_left: bool | None = None
    full_duration: int | None = None
    last_modified: str | None = None
    permalink: str | None = None
    publisher_metadata: PublisherMetadata | None = None
    public: bool | None = None
    release_date: str | None = None
    secret_token: str | None = None
    state: str | None = None
    user_id: int | None = None
    visuals: Visuals | None = None
    display_date: str | None = None
    media: Media | None = None
    station_urn: str | None = None
    station_permalink: str | None = None
    track_authorization: str | None = None
    monetization_model: str | None = None
    policy: str | None = None

    @property
    def hq_artwork_url(self) -> str | None:
        return self.artwork_url and self.artwork_url.replace("-large.", "-t500x500.")

    @property
    def artist(self) -> str:
        return (self.publisher_metadata and self.publisher_metadata.artist) or self.user.username

    @property
    def duration_s(self) -> int:
        return self.duration // 1000

    def __eq__(self, other: Any) -> bool:
        if self.id is not None and isinstance(other, Track) and other.id is not None:
            return self.id == other.id
        return False

    def __hash__(self) -> int:
        return hash(self.id) if self.id is not None else hash(self.urn)


class Tracks(BaseModel):
    """Collection of tracks from official API (search results, user tracks, etc.)"""

    collection: list[Track]
    next_href: str | None = None
    query_urn: str | None = None
