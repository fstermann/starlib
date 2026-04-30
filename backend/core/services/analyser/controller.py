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
import time
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
    TrackIdentifiedEvent,
    WindowBpmEvent,
    event_from_subprocess_line,
)
from backend.core.services.analyser.pipeline import (
    AnalyserBinaryOptions,
    _summarise_section_for_shazam,
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


_jobs: dict[str, _JobState] = {}
_jobs_lock = asyncio.Lock()


class JobNotFoundError(LookupError):
    """Raised when a job_id has no in-memory state and isn't in the DB."""


async def _get_state(job_id: str) -> _JobState:
    async with _jobs_lock:
        state = _jobs.get(job_id)
    if state is None:
        raise JobNotFoundError(f"job {job_id} not found")
    return state


async def _put_state(state: _JobState) -> None:
    async with _jobs_lock:
        _jobs[state.job_id] = state


async def _maybe_remove_state(job_id: str) -> None:
    async with _jobs_lock:
        state = _jobs.get(job_id)
        if state and state.finished and not state.listeners:
            _jobs.pop(job_id, None)


# ---------------------------------------------------------------------------
# Event broadcast
# ---------------------------------------------------------------------------


async def _broadcast(state: _JobState, event: AnalyserEvent) -> None:
    """Send event to every active listener. Drops listeners whose queue is full."""
    dead: list[asyncio.Queue[AnalyserEvent | None]] = []
    for queue in state.listeners:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            dead.append(queue)
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
    await _put_state(state)
    asyncio.create_task(
        _run_job(
            state,
            fetch_audio=fetch_audio,
            shazam_client=shazam_client or _build_default_shazam(),
            region=None,
            replay_meta=True,
        )
    )
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

    Existing window-BPM rows in those ranges are dropped first so the
    re-emitted events overwrite cleanly. Outside-range data is preserved.
    """
    state = _maybe_revive_state(job_id)
    if state is None:
        raise JobNotFoundError(f"job {job_id} not found")

    if overrides:
        # Spread overrides into a fresh options copy.
        new_opts = state.options.model_copy(update=overrides)
        state.options = new_opts

    db.update_job_status(job_id, status="running")
    await _broadcast(
        state,
        ReanalyseStartedEvent(
            job_id=job_id,
            ranges=[{"start_s": s, "end_s": e} for s, e in ranges],
        ),
    )

    for start_s, end_s in ranges:
        db.delete_windows_in_range(job_id, start_s, end_s)
        await _run_job(
            state,
            fetch_audio=fetch_audio,
            shazam_client=shazam_client or _build_default_shazam(),
            region=(start_s, end_s),
            replay_meta=False,
        )


async def subscribe_to_job(job_id: str) -> AsyncIterator[AnalyserEvent]:
    """Async iterator over events for the SSE endpoint.

    If the job already finished, replays the persisted state once and exits.
    Otherwise yields live events until ``job.complete`` / ``job.error``.
    Backpressure handling: the per-listener queue is bounded; slow consumers
    get unsubscribed (they can reconnect and replay from DB).
    """
    state = _maybe_revive_state(job_id)
    if state is None:
        # Job is finished and gone from memory — replay from DB and exit.
        async for event in _replay_finished_job(job_id):
            yield event
        return

    queue: asyncio.Queue[AnalyserEvent | None] = asyncio.Queue(maxsize=1024)
    state.listeners.append(queue)

    # Replay persisted state so a late subscriber can render the timeline
    # without waiting for the next live event.
    for event in _replay_in_progress_state(state):
        yield event

    try:
        while True:
            event = await queue.get()
            if event is None:
                return
            yield event
            if isinstance(event, (JobCompleteEvent, JobErrorEvent)):
                return
    finally:
        try:
            state.listeners.remove(queue)
        except ValueError:
            pass
        await _maybe_remove_state(job_id)


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
        "tracks": [
            {
                "section_index": t.section_index,
                "title": t.title,
                "artist": t.artist,
                "shazam_id": t.shazam_id,
                "confidence": t.confidence,
                "pitch_offset": t.pitch_offset,
            }
            for t in db.list_track_ids(job_id)
        ],
    }


def recent_jobs(limit: int = 25) -> list[dict]:
    return [
        {
            "id": j.id,
            "soundcloud_id": j.soundcloud_id,
            "title": j.title,
            "artist": j.artist,
            "duration_s": j.duration_s,
            "status": j.status,
            "created_at": j.created_at,
        }
        for j in db.list_recent_jobs(limit=limit)
    ]


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _build_default_shazam() -> ShazamClient:
    return build_rate_limited_client(get_default_client())


def _maybe_revive_state(job_id: str) -> _JobState | None:
    """Return the in-memory state, or rebuild a fresh one for a finished job."""
    state = _jobs.get(job_id)
    if state is not None:
        return state
    job = db.get_job(job_id)
    if job is None:
        return None
    if job.status not in ("running", "pending"):
        return None
    options = AnalyserJobOptions(**job.options) if job.options else AnalyserJobOptions()
    revived = _JobState(job_id=job_id, options=options, finished=False)
    _jobs[job_id] = revived
    return revived


async def _run_job(
    state: _JobState,
    *,
    fetch_audio: AudioFetcher,
    shazam_client: ShazamClient,
    region: tuple[float, float] | None,
    replay_meta: bool,
) -> None:
    """Drive one analyser pass to completion; broadcast events as they arrive."""
    job_id = state.job_id
    db.update_job_status(job_id, status="running")
    try:
        audio_path = await fetch_audio()
    except Exception as exc:
        logger.exception("analyser: audio fetch failed for job %s", job_id)
        db.update_job_status(job_id, status="error", error=f"audio fetch: {exc}")
        await _broadcast(state, JobErrorEvent(job_id=job_id, message=f"audio fetch: {exc}"))
        await _finalise_job(state)
        return

    binary_path = binary_locator.find_analyser_binary()
    bin_options = state.options.to_binary_options(region=region)

    sections_buffer: list[SectionDetectedEvent] = []

    async def listener(payload: dict) -> None:
        event = event_from_subprocess_line(job_id, payload)
        if event is None:
            return
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
        elif isinstance(event, JobCompleteEvent):
            # Emitted later by us, after the Shazam stage.
            return
        elif isinstance(event, JobErrorEvent):
            await _broadcast(state, event)

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
        await _finalise_job(state)
        return

    if rc != 0:
        msg = f"analyser-stream exited with status {rc}"
        db.update_job_status(job_id, status="error", error=msg)
        await _broadcast(state, JobErrorEvent(job_id=job_id, message=msg))
        await _finalise_job(state)
        return

    # Persist the final section list (the subprocess emits the full set
    # at the end of the segmentation stage; we store that snapshot).
    if sections_buffer:
        rows = [
            db.SectionRow(
                section_index=ev.section_index,
                start_s=ev.start_s,
                end_s=ev.end_s,
                confidence=ev.confidence,
            )
            for ev in sections_buffer
        ]
        db.replace_sections(job_id, rows)
        state.sections = sections_buffer

    # Stage: Shazam.
    await _run_shazam_stage(
        state=state,
        audio_path=audio_path,
        sections=sections_buffer,
        client=shazam_client,
    )

    db.update_job_status(job_id, status="complete")
    await _broadcast(state, JobCompleteEvent(job_id=job_id))
    await _finalise_job(state)


async def _run_shazam_stage(
    *,
    state: _JobState,
    audio_path: Path,
    sections: list[SectionDetectedEvent],
    client: ShazamClient,
) -> None:
    """Run Shazam recognition on each section's representative slice."""
    if not sections:
        return
    options = state.options
    section_bpm_lookup = _bpm_per_section(state.job_id, sections)

    async def shazam_one(section: SectionDetectedEvent) -> None:
        offset_s, duration_s = _summarise_section_for_shazam(section.start_s, section.end_s)
        section_bpm = section_bpm_lookup.get(section.section_index, 0.0)
        offsets = select_pitch_offsets(
            section_bpm=section_bpm,
            target_bpm=options.target_bpm,
            bpm_range=options.bpm_range,
            strategy=options.pitch_strategy,
        )
        best: TrackIdentifiedEvent | None = None
        for pitch_offset in offsets:
            cached = db.get_track_id(state.job_id, section.section_index, pitch_offset)
            if cached is not None:
                match = cached
            else:
                try:
                    slice_path = await cache.make_shazam_slice(
                        job_id=state.job_id,
                        section_index=section.section_index,
                        source=audio_path,
                        start_s=offset_s,
                        duration_s=duration_s,
                        pitch_semitones=pitch_offset,
                    )
                except Exception as exc:
                    logger.warning(
                        "analyser: slice generation failed for job %s section %d pitch %.2f: %s",
                        state.job_id, section.section_index, pitch_offset, exc,
                    )
                    continue
                try:
                    response = await client.match(str(slice_path))
                except Exception as exc:
                    logger.warning(
                        "analyser: shazam call failed for job %s section %d: %s",
                        state.job_id, section.section_index, exc,
                    )
                    continue
                title = response.title if response else None
                artist = response.artist if response else None
                shazam_id = response.shazam_id if response else None
                confidence = response.confidence if response else 0.0
                db.upsert_track_id(
                    job_id=state.job_id,
                    section_index=section.section_index,
                    pitch_offset=pitch_offset,
                    title=title,
                    artist=artist,
                    shazam_id=shazam_id,
                    confidence=confidence,
                )
                match = db.TrackIdRow(
                    section_index=section.section_index,
                    pitch_offset=pitch_offset,
                    title=title,
                    artist=artist,
                    shazam_id=shazam_id,
                    confidence=confidence,
                    matched_at=time.time(),
                )

            if match.title is None:
                continue
            event = TrackIdentifiedEvent(
                job_id=state.job_id,
                section_index=section.section_index,
                title=match.title,
                artist=match.artist,
                shazam_id=match.shazam_id,
                confidence=match.confidence,
                pitch_offset=match.pitch_offset,
            )
            if best is None or event.confidence > best.confidence:
                best = event

        if best is not None:
            await _broadcast(state, best)

    tasks = [asyncio.create_task(shazam_one(s)) for s in sections]
    state.shazam_tasks = tasks
    await asyncio.gather(*tasks, return_exceptions=True)


def _bpm_per_section(job_id: str, sections: list[SectionDetectedEvent]) -> dict[int, float]:
    """Return median BPM per section using stored window rows."""
    windows = db.list_windows(job_id)
    out: dict[int, float] = {}
    for section in sections:
        in_section = [w.bpm for w in windows if w.start_s >= section.start_s and w.end_s <= section.end_s and w.bpm > 0]
        if in_section:
            in_section.sort()
            out[section.section_index] = in_section[len(in_section) // 2]
    return out


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
    for t in db.list_track_ids(state.job_id):
        if t.title is None:
            continue
        events.append(
            TrackIdentifiedEvent(
                job_id=state.job_id,
                section_index=t.section_index,
                title=t.title,
                artist=t.artist,
                shazam_id=t.shazam_id,
                confidence=t.confidence,
                pitch_offset=t.pitch_offset,
            )
        )
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
    for t in db.list_track_ids(job_id):
        if t.title is None:
            continue
        yield TrackIdentifiedEvent(
            job_id=job_id,
            section_index=t.section_index,
            title=t.title,
            artist=t.artist,
            shazam_id=t.shazam_id,
            confidence=t.confidence,
            pitch_offset=t.pitch_offset,
        )
    if job.status == "error":
        yield JobErrorEvent(job_id=job_id, message=job.error or "unknown error")
    else:
        yield JobCompleteEvent(job_id=job_id)


async def _finalise_job(state: _JobState) -> None:
    state.finished = True
    for queue in list(state.listeners):
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
