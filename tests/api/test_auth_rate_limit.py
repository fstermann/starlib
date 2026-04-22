"""Tests for the /auth/soundcloud/result rate limiter."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import auth as auth_api


@pytest.fixture(autouse=True)
def _reset_limiter():
    auth_api._reset_rate_limiter_for_tests()
    yield
    auth_api._reset_rate_limiter_for_tests()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(auth_api.router)
    return TestClient(app)


def test_rate_limit_triggers_429(client: TestClient) -> None:
    """After 10 requests in the window, the 11th returns 429."""
    # First 10 requests either 404 (state not found) or 200; none should 429.
    for _ in range(auth_api._RATE_LIMIT_MAX_REQUESTS):
        resp = client.get("/auth/soundcloud/result?state=abc")
        assert resp.status_code != 429

    resp = client.get("/auth/soundcloud/result?state=abc")
    assert resp.status_code == 429
