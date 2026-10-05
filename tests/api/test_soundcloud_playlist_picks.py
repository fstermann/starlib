"""Tests for the playlist-picks endpoint.

The backend lists the public playlists containing a seed track via api-v2,
reads each playlist's track ids, and returns the tracks ranked by how many of
those playlists contain them.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.soundcloud import api_v2
from backend.api.soundcloud import playlist_picks as picks_api
from backend.infra.soundcloud import client as sc_client


class _Resp:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class _RoutingAsyncClient:
    """Async client stub that returns a payload per URL path suffix."""

    is_closed = False

    def __init__(self, routes: dict[str, _Resp], recorder: list):
        self._routes = routes
        self._recorder = recorder

    async def request(self, method, url, params=None, headers=None, follow_redirects=False):
        self._recorder.append((url, params))
        path = url.removeprefix(sc_client.API_V2_BASE)
        return self._routes.get(path, _Resp(404, {}))


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(picks_api.router)
    return TestClient(app)


def _patched(routes: dict[str, _Resp], calls: list, token: str | None = "session"):
    settings = SimpleNamespace(oauth_token=token)
    return (
        patch.object(api_v2, "get_settings", lambda: settings),
        patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, calls)),
    )


def _track(track_id: int) -> dict:
    return {"id": track_id, "urn": f"soundcloud:tracks:{track_id}", "title": f"T{track_id}"}


def test_ranks_tracks_by_playlist_occurrence(client: TestClient) -> None:
    routes = {
        "/tracks/42/playlists_without_albums": _Resp(200, {"collection": [{"id": 1}, {"id": 2}, {"id": 3}]}),
        "/playlists/1": _Resp(200, {"tracks": [{"id": 42}, {"id": 10}, {"id": 20}]}),
        "/playlists/2": _Resp(200, {"tracks": [{"id": 42}, {"id": 20}, {"id": 30}]}),
        "/playlists/3": _Resp(200, {"tracks": [{"id": 20}, {"id": 30}]}),
        "/tracks": _Resp(200, [_track(10), _track(20), _track(30)]),
    }
    calls: list = []
    a, b = _patched(routes, calls)
    with a, b:
        resp = client.get("/api/soundcloud/playlist-picks/42")

    assert resp.status_code == 200
    body = resp.json()
    assert body["playlist_count"] == 3
    assert [(p["track"]["id"], p["count"]) for p in body["picks"]] == [(20, 3), (30, 2), (10, 1)]
    listing_url, listing_params = calls[0]
    assert listing_url.endswith("/tracks/42/playlists_without_albums")
    assert listing_params["limit"] == 50


def test_skips_unreadable_playlists(client: TestClient) -> None:
    routes = {
        "/tracks/42/playlists_without_albums": _Resp(200, {"collection": [{"id": 1}, {"id": 2}]}),
        "/playlists/1": _Resp(200, {"tracks": [{"id": 10}]}),
        "/playlists/2": _Resp(403, {}),
        "/tracks": _Resp(200, [_track(10)]),
    }
    a, b = _patched(routes, [])
    with a, b:
        resp = client.get("/api/soundcloud/playlist-picks/42")

    assert resp.status_code == 200
    assert [p["track"]["id"] for p in resp.json()["picks"]] == [10]


def test_empty_when_track_is_in_no_playlists(client: TestClient) -> None:
    routes = {"/tracks/42/playlists_without_albums": _Resp(200, {"collection": []})}
    calls: list = []
    a, b = _patched(routes, calls)
    with a, b:
        resp = client.get("/api/soundcloud/playlist-picks/42")

    assert resp.status_code == 200
    assert resp.json() == {"playlist_count": 0, "picks": []}
    assert len(calls) == 1


def test_404_without_session_token(client: TestClient) -> None:
    a, b = _patched({}, [], token=None)
    with a, b:
        resp = client.get("/api/soundcloud/playlist-picks/42")
    assert resp.status_code == 404
