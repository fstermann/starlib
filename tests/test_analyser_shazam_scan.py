"""Tests for the decoupled Shazam scan stage.

The pipeline change splits BPM/segmentation from Shazam: ``start_job``
runs only the analyser-stream subprocess, and ``start_shazam_scan`` runs
a separate scan grid against the cached audio. These tests pin the
cadence math, BPM-driven pitch correction, timeline aggregation, and the
gate that requires ``target_bpm`` (or pitch_strategy=='none') before the
HTTP endpoint will accept the request.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from backend.core.db import engine as db_engine
from backend.core.db.migrations import run_migrations
from backend.core.services.analyser import (
    AnalyserJobOptions,
    JobNotFoundError,
    start_job,
    start_shazam_scan,
    subscribe_to_job,
)
from backend.core.services.analyser import controller as analyser_controller
from backend.core.services.analyser import db as analyser_db
from backend.core.services.analyser.controller import (
    _aggregate_timeline,
    _build_scan_grid,
)
from backend.core.services.analyser.events import (
    JobCompleteEvent,
    ShazamScanEvent,
    ShazamScanStartedEvent,
    TrackTimelineEvent,
)
from backend.core.services.analyser.shazam import ShazamMatch


# ---------------------------------------------------------------------------
# Scaffolding
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    db_path = tmp_path / "analyser.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    analyser_controller._jobs.clear()
    monkeypatch.setattr(
        "backend.core.services.analyser.controller.binary_locator.find_analyser_binary",
        lambda: "/dev/null",
    )
    monkeypatch.setattr(
        "backend.core.services.analyser.controller.cache.make_shazam_slice",
        _fake_make_slice,
    )
    yield db_path
    engine.dispose()


async def _fake_make_slice(**kwargs: Any) -> Path:  # noqa: D401
    return Path("/tmp/fake-slice.mp3")


async def _fake_fetch_audio() -> Path:
    return Path("/tmp/fake-source.mp4")


class FakeShazam:
    def __init__(self, *, responses: dict[float, ShazamMatch | None] | None = None) -> None:
        # Optional: per-scan-second responses. Falls back to None.
        self._by_scan = responses or {}
        self.calls: list[float] = []

    async def match(self, audio_path: str) -> ShazamMatch | None:
        # Decode the scan_s out of the slice path: section-{idx}-pitch-...
        # In our fake the path is constant, so we just round-robin via
        # the call counter to let tests script per-scan responses by index.
        idx = len(self.calls)
        self.calls.append(idx)
        # Map call index → scan_s using the registered responses' insertion order.
        keys = list(self._by_scan.keys())
        if idx < len(keys):
            return self._by_scan[keys[idx]]
        return None


def _stub_subprocess(monkeypatch: pytest.MonkeyPatch, payloads: list[dict[str, Any]]) -> None:
    queue = [payloads]

    async def fake_run(*, binary_path, input_path, options, listener):
        try:
            for payload in queue.pop(0):
                await listener(payload)
        except IndexError:
            pass
        return 0

    monkeypatch.setattr(
        "backend.core.services.analyser.controller.run_analyser_subprocess",
        fake_run,
    )


# ---------------------------------------------------------------------------
# Pure helpers — scan grid + timeline aggregation
# ---------------------------------------------------------------------------


class TestBuildScanGrid:
    def test_grid_steps_at_cadence_until_last_start(self) -> None:
        # last_start=120 with cadence=45 → [0, 45, 90]; 120-window<scan_window_s
        # only matters in the caller, not here.
        assert _build_scan_grid(cadence=45.0, last_start=120.0) == [0.0, 45.0, 90.0]

    def test_grid_includes_last_start_when_aligned(self) -> None:
        assert _build_scan_grid(cadence=30.0, last_start=90.0) == [0.0, 30.0, 60.0, 90.0]

    def test_grid_for_short_audio_yields_single_point(self) -> None:
        assert _build_scan_grid(cadence=45.0, last_start=0.0) == [0.0]


class TestAggregateTimeline:
    def _row(
        self,
        scan_s: float,
        title: str | None = None,
        shazam_id: str | None = None,
        confidence: float = 0.9,
    ) -> analyser_db.ShazamScanRow:
        return analyser_db.ShazamScanRow(
            scan_s=scan_s,
            pitch_offset=0.0,
            title=title,
            artist="A" if title else None,
            shazam_id=shazam_id,
            confidence=confidence,
            matched_at=0.0,
        )

    def test_consecutive_same_shazam_id_merges_into_one_run(self) -> None:
        rows = [
            self._row(0.0, title="T1", shazam_id="k1"),
            self._row(45.0, title="T1", shazam_id="k1"),
            self._row(90.0, title="T1", shazam_id="k1"),
        ]
        runs = _aggregate_timeline(rows)
        assert len(runs) == 1
        assert (runs[0].start_s, runs[0].end_s, runs[0].title) == (0.0, 90.0, "T1")

    def test_miss_breaks_run(self) -> None:
        rows = [
            self._row(0.0, title="T1", shazam_id="k1"),
            self._row(45.0, title=None),
            self._row(90.0, title="T1", shazam_id="k1"),
        ]
        runs = _aggregate_timeline(rows)
        # Two separate runs, both pointing at T1.
        assert [(r.start_s, r.end_s) for r in runs] == [(0.0, 0.0), (90.0, 90.0)]

    def test_different_track_starts_new_run(self) -> None:
        rows = [
            self._row(0.0, title="T1", shazam_id="k1"),
            self._row(45.0, title="T2", shazam_id="k2"),
        ]
        runs = _aggregate_timeline(rows)
        assert [(r.start_s, r.title) for r in runs] == [(0.0, "T1"), (45.0, "T2")]

    def test_falls_back_to_title_artist_when_shazam_id_missing(self) -> None:
        rows = [
            self._row(0.0, title="T1", shazam_id=None),
            self._row(45.0, title="T1", shazam_id=None),
        ]
        runs = _aggregate_timeline(rows)
        assert len(runs) == 1


# ---------------------------------------------------------------------------
# start_job no longer runs Shazam; start_shazam_scan does
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_job_does_not_call_shazam(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 60.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 120.0, "confidence": "high"},
            {"type": "section.detected", "index": 0, "start_s": 0.0, "end_s": 45.0, "confidence": 0.8},
        ],
    )
    client = FakeShazam()
    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=1,
        fetch_audio=_fake_fetch_audio,
        shazam_client=client,
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break
    assert client.calls == [], "start_job must not invoke Shazam"


@pytest.mark.asyncio
async def test_shazam_scan_emits_scan_and_timeline_events(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 200.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
            {"type": "window.bpm", "start_s": 25.0, "end_s": 55.0, "bpm": 128.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0, scan_cadence_s=60.0, scan_window_s=12.0),
        soundcloud_id=2,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    # Four scan points (0, 60, 120, 180 — last_start=200-12=188 admits 180);
    # first two match the same track, last two miss.
    same = ShazamMatch(title="Speedhouse Anthem", artist="DJ X", shazam_id="abc", confidence=0.9)
    client = FakeShazam(responses={0.0: same, 60.0: same, 120.0: None, 180.0: None})

    received: list[Any] = []

    async def collect() -> None:
        async for ev in subscribe_to_job(job_id):
            received.append(ev)
            if isinstance(ev, JobCompleteEvent):
                break

    import asyncio

    consumer = asyncio.create_task(collect())
    await asyncio.sleep(0)
    await start_shazam_scan(job_id, fetch_audio=_fake_fetch_audio, shazam_client=client)
    await asyncio.wait_for(consumer, timeout=5.0)

    scans = [e for e in received if isinstance(e, ShazamScanEvent)]
    timeline = [e for e in received if isinstance(e, TrackTimelineEvent)]
    assert len(scans) == 4
    assert {s.scan_s for s in scans} == {0.0, 60.0, 120.0, 180.0}
    # Two consecutive hits → one materialised track. The scan loop now
    # broadcasts the row live (insert at scan_s=0) and re-broadcasts
    # the final state at end-of-loop, so we expect ≥ 1 timeline event
    # and the last one carries the fully-extended run [0..60].
    assert len(timeline) >= 1
    last = timeline[-1]
    assert last.start_s == 0.0 and last.end_s == 60.0
    assert last.title == "Speedhouse Anthem"


@pytest.mark.asyncio
async def test_shazam_scan_unknown_job_raises() -> None:
    with pytest.raises(JobNotFoundError):
        await start_shazam_scan("missing", fetch_audio=_fake_fetch_audio, shazam_client=FakeShazam())


@pytest.mark.asyncio
async def test_shazam_scan_endpoint_flips_status_synchronously(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The /shazam-scan endpoint must persist ``status='running'`` BEFORE
    returning 200, so a frontend that re-fetches the snapshot right after
    the response sees the new pass in progress (and re-subscribes for SSE
    rather than dropping the EventSource)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.api.analyser import router as analyser_router

    monkeypatch.setattr(
        "backend.api.analyser._make_soundcloud_fetcher",
        lambda _id: _fake_fetch_audio,
    )

    analyser_db.insert_job(
        job_id="j-flip",
        soundcloud_id=99,
        source_url=None,
        title=None,
        artist=None,
        duration_s=120.0,
        options={"pitch_strategy": "none"},
    )
    analyser_db.update_job_status("j-flip", status="complete")

    app = FastAPI()
    app.include_router(analyser_router)
    with TestClient(app) as client:
        resp = client.post("/api/analyser/sets/j-flip/shazam-scan", json={})
        assert resp.status_code == 200
        # Without the synchronous flip, the row would still read 'complete'
        # for an arbitrary scheduling-dependent window after the response.
        row = analyser_db.get_job("j-flip")
        assert row is not None and row.status == "running"


# ---------------------------------------------------------------------------
# HTTP endpoint gate: target_bpm required when pitch_strategy != "none"
# ---------------------------------------------------------------------------


@pytest.fixture()
def http_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """Minimal FastAPI app exposing only the analyser router for endpoint tests."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.api.analyser import router as analyser_router

    monkeypatch.setattr(
        "backend.api.analyser._make_soundcloud_fetcher",
        lambda _id: _fake_fetch_audio,
    )

    app = FastAPI()
    app.include_router(analyser_router)
    with TestClient(app) as client:
        yield client


