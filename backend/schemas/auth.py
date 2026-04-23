"""OAuth and authentication schemas."""

from pydantic import BaseModel


class CallbackRequest(BaseModel):
    """OAuth callback payload from frontend."""

    code: str
    state: str


class AuthorizeResponse(BaseModel):
    """Authorization URL response."""

    authorization_url: str
    state: str


class UserInfo(BaseModel):
    """Minimal SoundCloud user info."""

    id: int
    username: str
    permalink: str
    avatar_url: str | None = None


class CallbackResponse(BaseModel):
    """OAuth callback response with tokens and user info."""

    access_token: str
    refresh_token: str | None
    expires_in: int | None = None
    user: UserInfo


class SessionCookieRequest(BaseModel):
    """Web-session ``oauth_token`` captured from the SoundCloud cookie jar.

    Required to reach api-v2.soundcloud.com (system playlists / mixes).
    Format is SoundCloud's session token: ``2-<digits>-<uid>-<rand>``.
    """

    oauth_token: str


class SessionCookieResponse(BaseModel):
    """Result of persisting the web-session token."""

    success: bool


class RefreshRequest(BaseModel):
    """Token refresh request."""

    refresh_token: str


class RefreshResponse(BaseModel):
    """Token refresh response."""

    access_token: str
    refresh_token: str | None
    expires_in: int | None = None
