"""Rekordbox ANLZ analysis parsing: beatgrid, phrase sections, cues.

The preview/detail *waveform* bytes are extracted by the lightweight scanners in
:mod:`.base` and streamed to the frontend untouched. The structured analysis
here — beat positions, phrase (song-structure) sections, and hot/memory cues — is
parsed server-side into JSON so the player can draw a beatgrid, a phrase band and
cue markers over the zoomed waveform.

Beatgrid and cues live in the ``.DAT`` file; phrase sections and the extended
nxs2 cues live in the ``.EXT``. We reuse :mod:`pyrekordbox`'s ``construct`` tag
definitions (already a dependency) for the fiddly variable-length cue and
song-structure records rather than hand-rolling them, but only feed them the
small tags we care about — never the multi-hundred-KB detail waveform — so the
parse stays fast. The one piece of logic we replicate is the XOR "garbage mask"
Rekordbox applies to exported/USB ``PSSI`` tags.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Beat:
    """A single beatgrid tick."""

    beat: int  # position in the bar, 1-4 (1 = downbeat)
    bpm: float
    time_ms: int


@dataclass(frozen=True)
class Cue:
    """A memory point or hot cue."""

    type: str  # "hot" or "memory"
    index: int | None  # hot-cue slot (1-based), None for memory cues
    time_ms: int
    color: str | None  # "#RRGGBB" when the cue carries a colour, else None
    comment: str | None


@dataclass(frozen=True)
class Section:
    """A phrase (song-structure) region, resolved to a time span."""

    kind: str  # normalized: intro/up/down/verse/bridge/chorus/outro/other
    label: str  # human label, e.g. "Verse 2"
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class TrackAnalysis:
    """Structured ANLZ analysis for one track."""

    beatgrid: list[Beat]
    sections: list[Section] | None  # None when the track has no phrase analysis
    cues: list[Cue]


# Phrase labels by (mood, kind), per the deep-symmetry ANLZ analysis. Mood is
# High=1, Mid=2, Low=3; kind indexes into a mood-specific vocabulary.
_PHRASE_LABELS: dict[int, dict[int, str]] = {
    1: {1: "Intro", 2: "Up", 3: "Down", 5: "Chorus", 6: "Outro"},
    2: {
        1: "Intro",
        2: "Verse 1",
        3: "Verse 2",
        4: "Verse 3",
        5: "Verse 4",
        6: "Verse 5",
        7: "Verse 6",
        8: "Bridge",
        9: "Chorus",
        10: "Outro",
    },
    3: {
        1: "Intro",
        2: "Verse 1",
        3: "Verse 1",
        4: "Verse 2",
        5: "Verse 2",
        6: "Verse 3",
        7: "Verse 3",
        8: "Bridge",
        9: "Chorus",
        10: "Outro",
    },
}


def _normalize_kind(label: str) -> str:
    """Map a phrase label to a stable kind slug for colouring."""
    lower = label.lower()
    for kind in ("intro", "verse", "bridge", "chorus", "outro", "up", "down"):
        if lower.startswith(kind):
            return kind
    return "other"


def _walk_tags(data: bytes) -> Iterator[tuple[str, bytes]]:
    """Yield ``(fourcc, tag_bytes)`` for each ANLZ section without parsing content.

    ``tag_bytes`` spans the whole tag (its generic header + body), ready to hand
    to a ``construct`` struct.
    """
    if len(data) < 8 or data[:4] != b"PMAI":
        return
    pos = int.from_bytes(data[4:8], "big")
    while pos + 12 <= len(data):
        fourcc = data[pos : pos + 4]
        len_tag = int.from_bytes(data[pos + 8 : pos + 12], "big")
        if len_tag <= 0 or pos + len_tag > len(data):
            return
        try:
            name = fourcc.decode("ascii")
        except UnicodeDecodeError:
            return
        yield name, data[pos : pos + len_tag]
        pos += len_tag


# -- Beatgrid (PQTZ) -------------------------------------------------------------


def parse_beatgrid(dat: bytes | None) -> list[Beat]:
    """Parse the PQTZ beatgrid tag from ``.DAT`` bytes."""
    if not dat:
        return []
    for name, tag in _walk_tags(dat):
        if name != "PQTZ":
            continue
        # Content after the 12-byte generic header: u1(4) + u2(4) + entry_count(4),
        # then 8-byte ticks (beat u16, tempo u16 = BPM*100, time u32 ms).
        count = int.from_bytes(tag[20:24], "big")
        beats: list[Beat] = []
        base = 24
        for i in range(count):
            off = base + i * 8
            if off + 8 > len(tag):
                break
            beat = int.from_bytes(tag[off : off + 2], "big")
            tempo = int.from_bytes(tag[off + 2 : off + 4], "big")
            time_ms = int.from_bytes(tag[off + 4 : off + 8], "big")
            beats.append(Beat(beat=beat, bpm=tempo / 100.0, time_ms=time_ms))
        return beats
    return []


def _beat_to_ms(beat_number: int, beatgrid: list[Beat]) -> int:
    """Convert a 1-based global beat number to a time in ms via the beatgrid."""
    if not beatgrid:
        return 0
    idx = max(0, min(beat_number - 1, len(beatgrid) - 1))
    return beatgrid[idx].time_ms


# -- Cues (PCO2 preferred, PCOB fallback) ---------------------------------------


def _parse_pco2(tag: bytes) -> list[Cue]:
    """Parse an extended (nxs2) PCO2 cue tag via pyrekordbox's construct struct."""
    from pyrekordbox.anlz import structs

    parsed = structs.AnlzTag.parse(tag)
    cues: list[Cue] = []
    for e in parsed.content.entries:
        hot = int(e.hot_cue)
        color = None
        if e.color_red or e.color_green or e.color_blue:
            color = f"#{e.color_red:02x}{e.color_green:02x}{e.color_blue:02x}"
        comment = str(e.comment) if e.comment else None
        cues.append(
            Cue(
                type="hot" if hot else "memory",
                index=hot or None,
                time_ms=int(e.time),
                color=color,
                comment=comment,
            )
        )
    return cues


