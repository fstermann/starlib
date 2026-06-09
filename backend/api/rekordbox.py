"""Rekordbox library endpoints.

Surfaces the local Rekordbox 6 master.db as a read-only browse source.
Reads are lazy: opening the DB only happens on first request, and a 503 is
returned if Rekordbox isn't installed on this machine.
"""

from __future__ import annotations

import logging
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel

from backend.core.services import rekordbox as rb_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/rekordbox", tags=["rekordbox"])


class RekordboxStatus(BaseModel):
    available: bool
    reason: str | None = None


class RekordboxPlaylist(BaseModel):
    id: str
    name: str
    parent_id: str | None = None
    is_folder: bool
    is_smart: bool
    track_count: int


class RekordboxTrack(BaseModel):
    id: str
    title: str
    artist: str | None = None
    album: str | None = None
    genre: str | None = None
    bpm: float | None = None
    key: str | None = None
    duration_seconds: int | None = None
    file_path: str | None = None
    comment: str | None = None
    soundcloud_id: int | None = None
    date_added: str | None = None
    release_date: str | None = None
    has_artwork: bool = False
    has_waveform: bool = False


class PlaylistsResponse(BaseModel):
    playlists: list[RekordboxPlaylist]


class TracksResponse(BaseModel):
    tracks: list[RekordboxTrack]


def _unavailable(reason: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=reason,
    )


@router.get("/status", response_model=RekordboxStatus)
def get_status() -> RekordboxStatus:
    """Report whether the Rekordbox master.db is reachable."""
    try:
        rb_service._open_db()
    except rb_service.RekordboxUnavailable as exc:
        return RekordboxStatus(available=False, reason=str(exc))
    return RekordboxStatus(available=True)


@router.get("/playlists", response_model=PlaylistsResponse)
def get_playlists() -> PlaylistsResponse:
    try:
        items = rb_service.list_playlists()
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    return PlaylistsResponse(playlists=[RekordboxPlaylist(**asdict(p)) for p in items])


@router.get("/playlists/{playlist_id}/tracks", response_model=TracksResponse)
def get_playlist_tracks(playlist_id: str) -> TracksResponse:
    try:
        items = rb_service.list_playlist_tracks(playlist_id)
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    return TracksResponse(tracks=[RekordboxTrack(**asdict(t)) for t in items])


@router.get("/tracks/{track_id}/artwork")
def get_track_artwork(track_id: str, small: bool = True) -> Response:
    """Serve the cached artwork JPEG for a track from the Rekordbox share dir."""
    try:
        data = rb_service.get_track_artwork(track_id, small=small)
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artwork")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/tracks/{track_id}/waveform")
def get_track_waveform(track_id: str) -> Response:
    """Serve the raw PWV4 color preview entries (7200 bytes: 1200 x 6).

    The frontend decodes the byte stream onto a small canvas to render an inline
    RGB waveform matching what Rekordbox shows in its track list.
    """
    try:
        data = rb_service.get_track_waveform_preview(track_id)
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No waveform")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/tracks", response_model=TracksResponse)
def get_tracks(limit: int | None = Query(default=None, ge=1, le=10000)) -> TracksResponse:
    try:
        items = rb_service.list_all_tracks(limit=limit)
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    return TracksResponse(tracks=[RekordboxTrack(**asdict(t)) for t in items])
