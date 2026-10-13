"""Tests for streaming local Rekordbox tracks by id.

Tracks may live anywhere on disk, outside the configured music root, so their
audio is resolved from ``master.db`` rather than a client-supplied path.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pyrekordbox import Rekordbox6Database

from backend.services.rekordbox import LocalMasterDbSource
from tests.services.test_rekordbox_local_edit import build_master_db, set_rekordbox_running


@pytest.fixture
def source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> LocalMasterDbSource:
    set_rekordbox_running(monkeypatch, False)
    audio = tmp_path / "elsewhere" / "track.mp3"
    audio.parent.mkdir()
    audio.write_bytes(b"ID3fake-mp3-bytes")
    db_path = tmp_path / "master.db"
    build_master_db(db_path).close()
    con = sqlite3.connect(db_path)
    con.execute("UPDATE djmdContent SET FolderPath = ? WHERE ID = '1'", (str(audio),))
    con.execute("UPDATE djmdContent SET FolderPath = ? WHERE ID = '2'", (str(tmp_path / "gone.mp3"),))
    con.commit()
    con.close()
    src = LocalMasterDbSource()
    src._db = Rekordbox6Database(db_path, unlock=False)
    return src


def test_audio_path_comes_from_master_db(source: LocalMasterDbSource, tmp_path: Path) -> None:
    assert source.get_track_audio_path("1") == tmp_path / "elsewhere" / "track.mp3"
    assert source.get_track_audio_path("2") is None  # file missing on disk
    assert source.get_track_audio_path("3") is None  # no path stored
    assert source.get_track_audio_path("999") is None  # unknown track


def test_api_streams_local_track_outside_music_root(
    source: LocalMasterDbSource, monkeypatch: pytest.MonkeyPatch
) -> None:
    from backend.api.rekordbox import router
    from backend.services import rekordbox as rb_service

    monkeypatch.setattr(rb_service, "get_source", lambda device=None: source)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    audio = client.get("/api/rekordbox/tracks/1/audio")
    assert audio.status_code == 200
    assert audio.content == b"ID3fake-mp3-bytes"

    assert client.get("/api/rekordbox/tracks/2/audio").status_code == 404
