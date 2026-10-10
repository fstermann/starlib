"""Analyse one track: stems, measurements, then first-guess sections.

Tracks are local files or SoundCloud tracks, which are downloaded first.

Analysis runs as an in-memory background job per file, with progress events
for an SSE stream. Results live on disk and edits in SQLite, so a restarted
backend only loses jobs that were still running.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.domain.arrangement import BarLevels, Section, detect_sections, validate_sections
from backend.infra.breakdown import stems as stems_infra
from backend.infra.breakdown import track as track_infra
from backend.infra.breakdown import track_db

logger = logging.getLogger(__name__)

# Must match `starlib_audio::breakdown::PIPELINE_VERSION`.
PIPELINE_VERSION = 1

StageCallback = Callable[[str, float | None], None]


@dataclass(frozen=True)
class SoundCloudTrack:
    """The SoundCloud track a download came from.

    Attributes:
        id: SoundCloud track id.
        title: Track title.
        artist: Uploader name.
        artwork_url: Cover image.
    """

    id: int
    title: str | None = None
    artist: str | None = None
    artwork_url: str | None = None


# Downloads a SoundCloud track's audio; returns the file and the track's details.
FetchSoundCloud = Callable[[], Awaitable[tuple[Path, SoundCloudTrack]]]


class DownloadError(RuntimeError):
    """The SoundCloud audio couldn't be downloaded."""


@dataclass(frozen=True)
class TrackBreakdown:
    """Measured features and sections of one track.

    Attributes:
        digest: Hash of the decoded audio; the cache key.
        features: The ``features.json`` document.
        sections: The user's sections if edited, else the detected ones.
        detected_sections: Sections as detected from the features.
        sections_edited: Whether ``sections`` are user edits.
        grid_edited: Whether the bar grid is a user edit.
        soundcloud: The SoundCloud track it was last opened from, if any.
    """

    digest: str
    features: dict[str, Any]
    sections: list[Section]
    detected_sections: list[Section]
    sections_edited: bool
    grid_edited: bool
    soundcloud: SoundCloudTrack | None = None


async def analyse_track(
    path: Path,
    on_stage: StageCallback = lambda _stage, _progress: None,
    soundcloud: SoundCloudTrack | None = None,
) -> TrackBreakdown:
    """Analyse ``path``, reusing cached stems and features when they still apply.

    Args:
        path: Local audio file.
        on_stage: Called with ``"hash"``, ``"stems"`` and ``"drum_parts"``
            (with progress 0 to 1), then each measured source name.
        soundcloud: The SoundCloud track ``path`` was downloaded from, if any.

    Returns:
        The track's features and sections.
    """
    on_stage("hash", None)
    digest = await track_infra.audio_hash(path)
    cache = track_infra.track_dir(digest)
    features_path = cache / "features.json"
    grid = track_db.get_edit(digest).grid
    stems_dir = cache / "stems"
    if _cached_features(features_path, grid) is None:
        on_stage("stems", 0.0)
        stems = await stems_infra.separate(path, stems_dir, lambda done: on_stage("stems", done))
        await _split_drums(stems_dir, on_stage)
        await track_infra.measure(path, stems, features_path, lambda source: on_stage(source, None), grid)
    else:
        await _split_drums(stems_dir, on_stage)
    _record_opened(path, digest, soundcloud)
    result = load_result(digest)
    assert result is not None
    return result


async def _split_drums(stems_dir: Path, on_stage: StageCallback) -> None:
    if stems_infra.cached_drum_parts(stems_dir) is None:
        on_stage("drum_parts", 0.0)
        await stems_infra.separate_drums(stems_dir / "drums.flac", stems_dir, lambda done: on_stage("drum_parts", done))


def _record_opened(path: Path, digest: str, soundcloud: SoundCloudTrack | None) -> None:
    features = json.loads((track_infra.track_dir(digest) / "features.json").read_text())
    grid = features["grid"]
    track_db.record_opened(
        track_db.HistoryEntry(
            digest=digest,
            path=str(path),
            bpm=grid["bpm"],
            root=features["tonal"]["root"],
            n_bars=grid["n_bars"],
            duration_s=features["duration_s"],
            opened_at=time.time(),
            soundcloud_id=soundcloud.id if soundcloud else None,
            title=soundcloud.title if soundcloud else None,
            artist=soundcloud.artist if soundcloud else None,
            artwork_url=soundcloud.artwork_url if soundcloud else None,
        )
    )


