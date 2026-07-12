"""Tests for the Rekordbox ANLZ analysis parsers.

Builds synthetic ANLZ tag bytes (beatgrid, detail waveform, phrase sections,
cues) so the parsers are exercised offline without real Rekordbox files.
"""

from __future__ import annotations

import struct

from pyrekordbox.anlz.file import XOR_MASK

from backend.core.services.rekordbox import analysis as A
from backend.core.services.rekordbox.base import extract_pwv3, extract_pwv5


def _anlz(*tags: bytes) -> bytes:
    body = b"".join(tags)
    return b"PMAI" + struct.pack(">II", 16, 16 + len(body)) + struct.pack(">I", 0) + body


def _pqtz(beats: list[tuple[int, int, int]]) -> bytes:
    content = struct.pack(">II", 0, 0x80000) + struct.pack(">I", len(beats))
    for beat, tempo, time_ms in beats:
        content += struct.pack(">HHI", beat, tempo, time_ms)
    return b"PQTZ" + struct.pack(">II", 24, 12 + len(content)) + content


def _detail(fourcc: bytes, entry_bytes: int, entries: bytes) -> bytes:
    n = len(entries) // entry_bytes
    body = struct.pack(">III", entry_bytes, n, 0) + entries
    return fourcc + struct.pack(">II", 24, 12 + len(body)) + body


def _pcp2(hot_cue: int, time_ms: int, rgb: tuple[int, int, int]) -> bytes:
    r, g, b = rgb
    e = b"PCP2" + struct.pack(">III", 16, 48, hot_cue) + struct.pack(">B", 1) + b"\x00" * 3
    e += struct.pack(">i", time_ms) + struct.pack(">i", -1) + struct.pack(">B", 0) + b"\x00" * 7
    e += struct.pack(">HH", 0, 0) + struct.pack(">I", 0) + struct.pack(">BBBB", 0, r, g, b)
    return e


def _pco2(cue_type: int, entries: list[bytes]) -> bytes:
    content = struct.pack(">I", cue_type) + struct.pack(">HH", len(entries), 0) + b"".join(entries)
    return b"PCO2" + struct.pack(">II", 20, 12 + len(content)) + content


def _pssi(mood: int, end_beat: int, entries: list[tuple[int, int, int]], *, garble: bool = False) -> bytes:
    """Build a PSSI tag; ``entries`` are ``(index, beat, kind)`` triples."""
    body = struct.pack(">IHH", 24, len(entries), mood)
    body += b"\x00" * 6 + struct.pack(">H", end_beat) + b"\x00" * 2 + b"\x00" + b"\x00"
    for index, beat, kind in entries:
        body += struct.pack(">HHH", index, beat, kind) + b"\x00" * 18
    tag = b"PSSI" + struct.pack(">II", 32, 12 + len(body)) + body
    if garble:
        # Scramble every byte past offset 18 exactly as Rekordbox exports do.
        out = bytearray(tag)
        len_entries = len(entries)
        for x in range(len(out) - 18):
            out[18 + x] ^= (XOR_MASK[x % len(XOR_MASK)] + len_entries) & 0xFF
        tag = bytes(out)
    return tag


_BEATS = [((i % 4) + 1, 12800, i * 469) for i in range(64)]


def test_parse_beatgrid() -> None:
    beats = A.parse_beatgrid(_anlz(_pqtz(_BEATS[:4])))
    assert len(beats) == 4
    assert beats[0] == A.Beat(beat=1, bpm=128.0, time_ms=0)
    assert beats[3].beat == 4


def test_parse_beatgrid_absent() -> None:
    assert A.parse_beatgrid(None) == []
    assert A.parse_beatgrid(_anlz()) == []


def test_extract_detail_waveforms() -> None:
    color = struct.pack(">HHH", 0xE07C, 0x1C40, 0x0380)
    assert extract_pwv5(_anlz(_detail(b"PWV5", 2, color))) == color
    blue = bytes([0x1F, 0xE0, 0x05])
    assert extract_pwv3(_anlz(_detail(b"PWV3", 1, blue))) == blue


def test_extract_detail_wrong_width_rejected() -> None:
    # A PWV5 tag claiming 1 byte/column is malformed and must be rejected.
    assert extract_pwv5(_anlz(_detail(b"PWV5", 1, b"\x00\x00"))) is None


def test_parse_cues_prefers_pco2() -> None:
    ext = _anlz(
        _pco2(1, [_pcp2(1, 1406, (0xFF, 0x88, 0x00))]),
        _pco2(0, [_pcp2(0, 5000, (0, 0, 0))]),
    )
    cues = A.parse_cues(None, ext)
    assert cues[0] == A.Cue(type="hot", index=1, time_ms=1406, color="#ff8800", comment=None)
    assert cues[1] == A.Cue(type="memory", index=None, time_ms=5000, color=None, comment=None)


class _CueRow:
    """Minimal stand-in for a pyrekordbox ``djmdCue`` ORM row."""

    def __init__(self, **kw: object) -> None:
        self.__dict__.update(kw)


def test_cues_from_db_rows_maps_kind_time_and_sorts() -> None:
    rows = [
        _CueRow(Kind=0, InMsec=25387, OutMsec=-1, Comment=None),
        _CueRow(Kind=1, InMsec=124, OutMsec=12756, Comment=""),  # hot loop → slot A
        _CueRow(Kind=2, InMsec=5000, OutMsec=-1, Comment="drop"),
        _CueRow(Kind=0, InMsec=-1, OutMsec=-1, Comment=None),  # negative → dropped
    ]
    cues = A.cues_from_db_rows(rows)
    assert [c.time_ms for c in cues] == [124, 5000, 25387]  # sorted, negative gone
    # Loop hot cue carries its out-point; point cues have out_ms=None.
    assert cues[0] == A.Cue(type="hot", index=1, time_ms=124, color=None, comment=None, out_ms=12756)
    assert cues[1] == A.Cue(type="hot", index=2, time_ms=5000, color=None, comment="drop")
    assert cues[1].out_ms is None
    assert cues[2].type == "memory" and cues[2].index is None


def test_cues_from_db_rows_empty() -> None:
    assert A.cues_from_db_rows([]) == []


def test_parse_sections_plain() -> None:
    ext = _anlz(_pssi(2, 33, [(1, 1, 1), (2, 17, 9)]))
    sections = A.parse_sections(ext, [A.Beat((i % 4) + 1, 128.0, i * 469) for i in range(40)])
    assert sections is not None
    assert sections[0] == A.Section(kind="intro", label="Intro", start_ms=0, end_ms=7504)
    assert sections[1].label == "Chorus"


def test_parse_sections_unmasks_garbled_pssi() -> None:
    beatgrid = [A.Beat((i % 4) + 1, 128.0, i * 469) for i in range(40)]
    plain = A.parse_sections(_anlz(_pssi(2, 33, [(1, 1, 1), (2, 17, 9)])), beatgrid)
    garbled = A.parse_sections(_anlz(_pssi(2, 33, [(1, 1, 1), (2, 17, 9)], garble=True)), beatgrid)
    assert garbled == plain


def test_parse_sections_absent() -> None:
    assert A.parse_sections(None, [A.Beat(1, 128.0, 0)]) is None
    assert A.parse_sections(_anlz(), [A.Beat(1, 128.0, 0)]) is None
