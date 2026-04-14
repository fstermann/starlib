"""Alembic-driven migration bootstrap for the cache DB.

At app startup this module decides between three paths:

1. **Fresh DB** — no tables, no ``alembic_version``.  ``alembic upgrade head``
   runs the full chain from scratch.
2. **Legacy DB** — tables exist but no ``alembic_version`` (any app version
   that shipped before #286).  Runs the old idempotent ``_ensure_schema``
   once to catch up users who skipped versions, takes a backup, stamps at
   ``0001``, then upgrades to head.
3. **Already-managed DB** — ``alembic_version`` exists.  Plain
   ``alembic upgrade head`` (no-op if already at head).

The legacy catch-up path is intentionally copied verbatim from the previous
``cache_db._ensure_schema`` rather than re-derived from models — the point
is to walk an arbitrary old DB up to the exact shape that revision ``0001``
records, no more and no less.
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
from importlib import resources
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import Engine, inspect

logger = logging.getLogger(__name__)

_BASELINE_REV = "0001"
_BACKUPS_TO_KEEP = 2


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_migrations(engine: Engine, db_path: Path) -> None:
    """Bring *db_path* up to the latest Alembic revision, auto-migrating legacy DBs."""
    with engine.begin() as conn:
        insp = inspect(conn)
        existing_tables = set(insp.get_table_names())

    has_managed = "alembic_version" in existing_tables
    has_legacy = "tracks" in existing_tables and not has_managed

    if has_legacy:
        logger.info("cache DB at %s is pre-Alembic; running legacy catch-up", db_path)
        _backup(db_path, "before-alembic-bootstrap")
        _legacy_ensure_schema(db_path)

    cfg = _alembic_config(engine)
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        if has_legacy:
            logger.info("stamping cache DB at revision %s", _BASELINE_REV)
            command.stamp(cfg, _BASELINE_REV)
        command.upgrade(cfg, "head")

    # Log what we landed on — useful in crash reports and helps users verify
    # a desktop release actually migrated.
    with engine.connect() as conn:
        rev = MigrationContext.configure(conn).get_current_revision()
    logger.info("cache DB migrations complete; current revision %s", rev)


# ---------------------------------------------------------------------------
# Internal: Alembic config resolution
# ---------------------------------------------------------------------------


def _alembic_config(engine: Engine) -> Config:
    """Build an Alembic ``Config`` pointed at the in-package ``backend/alembic``.

    Resolving via ``importlib.resources`` is the key detail that makes the
    sidecar work: PyInstaller bundles ``backend.alembic`` as a Python
    package (see ``desktop/sidecar.spec``) and this is the one way to find
    its on-disk location both in dev and inside the frozen binary.
    """
    alembic_dir = resources.files("backend.alembic")
    # ``resources.files`` returns a Traversable; we need a real filesystem
    # path for Alembic's ScriptDirectory.  ``as_file`` would require a
    # context manager, but for our layout the files already live on disk
    # (no zip import), so a direct ``str`` works.
    script_location = str(alembic_dir)

    cfg = Config()
    cfg.set_main_option("script_location", script_location)
    cfg.set_main_option("sqlalchemy.url", str(engine.url))
    return cfg


# ---------------------------------------------------------------------------
# Internal: legacy catch-up
# ---------------------------------------------------------------------------


def _legacy_ensure_schema(db_path: Path) -> None:
    """Run the pre-Alembic ``cache_db._ensure_schema`` against *db_path*.

    Copied verbatim (with cosmetic tweaks) from the pre-#286 implementation.
    It walks an arbitrary legacy DB forward to the exact shape captured in
    revision 0001, and is safe to run on any DB that predates the Alembic
    era — every step is guarded by ``IF NOT EXISTS`` or
    ``except OperationalError``.
    """
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(
            """
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
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS peaks (
                file_path TEXT NOT NULL,
                num_peaks INTEGER NOT NULL,
                peaks     TEXT NOT NULL,
                mtime     REAL NOT NULL,
                PRIMARY KEY (file_path, num_peaks)
            )
            """
        )
        conn.commit()

        for col, sqltype in (
            ("duration", "REAL"),
            ("soundcloud_id", "INTEGER"),
            ("remixers", "TEXT"),
        ):
            _try_add_column(conn, "tracks", col, sqltype)
        # Force re-index once remixers appeared (mirrors historical behaviour).
        if _column_exists(conn, "tracks", "remixers"):
            # The historical code only DELETE'd when the column was *just*
            # added; we can't distinguish that here, so skip the destructive
            # step — Alembic's 0001 is declarative and the cache will re-populate.
            pass

        added_any_flat = False
        for col, sqltype in (
            ("original_artist", "TEXT"),
            ("remixer", "TEXT"),
            ("mix_name", "TEXT"),
            ("release_year", "INTEGER"),
            ("user_comment", "TEXT"),
        ):
            added_any_flat |= _try_add_column(conn, "tracks", col, sqltype)
        if added_any_flat:
            conn.execute("DELETE FROM tracks")
            conn.commit()

        # peaks: migrate single-column PK → composite PK.
        cur = conn.execute("PRAGMA table_info(peaks)")
        cols = {row[1]: row[5] for row in cur.fetchall()}
        if cols.get("file_path") and not cols.get("num_peaks", 0):
            conn.execute("DROP TABLE peaks")
            conn.execute(
                """
                CREATE TABLE peaks (
                    file_path TEXT NOT NULL,
                    num_peaks INTEGER NOT NULL,
                    peaks     TEXT NOT NULL,
                    mtime     REAL NOT NULL,
                    PRIMARY KEY (file_path, num_peaks)
                )
                """
            )
            conn.commit()
    finally:
        conn.close()


def _try_add_column(conn: sqlite3.Connection, table: str, col: str, sqltype: str) -> bool:
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {sqltype}")
        conn.commit()
        return True
    except sqlite3.OperationalError:
        return False


def _column_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == col for row in cur.fetchall())


# ---------------------------------------------------------------------------
# Internal: backups
# ---------------------------------------------------------------------------


def _backup(db_path: Path, tag: str) -> Path | None:
    if not db_path.exists():
        return None
    backup = db_path.with_name(f"{db_path.stem}.bak-{tag}.db")
    shutil.copy2(db_path, backup)
    _prune_old_backups(db_path)
    logger.info("backed up cache DB to %s", backup)
    return backup


def _prune_old_backups(db_path: Path) -> None:
    backups = sorted(
        db_path.parent.glob(f"{db_path.stem}.bak-*.db"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for stale in backups[_BACKUPS_TO_KEEP:]:
        try:
            stale.unlink()
        except OSError:
            logger.warning("could not remove old backup %s", stale)
