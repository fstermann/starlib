"""Regression tests for SSE replay ordering and preview persistence.

Bug 1: ``_replay_in_progress_state`` used to emit the active
``shazam.scan_started`` marker *before* replaying cached scan rows, so a
mid-scan reload counted every same-tier row from prior runs into the
active run's progress ("87/40 points"-style counts).

Bug 2: Shazam preview/artwork URLs lived only on scan-grid rows, which
are a cache that re-probes overwrite — a re-probe miss (or a replay that
dropped the fields) made previews silently disappear from the tracklist.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from backend.core.db import engine as db_engine
from backend.core.db.migrations import run_migrations
from backend.core.services.analyser import controller as analyser_controller
from backend.core.services.analyser import db as analyser_db
from backend.core.services.analyser.controller import (
    _JobState,
    _replay_in_progress_state,
    sync_shazam_runs_to_tracks,
)
from backend.core.services.analyser.events import (
    ReanalyseStartedEvent,
    ShazamScanStartedEvent,
)


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path) -> Iterator[Path]:
    db_path = tmp_path / "analyser.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    analyser_controller._jobs.clear()
    yield db_path
    engine.dispose()


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


def _seed_scan(
    job_id: str,
    scan_s: float,
    *,
    title: str | None = "Track A",
    shazam_id: str | None = "shz-a",
    preview_url: str | None = None,
    artwork_url: str | None = None,
    tier: str = "sweep",
) -> None:
    analyser_db.upsert_shazam_scan(
        job_id=job_id,
        scan_s=scan_s,
        pitch_offset=0.0,
        title=title,
        artist="A" if title else None,
        shazam_id=shazam_id,
        confidence=0.9 if title else 0.0,
        preview_url=preview_url,
        artwork_url=artwork_url,
        tier=tier,
    )


def test_scan_started_replays_after_cached_scans() -> None:
    _seed_job()
    for s in (0.0, 60.0, 120.0):
        _seed_scan("job-1", s)
    state = _JobState(
        job_id="job-1",
        options=analyser_controller.AnalyserJobOptions(),
        duration_s=600.0,
    )
    state.active_shazam_scan = ShazamScanStartedEvent(
        job_id="job-1", tier="sweep", total_points=10, completed_points=3
    )

    events = _replay_in_progress_state(state)
    types = [e.type for e in events]
    last_scan = max(i for i, t in enumerate(types) if t == "shazam.scan")
    started_idx = types.index("shazam.scan_started")
    assert started_idx > last_scan, (
        "scan_started must replay after cached scan rows so the frontend "
        "doesn't count history into the active run"
    )
    started = events[started_idx]
    assert started.completed_points == 3


def test_replayed_scans_carry_preview_and_artwork() -> None:
    _seed_job()
    _seed_scan(
        "job-1", 0.0, preview_url="https://cdn/p.m4a", artwork_url="https://cdn/a.jpg"
    )
    state = _JobState(
        job_id="job-1",
        options=analyser_controller.AnalyserJobOptions(),
        duration_s=600.0,
    )
    events = _replay_in_progress_state(state)
    scan = next(e for e in events if e.type == "shazam.scan")
    assert scan.preview_url == "https://cdn/p.m4a"
    assert scan.artwork_url == "https://cdn/a.jpg"


def test_reanalyse_marker_replays_before_windows() -> None:
    _seed_job()
    analyser_db.upsert_window_bpm(
        job_id="job-1", start_s=0.0, end_s=30.0, bpm=128.0, confidence="high"
    )
    state = _JobState(
        job_id="job-1",
        options=analyser_controller.AnalyserJobOptions(),
        duration_s=600.0,
    )
    state.active_reanalyse = ReanalyseStartedEvent(
        job_id="job-1", ranges=[{"start_s": 0.0, "end_s": 100.0}]
    )
    events = _replay_in_progress_state(state)
    types = [e.type for e in events]
    assert types.index("job.reanalyse_started") < types.index("window.bpm"), (
        "the reanalyse marker drops in-range windows in the reducer, so it "
        "must arrive before the windows replay refills them"
    )


def test_track_preview_survives_scan_row_overwrite() -> None:
    _seed_job()
    _seed_scan("job-1", 0.0, preview_url="https://cdn/p.m4a")
    _seed_scan("job-1", 60.0, preview_url=None)
    assert sync_shazam_runs_to_tracks("job-1") == 1
    track = analyser_db.list_tracks("job-1")[0]
    assert track.preview_url == "https://cdn/p.m4a"

    # A finer-tier re-probe at the matched point comes back as a miss and
    # overwrites the cached row — the track-level preview must survive.
    _seed_scan("job-1", 0.0, title=None, shazam_id=None, tier="refine")
    sync_shazam_runs_to_tracks("job-1")
    track = analyser_db.list_tracks("job-1")[0]
    assert track.preview_url == "https://cdn/p.m4a"
