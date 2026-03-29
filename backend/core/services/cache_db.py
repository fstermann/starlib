"""SQLite-backed cache for track metadata and waveform peaks.

Thread-safe via thread-local connections in WAL mode, which allows concurrent
reads alongside a single background writer without blocking either side.
"""

import json
import logging
import sqlite3
import threading
from datetime import date
from pathlib import Path

logger = logging.getLogger(__name__)

_local = threading.local()
_db_path: Path | None = None


def init_db(db_path: Path) -> None:
    """Initialise the database at *db_path*, creating tables if missing."""
    global _db_path
    _db_path = db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = _get_conn()
    conn.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS tracks (
            file_path    TEXT PRIMARY KEY,
            file_name    TEXT NOT NULL,
            folder       TEXT NOT NULL,
            title        TEXT,
            artist_str   TEXT,
            genre        TEXT,
            key          TEXT,
            bpm          INTEGER,
            release_date TEXT,
            has_artwork  INTEGER NOT NULL DEFAULT 0,
            file_size    INTEGER,
            file_format  TEXT,
            duration     REAL,
            is_complete  INTEGER NOT NULL DEFAULT 0,
            missing_fields TEXT,
            mtime        REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder);

        CREATE TABLE IF NOT EXISTS peaks (
            file_path TEXT NOT NULL,
            num_peaks INTEGER NOT NULL,
            peaks     TEXT NOT NULL,
            mtime     REAL NOT NULL,
            PRIMARY KEY (file_path, num_peaks)
        );
    """)
    # Migrate existing DBs that pre-date the duration column
    try:
        conn.execute("ALTER TABLE tracks ADD COLUMN duration REAL")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists

    # Migrate existing DBs that pre-date the soundcloud_id column
    try:
        conn.execute("ALTER TABLE tracks ADD COLUMN soundcloud_id INTEGER")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists

    # Migrate peaks table from single-column PK to composite PK (file_path, num_peaks)
    try:
        cur = conn.execute("PRAGMA table_info(peaks)")
        cols = {row[1]: row[5] for row in cur.fetchall()}  # name -> pk_index
        # Old schema had file_path as sole PK (pk=1, num_peaks pk=0)
        if cols.get("file_path") and not cols.get("num_peaks", 0):
            conn.execute("DROP TABLE peaks")
            conn.execute("""
                CREATE TABLE peaks (
                    file_path TEXT NOT NULL,
                    num_peaks INTEGER NOT NULL,
                    peaks     TEXT NOT NULL,
                    mtime     REAL NOT NULL,
                    PRIMARY KEY (file_path, num_peaks)
                )
            """)
            conn.commit()
    except sqlite3.OperationalError:
        pass


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_conn() -> sqlite3.Connection:
    """Return a thread-local connection, opening one on first use."""
    if not hasattr(_local, "conn") or _local.conn is None:
        if _db_path is None:
            raise RuntimeError("cache_db.init_db() has not been called")
        conn = sqlite3.connect(str(_db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return _local.conn


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
) -> None:
    """Insert or replace a track row."""
    conn = _get_conn()
    conn.execute(
        """
        INSERT OR REPLACE INTO tracks
            (file_path, file_name, folder, title, artist_str, genre, key, bpm,
             release_date, has_artwork, file_size, file_format, duration, is_complete,
             missing_fields, mtime, soundcloud_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(file_path),
            file_path.name,
            str(folder),
            title or None,
            artist_str or None,
            genre or None,
            key or None,
            bpm,
            str(release_date) if release_date else None,
            int(has_artwork),
            file_size,
            file_format,
            duration,
            int(is_complete),
            json.dumps(missing_fields),
            mtime,
            soundcloud_id,
        ),
    )
    conn.commit()


def delete_track(file_path: Path) -> None:
    """Remove a track row from the DB."""
    conn = _get_conn()
    conn.execute("DELETE FROM tracks WHERE file_path = ?", (str(file_path),))
    conn.commit()


