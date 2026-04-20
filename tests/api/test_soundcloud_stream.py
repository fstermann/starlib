"""Tests for the SoundCloud HLS stream-URL endpoint.

Covers:
- Successful fetch returns `url` + `expires_at` from the upstream `/streams` payload.
- Second call within TTL is served from the in-memory cache (upstream hit once).
- Expired cache entries trigger a refetch.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import soundcloud as soundcloud_api


def _mock_response(status_code: int = 200, json_data: dict | None = None, headers: dict | None = None):
    """Build a lightweight stand-in for `requests.Response`."""

    return SimpleNamespace(
        status_code=status_code,
        headers=headers or {},
        json=lambda: json_data or {},
    )


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(soundcloud_api.router)
    return test_app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_cache():
    soundcloud_api._reset_cache_for_tests()
    yield
    soundcloud_api._reset_cache_for_tests()


def test_returns_stream_url_and_expiry(client: TestClient) -> None:
    """Happy path: endpoint returns the HLS URL + ISO expiry."""

    expires_epoch = int(time.time()) + 1800  # 30 min in the future
    signed_cdn = f"https://playback.media-streaming.soundcloud.cloud/test.m3u8?expires={expires_epoch}&sig=abc"

    async def fake_make_request(method, url, **kwargs):
        if url.endswith("/streams"):
            return _mock_response(
                status_code=200,
                json_data={"hls_aac_160_url": "https://api.soundcloud.com/streams/redirect"},
            )
        # Redirect hop
        return _mock_response(status_code=302, headers={"Location": signed_cdn})

    with patch.object(soundcloud_api.Client, "make_request", new=AsyncMock(side_effect=fake_make_request)):
        resp = client.get("/api/soundcloud/tracks/12345/stream")

    assert resp.status_code == 200
    body = resp.json()
    assert body["url"] == signed_cdn
    assert "expires_at" in body
    assert "T" in body["expires_at"]  # ISO-8601


def test_cache_hit_skips_upstream_call(client: TestClient) -> None:
    """Second request within TTL must not re-hit the upstream API."""

    signed_cdn = f"https://playback.media-streaming.soundcloud.cloud/test.m3u8?expires={int(time.time()) + 1800}"

    async def fake_make_request(method, url, **kwargs):
        if url.endswith("/streams"):
            return _mock_response(
                status_code=200,
                json_data={"hls_aac_160_url": "https://api.soundcloud.com/streams/redirect"},
            )
        return _mock_response(status_code=302, headers={"Location": signed_cdn})

    mock = AsyncMock(side_effect=fake_make_request)
    with patch.object(soundcloud_api.Client, "make_request", new=mock):
        r1 = client.get("/api/soundcloud/tracks/42/stream")
        r2 = client.get("/api/soundcloud/tracks/42/stream")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json() == r2.json()
    # Only the first call should have gone upstream. The stub issues one
    # `/streams` call + one redirect hop per fetch, so exactly 2 total.
    assert mock.call_count == 2


def test_cache_expiry_triggers_refetch(client: TestClient) -> None:
    """When the cached entry is stale, the next call refetches upstream."""

    signed_cdn_1 = f"https://cdn.example/first.m3u8?expires={int(time.time()) + 1800}"
    signed_cdn_2 = f"https://cdn.example/second.m3u8?expires={int(time.time()) + 3600}"

    call_state = {"n": 0}

    async def fake_make_request(method, url, **kwargs):
        if url.endswith("/streams"):
            return _mock_response(
                status_code=200,
                json_data={"hls_aac_160_url": "https://api.soundcloud.com/streams/redirect"},
            )
        call_state["n"] += 1
        loc = signed_cdn_1 if call_state["n"] == 1 else signed_cdn_2
        return _mock_response(status_code=302, headers={"Location": loc})

    with patch.object(soundcloud_api.Client, "make_request", new=AsyncMock(side_effect=fake_make_request)):
        r1 = client.get("/api/soundcloud/tracks/99/stream")
        assert r1.json()["url"] == signed_cdn_1

        # Force-expire the cached entry.
        soundcloud_api._cache[99].expires_at = time.time() - 1

        r2 = client.get("/api/soundcloud/tracks/99/stream")
        assert r2.json()["url"] == signed_cdn_2


def test_missing_hls_variant_returns_404(client: TestClient) -> None:
    """Upstream without any HLS URL should surface a 404."""

    async def fake_make_request(method, url, **kwargs):
        return _mock_response(status_code=200, json_data={"preview_url": "nope"})

    with patch.object(soundcloud_api.Client, "make_request", new=AsyncMock(side_effect=fake_make_request)):
        resp = client.get("/api/soundcloud/tracks/7/stream")

    assert resp.status_code == 404
