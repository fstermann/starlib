"""Tests for the SoundCloud track-station proxy endpoint.

The backend proxies the public API's ``/tracks/{track_urn}/related`` feed with
a Client-Credentials token and returns the full Track payloads in SoundCloud's
order.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

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
        self._recorder.append((method, url, params, headers))
        for key, resp in self._routes.items():
            if key in url:
                return resp
        return _Resp(404, {})


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(stations_api.router)
    return TestClient(app)


def _with_credentials():
    return patch.object(
        stations_api,
        "get_settings",
        lambda: SimpleNamespace(
            client_id="cid",
            client_secret="secret",
            has_oauth_credentials=lambda: True,
        ),
    )


def _with_token():
    return patch.object(stations_api.token_cache, "get_cached_access_token", return_value="public-token")


def test_station_returns_related_tracks_in_order(client: TestClient) -> None:
    routes = {
        "/tracks/soundcloud:tracks:123/related": _Resp(
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
        _with_credentials(),
        _with_token(),
        patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, calls)),
    ):
        resp = client.get("/api/soundcloud/stations/123/tracks")

    assert resp.status_code == 200
    body = resp.json()
    # SoundCloud's related-track order is preserved.
    assert [t["id"] for t in body["tracks"]] == [30, 10, 20]
    method, url, params, headers = calls[0]
    assert method == "GET"
    assert url == "https://api.soundcloud.com/tracks/soundcloud:tracks:123/related"
    assert params == {"limit": 50, "linked_partitioning": True}
    assert headers["Authorization"] == "OAuth public-token"


def test_station_502_without_oauth_credentials(client: TestClient) -> None:
    settings = SimpleNamespace(has_oauth_credentials=lambda: False)
    with patch.object(stations_api, "get_settings", return_value=settings):
        resp = client.get("/api/soundcloud/stations/123/tracks")
    assert resp.status_code == 502


def test_station_empty_when_no_tracks(client: TestClient) -> None:
    routes = {
        "/tracks/soundcloud:tracks:123/related": _Resp(
            200,
            {"collection": [], "next_href": None},
        ),
    }
    with (
        _with_credentials(),
        _with_token(),
        patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, [])),
    ):
        resp = client.get("/api/soundcloud/stations/123/tracks")
    assert resp.status_code == 200
    assert resp.json() == {"title": None, "tracks": []}


def test_station_502_on_upstream_error(client: TestClient) -> None:
    routes = {"/tracks/soundcloud:tracks:123/related": _Resp(500, {})}
    with (
        _with_credentials(),
        _with_token(),
        patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, [])),
    ):
        resp = client.get("/api/soundcloud/stations/123/tracks")
    assert resp.status_code == 502
