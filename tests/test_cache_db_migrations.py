"""Migration + integration coverage for the SQLModel + Alembic cache DB.

These tests boot ``init_db`` against a scratch directory and verify end-to-end
behaviour through the public ``cache_db`` API, so they double as the "the
module still works" regression suite — cache_db doesn't have a single-purpose
unit test file elsewhere.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from backend.core.db import engine as db_engine
from backend.core.services import cache_db


@pytest.fixture(autouse=True)
def _reset_engine():
    """Drop the module-level engine between tests to isolate DB paths."""
    yield
    if db_engine._engine is not None:  # type: ignore[attr-defined]
        db_engine._engine.dispose()  # type: ignore[attr-defined]
    db_engine._engine = None  # type: ignore[attr-defined]
    db_engine._engine_path = None  # type: ignore[attr-defined]


def _connect(db: Path) -> sqlite3.Connection:
    return sqlite3.connect(str(db))


def _rev(db: Path) -> str | None:
    row = _connect(db).execute("SELECT version_num FROM alembic_version").fetchone()
    return row[0] if row else None


def _tables(db: Path) -> set[str]:
    return {r[0] for r in _connect(db).execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _cols(db: Path, table: str) -> set[str]:
    return {r[1] for r in _connect(db).execute(f"PRAGMA table_info({table})")}


def test_fresh_db_upgrades_to_head(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"
    cache_db.init_db(db)
    assert _rev(db) == "0003"
    assert {"tracks", "peaks", "alembic_version"} <= _tables(db)


def test_idempotent_restart(tmp_path: Path) -> None:
    """Running ``init_db`` twice must not raise or duplicate migrations."""
    db = tmp_path / "cache.db"
    cache_db.init_db(db)
    first_rev = _rev(db)
    cache_db.init_db(db)
    assert _rev(db) == first_rev


def _write_legacy_db(db: Path) -> None:
    """Write a pre-Alembic DB shaped like the original #285-era schema (pre-flat-columns)."""
    conn = _connect(db)
    conn.execute(
        """
        CREATE TABLE tracks (
            file_path TEXT PRIMARY KEY, file_name TEXT NOT NULL, folder TEXT NOT NULL,
            title TEXT, artist_str TEXT, genre TEXT, key TEXT, bpm INTEGER,
            release_date TEXT, has_artwork INTEGER NOT NULL DEFAULT 0,
            file_size INTEGER, file_format TEXT, is_complete INTEGER NOT NULL DEFAULT 0,
            missing_fields TEXT, mtime REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX idx_tracks_folder ON tracks(folder)")
    conn.execute(
        """
        CREATE TABLE peaks (
            file_path TEXT PRIMARY KEY, num_peaks INTEGER, peaks TEXT, mtime REAL
        )
        """
    )
    conn.execute(
        "INSERT INTO tracks(file_path, file_name, folder, title, mtime) VALUES (?, ?, ?, ?, ?)",
        ("/music/x.mp3", "x.mp3", "/music", "X", 1.0),
    )
    conn.commit()
    conn.close()


def test_legacy_db_bootstrap_then_head(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"
    _write_legacy_db(db)

    cache_db.init_db(db)

    # All post-#285 flat columns must have landed.
    tracks_cols = _cols(db, "tracks")
    for col in (
        "original_artist",
        "remixer",
        "mix_name",
        "release_year",
        "user_comment",
        "soundcloud_id",
        "duration",
    ):
        assert col in tracks_cols, f"missing column after bootstrap: {col}"
    assert _rev(db) == "0003"


def test_backup_created_on_bootstrap(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"
    _write_legacy_db(db)
    cache_db.init_db(db)
    backups = list(tmp_path.glob("cache.bak-*.db"))
    assert len(backups) == 1, f"expected exactly one backup, got {backups}"


def test_upsert_and_get_track_round_trip(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"
    cache_db.init_db(db)

    folder = tmp_path / "music"
    folder.mkdir()
    file_path = folder / "song.mp3"
    file_path.write_bytes(b"")

    cache_db.upsert_track(
        file_path=file_path,
        folder=folder,
        title="Song",
        artist_str="Alice, Bob",
        genre="House",
        key="8A",
        bpm=128,
        release_date=None,
        has_artwork=True,
        file_size=123,
        file_format=".mp3",
        duration=60.0,
        is_complete=True,
        missing_fields=[],
        mtime=file_path.stat().st_mtime,
        original_artist="Carol",
        remixer="Dave",
        mix_name="VIP Mix",
        release_year=2024,
        user_comment="nice",
        soundcloud_id=42,
    )

    rows = cache_db.get_tracks(folder)
    assert len(rows) == 1
    row = rows[0]
    assert row["title"] == "Song"
    assert row["artist_str"] == "Alice, Bob"
    assert row["remixer"] == "Dave"
    assert row["release_year"] == 2024
    assert row["user_comment"] == "nice"
    assert row["soundcloud_id"] == 42


def test_search_filter_hits_flat_tag_columns(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"
    cache_db.init_db(db)
    folder = tmp_path / "music"
    folder.mkdir()
    (folder / "a.mp3").write_bytes(b"")
    (folder / "b.mp3").write_bytes(b"")

    cache_db.upsert_track(
        file_path=folder / "a.mp3",
        folder=folder,
        title="One",
        artist_str="Alice",
        genre="House",
        key=None,
        bpm=None,
        release_date=None,
        has_artwork=False,
        file_size=1,
        file_format=".mp3",
        duration=None,
        is_complete=False,
        missing_fields=[],
        mtime=1.0,
        original_artist="Needle",
        remixer="x",
        mix_name=None,
    )
    cache_db.upsert_track(
        file_path=folder / "b.mp3",
        folder=folder,
        title="Two",
        artist_str="Bob",
        genre="House",
        key=None,
        bpm=None,
        release_date=None,
        has_artwork=False,
        file_size=1,
        file_format=".mp3",
        duration=None,
        is_complete=False,
        missing_fields=[],
        mtime=1.0,
        original_artist="x",
        remixer="Haystack",
        mix_name=None,
    )

    # original_artist is in _SEARCH_COLS (registry.searchable = True)
    hits_needle = cache_db.get_tracks(folder, search_query="Needle")
    assert len(hits_needle) == 1 and hits_needle[0]["title"] == "One"

    # remixer is also searchable
    hits_hay = cache_db.get_tracks(folder, search_query="Haystack")
    assert len(hits_hay) == 1 and hits_hay[0]["title"] == "Two"


def test_peaks_round_trip(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"
    cache_db.init_db(db)
    f = tmp_path / "a.mp3"
    f.write_bytes(b"")
    cache_db.upsert_peaks(f, [0.1, 0.2, 0.3], 1.0)
    assert cache_db.get_peaks(f, 1.0, num_peaks=3) == [0.1, 0.2, 0.3]
    cache_db.delete_peaks(f)
    assert cache_db.get_peaks(f, 1.0, num_peaks=3) is None
