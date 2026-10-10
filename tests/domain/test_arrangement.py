"""Section detection on synthetic per-bar levels."""

from __future__ import annotations

from backend.domain.arrangement import BarLevels, Section, detect_sections

SILENT = -70.0
KICK = BarLevels(kick_db=-11, bass_db=SILENT, mix_db=-2.5, high_db=-16, width=0.02)
GROOVE = BarLevels(kick_db=-11, bass_db=-5, mix_db=-0.5, high_db=-18, width=0.02)
FILTERED = BarLevels(kick_db=-12, bass_db=-5, mix_db=-3, high_db=-30, width=0.1)
BREAKDOWN = BarLevels(kick_db=SILENT, bass_db=SILENT, mix_db=-11, high_db=-30, width=0.6)
BUILD = BarLevels(kick_db=-17, bass_db=SILENT, mix_db=-6, high_db=-17, width=0.2)
TAIL = BarLevels(kick_db=SILENT, bass_db=SILENT, mix_db=-25, high_db=-30, width=1.0)


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


def test_boundaries_snap_to_phrases() -> None:
    bars = _track((GROOVE, 20), (BREAKDOWN, 12), (GROOVE, 16))
    starts = [s.start_bar for s in detect_sections(bars)]
    assert all((start - 1) % 16 == 0 for start in starts)


def test_empty_track_has_no_sections() -> None:
    assert detect_sections([]) == []
