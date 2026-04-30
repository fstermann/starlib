"""Regression tests for analyser bugfixes (issue #403 follow-up).

Each test pins down behaviour for one concrete bug from the ultrareview
audit. The controller pipeline is exercised with the real DB but a mocked
``run_analyser_subprocess`` so the suite stays hermetic and fast.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from backend.core.db import engine as db_engine
from backend.core.db.migrations import run_migrations
from backend.core.services.analyser import (
    AnalyserJobOptions,
    JobNotFoundError,
    reanalyse_job,
    start_job,
    subscribe_to_job,
)
from backend.core.services.analyser import controller as analyser_controller
from backend.core.services.analyser import db as analyser_db
from backend.core.services.analyser.events import (
    JobCompleteEvent,
    SectionDetectedEvent,
    TrackIdentifiedEvent,
    WindowBpmEvent,
)
from backend.core.services.analyser.shazam import ShazamMatch, _parse_shazamio_response


# ---------------------------------------------------------------------------
# Test scaffolding
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    db_path = tmp_path / "analyser.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    # Reset the in-memory job registry between tests.
    analyser_controller._jobs.clear()
    # Stub the analyser binary lookup — no subprocess actually runs.
    monkeypatch.setattr(
        "backend.core.services.analyser.controller.binary_locator.find_analyser_binary",
        lambda: "/dev/null",
    )
    yield db_path
    engine.dispose()


class FakeShazam:
    """Records ``match`` calls; returns whatever the test queues up."""

    def __init__(self, *, response: ShazamMatch | None = None) -> None:
        self._response = response
        self.calls: list[str] = []

    async def match(self, audio_path: str) -> ShazamMatch | None:
        self.calls.append(audio_path)
        return self._response


def _payloads(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Echo helper for readability — the subprocess fake just iterates these."""
    return events


def _stub_subprocess(
    monkeypatch: pytest.MonkeyPatch, *, scripts: list[list[dict[str, Any]]]
) -> list[dict[str, Any]]:
    """Patch ``run_analyser_subprocess`` to replay scripted JSON-line events.

    The fake consumes one ``script`` per call (i.e. one per pipeline pass).
    Returns the list of binary-options dicts captured per call so callers
    can assert on the region / window args sent to each pass.
    """
    captured: list[dict[str, Any]] = []
    queue = list(scripts)

    async def fake_run(*, binary_path, input_path, options, listener):
        captured.append({
            "start_s": options.start_s,
            "end_s": options.end_s,
            "window_s": options.window_s,
        })
        try:
            payload_list = queue.pop(0)
        except IndexError:
            payload_list = []
        for payload in payload_list:
            await listener(payload)
        return 0

    monkeypatch.setattr(
        "backend.core.services.analyser.controller.run_analyser_subprocess",
        fake_run,
    )
    monkeypatch.setattr(
        "backend.core.services.analyser.controller.cache.make_shazam_slice",
        _fake_make_slice,
    )
    return captured


async def _fake_make_slice(*, job_id, section_index, source, start_s, duration_s, pitch_semitones):
    return Path("/tmp/fake-slice.mp3")


async def _fake_fetch_audio() -> Path:
    return Path("/tmp/fake-source.mp4")


# ---------------------------------------------------------------------------
# Issue 6: shazamio parser tolerates ``track.hub: null``
# ---------------------------------------------------------------------------


def test_parse_shazamio_response_handles_null_hub() -> None:
    """``track.hub`` can come back as JSON ``null``; parser must not crash."""
    raw = {"track": {"title": "Foo", "subtitle": "Bar", "key": "k1", "hub": None}}
    match = _parse_shazamio_response(raw)
    assert match == ShazamMatch(title="Foo", artist="Bar", shazam_id="k1", confidence=0.6)


def test_parse_shazamio_response_with_hub_actions() -> None:
    raw = {"track": {"title": "Foo", "subtitle": "Bar", "key": "k1", "hub": {"actions": [{}]}}}
    match = _parse_shazamio_response(raw)
    assert match is not None and match.confidence == 0.95


# ---------------------------------------------------------------------------
# Issue 10: stale ``running`` jobs marked as error on startup
# ---------------------------------------------------------------------------


