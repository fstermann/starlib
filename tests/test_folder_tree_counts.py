"""Filtered per-folder counts backing the tree-view badges (#399).

``get_folder_track_counts`` must return unfiltered direct counts by default and
counts restricted to matching tracks when filter arguments are supplied.
"""

from __future__ import annotations

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


def _add(folder: Path, name: str, *, genre: str, bpm: int) -> None:
    cache_db.upsert_track(
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


def test_folder_counts_unfiltered_and_filtered(tmp_path: Path) -> None:
    cache_db.init_db(tmp_path / "cache.db")
    house = tmp_path / "music" / "house"
    techno = tmp_path / "music" / "techno"
    house.mkdir(parents=True)
    techno.mkdir(parents=True)

    _add(house, "a.mp3", genre="House", bpm=124)
    _add(house, "b.mp3", genre="Techno", bpm=130)
    _add(techno, "c.mp3", genre="Techno", bpm=135)

    # Unfiltered: direct count per folder.
    assert cache_db.get_folder_track_counts() == {
        str(house): 2,
        str(techno): 1,
    }

    # Genre filter narrows counts and drops non-matching folders.
    assert cache_db.get_folder_track_counts(genres=["Techno"]) == {
        str(house): 1,
        str(techno): 1,
    }
    assert cache_db.get_folder_track_counts(genres=["House"]) == {str(house): 1}

    # BPM range filter.
    assert cache_db.get_folder_track_counts(bpm_min=131) == {str(techno): 1}
