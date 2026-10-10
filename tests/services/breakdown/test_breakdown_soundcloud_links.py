"""Tests for linking Shazam-recognised tracks to their SoundCloud upload."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.breakdown import router as breakdown_router
from backend.infra.breakdown import db as breakdown_db
from backend.infra.db import engine as db_engine
from backend.infra.db.migrations import run_migrations
from backend.services.breakdown import controller as breakdown_controller
from backend.services.breakdown import soundcloud_links


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path) -> Iterator[Path]:
    db_path = tmp_path / "breakdown.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    breakdown_controller._jobs.clear()
    yield db_path
    engine.dispose()


def _seed() -> None:
    breakdown_db.insert_job(
        job_id="job-1",
        soundcloud_id=42,
        source_url=None,
        title="Set",
        artist="DJ",
        duration_s=3600.0,
        options={},
    )


def _shazam_track(title: str, artist: str, **extra) -> breakdown_db.TrackRow:
    return breakdown_db.insert_track(
        job_id="job-1", origin="shazam", start_s=0.0, title=title, artist=artist, shazam_id=title, **extra
    )


SEARCH_RESULTS = {
    "invasion entasia": [
        {
            "id": 777,
            "title": "Entasia - Invasion",
            "user": {"username": "Entasia"},
            "duration": 412_000,
            "permalink_url": "https://soundcloud.com/entasia/invasion",
            "artwork_url": "https://i1.sndcdn.com/a.jpg",
        }
    ],
}


def _patched(queries: list[str]):
    async def fake_search(query: str, *, token: str, limit: int = 10) -> list[dict]:
        queries.append(query)
        return SEARCH_RESULTS.get(query, [])

    return (
        patch.object(soundcloud_links.client, "search_tracks", fake_search),
        patch.object(soundcloud_links, "_token", lambda: "tok"),
    )


def test_links_match_and_stores_duration() -> None:
    _seed()
    row = _shazam_track("Invasion", "Entasia")
    a, b = _patched([])
    with a, b:
        linked = asyncio.run(soundcloud_links.link_unlinked_tracks("job-1"))

    assert linked == 1
    after = breakdown_db.list_tracks("job-1")[0]
    assert after.id == row.id
    assert after.soundcloud_id == 777
    assert after.duration_s == 412.0
    assert after.soundcloud_permalink_url == "https://soundcloud.com/entasia/invasion"
    # A link is admin data, not a user edit: later Shazam syncs still apply.
    assert after.user_edited is False


def test_skips_already_linked_and_unmatched_tracks() -> None:
    _seed()
    _shazam_track("Linked", "X", soundcloud_id=1, duration_s=300.0)
    _shazam_track("Nowhere", "Nobody")
    queries: list[str] = []
    a, b = _patched(queries)
    with a, b:
        linked = asyncio.run(soundcloud_links.link_unlinked_tracks("job-1"))

    assert linked == 0
    assert queries == ["nowhere nobody"]
    assert breakdown_db.list_tracks("job-1")[1].soundcloud_id is None


def test_noop_without_credentials() -> None:
    _seed()
    _shazam_track("Invasion", "Entasia")
    with patch.object(soundcloud_links, "_token", lambda: None):
        assert asyncio.run(soundcloud_links.link_unlinked_tracks("job-1")) == 0


def test_route_links_existing_set() -> None:
    _seed()
    _shazam_track("Invasion", "Entasia")
    app = FastAPI()
    app.include_router(breakdown_router)
    a, b = _patched([])
    with a, b:
        resp = TestClient(app).post("/api/breakdown/sets/job-1/tracks/link-soundcloud")

    assert resp.status_code == 200
    assert resp.json() == {"job_id": "job-1", "linked": 1}
    assert breakdown_db.list_tracks("job-1")[0].duration_s == 412.0


def test_skips_unreleased_and_unknown_tracks() -> None:
    _seed()
    _shazam_track("Invasion", "Entasia", unreleased=True)
    breakdown_db.insert_track(job_id="job-1", origin="manual", start_s=10.0, title="ID", artist="Entasia")
    breakdown_db.insert_track(job_id="job-1", origin="manual", start_s=20.0, title="Invasion", artist="ID")
    queries: list[str] = []
    a, b = _patched(queries)
    with a, b:
        assert asyncio.run(soundcloud_links.link_unlinked_tracks("job-1")) == 0
    assert queries == []


def test_link_track_uses_matcher_not_top_hit() -> None:
    _seed()
    row = _shazam_track("Invasion", "Entasia")
    other = _shazam_track("Believe In Me", "Nobody")
    a, b = _patched([])
    with a, b:
        assert asyncio.run(soundcloud_links.link_track("job-1", row.id)) == 777
        assert asyncio.run(soundcloud_links.link_track("job-1", other.id)) is None
    assert breakdown_db.list_tracks("job-1")[0].soundcloud_id == 777


def test_link_track_keeps_existing_link() -> None:
    _seed()
    row = _shazam_track("Linked", "X", soundcloud_id=5)
    queries: list[str] = []
    a, b = _patched(queries)
    with a, b:
        resp = TestClient(_app()).post(f"/api/breakdown/sets/job-1/tracks/{row.id}/link-soundcloud")
    assert resp.json() == {"soundcloud_id": 5}
    assert queries == []


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(breakdown_router)
    return app


def test_link_track_keeps_a_known_duration() -> None:
    _seed()
    row = _shazam_track("Invasion", "Entasia", duration_s=300.0)
    a, b = _patched([])
    with a, b:
        assert asyncio.run(soundcloud_links.link_track("job-1", row.id)) == 777
    assert breakdown_db.list_tracks("job-1")[0].duration_s == 300.0
