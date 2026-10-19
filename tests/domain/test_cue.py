"""Tests for CUE sheet parsing."""

from __future__ import annotations

import pytest

from backend.domain.cue import CueTrack, decode_cue, drop_repeats, parse_cue

SHEET = """REM GENRE Techno
PERFORMER "DJ Example"
TITLE "Live at Somewhere"
FILE "set.wav" WAVE
  TRACK 01 AUDIO
    TITLE "Opening"
    PERFORMER "Artist A"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Don't Stop"
    PERFORMER "Artist B"
    INDEX 00 05:59:00
    INDEX 01 06:00:37
\tTRACK 03 AUDIO
\t\tTITLE Unquoted Title
\t\tINDEX 01 72:30:00
"""


def test_parses_sheet_and_tracks() -> None:
    sheet = parse_cue(SHEET)

    assert sheet.title == "Live at Somewhere"
    assert sheet.performer == "DJ Example"
    assert [(t.title, t.performer) for t in sheet.tracks] == [
        ("Opening", "Artist A"),
        ("Don't Stop", "Artist B"),
        ("Unquoted Title", None),
    ]


def test_start_is_index_01_in_frames_of_75() -> None:
    starts = [t.start_s for t in parse_cue(SHEET).tracks]

    assert starts[0] == 0.0
    assert starts[1] == pytest.approx(360 + 37 / 75)
    # Minutes run past 59 in a long set.
    assert starts[2] == 72 * 60 + 30


def test_index_00_stands_in_when_there_is_no_index_01() -> None:
    sheet = parse_cue('TRACK 01 AUDIO\n TITLE "Only pregap"\n INDEX 00 01:00:00\n')

    assert sheet.tracks[0].start_s == 60.0


def test_tracks_are_sorted_and_tracks_without_index_skipped() -> None:
    sheet = parse_cue(
        'TRACK 01 AUDIO\n TITLE "B"\n INDEX 01 02:00:00\n'
        'TRACK 02 AUDIO\n TITLE "No index"\n'
        'TRACK 03 AUDIO\n TITLE "A"\n INDEX 01 01:00:00\n'
    )

    assert [t.title for t in sheet.tracks] == ["A", "B"]


def test_sheet_without_timed_tracks_is_rejected() -> None:
    with pytest.raises(ValueError, match="no tracks"):
        parse_cue('TITLE "Empty"\nTRACK 01 AUDIO\n')


def test_decodes_utf8_with_bom_and_cp1252() -> None:
    assert decode_cue('﻿TITLE "Café"'.encode()) == 'TITLE "Café"'
    assert decode_cue('TITLE "Café"'.encode("cp1252")) == 'TITLE "Café"'


REKORDBOX_SHEET = """REM DATE 2026-10-17 05:54 PM
REM RECORDED_BY "rekordbox-dj"
TITLE "REC-2026-10-17"
FILE "01 REC-2026-10-17.wav" WAVE
\tTRACK 01 AUDIO
\t\tTITLE "RR3"
\t\tPERFORMER "Vitess"
\t\tFILE "/Music/cleaned/Vitess - RR3.aiff" WAVE
\t\tINDEX 01 00:00:00
\tTRACK 02 AUDIO
\t\tTITLE "In Your Arms"
\t\tFILE "/Music/collection/Brent Honey, Homage - In Your Arms.aiff" WAVE
\t\tINDEX 01 00:57:31
"""


def test_rekordbox_timestamps_are_hours_minutes_seconds() -> None:
    starts = [t.start_s for t in parse_cue(REKORDBOX_SHEET).tracks]

    assert starts == [0, 57 * 60 + 31]


def test_keeps_each_tracks_source_file() -> None:
    files = [t.file for t in parse_cue(REKORDBOX_SHEET).tracks]

    assert files == ["/Music/cleaned/Vitess - RR3.aiff", "/Music/collection/Brent Honey, Homage - In Your Arms.aiff"]


def test_drop_repeats_keeps_the_first_entry_of_each_track() -> None:
    tracks = [
        CueTrack(0, "La Musica", "NewTone", "/lib/la-musica.aiff"),
        CueTrack(60, "Phonic Sound", "STEPPA", "/lib/phonic.aiff"),
        CueTrack(120, "La Musica", "NewTone", "/lib/la-musica.aiff"),
        CueTrack(180, "Bassline", "JG", "/lib/bassline.aiff"),
    ]

    assert [t.start_s for t in drop_repeats(tracks)] == [0, 60, 180]


def test_drop_repeats_matches_by_tags_without_a_source_file() -> None:
    tracks = [
        CueTrack(0, "La Musica", "NewTone"),
        CueTrack(60, "la musica", "newtone"),
        CueTrack(120, "La Musica", "Other Artist"),
        CueTrack(180, None, None),
        CueTrack(240, None, None),
    ]

    assert [t.start_s for t in drop_repeats(tracks)] == [0, 120, 180, 240]
