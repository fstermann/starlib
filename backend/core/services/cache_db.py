"""SQLModel-backed cache for track metadata and waveform peaks.

Thin CRUD layer over ``backend.core.db``.  Every public function keeps its
pre-#286 signature so that callers in ``collection.py``, ``watcher.py``, and
the metadata endpoints don't have to change.

Threading: each operation opens a short-lived ``Session`` from the module-level
engine.  The engine is a normal SQLAlchemy pool (not thread-local), but SQLite
in WAL mode happily serves concurrent reads alongside a single writer, so the
"concurrent reads alongside a background indexer" behaviour is preserved — see
``tests/test_cache_db_concurrency.py``.
"""

from __future__ import annotations

import json
import logging
from datetime import date
from pathlib import Path

from sqlalchemy import Select, String, delete, func, or_, select, update

from backend.core.db.engine import get_engine, init_engine
from backend.core.db.migrations import run_migrations
from backend.core.db.models import Peaks, SoundcloudTrackBpm, Track
from soundcloud_tools.handler.track import SIMPLE_TAG_FIELDS

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Registry-driven sort + search metadata
# ---------------------------------------------------------------------------

# Mapping registry name → Track column attribute.  ``artist`` is joined to a
# string at cache-write time and lives in ``artist_str``.
_REGISTRY_COL: dict[str, str] = {"artist": "artist_str"}


def _track_column(field_or_column: str):
    attr = _REGISTRY_COL.get(field_or_column, field_or_column)
    col = getattr(Track, attr, None)
    if col is None:
        raise KeyError(f"Unknown Track column: {field_or_column}")
    return col


# Columns callers may sort by.  Registry-driven, plus a few static helpers.
_SORT_COLS: dict[str, str] = {
    "title": "title",
    "artist": "artist_str",
    "genre": "genre",
    "bpm": "bpm",
    "key": "key",
    "release_date": "release_date",
    "release_year": "release_year",
    "original_artist": "original_artist",
    "remixer": "remixer",
    "mix_name": "mix_name",
    "file_name": "file_name",
    "folder": "folder",
    "mtime": "mtime",
}
_NULLABLE_SORT_COLS = {"bpm", "release_date", "release_year"}

# Columns matched by search_query LIKE clauses — derived from registry.
_SEARCH_COLS: tuple[str, ...] = tuple(_REGISTRY_COL.get(f.name, f.name) for f in SIMPLE_TAG_FIELDS if f.searchable)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


def init_db(db_path: Path) -> None:
    """Initialise the engine at *db_path* and run Alembic migrations to head."""
    engine = init_engine(db_path)
    run_migrations(engine, db_path)


# ---------------------------------------------------------------------------
# Track operations
# ---------------------------------------------------------------------------


def upsert_track(
    *,
    file_path: Path,
    folder: Path,
    title: str | None,
    artist_str: str,
    genre: str | None,
    key: str | None,
    bpm: int | None,
    release_date: date | None,
    has_artwork: bool,
    file_size: int,
    file_format: str,
    duration: float | None,
    is_complete: bool,
    missing_fields: list[str],
    mtime: float,
    soundcloud_id: int | None = None,
    original_artist: str | None = None,
    remixer: str | None = None,
    mix_name: str | None = None,
    release_year: int | None = None,
    user_comment: str | None = None,
) -> None:
    """Insert or replace a track row."""
    engine = get_engine()
    row = {
        "file_path": str(file_path),
        "file_name": file_path.name,
        "folder": str(folder),
        "title": title or None,
        "artist_str": artist_str or None,
        "genre": genre or None,
        "key": key or None,
        "bpm": bpm,
        "release_date": str(release_date) if release_date else None,
        "release_year": release_year,
        "original_artist": original_artist or None,
        "remixer": remixer or None,
        "mix_name": mix_name or None,
        "user_comment": user_comment or None,
        "has_artwork": bool(has_artwork),
        "file_size": file_size,
        "file_format": file_format,
        "duration": duration,
        "is_complete": bool(is_complete),
        "missing_fields": json.dumps(missing_fields),
        "mtime": mtime,
        "soundcloud_id": soundcloud_id,
    }
    # Use raw SQLite "INSERT OR REPLACE" semantics via SQLAlchemy Core to keep
    # the single-round-trip behaviour the caller relied on previously.
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    stmt = sqlite_insert(Track.__table__).values(row)
    update_cols = {c: stmt.excluded[c] for c in row if c != "file_path"}
    stmt = stmt.on_conflict_do_update(index_elements=[Track.__table__.c.file_path], set_=update_cols)
    with engine.begin() as conn:
        conn.execute(stmt)


