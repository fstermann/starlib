"""Tests for the metadata suggestions endpoint."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.deps import get_root_folder
from backend.api.suggestions import router as suggestions_router


@pytest.fixture
def app(tmp_path: Path) -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(suggestions_router)
    test_app.dependency_overrides[get_root_folder] = lambda: tmp_path
    return test_app


@pytest.fixture
def music_file(tmp_path: Path) -> Path:
    f = tmp_path / "Some Artist - Some Title.mp3"
    f.write_bytes(b"")
    return f


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def test_endpoint_round_trips_with_no_sc_track(client: TestClient, music_file: Path) -> None:
    """No SC track → filename-only suggestions."""
    resp = client.post(
        "/api/suggestions/track",
        json={"file_path": str(music_file)},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Filename "Some Artist - Some Title.mp3" should yield title/artist suggestions.
    assert "title" in body["fields"]
    assert body["fields"]["title"][0]["value"] == "Some Title"
    assert "artist" in body["fields"]
    assert body["fields"]["artist"][0]["value"] == "Some Artist"


def test_endpoint_accepts_full_sc_payload_without_validation_errors(client: TestClient, music_file: Path) -> None:
    """The SC payload model uses ``extra='ignore'`` so OpenAPI shapes pass through."""
    resp = client.post(
        "/api/suggestions/track",
        json={
            "file_path": str(music_file),
            "sc_track": {
                "title": "Foo - Bar (Baz Remix)",
                "metadata_artist": "Foo",
                "genre": "House",
                "tag_list": "house dance",
                "user": {"username": "foo_uploader", "id": 99},
                "release_year": 2024,
                "extra_unknown_field": "ignored",
            },
            "current": {"title": "old"},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    # Sanity: at least title and genre come back; full content covered in
    # ``test_suggesters.py``.
    assert "title" in body["fields"]
    assert "genre" in body["fields"]
    assert body["fields"]["genre"][0]["value"] == "House"


def test_endpoint_rejects_path_outside_root(client: TestClient) -> None:
    resp = client.post(
        "/api/suggestions/track",
        json={"file_path": "/etc/passwd"},
    )
    assert resp.status_code == 403


def test_endpoint_rejects_missing_file(client: TestClient, tmp_path: Path) -> None:
    resp = client.post(
        "/api/suggestions/track",
        json={"file_path": str(tmp_path / "does-not-exist.mp3")},
    )
    assert resp.status_code == 404
