"""Tests for the SoundCloud playlist-delete proxy endpoint.

The browser can't DELETE a playlist directly (SoundCloud blocks the method in
its CORS policy), so the backend forwards the request with the user's token.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import soundcloud as soundcloud_api


class _MockAsyncClient:
    """Minimal async-context-manager stand-in for httpx.AsyncClient."""

    def __init__(self, resp, recorder: list):
        self._resp = resp
        self._recorder = recorder

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def request(self, method, url, headers=None):
        self._recorder.append((method, url, headers))
        return self._resp


def _resp(status_code: int):
    return SimpleNamespace(
        status_code=status_code,
        is_success=200 <= status_code < 300,
    )


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(soundcloud_api.router)
    return TestClient(app)


def test_delete_playlist_forwards_to_soundcloud(client: TestClient) -> None:
    calls: list = []
    with patch.object(
        soundcloud_api.httpx,
        "AsyncClient",
        lambda *a, **k: _MockAsyncClient(_resp(200), calls),
    ):
        resp = client.delete(
            "/api/soundcloud/playlists/100",
            headers={"Authorization": "Bearer tok"},
        )

    assert resp.status_code == 204
    assert len(calls) == 1
    method, url, headers = calls[0]
    assert method == "DELETE"
    assert url == "https://api.soundcloud.com/playlists/soundcloud:playlists:100"
    assert headers["Authorization"] == "OAuth tok"


def test_delete_playlist_requires_auth(client: TestClient) -> None:
    resp = client.delete("/api/soundcloud/playlists/100")
    assert resp.status_code == 401


def test_delete_playlist_propagates_upstream_failure(client: TestClient) -> None:
    with patch.object(
        soundcloud_api.httpx,
        "AsyncClient",
        lambda *a, **k: _MockAsyncClient(_resp(404), []),
    ):
        resp = client.delete(
            "/api/soundcloud/playlists/100",
            headers={"Authorization": "Bearer tok"},
        )
    assert resp.status_code == 502