def _parse_pcob(tag: bytes) -> list[Cue]:
    """Parse a legacy PCOB cue tag via pyrekordbox's construct struct."""
    from pyrekordbox.anlz import structs

    parsed = structs.AnlzTag.parse(tag)
    cues: list[Cue] = []
    for e in parsed.content.entries:
        hot = int(e.hot_cue)
        cues.append(
            Cue(
                type="hot" if hot else "memory",
                index=hot or None,
                time_ms=int(e.time),
                color=None,
                comment=None,
            )
        )
    return cues


def _collect_cues(fourcc: str, parse, *blobs: bytes | None) -> list[Cue]:
    """Parse every ``fourcc`` cue tag across ``blobs`` with ``parse``, deduped."""
    cues: list[Cue] = []
    seen: set[tuple[str, int | None, int]] = set()
    for blob in blobs:
        if not blob:
            continue
        for name, tag in _walk_tags(blob):
            if name != fourcc:
                continue
            try:
                parsed = parse(tag)
            except Exception:
                logger.debug("Failed to parse %s cue tag", fourcc, exc_info=True)
                continue
            for cue in parsed:
                key = (cue.type, cue.index, cue.time_ms)
                if key not in seen:
                    seen.add(key)
                    cues.append(cue)
    return cues


def parse_cues(dat: bytes | None, ext: bytes | None) -> list[Cue]:
    """Parse cues, preferring extended nxs2 (PCO2) over legacy (PCOB) tags.

    PCO2 lives in the ``.EXT`` and carries colours/comments; when a track has it
    we use it exclusively. Otherwise we fall back to PCOB (present in both files).
    """
    pco2 = _collect_cues("PCO2", _parse_pco2, ext, dat)
    cues = pco2 if pco2 else _collect_cues("PCOB", _parse_pcob, dat, ext)
    return sorted(cues, key=lambda c: c.time_ms)


