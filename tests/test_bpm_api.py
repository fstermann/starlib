"""Tests for the local-file BPM persistence endpoint."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.bpm import router as bpm_router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(bpm_router)
    return TestClient(app)


def _payload(file_path: str = "/music/track.mp3", bpm: float = 128.4, algo: int = 1) -> dict:
    return {"file_path": file_path, "bpm": bpm, "algorithm_version": algo}


def test_rounds_bpm_and_persists(client: TestClient) -> None:
    """Happy path: float BPM is rounded and handed to cache_db."""

    with patch("backend.api.bpm.cache_db.update_track_bpm", return_value=True) as mock:
        resp = client.post("/api/bpm/local", json=_payload(bpm=128.4))

    assert resp.status_code == 200
    body = resp.json()
    assert body["bpm"] == 128
    assert body["algorithm_version"] == 1
    mock.assert_called_once()
    called_path, called_bpm = mock.call_args.args
    assert called_path == Path("/music/track.mp3")
    assert called_bpm == 128


def test_rounds_half_up(client: TestClient) -> None:
    """128.6 → 129, not 128."""
    with patch("backend.api.bpm.cache_db.update_track_bpm", return_value=True):
        resp = client.post("/api/bpm/local", json=_payload(bpm=128.6))
    assert resp.json()["bpm"] == 129


def test_unknown_track_returns_404(client: TestClient) -> None:
    """update_track_bpm returning False (no row updated) surfaces as 404."""

    with patch("backend.api.bpm.cache_db.update_track_bpm", return_value=False):
        resp = client.post("/api/bpm/local", json=_payload())

    assert resp.status_code == 404
    assert "track" in resp.json()["detail"].lower()


def test_rejects_non_positive_bpm(client: TestClient) -> None:
    """Pydantic validation rejects BPM <= 0 before it reaches the handler."""
    resp = client.post("/api/bpm/local", json=_payload(bpm=0))
    assert resp.status_code == 422

    resp = client.post("/api/bpm/local", json=_payload(bpm=-1))
    assert resp.status_code == 422
