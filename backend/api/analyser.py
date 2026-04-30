"""Set Analyser HTTP routes (issue #403).

Endpoints:
- ``POST /api/analyser/sets``                     — start a new job.
- ``GET  /api/analyser/sets``                     — list recent jobs.
- ``GET  /api/analyser/sets/{job_id}``            — current snapshot.
- ``POST /api/analyser/sets/{job_id}/reanalyse``  — re-run on regions.
- ``GET  /api/analyser/sets/{job_id}/events``     — SSE stream.

The router is intentionally thin: validation + dependency injection for the
audio fetcher (so tests can pass local files), then delegates to the
``backend.core.services.analyser`` controller.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from backend.core.services.analyser import (
    AnalyserJobOptions,
    JobNotFoundError,
    get_job_snapshot,
    reanalyse_job,
    recent_jobs,
    start_job,
    subscribe_to_job,
)
from backend.core.services.analyser import cache as audio_cache
from backend.core.services.analyser.events import event_to_sse
from backend.core.services.sc_auth_cache import get_cached_access_token
from soundcloud_tools.oauth import OAuthManager
from soundcloud_tools.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/analyser", tags=["analyser"])

# Holds strong references to fire-and-forget background tasks so the GC
# doesn't reap them mid-flight. asyncio's docs explicitly warn that bare
# ``create_task`` without a stored reference is a footgun.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class StartJobRequest(BaseModel):
    """Body for ``POST /sets``: either a SoundCloud URL or a track id."""

    url: str | None = None
    soundcloud_id: int | None = None
    options: AnalyserJobOptions = Field(default_factory=AnalyserJobOptions)
    title: str | None = None
    artist: str | None = None

    @model_validator(mode="after")
    def _has_target(self) -> StartJobRequest:
        if self.url is None and self.soundcloud_id is None:
            raise ValueError("either url or soundcloud_id is required")
        return self


class StartJobResponse(BaseModel):
    job_id: str


class ReanalyseRequest(BaseModel):
    ranges: list[dict[str, float]] = Field(default_factory=list)
    overrides: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _at_least_one_range(self) -> ReanalyseRequest:
        if not self.ranges:
            raise ValueError("ranges must contain at least one entry")
        for r in self.ranges:
            if "start_s" not in r or "end_s" not in r:
                raise ValueError("each range must include start_s and end_s")
        return self


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/sets", response_model=StartJobResponse)
async def start_analyser_job(payload: StartJobRequest) -> StartJobResponse:
    """Start a new analyser job for a SoundCloud set."""
    if not get_settings().has_oauth_credentials():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SoundCloud OAuth credentials not configured",
        )

    soundcloud_id = payload.soundcloud_id
    if soundcloud_id is None:
        soundcloud_id = await _resolve_soundcloud_url(payload.url or "")
    title, artist = await _fetch_track_meta(soundcloud_id, payload.title, payload.artist)

    fetch_audio = _make_soundcloud_fetcher(soundcloud_id)
    job_id = await start_job(
        options=payload.options,
        soundcloud_id=soundcloud_id,
        source_url=payload.url,
        title=title,
        artist=artist,
        fetch_audio=fetch_audio,
    )
    return StartJobResponse(job_id=job_id)


async def _resolve_soundcloud_url(url: str) -> int:
    # Goes through ``api.soundcloud.com/resolve`` (Client-Credentials token),
    # not the api-v2 path that ``soundcloud_tools.Client`` would hit — those
    # require the web-session cookie token and aren't authorised for this
    # router's use case.
    from backend.api.soundcloud import _resolve_track_id

    try:
        resolved = await _resolve_track_id(url)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("analyser: failed to resolve URL %s", url)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"could not resolve SoundCloud URL: {exc}",
        ) from exc
    if resolved is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="no SoundCloud track found at that URL",
        )
    return resolved


async def _fetch_track_meta(soundcloud_id: int, title: str | None, artist: str | None) -> tuple[str | None, str | None]:
    """Fill in title/artist from the public SoundCloud API. Failures are non-fatal."""
    if title and artist:
        return title, artist
    from backend.api.soundcloud import _fetch_track_meta as fetch_public_track

    try:
        track = await fetch_public_track(soundcloud_id)
    except Exception as exc:  # metadata is best-effort — never fail the job for this.
        logger.warning("analyser: track metadata fetch failed for %s: %s", soundcloud_id, exc)
        return title, artist
    if not isinstance(track, dict):
        return title, artist
    if title is None:
        t = track.get("title")
        if isinstance(t, str) and t:
            title = t
    if artist is None:
        user = track.get("user")
        if isinstance(user, dict):
            u = user.get("username")
            if isinstance(u, str) and u:
                artist = u
    return title, artist


@router.get("/sets")
def list_jobs(limit: int = 25) -> dict:
    if limit < 1 or limit > 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="limit must be 1..100")
    return {"jobs": recent_jobs(limit=limit)}


@router.get("/sets/{job_id}")
def get_snapshot(job_id: str) -> dict:
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    return snap


@router.post("/sets/{job_id}/reanalyse")
async def reanalyse(job_id: str, payload: ReanalyseRequest) -> dict:
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    soundcloud_id = snap.get("soundcloud_id")
    if soundcloud_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="re-analysis requires a SoundCloud-backed job",
        )

    fetch_audio = _make_soundcloud_fetcher(int(soundcloud_id))
    ranges = [(float(r["start_s"]), float(r["end_s"])) for r in payload.ranges]

    task = asyncio.create_task(
        reanalyse_job(
            job_id,
            ranges=ranges,
            overrides=payload.overrides,
            fetch_audio=fetch_audio,
        )
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return {"job_id": job_id, "scheduled_ranges": payload.ranges}


@router.get("/sets/{job_id}/events")
async def stream_events(job_id: str, request: Request) -> StreamingResponse:
    """Server-Sent Events stream for an analyser job."""
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")

    async def event_iter() -> AsyncIterator[bytes]:
        try:
            async for event in subscribe_to_job(job_id):
                if await request.is_disconnected():
                    break
                yield event_to_sse(event).encode()
        except JobNotFoundError:
            return
        except Exception:
            logger.exception("analyser: SSE stream errored for job %s", job_id)
            return

    return StreamingResponse(
        event_iter(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Audio fetcher factories
# ---------------------------------------------------------------------------


def _make_soundcloud_fetcher(soundcloud_id: int):
    """Build an :class:`AudioFetcher` that pulls a SoundCloud track via HLS.

    The fetcher closes over the resolved track id so the controller doesn't
    need to know about SoundCloud auth — it just calls the fetcher and gets
    a path back. Errors propagate out as ``job.error`` events.
    """

    async def fetch() -> Path:
        # Dodging an inline import so the analyser package stays decoupled
        # from the soundcloud router module's globals during tests.
        from backend.api.soundcloud import _fetch_stream_url  # local import

        existing = audio_cache.cached_set_path(soundcloud_id)
        if existing is not None:
            return existing

        hls_url, _expires = await _fetch_stream_url(soundcloud_id)
        token = get_cached_access_token(get_settings(), OAuthManager)
        return await audio_cache.fetch_set_audio(
            soundcloud_id,
            hls_url=hls_url,
            auth_header=f"OAuth {token}",
        )

    return fetch
