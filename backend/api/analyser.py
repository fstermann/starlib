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
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator

from backend.core.services.analyser import (
    AnalyserJobOptions,
    JobNotFoundError,
    cancel_shazam_scan,
    delete_job,
    get_job_snapshot,
    reanalyse_job,
    recent_jobs,
    start_job,
    start_shazam_scan,
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


class ShazamScanRequest(BaseModel):
    """User-triggered Shazam scan kick-off.

    BPM-driven pitch correction is the whole point of running Shazam after
    BPM analysis, so we require the user to commit to either a
    ``target_bpm`` or an explicit ``"none"`` strategy before spending
    Shazam quota. ``overrides`` lets the user adjust target_bpm, etc.
    without a separate PATCH endpoint.

    ``tier`` selects the scan resolution: ``sweep`` (60 s), ``refine``
    (20 s), or ``pinpoint`` (8 s). ``region`` restricts the scan to one
    span (used for "rescan this part"); ``cadence_s`` / ``window_s``
    override the tier defaults for custom-resolution rescans.
    """

    tier: str = "sweep"
    region: tuple[float, float] | None = None
    cadence_s: float | None = Field(default=None, gt=0)
    window_s: float | None = Field(default=None, gt=0)
    overrides: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _validate(self) -> ShazamScanRequest:
        if self.tier not in ("sweep", "refine", "pinpoint"):
            raise ValueError("tier must be one of: sweep, refine, pinpoint")
        if self.region is not None and self.region[1] <= self.region[0]:
            raise ValueError("region end must be greater than region start")
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
def list_jobs(limit: int = 100) -> dict:
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="limit must be 1..500")
    return {"jobs": recent_jobs(limit=limit)}


