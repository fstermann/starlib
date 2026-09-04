"""Tests for the on-disk peaks cache (no ffmpeg required)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.infra.analyser import peaks as peaks_infra


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(
        peaks_infra,
        "get_backend_settings",
        lambda: SimpleNamespace(cache_dir=tmp_path),
    )
    return tmp_path


def test_round_trip(cache_dir: Path) -> None:
    peaks_infra._save_cached(7, [0.0, 0.5, 1.0], 12.5, 128.0, source_mtime=100.0)
    assert peaks_infra._load_cached(7, 100.0) == ([0.0, 0.5, 1.0], 12.5, 128.0)


def test_round_trip_without_bpm(cache_dir: Path) -> None:
    peaks_infra._save_cached(7, [0.1], 1.0, None, source_mtime=100.0)
    assert peaks_infra._load_cached(7, 100.0) == ([0.1], 1.0, None)


def test_mtime_mismatch_invalidates(cache_dir: Path) -> None:
    peaks_infra._save_cached(7, [0.1], 1.0, None, source_mtime=100.0)
    assert peaks_infra._load_cached(7, 101.0) is None


def test_version_bump_invalidates(cache_dir: Path) -> None:
    # A cache file baked at an older density (lower version) is not served.
    stale = {
        "peaks": [0.1],
        "duration_s": 1.0,
        "bpm": None,
        "source_mtime": 100.0,
        "version": peaks_infra._CACHE_VERSION - 1,
    }
    peaks_infra._peaks_cache_path(7).write_text(json.dumps(stale))
    assert peaks_infra._load_cached(7, 100.0) is None


def test_missing_file_returns_none(cache_dir: Path) -> None:
    assert peaks_infra._load_cached(999, 100.0) is None


def test_read_cached_bpm_returns_value_without_mtime(cache_dir: Path) -> None:
    # No source_mtime is passed: the cheap lookup ignores it on purpose.
    peaks_infra._save_cached(7, [0.1], 1.0, 128.0, source_mtime=100.0)
    assert peaks_infra.read_cached_bpm(7) == (True, 128.0)


def test_read_cached_bpm_present_but_none(cache_dir: Path) -> None:
    peaks_infra._save_cached(7, [0.1], 1.0, None, source_mtime=100.0)
    assert peaks_infra.read_cached_bpm(7) == (True, None)


def test_read_cached_bpm_missing_file(cache_dir: Path) -> None:
    assert peaks_infra.read_cached_bpm(999) == (False, None)


def test_read_cached_bpm_version_bump_not_served(cache_dir: Path) -> None:
    stale = {
        "peaks": [0.1],
        "duration_s": 1.0,
        "bpm": 128.0,
        "source_mtime": 100.0,
        "version": peaks_infra._CACHE_VERSION - 1,
    }
    peaks_infra._peaks_cache_path(7).write_text(json.dumps(stale))
    assert peaks_infra.read_cached_bpm(7) == (False, None)


def _run_bpm(fake_run: object) -> float | None:
    with (
        patch.object(peaks_infra.binary_locator, "find_analyser_binary", return_value="bin"),
        patch.object(peaks_infra, "run_analyser_subprocess", new=AsyncMock(side_effect=fake_run)),
    ):
        return asyncio.run(peaks_infra.detect_bpm(Path("x")))


def test_detect_bpm_returns_median() -> None:
    async def fake_run(*, binary_path, input_path, options, listener):
        await listener({"type": "window.bpm", "bpm": 128.0})
        await listener({"type": "window.bpm", "bpm": 130.0})
        await listener({"type": "section.detected"})  # non-BPM lines ignored
        return 0

    assert _run_bpm(fake_run) == 129.0


def test_detect_bpm_none_on_nonzero_exit() -> None:
    async def fake_run(*, binary_path, input_path, options, listener):
        await listener({"type": "window.bpm", "bpm": 128.0})
        return 1

    assert _run_bpm(fake_run) is None


def test_detect_bpm_none_when_no_windows() -> None:
    async def fake_run(*, binary_path, input_path, options, listener):
        return 0

    assert _run_bpm(fake_run) is None


def test_detect_bpm_none_on_error() -> None:
    async def fake_run(*, binary_path, input_path, options, listener):
        raise RuntimeError("binary missing")

    assert _run_bpm(fake_run) is None
