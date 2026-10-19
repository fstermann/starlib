"""Tests for BS.1770 loudness statistics and per-segment gain suggestions."""

from __future__ import annotations

import pytest

from backend.domain.loudness import (
    LoudnessFrames,
    Segment,
    even_out,
    integrated_lufs,
    low_end_lu,
    low_end_reference,
    partition,
    summarise,
    transitions,
)

SILENCE = -200.0


def _frames(*spans: tuple[float, float]) -> LoudnessFrames:
    """Frames for consecutive ``(seconds, lufs)`` spans of steady level."""
    levels = [lufs for seconds, lufs in spans for _ in range(round(seconds * 10))]
    return LoudnessFrames(momentary=levels, short_term=levels, true_peak=[lufs + 10 for lufs in levels])


def test_integrated_of_steady_level_is_that_level() -> None:
    assert integrated_lufs([-12.0] * 100) == pytest.approx(-12.0)


def test_integrated_ignores_silence_below_absolute_gate() -> None:
    assert integrated_lufs([SILENCE] * 500 + [-10.0] * 100) == pytest.approx(-10.0)


def test_integrated_ignores_quiet_passages_below_relative_gate() -> None:
    # -40 sits more than 10 LU below the ungated mean, so it's gated out.
    assert integrated_lufs([-10.0] * 100 + [-40.0] * 100) == pytest.approx(-10.0)


def test_integrated_averages_power_not_decibels() -> None:
    # Equal time at -10 and -16: mean power is (1 + 0.251) / 2 → -10 + 10·log10(0.6256) ≈ -12.04.
    assert integrated_lufs([-10.0] * 100 + [-16.0] * 100) == pytest.approx(-12.04, abs=0.01)


def test_integrated_of_silence_is_none() -> None:
    assert integrated_lufs([SILENCE] * 50) is None


def test_summary_min_short_term_skips_fades_and_silence() -> None:
    summary = summarise(_frames((5, SILENCE), (60, -9.0), (60, -12.0), (5, -45.0)))

    assert summary.short_term_max_lufs == -9.0
    assert summary.short_term_min_lufs == -12.0
    assert summary.momentary_max_lufs == -9.0
    assert summary.true_peak_dbtp == pytest.approx(1.0)


def test_summary_of_a_span() -> None:
    summary = summarise(_frames((60, -9.0), (60, -14.0)), start_s=60.0, end_s=120.0)

    assert summary.integrated_lufs == pytest.approx(-14.0)


def test_partition_runs_each_track_until_the_next_starts() -> None:
    segments = partition([(300.0, "B"), (0.0, "A"), (900.0, "C")], duration_s=1200.0)

    assert segments == [
        Segment(0.0, 300.0, "A"),
        Segment(300.0, 900.0, "B"),
        Segment(900.0, 1200.0, "C"),
    ]


def test_partition_drops_starts_past_the_end() -> None:
    assert partition([(0.0, "A"), (1300.0, "late")], duration_s=1200.0) == [Segment(0.0, 1200.0, "A")]


def test_partition_without_tracks() -> None:
    assert partition([], duration_s=1200.0) == []


def test_even_out_levels_against_the_median_segment() -> None:
    frames = _frames((120, -10.0), (120, -10.5), (120, -7.0), (120, -13.0))
    segments = [Segment(i * 120.0, (i + 1) * 120.0, f"T{i}") for i in range(4)]

    reference, levels = even_out(frames, segments)

    # Median of -10, -10.5, -7, -13.
    assert reference == pytest.approx(-10.25)
    gains = [lvl.suggested_gain_db for lvl in levels]
    # Within tolerance of the median: leave alone.
    assert gains[0] is None and gains[1] is None
    assert gains[2] == pytest.approx(-3.25)
    assert gains[3] == pytest.approx(2.75)


def test_even_out_skips_silent_segments() -> None:
    frames = _frames((60, -10.0), (60, SILENCE))

    reference, levels = even_out(frames, [Segment(0, 60), Segment(60, 120)])

    assert reference == pytest.approx(-10.0)
    assert len(levels) == 1


def test_even_out_skips_a_short_tail() -> None:
    # The last seconds of a mix fade out; they aren't a track to level.
    frames = _frames((120, -10.0), (120, -10.0), (5, -24.0))
    segments = [Segment(0, 120), Segment(120, 240), Segment(240, 245)]

    _reference, levels = even_out(frames, segments)

    assert [lvl.start_s for lvl in levels] == [0, 120]


def test_even_out_without_segments() -> None:
    assert even_out(_frames((10, -10.0)), []) == (None, [])


def test_low_end_is_the_low_band_relative_to_the_full_band() -> None:
    full = [-10.0] * 600
    frames = LoudnessFrames(momentary=full, short_term=full, true_peak=full, low_band=[-14.0] * 600)

    assert low_end_lu(frames) == pytest.approx(-4.0)


def test_low_end_ignores_blocks_the_full_band_gates_out() -> None:
    # A breakdown with no kick: quiet overall, so the gate drops it, along with its missing bass.
    full = [-10.0] * 300 + [-30.0] * 300
    low = [-14.0] * 300 + [-60.0] * 300
    frames = LoudnessFrames(momentary=full, short_term=full, true_peak=full, low_band=low)

    assert low_end_lu(frames) == pytest.approx(-4.0)


def test_low_end_without_a_low_band_reading() -> None:
    assert low_end_lu(_frames((60, -10.0))) is None


def test_even_out_reports_each_segments_low_end_and_their_median() -> None:
    full = [-10.0] * 1800
    low = [-12.0] * 600 + [-14.0] * 600 + [-19.0] * 600
    frames = LoudnessFrames(momentary=full, short_term=full, true_peak=full, low_band=low)
    segments = [Segment(i * 60.0, (i + 1) * 60.0) for i in range(3)]

    _reference, levels = even_out(frames, segments)

    assert [lvl.low_end_lu for lvl in levels] == pytest.approx([-2.0, -4.0, -9.0])
    assert low_end_reference(levels) == pytest.approx(-4.0)


def test_transitions_compare_the_seconds_either_side_of_each_change() -> None:
    # The last 30 s of the first track are 4 LU quieter than its body.
    frames = _frames((90, -10.0), (30, -14.0), (120, -9.0))
    segments = [Segment(0, 120, "A"), Segment(120, 240, "B")]

    [change] = transitions(frames, segments)

    assert change.at_s == 120
    assert (change.from_label, change.to_label) == ("A", "B")
    assert change.before_lufs == pytest.approx(-14.0)
    assert change.after_lufs == pytest.approx(-9.0)
    assert change.jump_lu == pytest.approx(5.0)


def test_transition_windows_stay_inside_short_tracks() -> None:
    # Track B is only 10 s long; its "after" window must not reach into C.
    frames = _frames((60, -10.0), (10, -16.0), (60, -6.0))
    segments = [Segment(0, 60), Segment(60, 70), Segment(70, 130)]

    first, second = transitions(frames, segments)

    assert first.after_lufs == pytest.approx(-16.0)
    assert second.before_lufs == pytest.approx(-16.0)


def test_transitions_skip_silent_sides() -> None:
    frames = _frames((60, -10.0), (60, SILENCE))

    assert transitions(frames, [Segment(0, 60), Segment(60, 120)]) == []