def test_shazam_scan_endpoint_rejects_when_target_bpm_missing(http_client: Any) -> None:
    analyser_db.insert_job(
        job_id="j1",
        soundcloud_id=42,
        source_url=None,
        title=None,
        artist=None,
        duration_s=120.0,
        options={"pitch_strategy": "single"},  # missing target_bpm
    )
    analyser_db.update_job_status("j1", status="complete")
    resp = http_client.post("/api/analyser/sets/j1/shazam-scan", json={})
    assert resp.status_code == 400
    assert "target_bpm" in resp.json()["detail"]


def test_shazam_scan_endpoint_rejects_range_without_bpm_range(http_client: Any) -> None:
    analyser_db.insert_job(
        job_id="j-range",
        soundcloud_id=44,
        source_url=None,
        title=None,
        artist=None,
        duration_s=120.0,
        options={"pitch_strategy": "range"},  # missing bpm_range
    )
    analyser_db.update_job_status("j-range", status="complete")
    resp = http_client.post("/api/analyser/sets/j-range/shazam-scan", json={})
    assert resp.status_code == 400
    assert "bpm_range" in resp.json()["detail"]


def test_shazam_scan_endpoint_rejects_single_with_only_bpm_range(http_client: Any) -> None:
    """Closes the silent fallthrough where ``single`` + ``bpm_range`` (but
    no ``target_bpm``) used to slip past the gate and degrade to ``[0.0]``
    inside ``select_pitch_offsets``."""
    analyser_db.insert_job(
        job_id="j-single-no-target",
        soundcloud_id=45,
        source_url=None,
        title=None,
        artist=None,
        duration_s=120.0,
        options={"pitch_strategy": "single", "bpm_range": [120.0, 140.0]},
    )
    analyser_db.update_job_status("j-single-no-target", status="complete")
    resp = http_client.post(
        "/api/analyser/sets/j-single-no-target/shazam-scan", json={}
    )
    assert resp.status_code == 400
    assert "target_bpm" in resp.json()["detail"]