@router.delete("/sets/{job_id}")
def delete_job_route(job_id: str) -> dict:
    """Hard-delete a job and all derived data (windows, sections, scans, overrides)."""
    deleted = delete_job(job_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    return {"job_id": job_id, "deleted": True}


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

    # Flip the row to ``running`` before scheduling so a frontend that
    # re-fetches the snapshot right after this response sees the new pass
    # in progress (rather than the previous pass's terminal status).
    from backend.core.services.analyser import db as analyser_db

    analyser_db.update_job_status(job_id, status="running")

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


@router.post("/sets/{job_id}/shazam-scan")
async def shazam_scan(job_id: str, payload: ShazamScanRequest) -> dict:
    """Kick off a Shazam scan over the whole mix.

    Gating: the user must either set ``target_bpm`` or explicitly select
    ``pitch_strategy="none"`` first — otherwise Shazam runs at native
    pitch on a track the DJ may have shifted, and we waste budget on
    near-certain misses. The check looks at the merged options (existing
    snapshot + this request's ``overrides``).
    """
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    soundcloud_id = snap.get("soundcloud_id")
    if soundcloud_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="shazam scan requires a SoundCloud-backed job",
        )

    options_dict = dict(snap.get("options") or {})
    if payload.overrides:
        options_dict.update(payload.overrides)
    pitch_strategy = options_dict.get("pitch_strategy", "none")
    target_bpm = options_dict.get("target_bpm")
    bpm_range = options_dict.get("bpm_range")
    # Each strategy has exactly one required BPM input; checking them
    # individually closes the silent-fallthrough where ``single`` with
    # only ``bpm_range`` (no ``target_bpm``) used to slip past the gate
    # and then default to ``[0.0]`` inside ``select_pitch_offsets``.
    if pitch_strategy == "single" and not target_bpm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="set target_bpm before running Shazam in 'single' mode",
        )
    if pitch_strategy == "range" and not bpm_range:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="set bpm_range before running Shazam in 'range' mode",
        )

    fetch_audio = _make_soundcloud_fetcher(int(soundcloud_id))

    # Flip the DB row to ``running`` synchronously so any frontend that
    # re-fetches the snapshot or re-opens the SSE stream right after this
    # response sees the scan in progress (otherwise it would still see
    # ``complete`` from the prior pass and not bother subscribing).
    from backend.core.services.analyser import db as analyser_db

    analyser_db.update_job_status(job_id, status="running")

    # Count confirmed tracks whose span overlaps the requested region — the
    # scheduler will skip those scan points; surfacing the count lets the
    # frontend flag "N confirmed tracks excluded".
    region_tuple = payload.region
    excluded_confirmed = _count_confirmed_in_region(job_id, region_tuple)

    task = asyncio.create_task(
        start_shazam_scan(
            job_id,
            fetch_audio=fetch_audio,
            tier=payload.tier,
            region=region_tuple,
            cadence_s=payload.cadence_s,
            window_s=payload.window_s,
            overrides=payload.overrides,
        ),
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return {
        "job_id": job_id,
        "status": "scheduled",
        "tier": payload.tier,
        "region": list(region_tuple) if region_tuple else None,
        "excluded_confirmed_tracks": excluded_confirmed,
    }


def _count_confirmed_in_region(job_id: str, region: tuple[float, float] | None) -> int:
    """Confirmed tracks whose span overlaps the requested scan region.

    With ``region=None`` (whole-mix scan) every confirmed track is excluded.
    """
    from backend.core.services.analyser import db as analyser_db

    ranges = analyser_db.list_confirmed_ranges(job_id)
    if region is None:
        return len(ranges)
    r_start, r_end = region
    return sum(1 for s, e in ranges if e > r_start and s < r_end)


class AddTrackRequest(BaseModel):
    """Body for ``POST /sets/{id}/tracks`` — add a track to the tracklist.

    Used both for user-added entries (origin='manual') and, in principle,
    for explicit Shazam-source additions (origin='shazam'); in practice
    Shazam rows are materialised by the controller, not the API.
    """

    start_s: float = Field(ge=0)
    end_s: float | None = Field(default=None, ge=0)
    title: str = Field(min_length=1)
    artist: str | None = None
    shazam_id: str | None = None
    soundcloud_id: int | None = None
    soundcloud_permalink_url: str | None = None
    artwork_url: str | None = None
    duration_s: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _end_after_start(self) -> AddTrackRequest:
        if self.end_s is not None and self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


class UpdateTrackRequest(BaseModel):
    """Body for ``PATCH /sets/{id}/tracks/{track_id}``.

    Every field is optional — clients send only what changed. Editing
    ``start_s``/``end_s``/``title``/``artist`` flips the row's
    ``user_edited`` flag so a later Shazam re-sync leaves it alone.
    Toggling ``confirmed`` or ``dismissed`` doesn't count as an edit.
    """

    start_s: float | None = Field(default=None, ge=0)
    end_s: float | None = Field(default=None, ge=0)
    title: str | None = Field(default=None, min_length=1)
    artist: str | None = None
    soundcloud_id: int | None = None
    soundcloud_permalink_url: str | None = None
    artwork_url: str | None = None
    duration_s: float | None = Field(default=None, gt=0)
    confirmed: bool | None = None

    @model_validator(mode="after")
    def _validate(self) -> UpdateTrackRequest:
        if self.start_s is not None and self.end_s is not None and self.end_s <= self.start_s:
            raise ValueError("end_s must be greater than start_s")
        return self


def _track_dict(row) -> dict:  # type: ignore[no-untyped-def]
    return {
        "id": row.id,
        "origin": row.origin,
        "start_s": row.start_s,
        "end_s": row.end_s,
        "title": row.title,
        "artist": row.artist,
        "shazam_id": row.shazam_id,
        "soundcloud_id": row.soundcloud_id,
        "soundcloud_permalink_url": row.soundcloud_permalink_url,
        "artwork_url": row.artwork_url,
        "duration_s": row.duration_s,
        "confirmed": row.confirmed,
        "dismissed": row.dismissed,
        "user_edited": row.user_edited,
        "set_bpm": row.set_bpm,
        "pitch_offset": row.pitch_offset,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


@router.post("/sets/{job_id}/tracks")
def add_track(job_id: str, payload: AddTrackRequest) -> dict:
    """Add a track to a job's tracklist (origin='manual')."""
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    from backend.core.services.analyser import db as analyser_db

    row = analyser_db.insert_track(
        job_id=job_id,
        origin="manual",
        start_s=payload.start_s,
        end_s=payload.end_s,
        title=payload.title,
        artist=payload.artist,
        shazam_id=payload.shazam_id,
        soundcloud_id=payload.soundcloud_id,
        soundcloud_permalink_url=payload.soundcloud_permalink_url,
        artwork_url=payload.artwork_url,
        duration_s=payload.duration_s,
        user_edited=True,
    )
    return _track_dict(row)


@router.patch("/sets/{job_id}/tracks/{track_id}")
def update_track(job_id: str, track_id: int, payload: UpdateTrackRequest) -> dict:
    """Patch any subset of a track's fields. Drag, rename, confirm — same route."""
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    from backend.core.services.analyser import db as analyser_db

    # ``confirmed`` toggles aren't user edits in the "Shazam should not
    # overwrite this" sense — they don't change the track's identity.
    edits_identity = any(
        v is not None
        for v in (
            payload.start_s,
            payload.end_s,
            payload.title,
            payload.artist,
        )
    )
    ok = analyser_db.update_track(
        job_id,
        track_id,
        start_s=payload.start_s,
        end_s=payload.end_s,
        title=payload.title,
        artist=payload.artist,
        soundcloud_id=payload.soundcloud_id,
        soundcloud_permalink_url=payload.soundcloud_permalink_url,
        artwork_url=payload.artwork_url,
        duration_s=payload.duration_s,
        confirmed=payload.confirmed,
        mark_user_edited=edits_identity,
    )
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="track not found")
    return {"job_id": job_id, "track_id": track_id, "updated": True}


@router.delete("/sets/{job_id}/tracks/{track_id}")
def delete_track(job_id: str, track_id: int) -> dict:
    """Remove a track. Manual rows hard-delete; Shazam-origin rows soft-dismiss
    so a future re-scan doesn't resurrect them."""
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    from backend.core.services.analyser import db as analyser_db

    # Look the row up so we know whether to dismiss or hard-delete.
    rows = analyser_db.list_tracks(job_id, include_dismissed=True)
    target = next((r for r in rows if r.id == track_id), None)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="track not found")
    if target.origin == "shazam":
        analyser_db.update_track(job_id, track_id, dismissed=True)
    else:
        analyser_db.delete_track(job_id, track_id)
    return {"job_id": job_id, "track_id": track_id, "deleted": True}