def get_track_mtime(file_path: Path) -> float | None:
    """Return the stored mtime for *file_path*, or None if not indexed."""
    row = _get_conn().execute("SELECT mtime FROM tracks WHERE file_path = ?", (str(file_path),)).fetchone()
    return row["mtime"] if row else None


def get_all_tracks(folder: Path) -> list[sqlite3.Row]:
    """Return all track rows for *folder*."""
    return _get_conn().execute("SELECT * FROM tracks WHERE folder = ?", (str(folder),)).fetchall()


def invalidate_folder(folder: Path) -> None:
    """Delete all track rows for *folder*."""
    conn = _get_conn()
    conn.execute("DELETE FROM tracks WHERE folder = ?", (str(folder),))
    conn.commit()


def invalidate_file(file_path: Path) -> None:
    """Delete the track row for a single file."""
    conn = _get_conn()
    conn.execute("DELETE FROM tracks WHERE file_path = ?", (str(file_path),))
    conn.commit()


def get_soundcloud_ids(folder: Path) -> list[int]:
    """Return all non-null soundcloud_ids for tracks in *folder*."""
    rows = (
        _get_conn()
        .execute(
            "SELECT soundcloud_id FROM tracks WHERE folder = ? AND soundcloud_id IS NOT NULL",
            (str(folder),),
        )
        .fetchall()
    )
    return [r["soundcloud_id"] for r in rows]


# ---------------------------------------------------------------------------
# Filtered / sorted query
# ---------------------------------------------------------------------------

_SORT_COLS: dict[str, str] = {
    "title": "LOWER(COALESCE(title, ''))",
    "artist": "LOWER(COALESCE(artist_str, ''))",
    "genre": "LOWER(COALESCE(genre, ''))",
    "bpm": "bpm",
    "key": "LOWER(COALESCE(key, ''))",
    "release_date": "release_date",
    "file_name": "LOWER(file_name)",
}
_NULLABLE_SORT_COLS = {"bpm", "release_date"}


def get_tracks(
    folder: Path,
    *,
    search_query: str | None = None,
    genres: list[str] | None = None,
    artists: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    sort_by: str = "file_name",
    sort_order: str = "asc",
) -> list[sqlite3.Row]:
    """Return filtered and sorted track rows."""
    conds: list[str] = ["folder = ?"]
    params: list = [str(folder)]

    if genres:
        conds.append(f"genre IN ({','.join('?' * len(genres))})")
        params.extend(genres)
    if keys:
        conds.append(f"key IN ({','.join('?' * len(keys))})")
        params.extend(keys)
    if bpm_min is not None:
        conds.append("bpm >= ?")
        params.append(bpm_min)
    if bpm_max is not None:
        conds.append("bpm <= ?")
        params.append(bpm_max)
    if start_date is not None:
        conds.append("release_date >= ?")
        params.append(str(start_date))
    if end_date is not None:
        conds.append("release_date <= ?")
        params.append(str(end_date))
    if artists:
        artist_conds = " OR ".join("artist_str LIKE ?" for _ in artists)
        conds.append(f"({artist_conds})")
        params.extend(f"%{a}%" for a in artists)
    if search_query:
        q = f"%{search_query}%"
        conds.append("(title LIKE ? OR artist_str LIKE ? OR genre LIKE ?)")
        params.extend([q, q, q])

    where = " AND ".join(conds)
    col = _SORT_COLS.get(sort_by, "LOWER(file_name)")
    order = "DESC" if sort_order == "desc" else "ASC"

    # Always put NULLs last regardless of direction
    if sort_by in _NULLABLE_SORT_COLS:
        order_clause = f"{col} IS NULL ASC, {col} {order}"
    else:
        order_clause = f"{col} {order}"

    return (
        _get_conn()
        .execute(
            f"SELECT * FROM tracks WHERE {where} ORDER BY {order_clause}",
            params,
        )
        .fetchall()
    )


# ---------------------------------------------------------------------------
# Aggregate queries
# ---------------------------------------------------------------------------