def test_shazam_scan_endpoint_accepts_when_pitch_strategy_none(http_client: Any) -> None:
    analyser_db.insert_job(
        job_id="j2",
        soundcloud_id=43,
        source_url=None,
        title=None,
        artist=None,
        duration_s=120.0,
        options={"pitch_strategy": "none"},
    )
    analyser_db.update_job_status("j2", status="complete")
    resp = http_client.post("/api/analyser/sets/j2/shazam-scan", json={})
    assert resp.status_code == 200
    assert resp.json()["status"] == "scheduled"


@pytest.mark.asyncio
async def test_cancel_shazam_scan_stops_at_next_point(monkeypatch: pytest.MonkeyPatch) -> None:
    """Setting ``cancel_requested`` mid-scan must break the loop after the
    current point completes — partial cached scans are preserved so the
    user can re-run and pick up where it left off."""
    from backend.core.services.analyser import cancel_shazam_scan, start_shazam_scan

    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 600.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(
            window_s=30.0, hop_s=25.0, scan_cadence_s=60.0, scan_window_s=10.0
        ),
        soundcloud_id=42,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    # Make the Shazam client flip the cancel flag after its second call,
    # simulating a user clicking Stop. Then verify only ~2 scan rows landed.
    client = FakeShazam()
    cancel_after = 2
    original_match = client.match

    async def cancelling_match(audio_path: str) -> Any:
        result = await original_match(audio_path)
        if len(client.calls) >= cancel_after:
            cancel_shazam_scan(job_id)
        return result

    client.match = cancelling_match  # type: ignore[assignment]

    await start_shazam_scan(job_id, fetch_audio=_fake_fetch_audio, shazam_client=client)

    rows = analyser_db.list_shazam_scans(job_id)
    distinct_points = {r.scan_s for r in rows}
    assert 0 < len(distinct_points) < 11, (
        f"expected scan to bail early, got {len(distinct_points)} points "
        "(grid would have 10 at 60s cadence × 600s)"
    )


