"""Tests for health endpoint."""

from starlette.testclient import TestClient


def test_health(client: TestClient) -> None:
    """Health endpoint returns 200 with status ok."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
