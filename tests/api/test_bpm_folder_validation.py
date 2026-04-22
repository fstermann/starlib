"""Tests for /api/bpm/local/candidates folder validation."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.bpm import router as bpm_router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(bpm_router)
    return TestClient(app)


def test_rejects_folder_outside_root(tmp_path: Path, client: TestClient) -> None:
    """An absolute path outside the configured library root returns 400."""
    root = tmp_path / "library"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()

    with patch(
        "backend.api.bpm.app_settings_service.get_root_music_folder",
        return_value=str(root),
    ):
        resp = client.get(f"/api/bpm/local/candidates?folder={outside}")

    assert resp.status_code == 400
    assert "library root" in resp.json()["detail"]


def test_rejects_traversal(tmp_path: Path, client: TestClient) -> None:
    """`..` traversal that escapes the root is rejected."""
    root = tmp_path / "library"
    root.mkdir()

    traversal = f"{root}/../elsewhere"
    with patch(
        "backend.api.bpm.app_settings_service.get_root_music_folder",
        return_value=str(root),
    ):
        resp = client.get(f"/api/bpm/local/candidates?folder={traversal}")

    assert resp.status_code == 400


def test_accepts_folder_inside_root(tmp_path: Path, client: TestClient) -> None:
    """A valid sub-path succeeds and reaches cache_db."""
    root = tmp_path / "library"
    sub = root / "prepare"
    sub.mkdir(parents=True)

    with (
        patch(
            "backend.api.bpm.app_settings_service.get_root_music_folder",
            return_value=str(root),
        ),
        patch("backend.api.bpm.cache_db.get_tracks_missing_bpm", return_value=[]) as mock,
    ):
        resp = client.get(f"/api/bpm/local/candidates?folder={sub}")

    assert resp.status_code == 200
    assert resp.json() == {"file_paths": []}
    mock.assert_called_once()


def test_rejects_when_no_root_configured(tmp_path: Path, client: TestClient) -> None:
    """If no library root is configured, validation rejects the request."""
    with patch(
        "backend.api.bpm.app_settings_service.get_root_music_folder",
        return_value="",
    ):
        resp = client.get(f"/api/bpm/local/candidates?folder={tmp_path}")

    assert resp.status_code == 400