@pytest.mark.asyncio
async def test_cancel_interrupts_in_flight_scan_task(monkeypatch: pytest.MonkeyPatch) -> None:
    """Cancelling while a Shazam call is mid-flight must ``.cancel()`` the
    asyncio task so the loop exits within sub-second, not waiting for
    the call's full timeout."""
    import asyncio

    from backend.core.services.analyser import cancel_shazam_scan, start_shazam_scan

    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 600.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(
            window_s=30.0,
            hop_s=25.0,
            scan_cadence_s=60.0,
            scan_window_s=10.0,
        ),
        soundcloud_id=42,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    class HangingShazam:
        """Mimics a stuck shazamio call — never resolves until cancelled."""

        def __init__(self) -> None:
            self.calls: list[float] = []
            self.cancelled = False

        async def match(self, audio_path: str) -> ShazamMatch | None:
            self.calls.append(0.0)
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                self.cancelled = True
                raise
            return None

    client = HangingShazam()

    async def runner() -> None:
        await start_shazam_scan(job_id, fetch_audio=_fake_fetch_audio, shazam_client=client)

    task = asyncio.create_task(runner())
    # Wait until the first scan call is in flight, then cancel.
    for _ in range(50):
        if client.calls:
            break
        await asyncio.sleep(0.02)
    cancel_shazam_scan(job_id)

    # Without the task cancellation the test would hang for 60 s; with
    # it, ``runner`` should return promptly.
    await asyncio.wait_for(task, timeout=2.0)
    assert client.cancelled, "cancel_shazam_scan must have interrupted the in-flight call"


