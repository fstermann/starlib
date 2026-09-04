"""Tests for the SoundCloud high-res peaks endpoint.

Covers the two entry paths (audio already cached vs. resolve + download) and
the decode-failure surface. The ffmpeg decode itself is exercised by the
domain reducer's unit tests; here we mock the infra so the suite runs offline.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.soundcloud import tracks as soundcloud_api
from backend.infra import cache as db_cache
from backend.infra.analyser import cache as audio_cache
from backend.infra.analyser import peaks as peaks_infra


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(soundcloud_api.router)
    return TestClient(app)


def test_returns_peaks_from_cached_audio(client: TestClient, tmp_path: Path) -> None:
    """When the audio is already cached, decode it and return peaks."""
    cached = tmp_path / "42.mp4"
    cached.write_bytes(b"fake")

    with (
        patch.object(audio_cache, "cached_set_path", return_value=cached),
        patch.object(db_cache, "get_sc_bpm_override", return_value=None),
        patch.object(
            peaks_infra,
            "get_or_compute_peaks",
            new=AsyncMock(return_value=([0.0, 0.5, 1.0], 123.4, 128.0)),
        ),
    ):
        resp = client.get("/api/soundcloud/tracks/42/peaks")

    assert resp.status_code == 200
    body = resp.json()
    assert body["peaks"] == [0.0, 0.5, 1.0]
    assert body["duration_s"] == 123.4
    assert body["bpm"] == 128.0
    assert body["bpm_overridden"] is False


def test_override_wins_over_detected_bpm(client: TestClient, tmp_path: Path) -> None:
    """A stored correction replaces the detected BPM in the peaks response."""
    cached = tmp_path / "42.mp4"
    cached.write_bytes(b"fake")

    with (
        patch.object(audio_cache, "cached_set_path", return_value=cached),
        patch.object(db_cache, "get_sc_bpm_override", return_value=140.0),
        patch.object(
            peaks_infra,
            "get_or_compute_peaks",
            new=AsyncMock(return_value=([0.0], 10.0, 70.0)),
        ),
    ):
        resp = client.get("/api/soundcloud/tracks/42/peaks")

    body = resp.json()
    assert body["bpm"] == 140.0
    assert body["bpm_overridden"] is True


def test_downloads_when_not_cached(client: TestClient, tmp_path: Path) -> None:
    """A cache miss resolves the stream, downloads, then decodes."""
    downloaded = tmp_path / "42.mp4"
    downloaded.write_bytes(b"fake")

    fetch_audio = AsyncMock(return_value=downloaded)
    with (
        patch.object(audio_cache, "cached_set_path", return_value=None),
        patch.object(db_cache, "get_sc_bpm_override", return_value=None),
        patch.object(
            soundcloud_api,
            "_fetch_stream_url",
            new=AsyncMock(return_value=("https://cdn.invalid/x.m3u8", 0.0)),
        ),
        patch.object(
            soundcloud_api.token_cache,
            "get_cached_access_token",
            return_value="tok",
        ),
        patch.object(soundcloud_api, "get_settings", return_value=SimpleNamespace()),
        patch.object(audio_cache, "fetch_set_audio", new=fetch_audio),
        patch.object(
            peaks_infra,
            "get_or_compute_peaks",
            new=AsyncMock(return_value=([0.1], 1.0, None)),
        ),
    ):
        resp = client.get("/api/soundcloud/tracks/42/peaks")

    assert resp.status_code == 200
    assert resp.json()["peaks"] == [0.1]
    assert resp.json()["bpm"] is None
    fetch_audio.assert_awaited_once()


def test_decode_failure_returns_502(client: TestClient, tmp_path: Path) -> None:
    """A decode error surfaces as a 502, not a 500."""
    cached = tmp_path / "42.mp4"
    cached.write_bytes(b"fake")

    with (
        patch.object(audio_cache, "cached_set_path", return_value=cached),
        patch.object(
            peaks_infra,
            "get_or_compute_peaks",
            new=AsyncMock(side_effect=RuntimeError("ffmpeg boom")),
        ),
    ):
        resp = client.get("/api/soundcloud/tracks/42/peaks")

    assert resp.status_code == 502


def test_set_bpm_override_persists(client: TestClient) -> None:
    """PUT stores the correction and echoes it back as overridden."""
    with patch.object(db_cache, "upsert_sc_bpm_override") as mock:
        resp = client.put("/api/soundcloud/tracks/42/bpm", json={"bpm": 140.0})

    assert resp.status_code == 200
    assert resp.json() == {"bpm": 140.0, "bpm_overridden": True}
    mock.assert_called_once()
    assert mock.call_args.args[:2] == (42, 140.0)


def test_set_bpm_rejects_out_of_range(client: TestClient) -> None:
    """A BPM outside the accepted range is a 422, and nothing is stored."""
    with patch.object(db_cache, "upsert_sc_bpm_override") as mock:
        resp = client.put("/api/soundcloud/tracks/42/bpm", json={"bpm": 5.0})

    assert resp.status_code == 422
    mock.assert_not_called()


def test_clear_bpm_reverts_to_detected(client: TestClient, tmp_path: Path) -> None:
    """DELETE removes the correction and returns the detected tempo."""
    cached = tmp_path / "42.mp4"
    cached.write_bytes(b"fake")

    with (
        patch.object(db_cache, "delete_sc_bpm_override") as delete_mock,
        patch.object(audio_cache, "cached_set_path", return_value=cached),
        patch.object(
            peaks_infra,
            "get_or_compute_peaks",
            new=AsyncMock(return_value=([0.0], 10.0, 70.0)),
        ),
    ):
        resp = client.delete("/api/soundcloud/tracks/42/bpm")

    assert resp.status_code == 200
    assert resp.json() == {"bpm": 70.0, "bpm_overridden": False}
    delete_mock.assert_called_once_with(42)


def test_clear_bpm_uses_cached_value_without_decoding(client: TestClient) -> None:
    """DELETE reads the detected tempo from the peaks cache directly.

    A cached BPM must not trigger a path resolve (which can re-download an
    evicted set) or a decode — the whole point of the cheap lookup.
    """
    resolve = AsyncMock()
    compute = AsyncMock()
    with (
        patch.object(db_cache, "delete_sc_bpm_override") as delete_mock,
        patch.object(peaks_infra, "read_cached_bpm", return_value=(True, 128.0)),
        patch.object(soundcloud_api, "_resolve_track_audio_path", new=resolve),
        patch.object(peaks_infra, "get_or_compute_peaks", new=compute),
    ):
        resp = client.delete("/api/soundcloud/tracks/42/bpm")

    assert resp.status_code == 200
    assert resp.json() == {"bpm": 128.0, "bpm_overridden": False}
    delete_mock.assert_called_once_with(42)
    resolve.assert_not_awaited()
    compute.assert_not_awaited()


def test_clear_bpm_decodes_when_cache_missing(client: TestClient, tmp_path: Path) -> None:
    """DELETE falls back to a full decode when no peaks cache exists yet."""
    cached = tmp_path / "42.mp4"
    cached.write_bytes(b"fake")
    with (
        patch.object(db_cache, "delete_sc_bpm_override"),
        patch.object(peaks_infra, "read_cached_bpm", return_value=(False, None)),
        patch.object(audio_cache, "cached_set_path", return_value=cached),
        patch.object(
            peaks_infra,
            "get_or_compute_peaks",
            new=AsyncMock(return_value=([0.0], 10.0, 70.0)),
        ),
    ):
        resp = client.delete("/api/soundcloud/tracks/42/bpm")

    assert resp.status_code == 200
    assert resp.json() == {"bpm": 70.0, "bpm_overridden": False}


def test_reanalyse_forces_recompute_and_clears_override(client: TestClient, tmp_path: Path) -> None:
    """POST reanalyse clears the override and recomputes with force=True."""
    cached = tmp_path / "42.mp4"
    cached.write_bytes(b"fake")
    compute = AsyncMock(return_value=([0.0], 10.0, 128.0))

    with (
        patch.object(db_cache, "delete_sc_bpm_override") as delete_mock,
        patch.object(audio_cache, "cached_set_path", return_value=cached),
        patch.object(peaks_infra, "get_or_compute_peaks", new=compute),
    ):
        resp = client.post("/api/soundcloud/tracks/42/bpm/reanalyse")

    assert resp.status_code == 200
    assert resp.json() == {"bpm": 128.0, "bpm_overridden": False}
    delete_mock.assert_called_once_with(42)
    assert compute.await_args is not None
    assert compute.await_args.kwargs.get("force") is True
