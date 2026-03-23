"""SQLite-backed analysis cache.

Stores beat analysis results keyed by absolute file path, with staleness
detection based on file mtime + size.  The DB lives at
``{BackendSettings.cache_dir}/analysis.db`` — outside music folders.

On first access for a file, any existing sidecar ``.beats_v5.json`` is
automatically imported into the DB and deleted (one-time migration).
"""

import json
import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

BEATS_SCHEMA_VERSION = 5

_CREATE_BEATS_TABLE = """
CREATE TABLE IF NOT EXISTS beats_cache (
    file_path       TEXT PRIMARY KEY,
    file_mtime      REAL    NOT NULL,
    file_size       INTEGER NOT NULL,
    schema_version  INTEGER NOT NULL,
    beats_json      TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
"""

_SIDECAR_SUFFIX = ".beats_v5.json"


def _db_path() -> Path:
    from backend.config import get_backend_settings

    cache_dir = get_backend_settings().cache_dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "analysis.db"


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(_CREATE_BEATS_TABLE)
    conn.commit()
    return conn


def get_beats(file_path: Path) -> dict | None:
    """Return cached beat analysis for *file_path*, or ``None`` if missing/stale.

    Side effect: if no DB entry exists but a legacy sidecar
    ``.{stem}.beats_v5.json`` is found next to the audio file, it is imported
    into the DB and the sidecar deleted (one-time migration).

    Parameters
    ----------
    file_path:
        Absolute path to the audio file.

    Returns
    -------
    dict or None
        ``{bpm, beats, downbeats}`` on cache hit; ``None`` otherwise.
    """
    db_path = _db_path()
    stat = file_path.stat()
    mtime, size = stat.st_mtime, stat.st_size

    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT file_mtime, file_size, schema_version, beats_json"
            " FROM beats_cache WHERE file_path = ?",
            (str(file_path),),
        ).fetchone()

    if row is not None:
        cached_mtime, cached_size, cached_version, beats_json = row
        if (
            cached_version == BEATS_SCHEMA_VERSION
            and abs(cached_mtime - mtime) < 1.0
            and cached_size == size
        ):
            logger.info("Beat cache hit (DB): %s", file_path.name)
            return json.loads(beats_json)
        logger.debug("Beat cache stale for %s, will re-analyse", file_path.name)
        return None

    # --- one-time sidecar migration ---
    sidecar = file_path.parent / f".{file_path.stem}{_SIDECAR_SUFFIX}"
    if sidecar.exists():
        try:
            data = json.loads(sidecar.read_text())
            set_beats(file_path, data)
            sidecar.unlink()
            logger.info("Migrated sidecar → DB: %s", file_path.name)
            return data
        except Exception as exc:
            logger.warning("Sidecar migration failed for %s: %s", file_path.name, exc)

    return None


def set_beats(file_path: Path, data: dict) -> None:
    """Persist beat analysis *data* for *file_path* in the DB.

    Parameters
    ----------
    file_path:
        Absolute path to the audio file (used as the cache key).
    data:
        ``{bpm, beats, downbeats}`` dict to store.
    """
    db_path = _db_path()
    stat = file_path.stat()
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO beats_cache
                (file_path, file_mtime, file_size, schema_version, beats_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(file_path) DO UPDATE SET
                file_mtime     = excluded.file_mtime,
                file_size      = excluded.file_size,
                schema_version = excluded.schema_version,
                beats_json     = excluded.beats_json,
                created_at     = datetime('now')
            """,
            (
                str(file_path),
                stat.st_mtime,
                stat.st_size,
                BEATS_SCHEMA_VERSION,
                json.dumps(data),
            ),
        )
    logger.debug("Beat cache written (DB): %s", file_path.name)