def recent_tracks(limit: int = 25) -> list[track_db.HistoryEntry]:
    """Return the most recently opened tracks, newest first.

    Args:
        limit: Maximum number of tracks.

    Returns:
        The tracks.
    """
    return track_db.list_history(limit)


def delete_track(digest: str) -> None:
    """Delete a track's stems, features, edits and recent-list entry.

    Args:
        digest: Decoded-audio hash.
    """
    track_infra.remove_track_dir(digest)
    track_db.forget(digest)


def _cached_features(path: Path, grid: tuple[float, float] | None) -> dict[str, Any] | None:
    if not path.exists():
        return None
    features = json.loads(path.read_text())
    if features.get("pipeline_version") != PIPELINE_VERSION:
        return None
    cached = features["grid"]
    if grid is None:
        return features if cached.get("concentration") is not None else None
    same_grid = abs(cached["bpm"] - grid[0]) < 1e-9 and abs(cached["downbeat_s"] - grid[1]) < 1e-9
    return features if same_grid else None


def load_result(digest: str) -> TrackBreakdown | None:
    """Return the analysed track with hash ``digest``, or ``None`` if not analysed.

    Args:
        digest: Decoded-audio hash.

    Returns:
        Features plus detected and edited sections.
    """
    features_path = track_infra.track_dir(digest) / "features.json"
    if not features_path.exists():
        return None
    features = json.loads(features_path.read_text())
    detected = detect_sections(bar_levels(features))
    edit = track_db.get_edit(digest)
    edited = [Section(**s) for s in edit.sections] if edit.sections is not None else None
    if edited is not None:
        try:
            validate_sections(edited, features["grid"]["n_bars"])
        except ValueError:
            # A grid edit changed the bar count; the old sections no longer fit.
            edited = None
    opened = track_db.get_history(digest)
    return TrackBreakdown(
        digest=digest,
        features=features,
        sections=edited if edited is not None else detected,
        detected_sections=detected,
        sections_edited=edited is not None,
        grid_edited=edit.grid is not None,
        soundcloud=(
            SoundCloudTrack(opened.soundcloud_id, opened.title, opened.artist, opened.artwork_url)
            if opened is not None and opened.soundcloud_id is not None
            else None
        ),
    )


def save_sections(digest: str, sections: list[Section] | None) -> TrackBreakdown:
    """Store edited sections; ``None`` reverts to the detected ones.

    Sections that don't cover the track's bars raise the ``ValueError`` from
    :func:`validate_sections`.

    Args:
        digest: Decoded-audio hash.
        sections: Sections covering every bar.

    Returns:
        The updated breakdown.

    Raises:
        LookupError: The track hasn't been analysed.
    """
    result = load_result(digest)
    if result is None:
        raise LookupError(digest)
    if sections is not None:
        validate_sections(sections, result.features["grid"]["n_bars"])
    track_db.save_sections(digest, [s.__dict__ for s in sections] if sections is not None else None)
    updated = load_result(digest)
    assert updated is not None
    return updated


def save_grid(digest: str, grid: tuple[float, float] | None) -> None:
    """Store an edited ``(bpm, downbeat_s)``; ``None`` reverts to estimation.

    The next analysis job for the track re-measures on that grid.

    Args:
        digest: Decoded-audio hash.
        grid: Tempo and first downbeat in seconds.

    Raises:
        LookupError: The track hasn't been analysed.
    """
    if load_result(digest) is None:
        raise LookupError(digest)
    track_db.save_grid(digest, grid)


def stem_path(digest: str, name: str) -> Path | None:
    """Return the cached stem or drum part file, or ``None`` if it doesn't exist."""
    if name not in (*stems_infra.STEM_NAMES, *stems_infra.DRUM_PART_NAMES):
        return None
    path = track_infra.track_dir(digest) / "stems" / f"{name}.flac"
    return path if path.exists() else None


def bar_levels(features: dict[str, Any]) -> list[BarLevels]:
    """Pick the per-bar levels sectioning needs out of a features document.

    Args:
        features: The ``features.json`` document, with drums, bass and other stems.

    Returns:
        One entry per bar.
    """
    sources = features["sources"]
    mix, drums, bass, other = sources["mix"], sources["drums"], sources["bass"], sources["other"]
    return [
        BarLevels(
            kick_db=drums["bands_db"][i][0],
            drums_db=drums["db"][i],
            bass_db=bass["db"][i],
            other_db=other["db"][i],
            mix_db=mix["db"][i],
            high_db=mix["bands_db"][i][5],
            width=mix["width"][i],
        )
        for i in range(features["grid"]["n_bars"])
    ]


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


