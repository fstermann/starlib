"""Folder tree endpoint includes empty directories.

``GET /api/metadata/folders/tree`` builds the tree from indexed tracks *and*
on-disk directories, so folders without any tracks still appear (with a
``track_count`` of 0). Hidden (dot-prefixed) directories are skipped.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.core.db import engine as db_engine
from backend.core.services import cache_db


@pytest.fixture(autouse=True)
def _reset_engine():
    yield
    if db_engine._engine is not None:  # type: ignore[attr-defined]
        db_engine._engine.dispose()  # type: ignore[attr-defined]
    db_engine._engine = None  # type: ignore[attr-defined]
    db_engine._engine_path = None  # type: ignore[attr-defined]


def _add(folder: Path, name: str) -> None:
    cache_db.upsert_track(
        file_path=folder / name,
        folder=folder,
        title=name,
        artist_str="Artist",
        genre="House",
        key=None,
        bpm=124,
        release_date=None,
        has_artwork=False,
        file_size=1,
        file_format=".mp3",
        duration=None,
        is_complete=False,
        missing_fields=[],
        mtime=1.0,
    )


def test_tree_includes_empty_folders(client: TestClient, tmp_music_folder: Path) -> None:
    root = tmp_music_folder.resolve()
    cache_db.init_db(root / "cache.db")

    # "collection" gets a track; "prepare" and "cleaned" stay empty, and an
    # empty nested folder plus a hidden folder are created on disk only.
    _add(root / "collection", "a.mp3")
    (root / "prepare" / "nested").mkdir()
    (root / ".hidden").mkdir()

    resp = client.get("/api/metadata/folders/tree")
    assert resp.status_code == 200
    data = resp.json()

    children = {c["name"]: c for c in data["children"]}
    assert set(children) == {"prepare", "collection", "cleaned"}

    assert children["collection"]["track_count"] == 1
    assert children["prepare"]["track_count"] == 0
    assert children["cleaned"]["track_count"] == 0

    # Empty folders nest too.
    nested = {c["name"]: c for c in children["prepare"]["children"]}
    assert set(nested) == {"nested"}
    assert nested["nested"]["track_count"] == 0