def _build_filter_conds(
    *,
    search_query: str | None = None,
    genres: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
) -> tuple[list[str], list]:
    """Build WHERE clause fragments for optional filter params (excluding folder)."""
    conds: list[str] = []
    params: list = []
    if genres:
        conds.append(f"genre IN ({','.join('?' * len(genres))})")
        params.extend(genres)
    if keys:
        conds.append(f"key IN ({','.join('?' * len(keys))})")
        params.extend(keys)
    if bpm_min is not None:
        conds.append("bpm >= ?")
        params.append(bpm_min)
    if bpm_max is not None:
        conds.append("bpm <= ?")
        params.append(bpm_max)
    if search_query:
        q = f"%{search_query}%"
        conds.append("(title LIKE ? OR artist_str LIKE ? OR genre LIKE ?)")
        params.extend([q, q, q])
    return conds, params


def get_filter_values(
    folder: Path,
    *,
    search_query: str | None = None,
    genres: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
) -> dict:
    """Return dropdown option lists + faceted counts for genres, keys, artists, BPM range.

    Counts are faceted: genre counts exclude the active genre filter so that each
    genre shows how many tracks match all *other* active filters. Same for keys.
    Options present in the full folder but with count=0 under current filters are
    included in the result so the UI can gray them out.
    """
    conn = _get_conn()
    folder_str = str(folder)

    # All genres/keys in folder (unfiltered — defines the full option list)
    all_genres = [
        r["genre"]
        for r in conn.execute(
            "SELECT genre FROM tracks "
            "WHERE folder = ? AND genre IS NOT NULL AND genre != '' "
            "GROUP BY genre ORDER BY genre",
            (folder_str,),
        ).fetchall()
    ]
    all_keys = [
        r["key"]
        for r in conn.execute(
            "SELECT key FROM tracks WHERE folder = ? AND key IS NOT NULL AND key != '' GROUP BY key ORDER BY key",
            (folder_str,),
        ).fetchall()
    ]

    # Genre counts: apply all filters EXCEPT genres (faceted)
    genre_extra_conds, genre_extra_params = _build_filter_conds(
        search_query=search_query, keys=keys, bpm_min=bpm_min, bpm_max=bpm_max
    )
    genre_where_parts = ["folder = ?", "genre IS NOT NULL", "genre != ''", *genre_extra_conds]
    genre_where = " AND ".join(genre_where_parts)
    filtered_genre_counts = {
        r["genre"]: r["cnt"]
        for r in conn.execute(
            f"SELECT genre, COUNT(*) AS cnt FROM tracks WHERE {genre_where} GROUP BY genre",
            [folder_str, *genre_extra_params],
        ).fetchall()
    }
    genre_counts = {g: filtered_genre_counts.get(g, 0) for g in all_genres}

    # Key counts: apply all filters EXCEPT keys (faceted)
    key_extra_conds, key_extra_params = _build_filter_conds(
        search_query=search_query, genres=genres, bpm_min=bpm_min, bpm_max=bpm_max
    )
    key_where_parts = ["folder = ?", "key IS NOT NULL", "key != ''", *key_extra_conds]
    key_where = " AND ".join(key_where_parts)
    filtered_key_counts = {
        r["key"]: r["cnt"]
        for r in conn.execute(
            f"SELECT key, COUNT(*) AS cnt FROM tracks WHERE {key_where} GROUP BY key",
            [folder_str, *key_extra_params],
        ).fetchall()
    }
    key_counts = {k: filtered_key_counts.get(k, 0) for k in all_keys}

    bpm_row = conn.execute(
        "SELECT MIN(bpm) AS bpm_min, MAX(bpm) AS bpm_max FROM tracks WHERE folder = ? AND bpm IS NOT NULL",
        (folder_str,),
    ).fetchone()

    artists_rows = conn.execute(
        "SELECT DISTINCT artist_str FROM tracks "
        "WHERE folder = ? AND artist_str IS NOT NULL AND artist_str != '' "
        "ORDER BY artist_str",
        (folder_str,),
    ).fetchall()

    return {
        "genres": all_genres,
        "genre_counts": genre_counts,
        "artists": [r["artist_str"] for r in artists_rows],
        "keys": all_keys,
        "key_counts": key_counts,
        "bpm_min": bpm_row["bpm_min"] if bpm_row else None,
        "bpm_max": bpm_row["bpm_max"] if bpm_row else None,
    }


