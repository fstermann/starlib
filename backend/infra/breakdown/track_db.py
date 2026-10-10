"""Persistence for Track Breakdown: user edits (sections, bar grid) and the recent list."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.infra.db.engine import get_engine
from backend.infra.db.models import BreakdownTrackEdit, BreakdownTrackHistory


@dataclass(frozen=True)
class TrackEdit:
    """Stored edits for one track; ``None`` fields fall back to detection.

    Attributes:
        sections: Edited sections as ``{start_bar, end_bar, label}`` dicts.
        grid: Edited ``(bpm, downbeat_s)``.
    """

    sections: list[dict[str, Any]] | None
    grid: tuple[float, float] | None


@dataclass(frozen=True)
class HistoryEntry:
    """A track opened in Track Breakdown.

    Attributes:
        digest: Decoded-audio hash.
        path: File the track was last opened from; for SoundCloud, the cached download.
        bpm: Tempo of the bar grid.
        root: Root note from the strongest bass peak, if any.
        n_bars: Bar count.
        duration_s: Track length in seconds.
        opened_at: Unix time it was last opened.
        soundcloud_id: SoundCloud track the audio was streamed from, if any.
        title: SoundCloud title; local files show their file name.
        artist: SoundCloud uploader.
        artwork_url: SoundCloud artwork.
    """

    digest: str
    path: str
    bpm: float
    root: str | None
    n_bars: int
    duration_s: float
    opened_at: float
    soundcloud_id: int | None = None
    title: str | None = None
    artist: str | None = None
    artwork_url: str | None = None


def get_edit(digest: str) -> TrackEdit:
    """Return the stored edits for ``digest``.

    Args:
        digest: Decoded-audio hash of the track.

    Returns:
        The edits, with ``None`` fields where nothing is stored.
    """
    table = BreakdownTrackEdit.__table__
    with get_engine().connect() as conn:
        row = conn.execute(select(table).where(table.c.digest == digest)).first()
    if row is None:
        return TrackEdit(sections=None, grid=None)
    sections = json.loads(row.sections_json) if row.sections_json else None
    grid = (row.bpm, row.downbeat_s) if row.bpm is not None and row.downbeat_s is not None else None
    return TrackEdit(sections=sections, grid=grid)


def save_sections(digest: str, sections: list[dict[str, Any]] | None) -> None:
    """Store edited sections for ``digest``; ``None`` reverts to detection.

    Args:
        digest: Decoded-audio hash of the track.
        sections: Sections as ``{start_bar, end_bar, label}`` dicts.
    """
    _upsert(digest, {"sections_json": json.dumps(sections) if sections is not None else None})


def save_grid(digest: str, grid: tuple[float, float] | None) -> None:
    """Store an edited ``(bpm, downbeat_s)`` for ``digest``; ``None`` reverts to detection.

    Args:
        digest: Decoded-audio hash of the track.
        grid: Tempo and first downbeat in seconds.
    """
    bpm, downbeat_s = grid if grid is not None else (None, None)
    _upsert(digest, {"bpm": bpm, "downbeat_s": downbeat_s})


def _upsert(digest: str, values: dict[str, Any]) -> None:
    row = {"digest": digest, **values, "updated_at": time.time()}
    stmt = sqlite_insert(BreakdownTrackEdit.__table__).values(row)
    stmt = stmt.on_conflict_do_update(
        index_elements=[BreakdownTrackEdit.__table__.c.digest],
        set_={c: stmt.excluded[c] for c in row if c != "digest"},
    )
    with get_engine().begin() as conn:
        conn.execute(stmt)


def record_opened(entry: HistoryEntry) -> None:
    """Insert or refresh ``entry`` in the recent list.

    Args:
        entry: The opened track.
    """
    row = entry.__dict__
    stmt = sqlite_insert(BreakdownTrackHistory.__table__).values(row)
    stmt = stmt.on_conflict_do_update(
        index_elements=[BreakdownTrackHistory.__table__.c.digest],
        set_={c: stmt.excluded[c] for c in row if c != "digest"},
    )
    with get_engine().begin() as conn:
        conn.execute(stmt)


def list_history(limit: int) -> list[HistoryEntry]:
    """Return up to ``limit`` tracks, most recently opened first.

    Args:
        limit: Maximum number of entries.

    Returns:
        The entries.
    """
    table = BreakdownTrackHistory.__table__
    with get_engine().connect() as conn:
        rows = conn.execute(select(table).order_by(table.c.opened_at.desc()).limit(limit)).all()
    return [HistoryEntry(**row._mapping) for row in rows]


def get_history(digest: str) -> HistoryEntry | None:
    """Return the track's recent-list entry, or ``None`` if it has none.

    Args:
        digest: Decoded-audio hash.

    Returns:
        The entry.
    """
    table = BreakdownTrackHistory.__table__
    with get_engine().connect() as conn:
        row = conn.execute(select(table).where(table.c.digest == digest)).first()
    return HistoryEntry(**row._mapping) if row is not None else None


def forget(digest: str) -> None:
    """Remove the track's history entry and edits.

    Args:
        digest: Decoded-audio hash.
    """
    with get_engine().begin() as conn:
        conn.execute(delete(BreakdownTrackHistory.__table__).where(BreakdownTrackHistory.__table__.c.digest == digest))
        conn.execute(delete(BreakdownTrackEdit.__table__).where(BreakdownTrackEdit.__table__.c.digest == digest))
