"""Top-level analyser orchestration.

Manages the lifetime of an analyser job — from "user pasted a URL" through
audio fetch → BPM streaming → section detection → Shazam stage → final
SSE ``job.complete``. Exposes:

- :func:`start_job`         — kick off a new job.
- :func:`reanalyse_job`     — re-run analysis over a sub-region.
- :func:`subscribe_to_job`  — async iterator over ``AnalyserEvent`` for SSE.
- :func:`get_job_snapshot`  — current state for the reload / deep-link path.
- :func:`recent_jobs`       — list recent jobs for the home view.

The controller is the only place that knows about all four of: the
subprocess, the Shazam client, the audio cache, and the DB. Everything
else stays decoupled — tests inject their own audio source and Shazam
client through the public ``start_job`` / ``reanalyse_job`` parameters.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from backend.core.services.analyser import binary as binary_locator
from backend.core.services.analyser import cache, db
from backend.core.services.analyser.events import (
    AnalyserEvent,
    JobCompleteEvent,
    JobErrorEvent,
    MetaEvent,
    ReanalyseStartedEvent,
    SectionDetectedEvent,
    ShazamScanEvent,
    ShazamScanStartedEvent,
    TrackTimelineEvent,
    WindowBpmEvent,
    event_from_subprocess_line,
)
from backend.core.services.analyser.pipeline import (
    AnalyserBinaryOptions,
    run_analyser_subprocess,
    select_pitch_offsets,
)
from backend.core.services.analyser.shazam import (
    ShazamClient,
    build_rate_limited_client,
    get_default_client,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tier configuration — Shazam scanning runs in user-driven passes, each
# successively finer. Cadence is the grid step (s) between scan points;
# window is the audio length (s) fed to one Shazam call. Tier ordering
# (sweep < refine < pinpoint) drives cache-hit decisions: a finer-tier
# request will overwrite a coarser cached row, but not vice versa.
# ---------------------------------------------------------------------------


SHAZAM_TIERS: dict[str, dict[str, float]] = {
    "sweep": {"cadence_s": 60.0, "window_s": 12.0},
    "refine": {"cadence_s": 20.0, "window_s": 12.0},
    "pinpoint": {"cadence_s": 8.0, "window_s": 8.0},
}

_TIER_ORDER: dict[str, int] = {"sweep": 0, "refine": 1, "pinpoint": 2}


def _tier_rank(tier: str) -> int:
    return _TIER_ORDER.get(tier, 0)


# ---------------------------------------------------------------------------
# Public job options
# ---------------------------------------------------------------------------


class AnalyserJobOptions(BaseModel):
    """User-supplied analysis configuration."""

    target_bpm: float | None = Field(default=None, gt=0)
    bpm_range: tuple[float, float] | None = None
    pitch_strategy: str = Field(default="none")
    window_s: float = Field(default=30.0, gt=0)
    hop_s: float = Field(default=25.0, gt=0)
    min_section_gap_s: float = Field(default=90.0, gt=0)
    sections_enabled: bool = True
    # Shazam scan grid step (seconds). Decoupled from segmentation —
    # Shazam walks every ``scan_cadence_s`` seconds independent of where
    # the segmenter put boundaries.
    scan_cadence_s: float = Field(default=45.0, gt=0)
    # Length of audio fed to each Shazam call. shazamio's recogniser uses
    # 10 s internally; 12 s gives it a small overlap to settle on.
    scan_window_s: float = Field(default=12.0, gt=0)

    def to_binary_options(self, *, region: tuple[float, float] | None = None) -> AnalyserBinaryOptions:
        return AnalyserBinaryOptions(
            window_s=self.window_s,
            hop_s=self.hop_s,
            bpm_range=self.bpm_range,
            sections_enabled=self.sections_enabled,
            min_gap_s=self.min_section_gap_s,
            start_s=region[0] if region else None,
            end_s=region[1] if region else None,
        )


# ---------------------------------------------------------------------------
# Audio source abstraction (lets tests inject local files)
# ---------------------------------------------------------------------------


# Returns a path to a decoded-on-demand file the analyser CLI can open.
AudioFetcher = Callable[[], Awaitable[Path]]


# ---------------------------------------------------------------------------
# In-memory job registry — listeners + locks
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _JobState:
    """Per-job in-memory state held while a job is running."""

    job_id: str
    options: AnalyserJobOptions
    listeners: list[asyncio.Queue[AnalyserEvent | None]] = field(default_factory=list)
    sections: list[SectionDetectedEvent] = field(default_factory=list)
    last_window_bpm: WindowBpmEvent | None = None
    duration_s: float | None = None
    finished: bool = False
    shazam_tasks: list[asyncio.Task] = field(default_factory=list)
    # Set by ``request_cancel`` to ask the running Shazam scan to stop at
    # the next scan-point boundary. Persisted matches up to that point are
    # kept (the cache is still useful) and the run lands as ``complete``.
    cancel_requested: bool = False
    # Tracks the asyncio task currently driving a single scan point. The
    # cancel handler ``.cancel()``s it so an in-flight ``client.match`` /
    # ffmpeg slice doesn't hold the loop for the full 30 s timeout after
    # the user clicked Stop.
    current_scan_task: asyncio.Task | None = None
    # The ``ShazamScanStartedEvent`` for the currently running scan, if
    # any. Replayed by ``_replay_in_progress_state`` so a reload during
    # a long-running scan still gets the per-run progress signal (tier,
    # region, total_points) — without it the frontend falls back to an
    # indeterminate bar with no "X / Y points" count.
    active_shazam_scan: Any | None = None


_jobs: dict[str, _JobState] = {}
# ``threading.Lock`` (not ``asyncio.Lock``) so sync FastAPI endpoints —
# which run in a worker threadpool — can hold the same lock as the event-
# loop tasks that mutate ``_jobs`` and per-state listener lists. We never
# hold this lock across an ``await``; every protected section is O(1)
# dict / list mutation.
_jobs_lock = threading.Lock()

# Holds strong refs to fire-and-forget pipeline tasks so the GC doesn't
# reap them while they're still streaming events to listeners.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


class JobNotFoundError(LookupError):
    """Raised when a job_id has no in-memory state and isn't in the DB."""


