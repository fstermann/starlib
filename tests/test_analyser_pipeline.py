"""End-to-end backend test for the analyser pipeline.

Spawns the real ``analyser-stream`` Rust subprocess against a synthetic
click-track WAV and verifies the orchestrator stitches events together
correctly: meta → window.bpm × N → section.detected × M → job.complete.
SoundCloud is bypassed via a custom audio fetcher.

The test is gated on the analyser binary being built; if it's missing it
skips with a helpful pointer rather than failing in CI.
"""

from __future__ import annotations

import asyncio
import math
import os
import struct
import wave
from pathlib import Path

import pytest

from backend.core.db import engine as db_engine
from backend.core.db.migrations import run_migrations
from backend.core.services.analyser import (
    AnalyserJobOptions,
    start_job,
    subscribe_to_job,
)
from backend.core.services.analyser import binary as analyser_binary
from backend.core.services.analyser.events import (
    JobCompleteEvent,
    MetaEvent,
    SectionDetectedEvent,
    WindowBpmEvent,
)


def _binary_available() -> bool:
    path = analyser_binary.find_analyser_binary()
    return os.path.isabs(path) and os.path.exists(path)


pytestmark = pytest.mark.skipif(
    not _binary_available(),
    reason="analyser-stream binary not built (run `cargo build -p starlib_audio --bin analyser-stream`)",
)


def _write_test_set(path: Path, *, bpm: float = 128.0, total_s: float = 90.0) -> None:
    """Synthesise a 90s click track with a timbre change at the midpoint.

    ~3 BPM windows (default 30s window, 25s hop) and one boundary near 45s
    (short of the default 90s min-gap, so we drop the gap to 30s in the
    test options).
    """
    sr = 22050
    period = 60.0 / bpm
    n = int(total_s * sr)
    data = bytearray()
    for i in range(n):
        t = i / sr
        freq = 200.0 if t < total_s / 2 else 4000.0
        base = math.sin(2 * math.pi * freq * t) * 0.4
        beat_phase = t % period
        click = math.exp(-50 * beat_phase) if beat_phase < 0.05 else 0.0
        sample = int(max(-1.0, min(1.0, base + click * 0.6)) * 32767)
        data += struct.pack("<h", sample)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(data))


@pytest.fixture(autouse=True)
def _temp_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "analyser.db"
    engine = db_engine.init_engine(db_path)
    run_migrations(engine, db_path)
    yield db_path
    engine.dispose()


@pytest.mark.asyncio
async def test_end_to_end_pipeline_emits_expected_event_sequence(tmp_path: Path) -> None:
    """A synthetic 90s set produces meta + multiple BPM events + ≥1 section + complete."""
    audio_path = tmp_path / "set.wav"
    _write_test_set(audio_path, bpm=128.0, total_s=90.0)

    async def fetcher() -> Path:
        return audio_path

    options = AnalyserJobOptions(
        window_s=30.0,
        hop_s=25.0,
        # Drop the section min-gap so the synthetic 45s boundary qualifies.
        min_section_gap_s=30.0,
    )
    job_id = await start_job(
        options=options,
        soundcloud_id=None,
        source_url=None,
        title="Synthetic Test Set",
        artist="pytest",
        fetch_audio=fetcher,
    )

    received: list = []
    async with asyncio.timeout(60):
        async for event in subscribe_to_job(job_id):
            received.append(event)
            if isinstance(event, JobCompleteEvent):
                break

    types = [type(e).__name__ for e in received]
    assert "JobCompleteEvent" in types, types
    assert "MetaEvent" in types

    metas = [e for e in received if isinstance(e, MetaEvent)]
    assert metas[0].duration_s == pytest.approx(90.0, abs=0.5)

    windows = [e for e in received if isinstance(e, WindowBpmEvent)]
    assert len(windows) >= 2, f"expected ≥2 BPM windows, got {len(windows)}"
    for w in windows:
        assert w.bpm == pytest.approx(128.0, abs=2.0), w

    sections = [e for e in received if isinstance(e, SectionDetectedEvent)]
    assert len(sections) >= 1
    # First section starts at zero.
    assert min(s.start_s for s in sections) == 0.0


@pytest.mark.asyncio
async def test_bpm_range_constraint_narrows_results(tmp_path: Path) -> None:
    """``bpm_range`` shrinks the autocorrelation search window.

    With a 128 BPM click track but a forced range of [120, 130] the
    detector must never produce a value outside the band — even when
    octave artefacts (64 / 256) would otherwise rank.
    """
    audio_path = tmp_path / "set.wav"
    _write_test_set(audio_path, bpm=128.0, total_s=60.0)

    async def fetcher() -> Path:
        return audio_path

    options = AnalyserJobOptions(
        window_s=30.0,
        hop_s=25.0,
        bpm_range=(120.0, 130.0),
        sections_enabled=False,
    )
    job_id = await start_job(
        options=options,
        soundcloud_id=None,
        fetch_audio=fetcher,
    )
    received: list = []
    async with asyncio.timeout(60):
        async for event in subscribe_to_job(job_id):
            received.append(event)
            if isinstance(event, JobCompleteEvent):
                break

    windows = [e for e in received if isinstance(e, WindowBpmEvent)]
    assert windows, "expected at least one BPM window"
    for w in windows:
        assert 119.0 <= w.bpm <= 131.0, f"BPM {w.bpm} fell outside [120,130] band"
