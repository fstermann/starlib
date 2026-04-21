"""Unit tests for the shared SoundCloud OAuth token TTL cache."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend.core.services import sc_auth_cache


@pytest.fixture(autouse=True)
def _reset():
    sc_auth_cache.reset_cache()
    yield
    sc_auth_cache.reset_cache()


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        client_id="cid",
        client_secret="secret",
        has_oauth_credentials=lambda: True,
    )


def test_token_reused_within_ttl() -> None:
    """Two calls within the TTL hit OAuthManager exactly once."""
    manager_instance = MagicMock()
    manager_instance.get_access_token.return_value = "tok-1"
    manager_cls = MagicMock(return_value=manager_instance)

    t1 = sc_auth_cache.get_cached_access_token(_settings(), manager_cls)
    t2 = sc_auth_cache.get_cached_access_token(_settings(), manager_cls)

    assert t1 == t2 == "tok-1"
    assert manager_cls.call_count == 1
    assert manager_instance.get_access_token.call_count == 1


def test_token_refreshed_after_ttl_expiry() -> None:
    """Expiring the cache forces a fresh token fetch."""
    manager_instance = MagicMock()
    manager_instance.get_access_token.side_effect = ["tok-1", "tok-2"]
    manager_cls = MagicMock(return_value=manager_instance)

    t1 = sc_auth_cache.get_cached_access_token(_settings(), manager_cls, ttl_seconds=60)
    assert t1 == "tok-1"

    # Force the cached entry into "needs-refresh" territory.
    sc_auth_cache._expires_at = 0.0  # type: ignore[assignment]

    t2 = sc_auth_cache.get_cached_access_token(_settings(), manager_cls, ttl_seconds=60)
    assert t2 == "tok-2"
    assert manager_instance.get_access_token.call_count == 2


def test_raises_without_credentials() -> None:
    """Missing credentials surface as RuntimeError (caller converts to 502)."""
    settings = SimpleNamespace(
        client_id="",
        client_secret="",
        has_oauth_credentials=lambda: False,
    )
    with pytest.raises(RuntimeError):
        sc_auth_cache.get_cached_access_token(settings, MagicMock())
