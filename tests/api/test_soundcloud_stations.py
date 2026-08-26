"""Tests for the SoundCloud track-station proxy endpoint.

Track stations live only on the internal ``api-v2.soundcloud.com`` and need
the web-session cookie; the backend proxies the seed track's ``/related``
feed and returns the full Track payloads in api-v2's order.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.soundcloud import api_v2
from backend.api.soundcloud import stations as stations_api
from backend.infra.soundcloud import client as sc_client


class _Resp:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class _RoutingAsyncClient:
    """Async-context-manager stub that returns a payload per requested URL."""

    is_closed = False

    def __init__(self, routes: dict[str, _Resp], recorder: list):
        self._routes = routes
        self._recorder = recorder

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def request(self, method, url, params=None, headers=None, follow_redirects=False):
        self._recorder.append((method, url, params))
        for key, resp in self._routes.items():
            if key in url:
                return resp
        return _Resp(404, {})


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(stations_api.router)
    return TestClient(app)


def _with_token():
    return patch.object(api_v2, "get_settings", lambda: SimpleNamespace(oauth_token="tok"))


def test_station_returns_related_tracks_in_order(client: TestClient) -> None:
    routes = {
        "/tracks/123/related": _Resp(
            200,
            {
                "collection": [
                    {"id": 30, "title": "Thirty"},
                    {"id": 10, "title": "Ten"},
                    {"id": 20, "title": "Twenty"},
                ],
                "next_href": None,
            },
        ),
    }
    calls: list = []
    with (
        _with_token(),
        patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, calls)),
    ):
        resp = client.get("/api/soundcloud/stations/123/tracks")

    assert resp.status_code == 200
    body = resp.json()
    # api-v2 order preserved.
    assert [t["id"] for t in body["tracks"]] == [30, 10, 20]
    # api-v2 call targets the related-tracks feed for the seed id.
    assert "/tracks/123/related" in calls[0][1]


def test_station_404_without_session_cookie(client: TestClient) -> None:
    with patch.object(api_v2, "get_settings", lambda: SimpleNamespace(oauth_token=None)):
        resp = client.get("/api/soundcloud/stations/123/tracks")
    assert resp.status_code == 404


def test_station_empty_when_no_tracks(client: TestClient) -> None:
    routes = {
        "/tracks/123/related": _Resp(200, {"collection": [], "next_href": None}),
    }
    with _with_token(), patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, [])):
        resp = client.get("/api/soundcloud/stations/123/tracks")
    assert resp.status_code == 200
    assert resp.json() == {"title": None, "tracks": []}


def test_station_502_on_upstream_error(client: TestClient) -> None:
    routes = {"/tracks/123/related": _Resp(500, {})}
    with _with_token(), patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, [])):
        resp = client.get("/api/soundcloud/stations/123/tracks")
    assert resp.status_code == 502
