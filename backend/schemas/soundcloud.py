"""Request/response models for the SoundCloud endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class StreamUrlResponse(BaseModel):
    """Signed HLS stream URL for a SoundCloud track."""

    url: str
    expires_at: str


class SystemPlaylistSummary(BaseModel):
    """Slim representation of a system playlist for tree display."""

    urn: str
    title: str
    short_title: str | None = None
    description: str | None = None
    artwork_url: str | None = None
    track_count: int
    last_updated: str | None = None
    permalink_url: str | None = None
    # Numeric track ids — the frontend hydrates these lazily via /tracks.
    track_ids: list[int]


class SystemPlaylistsResponse(BaseModel):
    playlists: list[SystemPlaylistSummary]


class SystemPlaylistTracksResponse(BaseModel):
    tracks: list[dict[str, Any]]


class StationTracksResponse(BaseModel):
    """Tracks of a track-station, in play order.

    ``title`` is nullable: the public API's ``/related`` feed carries no
    station name, so the backend leaves it ``None`` and the frontend supplies
    the seed track's title for the header.
    """

    title: str | None = None
    tracks: list[dict[str, Any]]
