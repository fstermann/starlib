"""Tests for the SoundCloud BPM persistence + client-token endpoints."""

from __future__ import annotations

from types import SimpleNamespace
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


def test_save_soundcloud_bpm_rounds_and_persists(client: TestClient) -> None:
    with patch("backend.api.bpm.cache_db.upsert_sc_bpm") as mock:
        resp = client.post(
            "/api/bpm/soundcloud",
            json={"track_id": 12345, "bpm": 128.4},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"track_id": 12345, "bpm": 128}
    mock.assert_called_once()
    kwargs = mock.call_args.kwargs
    assert kwargs["track_id"] == 12345
    assert kwargs["bpm"] == 128
    assert kwargs["analyzed_at"] > 0


def test_save_rejects_non_positive_bpm(client: TestClient) -> None:
    resp = client.post("/api/bpm/soundcloud", json={"track_id": 1, "bpm": 0})
    assert resp.status_code == 422


def test_get_soundcloud_bpm_returns_cached(client: TestClient) -> None:
    with patch(
        "backend.api.bpm.cache_db.get_sc_bpm",
        return_value={"track_id": 42, "bpm": 128, "analyzed_at": 0.0},
    ):
        resp = client.get("/api/bpm/soundcloud/42")
    assert resp.status_code == 200
    assert resp.json()["bpm"] == 128


def test_get_soundcloud_bpm_404_when_missing(client: TestClient) -> None:
    with patch("backend.api.bpm.cache_db.get_sc_bpm", return_value=None):
        resp = client.get("/api/bpm/soundcloud/999")
    assert resp.status_code == 404


def test_bulk_lookup_returns_hits(client: TestClient) -> None:
    with patch("backend.api.bpm.cache_db.get_sc_bpms", return_value={1: 128, 2: 140}):
        resp = client.post("/api/bpm/soundcloud/bulk", json={"track_ids": [1, 2, 3]})
    assert resp.status_code == 200
    assert resp.json() == {"bpms": {"1": 128, "2": 140}}


def test_client_token_endpoint(client: TestClient) -> None:
    settings = SimpleNamespace(client_id="cid", client_secret="secret", has_oauth_credentials=lambda: True)
    with (
        patch("backend.api.bpm.get_settings", return_value=settings),
        patch("backend.api.bpm.OAuthManager.get_access_token", return_value="faketoken"),
    ):
        resp = client.get("/api/bpm/soundcloud-client-token")
    assert resp.status_code == 200
    assert resp.json() == {"token": "faketoken"}


def test_client_token_without_credentials_returns_503(client: TestClient) -> None:
    settings = SimpleNamespace(client_id="", client_secret="", has_oauth_credentials=lambda: False)
    with patch("backend.api.bpm.get_settings", return_value=settings):
        resp = client.get("/api/bpm/soundcloud-client-token")
    assert resp.status_code == 503
