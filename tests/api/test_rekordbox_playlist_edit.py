"""Tests for the Rekordbox playlist edit endpoints."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import rekordbox as rekordbox_api
from backend.services import rekordbox as rb_service
from tests.services.test_rekordbox_local_edit import build_master_db, set_rekordbox_running


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    set_rekordbox_running(monkeypatch, False)
    source = rb_service.LocalMasterDbSource()
    source._db = build_master_db(tmp_path / "master.db")
    monkeypatch.setattr(rb_service, "get_local_source", lambda: source)
    app = FastAPI()
    app.include_router(rekordbox_api.router)
    return TestClient(app)


def _titles(resp) -> list[str]:
    return [t["title"] for t in resp.json()["tracks"]]


def test_add_remove_and_reorder(client: TestClient) -> None:
    resp = client.post("/api/rekordbox/playlists/10/tracks", json={"track_ids": ["3"]})
    assert resp.status_code == 200
    assert _titles(resp) == ["Track 1", "Track 2", "Track 3", "Track 3"]

    resp = client.post("/api/rekordbox/playlists/10/tracks/remove", json={"entry_ids": ["e1"]})
    assert _titles(resp) == ["Track 2", "Track 3", "Track 3"]

    entries = [t["entry_id"] for t in resp.json()["tracks"]]
    resp = client.put("/api/rekordbox/playlists/10/order", json={"entry_ids": entries[::-1]})
    assert resp.status_code == 200
    assert _titles(resp) == ["Track 3", "Track 3", "Track 2"]


def test_busy_maps_to_409(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    set_rekordbox_running(monkeypatch, True)

    resp = client.post("/api/rekordbox/playlists/10/tracks", json={"track_ids": ["1"]})

    assert resp.status_code == 409
    assert resp.json()["detail"] == "Close Rekordbox to save playlist changes."


def test_smart_playlist_maps_to_400(client: TestClient) -> None:
    resp = client.post("/api/rekordbox/playlists/20/tracks", json={"track_ids": ["1"]})

    assert resp.status_code == 400


def test_create_and_delete_playlist(client: TestClient) -> None:
    resp = client.post("/api/rekordbox/playlists", json={"name": "Warmup", "parent_id": "30"})
    assert resp.status_code == 201
    created = resp.json()
    assert (created["name"], created["parent_id"], created["is_folder"]) == ("Warmup", "30", False)

    resp = client.delete(f"/api/rekordbox/playlists/{created['id']}")
    assert resp.status_code == 204
    ids = {p["id"] for p in client.get("/api/rekordbox/playlists").json()["playlists"]}
    assert created["id"] not in ids


def test_running_reports_the_rekordbox_process(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.get("/api/rekordbox/running").json() == {"running": False}
    set_rekordbox_running(monkeypatch, True)
    assert client.get("/api/rekordbox/running").json() == {"running": True}


def test_rename_playlist(client: TestClient) -> None:
    resp = client.patch("/api/rekordbox/playlists/30", json={"name": "Crates"})

    assert resp.status_code == 200
    assert resp.json()["name"] == "Crates"
