"""Tests for manual window-BPM correction (``PATCH /sets/{id}/windows``).

The analyser sometimes locks onto a metrically related tempo (2:3, 1:2)
for a span of windows. The correction route rewrites those rows in place
without a re-analysis pass.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.analyser import router as analyser_router
from backend.infra.analyser import db as analyser_db
from backend.infra.db import engine as db_engine
from backend.infra.db.migrations import run_migrations
from backend.services.analyser import controller as analyser_controller


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


def _seed_job_with_windows(job_id: str = "job-1") -> None:
    analyser_db.insert_job(
        job_id=job_id,
        soundcloud_id=42,
        source_url=None,
        title="Set",
        artist="DJ",
        duration_s=600.0,
        options={},
    )
    # 143.8 BPM throughout, except a misdetected 95.9 dip at 200-300 s.
    for start in range(0, 600, 50):
        bpm = 95.9 if 200 <= start < 300 else 143.8
        analyser_db.upsert_window_bpm(
            job_id=job_id,
            start_s=float(start),
            end_s=float(start + 30),
            bpm=bpm,
            confidence="medium",
        )


def test_patch_windows_rewrites_range(http_client: TestClient) -> None:
    _seed_job_with_windows()

    resp = http_client.patch(
        "/api/analyser/sets/job-1/windows",
        json={"start_s": 200.0, "end_s": 299.0, "bpm": 143.8},
    )
    assert resp.status_code == 200
    assert resp.json() == {"job_id": "job-1", "updated": 2}

    windows = analyser_db.list_windows("job-1")
    assert all(w.bpm == 143.8 for w in windows)
    # Corrected rows are user-asserted; the rest keep their confidence.
    corrected = [w for w in windows if 200 <= w.start_s < 300]
    untouched = [w for w in windows if not 200 <= w.start_s < 300]
    assert all(w.confidence == "high" for w in corrected)
    assert all(w.confidence == "medium" for w in untouched)


def test_patch_windows_outside_range_untouched(http_client: TestClient) -> None:
    _seed_job_with_windows()

    http_client.patch(
        "/api/analyser/sets/job-1/windows",
        json={"start_s": 200.0, "end_s": 299.0, "bpm": 143.8},
    )
    windows = analyser_db.list_windows("job-1")
    assert [w.bpm for w in windows if w.start_s < 200] == [143.8] * 4


def test_patch_windows_unknown_job_404(http_client: TestClient) -> None:
    resp = http_client.patch(
        "/api/analyser/sets/nope/windows",
        json={"start_s": 0.0, "end_s": 10.0, "bpm": 120.0},
    )
    assert resp.status_code == 404


def test_patch_windows_invalid_range_422(http_client: TestClient) -> None:
    _seed_job_with_windows()
    resp = http_client.patch(
        "/api/analyser/sets/job-1/windows",
        json={"start_s": 100.0, "end_s": 50.0, "bpm": 120.0},
    )
    assert resp.status_code == 422