FetchAudio = Callable[[StageCallback], Awaitable[tuple[Path, SoundCloudTrack | None]]]


@dataclass
class _Job:
    id: str
    key: str
    """What is analysed: a file path or ``soundcloud:<id>``; one job runs per key."""
    fetch: FetchAudio
    events: list[dict[str, Any]] = field(default_factory=list)
    listeners: set[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=set)
    task: asyncio.Task[None] | None = None
    done: bool = False


_jobs: dict[str, _Job] = {}


class JobNotFoundError(LookupError):
    """Raised for an unknown job id."""


def start_job(path: Path) -> str:
    """Start analysing ``path`` in the background, or join a running job for it.

    Args:
        path: Local audio file.

    Returns:
        The job id.
    """

    async def local(_on_stage: StageCallback) -> tuple[Path, SoundCloudTrack | None]:
        return path, None

    return _start(str(path), local)


def start_soundcloud_job(track_id: int, fetch: FetchSoundCloud) -> str:
    """Download and analyse a SoundCloud track in the background, or join a running job for it.

    Args:
        track_id: SoundCloud track id.
        fetch: Downloads the audio; a cached download returns at once.

    Returns:
        The job id.
    """

    async def download(on_stage: StageCallback) -> tuple[Path, SoundCloudTrack | None]:
        on_stage("download", None)
        try:
            return await fetch()
        except Exception as exc:
            raise DownloadError(f"Couldn't download the track from SoundCloud: {exc}") from exc

    return _start(f"soundcloud:{track_id}", download)


def _start(key: str, fetch: FetchAudio) -> str:
    for job in _jobs.values():
        if job.key == key and not job.done:
            return job.id
    job = _Job(id=uuid.uuid4().hex, key=key, fetch=fetch)
    _jobs[job.id] = job
    job.task = asyncio.create_task(_run(job))
    job.task.add_done_callback(lambda _task: _finish(job))
    return job.id


def cancel_job(job_id: str) -> bool:
    """Cancel a running job. Returns whether there was one to cancel."""
    job = _jobs.get(job_id)
    if job is None or job.done or job.task is None:
        return False
    job.task.cancel()
    return True


async def subscribe(job_id: str) -> AsyncIterator[dict[str, Any]]:
    """Yield the job's events so far, then new ones until it finishes.

    Args:
        job_id: Job to follow.

    Yields:
        dict[str, Any]: Events with a ``type`` of ``stage``, ``complete``,
        ``error`` (with ``code: stems_unavailable`` when Demucs isn't set up)
        or ``cancelled``.

    Raises:
        JobNotFoundError: No job has that id.
    """
    job = _jobs.get(job_id)
    if job is None:
        raise JobNotFoundError(job_id)
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    replay = list(job.events)
    if not job.done:
        job.listeners.add(queue)
    try:
        for past in replay:
            yield past
        if job.done:
            return
        while (incoming := await queue.get()) is not None:
            yield incoming
    finally:
        job.listeners.discard(queue)


def _emit(job: _Job, event: dict[str, Any]) -> None:
    job.events.append(event)
    for queue in job.listeners:
        queue.put_nowait(event)


async def _run(job: _Job) -> None:
    def on_stage(stage: str, progress: float | None) -> None:
        _emit(job, {"type": "stage", "stage": stage, "progress": progress})

    try:
        path, soundcloud = await job.fetch(on_stage)
        result = await analyse_track(path, on_stage, soundcloud)
        _emit(job, {"type": "complete", "digest": result.digest})
    except stems_infra.StemsUnavailableError as exc:
        _emit(job, {"type": "error", "code": "stems_unavailable", "message": str(exc)})
    except (DownloadError, track_infra.MeasureError) as exc:
        _emit(job, {"type": "error", "message": str(exc)})
    except Exception:
        logger.exception("track breakdown failed for %s", job.key)
        _emit(job, {"type": "error", "message": "Analysis failed; see the backend log."})


def _finish(job: _Job) -> None:
    """Close the job's streams; runs even when it was cancelled before starting."""
    if job.task is not None and job.task.cancelled():
        _emit(job, {"type": "cancelled"})
    job.done = True
    for queue in job.listeners:
        queue.put_nowait(None)
