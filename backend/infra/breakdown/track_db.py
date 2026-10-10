"""Persistence for user edits to a Track Breakdown (sections, bar grid)."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.infra.db.engine import get_engine
from backend.infra.db.models import BreakdownTrackEdit


@dataclass(frozen=True)
class TrackEdit:
    """Stored edits for one track; ``None`` fields fall back to detection.

    Attributes:
        sections: Edited sections as ``{start_bar, end_bar, label}`` dicts.
        grid: Edited ``(bpm, downbeat_s)``.
    """

    sections: list[dict[str, Any]] | None
    grid: tuple[float, float] | None


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