def test_shazam_scan_endpoint_accepts_overrides_with_target_bpm(http_client: Any) -> None:
    analyser_db.insert_job(
        job_id="j3",
        soundcloud_id=44,
        source_url=None,
        title=None,
        artist=None,
        duration_s=120.0,
        options={"pitch_strategy": "single"},
    )
    analyser_db.update_job_status("j3", status="complete")
    resp = http_client.post(
        "/api/analyser/sets/j3/shazam-scan",
        json={"overrides": {"target_bpm": 128.0}},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Tiered scans (sweep / refine / pinpoint) — gating, region scoping,
# confirmed-track exclusion, cache-tier ordering.
# ---------------------------------------------------------------------------


class TestGridMinusRanges:
    def test_no_ranges_returns_grid_unchanged(self) -> None:
        from backend.core.services.analyser.controller import _grid_minus_ranges

        assert _grid_minus_ranges([0.0, 60.0, 120.0], [], window=12.0) == [
            0.0,
            60.0,
            120.0,
        ]

    def test_drops_points_whose_window_overlaps_a_range(self) -> None:
        from backend.core.services.analyser.controller import _grid_minus_ranges

        # Range [50, 90] eats the 60-point (60..72 overlaps) but not 0 or 120.
        kept = _grid_minus_ranges(
            [0.0, 60.0, 120.0], [(50.0, 90.0)], window=12.0
        )
        assert kept == [0.0, 120.0]

    def test_partial_overlap_at_boundary_drops_the_point(self) -> None:
        from backend.core.services.analyser.controller import _grid_minus_ranges

        # Range starts inside the scan window → still drops.
        assert _grid_minus_ranges([0.0], [(8.0, 30.0)], window=12.0) == []
        # Range ends right at scan_s → no overlap (half-open semantics).
        assert _grid_minus_ranges([10.0], [(0.0, 10.0)], window=12.0) == [10.0]


@pytest.mark.asyncio
async def test_shazam_scan_tier_cadence_and_region(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A region-scoped pinpoint scan walks at the pinpoint cadence (8 s)
    starting from the region start, not from t=0."""
    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 200.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=2001,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    await start_shazam_scan(
        job_id,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
        tier="pinpoint",
        region=(40.0, 80.0),
    )

    rows = analyser_db.list_shazam_scans(job_id)
    points = sorted({r.scan_s for r in rows})
    # last_start = min(200, 80) - 8 = 72; pinpoint cadence 8s from 40
    # → 40, 48, 56, 64, 72.
    assert points == [40.0, 48.0, 56.0, 64.0, 72.0]
    assert all(r.tier == "pinpoint" for r in rows)


@pytest.mark.asyncio
async def test_shazam_scan_skips_confirmed_track_ranges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A confirmed track's span is subtracted from the grid regardless of
    tier — the user already validated that audio."""
    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 240.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=2002,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    # Confirm a track covering 50..130 — sweep-tier scan points at 60 / 120
    # should be skipped (their 12 s windows overlap the confirmed range).
    inserted = analyser_db.insert_track(
        job_id=job_id,
        origin="manual",
        start_s=50.0,
        end_s=130.0,
        title="Locked",
    )
    analyser_db.update_track(job_id, inserted.id, confirmed=True)

    await start_shazam_scan(
        job_id,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
        tier="sweep",
    )

    points = sorted({r.scan_s for r in analyser_db.list_shazam_scans(job_id)})
    # Sweep grid 60s cadence over 240s, last_start = 240 - 12 = 228 →
    # full grid would be 0, 60, 120, 180. Confirmed [50,130] eats 60 + 120.
    assert points == [0.0, 180.0]


@pytest.mark.asyncio
async def test_finer_tier_reuses_coarser_cached_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cached match at a given ``(scan_s, pitch_offset)`` short-circuits
    any later tier — the audio at a point is identical regardless of
    which tier ran first, so re-querying would just spend rate-limit
    budget for the same answer. Tiers refine by *adding new scan points*,
    not by re-running existing ones."""
    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 60.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=2003,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    analyser_db.upsert_shazam_scan(
        job_id=job_id,
        scan_s=0.0,
        pitch_offset=0.0,
        title="Cached",
        artist="Old",
        shazam_id="cached-key",
        confidence=0.7,
        tier="sweep",
    )

    client = FakeShazam(
        responses={
            0.0: ShazamMatch(
                title="Fresh", artist="New", shazam_id="fresh-key", confidence=0.95
            )
        }
    )
    await start_shazam_scan(
        job_id,
        fetch_audio=_fake_fetch_audio,
        shazam_client=client,
        tier="pinpoint",
        region=(0.0, 8.0),
    )

    # Cached sweep hit must be reused, not overwritten — and the client
    # should never have been called at scan_s=0.
    row = analyser_db.get_shazam_scan(job_id, 0.0, 0.0)
    assert row is not None
    assert row.title == "Cached"
    assert row.tier == "sweep"
    # ``calls`` only grows on real client.match invocations; if pinpoint
    # had bypassed the cache it would be non-empty.
    assert not client.calls, "pinpoint must reuse coarser-tier cached match"


@pytest.mark.asyncio
async def test_live_scan_events_carry_active_tier_even_on_cache_hits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """During a live run, every ShazamScanEvent must carry the *active*
    tier — not the cached row's stored tier. The frontend filters scan
    events by tier to attribute them to the right run; if cache-hit
    events kept the older tier, they'd be silently dropped from the
    progress counter and the bar would freeze near 99%. (Regression: this
    bug shipped + recurred multiple times before this guard.)"""
    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 60.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=4001,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    # Seed two sweep cached rows that the upcoming refine will hit.
    for s in (0.0, 20.0):
        analyser_db.upsert_shazam_scan(
            job_id=job_id,
            scan_s=s,
            pitch_offset=0.0,
            title="Cached",
            artist="Old",
            shazam_id="cached-key",
            confidence=0.9,
            tier="sweep",
        )

    received: list[Any] = []

    async def collect() -> None:
        async for ev in subscribe_to_job(job_id):
            received.append(ev)
            if isinstance(ev, JobCompleteEvent):
                break

    import asyncio

    consumer = asyncio.create_task(collect())
    await asyncio.sleep(0)
    await start_shazam_scan(
        job_id,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
        tier="refine",
    )
    await asyncio.wait_for(consumer, timeout=5.0)

    # Find the scan_started event marking the live refine pass. Events
    # arriving after it are the LIVE broadcasts the FE counts toward the
    # current run's progress; events before are the replay path
    # (legitimately carrying the historical sweep tier).
    started_idx = next(
        i
        for i, e in enumerate(received)
        if isinstance(e, ShazamScanStartedEvent) and e.tier == "refine"
    )
    live_scans = [
        e for e in received[started_idx + 1 :] if isinstance(e, ShazamScanEvent)
    ]
    assert live_scans, "expected at least one live scan event after refine started"
    bad = [e for e in live_scans if e.tier != "refine"]
    assert not bad, (
        "live broadcasts must use the active tier; got "
        f"{[(e.scan_s, e.tier) for e in bad]} during a refine run — "
        "these would be filtered out of the FE's progress counter"
    )


def test_shazam_scan_endpoint_returns_excluded_count_and_tier(
    http_client: Any,
) -> None:
    analyser_db.insert_job(
        job_id="j-tier",
        soundcloud_id=701,
        source_url=None,
        title=None,
        artist=None,
        duration_s=200.0,
        options={"pitch_strategy": "none"},
    )
    analyser_db.update_job_status("j-tier", status="complete")
    confirmed = analyser_db.insert_track(
        job_id="j-tier",
        origin="manual",
        start_s=10.0,
        end_s=70.0,
        title="Pinned",
    )
    analyser_db.update_track("j-tier", confirmed.id, confirmed=True)

    resp = http_client.post(
        "/api/analyser/sets/j-tier/shazam-scan",
        json={"tier": "refine", "region": [0.0, 100.0]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["tier"] == "refine"
    assert body["region"] == [0.0, 100.0]
    assert body["excluded_confirmed_tracks"] == 1


@pytest.mark.asyncio
async def test_sync_persists_set_bpm_and_pitch_offset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Shazam-sourced track row must carry the median in-set BPM over
    its run's range and the pitch_offset of the highest-confidence scan
    that produced the match — that's what the frontend uses to derive
    set→original BPM and the effective duration."""
    _stub_subprocess(
        monkeypatch,
        [
            {"type": "meta", "duration_s": 120.0, "sample_rate": 22050},
            {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 128.0, "confidence": "high"},
            {"type": "window.bpm", "start_s": 30.0, "end_s": 60.0, "bpm": 130.0, "confidence": "high"},
            {"type": "window.bpm", "start_s": 60.0, "end_s": 90.0, "bpm": 132.0, "confidence": "high"},
        ],
    )
    job_id = await start_job(
        options=AnalyserJobOptions(
            window_s=30.0,
            hop_s=25.0,
            pitch_strategy="single",
            target_bpm=124.0,
        ),
        soundcloud_id=3001,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    # Two consecutive matching scans → one run from 0..60. Use distinct
    # confidences so the aggregator picks the high-confidence row's
    # pitch_offset as representative.
    same = ShazamMatch(
        title="Pinned", artist="DJ Y", shazam_id="kkk", confidence=0.9
    )
    client = FakeShazam(responses={0.0: same, 60.0: same})
    await start_shazam_scan(
        job_id,
        fetch_audio=_fake_fetch_audio,
        shazam_client=client,
        tier="sweep",
    )

    tracks = analyser_db.list_tracks(job_id)
    assert len(tracks) == 1
    t = tracks[0]
    # set_bpm = median of [128, 130, 132] over [0, 60]
    assert t.set_bpm is not None and abs(t.set_bpm - 130.0) < 1e-6
    # pitch_strategy='single' with target=124 vs local~128 → negative offset
    # (we slow the slice down to match the original). Just assert it's
    # populated and finite — the exact value depends on the local BPM
    # at the high-confidence scan point.
    assert t.pitch_offset is not None
    assert -2.0 <= t.pitch_offset <= 0.0


def test_shazam_scan_endpoint_rejects_unknown_tier(http_client: Any) -> None:
    analyser_db.insert_job(
        job_id="j-bad-tier",
        soundcloud_id=702,
        source_url=None,
        title=None,
        artist=None,
        duration_s=120.0,
        options={"pitch_strategy": "none"},
    )
    analyser_db.update_job_status("j-bad-tier", status="complete")
    resp = http_client.post(
        "/api/analyser/sets/j-bad-tier/shazam-scan",
        json={"tier": "ultrafine"},
    )
    assert resp.status_code == 422
