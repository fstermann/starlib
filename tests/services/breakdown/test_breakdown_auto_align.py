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

from backend.api.breakdown import router as breakdown_router
from backend.infra.breakdown import db as breakdown_db
from backend.infra.breakdown.align import AlignResult
from backend.infra.db import engine as db_engine
from backend.infra.db.migrations import run_migrations
from backend.services.breakdown import auto_align
from backend.services.breakdown import controller as breakdown_controller


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path) -> Iterator[Path]:
    db_path = tmp_path / "breakdown.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    breakdown_controller._jobs.clear()
    yield db_path
    engine.dispose()


def _seed() -> breakdown_db.TrackRow:
    breakdown_db.insert_job(
        job_id="job-1", soundcloud_id=42, source_url=None, title="Set", artist="DJ", duration_s=3600.0, options={}
    )
    return breakdown_db.insert_track(
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
    assert breakdown_db.list_tracks("job-1")[0].start_s == 1200.0


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
    app.include_router(breakdown_router)
    _mock, patches = _patched(_result(0.6))
    with (
        patches,
        patch("backend.api.soundcloud.tracks._resolve_track_audio_path", AsyncMock(return_value=Path("orig.mp4"))),
    ):
        resp = TestClient(app).post(f"/api/breakdown/sets/job-1/tracks/{track.id}/auto-align")

    assert resp.status_code == 200
    body = resp.json()
    assert body["found"] is True
    assert body["start_s"] == 1180.5
    assert body["rate"] == 1.04


def test_route_without_soundcloud_link_finds_nothing() -> None:
    _seed()
    row = breakdown_db.insert_track(job_id="job-1", origin="manual", start_s=10.0, title="ID", artist="Y")
    app = FastAPI()
    app.include_router(breakdown_router)
    resp = TestClient(app).post(f"/api/breakdown/sets/job-1/tracks/{row.id}/auto-align")
    assert resp.json() == {"found": False}


def test_set_peaks_window_is_clamped_to_the_set() -> None:
    _seed()
    peaks_mock = AsyncMock(return_value=[0.5, 1.0])
    with (
        patch("backend.api.breakdown.audio_cache.cached_set_path", return_value=Path("mix.mp4")),
        patch("backend.infra.breakdown.peaks.window_peaks", peaks_mock),
    ):
        early = TestClient(_app()).get("/api/breakdown/sets/job-1/peaks?start_s=-30&end_s=600")
        late = TestClient(_app()).get("/api/breakdown/sets/job-1/peaks?start_s=3300&end_s=4000")

    assert early.status_code == late.status_code == 200
    assert early.json()["start_s"] == 0.0
    assert peaks_mock.await_args_list[0].args[1:] == (0.0, 600.0)
    assert peaks_mock.await_args_list[1].args[1:] == (3300.0, 3600.0)


def test_set_peaks_rejects_oversized_window() -> None:
    _seed()
    with patch("backend.api.breakdown.audio_cache.cached_set_path", return_value=Path("mix.mp4")):
        resp = TestClient(_app()).get("/api/breakdown/sets/job-1/peaks?start_s=0&end_s=3600")
    assert resp.status_code == 422


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(breakdown_router)
    return app


def _aligned_track(start_s: float) -> breakdown_db.TrackRow:
    track = _seed()
    breakdown_db.update_track("job-1", track.id, start_s=start_s, aligned=True)
    return track


def _fill(result: AlignResult | None) -> int:
    _mock, patches = _patched(result)

    async def resolve(_sc: int) -> Path:
        return Path("orig.mp4")

    with patches:
        return asyncio.run(auto_align.fill_mix_points("job-1", resolve))


def test_fill_stores_mix_points_when_the_match_agrees() -> None:
    # Saved at 1180.5; set 130 / original 125 = the match's rate 1.04.
    track = _aligned_track(1180.5)
    assert _fill(_result(0.6)) == 1
    row = next(t for t in breakdown_db.list_tracks("job-1") if t.id == track.id)
    assert (row.mix_in_s, row.mix_out_s) == (1180.5, 1400.0)


def test_fill_leaves_a_disagreeing_alignment_alone() -> None:
    track = _aligned_track(1190.0)  # 9.5 s off the match
    assert _fill(_result(0.6)) == 0
    row = next(t for t in breakdown_db.list_tracks("job-1") if t.id == track.id)
    assert row.mix_in_s is None


def test_fill_skips_unaligned_tracks() -> None:
    _seed()
    assert _fill(_result(0.6)) == 0


def test_saving_mix_points_round_trips() -> None:
    track = _seed()
    resp = TestClient(_app()).patch(
        f"/api/breakdown/sets/job-1/tracks/{track.id}", json={"mix_in_s": 1250.0, "mix_out_s": 1420.0}
    )
    assert resp.status_code == 200
    snap = TestClient(_app()).get("/api/breakdown/sets/job-1").json()
    entry = next(t for t in snap["timeline"] if t["id"] == track.id)
    assert (entry["mix_in_s"], entry["mix_out_s"]) == (1250.0, 1420.0)


def test_mix_out_before_mix_in_is_rejected() -> None:
    track = _seed()
    resp = TestClient(_app()).patch(
        f"/api/breakdown/sets/job-1/tracks/{track.id}", json={"mix_in_s": 1420.0, "mix_out_s": 1250.0}
    )
    assert resp.status_code == 422


def test_fill_skips_a_track_whose_original_fails() -> None:
    track = _aligned_track(1180.5)
    broken = breakdown_db.insert_track(
        job_id="job-1", origin="manual", start_s=100.0, title="Gone", artist="Y", soundcloud_id=8
    )
    breakdown_db.update_track("job-1", broken.id, aligned=True)
    _mock, patches = _patched(_result(0.6))

    async def resolve(sc: int) -> Path:
        if sc == 8:
            raise RuntimeError("taken down")
        return Path("orig.mp4")

    with patches:
        assert asyncio.run(auto_align.fill_mix_points("job-1", resolve)) == 1
    row = next(t for t in breakdown_db.list_tracks("job-1") if t.id == track.id)
    assert row.mix_in_s == 1180.5


def test_fill_agrees_with_a_half_time_listing() -> None:
    # Listed at 62.5, half the original's 125: the dialog folds the rate to 1.04.
    track = _aligned_track(1180.5)
    _mock, patches = _patched(_result(0.6))

    async def resolve(_sc: int) -> Path:
        return Path("orig.mp4")

    with patches, patch.object(auto_align, "original_bpm", AsyncMock(return_value=(62.5, "soundcloud"))):
        assert asyncio.run(auto_align.fill_mix_points("job-1", resolve)) == 1
    row = next(t for t in breakdown_db.list_tracks("job-1") if t.id == track.id)
    assert row.mix_in_s == 1180.5
