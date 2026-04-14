"""WAL / concurrent-access regression for the SQLModel cache.

A background indexer thread + a pool of reader threads must coexist without
``OperationalError('database is locked')``.  Before the SQLModel swap this
was enforced by thread-local raw sqlite connections; under SQLAlchemy we
rely on WAL + short-lived sessions to deliver the same property.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from backend.core.db import engine as db_engine
from backend.core.services import cache_db


@pytest.fixture(autouse=True)
def _reset_engine():
    yield
    if db_engine._engine is not None:  # type: ignore[attr-defined]
        db_engine._engine.dispose()  # type: ignore[attr-defined]
    db_engine._engine = None  # type: ignore[attr-defined]
    db_engine._engine_path = None  # type: ignore[attr-defined]


def _fake_upsert(folder: Path, i: int) -> None:
    f = folder / f"t{i}.mp3"
    cache_db.upsert_track(
        file_path=f,
        folder=folder,
        title=f"Track {i}",
        artist_str="Artist",
        genre="House",
        key=None,
        bpm=120 + (i % 10),
        release_date=None,
        has_artwork=False,
        file_size=1,
        file_format=".mp3",
        duration=None,
        is_complete=False,
        missing_fields=[],
        mtime=float(i),
    )


def test_concurrent_writes_and_reads(tmp_path: Path) -> None:
    db = tmp_path / "cache.db"
    cache_db.init_db(db)
    folder = tmp_path / "music"
    folder.mkdir()

    stop = threading.Event()
    errors: list[BaseException] = []
    writes = 200

    def writer() -> None:
        try:
            for i in range(writes):
                _fake_upsert(folder, i)
            stop.set()
        except BaseException as e:  # noqa: BLE001 — capture anything
            errors.append(e)
            stop.set()

    def reader() -> None:
        try:
            while not stop.is_set():
                cache_db.get_tracks(folder)
                cache_db.get_stats(folder)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    readers = [threading.Thread(target=reader) for _ in range(8)]
    w = threading.Thread(target=writer)
    for r in readers:
        r.start()
    w.start()

    # Cap on wall-clock so a regression can't hang CI.
    deadline = time.time() + 15.0
    while not stop.is_set() and time.time() < deadline:
        time.sleep(0.05)
    stop.set()

    w.join(timeout=2.0)
    for r in readers:
        r.join(timeout=2.0)

    assert not errors, f"errors under concurrent access: {errors[:3]}"

    # Final row count matches what the writer claimed to produce.
    rows = cache_db.get_tracks(folder)
    assert len(rows) == writes
