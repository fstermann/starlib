"""Rekordbox library endpoints.

Surfaces Rekordbox as a read-only browse source, either the local Rekordbox 6
master.db or a mounted USB/SD export (selected via the ``device`` query param).
Reads are lazy: opening a source only happens on first request, and a 503 is
returned if the selected source can't be read.
"""

from __future__ import annotations

import logging
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from backend.api.metadata.audio import stream_local_file
from backend.core.services import rekordbox as rb_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/rekordbox", tags=["rekordbox"])

# A discovered USB device id (its mount path), or None/absent for the local install.
DeviceParam = Query(default=None, description="USB device id; omit for the local install")


class RekordboxStatus(BaseModel):
    available: bool
    reason: str | None = None


class UsbDevice(BaseModel):
    id: str
    label: str
    mount_path: str


class DevicesResponse(BaseModel):
    devices: list[UsbDevice]


class EjectResponse(BaseModel):
    ok: bool


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


@router.get("/usb/devices", response_model=DevicesResponse)
def get_usb_devices() -> DevicesResponse:
    """List mounted Rekordbox USB/SD exports that carry a readable library."""
    devices = rb_service.discover_usb_devices()
    return DevicesResponse(devices=[UsbDevice(**asdict(d)) for d in devices])


@router.post("/usb/eject", response_model=EjectResponse)
def eject_usb_device(device: str = Query(..., description="USB device id")) -> EjectResponse:
    """Safely eject a mounted Rekordbox USB/SD export."""
    if device not in {d.id for d in rb_service.discover_usb_devices()}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not mounted")
    rb_service.forget_usb_source(device)  # close our DB handle before unmounting
    try:
        rb_service.eject_device(device)
    except rb_service.EjectError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return EjectResponse(ok=True)


@router.get("/status", response_model=RekordboxStatus)
def get_status(device: str | None = DeviceParam) -> RekordboxStatus:
    """Report whether the selected Rekordbox source is reachable."""
    try:
        rb_service.get_source(device).check_available()
    except rb_service.RekordboxUnavailable as exc:
        return RekordboxStatus(available=False, reason=str(exc))
    return RekordboxStatus(available=True)


@router.get("/playlists", response_model=PlaylistsResponse)
def get_playlists(device: str | None = DeviceParam) -> PlaylistsResponse:
    try:
        items = rb_service.get_source(device).list_playlists()
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    return PlaylistsResponse(playlists=[RekordboxPlaylist(**asdict(p)) for p in items])


@router.get("/playlists/{playlist_id}/tracks", response_model=TracksResponse)
def get_playlist_tracks(playlist_id: str, device: str | None = DeviceParam) -> TracksResponse:
    try:
        items = rb_service.get_source(device).list_playlist_tracks(playlist_id)
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    return TracksResponse(tracks=[RekordboxTrack(**asdict(t)) for t in items])


@router.get("/tracks/{track_id}/artwork")
def get_track_artwork(track_id: str, small: bool = True, device: str | None = DeviceParam) -> Response:
    """Serve the cached artwork JPEG for a track."""
    try:
        data = rb_service.get_source(device).get_track_artwork(track_id, small=small)
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
def get_track_waveform(
    track_id: str,
    device: str | None = DeviceParam,
    variant: str = Query("color", pattern="^(color|blue)$"),
) -> Response:
    """Serve a track's raw ANLZ preview waveform bytes.

    ``variant=color`` (default) returns the PWV4 colour preview (7200 bytes:
    1200 x 6). ``variant=blue`` returns the PWAV monochrome preview (400 bytes:
    400 x 1, 5-bit height + 3-bit whiteness). The frontend decodes the byte
    stream onto a canvas to render the waveform.
    """
    source = rb_service.get_source(device)
    try:
        data = (
            source.get_track_waveform_blue(track_id)
            if variant == "blue"
            else source.get_track_waveform_preview(track_id)
        )
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No waveform")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/tracks/{track_id}/audio", response_model=None)
async def stream_track_audio(track_id: str, device: str = Query(..., description="USB device id")) -> FileResponse:
    """Stream a track's audio file from a mounted USB export.

    Local-install tracks play through the metadata audio endpoint by their
    absolute path; USB tracks live on the device, so their device-relative path
    is resolved here (within the mount) and streamed with the same
    transcode/range handling.
    """
    try:
        source = rb_service.get_source(device)
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    if not isinstance(source, rb_service.UsbExportSource):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Audio streaming requires a USB device")
    path = source.get_track_audio_path(track_id)
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio file not found")
    return await stream_local_file(path)


@router.get("/tracks", response_model=TracksResponse)
def get_tracks(
    limit: int | None = Query(default=None, ge=1, le=10000), device: str | None = DeviceParam
) -> TracksResponse:
    try:
        items = rb_service.get_source(device).list_all_tracks(limit=limit)
    except rb_service.RekordboxUnavailable as exc:
        raise _unavailable(str(exc)) from exc
    return TracksResponse(tracks=[RekordboxTrack(**asdict(t)) for t in items])