# -- Phrase sections (PSSI, with XOR unmask) ------------------------------------


def _unmask_pssi(tag: bytes) -> bytes:
    """Undo the XOR "garbage mask" Rekordbox applies to exported PSSI tags.

    Exported/USB files scramble every byte past offset 18 with a fixed pattern
    offset by ``len_entries``. A tag is scrambled when its raw mood byte falls
    outside the valid 1-3 range. Logic mirrors :mod:`pyrekordbox.anlz.file`.
    """
    from pyrekordbox.anlz.file import XOR_MASK

    if len(tag) < 20:
        return tag
    mood = int.from_bytes(tag[18:20], "big")
    if 1 <= mood <= 3:
        return tag  # not scrambled
    len_entries = int.from_bytes(tag[16:18], "big")
    out = bytearray(tag)
    for x in range(len(out) - 18):
        mask = (XOR_MASK[x % len(XOR_MASK)] + len_entries) & 0xFF
        out[18 + x] ^= mask
    return bytes(out)


def parse_sections(ext: bytes | None, beatgrid: list[Beat]) -> list[Section] | None:
    """Parse the PSSI phrase tag and resolve each phrase to a time span.

    Returns ``None`` when no phrase analysis exists (common: not every track is
    phrase-analysed, and older ``.EXT`` files omit PSSI).
    """
    if not ext or not beatgrid:
        return None
    from pyrekordbox.anlz import structs

    for name, tag in _walk_tags(ext):
        if name != "PSSI":
            continue
        try:
            parsed = structs.AnlzTag.parse(_unmask_pssi(tag))
        except Exception:
            logger.debug("Failed to parse PSSI tag", exc_info=True)
            return None
        content = parsed.content
        mood = int(content.mood)
        labels = _PHRASE_LABELS.get(mood, {})
        entries = sorted(content.entries, key=lambda e: int(e.beat))
        sections: list[Section] = []
        for i, e in enumerate(entries):
            start_beat = int(e.beat)
            end_beat = int(entries[i + 1].beat) if i + 1 < len(entries) else int(content.end_beat)
            label = labels.get(int(e.kind), f"Phrase {int(e.kind)}")
            sections.append(
                Section(
                    kind=_normalize_kind(label),
                    label=label,
                    start_ms=_beat_to_ms(start_beat, beatgrid),
                    end_ms=_beat_to_ms(end_beat, beatgrid),
                )
            )
        return sections or None
    return None


# -- Cached entry point ---------------------------------------------------------


@lru_cache(maxsize=512)
def _read_analysis_cached(dat_path: str | None, dat_mtime: int, ext_path: str | None, ext_mtime: int) -> TrackAnalysis:
    dat = None
    ext = None
    try:
        if dat_path:
            dat = Path(dat_path).read_bytes()
    except OSError:
        dat = None
    try:
        if ext_path:
            ext = Path(ext_path).read_bytes()
    except OSError:
        ext = None
    beatgrid = parse_beatgrid(dat)
    return TrackAnalysis(
        beatgrid=beatgrid,
        sections=parse_sections(ext, beatgrid),
        cues=parse_cues(dat, ext),
    )


def read_analysis(dat_path: str | None, dat_mtime: int, ext_path: str | None, ext_mtime: int) -> TrackAnalysis:
    """Read and parse a track's ANLZ analysis, cached on ``(path, mtime)`` pairs.

    Args:
        dat_path: Absolute ``.DAT`` path, or ``None``.
        dat_mtime: ``.DAT`` mtime in ns (cache key; 0 when absent).
        ext_path: Absolute ``.EXT`` path, or ``None``.
        ext_mtime: ``.EXT`` mtime in ns (cache key; 0 when absent).

    Returns:
        The parsed :class:`TrackAnalysis`.
    """
    return _read_analysis_cached(dat_path, dat_mtime, ext_path, ext_mtime)
