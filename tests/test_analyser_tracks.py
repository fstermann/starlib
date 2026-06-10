"""Tests for the consolidated tracklist model (``analyser_tracks``).

Replaces the previous ``test_analyser_track_overrides.py`` overlay
tests. Covers:

- Direct CRUD on the tracklist (insert, list, update, delete).
- Shazam-scan → tracks materialisation, idempotent on ``shazam_id``.
- The "user_edited preserves edits" re-sync policy (option (b)).
- Soft-dismiss for Shazam-origin rows so re-scans don't resurrect them.
- HTTP routes (``POST/PATCH/DELETE /tracks``) keep the snapshot in sync.
- Reset wipes everything, ``DELETE /sets/{id}`` cascades.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.analyser import router as analyser_router
from backend.core.db import engine as db_engine
from backend.core.db.migrations import run_migrations
from backend.core.services.analyser import controller as analyser_controller
from backend.core.services.analyser import db as analyser_db


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path) -> Iterator[Path]:
    db_path = tmp_path / "analyser.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    analyser_controller._jobs.clear()
    yield db_path
    engine.dispose()


@pytest.fixture()
def http_client() -> TestClient:
    app = FastAPI()
    app.include_router(analyser_router)
    return TestClient(app)


def _seed_job(job_id: str = "job-1") -> None:
    analyser_db.insert_job(
        job_id=job_id,
        soundcloud_id=42,
        source_url=None,
        title="Set",
        artist="DJ",
        duration_s=600.0,
        options={},
    )


def _seed_shazam_run(job_id: str, scan_s: float, title: str, shazam_id: str) -> None:
    analyser_db.upsert_shazam_scan(
        job_id=job_id,
        scan_s=scan_s,
        pitch_offset=0.0,
        title=title,
        artist="A",
        shazam_id=shazam_id,
        confidence=0.9,
    )


# ---------------------------------------------------------------------------
# Repo layer
# ---------------------------------------------------------------------------


def test_insert_and_list_tracks_round_trip() -> None:
    _seed_job()
    row = analyser_db.insert_track(
        job_id="job-1",
        origin="manual",
        start_s=120.0,
        title="Manual Track",
        artist="Manual Artist",
        soundcloud_id=999,
        duration_s=240.0,
        user_edited=True,
    )
    assert row.id > 0
    assert row.origin == "manual"
    assert row.user_edited is True

    rows = analyser_db.list_tracks("job-1")
    assert len(rows) == 1
    assert rows[0].title == "Manual Track"


def test_update_track_marks_user_edited() -> None:
    _seed_job()
    row = analyser_db.insert_track(
        job_id="job-1",
        origin="shazam",
        start_s=0.0,
        title="X",
        shazam_id="shz-x",
    )
    assert row.user_edited is False

    analyser_db.update_track(
        "job-1", row.id, start_s=10.0, mark_user_edited=True
    )
    after = analyser_db.list_tracks("job-1")[0]
    assert after.start_s == 10.0
    assert after.user_edited is True


def test_dismissed_rows_hidden_by_default() -> None:
    _seed_job()
    row = analyser_db.insert_track(
        job_id="job-1",
        origin="shazam",
        start_s=0.0,
        title="X",
        shazam_id="shz-x",
    )
    analyser_db.update_track("job-1", row.id, dismissed=True)
    assert analyser_db.list_tracks("job-1") == []
    assert len(analyser_db.list_tracks("job-1", include_dismissed=True)) == 1


# ---------------------------------------------------------------------------
# Shazam → tracks materialisation
# ---------------------------------------------------------------------------


def test_sync_materialises_shazam_runs() -> None:
    _seed_job()
    _seed_shazam_run("job-1", 0.0, "First", "shz-1")
    _seed_shazam_run("job-1", 60.0, "Second", "shz-2")
    inserted = analyser_controller.sync_shazam_runs_to_tracks("job-1")
    assert inserted == 2

    titles = [t.title for t in analyser_db.list_tracks("job-1")]
    assert titles == ["First", "Second"]


def test_sync_is_idempotent() -> None:
    _seed_job()
    _seed_shazam_run("job-1", 0.0, "First", "shz-1")
    analyser_controller.sync_shazam_runs_to_tracks("job-1")
    second = analyser_controller.sync_shazam_runs_to_tracks("job-1")
    assert second == 0
    assert len(analyser_db.list_tracks("job-1")) == 1


def test_sync_preserves_user_edits() -> None:
    """Option (b): a Shazam re-scan must not overwrite a row the user edited."""
    _seed_job()
    _seed_shazam_run("job-1", 0.0, "Original", "shz-1")
    analyser_controller.sync_shazam_runs_to_tracks("job-1")
    row = analyser_db.list_tracks("job-1")[0]
    analyser_db.update_track(
        "job-1", row.id, start_s=99.0, title="My Edit", mark_user_edited=True
    )

    # Re-sync — the existing (job_id, shazam_id) row should be untouched.
    analyser_controller.sync_shazam_runs_to_tracks("job-1")
    after = analyser_db.list_tracks("job-1")[0]
    assert after.title == "My Edit"
    assert after.start_s == 99.0


def test_sync_skips_dismissed_rows() -> None:
    _seed_job()
    _seed_shazam_run("job-1", 0.0, "X", "shz-1")
    analyser_controller.sync_shazam_runs_to_tracks("job-1")
    row = analyser_db.list_tracks("job-1")[0]
    analyser_db.update_track("job-1", row.id, dismissed=True)

    # Re-sync: dismissed row stays dismissed; nothing new appears.
    inserted = analyser_controller.sync_shazam_runs_to_tracks("job-1")
    assert inserted == 0
    assert analyser_db.list_tracks("job-1") == []  # still hidden


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------


def test_routes_round_trip(http_client: TestClient) -> None:
    _seed_job()
    _seed_shazam_run("job-1", 0.0, "Keep", "shz-keep")
    _seed_shazam_run("job-1", 60.0, "Drop", "shz-drop")

    # First snapshot read materialises the Shazam runs.
    snap = http_client.get("/api/analyser/sets/job-1").json()
    assert [t["title"] for t in snap["timeline"]] == ["Keep", "Drop"]
    drop_id = next(t for t in snap["timeline"] if t["title"] == "Drop")["id"]
    keep_id = next(t for t in snap["timeline"] if t["title"] == "Keep")["id"]

    # Add a manual.
    r = http_client.post(
        "/api/analyser/sets/job-1/tracks",
        json={"start_s": 30.0, "title": "Manual", "artist": "Z"},
    )
    assert r.status_code == 200, r.text
    manual_id = r.json()["id"]

    # Drag-edit the keep row's bounds.
    r = http_client.patch(
        f"/api/analyser/sets/job-1/tracks/{keep_id}",
        json={"start_s": 5.0, "end_s": 25.0},
    )
    assert r.status_code == 200

    # Delete the Drop row — soft-dismiss because origin='shazam'.
    r = http_client.delete(f"/api/analyser/sets/job-1/tracks/{drop_id}")
    assert r.status_code == 200

    # Snapshot reflects all three actions.
    snap = http_client.get("/api/analyser/sets/job-1").json()
    titles = [t["title"] for t in snap["timeline"]]
    assert titles == ["Keep", "Manual"]
    keep = next(t for t in snap["timeline"] if t["title"] == "Keep")
    assert keep["start_s"] == 5.0 and keep["end_s"] == 25.0
    assert keep["user_edited"] is True

    # Manual delete is hard-delete.
    r = http_client.delete(f"/api/analyser/sets/job-1/tracks/{manual_id}")
    assert r.status_code == 200
    snap = http_client.get("/api/analyser/sets/job-1").json()
    assert [t["title"] for t in snap["timeline"]] == ["Keep"]


def test_confirmed_toggle_is_not_a_user_edit(http_client: TestClient) -> None:
    """Toggling ``confirmed`` shouldn't flip ``user_edited`` — that flag
    is reserved for changes Shazam might want to overwrite."""
    _seed_job()
    _seed_shazam_run("job-1", 0.0, "T", "shz-t")
    snap = http_client.get("/api/analyser/sets/job-1").json()
    track_id = snap["timeline"][0]["id"]

    r = http_client.patch(
        f"/api/analyser/sets/job-1/tracks/{track_id}",
        json={"confirmed": True},
    )
    assert r.status_code == 200
    snap = http_client.get("/api/analyser/sets/job-1").json()
    assert snap["timeline"][0]["confirmed"] is True
    assert snap["timeline"][0]["user_edited"] is False


def test_routes_404(http_client: TestClient) -> None:
    assert (
        http_client.post(
            "/api/analyser/sets/nope/tracks",
            json={"start_s": 0.0, "title": "x"},
        ).status_code
        == 404
    )
    assert (
        http_client.delete("/api/analyser/sets/nope/tracks/1").status_code == 404
    )
    assert (
        http_client.patch(
            "/api/analyser/sets/nope/tracks/1", json={"start_s": 5.0}
        ).status_code
        == 404
    )


def test_reset_wipes_tracks_and_keeps_job_row(http_client: TestClient) -> None:
    _seed_job()
    _seed_shazam_run("job-1", 0.0, "T", "shz-t")
    http_client.get("/api/analyser/sets/job-1")  # materialise
    http_client.post(
        "/api/analyser/sets/job-1/tracks",
        json={"start_s": 30.0, "title": "Manual"},
    )

    r = http_client.post("/api/analyser/sets/job-1/reset")
    assert r.status_code == 200
    snap = http_client.get("/api/analyser/sets/job-1").json()
    # Cache scans were dropped too, so the lazy materialisation has nothing to
    # do and the timeline stays empty.
    assert snap["timeline"] == []
    assert snap["status"] == "complete"
    assert snap["soundcloud_id"] == 42  # job row preserved


def test_recent_jobs_track_count_matches_materialisation(
    http_client: TestClient,
) -> None:
    _seed_job("a")
    _seed_shazam_run("a", 0.0, "T1", "shz-a")
    _seed_shazam_run("a", 60.0, "T2", "shz-b")
    http_client.post(
        "/api/analyser/sets/a/tracks",
        json={"start_s": 30.0, "title": "Manual"},
    )

    body = http_client.get("/api/analyser/sets").json()
    job = next(j for j in body["jobs"] if j["id"] == "a")
    assert job["track_count"] == 3


def test_delete_job_cascades_tracks(http_client: TestClient) -> None:
    _seed_job("doomed")
    _seed_shazam_run("doomed", 0.0, "T", "shz")
    http_client.post(
        "/api/analyser/sets/doomed/tracks",
        json={"start_s": 10.0, "title": "M"},
    )

    r = http_client.delete("/api/analyser/sets/doomed")
    assert r.status_code == 200
    assert analyser_db.list_tracks("doomed") == []
