"""SQLModel tables for the cache DB.

The ``Track`` columns mirror the post-#285 sqlite schema exactly, so that
Alembic revision 0001 can stamp an existing user DB without drift.  Adding a
new tag in ``SIMPLE_TAG_FIELDS`` should be followed by a column on ``Track``
plus an ``alembic revision --autogenerate`` — the import-time parity check
below catches the easy mistake of forgetting the second step.

``starlib_meta`` is intentionally not a column: its payload lives in the
``TXXX:starlib`` ID3 frame on disk, not in the cache (the cache is a
derived-data view).
"""

from __future__ import annotations

from sqlmodel import Field, Index, SQLModel

from soundcloud_tools.handler.track import SIMPLE_TAG_FIELDS


class Track(SQLModel, table=True):
    __tablename__ = "tracks"  # type: ignore[assignment]

    file_path: str = Field(primary_key=True)
    file_name: str
    # folder index is declared explicitly via ``__table_args__`` below with
    # the legacy name ``idx_tracks_folder``; Field(index=True) would create
    # an additional auto-named index, so it's intentionally omitted.
    folder: str

    # Flat registry-driven tag columns
    title: str | None = None
    artist_str: str | None = None
    genre: str | None = None
    key: str | None = None
    bpm: int | None = None
    release_date: str | None = None
    release_year: int | None = None
    original_artist: str | None = None
    remixer: str | None = None
    mix_name: str | None = None
    user_comment: str | None = None

    # File + readiness metadata
    has_artwork: bool = Field(default=False)
    file_size: int | None = None
    file_format: str | None = None
    duration: float | None = None
    is_complete: bool = Field(default=False)
    missing_fields: str | None = None  # JSON-encoded list[str]
    mtime: float

    # SoundCloud linkage (extracted from starlib_meta)
    soundcloud_id: int | None = None

    # Legacy column kept because SQLite can't drop columns without a table
    # rebuild.  No reader writes to it any more.
    remixers: str | None = None

    __table_args__ = (
        Index("idx_tracks_folder", "folder"),
    )


class Peaks(SQLModel, table=True):
    __tablename__ = "peaks"  # type: ignore[assignment]

    file_path: str = Field(primary_key=True)
    num_peaks: int = Field(primary_key=True)
    peaks: str  # JSON-encoded list[float]
    mtime: float


# ---------------------------------------------------------------------------
# Registry parity — fail loudly at import time if a SIMPLE_TAG_FIELDS entry
# doesn't have a matching Track column.
# ---------------------------------------------------------------------------

# Tag names that live on disk only (no cache column).
_NOT_CACHED: frozenset[str] = frozenset({"starlib_meta"})
# Registry names whose cache column uses a different Python attribute name.
_RENAME: dict[str, str] = {"artist": "artist_str"}


def _check_registry_parity() -> None:
    expected: set[str] = set()
    for f in SIMPLE_TAG_FIELDS:
        if f.name in _NOT_CACHED:
            continue
        expected.add(_RENAME.get(f.name, f.name))
    missing = expected - set(Track.model_fields)
    if missing:
        raise RuntimeError(
            f"SIMPLE_TAG_FIELDS has registry entries without matching Track columns: "
            f"{sorted(missing)}. Add columns to backend/core/db/models.py::Track and "
            f"create an alembic revision."
        )


_check_registry_parity()
