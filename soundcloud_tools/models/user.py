from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel


class Badges(BaseModel):
    pro: bool
    creator_mid_tier: bool
    pro_unlimited: bool
    verified: bool


class Subscription(BaseModel):
    """Subscription associated with the user"""

    product: dict[str, str]  # {"id": "...", "name": "..."}
    recurring: bool | None = None


class User(BaseModel):
    """SoundCloud User object from official API"""

    # Required fields
    avatar_url: str
    urn: str
    kind: Literal["user"]
    permalink: str
    permalink_url: str
    uri: str
    username: str
    last_modified: str  # API returns string, not datetime
    followers_count: int
    followings_count: int

    # Optional fields from API spec
    city: str | None = None
    country: str | None = None  # Changed from country_code
    created_at: str | None = None  # API returns string
    description: str | None = None
    discogs_name: str | None = None
    first_name: str | None = None
    full_name: str | None = None
    last_name: str | None = None
    plan: str | None = None
    playlist_count: int | None = None
    public_favorites_count: int | None = None
    reposts_count: int | None = None
    track_count: int | None = None
    website: str | None = None
    website_title: str | None = None
    subscriptions: list[Subscription] | None = None

    # Extended fields (may not be in official schema but exist in responses)
    id: int | None = None  # Some endpoints use id
    verified: bool | None = None
    country_code: str | None = None
    badges: Badges | None = None
    station_urn: str | None = None
    station_permalink: str | None = None

    @property
    def hq_avatar_url(self) -> str | None:
        return self.avatar_url and self.avatar_url.replace("-large.", "-t500x500.")


class Me(BaseModel):
    """SoundCloud Me object - authenticated user info"""

    # Required fields
    avatar_url: str
    urn: str
    kind: Literal["user"]
    permalink: str
    permalink_url: str
    uri: str
    username: str
    last_modified: str
    followers_count: int
    followings_count: int

    # Me-specific fields
    likes_count: int | None = None
    primary_email_confirmed: bool | None = None
    private_playlists_count: int | None = None
    private_tracks_count: int | None = None

    # Quota information
    quota: dict[str, Any] | None = None  # {unlimited_upload_quota, upload_seconds_used, upload_seconds_left}

    # Optional fields
    city: str | None = None
    country: str | None = None
    created_at: str | None = None
    description: str | None = None
    discogs_name: str | None = None
    first_name: str | None = None
    full_name: str | None = None
    last_name: str | None = None
    locale: str | None = None
    online: bool | None = None
    plan: str | None = None
    playlist_count: int | None = None
    public_favorites_count: int | None = None
    reposts_count: int | None = None
    track_count: int | None = None
    upload_seconds_left: int | None = None
    website: str | None = None
    website_title: str | None = None
    subscriptions: list[Subscription] | None = None

    # Deprecated field (always 0)
    comments_count: int | None = None

    @property
    def hq_avatar_url(self) -> str | None:
        return self.avatar_url and self.avatar_url.replace("-large.", "-t500x500.")


class Users(BaseModel):
    """Collection of users from official API (search results, followers, followings, etc.)"""

    collection: list[User]
    next_href: str | None = None
    query_urn: str | None = None