def update_track_bpm(file_path: Path, bpm: int) -> bool:
    """Update the cached BPM for a track. Returns True if a row was updated."""
    stmt = update(Track).where(Track.file_path == str(file_path)).values(bpm=bpm)
    with get_engine().begin() as conn:
        result = conn.execute(stmt)
    return result.rowcount > 0


def delete_track(file_path: Path) -> None:
    with get_engine().begin() as conn:
        conn.execute(delete(Track).where(Track.file_path == str(file_path)))


def upsert_sc_bpm(track_id: int, bpm: int, analyzed_at: float) -> None:
    """Insert or replace the cached BPM for a SoundCloud track."""
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    row = {
        "track_id": track_id,
        "bpm": bpm,
        "analyzed_at": analyzed_at,
    }
    stmt = sqlite_insert(SoundcloudTrackBpm.__table__).values(row)
    stmt = stmt.on_conflict_do_update(
        index_elements=[SoundcloudTrackBpm.__table__.c.track_id],
        set_={c: stmt.excluded[c] for c in row if c != "track_id"},
    )
    with get_engine().begin() as conn:
        conn.execute(stmt)


def get_sc_bpm(track_id: int) -> dict | None:
    """Return the cached BPM row for a SoundCloud track or None."""
    with get_engine().connect() as conn:
        row = conn.execute(select(SoundcloudTrackBpm).where(SoundcloudTrackBpm.track_id == track_id)).mappings().first()
    return dict(row) if row else None


def get_sc_bpms(track_ids: list[int]) -> dict[int, int]:
    """Bulk lookup: returns {track_id: bpm} for any tracks found in cache."""
    if not track_ids:
        return {}
    with get_engine().connect() as conn:
        rows = conn.execute(
            select(SoundcloudTrackBpm.track_id, SoundcloudTrackBpm.bpm).where(
                SoundcloudTrackBpm.track_id.in_(track_ids)
            )
        ).all()
    return {int(r[0]): int(r[1]) for r in rows}


def get_track_mtime(file_path: Path) -> float | None:
    with get_engine().connect() as conn:
        row = conn.execute(select(Track.mtime).where(Track.file_path == str(file_path))).first()
    return float(row[0]) if row else None


def get_all_tracks(folder: Path):
    with get_engine().connect() as conn:
        result = conn.execute(select(Track).where(Track.folder == str(folder)))
        return result.mappings().all()


def invalidate_folder(folder: Path) -> None:
    with get_engine().begin() as conn:
        conn.execute(delete(Track).where(Track.folder == str(folder)))


def invalidate_file(file_path: Path) -> None:
    delete_track(file_path)


def get_distinct_folders() -> list[str]:
    """Return all distinct folder paths that contain at least one track."""
    with get_engine().connect() as conn:
        rows = conn.execute(select(Track.folder).distinct().order_by(Track.folder)).all()
    return [r[0] for r in rows]


def get_folder_track_counts() -> dict[str, int]:
    """Return direct track count per folder (non-recursive)."""
    with get_engine().connect() as conn:
        rows = conn.execute(select(Track.folder, func.count()).group_by(Track.folder)).all()
    return {r[0]: int(r[1]) for r in rows}


def get_soundcloud_ids(folder: Path) -> list[int]:
    with get_engine().connect() as conn:
        rows = conn.execute(
            select(Track.soundcloud_id).where(Track.folder == str(folder), Track.soundcloud_id.is_not(None))
        ).all()
    return [int(r[0]) for r in rows]


# ---------------------------------------------------------------------------
# Filtered / sorted query
# ---------------------------------------------------------------------------


def _folder_clause(folder: Path, recursive: bool = False):
    """Return a SQLAlchemy clause filtering tracks to *folder*.

    When *recursive* is True the clause matches the folder itself and all
    subdirectories beneath it.
    """
    folder_str = str(folder)
    if recursive:
        return or_(Track.folder == folder_str, Track.folder.startswith(folder_str + "/"))
    return Track.folder == folder_str


