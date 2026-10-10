"""Section detection on synthetic per-bar levels."""

from __future__ import annotations

import pytest

from backend.domain.arrangement import BarLevels, Section, detect_sections, validate_sections

SILENT = -70.0


def _bar(
    kick: float,
    bass: float,
    mix: float,
    *,
    drums: float | None = None,
    other: float = -20,
    high: float = -18,
    width: float = 0.02,
) -> BarLevels:
    return BarLevels(
        kick_db=kick,
        drums_db=drums if drums is not None else min(kick + 6, -4),
        bass_db=bass,
        other_db=other,
        mix_db=mix,
        high_db=high,
        width=width,
    )


KICK = _bar(-11, SILENT, -2.5, high=-16)
GROOVE = _bar(-11, -5, -0.5)
FILTERED = _bar(-12, -5, -3, high=-30, width=0.1)
BREAKDOWN = _bar(SILENT, SILENT, -11, drums=SILENT, other=-12, high=-30, width=0.6)
BUILD = _bar(-17, SILENT, -6, high=-17, width=0.2)
ROLL = _bar(SILENT, SILENT, -8, drums=-20, other=-12, high=-20, width=0.2)
FILL = _bar(-55, -14, -7)
TAIL = _bar(SILENT, SILENT, -25, drums=SILENT, other=-40, high=-30, width=1.0)


def _track(*runs: tuple[BarLevels, int]) -> list[BarLevels]:
    return [bar for bar, count in runs for _ in range(count)]


def test_labels_a_dj_arrangement() -> None:
    bars = _track(
        (KICK, 16),
        (GROOVE, 32),
        (BUILD, 16),
        (GROOVE, 48),
        (BREAKDOWN, 16),
        (FILTERED, 16),
        (BUILD, 16),
        (GROOVE, 48),
        (KICK, 16),
        (TAIL, 2),
    )
    assert detect_sections(bars) == [
        Section(1, 16, "intro"),
        Section(17, 48, "groove"),
        Section(49, 64, "build"),
        Section(65, 112, "main"),
        Section(113, 128, "breakdown"),
        Section(129, 144, "filtered"),
        Section(145, 160, "build"),
        Section(161, 208, "main"),
        Section(209, 224, "outro"),
        Section(225, 226, "tail"),
    ]


def test_bass_entering_mid_phrase_starts_a_section() -> None:
    bars = _track((KICK, 8), (GROOVE, 24))
    assert detect_sections(bars) == [Section(1, 8, "intro"), Section(9, 32, "groove")]


def test_one_and_two_bar_fills_dont_split_a_section() -> None:
    eight = [GROOVE] * 7 + [FILL]
    bars = eight * 2 + [GROOVE] * 6 + [FILL, FILL] + eight * 2
    assert detect_sections(bars) == [Section(1, 40, "groove")]


def test_short_bassless_gap_between_grooves_is_a_break() -> None:
    bars = _track((GROOVE, 16), (BUILD, 8), (GROOVE, 16))
    assert [s.label for s in detect_sections(bars)] == ["groove", "break", "main"]


def test_drum_rolls_into_a_kick_build_are_one_build() -> None:
    bars = _track((GROOVE, 16), (BREAKDOWN, 16), (ROLL, 16), (BUILD, 8), (GROOVE, 16))
    assert detect_sections(bars) == [
        Section(1, 16, "groove"),
        Section(17, 32, "breakdown"),
        Section(33, 56, "build"),
        Section(57, 72, "main"),
    ]


def test_boundary_follows_the_change_off_the_phrase_line() -> None:
    bars = _track((GROOVE, 34), (KICK, 10))
    assert [s.start_bar for s in detect_sections(bars)] == [1, 35]


def test_short_section_inside_the_track_joins_a_neighbour() -> None:
    bars = _track((GROOVE, 16), (BREAKDOWN, 16), (GROOVE, 4), (BREAKDOWN, 16), (GROOVE, 16))
    assert all(s.end_bar - s.start_bar + 1 >= 8 for s in detect_sections(bars))


def test_empty_track_has_no_sections() -> None:
    assert detect_sections([]) == []


def test_valid_sections_pass() -> None:
    validate_sections([Section(1, 16, "intro"), Section(17, 32, "drop")], n_bars=32)


@pytest.mark.parametrize(
    "sections",
    [
        [Section(1, 16, "intro"), Section(18, 32, "drop")],
        [Section(1, 16, "intro"), Section(16, 32, "drop")],
        [Section(1, 16, "intro")],
        [Section(1, 40, "intro")],
        [Section(1, 32, " ")],
        [Section(2, 32, "drop")],
    ],
    ids=["gap", "overlap", "short", "too-long", "blank-label", "late-start"],
)
def test_invalid_sections_raise(sections: list[Section]) -> None:
    with pytest.raises(ValueError):
        validate_sections(sections, n_bars=32)
