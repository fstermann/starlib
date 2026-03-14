"""
DEPRECATED: The Like model is not actually used by the SoundCloud API.

The /users/{user_urn}/likes/tracks endpoint returns a Tracks collection (list of Track objects).
The /users/{user_urn}/likes/playlists endpoint returns a Playlists collection (list of Playlist objects).

There are no "like" wrapper objects in the API responses - they return the liked items directly.
This module is kept for backward compatibility but should not be used.
"""

from typing import Literal

from pydantic import BaseModel

from soundcloud_tools.models.playlist import Playlist
from soundcloud_tools.models.track import Track


class BaseLike(BaseModel):
    """DEPRECATED: Not used by the API"""

    created_at: str  # API returns string
    kind: Literal["like"]


class TrackLike(BaseLike):
    """DEPRECATED: Not used by the API"""

    track: Track


class PlaylistLike(BaseLike):
    """DEPRECATED: Not used by the API"""

    playlist: Playlist


Like = TrackLike | PlaylistLike


class Likes(BaseModel):
    """
    DEPRECATED: Not used by the API.

    The likes endpoints actually return Tracks or Playlists collections,
    not Like wrapper objects. Use those models instead.
    """

    collection: list[Like]
    next_href: str | None = None
    query_urn: str | None = None
