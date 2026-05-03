"""Repository layer for analyser tables.

Thin CRUD wrappers around the SQLModel tables defined in
``backend.core.db.models``. Mirrors the style of ``cache_db.py``: each
function opens a short-lived session against the module engine.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.core.db.engine import get_engine
from backend.core.db.models import (
    AnalyserJob,
    AnalyserSection,
    AnalyserShazamScan,
    AnalyserTrack,
    AnalyserWindowBpm,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Plain dataclasses returned to callers (decoupled from SQLModel rows so the
# API layer can map directly to pydantic without coupling to ORM internals).
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class JobRow:
    id: str
    soundcloud_id: int | None
    source_url: str | None
    title: str | None
    artist: str | None
    duration_s: float | None
    status: str
    options: dict
    error: str | None
    created_at: float
    updated_at: float


@dataclass(slots=True)
class WindowBpmRow:
    start_s: float
    end_s: float
    bpm: float
    confidence: str


@dataclass(slots=True)
class SectionRow:
    section_index: int
    start_s: float
    end_s: float
    confidence: float


@dataclass(slots=True)
class ShazamScanRow:
    scan_s: float
    pitch_offset: float
    title: str | None
    artist: str | None
    shazam_id: str | None
    confidence: float
    matched_at: float
    preview_url: str | None = None
    artwork_url: str | None = None
    tier: str = "sweep"


# ---------------------------------------------------------------------------
# Job CRUD
# ---------------------------------------------------------------------------


def insert_job(
    *,
    job_id: str,
    soundcloud_id: int | None,
    source_url: str | None,
    title: str | None,
    artist: str | None,
    duration_s: float | None,
    options: dict,
) -> JobRow:
    now = time.time()
    values = {
        "id": job_id,
        "soundcloud_id": soundcloud_id,
        "source_url": source_url,
        "title": title,
        "artist": artist,
        "duration_s": duration_s,
        "status": "pending",
        "options_json": json.dumps(options),
        "error": None,
        "created_at": now,
        "updated_at": now,
    }
    with get_engine().begin() as conn:
        conn.execute(sqlite_insert(AnalyserJob.__table__).values(**values))
    return JobRow(
        id=job_id,
        soundcloud_id=soundcloud_id,
        source_url=source_url,
        title=title,
        artist=artist,
        duration_s=duration_s,
        status="pending",
        options=options,
        error=None,
        created_at=now,
        updated_at=now,
    )


def update_job_status(job_id: str, *, status: str, error: str | None = None) -> None:
    with get_engine().begin() as conn:
        conn.execute(
            AnalyserJob.__table__.update()
            .where(AnalyserJob.__table__.c.id == job_id)
            .values(status=status, error=error, updated_at=time.time())
        )


def update_job_meta(job_id: str, *, duration_s: float | None) -> None:
    with get_engine().begin() as conn:
        conn.execute(
            AnalyserJob.__table__.update()
            .where(AnalyserJob.__table__.c.id == job_id)
            .values(duration_s=duration_s, updated_at=time.time())
        )


def update_job_options(job_id: str, options: dict) -> None:
    """Persist a new options blob for a job (used by re-analyse overrides)."""
    with get_engine().begin() as conn:
        conn.execute(
            AnalyserJob.__table__.update()
            .where(AnalyserJob.__table__.c.id == job_id)
            .values(options_json=json.dumps(options), updated_at=time.time())
        )


def mark_running_jobs_as_error(message: str) -> int:
    """Move ``pending`` / ``running`` jobs to ``error``.

    Called at backend startup so subscribers don't hang on jobs whose
    pipeline died with the previous process. Returns the number of rows
    affected.
    """
    table = AnalyserJob.__table__
    with get_engine().begin() as conn:
        result = conn.execute(
            table.update()
            .where(table.c.status.in_(("running", "pending")))
            .values(status="error", error=message, updated_at=time.time())
        )
    return result.rowcount or 0


_JOB_COLS = (
    AnalyserJob.__table__.c.id,
    AnalyserJob.__table__.c.soundcloud_id,
    AnalyserJob.__table__.c.source_url,
    AnalyserJob.__table__.c.title,
    AnalyserJob.__table__.c.artist,
    AnalyserJob.__table__.c.duration_s,
    AnalyserJob.__table__.c.status,
    AnalyserJob.__table__.c.options_json,
    AnalyserJob.__table__.c.error,
    AnalyserJob.__table__.c.created_at,
    AnalyserJob.__table__.c.updated_at,
)


def _row_to_job(row) -> JobRow:
    try:
        options = json.loads(row.options_json) if row.options_json else {}
    except json.JSONDecodeError:
        options = {}
    return JobRow(
        id=row.id,
        soundcloud_id=row.soundcloud_id,
        source_url=row.source_url,
        title=row.title,
        artist=row.artist,
        duration_s=row.duration_s,
        status=row.status,
        options=options,
        error=row.error,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def get_job(job_id: str) -> JobRow | None:
    with get_engine().begin() as conn:
        row = conn.execute(select(*_JOB_COLS).where(AnalyserJob.__table__.c.id == job_id)).first()
    if row is None:
        return None
    return _row_to_job(row)


def list_recent_jobs(limit: int = 25) -> list[JobRow]:
    with get_engine().begin() as conn:
        rows = conn.execute(select(*_JOB_COLS).order_by(AnalyserJob.__table__.c.created_at.desc()).limit(limit)).all()
    return [_row_to_job(r) for r in rows]


def find_job_for_set(soundcloud_id: int) -> JobRow | None:
    """Return the most recent job for a SoundCloud set, if any."""
    with get_engine().begin() as conn:
        row = conn.execute(
            select(*_JOB_COLS)
            .where(AnalyserJob.__table__.c.soundcloud_id == soundcloud_id)
            .order_by(AnalyserJob.__table__.c.created_at.desc())
            .limit(1)
        ).first()
    if row is None:
        return None
    return _row_to_job(row)


# ---------------------------------------------------------------------------
# Window-BPM CRUD
# ---------------------------------------------------------------------------


def upsert_window_bpm(*, job_id: str, start_s: float, end_s: float, bpm: float, confidence: str) -> None:
    table = AnalyserWindowBpm.__table__
    stmt = sqlite_insert(table).values(
        job_id=job_id,
        start_s=start_s,
        end_s=end_s,
        bpm=bpm,
        confidence=confidence,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[table.c.job_id, table.c.start_s],
        set_={"end_s": stmt.excluded.end_s, "bpm": stmt.excluded.bpm, "confidence": stmt.excluded.confidence},
    )
    with get_engine().begin() as conn:
        conn.execute(stmt)


def list_windows(job_id: str) -> list[WindowBpmRow]:
    table = AnalyserWindowBpm.__table__
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(table.c.start_s, table.c.end_s, table.c.bpm, table.c.confidence)
            .where(table.c.job_id == job_id)
            .order_by(table.c.start_s)
        ).all()
    return [WindowBpmRow(start_s=r.start_s, end_s=r.end_s, bpm=r.bpm, confidence=r.confidence) for r in rows]


def delete_windows_in_range(job_id: str, start_s: float, end_s: float) -> None:
    """Drop window BPM rows whose ``start_s`` falls inside ``[start_s, end_s]``.

    Used by re-analyse so the new pass can write fresh values without
    accumulating stale duplicates. Selection is by start point — windows
    that begin inside the range get cleared even when their tail extends
    past ``end_s``.
    """
    table = AnalyserWindowBpm.__table__
    with get_engine().begin() as conn:
        conn.execute(
            delete(table)
            .where(table.c.job_id == job_id)
            .where(table.c.start_s >= start_s)
            .where(table.c.start_s <= end_s)
        )


# ---------------------------------------------------------------------------
# Section CRUD
# ---------------------------------------------------------------------------


def replace_sections(job_id: str, sections: list[SectionRow]) -> None:
    """Replace all sections for a job in one transaction."""
    table = AnalyserSection.__table__
    with get_engine().begin() as conn:
        conn.execute(delete(table).where(table.c.job_id == job_id))
        if sections:
            conn.execute(
                table.insert(),
                [
                    {
                        "job_id": job_id,
                        "section_index": s.section_index,
                        "start_s": s.start_s,
                        "end_s": s.end_s,
                        "confidence": s.confidence,
                    }
                    for s in sections
                ],
            )


def insert_sections(job_id: str, sections: list[SectionRow]) -> None:
    """Insert sections without touching existing rows (re-analyse path)."""
    if not sections:
        return
    table = AnalyserSection.__table__
    with get_engine().begin() as conn:
        conn.execute(
            table.insert(),
            [
                {
                    "job_id": job_id,
                    "section_index": s.section_index,
                    "start_s": s.start_s,
                    "end_s": s.end_s,
                    "confidence": s.confidence,
                }
                for s in sections
            ],
        )


def delete_sections_in_range(job_id: str, start_s: float, end_s: float) -> list[int]:
    """Delete sections fully contained in ``[start_s, end_s]``.

    Returns the list of removed ``section_index`` values so callers can
    cascade to ``analyser_track_ids`` (those rows aren't FK-linked).
    """
    table = AnalyserSection.__table__
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(table.c.section_index)
            .where(table.c.job_id == job_id)
            .where(table.c.start_s >= start_s)
            .where(table.c.end_s <= end_s)
        ).all()
        removed = [r.section_index for r in rows]
        if removed:
            conn.execute(delete(table).where(table.c.job_id == job_id).where(table.c.section_index.in_(removed)))
    return removed


def max_section_index(job_id: str) -> int | None:
    """Highest existing ``section_index`` for a job, or ``None`` if no rows."""
    table = AnalyserSection.__table__
    with get_engine().begin() as conn:
        row = conn.execute(
            select(table.c.section_index)
            .where(table.c.job_id == job_id)
            .order_by(table.c.section_index.desc())
            .limit(1)
        ).first()
    return None if row is None else row.section_index


def list_sections(job_id: str) -> list[SectionRow]:
    table = AnalyserSection.__table__
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(table.c.section_index, table.c.start_s, table.c.end_s, table.c.confidence)
            .where(table.c.job_id == job_id)
            .order_by(table.c.section_index)
        ).all()
    return [SectionRow(**dict(r._mapping)) for r in rows]


# ---------------------------------------------------------------------------
# Shazam scan CRUD
# ---------------------------------------------------------------------------


def upsert_shazam_scan(
    *,
    job_id: str,
    scan_s: float,
    pitch_offset: float,
    title: str | None,
    artist: str | None,
    shazam_id: str | None,
    confidence: float,
    preview_url: str | None = None,
    artwork_url: str | None = None,
    tier: str = "sweep",
) -> None:
    """Persist (or refresh) a single Shazam-scan attempt.

    The grid is keyed by ``(job_id, scan_s, pitch_offset)``. Caching by
    pitch lets the ``range`` strategy memoise its candidate sweeps without
    re-spending ffmpeg / Shazam quota on a re-run with identical params.
    The ``tier`` records which pass produced the row so the timeline can
    prefer finer matches over coarser ones.
    """
    table = AnalyserShazamScan.__table__
    stmt = sqlite_insert(table).values(
        job_id=job_id,
        scan_s=scan_s,
        pitch_offset=pitch_offset,
        title=title,
        artist=artist,
        shazam_id=shazam_id,
        confidence=confidence,
        matched_at=time.time(),
        preview_url=preview_url,
        artwork_url=artwork_url,
        tier=tier,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[table.c.job_id, table.c.scan_s, table.c.pitch_offset],
        set_={
            "title": stmt.excluded.title,
            "artist": stmt.excluded.artist,
            "shazam_id": stmt.excluded.shazam_id,
            "confidence": stmt.excluded.confidence,
            "matched_at": stmt.excluded.matched_at,
            "preview_url": stmt.excluded.preview_url,
            "artwork_url": stmt.excluded.artwork_url,
            "tier": stmt.excluded.tier,
        },
    )
    with get_engine().begin() as conn:
        conn.execute(stmt)


def get_shazam_scan(job_id: str, scan_s: float, pitch_offset: float) -> ShazamScanRow | None:
    """Lookup a single cached scan attempt."""
    table = AnalyserShazamScan.__table__
    with get_engine().begin() as conn:
        row = conn.execute(
            select(
                table.c.scan_s,
                table.c.pitch_offset,
                table.c.title,
                table.c.artist,
                table.c.shazam_id,
                table.c.confidence,
                table.c.matched_at,
                table.c.preview_url,
                table.c.artwork_url,
                table.c.tier,
            )
            .where(table.c.job_id == job_id)
            .where(table.c.scan_s == scan_s)
            .where(table.c.pitch_offset == pitch_offset)
        ).first()
    if row is None:
        return None
    return ShazamScanRow(**dict(row._mapping))


def list_shazam_scans(job_id: str) -> list[ShazamScanRow]:
    """Return every cached scan attempt for a job, ordered by ``scan_s``.

    Each ``(scan_s, pitch_offset)`` is its own row — ``range`` pitch
    strategy can fan out 3+ attempts per scan point that resolve to
    different tracks. The frontend de-duplicates per scan point for
    the timeline aggregation but surfaces alternatives in the tracklist.
    """
    table = AnalyserShazamScan.__table__
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(
                table.c.scan_s,
                table.c.pitch_offset,
                table.c.title,
                table.c.artist,
                table.c.shazam_id,
                table.c.confidence,
                table.c.matched_at,
                table.c.preview_url,
                table.c.artwork_url,
                table.c.tier,
            )
            .where(table.c.job_id == job_id)
            .order_by(table.c.scan_s, table.c.confidence.desc())
        ).all()
    return [ShazamScanRow(**dict(r._mapping)) for r in rows]


# ---------------------------------------------------------------------------
# Tracklist CRUD — single mutable table for both Shazam-sourced and
# manual entries. See ``AnalyserTrack`` for the lifecycle model.
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class TrackRow:
    id: int
    job_id: str
    origin: str  # "shazam" | "manual"
    start_s: float
    end_s: float | None
    title: str
    artist: str | None
    shazam_id: str | None
    soundcloud_id: int | None
    soundcloud_permalink_url: str | None
    artwork_url: str | None
    duration_s: float | None
    confirmed: bool
    dismissed: bool
    user_edited: bool
    set_bpm: float | None
    pitch_offset: float | None
    created_at: float
    updated_at: float


_TRACK_COLS = (
    AnalyserTrack.__table__.c.id,
    AnalyserTrack.__table__.c.job_id,
    AnalyserTrack.__table__.c.origin,
    AnalyserTrack.__table__.c.start_s,
    AnalyserTrack.__table__.c.end_s,
    AnalyserTrack.__table__.c.title,
    AnalyserTrack.__table__.c.artist,
    AnalyserTrack.__table__.c.shazam_id,
    AnalyserTrack.__table__.c.soundcloud_id,
    AnalyserTrack.__table__.c.soundcloud_permalink_url,
    AnalyserTrack.__table__.c.artwork_url,
    AnalyserTrack.__table__.c.duration_s,
    AnalyserTrack.__table__.c.confirmed,
    AnalyserTrack.__table__.c.dismissed,
    AnalyserTrack.__table__.c.user_edited,
    AnalyserTrack.__table__.c.set_bpm,
    AnalyserTrack.__table__.c.pitch_offset,
    AnalyserTrack.__table__.c.created_at,
    AnalyserTrack.__table__.c.updated_at,
)


def _row_to_track(row) -> TrackRow:
    return TrackRow(
        id=int(row.id),
        job_id=row.job_id,
        origin=row.origin,
        start_s=float(row.start_s),
        end_s=None if row.end_s is None else float(row.end_s),
        title=row.title,
        artist=row.artist,
        shazam_id=row.shazam_id,
        soundcloud_id=row.soundcloud_id,
        soundcloud_permalink_url=row.soundcloud_permalink_url,
        artwork_url=row.artwork_url,
        duration_s=None if row.duration_s is None else float(row.duration_s),
        confirmed=bool(row.confirmed),
        dismissed=bool(row.dismissed),
        user_edited=bool(row.user_edited),
        set_bpm=None if row.set_bpm is None else float(row.set_bpm),
        pitch_offset=None if row.pitch_offset is None else float(row.pitch_offset),
        created_at=float(row.created_at),
        updated_at=float(row.updated_at),
    )


def insert_track(
    *,
    job_id: str,
    origin: str,
    start_s: float,
    title: str,
    end_s: float | None = None,
    artist: str | None = None,
    shazam_id: str | None = None,
    soundcloud_id: int | None = None,
    soundcloud_permalink_url: str | None = None,
    artwork_url: str | None = None,
    duration_s: float | None = None,
    user_edited: bool = False,
    set_bpm: float | None = None,
    pitch_offset: float | None = None,
) -> TrackRow:
    table = AnalyserTrack.__table__
    now = time.time()
    values = {
        "job_id": job_id,
        "origin": origin,
        "start_s": start_s,
        "end_s": end_s,
        "title": title,
        "artist": artist,
        "shazam_id": shazam_id,
        "soundcloud_id": soundcloud_id,
        "soundcloud_permalink_url": soundcloud_permalink_url,
        "artwork_url": artwork_url,
        "duration_s": duration_s,
        "confirmed": False,
        "dismissed": False,
        "user_edited": user_edited,
        "set_bpm": set_bpm,
        "pitch_offset": pitch_offset,
        "created_at": now,
        "updated_at": now,
    }
    with get_engine().begin() as conn:
        result = conn.execute(table.insert().values(**values))
        new_id = int(result.inserted_primary_key[0])
        row = conn.execute(select(*_TRACK_COLS).where(table.c.id == new_id)).first()
    if row is None:  # belt-and-braces; insert just succeeded
        raise RuntimeError(f"insert_track: row {new_id} disappeared")
    return _row_to_track(row)


def count_tracks(job_id: str, *, include_dismissed: bool = False) -> int:
    """Count tracks for a job without materialising rows."""
    from sqlalchemy import func

    table = AnalyserTrack.__table__
    stmt = select(func.count()).select_from(table).where(table.c.job_id == job_id)
    if not include_dismissed:
        stmt = stmt.where(table.c.dismissed == False)  # noqa: E712
    with get_engine().begin() as conn:
        return int(conn.execute(stmt).scalar() or 0)


def list_tracks(job_id: str, *, include_dismissed: bool = False) -> list[TrackRow]:
    table = AnalyserTrack.__table__
    stmt = select(*_TRACK_COLS).where(table.c.job_id == job_id)
    if not include_dismissed:
        stmt = stmt.where(table.c.dismissed == False)  # noqa: E712
    stmt = stmt.order_by(table.c.start_s)
    with get_engine().begin() as conn:
        rows = conn.execute(stmt).all()
    return [_row_to_track(r) for r in rows]


def list_confirmed_ranges(job_id: str) -> list[tuple[float, float]]:
    """Return (start_s, end_s) for every confirmed, non-dismissed track.

    Used by the Shazam scan scheduler to skip scan points that fall inside
    a track the user already validated. Tracks without an ``end_s`` are
    treated as zero-width at ``start_s``. Ranges aren't merged here — the
    caller (``_grid_minus_ranges``) handles overlaps.
    """
    table = AnalyserTrack.__table__
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(table.c.start_s, table.c.end_s)
            .where(table.c.job_id == job_id)
            .where(table.c.confirmed == True)  # noqa: E712
            .where(table.c.dismissed == False)  # noqa: E712
        ).all()
    return [(float(r.start_s), float(r.end_s if r.end_s is not None else r.start_s)) for r in rows]


def get_track_by_shazam_id(job_id: str, shazam_id: str) -> TrackRow | None:
    table = AnalyserTrack.__table__
    with get_engine().begin() as conn:
        row = conn.execute(
            select(*_TRACK_COLS).where(table.c.job_id == job_id).where(table.c.shazam_id == shazam_id)
        ).first()
    return None if row is None else _row_to_track(row)


def update_track(
    job_id: str,
    track_id: int,
    *,
    start_s: float | None = None,
    end_s: float | None = None,
    title: str | None = None,
    artist: str | None = None,
    soundcloud_id: int | None = None,
    soundcloud_permalink_url: str | None = None,
    artwork_url: str | None = None,
    duration_s: float | None = None,
    confirmed: bool | None = None,
    dismissed: bool | None = None,
    set_bpm: float | None = None,
    pitch_offset: float | None = None,
    mark_user_edited: bool = False,
) -> bool:
    """Apply a partial update to a track row.

    ``mark_user_edited=True`` flips the row's ``user_edited`` flag so a
    later Shazam re-sync skips it. Pass it for every drag/rename op,
    skip it for purely admin updates (sync, dismiss).
    """
    values: dict[str, object] = {"updated_at": time.time()}
    if start_s is not None:
        values["start_s"] = start_s
    if end_s is not None:
        values["end_s"] = end_s
    if title is not None:
        values["title"] = title
    if artist is not None:
        values["artist"] = artist
    if soundcloud_id is not None:
        values["soundcloud_id"] = soundcloud_id
    if soundcloud_permalink_url is not None:
        values["soundcloud_permalink_url"] = soundcloud_permalink_url
    if artwork_url is not None:
        values["artwork_url"] = artwork_url
    if duration_s is not None:
        values["duration_s"] = duration_s
    if confirmed is not None:
        values["confirmed"] = confirmed
    if dismissed is not None:
        values["dismissed"] = dismissed
    if set_bpm is not None:
        values["set_bpm"] = set_bpm
    if pitch_offset is not None:
        values["pitch_offset"] = pitch_offset
    if mark_user_edited:
        values["user_edited"] = True
    if len(values) == 1:  # only updated_at would change → no-op
        return False
    table = AnalyserTrack.__table__
    with get_engine().begin() as conn:
        result = conn.execute(
            table.update().where(table.c.job_id == job_id).where(table.c.id == track_id).values(**values)
        )
    return (result.rowcount or 0) > 0


def delete_track(job_id: str, track_id: int) -> bool:
    """Hard-delete a track row.

    Used for manual entries (no Shazam refresh would re-create them).
    For Shazam-origin rows the API soft-deletes via ``dismissed=True``
    instead so a future scan doesn't resurrect them.
    """
    table = AnalyserTrack.__table__
    with get_engine().begin() as conn:
        result = conn.execute(delete(table).where(table.c.job_id == job_id).where(table.c.id == track_id))
    return (result.rowcount or 0) > 0


def delete_tracks_for_job(job_id: str) -> None:
    table = AnalyserTrack.__table__
    with get_engine().begin() as conn:
        conn.execute(delete(table).where(table.c.job_id == job_id))


def delete_job(job_id: str) -> bool:
    """Hard-delete a job row and every row that references it.

    Returns ``True`` if the job existed. Cascades manually because
    SQLite doesn't enforce FKs by default in this app's engine config.
    """
    with get_engine().begin() as conn:
        conn.execute(delete(AnalyserWindowBpm.__table__).where(AnalyserWindowBpm.__table__.c.job_id == job_id))
        conn.execute(delete(AnalyserSection.__table__).where(AnalyserSection.__table__.c.job_id == job_id))
        conn.execute(delete(AnalyserShazamScan.__table__).where(AnalyserShazamScan.__table__.c.job_id == job_id))
        conn.execute(delete(AnalyserTrack.__table__).where(AnalyserTrack.__table__.c.job_id == job_id))
        result = conn.execute(delete(AnalyserJob.__table__).where(AnalyserJob.__table__.c.id == job_id))
    return (result.rowcount or 0) > 0


def reset_job_data(job_id: str) -> None:
    """Drop all derived + user-edited data for a job, keep the job row.

    Wipes windows, sections, shazam scans and track overrides in one
    transaction so a partial failure can't leave the job in a weird
    half-cleared state. The job row itself (id, soundcloud_id, title,
    artist, options, duration_s) is preserved so the user can immediately
    re-run analysis without re-entering the URL.
    """
    with get_engine().begin() as conn:
        conn.execute(delete(AnalyserWindowBpm.__table__).where(AnalyserWindowBpm.__table__.c.job_id == job_id))
        conn.execute(delete(AnalyserSection.__table__).where(AnalyserSection.__table__.c.job_id == job_id))
        conn.execute(delete(AnalyserShazamScan.__table__).where(AnalyserShazamScan.__table__.c.job_id == job_id))
        conn.execute(delete(AnalyserTrack.__table__).where(AnalyserTrack.__table__.c.job_id == job_id))
        # Status flips back to ``complete`` (not ``pending``) — nothing is
        # actually queued or running after a reset. ``pending`` would make
        # the header chip read "Queued" indefinitely until the user kicks
        # off a fresh pass.
        conn.execute(
            AnalyserJob.__table__.update()
            .where(AnalyserJob.__table__.c.id == job_id)
            .values(status="complete", error=None, updated_at=time.time())
        )


def delete_shazam_scans_for_job(job_id: str) -> None:
    """Drop every cached scan for a job (re-analyse 'force a fresh run')."""
    table = AnalyserShazamScan.__table__
    with get_engine().begin() as conn:
        conn.execute(delete(table).where(table.c.job_id == job_id))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def section_row_dict(row: SectionRow) -> dict:
    """Convenience for serialising a SectionRow to JSON-friendly dict."""
    return asdict(row)
