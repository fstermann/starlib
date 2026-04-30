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
    AnalyserTrackId,
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
class TrackIdRow:
    section_index: int
    pitch_offset: float
    title: str | None
    artist: str | None
    shazam_id: str | None
    confidence: float
    matched_at: float


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
        row = conn.execute(
            select(*_JOB_COLS).where(AnalyserJob.__table__.c.id == job_id)
        ).first()
    if row is None:
        return None
    return _row_to_job(row)


def list_recent_jobs(limit: int = 25) -> list[JobRow]:
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(*_JOB_COLS)
            .order_by(AnalyserJob.__table__.c.created_at.desc())
            .limit(limit)
        ).all()
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


def upsert_window_bpm(
    *, job_id: str, start_s: float, end_s: float, bpm: float, confidence: str
) -> None:
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
    """Drop window BPM rows whose midpoint falls inside ``[start_s, end_s]``.

    Used by re-analyse so the new pass can write fresh values without
    accumulating stale duplicates.
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
# Track-ID CRUD
# ---------------------------------------------------------------------------


def upsert_track_id(
    *,
    job_id: str,
    section_index: int,
    pitch_offset: float,
    title: str | None,
    artist: str | None,
    shazam_id: str | None,
    confidence: float,
) -> None:
    table = AnalyserTrackId.__table__
    stmt = sqlite_insert(table).values(
        job_id=job_id,
        section_index=section_index,
        pitch_offset=pitch_offset,
        title=title,
        artist=artist,
        shazam_id=shazam_id,
        confidence=confidence,
        matched_at=time.time(),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[table.c.job_id, table.c.section_index, table.c.pitch_offset],
        set_={
            "title": stmt.excluded.title,
            "artist": stmt.excluded.artist,
            "shazam_id": stmt.excluded.shazam_id,
            "confidence": stmt.excluded.confidence,
            "matched_at": stmt.excluded.matched_at,
        },
    )
    with get_engine().begin() as conn:
        conn.execute(stmt)


def get_track_id(job_id: str, section_index: int, pitch_offset: float) -> TrackIdRow | None:
    """Cache lookup keyed by ``(job_id, section_index, pitch_offset)``."""
    table = AnalyserTrackId.__table__
    with get_engine().begin() as conn:
        row = conn.execute(
            select(table.c.section_index, table.c.pitch_offset, table.c.title,
                   table.c.artist, table.c.shazam_id, table.c.confidence, table.c.matched_at)
            .where(table.c.job_id == job_id)
            .where(table.c.section_index == section_index)
            .where(table.c.pitch_offset == pitch_offset)
        ).first()
    if row is None:
        return None
    return TrackIdRow(**dict(row._mapping))


def list_track_ids(job_id: str) -> list[TrackIdRow]:
    """Return the highest-confidence Shazam match per section for a job."""
    table = AnalyserTrackId.__table__
    with get_engine().begin() as conn:
        rows = conn.execute(
            select(table.c.section_index, table.c.pitch_offset, table.c.title,
                   table.c.artist, table.c.shazam_id, table.c.confidence, table.c.matched_at)
            .where(table.c.job_id == job_id)
            .order_by(table.c.section_index, table.c.confidence.desc())
        ).all()
    # Reduce: one row per section_index — the first one (highest confidence
    # thanks to the order_by clause).
    seen: set[int] = set()
    out: list[TrackIdRow] = []
    for r in rows:
        if r.section_index in seen:
            continue
        seen.add(r.section_index)
        out.append(TrackIdRow(**dict(r._mapping)))
    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def section_row_dict(row: SectionRow) -> dict:
    """Convenience for serialising a SectionRow to JSON-friendly dict."""
    return asdict(row)
