"""SQL-level paging for the browse endpoints.

``get_tracks`` used to return the whole folder and let the API layer slice it
in Python, so every page request materialised the full row set.  These tests
pin the paged behaviour: the slice happens in SQL, the count matches the same
filters, and paging through a folder yields every row exactly once.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.infra import cache
from backend.infra.db import engine as db_engine


@pytest.fixture(autouse=True)
def _reset_engine():
    yield
    if db_engine._engine is not None:  # type: ignore[attr-defined]
        db_engine._engine.dispose()  # type: ignore[attr-defined]
    db_engine._engine = None  # type: ignore[attr-defined]
    db_engine._engine_path = None  # type: ignore[attr-defined]


def _add(folder: Path, name: str, *, genre: str = "House", bpm: int | None = 120) -> None:
    cache.upsert_track(
        file_path=folder / name,
        folder=folder,
        title=name,
        artist_str="Artist",
        genre=genre,
        key=None,
        bpm=bpm,
        release_date=None,
        has_artwork=False,
        file_size=1,
        file_format=".mp3",
        duration=None,
        is_complete=False,
        missing_fields=[],
        mtime=1.0,
    )


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    cache.init_db(tmp_path / "cache.db")
    music = tmp_path / "music"
    music.mkdir()
    for i in range(25):
        _add(music, f"track_{i:02d}.mp3")
    return music


def test_limit_and_offset_slice_in_sql(folder: Path) -> None:
    page1 = cache.get_tracks(folder, limit=10, offset=0)
    page2 = cache.get_tracks(folder, limit=10, offset=10)
    page3 = cache.get_tracks(folder, limit=10, offset=20)

    assert [len(p) for p in (page1, page2, page3)] == [10, 10, 5]


def test_paging_covers_every_row_exactly_once(folder: Path) -> None:
    seen: list[str] = []
    for offset in range(0, 25, 10):
        seen += [r["file_path"] for r in cache.get_tracks(folder, limit=10, offset=offset)]

    all_rows = [r["file_path"] for r in cache.get_tracks(folder)]
    assert len(seen) == 25
    assert len(set(seen)) == 25, "a row appeared on two pages"
    assert sorted(seen) == sorted(all_rows)


def test_ordering_is_total_so_pages_are_stable(folder: Path) -> None:
    """Rows tying on the sort column must not swap between page requests."""
    # Every row here has the same bpm, so bpm alone cannot order them.
    first = [r["file_path"] for r in cache.get_tracks(folder, sort_by="bpm", limit=10, offset=0)]
    again = [r["file_path"] for r in cache.get_tracks(folder, sort_by="bpm", limit=10, offset=0)]
    assert first == again

    second = [r["file_path"] for r in cache.get_tracks(folder, sort_by="bpm", limit=10, offset=10)]
    assert not set(first) & set(second)


def test_count_matches_filters(folder: Path) -> None:
    _add(folder, "techno_a.mp3", genre="Techno")
    _add(folder, "techno_b.mp3", genre="Techno")

    assert cache.count_tracks(folder) == 27
    assert cache.count_tracks(folder, genres=["Techno"]) == 2

    # The count must agree with what an unpaged fetch under the same filters returns.
    rows = cache.get_tracks(folder, genres=["Techno"])
    assert cache.count_tracks(folder, genres=["Techno"]) == len(rows)


def test_count_is_independent_of_the_page_slice(folder: Path) -> None:
    """The total reported to the client is the filter total, not the page size."""
    page = cache.get_tracks(folder, limit=10, offset=0)
    assert len(page) == 10
    assert cache.count_tracks(folder) == 25


def test_no_limit_returns_everything(folder: Path) -> None:
    assert len(cache.get_tracks(folder)) == 25
