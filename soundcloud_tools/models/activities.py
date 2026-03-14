from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from soundcloud_tools.models.playlist import Playlist
from soundcloud_tools.models.track import Track


class Activity(BaseModel):
    """SoundCloud Activity object from official API"""
    type: str  # e.g., "track", "playlist", "track:repost", etc.
    created_at: str  # API returns string
    origin: Track | Playlist | Any  # Can be Track or Playlist object


class Activities(BaseModel):
    """Collection of user activities"""
    collection: list[Activity]
    next_href: str | None = None
    future_href: str | None = None