def test_mark_running_jobs_as_error_transitions_pending_and_running() -> None:
    analyser_db.insert_job(
        job_id="j-pending",
        soundcloud_id=None,
        source_url=None,
        title=None,
        artist=None,
        duration_s=None,
        options={},
    )
    analyser_db.insert_job(
        job_id="j-running",
        soundcloud_id=None,
        source_url=None,
        title=None,
        artist=None,
        duration_s=None,
        options={},
    )
    analyser_db.update_job_status("j-running", status="running")
    analyser_db.insert_job(
        job_id="j-complete",
        soundcloud_id=None,
        source_url=None,
        title=None,
        artist=None,
        duration_s=None,
        options={},
    )
    analyser_db.update_job_status("j-complete", status="complete")

    moved = analyser_db.mark_running_jobs_as_error("backend restarted")
    assert moved == 2
    assert analyser_db.get_job("j-pending").status == "error"  # type: ignore[union-attr]
    assert analyser_db.get_job("j-running").status == "error"  # type: ignore[union-attr]
    assert analyser_db.get_job("j-complete").status == "complete"  # type: ignore[union-attr]
    assert analyser_db.get_job("j-running").error == "backend restarted"  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# Issue 14: delete_windows_in_range matches the docstring (start_s)
# ---------------------------------------------------------------------------


def test_delete_windows_in_range_uses_start_s_not_midpoint() -> None:
    analyser_db.insert_job(
        job_id="j",
        soundcloud_id=None,
        source_url=None,
        title=None,
        artist=None,
        duration_s=None,
        options={},
    )
    # A window starting at 10s, ending at 40s — start_s inside [0, 20] but
    # midpoint at 25 outside it. The docstring (post-fix) says deletion is
    # by start_s, so this row must go.
    analyser_db.upsert_window_bpm(job_id="j", start_s=10.0, end_s=40.0, bpm=120.0, confidence="high")
    analyser_db.upsert_window_bpm(job_id="j", start_s=50.0, end_s=70.0, bpm=120.0, confidence="high")
    analyser_db.delete_windows_in_range("j", 0.0, 20.0)
    rows = analyser_db.list_windows("j")
    assert [w.start_s for w in rows] == [50.0]


