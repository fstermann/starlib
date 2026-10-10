"""Tests for choosing which tempo of an original track to trust."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from backend.services.breakdown import original_bpm


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    original_bpm._listed.clear()
    yield
    original_bpm._listed.clear()


def _pick(corrected: float | None, listed: float | None, detected: float | None):
    with (
        patch.object(original_bpm.db_cache, "get_sc_bpm_override", return_value=corrected),
        patch.object(original_bpm, "listed_bpm", AsyncMock(return_value=listed)),
    ):
        return asyncio.run(original_bpm.original_bpm(7, detected))


def test_correction_beats_soundcloud_and_detection() -> None:
    assert _pick(138.4, 140.0, 93.1) == (138.4, "corrected")


def test_soundcloud_beats_detection() -> None:
    assert _pick(None, 140.0, 93.1) == (140.0, "soundcloud")


def test_detection_when_soundcloud_lists_none() -> None:
    assert _pick(None, None, 93.1) == (93.1, "detected")


def test_listed_bpm_is_fetched_once_per_track() -> None:
    fetch = AsyncMock(return_value=140.0)
    with (
        patch.object(original_bpm, "get_settings") as settings,
        patch.object(original_bpm.token_cache, "get_cached_access_token", return_value="t"),
        patch.object(original_bpm.client, "get_track_bpm", fetch),
    ):
        settings.return_value.has_oauth_credentials.return_value = True
        assert asyncio.run(original_bpm.listed_bpm(7)) == 140.0
        assert asyncio.run(original_bpm.listed_bpm(7)) == 140.0
    fetch.assert_awaited_once()


def test_failed_lookup_is_retried() -> None:
    fetch = AsyncMock(side_effect=[httpx.ConnectError("down"), 140.0])
    with (
        patch.object(original_bpm, "get_settings") as settings,
        patch.object(original_bpm.token_cache, "get_cached_access_token", return_value="t"),
        patch.object(original_bpm.client, "get_track_bpm", fetch),
    ):
        settings.return_value.has_oauth_credentials.return_value = True
        assert asyncio.run(original_bpm.listed_bpm(7)) is None
        assert asyncio.run(original_bpm.listed_bpm(7)) == 140.0
