"""HTTP routes for Track Breakdown: analysis jobs, results, edits and stems."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from backend.api.deps import get_root_folder, validate_file_path
from backend.domain.arrangement import Section
from backend.services.breakdown import track as track_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/breakdown/tracks", tags=["breakdown"])


class StartTrackJobRequest(BaseModel):
    """Body for starting an analysis."""

    path: str


class StartTrackJobResponse(BaseModel):
    """Id of the started (or already running) job."""

    job_id: str


class SectionModel(BaseModel):
    """A labelled run of bars, 1-based and inclusive."""

    start_bar: int = Field(ge=1)
    end_bar: int = Field(ge=1)
    label: str


class TrackBreakdownResponse(BaseModel):
    """Features and sections of an analysed track."""

    digest: str
    features: dict[str, Any]
    sections: list[SectionModel]
    detected_sections: list[SectionModel]
    sections_edited: bool
    grid_edited: bool


class SectionsRequest(BaseModel):
    """Edited sections; they must cover every bar."""

    sections: list[SectionModel]


class GridRequest(BaseModel):
    """An edited bar grid."""

    bpm: float = Field(gt=40, lt=300)
    downbeat_s: float = Field(ge=0)


def _response(result: track_service.TrackBreakdown) -> TrackBreakdownResponse:
    return TrackBreakdownResponse(
        digest=result.digest,
        features=result.features,
        sections=[SectionModel(**s.__dict__) for s in result.sections],
        detected_sections=[SectionModel(**s.__dict__) for s in result.detected_sections],
        sections_edited=result.sections_edited,
        grid_edited=result.grid_edited,
    )


def _not_analysed(digest: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"track {digest} has not been analysed")


@router.post("/jobs", response_model=StartTrackJobResponse)
async def start_job(
    body: StartTrackJobRequest, root_folder: Annotated[Path, Depends(get_root_folder)]
) -> StartTrackJobResponse:
    """Start analysing a local file, or join the running job for it."""
    path = validate_file_path(body.path, root_folder)
    return StartTrackJobResponse(job_id=track_service.start_job(path))


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
