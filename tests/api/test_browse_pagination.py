"""Paged browse endpoints.

Paging is resolved in SQL now, so these pin the contract the frontend's
infinite scroll relies on: ``total`` is the filter total (not the page size),
each page holds ``size`` rows, and scrolling through every page yields each
track exactly once.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.infra import cache
from backend.infra.db import engine as db_engine


@pytest.fixture(autouse=True)
def _reset_engine():
    yield
    if db_engine._engine is not None:  # type: ignore[attr-defined]
        db_engine._engine.dispose()  # type: ignore[attr-defined]
    db_engine._engine = None  # type: ignore[attr-defined]
    db_engine._engine_path = None  # type: ignore[attr-defined]


def _add(folder: Path, name: str, *, genre: str = "House") -> None:
    cache.upsert_track(
        file_path=folder / name,
        folder=folder,
        title=name,
        artist_str="Artist",
        genre=genre,
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


@pytest.fixture
def seeded(tmp_music_folder: Path) -> Path:
    root = tmp_music_folder.resolve()
    cache.init_db(root / "cache.db")
    collection = root / "collection"
    for i in range(25):
        _add(collection, f"track_{i:02d}.mp3")
    return collection


def test_browse_path_reports_the_filter_total_not_the_page_size(client: TestClient, seeded: Path) -> None:
    resp = client.get(
        "/api/metadata/folders/browse-path",
        params={"path": str(seeded), "page": 1, "size": 10},
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["total"] == 25
    assert len(data["items"]) == 10


def test_browse_path_pages_cover_every_track_once(client: TestClient, seeded: Path) -> None:
    seen: list[str] = []
    for page in (1, 2, 3):
        resp = client.get(
            "/api/metadata/folders/browse-path",
            params={"path": str(seeded), "page": page, "size": 10},
        )
        assert resp.status_code == 200
        seen += [item["file_path"] for item in resp.json()["items"]]

    assert len(seen) == 25
    assert len(set(seen)) == 25, "a track appeared on more than one page"


def test_browse_path_last_page_is_partial(client: TestClient, seeded: Path) -> None:
    resp = client.get(
        "/api/metadata/folders/browse-path",
        params={"path": str(seeded), "page": 3, "size": 10},
    )
    assert len(resp.json()["items"]) == 5


def test_browse_path_total_respects_filters(client: TestClient, seeded: Path) -> None:
    _add(seeded, "techno.mp3", genre="Techno")

    resp = client.get(
        "/api/metadata/folders/browse-path",
        params={"path": str(seeded), "genres": ["Techno"], "page": 1, "size": 10},
    )
    data = resp.json()
    assert data["total"] == 1
    assert [item["genre"] for item in data["items"]] == ["Techno"]


def test_browse_mode_endpoint_pages_too(client: TestClient, seeded: Path) -> None:
    resp = client.get(
        "/api/metadata/folders/collection/browse",
        params={"page": 1, "size": 10},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 25
    assert len(data["items"]) == 10


def test_sorting_still_applies_across_pages(client: TestClient, seeded: Path) -> None:
    """Sort order must hold globally, not just within a page."""
    all_titles: list[str] = []
    for page in (1, 2, 3):
        resp = client.get(
            "/api/metadata/folders/browse-path",
            params={
                "path": str(seeded),
                "page": page,
                "size": 10,
                "sort_by": "title",
                "sort_order": "desc",
            },
        )
        all_titles += [item["title"] for item in resp.json()["items"]]

    assert all_titles == sorted(all_titles, reverse=True)