def _apply_filters(  # noqa: C901
    stmt: Select,
    *,
    folder: Path | None = None,
    recursive: bool = False,
    search_query: str | None = None,
    genres: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    artists: list[str] | None = None,
    has_soundcloud_id: bool | None = None,
) -> Select:
    if folder is not None:
        stmt = stmt.where(_folder_clause(folder, recursive))
    if genres:
        stmt = stmt.where(Track.genre.in_(genres))
    if keys:
        stmt = stmt.where(Track.key.in_(keys))
    if bpm_min is not None:
        stmt = stmt.where(Track.bpm >= bpm_min)
    if bpm_max is not None:
        stmt = stmt.where(Track.bpm <= bpm_max)
    if start_date is not None:
        stmt = stmt.where(Track.release_date >= str(start_date))
    if end_date is not None:
        stmt = stmt.where(Track.release_date <= str(end_date))
    if has_soundcloud_id is not None:
        stmt = stmt.where(Track.soundcloud_id.is_not(None) if has_soundcloud_id else Track.soundcloud_id.is_(None))
    if artists:
        clauses = [Track.artist_str.like(f"%{a}%") for a in artists]
        stmt = stmt.where(or_(*clauses))
    if search_query:
        q = f"%{search_query}%"
        clauses = [_track_column(c).like(q) for c in _SEARCH_COLS]
        stmt = stmt.where(or_(*clauses))
    return stmt


def get_tracks(
    folder: Path,
    *,
    recursive: bool = False,
    search_query: str | None = None,
    genres: list[str] | None = None,
    artists: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    has_soundcloud_id: bool | None = None,
    sort_by: str = "file_name",
    sort_order: str = "asc",
):
    """Return filtered and sorted track rows as mapping-style objects."""
    stmt = _apply_filters(
        select(Track),
        folder=folder,
        recursive=recursive,
        search_query=search_query,
        genres=genres,
        artists=artists,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
        start_date=start_date,
        end_date=end_date,
        has_soundcloud_id=has_soundcloud_id,
    )

    sort_col_name = _SORT_COLS.get(sort_by, "file_name")
    col = getattr(Track, sort_col_name)
    # Lower-case string columns for stable case-insensitive ordering.
    order_expr = func.lower(col) if isinstance(col.type, String) else col
    if sort_order == "desc":
        order_expr = order_expr.desc()
    else:
        order_expr = order_expr.asc()
    if sort_by in _NULLABLE_SORT_COLS:
        stmt = stmt.order_by(col.is_(None).asc(), order_expr)
    else:
        stmt = stmt.order_by(order_expr)

    with get_engine().connect() as conn:
        return conn.execute(stmt).mappings().all()


# ---------------------------------------------------------------------------
# Aggregate queries
# ---------------------------------------------------------------------------


def get_filter_values(
    folder: Path,
    *,
    recursive: bool = False,
    search_query: str | None = None,
    genres: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
) -> dict:
    """Return dropdown option lists + faceted counts for genres, keys, artists, BPM range."""
    engine = get_engine()
    fc = _folder_clause(folder, recursive)

    def _count(stmt: Select) -> list:
        with engine.connect() as conn:
            return list(conn.execute(stmt).all())

    with engine.connect() as conn:
        all_genres = [
            r[0]
            for r in conn.execute(
                select(Track.genre)
                .where(
                    fc,
                    Track.genre.is_not(None),
                    Track.genre != "",
                )
                .group_by(Track.genre)
                .order_by(Track.genre)
            ).all()
        ]
        all_keys = [
            r[0]
            for r in conn.execute(
                select(Track.key)
                .where(fc, Track.key.is_not(None), Track.key != "")
                .group_by(Track.key)
                .order_by(Track.key)
            ).all()
        ]

    # Genre counts: apply all filters EXCEPT genres.
    genre_stmt = _apply_filters(
        select(Track.genre, func.count()).where(fc, Track.genre.is_not(None), Track.genre != ""),
        search_query=search_query,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
    ).group_by(Track.genre)
    filtered_genre_counts = {r[0]: r[1] for r in _count(genre_stmt)}
    genre_counts = {g: filtered_genre_counts.get(g, 0) for g in all_genres}

    # Key counts: apply all filters EXCEPT keys.
    key_stmt = _apply_filters(
        select(Track.key, func.count()).where(fc, Track.key.is_not(None), Track.key != ""),
        search_query=search_query,
        genres=genres,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
    ).group_by(Track.key)
    filtered_key_counts = {r[0]: r[1] for r in _count(key_stmt)}
    key_counts = {k: filtered_key_counts.get(k, 0) for k in all_keys}

    with engine.connect() as conn:
        bpm_row = conn.execute(
            select(func.min(Track.bpm), func.max(Track.bpm)).where(fc, Track.bpm.is_not(None))
        ).first()
        artists_rows = conn.execute(
            select(Track.artist_str)
            .where(
                fc,
                Track.artist_str.is_not(None),
                Track.artist_str != "",
            )
            .distinct()
            .order_by(Track.artist_str)
        ).all()

    return {
        "genres": all_genres,
        "genre_counts": genre_counts,
        "artists": [r[0] for r in artists_rows],
        "keys": all_keys,
        "key_counts": key_counts,
        "bpm_min": bpm_row[0] if bpm_row else None,
        "bpm_max": bpm_row[1] if bpm_row else None,
    }


