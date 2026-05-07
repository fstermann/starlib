"""Tests for the Fetch-from-Downloads endpoint."""

import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def fake_downloads(tmp_path: Path) -> Path:
    """Stand in for ``~/Downloads`` via a patched ``Path.home()``."""
    home = tmp_path / "home"
    (home / "Downloads").mkdir(parents=True)
    return home


@pytest.fixture
def patched_client(client: TestClient, fake_downloads: Path):
    """Client with ``Path.home()`` redirected to a temp dir."""
    with patch("backend.api.metadata.files.Path.home", return_value=fake_downloads):
        yield client


def _touch(path: Path, mtime_offset_s: float = 0) -> Path:
    path.write_bytes(b"data")
    if mtime_offset_s:
        ts = time.time() + mtime_offset_s
        os.utime(path, (ts, ts))
    return path


def test_moves_recent_audio_into_destination(
    patched_client: TestClient,
    tmp_music_folder: Path,
    fake_downloads: Path,
):
    downloads = fake_downloads / "Downloads"
    _touch(downloads / "recent.mp3")
    _touch(downloads / "old.mp3", mtime_offset_s=-3 * 86400)
    _touch(downloads / "doc.pdf")  # non-audio
    _touch(downloads / ".hidden.mp3")

    dest = tmp_music_folder / "prepare"

    with patch("backend.api.metadata.files.collection.reindex_file"):
        resp = patched_client.post(
            "/api/metadata/folders/fetch-from-downloads",
            json={"dest_path": str(dest), "window_days": 1},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["moved"] == ["recent.mp3"]
    assert body["skipped"] == []
    assert body["errors"] == []
    assert (dest / "recent.mp3").is_file()
    assert not (downloads / "recent.mp3").exists()
    # Old, non-audio, hidden files stay put.
    assert (downloads / "old.mp3").exists()
    assert (downloads / "doc.pdf").exists()


def test_skips_files_already_present(
    patched_client: TestClient,
    tmp_music_folder: Path,
    fake_downloads: Path,
):
    downloads = fake_downloads / "Downloads"
    _touch(downloads / "track.mp3")
    dest = tmp_music_folder / "prepare"
    _touch(dest / "track.mp3")  # collision

    with patch("backend.api.metadata.files.collection.reindex_file"):
        resp = patched_client.post(
            "/api/metadata/folders/fetch-from-downloads",
            json={"dest_path": str(dest), "window_days": 7},
        )

    body = resp.json()
    assert body["moved"] == []
    assert body["skipped"] == ["track.mp3"]
    # Source preserved — not clobbered.
    assert (downloads / "track.mp3").exists()


def test_preview_lists_recent_audio_and_collisions(
    patched_client: TestClient,
    tmp_music_folder: Path,
    fake_downloads: Path,
):
    downloads = fake_downloads / "Downloads"
    _touch(downloads / "recent.mp3")
    _touch(downloads / "another.wav")
    _touch(downloads / "old.mp3", mtime_offset_s=-3 * 86400)
    _touch(downloads / "doc.pdf")
    _touch(downloads / "unsupported.m4a")  # not in FILETYPE_MAP
    dest = tmp_music_folder / "prepare"
    _touch(dest / "another.wav")  # collision

    resp = patched_client.get(
        "/api/metadata/folders/fetch-from-downloads/preview",
        params={"dest_path": str(dest), "window_days": 1},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [c["name"] for c in body["candidates"]] == ["recent.mp3"]
    assert body["candidates"][0]["size"] == len(b"data")
    assert body["skipped"] == ["another.wav"]


def test_post_with_file_names_only_moves_selected(
    patched_client: TestClient,
    tmp_music_folder: Path,
    fake_downloads: Path,
):
    downloads = fake_downloads / "Downloads"
    _touch(downloads / "keep.mp3")
    _touch(downloads / "drop.mp3")
    dest = tmp_music_folder / "prepare"

    with patch("backend.api.metadata.files.collection.reindex_file"):
        resp = patched_client.post(
            "/api/metadata/folders/fetch-from-downloads",
            json={
                "dest_path": str(dest),
                "window_days": 1,
                "file_names": ["keep.mp3"],
            },
        )

    assert resp.status_code == 200
    assert resp.json()["moved"] == ["keep.mp3"]
    assert (dest / "keep.mp3").is_file()
    # Excluded file stays in Downloads.
    assert (downloads / "drop.mp3").exists()
    assert not (dest / "drop.mp3").exists()


def test_rejects_destination_outside_root(
    patched_client: TestClient,
    fake_downloads: Path,
    tmp_path_factory: pytest.TempPathFactory,
):
    (fake_downloads / "Downloads" / "x.mp3").write_bytes(b"")
    # Distinct temp dir — outside the music root.
    outside = tmp_path_factory.mktemp("outside-root")
    resp = patched_client.post(
        "/api/metadata/folders/fetch-from-downloads",
        json={"dest_path": str(outside), "window_days": 1},
    )
    assert resp.status_code == 403