@router.post("/sets/{job_id}/reset")
def reset_job(job_id: str) -> dict:
    """Wipe BPM windows, sections, Shazam scans and tracklist overrides.

    Keeps the job row itself so the user can immediately re-run analysis
    against the same SoundCloud source without re-entering the URL.
    """
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    from backend.core.services.analyser import controller as analyser_controller
    from backend.core.services.analyser import db as analyser_db

    analyser_db.reset_job_data(job_id)
    # Drop the in-memory job state so a resubscribe replays cleanly from
    # the now-empty DB instead of hanging on stale listener queues.
    with analyser_controller._jobs_lock:
        analyser_controller._jobs.pop(job_id, None)
    return {"job_id": job_id, "reset": True}


@router.post("/sets/{job_id}/shazam-scan/cancel")
async def cancel_scan(job_id: str) -> dict:
    """Stop a running Shazam scan at the next scan-point boundary.

    Returns ``{"cancelled": true}`` if a running scan was flagged, or
    ``{"cancelled": false}`` if no in-flight scan exists for this job.
    Either way the response is 200 — clients can call this idempotently
    without first checking job status.
    """
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    flagged = cancel_shazam_scan(job_id)
    return {"job_id": job_id, "cancelled": flagged}


@router.get("/sets/{job_id}/audio", response_model=None)
async def get_audio(job_id: str) -> FileResponse:
    """Serve the cached set audio with HTTP Range support.

    Lets the frontend play and seek into the analysed audio for the
    "play this section" workflow on the tracklist. Uses the same
    on-disk cache as the analyser-stream subprocess (no re-download).
    """
    snap = get_job_snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    soundcloud_id = snap.get("soundcloud_id")
    if soundcloud_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="job has no associated SoundCloud audio",
        )
    path = audio_cache.cached_set_path(int(soundcloud_id))
    if path is None or not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="audio not yet cached; run analysis first",
        )
    # Browser audio seeking requires Range support, which FileResponse
    # has provided since Starlette 0.45 (already pinned in this project).
    return FileResponse(
        path,
        media_type="audio/mp4",
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-store"},
    )


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
