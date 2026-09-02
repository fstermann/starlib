"""Tests for SoundCloud image proxy endpoint."""

from unittest.mock import patch

import httpx
from starlette.testclient import TestClient

from backend.api.metadata.proxy import _ALLOWED_SC_HOSTS


class TestProxyImage:
    """Tests for the /proxy-image endpoint."""

    def test_allowed_host_succeeds(self, client: TestClient) -> None:
        """Request to allowed SoundCloud CDN host succeeds."""
        fake_response = httpx.Response(
            200,
            content=b"\x89PNG",
            headers={"content-type": "image/png"},
            request=httpx.Request("GET", "https://i1.sndcdn.com/img.png"),
        )
        with patch("backend.api.metadata.proxy.httpx.get", return_value=fake_response):
            resp = client.get("/api/metadata/proxy-image", params={"url": "https://i1.sndcdn.com/img.png"})
        assert resp.status_code == 200
        assert resp.content == b"\x89PNG"

    def test_disallowed_host_rejected(self, client: TestClient) -> None:
        """Request to non-SoundCloud host is rejected with 400."""
        resp = client.get("/api/metadata/proxy-image", params={"url": "https://evil.com/img.png"})
        assert resp.status_code == 400

    def test_http_scheme_rejected(self, client: TestClient) -> None:
        """Non-https URL is rejected with 400."""
        resp = client.get("/api/metadata/proxy-image", params={"url": "http://i1.sndcdn.com/img.png"})
        assert resp.status_code == 400

    def test_all_allowed_hosts(self) -> None:
        """Verify the expected CDN hosts are in the allow-list."""
        expected = {"i1.sndcdn.com", "i2.sndcdn.com", "i3.sndcdn.com", "i4.sndcdn.com"}
        assert _ALLOWED_SC_HOSTS == expected

    def test_upstream_failure_returns_502(self, client: TestClient) -> None:
        """Upstream fetch failure returns 502."""
        with patch("backend.api.metadata.proxy.httpx.get", side_effect=httpx.ConnectError("fail")):
            resp = client.get("/api/metadata/proxy-image", params={"url": "https://i1.sndcdn.com/img.png"})
        assert resp.status_code == 502
