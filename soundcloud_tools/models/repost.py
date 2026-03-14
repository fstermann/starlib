from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from soundcloud_tools.models.playlist import Playlist
from soundcloud_tools.models.track import Track
from soundcloud_tools.models.user import User


class BaseRepost(BaseModel):
    uuid: UUID
    created_at: str  # API returns string
    caption: str | None = None
    user: User


class TrackRepost(BaseRepost):
    type: Literal["track-repost"]
    track: Track


class PlaylistRepost(BaseRepost):
    type: Literal["playlist-repost"]
    playlist: Playlist


Repost = Annotated[TrackRepost | PlaylistRepost, Field(discriminator="type")]


class Reposts(BaseModel):
    collection: list[Repost]
    next_href: str | None = None
    query_urn: str | None = None
