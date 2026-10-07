"""Tests for the system-playlist (Mixes) tracks endpoint.

The mix's track ids come from api-v2; the full Track payloads come from the
public API, because api-v2 omits ``bpm``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.soundcloud import api_v2, public_api
from backend.api.soundcloud import system_playlists as sp_api
from backend.infra.soundcloud import client as sc_client

_URN = "soundcloud:system-playlists:weekly:1"
_PUBLIC_TRACKS = f"{sc_client.PUBLIC_API_BASE}/tracks"


class _Resp:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class _RoutingAsyncClient:
    """Async client stub that returns a payload per api-v2 path, or per full public-API URL."""

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
    app.include_router(sp_api.router)
    return TestClient(app)


def test_mix_tracks_come_from_public_api_in_mix_order(client: TestClient) -> None:
    routes = {
        f"/system-playlists/{_URN}": _Resp(200, {"tracks": [{"id": 30}, {"id": 10}, {"id": 20}]}),
        _PUBLIC_TRACKS: _Resp(200, [{"id": i, "bpm": 120 + i} for i in (10, 20, 30)]),
    }
    calls: list = []
    with (
        patch.object(api_v2, "get_settings", lambda: SimpleNamespace(oauth_token="session")),
        patch.object(public_api, "public_api_token", lambda: "app"),
        patch.object(sc_client.httpx, "AsyncClient", lambda *a, **k: _RoutingAsyncClient(routes, calls)),
    ):
        resp = client.get(f"/api/soundcloud/system-playlists/{_URN}/tracks")

    assert resp.status_code == 200
    assert [(t["id"], t["bpm"]) for t in resp.json()["tracks"]] == [(30, 150), (10, 130), (20, 140)]
    hydrate_url, hydrate_params = calls[-1]
    assert hydrate_url == _PUBLIC_TRACKS
    assert hydrate_params["urns"] == "soundcloud:tracks:30,soundcloud:tracks:10,soundcloud:tracks:20"