def get_stats(folder: Path, *, recursive: bool = False) -> dict:
    engine = get_engine()
    fc = _folder_clause(folder, recursive)
    with engine.connect() as conn:
        total = conn.execute(select(func.count()).select_from(Track).where(fc)).scalar_one()
        complete = conn.execute(
            select(func.count()).select_from(Track).where(fc, Track.is_complete.is_(True))
        ).scalar_one()
        bpm_row = conn.execute(
            select(func.min(Track.bpm), func.max(Track.bpm)).where(fc, Track.bpm.is_not(None))
        ).first()

        def _missing(where) -> int:
            return conn.execute(select(func.count()).select_from(Track).where(fc, where)).scalar_one()

        missing_artwork = _missing(Track.has_artwork.is_(False))
        missing_release_date = _missing(Track.release_date.is_(None))
        missing_title = _missing(or_(Track.title.is_(None), Track.title == ""))
        missing_genre = _missing(or_(Track.genre.is_(None), Track.genre == ""))

        genres = [
            r[0]
            for r in conn.execute(
                select(Track.genre)
                .where(
                    fc,
                    Track.genre.is_not(None),
                    Track.genre != "",
                )
                .distinct()
                .order_by(Track.genre)
            ).all()
        ]
        artists = [
            r[0]
            for r in conn.execute(
                select(Track.artist_str)
                .where(
                    fc,
                    Track.artist_str.is_not(None),
                    Track.artist_str != "",
                )
                .distinct()
                .order_by(Track.artist_str)
            ).all()
        ]
        keys = [
            r[0]
            for r in conn.execute(
                select(Track.key).where(fc, Track.key.is_not(None), Track.key != "").distinct().order_by(Track.key)
            ).all()
        ]

    return {
        "total_tracks": int(total or 0),
        "complete_tracks": int(complete or 0),
        "incomplete_tracks": int((total or 0) - (complete or 0)),
        "total_artists": len(artists),
        "total_genres": len(genres),
        "missing_fields": {
            "title": missing_title,
            "genre": missing_genre,
            "release_date": missing_release_date,
            "artwork": missing_artwork,
        },
        "genres": genres,
        "artists": artists,
        "keys": keys,
        "bpm_min": bpm_row[0] if bpm_row else None,
        "bpm_max": bpm_row[1] if bpm_row else None,
    }


# ---------------------------------------------------------------------------
# Peaks operations
# ---------------------------------------------------------------------------


def get_peaks(file_path: Path, mtime: float, num_peaks: int | None = None) -> list[float] | None:
    stmt = select(Peaks.peaks).where(Peaks.file_path == str(file_path), Peaks.mtime == mtime)
    if num_peaks is not None:
        stmt = stmt.where(Peaks.num_peaks == num_peaks)
    with get_engine().connect() as conn:
        row = conn.execute(stmt).first()
    return json.loads(row[0]) if row else None


def upsert_peaks(file_path: Path, peaks: list[float], mtime: float) -> None:
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    row = {
        "file_path": str(file_path),
        "num_peaks": len(peaks),
        "peaks": json.dumps(peaks),
        "mtime": mtime,
    }
    stmt = sqlite_insert(Peaks.__table__).values(row)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Peaks.__table__.c.file_path, Peaks.__table__.c.num_peaks],
        set_={"peaks": stmt.excluded.peaks, "mtime": stmt.excluded.mtime},
    )
    with get_engine().begin() as conn:
        conn.execute(stmt)


def delete_peaks(file_path: Path) -> None:
    with get_engine().begin() as conn:
        conn.execute(delete(Peaks).where(Peaks.file_path == str(file_path)))


def prune_missing_files() -> int:
    """Delete cache entries for files that no longer exist on disk."""
    engine = get_engine()
    with engine.connect() as conn:
        paths = [r[0] for r in conn.execute(select(Track.file_path)).all()]
    stale = [p for p in paths if not Path(p).exists()]
    if not stale:
        return 0
    with engine.begin() as conn:
        conn.execute(delete(Track).where(Track.file_path.in_(stale)))
        conn.execute(delete(Peaks).where(Peaks.file_path.in_(stale)))
    logger.info("Pruned %d stale cache entries", len(stale))
    return len(stale)