def get_stats(folder: Path) -> dict:
    """Return collection statistics for *folder*."""
    conn = _get_conn()
    folder_str = str(folder)

    agg = conn.execute(
        "SELECT COUNT(*) AS total, SUM(is_complete) AS complete FROM tracks WHERE folder = ?",
        (folder_str,),
    ).fetchone()

    bpm_row = conn.execute(
        "SELECT MIN(bpm) AS bpm_min, MAX(bpm) AS bpm_max FROM tracks WHERE folder = ? AND bpm IS NOT NULL",
        (folder_str,),
    ).fetchone()

    missing_artwork = conn.execute(
        "SELECT COUNT(*) FROM tracks WHERE folder = ? AND has_artwork = 0",
        (folder_str,),
    ).fetchone()[0]
    missing_release_date = conn.execute(
        "SELECT COUNT(*) FROM tracks WHERE folder = ? AND release_date IS NULL",
        (folder_str,),
    ).fetchone()[0]
    missing_title = conn.execute(
        "SELECT COUNT(*) FROM tracks WHERE folder = ? AND (title IS NULL OR title = '')",
        (folder_str,),
    ).fetchone()[0]
    missing_genre = conn.execute(
        "SELECT COUNT(*) FROM tracks WHERE folder = ? AND (genre IS NULL OR genre = '')",
        (folder_str,),
    ).fetchone()[0]

    genres = [
        r[0]
        for r in conn.execute(
            "SELECT DISTINCT genre FROM tracks WHERE folder = ? AND genre IS NOT NULL AND genre != '' ORDER BY genre",
            (folder_str,),
        ).fetchall()
    ]
    artists = [
        r[0]
        for r in conn.execute(
            "SELECT DISTINCT artist_str FROM tracks"
            " WHERE folder = ? AND artist_str IS NOT NULL AND artist_str != ''"
            " ORDER BY artist_str",
            (folder_str,),
        ).fetchall()
    ]
    keys = [
        r[0]
        for r in conn.execute(
            "SELECT DISTINCT key FROM tracks WHERE folder = ? AND key IS NOT NULL AND key != '' ORDER BY key",
            (folder_str,),
        ).fetchall()
    ]

    total = agg["total"] or 0
    complete = int(agg["complete"] or 0)

    return {
        "total_tracks": total,
        "complete_tracks": complete,
        "incomplete_tracks": total - complete,
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
        "bpm_min": bpm_row["bpm_min"] if bpm_row else None,
        "bpm_max": bpm_row["bpm_max"] if bpm_row else None,
    }


# ---------------------------------------------------------------------------
# Peaks operations
# ---------------------------------------------------------------------------


def get_peaks(file_path: Path, mtime: float, num_peaks: int | None = None) -> list[float] | None:
    """Return cached peak data if it exists and mtime matches, else None."""
    if num_peaks is not None:
        row = (
            _get_conn()
            .execute(
                "SELECT peaks FROM peaks WHERE file_path = ? AND mtime = ? AND num_peaks = ?",
                (str(file_path), mtime, num_peaks),
            )
            .fetchone()
        )
    else:
        row = (
            _get_conn()
            .execute(
                "SELECT peaks FROM peaks WHERE file_path = ? AND mtime = ?",
                (str(file_path), mtime),
            )
            .fetchone()
        )
    return json.loads(row["peaks"]) if row else None


def upsert_peaks(file_path: Path, peaks: list[float], mtime: float) -> None:
    """Store peak data for *file_path* with the given *mtime*."""
    conn = _get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO peaks (file_path, num_peaks, peaks, mtime) VALUES (?, ?, ?, ?)",
        (str(file_path), len(peaks), json.dumps(peaks), mtime),
    )
    conn.commit()


def delete_peaks(file_path: Path) -> None:
    """Remove peaks row for *file_path*."""
    conn = _get_conn()
    conn.execute("DELETE FROM peaks WHERE file_path = ?", (str(file_path),))
    conn.commit()
