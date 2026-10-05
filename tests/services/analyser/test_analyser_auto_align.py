"""Tests for suggesting a track's start from the audio."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.analyser import router as analyser_router
from backend.infra.analyser import db as analyser_db
from backend.infra.analyser.align import AlignResult
from backend.infra.db import engine as db_engine
from backend.infra.db.migrations import run_migrations
from backend.services.analyser import auto_align
from backend.services.analyser import controller as analyser_controller


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path) -> Iterator[Path]:
    db_path = tmp_path / "analyser.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    analyser_controller._jobs.clear()
    yield db_path
    engine.dispose()


def _seed() -> analyser_db.TrackRow:
    analyser_db.insert_job(
        job_id="job-1", soundcloud_id=42, source_url=None, title="Set", artist="DJ", duration_s=3600.0, options={}
    )
    return analyser_db.insert_track(
        job_id="job-1",
        origin="shazam",
        start_s=1200.0,
        title="Get It",
        artist="X",
        shazam_id="s",
        soundcloud_id=7,
        set_bpm=130.0,
        pitch_offset=None,
    )


def _result(confidence: float) -> AlignResult:
    return AlignResult(start_s=1180.5, rate=1.04, key_lock=True, confidence=confidence, enter_s=1180.5, exit_s=1400.0)


def _patched(result: AlignResult | None):
    align_mock = AsyncMock(return_value=result)
    stack = ExitStack()
    stack.enter_context(patch.object(auto_align.audio_cache, "cached_set_path", return_value=Path("mix.mp4")))
    stack.enter_context(
        patch.object(auto_align.peaks, "get_or_compute_peaks", AsyncMock(return_value=([], 240.0, 125.0)))
    )
    stack.enter_context(patch.object(auto_align, "original_bpm", AsyncMock(return_value=(125.0, "detected"))))
    stack.enter_context(patch.object(auto_align.align, "align_track", align_mock))
    return align_mock, stack


def test_searches_around_detection_with_bpm_rate() -> None:
    track = _seed()
    align_mock, patches = _patched(_result(0.6))
    with patches:
        result = asyncio.run(auto_align.suggest_alignment("job-1", track.id, 7, Path("orig.mp4")))

    assert result is not None and result.start_s == 1180.5
    kwargs = align_mock.await_args.kwargs
    assert kwargs["rate_hints"] == [pytest.approx(1.04)]
    start, end = kwargs["window"]
    assert start == pytest.approx(1200.0 - 240.0 / 1.04 - 15.0)
    assert end == pytest.approx(1200.0 + 240.0 / 1.04 + 15.0)
    # A suggestion is never saved; the user confirms it in the dialog.
    assert analyser_db.list_tracks("job-1")[0].start_s == 1200.0


def test_soundcloud_bpm_drives_the_rate_hint() -> None:
    track = _seed()
    align_mock, patches = _patched(_result(0.6))
    with patches, patch.object(auto_align, "original_bpm", AsyncMock(return_value=(120.0, "soundcloud"))):
        asyncio.run(auto_align.suggest_alignment("job-1", track.id, 7, Path("orig.mp4")))

    assert align_mock.await_args is not None
    assert align_mock.await_args.kwargs["rate_hints"] == [pytest.approx(130.0 / 120.0)]


def test_low_confidence_is_no_suggestion() -> None:
    track = _seed()
    _mock, patches = _patched(_result(0.1))
    with patches:
        assert asyncio.run(auto_align.suggest_alignment("job-1", track.id, 7, Path("orig.mp4"))) is None


def test_route_returns_suggestion() -> None:
    track = _seed()
    app = FastAPI()
    app.include_router(analyser_router)
    _mock, patches = _patched(_result(0.6))
    with (
        patches,
        patch("backend.api.soundcloud.tracks._resolve_track_audio_path", AsyncMock(return_value=Path("orig.mp4"))),
    ):
        resp = TestClient(app).post(f"/api/analyser/sets/job-1/tracks/{track.id}/auto-align")

    assert resp.status_code == 200
    body = resp.json()
    assert body["found"] is True
    assert body["start_s"] == 1180.5
    assert body["rate"] == 1.04


def test_route_without_soundcloud_link_finds_nothing() -> None:
    _seed()
    row = analyser_db.insert_track(job_id="job-1", origin="manual", start_s=10.0, title="ID", artist="Y")
    app = FastAPI()
    app.include_router(analyser_router)
    resp = TestClient(app).post(f"/api/analyser/sets/job-1/tracks/{row.id}/auto-align")
    assert resp.json() == {"found": False}


def test_set_peaks_window_is_clamped_to_the_set() -> None:
    _seed()
    peaks_mock = AsyncMock(return_value=[0.5, 1.0])
    with (
        patch("backend.api.analyser.audio_cache.cached_set_path", return_value=Path("mix.mp4")),
        patch("backend.infra.analyser.peaks.window_peaks", peaks_mock),
    ):
        early = TestClient(_app()).get("/api/analyser/sets/job-1/peaks?start_s=-30&end_s=600")
        late = TestClient(_app()).get("/api/analyser/sets/job-1/peaks?start_s=3300&end_s=4000")

    assert early.status_code == late.status_code == 200
    assert early.json()["start_s"] == 0.0
    assert peaks_mock.await_args_list[0].args[1:] == (0.0, 600.0)
    assert peaks_mock.await_args_list[1].args[1:] == (3300.0, 3600.0)


def test_set_peaks_rejects_oversized_window() -> None:
    _seed()
    with patch("backend.api.analyser.audio_cache.cached_set_path", return_value=Path("mix.mp4")):
        resp = TestClient(_app()).get("/api/analyser/sets/job-1/peaks?start_s=0&end_s=3600")
    assert resp.status_code == 422


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(analyser_router)
    return app
