"""HTTP routes for Track Breakdown: analysis jobs, results, edits and stems."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator

from backend.api.deps import get_root_folder, validate_file_path
from backend.domain.arrangement import Section
from backend.infra.breakdown import cache as audio_cache
from backend.services.breakdown import track as track_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/breakdown/tracks", tags=["breakdown"])


class StartTrackJobRequest(BaseModel):
    """Body for starting an analysis: a local file or a SoundCloud track id."""

    path: str | None = None
    soundcloud_id: int | None = None

    @model_validator(mode="after")
    def _one_source(self) -> StartTrackJobRequest:
        if (self.path is None) == (self.soundcloud_id is None):
            raise ValueError("give exactly one of path or soundcloud_id")
        return self


class StartTrackJobResponse(BaseModel):
    """Id of the started (or already running) job."""

    job_id: str


class SectionModel(BaseModel):
    """A labelled run of bars, 1-based and inclusive."""

    start_bar: int = Field(ge=1)
    end_bar: int = Field(ge=1)
    label: str


class SoundCloudTrackModel(BaseModel):
    """The SoundCloud track a breakdown's audio was streamed from."""

    id: int
    title: str | None
    artist: str | None
    artwork_url: str | None


class TrackBreakdownResponse(BaseModel):
    """Features and sections of an analysed track."""

    digest: str
    features: dict[str, Any]
    sections: list[SectionModel]
    detected_sections: list[SectionModel]
    sections_edited: bool
    grid_edited: bool
    soundcloud: SoundCloudTrackModel | None


class SectionsRequest(BaseModel):
    """Edited sections; they must cover every bar."""

    sections: list[SectionModel]


class GridRequest(BaseModel):
    """An edited bar grid."""

    bpm: float = Field(gt=40, lt=300)
    downbeat_s: float = Field(ge=0)


class RecentTrack(BaseModel):
    """A track in the recent list."""

    digest: str
    path: str
    bpm: float
    root: str | None
    n_bars: int
    duration_s: float
    opened_at: float
    soundcloud_id: int | None
    title: str | None
    artist: str | None
    artwork_url: str | None
    missing: bool
    """Whether the file is no longer at ``path``; SoundCloud tracks download again."""


class RecentTracksResponse(BaseModel):
    """Most recently opened tracks, newest first."""

    tracks: list[RecentTrack]


def _response(result: track_service.TrackBreakdown) -> TrackBreakdownResponse:
    return TrackBreakdownResponse(
        digest=result.digest,
        features=result.features,
        sections=[SectionModel(**s.__dict__) for s in result.sections],
        detected_sections=[SectionModel(**s.__dict__) for s in result.detected_sections],
        sections_edited=result.sections_edited,
        grid_edited=result.grid_edited,
        soundcloud=SoundCloudTrackModel(**result.soundcloud.__dict__) if result.soundcloud else None,
    )


def _not_analysed(digest: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"track {digest} has not been analysed")


@router.post("/jobs", response_model=StartTrackJobResponse)
async def start_job(
    body: StartTrackJobRequest, root_folder: Annotated[Path, Depends(get_root_folder)]
) -> StartTrackJobResponse:
    """Start analysing a local file or a SoundCloud track, or join the running job for it."""
    if body.soundcloud_id is not None:
        track_id = body.soundcloud_id
        return StartTrackJobResponse(
            job_id=track_service.start_soundcloud_job(track_id, lambda: _download_soundcloud(track_id))
        )
    assert body.path is not None
    path = validate_file_path(body.path, root_folder)
    return StartTrackJobResponse(job_id=track_service.start_job(path))


async def _download_soundcloud(track_id: int) -> tuple[Path, track_service.SoundCloudTrack]:
    from backend.api.breakdown import _make_soundcloud_fetcher
    from backend.api.soundcloud.tracks import _fetch_track_meta

    path = await _make_soundcloud_fetcher(track_id)()
    try:
        meta = await _fetch_track_meta(track_id) or {}
    except HTTPException as exc:  # The analysis doesn't need the title; keep going without it.
        logger.warning("track breakdown: SoundCloud metadata fetch failed for %s: %s", track_id, exc)
        meta = {}
    user = meta.get("user")
    if not isinstance(user, dict):
        user = {}
    return path, track_service.SoundCloudTrack(
        id=track_id,
        title=meta.get("title") or None,
        artist=user.get("username") or None,
        artwork_url=meta.get("artwork_url") or None,
    )


