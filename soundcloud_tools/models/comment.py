from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from soundcloud_tools.models.track import TrackSlim
from soundcloud_tools.models.user import User


class Comment(BaseModel):
    """SoundCloud Comment object from official API"""

    # Required fields
    body: str
    created_at: str  # API returns string
    urn: str
    kind: Literal["comment"]
    user_urn: str
    timestamp: str | int  # API supports both string and number
    track_urn: str
    uri: str
    user: User  # Nested user object with limited fields

    # Extended fields (not in minimal schema)
    id: int | None = None
    type: Literal["comment"] = "comment"  # Auxiliary field
    track_id: int | None = None
    user_id: int | None = None
    self: dict | None = None  # Sometimes has a "self" field with urn
    track: TrackSlim | None = None


class Comments(BaseModel):
    collection: list[Comment]
    next_href: str | None
    query_urn: str | None = None