# ---------------------------------------------------------------------------
# Issue 1 + 7 + 13 + 15: re-analyse a completed job
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reanalyse_revives_completed_job_persists_overrides_and_keeps_meta(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A completed job must be re-analysable; overrides hit the DB; revival
    carries duration_s so the MetaEvent replay keeps working.
    """
    initial_script = [
        {"type": "meta", "duration_s": 90.0, "sample_rate": 22050},
        {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 120.0, "confidence": "high"},
        {"type": "section.detected", "index": 0, "start_s": 0.0, "end_s": 45.0, "confidence": 0.8},
        {"type": "section.detected", "index": 1, "start_s": 45.0, "end_s": 90.0, "confidence": 0.8},
    ]
    rerun_script = [
        {"type": "meta", "duration_s": 90.0, "sample_rate": 22050},
        {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 124.0, "confidence": "high"},
        {"type": "section.detected", "index": 0, "start_s": 0.0, "end_s": 45.0, "confidence": 0.9},
    ]
    captured = _stub_subprocess(monkeypatch, scripts=[initial_script, rerun_script])

    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=42,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    # Drain the initial run to completion (subscribe acts as the join).
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break
    job = analyser_db.get_job(job_id)
    assert job is not None and job.status == "complete"

    # Re-analyse the first half. Without the fix this would raise
    # JobNotFoundError because the job is finished.
    await reanalyse_job(
        job_id,
        ranges=[(0.0, 45.0)],
        overrides={"target_bpm": 125.0},
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )

    # Issue 7: overrides are persisted, not just held in memory.
    job = analyser_db.get_job(job_id)
    assert job is not None
    assert job.options.get("target_bpm") == 125.0
    assert job.status == "complete"

    # Issue 2 + 15: the survivor section (index 1) and only the in-range
    # one were touched. New rows are renumbered past the survivor.
    sections = analyser_db.list_sections(job_id)
    assert len(sections) == 2
    indices = sorted(s.section_index for s in sections)
    assert 1 in indices  # the survivor index 1 → kept
    assert max(indices) >= 2  # the new in-range section was renumbered

    # Captured pass args: 1 full (None region) + 1 partial (0..45).
    assert captured[0]["start_s"] is None
    assert captured[1]["start_s"] == 0.0 and captured[1]["end_s"] == 45.0


# ---------------------------------------------------------------------------
# Issue 3: multi-range re-analyse fires job.complete only once
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_range_reanalyse_emits_one_job_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    initial_script = [
        {"type": "meta", "duration_s": 100.0, "sample_rate": 22050},
        {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 120.0, "confidence": "high"},
    ]
    range_a = [
        {"type": "meta", "duration_s": 100.0, "sample_rate": 22050},
        {"type": "window.bpm", "start_s": 0.0, "end_s": 30.0, "bpm": 121.0, "confidence": "high"},
    ]
    range_b = [
        {"type": "meta", "duration_s": 100.0, "sample_rate": 22050},
        {"type": "window.bpm", "start_s": 60.0, "end_s": 90.0, "bpm": 122.0, "confidence": "high"},
    ]
    _stub_subprocess(monkeypatch, scripts=[initial_script, range_a, range_b])

    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=99,
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break

    # Subscribe before kicking off re-analyse so we observe its events live.
    received: list[Any] = []

    async def collect() -> None:
        async for ev in subscribe_to_job(job_id):
            received.append(ev)
            if isinstance(ev, JobCompleteEvent):
                break

    consumer = asyncio.create_task(collect())
    # Yield once so the subscriber attaches a queue before reanalyse starts.
    await asyncio.sleep(0)

    await reanalyse_job(
        job_id,
        ranges=[(0.0, 45.0), (60.0, 90.0)],
        fetch_audio=_fake_fetch_audio,
        shazam_client=FakeShazam(),
    )
    await asyncio.wait_for(consumer, timeout=5.0)

    completes = [e for e in received if isinstance(e, JobCompleteEvent)]
    assert len(completes) == 1, f"expected exactly one job.complete, got {len(completes)}"
    bpms = [e.bpm for e in received if isinstance(e, WindowBpmEvent)]
    # Both ranges' BPM events must reach the same listener.
    assert 121.0 in bpms and 122.0 in bpms


# ---------------------------------------------------------------------------
# Issue 11: cached null-title rows must not block retry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_null_title_cached_row_does_not_block_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    initial_script = [
        {"type": "meta", "duration_s": 60.0, "sample_rate": 22050},
        {"type": "section.detected", "index": 0, "start_s": 0.0, "end_s": 45.0, "confidence": 0.8},
    ]
    rerun_script = [
        {"type": "meta", "duration_s": 60.0, "sample_rate": 22050},
        {"type": "section.detected", "index": 0, "start_s": 0.0, "end_s": 45.0, "confidence": 0.9},
    ]
    _stub_subprocess(monkeypatch, scripts=[initial_script, rerun_script])

    miss_client = FakeShazam(response=None)  # caches a null-title row.
    hit_client = FakeShazam(response=ShazamMatch(title="Hit", artist="A", shazam_id="k", confidence=0.95))

    job_id = await start_job(
        options=AnalyserJobOptions(window_s=30.0, hop_s=25.0),
        soundcloud_id=7,
        fetch_audio=_fake_fetch_audio,
        shazam_client=miss_client,
    )
    async for ev in subscribe_to_job(job_id):
        if isinstance(ev, JobCompleteEvent):
            break
    # First pass produced no hit; track row may exist with title=None.
    # (Section index 0 was inserted, so re-analyse over [0, 45] will replace
    # it — issue 15 fix clears the corresponding track_id row, and issue 11
    # fix would also force a retry even if it survived.)
    await reanalyse_job(
        job_id,
        ranges=[(0.0, 45.0)],
        fetch_audio=_fake_fetch_audio,
        shazam_client=hit_client,
    )
    # The hit client must have actually been invoked — i.e. we did NOT
    # short-circuit on the cached miss.
    assert hit_client.calls, "Shazam was not retried after a cached null match"


# ---------------------------------------------------------------------------
# Issue 9: concurrent fetch_set_audio for the same id serialises
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_fetch_set_audio_runs_ffmpeg_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from backend.core.services.analyser import cache

    # Point the cache at a temp dir.
    cfg = cache.AnalyserCacheConfig(sets_dir=tmp_path / "sets", slices_dir=tmp_path / "slices")
    cfg.sets_dir.mkdir(parents=True, exist_ok=True)
    cfg.slices_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(cache, "_config", lambda: cfg)
    cache._set_audio_locks.clear()

    invocations = 0

    class FakeProc:
        returncode = 0

        async def communicate(self) -> tuple[bytes, bytes]:
            return b"", b""

    async def fake_exec(*args, **kwargs):
        nonlocal invocations
        invocations += 1
        out_path = Path(args[-1])
        await asyncio.sleep(0.05)  # widen the race window
        out_path.write_bytes(b"fake")
        return FakeProc()

    monkeypatch.setattr("backend.core.services.analyser.cache.asyncio.create_subprocess_exec", fake_exec)
    monkeypatch.setattr("backend.core.services.analyser.cache._find_ffmpeg", lambda: "/bin/true")

    # Two parallel fetches for the same id must serialise on the lock and
    # only run ffmpeg once.
    results = await asyncio.gather(
        cache.fetch_set_audio(101, hls_url="https://x"),
        cache.fetch_set_audio(101, hls_url="https://x"),
    )
    assert invocations == 1
    assert results[0] == results[1]


# ---------------------------------------------------------------------------
# Issue 1 sanity: re-analyse on a missing job still raises
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reanalyse_unknown_job_raises() -> None:
    with pytest.raises(JobNotFoundError):
        await reanalyse_job(
            "no-such-job",
            ranges=[(0.0, 10.0)],
            fetch_audio=_fake_fetch_audio,
            shazam_client=FakeShazam(),
        )
