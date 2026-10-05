"""Tests for the inputs to locating a track inside its mix."""

from __future__ import annotations

import pytest

from backend.domain.track_alignment import rate_hints, search_window


def test_rate_from_bpm_ratio_and_pitch_offset() -> None:
    hints = rate_hints(set_bpm=130.0, original_bpm=125.0, pitch_offset=-1.0)
    assert hints[0] == pytest.approx(1.04)
    assert hints[1] == pytest.approx(2 ** (1 / 12))


def test_octave_error_in_detected_bpm_is_folded() -> None:
    assert rate_hints(set_bpm=144.0, original_bpm=72.0, pitch_offset=None) == [pytest.approx(1.0)]


def test_duplicate_hints_collapse() -> None:
    assert rate_hints(set_bpm=128.0, original_bpm=128.0, pitch_offset=0.0) == [pytest.approx(1.0)]


def test_falls_back_to_original_tempo() -> None:
    assert rate_hints(None, None, None) == [1.0]


def test_window_spans_a_track_length_either_side() -> None:
    assert search_window(600.0, 300.0, 1.0, None) == (285.0, 915.0)


def test_window_clamps_to_set() -> None:
    start, end = search_window(100.0, 300.0, 1.0, 350.0)
    assert (start, end) == (0.0, 350.0)
