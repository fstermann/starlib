"""Tests for the SoundCloud beatgrid analysis and full-audio endpoints.

The analyser binary and the audio download are mocked; the cache DB is real
(a temp SQLite file) so the analyse-once behaviour is exercised end to end.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.soundcloud import tracks as soundcloud_api
from backend.infra import cache as db_cache
from backend.infra.breakdown import cache as audio_cache
from backend.infra.breakdown import grid as grid_infra
from backend.services.breakdown import original_bpm

GRID = {
    "bpm": 143.998,
    "confidence": 0.88,
    "beats": [{"time_s": 0.1234, "beat": 4}, {"time_s": 0.54, "beat": 1}],
    "phrases": [{"kind": "intro", "label": "Intro", "start_s": 0.54, "end_s": 27.2}],
}


@pytest.fixture(autouse=True)
def _db(tmp_path: Path) -> Iterator[None]:
    db_cache.init_db(tmp_path / "cache.db")
    with (
        patch.object(original_bpm, "listed_bpm", new=AsyncMock(return_value=145.0)),
        patch.object(db_cache, "get_sc_bpm_override", return_value=None),
    ):
        yield


@pytest.fixture
def audio(tmp_path: Path) -> Iterator[Path]:
    cached = tmp_path / "42.mp4"
    cached.write_bytes(b"fake-audio")
    with patch.object(audio_cache, "cached_set_path", return_value=cached):
        yield cached


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(soundcloud_api.router)
    return TestClient(app)


def test_analyses_once_with_the_listed_bpm(client: TestClient, audio: Path) -> None:
    """The first request seeds detection with SoundCloud's BPM; later ones hit the cache."""
    detect = AsyncMock(return_value=dict(GRID))
    with patch.object(grid_infra, "detect_grid", new=detect):
        first = client.get("/api/soundcloud/tracks/42/analysis")
        second = client.get("/api/soundcloud/tracks/42/analysis")

    assert first.status_code == second.status_code == 200
    detect.assert_awaited_once_with(audio, 145.0)
    body = second.json()
    assert body["beatgrid"] == [
        {"beat": 4, "bpm": 143.998, "timeMs": 123},
        {"beat": 1, "bpm": 143.998, "timeMs": 540},
    ]
    assert body["sections"] == [{"kind": "intro", "label": "Intro", "startMs": 540, "endMs": 27200}]
    assert body["cues"] == []


def test_unsteady_grid_returns_no_analysis(client: TestClient, audio: Path) -> None:
    """A low-confidence grid degrades to an empty beatgrid so the mix falls back."""
    shaky = {**GRID, "confidence": 0.3}
    with patch.object(grid_infra, "detect_grid", new=AsyncMock(return_value=shaky)):
        resp = client.get("/api/soundcloud/tracks/42/analysis")

    assert resp.status_code == 200
    assert resp.json() == {"beatgrid": [], "sections": None, "cues": []}


def test_failed_detection_is_not_cached(client: TestClient, audio: Path) -> None:
    """A binary failure returns no grid and retries on the next request."""
    detect = AsyncMock(side_effect=[None, dict(GRID)])
    with patch.object(grid_infra, "detect_grid", new=detect):
        assert client.get("/api/soundcloud/tracks/42/analysis").json()["beatgrid"] == []
        assert len(client.get("/api/soundcloud/tracks/42/analysis").json()["beatgrid"]) == 2


def test_serves_cached_audio(client: TestClient, audio: Path) -> None:
    """The full track is served from the analyser cache for Web Audio decoding."""
    resp = client.get("/api/soundcloud/tracks/42/audio")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/mp4"
    assert resp.content == b"fake-audio"