@router.get("/soundcloud/{track_id}/audio", response_model=None)
async def get_soundcloud_audio(track_id: int) -> FileResponse:
    """Serve a SoundCloud track's downloaded audio, for the Original lane."""
    path = audio_cache.cached_set_path(track_id)
    if path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"SoundCloud track {track_id} isn't downloaded"
        )
    return FileResponse(path, media_type="audio/mp4")


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict[str, bool]:
    """Cancel a running analysis."""
    return {"cancelled": track_service.cancel_job(job_id)}


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request) -> StreamingResponse:
    """Server-Sent Events: ``stage`` progress, then ``complete``, ``error`` or ``cancelled``."""
    events = track_service.subscribe(job_id)
    try:
        first = await anext(events)
    except track_service.JobNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found") from exc
    except StopAsyncIteration:
        first = None

    async def stream() -> AsyncIterator[bytes]:
        if first is None:
            return
        yield f"data: {json.dumps(first)}\n\n".encode()
        async for event in events:
            if await request.is_disconnected():
                break
            yield f"data: {json.dumps(event)}\n\n".encode()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.get("", response_model=RecentTracksResponse)
async def recent_tracks() -> RecentTracksResponse:
    """List the most recently opened tracks."""
    return RecentTracksResponse(
        tracks=[
            RecentTrack(**entry.__dict__, missing=entry.soundcloud_id is None and not Path(entry.path).exists())
            for entry in track_service.recent_tracks()
        ]
    )


@router.delete("/{digest}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_track(digest: str) -> None:
    """Delete a track's stems, features, edits and recent-list entry."""
    track_service.delete_track(digest)


@router.get("/{digest}", response_model=TrackBreakdownResponse)
async def get_breakdown(digest: str) -> TrackBreakdownResponse:
    """Return an analysed track's features and sections."""
    result = track_service.load_result(digest)
    if result is None:
        raise _not_analysed(digest)
    return _response(result)


@router.put("/{digest}/sections", response_model=TrackBreakdownResponse)
async def put_sections(digest: str, body: SectionsRequest) -> TrackBreakdownResponse:
    """Replace the track's sections with the user's edits."""
    sections = [Section(**s.model_dump()) for s in body.sections]
    try:
        return _response(track_service.save_sections(digest, sections))
    except LookupError as exc:
        raise _not_analysed(digest) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.delete("/{digest}/sections", response_model=TrackBreakdownResponse)
async def reset_sections(digest: str) -> TrackBreakdownResponse:
    """Drop the user's section edits and return to the detected sections."""
    try:
        return _response(track_service.save_sections(digest, None))
    except LookupError as exc:
        raise _not_analysed(digest) from exc


@router.put("/{digest}/grid", status_code=status.HTTP_204_NO_CONTENT)
async def put_grid(digest: str, body: GridRequest) -> None:
    """Store an edited bar grid; the next analysis job re-measures on it."""
    try:
        track_service.save_grid(digest, (body.bpm, body.downbeat_s))
    except LookupError as exc:
        raise _not_analysed(digest) from exc


@router.delete("/{digest}/grid", status_code=status.HTTP_204_NO_CONTENT)
async def reset_grid(digest: str) -> None:
    """Return to the estimated bar grid on the next analysis job."""
    try:
        track_service.save_grid(digest, None)
    except LookupError as exc:
        raise _not_analysed(digest) from exc


@router.get("/{digest}/stems/{name}", response_model=None)
async def get_stem(digest: str, name: str) -> FileResponse:
    """Serve a cached stem as FLAC."""
    path = track_service.stem_path(digest, name)
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"no {name} stem for {digest}")
    return FileResponse(path, media_type="audio/flac")