def _get_state(job_id: str) -> _JobState:
    with _jobs_lock:
        state = _jobs.get(job_id)
    if state is None:
        raise JobNotFoundError(f"job {job_id} not found")
    return state


def _put_state(state: _JobState) -> None:
    with _jobs_lock:
        _jobs[state.job_id] = state


def _maybe_remove_state(job_id: str) -> None:
    with _jobs_lock:
        state = _jobs.get(job_id)
        if state and state.finished and not state.listeners:
            _jobs.pop(job_id, None)


def _add_listener(state: _JobState, queue: asyncio.Queue[AnalyserEvent | None]) -> None:
    with _jobs_lock:
        state.listeners.append(queue)


def _remove_listener(state: _JobState, queue: asyncio.Queue[AnalyserEvent | None]) -> None:
    with _jobs_lock:
        try:
            state.listeners.remove(queue)
        except ValueError:
            pass


# ---------------------------------------------------------------------------
# Event broadcast
# ---------------------------------------------------------------------------


async def _broadcast(state: _JobState, event: AnalyserEvent) -> None:
    """Send event to every active listener. Drops listeners whose queue is full."""
    with _jobs_lock:
        listeners = list(state.listeners)
    dead: list[asyncio.Queue[AnalyserEvent | None]] = []
    for queue in listeners:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            dead.append(queue)
    if dead:
        with _jobs_lock:
            for queue in dead:
                try:
                    state.listeners.remove(queue)
                except ValueError:
                    pass


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def start_job(
    *,
    options: AnalyserJobOptions,
    soundcloud_id: int | None = None,
    source_url: str | None = None,
    title: str | None = None,
    artist: str | None = None,
    fetch_audio: AudioFetcher,
    shazam_client: ShazamClient | None = None,
) -> str:
    """Create a new analyser job and start the pipeline. Returns the job id.

    The audio fetcher is invoked in the background after the job row is
    persisted, so the caller gets the job_id back immediately and can start
    streaming events. Errors surface as ``job.error`` events.
    """
    job_id = uuid.uuid4().hex
    db.insert_job(
        job_id=job_id,
        soundcloud_id=soundcloud_id,
        source_url=source_url,
        title=title,
        artist=artist,
        duration_s=None,
        options=options.model_dump(),
    )
    state = _JobState(job_id=job_id, options=options)
    _put_state(state)
    task = asyncio.create_task(
        _run_full_job(
            state,
            fetch_audio=fetch_audio,
            shazam_client=shazam_client or _build_default_shazam(),
        )
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return job_id


async def reanalyse_job(
    job_id: str,
    *,
    ranges: list[tuple[float, float]],
    overrides: dict[str, Any] | None = None,
    fetch_audio: AudioFetcher,
    shazam_client: ShazamClient | None = None,
) -> None:
    """Re-run analysis for the given ranges, updating in-place.

    Existing window-BPM rows and section/track rows in those ranges are
    dropped first so the re-emitted events overwrite cleanly. Outside-range
    data is preserved. Works for jobs in any terminal state — completed
    jobs are revived in memory and finalised once at the end of the loop.
    """
    state = _maybe_revive_state(job_id, allow_finished=True)
    if state is None:
        raise JobNotFoundError(f"job {job_id} not found")

    if overrides:
        new_opts = state.options.model_copy(update=overrides)
        state.options = new_opts
        db.update_job_options(job_id, new_opts.model_dump())

    state.finished = False
    db.update_job_status(job_id, status="running")
    await _broadcast(
        state,
        ReanalyseStartedEvent(
            job_id=job_id,
            ranges=[{"start_s": s, "end_s": e} for s, e in ranges],
        ),
    )

    client = shazam_client or _build_default_shazam()
    failed = False
    for start_s, end_s in ranges:
        db.delete_windows_in_range(job_id, start_s, end_s)
        ok = await _run_pipeline_pass(
            state,
            fetch_audio=fetch_audio,
            shazam_client=client,
            region=(start_s, end_s),
            replay_meta=False,
        )
        if not ok:
            failed = True
            break

    if not failed:
        db.update_job_status(job_id, status="complete")
        await _broadcast(state, JobCompleteEvent(job_id=job_id))
    await _finalise_job(state)


async def _run_full_job(
    state: _JobState,
    *,
    fetch_audio: AudioFetcher,
    shazam_client: ShazamClient,
) -> None:
    """Drive the initial analysis pass to completion + finalise."""
    ok = await _run_pipeline_pass(
        state,
        fetch_audio=fetch_audio,
        shazam_client=shazam_client,
        region=None,
        replay_meta=True,
    )
    if ok:
        db.update_job_status(state.job_id, status="complete")
        await _broadcast(state, JobCompleteEvent(job_id=state.job_id))
    await _finalise_job(state)


async def subscribe_to_job(job_id: str) -> AsyncIterator[AnalyserEvent]:
    """Async iterator over events for the SSE endpoint.

    If the job already finished, replays the persisted state once and exits.
    Otherwise yields live events until ``job.complete`` / ``job.error``.
    Backpressure handling: the per-listener queue is bounded; slow consumers
    get unsubscribed (they can reconnect and replay from DB).
    """
    state = _maybe_revive_state(job_id)
    if state is None:
        # Job is gone from memory and out of running/pending — replay from
        # the DB and exit so the SSE response closes cleanly.
        async for event in _replay_finished_job(job_id):
            yield event
        return

    queue: asyncio.Queue[AnalyserEvent | None] = asyncio.Queue(maxsize=1024)
    _add_listener(state, queue)

    # Replay persisted state so a late subscriber can render the timeline
    # without waiting for the next live event.
    for event in _replay_in_progress_state(state):
        yield event

    try:
        while True:
            queued = await queue.get()
            if queued is None:
                return
            yield queued
            if isinstance(queued, (JobCompleteEvent, JobErrorEvent)):
                return
    finally:
        _remove_listener(state, queue)
        _maybe_remove_state(job_id)


def get_job_snapshot(job_id: str) -> dict | None:
    """Persisted snapshot for the reload / deep-link path."""
    job = db.get_job(job_id)
    if job is None:
        return None
    return {
        "id": job.id,
        "soundcloud_id": job.soundcloud_id,
        "source_url": job.source_url,
        "title": job.title,
        "artist": job.artist,
        "duration_s": job.duration_s,
        "status": job.status,
        "options": job.options,
        "error": job.error,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "windows": [
            {"start_s": w.start_s, "end_s": w.end_s, "bpm": w.bpm, "confidence": w.confidence}
            for w in db.list_windows(job_id)
        ],
        "sections": [
            {
                "section_index": s.section_index,
                "start_s": s.start_s,
                "end_s": s.end_s,
                "confidence": s.confidence,
            }
            for s in db.list_sections(job_id)
        ],
        "scans": [
            {
                "scan_s": s.scan_s,
                "title": s.title,
                "artist": s.artist,
                "shazam_id": s.shazam_id,
                "confidence": s.confidence,
                "pitch_offset": s.pitch_offset,
                "preview_url": s.preview_url,
                "artwork_url": s.artwork_url,
                "tier": s.tier,
            }
            for s in db.list_shazam_scans(job_id)
        ],
        "timeline": [_track_to_dict(t) for t in _materialised_tracks(job_id)],
    }


def _materialised_tracks(job_id: str) -> list[db.TrackRow]:
    """Tracks for the snapshot, with lazy backfill from the Shazam cache.

    Newly-loaded jobs (or jobs whose Shazam scan ran before this table
    existed) need their cached scans materialised into ``analyser_tracks``
    on first read so the user sees a populated tracklist without an
    explicit re-scan. After the first load this is a no-op.
    """
    rows = db.list_tracks(job_id)
    if rows:
        return rows
    inserted = sync_shazam_runs_to_tracks(job_id)
    if inserted == 0:
        return []
    return db.list_tracks(job_id)


def recent_jobs(limit: int = 25) -> list[dict]:
    out: list[dict] = []
    for j in db.list_recent_jobs(limit=limit):
        # Count straight from the materialised tracks table — the list
        # endpoint must not write. Jobs whose Shazam scans haven't been
        # materialised yet show 0 until the user opens them (the snapshot
        # path runs the lazy backfill).
        track_count = db.count_tracks(j.id)
        out.append(
            {
                "id": j.id,
                "soundcloud_id": j.soundcloud_id,
                "title": j.title,
                "artist": j.artist,
                "duration_s": j.duration_s,
                "status": j.status,
                "created_at": j.created_at,
                "track_count": track_count,
            }
        )
    return out


def delete_job(job_id: str) -> bool:
    """Hard-delete a job and every row that references it.

    Drops the in-memory state first so any in-flight subscriber stops
    receiving events from a row that's about to disappear from the DB.
    """
    with _jobs_lock:
        state = _jobs.pop(job_id, None)
        listeners = list(state.listeners) if state is not None else []
    for queue in listeners:
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
    return db.delete_job(job_id)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _build_default_shazam() -> ShazamClient:
    return build_rate_limited_client(get_default_client())


async def _dispatch_subprocess_event(
    event: AnalyserEvent,
    *,
    state: _JobState,
    sections_buffer: list[SectionDetectedEvent],
    replay_meta: bool,
) -> None:
    """Persist + broadcast one event coming off the subprocess listener."""
    job_id = state.job_id
    if isinstance(event, MetaEvent):
        state.duration_s = event.duration_s
        db.update_job_meta(job_id, duration_s=event.duration_s)
        if replay_meta:
            # Carry across the user-facing title/artist that came in via
            # the SoundCloud /resolve hop (already on the DB row).
            event.title = _job_title(job_id)
            event.artist = _job_artist(job_id)
            await _broadcast(state, event)
    elif isinstance(event, WindowBpmEvent):
        db.upsert_window_bpm(
            job_id=job_id,
            start_s=event.start_s,
            end_s=event.end_s,
            bpm=event.bpm,
            confidence=event.confidence,
        )
        state.last_window_bpm = event
        await _broadcast(state, event)
    elif isinstance(event, SectionDetectedEvent):
        sections_buffer.append(event)
        await _broadcast(state, event)
    elif isinstance(event, JobErrorEvent):
        await _broadcast(state, event)
    # JobCompleteEvent is emitted by the controller, not the subprocess.


def _maybe_revive_state(job_id: str, *, allow_finished: bool = False) -> _JobState | None:
    """Return the in-memory state, or rebuild a fresh one from the DB.

    ``allow_finished=True`` lets a re-analyse caller revive a completed
    job. The default (``False``) preserves the subscribe path's contract
    of replaying from the DB once a job has reached a terminal state.
    """
    with _jobs_lock:
        state = _jobs.get(job_id)
    if state is not None:
        return state
    job = db.get_job(job_id)
    if job is None:
        return None
    if not allow_finished and job.status not in ("running", "pending"):
        return None
    options = AnalyserJobOptions(**job.options) if job.options else AnalyserJobOptions()
    revived = _JobState(
        job_id=job_id,
        options=options,
        finished=False,
        duration_s=job.duration_s,
    )
    with _jobs_lock:
        # Race: another caller may have revived first while we built ours.
        # Stick with whichever landed first so listeners aren't split
        # across two parallel state objects.
        existing = _jobs.get(job_id)
        if existing is not None:
            return existing
        _jobs[job_id] = revived
    return revived


async def _run_pipeline_pass(
    state: _JobState,
    *,
    fetch_audio: AudioFetcher,
    shazam_client: ShazamClient,
    region: tuple[float, float] | None,
    replay_meta: bool,
) -> bool:
    """Drive one analyser pass; return ``True`` on success, ``False`` on error.

    On error this still broadcasts a :class:`JobErrorEvent` and writes the
    error to the DB — but does **not** finalise the job (close listener
    queues / emit ``job.complete``). That's the caller's responsibility,
    so multi-range re-analyse can chain passes without tearing down the
    SSE connection between them.
    """
    job_id = state.job_id
    db.update_job_status(job_id, status="running")
    try:
        audio_path = await fetch_audio()
    except Exception as exc:
        logger.exception("analyser: audio fetch failed for job %s", job_id)
        db.update_job_status(job_id, status="error", error=f"audio fetch: {exc}")
        await _broadcast(state, JobErrorEvent(job_id=job_id, message=f"audio fetch: {exc}"))
        return False

    # For a partial re-analyse, new section indices coming off the
    # subprocess (always ``0..N-1``) would collide with rows from prior
    # passes. Offset them past the highest surviving index.
    section_index_offset = 0
    if region is not None:
        existing = db.list_sections(job_id)
        r0, r1 = region
        survivors_max = max(
            (s.section_index for s in existing if not (s.start_s >= r0 and s.end_s <= r1)),
            default=-1,
        )
        section_index_offset = survivors_max + 1

    binary_path = binary_locator.find_analyser_binary()
    bin_options = state.options.to_binary_options(region=region)

    sections_buffer: list[SectionDetectedEvent] = []

    async def listener(payload: dict) -> None:
        event = event_from_subprocess_line(job_id, payload)
        if event is None:
            return
        if isinstance(event, SectionDetectedEvent) and section_index_offset:
            event.section_index += section_index_offset
        await _dispatch_subprocess_event(
            event,
            state=state,
            sections_buffer=sections_buffer,
            replay_meta=replay_meta,
        )

    try:
        rc = await run_analyser_subprocess(
            binary_path=binary_path,
            input_path=audio_path,
            options=bin_options,
            listener=listener,
        )
    except Exception as exc:
        logger.exception("analyser: subprocess crashed for job %s", job_id)
        db.update_job_status(job_id, status="error", error=str(exc))
        await _broadcast(state, JobErrorEvent(job_id=job_id, message=str(exc)))
        return False

    if rc != 0:
        msg = f"analyser-stream exited with status {rc}"
        db.update_job_status(job_id, status="error", error=msg)
        await _broadcast(state, JobErrorEvent(job_id=job_id, message=msg))
        return False

    _persist_sections_for_pass(job_id, region, sections_buffer)
    if sections_buffer:
        state.sections = sections_buffer

    return True


def _persist_sections_for_pass(
    job_id: str,
    region: tuple[float, float] | None,
    sections_buffer: list[SectionDetectedEvent],
) -> None:
    """Write new section rows; full-pass replaces, partial-pass merges."""
    new_section_rows = [
        db.SectionRow(
            section_index=ev.section_index,
            start_s=ev.start_s,
            end_s=ev.end_s,
            confidence=ev.confidence,
        )
        for ev in sections_buffer
    ]
    if region is None:
        # Full pass: clean slate replace.
        db.replace_sections(job_id, new_section_rows)
        return
    # Partial pass: drop old in-range sections; insert renumbered new rows.
    db.delete_sections_in_range(job_id, region[0], region[1])
    db.insert_sections(job_id, new_section_rows)


# ---------------------------------------------------------------------------
# Shazam scan stage — decoupled from segmentation
# ---------------------------------------------------------------------------


async def start_shazam_scan(
    job_id: str,
    *,
    fetch_audio: AudioFetcher,
    tier: str = "sweep",
    region: tuple[float, float] | None = None,
    cadence_s: float | None = None,
    window_s: float | None = None,
    overrides: dict[str, Any] | None = None,
    shazam_client: ShazamClient | None = None,
) -> None:
    """Run a Shazam scan in the requested tier (and optional region).

    ``tier`` selects the scan resolution — ``sweep`` (60 s grid) for the
    first pass, ``refine`` (20 s) and ``pinpoint`` (8 s) for progressively
    finer follow-ups. ``cadence_s`` / ``window_s`` override the tier
    defaults (used by region rescans with custom params). ``region``
    restricts the scan to ``[start, end]`` instead of the full mix.

    Confirmed tracks (``AnalyserTrack.confirmed=True``) are excluded — the
    scheduler subtracts their time spans from the grid, regardless of
    tier.

    Walks the audio at the resolved cadence; for each scan point, looks up
    the local BPM, computes pitch candidates, and queries Shazam. Emits
    ``shazam.scan`` per attempt and ``track.timeline`` per aggregated run.
    Finalises with ``job.complete`` (or ``job.error`` on failure).
    Idempotent against cached scan rows of equal-or-finer tier; coarser
    cached rows are re-queried so finer tiers actually refine.
    """
    if tier not in SHAZAM_TIERS:
        raise ValueError(f"unknown shazam tier: {tier!r}")
    state = _maybe_revive_state(job_id, allow_finished=True)
    if state is None:
        raise JobNotFoundError(f"job {job_id} not found")
    if overrides:
        new_opts = state.options.model_copy(update=overrides)
        state.options = new_opts
        db.update_job_options(job_id, new_opts.model_dump())
    state.finished = False
    state.cancel_requested = False
    state.current_scan_task = None
    state.active_shazam_scan = None
    db.update_job_status(job_id, status="running")
    client = shazam_client or _build_default_shazam()
    try:
        await _run_shazam_scan(
            state,
            fetch_audio=fetch_audio,
            client=client,
            tier=tier,
            region=region,
            cadence_s=cadence_s,
            window_s=window_s,
        )
    except asyncio.CancelledError:
        # Came in via ``cancel_shazam_scan`` cancelling the in-flight scan
        # task. Treat the run as a clean (partial) completion rather than
        # an error so the UI doesn't show a red banner for a deliberate
        # user action.
        logger.info("analyser: shazam scan cancelled for job %s", job_id)
    except Exception as exc:
        logger.exception("analyser: shazam scan failed for job %s", job_id)
        db.update_job_status(job_id, status="error", error=str(exc))
        await _broadcast(state, JobErrorEvent(job_id=job_id, message=str(exc)))
        await _finalise_job(state)
        return
    finally:
        state.current_scan_task = None
        state.active_shazam_scan = None
    db.update_job_status(job_id, status="complete")
    await _broadcast(state, JobCompleteEvent(job_id=job_id))
    await _finalise_job(state)


def cancel_shazam_scan(job_id: str) -> bool:
    """Ask the in-flight Shazam scan to stop as soon as possible.

    Sets the ``cancel_requested`` flag *and* ``.cancel()``s the asyncio
    task running the current scan point — without that second step the
    loop would block for up to ~30 s waiting on the active ``client.match``
    / ffmpeg subprocess before reaching the next iteration's flag check.

    Returns ``True`` if a running scan was found and flagged, ``False`` if
    no in-memory job state exists (e.g. the scan already finished or
    was never started). Cached partial results are kept — the user can
    re-run later and the cache will short-circuit the points already
    processed.
    """
    with _jobs_lock:
        state = _jobs.get(job_id)
    if state is None:
        return False
    state.cancel_requested = True
    task = state.current_scan_task
    if task is not None and not task.done():
        task.cancel()
    return True


async def _run_shazam_scan(
    state: _JobState,
    *,
    fetch_audio: AudioFetcher,
    client: ShazamClient,
    tier: str = "sweep",
    region: tuple[float, float] | None = None,
    cadence_s: float | None = None,
    window_s: float | None = None,
) -> None:
    """Slide a Shazam query window across the requested region."""
    duration = state.duration_s or _job_duration(state.job_id)
    if duration is None or duration <= 0.0:
        raise RuntimeError("job has no known duration; run BPM analysis first")
    audio_path = await fetch_audio()

    tier_params = SHAZAM_TIERS[tier]
    cadence = max(float(cadence_s if cadence_s is not None else tier_params["cadence_s"]), 1.0)
    window = max(float(window_s if window_s is not None else tier_params["window_s"]), 1.0)

    region_start = max(0.0, region[0]) if region else 0.0
    region_end = min(duration, region[1]) if region else duration
    if region_end <= region_start:
        logger.info("analyser: shazam scan got empty region for job %s", state.job_id)
        return

    # Step from region_start to the latest start that still fits a full window.
    last_start = max(region_start, region_end - window)
    grid = _build_scan_grid(cadence=cadence, start=region_start, last_start=last_start)
    confirmed_ranges = db.list_confirmed_ranges(state.job_id)
    grid_full = grid
    grid = _grid_minus_ranges(grid, confirmed_ranges, window=window)
    skipped = len(grid_full) - len(grid)
    bpm_at = _bpm_lookup(state.job_id)

    # Run scan points in order rather than fanning out — the rate-limited
    # client serialises them anyway, and ordered emission lets the UI fill
    # the timeline progressively.
    state.shazam_tasks = []
    logger.info(
        "analyser: shazam scan starting for job %s tier=%s — %d points "
        "(skipped %d confirmed) across %.1f-%.1fs (cadence %.1fs window %.1fs)",
        state.job_id,
        tier,
        len(grid),
        skipped,
        region_start,
        region_end,
        cadence,
        window,
    )
    # Reset the frontend's per-run progress before any scan event lands.
    started = ShazamScanStartedEvent(
        job_id=state.job_id,
        tier=tier,
        region=(region_start, region_end) if region else None,
        total_points=len(grid),
    )
    state.active_shazam_scan = started
    await _broadcast(state, started)
    for idx, scan_s in enumerate(grid, start=1):
        if state.cancel_requested:
            logger.info(
                "analyser: shazam scan cancelled for job %s after %d/%d points",
                state.job_id,
                idx - 1,
                len(grid),
            )
            break
        # Wrap each scan point in its own task so ``cancel_shazam_scan``
        # can interrupt the in-flight ffmpeg / shazamio call directly
        # rather than waiting for it to time out at the loop boundary.
        task = asyncio.create_task(
            _scan_point(
                state,
                scan_s=scan_s,
                audio_path=audio_path,
                window=window,
                bpm_at=bpm_at,
                client=client,
                tier=tier,
            )
        )
        state.current_scan_task = task
        try:
            await task
        except asyncio.CancelledError:
            logger.info(
                "analyser: shazam scan interrupted mid-point for job %s at %.1fs",
                state.job_id,
                scan_s,
            )
            break
        finally:
            state.current_scan_task = None
        # Materialise + broadcast newly-recognised tracks live, so the
        # tracklist fills as the scan walks instead of waiting for the
        # full pass to finish (a 20-min refine over a 76-min set takes
        # several minutes — too long to leave the user staring at an
        # empty tracklist). Idempotent on (job_id, shazam_id) so re-runs
        # don't duplicate work.
        await _sync_and_broadcast_new_tracks(state)
        if idx % 10 == 0 or idx == len(grid):
            logger.info(
                "analyser: shazam scan progress for job %s — %d/%d (%.1fs)",
                state.job_id,
                idx,
                len(grid),
                scan_s,
            )

    # Final pass — catches any straggler runs (e.g., a single-point match
    # that the per-point sync didn't yet aggregate) and broadcasts the
    # complete tracklist for late subscribers.
    sync_shazam_runs_to_tracks(state.job_id)
    for t in db.list_tracks(state.job_id):
        await _broadcast(state, _track_to_event(state.job_id, t))


async def _sync_and_broadcast_new_tracks(state: _JobState) -> None:
    """Run a sync pass and broadcast track.timeline events for any rows
    that didn't exist before. Cheap: ``sync_shazam_runs_to_tracks``
    short-circuits on already-materialised shazam_ids."""
    before = {t.id for t in db.list_tracks(state.job_id)}
    inserted = sync_shazam_runs_to_tracks(state.job_id)
    if inserted == 0:
        return
    for t in db.list_tracks(state.job_id):
        if t.id in before:
            continue
        await _broadcast(state, _track_to_event(state.job_id, t))


async def _scan_point(
    state: _JobState,
    *,
    scan_s: float,
    audio_path: Path,
    window: float,
    bpm_at: Callable[[float], float],
    client: ShazamClient,
    tier: str = "sweep",
) -> None:
    """Run all pitch attempts for one scan point, persist + broadcast events."""
    options = state.options
    local_bpm = bpm_at(scan_s)
    offsets = select_pitch_offsets(
        section_bpm=local_bpm,
        target_bpm=options.target_bpm,
        bpm_range=options.bpm_range,
        strategy=options.pitch_strategy,
    )
    events_for_point: list[ShazamScanEvent] = []
    for pitch_offset in offsets:
        ev = await _resolve_scan_attempt(
            state=state,
            audio_path=audio_path,
            scan_s=scan_s,
            window=window,
            pitch_offset=pitch_offset,
            client=client,
            tier=tier,
        )
        events_for_point.append(ev)
    # Broadcast every real match (highest confidence first); fall back to
    # a single null event so the UI still registers progress at this point.
    matches = sorted(
        (ev for ev in events_for_point if ev.title is not None),
        key=lambda e: e.confidence,
        reverse=True,
    )
    if matches:
        for ev in matches:
            await _broadcast(state, ev)
    else:
        await _broadcast(
            state,
            ShazamScanEvent(
                job_id=state.job_id,
                scan_s=scan_s,
                title=None,
                artist=None,
                shazam_id=None,
                confidence=0.0,
                pitch_offset=offsets[0] if offsets else 0.0,
                tier=tier,
            ),
        )


async def _resolve_scan_attempt(
    *,
    state: _JobState,
    audio_path: Path,
    scan_s: float,
    window: float,
    pitch_offset: float,
    client: ShazamClient,
    tier: str = "sweep",
) -> ShazamScanEvent:
    """Look up a cached hit (or run shazamio) for one (scan_s, pitch_offset).

    The audio fed to Shazam at a given ``(scan_s, pitch_offset, window)``
    is identical across tiers — tiers only differ in *which* scan points
    get walked. So a cached match from any tier short-circuits any later
    request. Cached misses (``title=None``) re-fire because they were
    often transient at the point they were recorded.
    """
    cached = db.get_shazam_scan(state.job_id, scan_s, pitch_offset)
    title: str | None
    artist: str | None
    shazam_id: str | None
    confidence: float
    preview_url: str | None
    artwork_url: str | None
    cache_hit = cached is not None and cached.title is not None
    if cache_hit:
        assert cached is not None
        title = cached.title
        artist = cached.artist
        shazam_id = cached.shazam_id
        confidence = cached.confidence
        preview_url = cached.preview_url
        artwork_url = cached.artwork_url
    else:
        (
            title,
            artist,
            shazam_id,
            confidence,
            preview_url,
            artwork_url,
        ) = await _shazam_at(
            state=state,
            audio_path=audio_path,
            scan_s=scan_s,
            duration_s=window,
            pitch_semitones=pitch_offset,
            client=client,
        )
        db.upsert_shazam_scan(
            job_id=state.job_id,
            scan_s=scan_s,
            pitch_offset=pitch_offset,
            title=title,
            artist=artist,
            shazam_id=shazam_id,
            confidence=confidence,
            preview_url=preview_url,
            artwork_url=artwork_url,
            tier=tier,
        )
    # Emit the *active* tier on live broadcasts so the frontend counts
    # this scan toward the current run's progress — even on cache hits.
    # (The cached row's stored tier still wins on replay, where the
    # historical attribution matters; see ``_replay_in_progress_state``.)
    return ShazamScanEvent(
        job_id=state.job_id,
        scan_s=scan_s,
        title=title,
        artist=artist,
        shazam_id=shazam_id,
        confidence=confidence,
        pitch_offset=pitch_offset,
        tier=tier,
        preview_url=preview_url,
        artwork_url=artwork_url,
    )


async def _shazam_at(
    *,
    state: _JobState,
    audio_path: Path,
    scan_s: float,
    duration_s: float,
    pitch_semitones: float,
    client: ShazamClient,
) -> tuple[str | None, str | None, str | None, float, str | None, str | None]:
    """Run a single Shazam call. Slice + match exceptions become a miss.

    Returns ``(title, artist, shazam_id, confidence, preview_url,
    artwork_url)``. The trailing two are ``None`` for misses or when
    Shazam's response doesn't include a preview/artwork.
    """
    miss: tuple[str | None, str | None, str | None, float, str | None, str | None] = (
        None,
        None,
        None,
        0.0,
        None,
        None,
    )
    try:
        slice_path = await cache.make_shazam_slice(
            job_id=state.job_id,
            section_index=int(scan_s),  # used only as a filename token
            source=audio_path,
            start_s=scan_s,
            duration_s=duration_s,
            pitch_semitones=pitch_semitones,
        )
    except Exception as exc:
        logger.warning(
            "analyser: slice generation failed for job %s scan %.1f pitch %.2f: %s",
            state.job_id,
            scan_s,
            pitch_semitones,
            exc,
        )
        return miss
    # shazamio can hang indefinitely on transient network glitches — its
    # internal recogniser doesn't enforce a per-call timeout. 12 s is
    # well past Shazam's typical <2 s response, so legitimate matches
    # land while a stuck call gets cut short of dragging the whole scan
    # through a 30 s wait per bad slice. The caller caches the miss; if
    # the network was just briefly down, the next scan run picks it up.
    try:
        response = await asyncio.wait_for(client.match(str(slice_path)), timeout=12.0)
    except TimeoutError:
        logger.warning(
            "analyser: shazam call timed out for job %s scan %.1f",
            state.job_id,
            scan_s,
        )
        return miss
    except Exception as exc:
        logger.warning(
            "analyser: shazam call failed for job %s scan %.1f: %s",
            state.job_id,
            scan_s,
            exc,
        )
        return miss
    if response is None:
        return miss
    return (
        response.title,
        response.artist,
        response.shazam_id,
        response.confidence,
        response.preview_url,
        response.artwork_url,
    )


def _build_scan_grid(*, cadence: float, last_start: float, start: float = 0.0) -> list[float]:
    grid: list[float] = []
    t = start
    while t <= last_start + 1e-6:
        grid.append(round(t, 3))
        t += cadence
    return grid


def _grid_minus_ranges(
    grid: list[float],
    ranges: list[tuple[float, float]],
    *,
    window: float,
) -> list[float]:
    """Drop any scan_s whose ``[scan_s, scan_s + window]`` overlaps a range.

    ``ranges`` are confirmed-track spans. We remove a scan point if its
    audio window touches any confirmed span at all — even partial overlap
    means the user already validated that audio, so re-querying it spends
    rate-limit budget for no gain.
    """
    if not ranges:
        return list(grid)
    kept: list[float] = []
    for scan_s in grid:
        s_end = scan_s + window
        overlapped = False
        for r_start, r_end in ranges:
            if s_end > r_start and scan_s < r_end:
                overlapped = True
                break
        if not overlapped:
            kept.append(scan_s)
    return kept


def _bpm_lookup(job_id: str) -> Callable[[float], float]:
    """Return ``f(t)`` → median BPM of windows overlapping ``t`` (or 0.0)."""
    windows = db.list_windows(job_id)

    def at(t: float) -> float:
        hits = [w.bpm for w in windows if w.start_s <= t <= w.end_s and w.bpm > 0]
        if not hits:
            return 0.0
        hits.sort()
        return hits[len(hits) // 2]

    return at


@dataclass(slots=True)
class _TimelineRun:
    start_s: float
    end_s: float
    title: str
    artist: str | None
    shazam_id: str | None
    confidence: float
    source: str = "shazam"
    override_id: int | None = None
    soundcloud_id: int | None = None
    soundcloud_permalink_url: str | None = None
    duration_s: float | None = None
    # Representative pitch_offset (semitones) for the run — taken from
    # the highest-confidence scan in the run, since that's the offset
    # Shazam most cleanly recognised at.
    pitch_offset: float | None = None
    # Best artwork URL seen across the run's scans. Populated lazily
    # because Shazam doesn't always return artwork on every match —
    # falling back to the first scan with a non-null value preserves
    # covers across mixed-result runs.
    artwork_url: str | None = None


def _best_per_scan_point(scans: list[db.ShazamScanRow]) -> list[db.ShazamScanRow]:
    """Reduce a fan-out list of scans (multiple pitch attempts per point)
    to one row per ``scan_s`` — the highest-confidence non-null match,
    falling back to a null row if no pitch attempt at that point matched."""
    by_point: dict[float, db.ShazamScanRow] = {}
    for row in scans:
        existing = by_point.get(row.scan_s)
        if existing is None:
            by_point[row.scan_s] = row
            continue
        existing_real = existing.title is not None
        row_real = row.title is not None
        if row_real and not existing_real:
            by_point[row.scan_s] = row
        elif row_real and existing_real and row.confidence > existing.confidence:
            by_point[row.scan_s] = row
    return [by_point[k] for k in sorted(by_point.keys())]


def _aggregate_timeline(scans: list[db.ShazamScanRow]) -> list[_TimelineRun]:
    """Collapse consecutive matching scan rows into one ``_TimelineRun`` each.

    De-duplicates input to one row per ``scan_s`` (best match) before
    walking the grid — runs are defined on the dominant track per point,
    not on every alternate pitch hit.
    """
    # Side-table of any artwork we saw for each shazam_id across pitch
    # alternates. Used as a fallback when the highest-confidence row
    # didn't carry artwork but a lower-confidence alternate did.
    artwork_by_id: dict[str, str] = {}
    for row in scans:
        if row.shazam_id is None or row.artwork_url is None:
            continue
        artwork_by_id.setdefault(row.shazam_id, row.artwork_url)

    runs: list[_TimelineRun] = []
    open_run: _TimelineRun | None = None
    for row in _best_per_scan_point(scans):
        if row.title is None:
            if open_run is not None:
                runs.append(open_run)
                open_run = None
            continue
        key = row.shazam_id or f"{row.title}|{row.artist}"
        open_key = open_run and (open_run.shazam_id or f"{open_run.title}|{open_run.artist}")
        if open_run is not None and open_key == key:
            open_run.end_s = row.scan_s
            # Use the row from the highest-confidence point in the run as
            # the representative pitch_offset — that's the offset Shazam
            # matched cleanest at, so it's the best estimate of the DJ's
            # pitch shift for this track.
            if row.confidence > open_run.confidence:
                open_run.pitch_offset = row.pitch_offset
            open_run.confidence = max(open_run.confidence, row.confidence)
            # Hold onto the first artwork we see — Shazam can return null
            # on some matches even when others in the run carried it.
            if open_run.artwork_url is None:
                open_run.artwork_url = row.artwork_url
        else:
            if open_run is not None:
                runs.append(open_run)
            open_run = _TimelineRun(
                start_s=row.scan_s,
                end_s=row.scan_s,
                title=row.title,
                artist=row.artist,
                shazam_id=row.shazam_id,
                confidence=row.confidence,
                pitch_offset=row.pitch_offset,
                artwork_url=row.artwork_url,
            )
    if open_run is not None:
        runs.append(open_run)
    # Backfill artwork for any run whose representative scan was a
    # null-artwork match but a sibling pitch attempt carried one.
    for r in runs:
        if r.artwork_url is None and r.shazam_id is not None:
            r.artwork_url = artwork_by_id.get(r.shazam_id)
    return runs


def sync_shazam_runs_to_tracks(job_id: str) -> int:
    """Materialise Shazam-aggregated runs into ``analyser_tracks`` rows.

    Idempotent on ``(job_id, shazam_id)``:
    - Row already exists for this shazam_id → leave it alone (preserves
      user edits + dismissals — option (b) re-scan policy).
    - No row yet → insert as ``origin='shazam'``.

    Returns the number of newly-inserted rows. Called at the end of a
    Shazam scan and lazily on snapshot read for legacy jobs.
    """
    runs = _aggregate_timeline(db.list_shazam_scans(job_id))
    windows = db.list_windows(job_id)
    inserted = 0
    for run in runs:
        if run.shazam_id is None:
            # Without a shazam_id we have no idempotency key. Skip — the
            # user can add it manually if it matters. (Shazam misses
            # don't reach this code path anyway since misses get title=None
            # and aggregation drops them.)
            continue
        set_bpm = _median_bpm_in_range(windows, run.start_s, run.end_s)
        existing = db.get_track_by_shazam_id(job_id, run.shazam_id)
        if existing is None:
            db.insert_track(
                job_id=job_id,
                origin="shazam",
                start_s=run.start_s,
                end_s=run.end_s,
                title=run.title,
                artist=run.artist,
                shazam_id=run.shazam_id,
                artwork_url=run.artwork_url,
                set_bpm=set_bpm,
                pitch_offset=run.pitch_offset,
            )
            inserted += 1
            continue
        # Existing Shazam-origin row — extend end_s and refresh derived
        # BPM signals as the run grows during a live scan, but never
        # overwrite user edits (option (b) re-scan policy).
        if existing.user_edited or existing.origin != "shazam":
            continue
        db.update_track(
            job_id,
            existing.id,
            end_s=run.end_s,
            set_bpm=set_bpm,
            pitch_offset=run.pitch_offset,
            artwork_url=run.artwork_url if existing.artwork_url is None else None,
        )
    return inserted


def _median_bpm_in_range(windows: list[db.WindowBpmRow], start_s: float, end_s: float) -> float | None:
    """Median BPM of windows overlapping ``[start_s, end_s]``. ``None`` if
    no usable window touches the range — keeps the column honestly empty
    rather than seeded with 0.0."""
    hits = [w.bpm for w in windows if w.bpm > 0 and w.start_s <= end_s and w.end_s >= start_s]
    if not hits:
        return None
    hits.sort()
    return hits[len(hits) // 2]


def _track_to_event(job_id: str, t: db.TrackRow) -> TrackTimelineEvent:
    """Wire-format conversion. The frontend's snapshot path now reads
    these fields directly from the snapshot dict; the SSE event still
    uses the old ``TrackTimelineEvent`` shape so existing subscribers
    keep working."""
    return TrackTimelineEvent(
        job_id=job_id,
        start_s=t.start_s,
        end_s=t.end_s if t.end_s is not None else t.start_s,
        title=t.title,
        artist=t.artist,
        shazam_id=t.shazam_id,
        confidence=1.0,
        source=t.origin,  # type: ignore[arg-type]
        override_id=t.id,
        soundcloud_id=t.soundcloud_id,
        soundcloud_permalink_url=t.soundcloud_permalink_url,
        artwork_url=t.artwork_url,
        duration_s=t.duration_s,
        set_bpm=t.set_bpm,
        pitch_offset=t.pitch_offset,
        confirmed=t.confirmed,
        user_edited=t.user_edited,
    )


def _track_to_dict(t: db.TrackRow) -> dict:
    """Snapshot serialisation — what the frontend's ``TrackTimelineEntry``
    consumes. Matches the SSE event shape so the same reducer can apply
    both."""
    return {
        "id": t.id,
        "start_s": t.start_s,
        "end_s": t.end_s if t.end_s is not None else t.start_s,
        "title": t.title,
        "artist": t.artist,
        "shazam_id": t.shazam_id,
        "confidence": 1.0,
        "source": t.origin,
        "soundcloud_id": t.soundcloud_id,
        "soundcloud_permalink_url": t.soundcloud_permalink_url,
        "artwork_url": t.artwork_url,
        "duration_s": t.duration_s,
        "confirmed": t.confirmed,
        "user_edited": t.user_edited,
        "set_bpm": t.set_bpm,
        "pitch_offset": t.pitch_offset,
    }


def _job_duration(job_id: str) -> float | None:
    job = db.get_job(job_id)
    return job.duration_s if job else None


def _replay_in_progress_state(state: _JobState) -> list[AnalyserEvent]:
    """Synthesise events for everything persisted so far."""
    events: list[AnalyserEvent] = []
    if state.duration_s is not None:
        events.append(
            MetaEvent(
                job_id=state.job_id,
                duration_s=state.duration_s,
                sample_rate=22050,
                title=_job_title(state.job_id),
                artist=_job_artist(state.job_id),
            )
        )
    for w in db.list_windows(state.job_id):
        events.append(
            WindowBpmEvent(
                job_id=state.job_id,
                start_s=w.start_s,
                end_s=w.end_s,
                bpm=w.bpm,
                confidence=w.confidence,
            )
        )
    for s in db.list_sections(state.job_id):
        events.append(
            SectionDetectedEvent(
                job_id=state.job_id,
                section_index=s.section_index,
                start_s=s.start_s,
                end_s=s.end_s,
                confidence=s.confidence,
            )
        )
    if state.active_shazam_scan is not None:
        events.append(state.active_shazam_scan)
    for scan in db.list_shazam_scans(state.job_id):
        events.append(
            ShazamScanEvent(
                job_id=state.job_id,
                scan_s=scan.scan_s,
                title=scan.title,
                artist=scan.artist,
                shazam_id=scan.shazam_id,
                confidence=scan.confidence,
                pitch_offset=scan.pitch_offset,
                tier=scan.tier,
            )
        )
    for t in _materialised_tracks(state.job_id):
        events.append(_track_to_event(state.job_id, t))
    return events


async def _replay_finished_job(job_id: str) -> AsyncIterator[AnalyserEvent]:
    """Replay a finished job's events from the DB, then close."""
    job = db.get_job(job_id)
    if job is None:
        return
    yield MetaEvent(
        job_id=job_id,
        duration_s=job.duration_s or 0.0,
        sample_rate=22050,
        title=job.title,
        artist=job.artist,
    )
    for w in db.list_windows(job_id):
        yield WindowBpmEvent(
            job_id=job_id,
            start_s=w.start_s,
            end_s=w.end_s,
            bpm=w.bpm,
            confidence=w.confidence,
        )
    for s in db.list_sections(job_id):
        yield SectionDetectedEvent(
            job_id=job_id,
            section_index=s.section_index,
            start_s=s.start_s,
            end_s=s.end_s,
            confidence=s.confidence,
        )
    for scan in db.list_shazam_scans(job_id):
        yield ShazamScanEvent(
            job_id=job_id,
            scan_s=scan.scan_s,
            title=scan.title,
            artist=scan.artist,
            shazam_id=scan.shazam_id,
            confidence=scan.confidence,
            pitch_offset=scan.pitch_offset,
            tier=scan.tier,
        )
    for t in _materialised_tracks(job_id):
        yield _track_to_event(job_id, t)
    if job.status == "error":
        yield JobErrorEvent(job_id=job_id, message=job.error or "unknown error")
    else:
        yield JobCompleteEvent(job_id=job_id)


async def _finalise_job(state: _JobState) -> None:
    state.finished = True
    with _jobs_lock:
        listeners = list(state.listeners)
    for queue in listeners:
        try:
            queue.put_nowait(None)  # sentinel: subscribers exit
        except asyncio.QueueFull:
            pass


def _job_title(job_id: str) -> str | None:
    job = db.get_job(job_id)
    return job.title if job else None


def _job_artist(job_id: str) -> str | None:
    job = db.get_job(job_id)
    return job.artist if job else None
