"""Parse CUE sheets: the tracklist a DJ app writes next to a recorded mix."""

from __future__ import annotations

import re
from dataclasses import dataclass

# CUE timestamps are ``mm:ss:ff`` with 75 frames per second (CD sectors).
_FRAMES_PER_SECOND = 75
_TIMESTAMP = re.compile(r"^(\d+):(\d{1,2}):(\d{1,2})$")
# rekordbox's recordings break the standard and write ``hh:mm:ss``.
_REKORDBOX = re.compile(r'^\s*REM\s+RECORDED_BY\s+"?rekordbox', re.IGNORECASE | re.MULTILINE)


@dataclass(frozen=True, slots=True)
class CueTrack:
    """One track of a CUE sheet."""

    start_s: float
    title: str | None
    performer: str | None
    # The source audio file of the track, which rekordbox writes into each TRACK.
    file: str | None = None


@dataclass(frozen=True, slots=True)
class CueSheet:
    """A parsed CUE sheet: the mix's own title and performer, then its tracks by start time."""

    title: str | None
    performer: str | None
    tracks: list[CueTrack]


def decode_cue(raw: bytes) -> str:
    """Decode a CUE file. Older DJ software writes cp1252, newer UTF-8 (often with a BOM).

    Args:
        raw: The file's bytes.

    Returns:
        The file's text.
    """
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def parse_cue(text: str) -> CueSheet:
    """Parse a CUE sheet into tracks with start times.

    A track's start is its ``INDEX 01``, or ``INDEX 00`` when that's all it
    has; a track with neither is skipped. Unknown commands are ignored.
    Sheets recorded by rekordbox use ``hh:mm:ss`` timestamps instead of the
    standard ``mm:ss:ff``.

    Args:
        text: The CUE sheet's contents.

    Returns:
        The sheet, tracks sorted by start time.

    Raises:
        ValueError: When the sheet has no track with a start time.
    """
    # Fields before the first TRACK describe the whole sheet.
    sheet = _Draft()
    drafts: list[_Draft] = []
    hours_minutes_seconds = _REKORDBOX.search(text) is not None

    for line in text.splitlines():
        command, rest = [*line.split(None, 1), "", ""][:2]
        command, rest = command.upper(), rest.strip()
        current = drafts[-1] if drafts else sheet
        if command == "TRACK":
            drafts.append(_Draft())
        elif command == "TITLE":
            current.title = _unquote(rest) or None
        elif command == "PERFORMER":
            current.performer = _unquote(rest) or None
        elif command == "FILE" and drafts:
            # ``FILE "<path>" <type>``: drop the type.
            current.file = _unquote(rest.rsplit(None, 1)[0]) or None
        elif command == "INDEX" and drafts:
            number, timestamp = [*rest.split(), "", ""][:2]
            if number in ("00", "0"):
                current.index00 = _timestamp_s(timestamp, hours_minutes_seconds)
            elif number in ("01", "1"):
                current.index01 = _timestamp_s(timestamp, hours_minutes_seconds)

    tracks = [
        CueTrack(start_s=start, title=d.title, performer=d.performer, file=d.file)
        for d in drafts
        if (start := d.index01 if d.index01 is not None else d.index00) is not None
    ]
    if not tracks:
        raise ValueError("no tracks with a start time in this CUE sheet")
    tracks.sort(key=lambda t: t.start_s)
    return CueSheet(title=sheet.title, performer=sheet.performer, tracks=tracks)


@dataclass(slots=True)
class _Draft:
    title: str | None = None
    performer: str | None = None
    file: str | None = None
    index00: float | None = None
    index01: float | None = None


def drop_repeats(tracks: list[CueTrack]) -> list[CueTrack]:
    """Drop entries for a track that already appeared earlier in the sheet.

    rekordbox logs a track each time its deck starts playing, so pressing
    play or cue on a deck that still holds an earlier track logs that track
    again. Dropping the entry hands its time to the track before it.

    Args:
        tracks: The sheet's tracks in time order.

    Returns:
        The tracks with repeats removed, in the same order.
    """
    seen: set[tuple[str, ...]] = set()
    kept = []
    for track in tracks:
        identity = _identity(track)
        if identity is not None and identity in seen:
            continue
        if identity is not None:
            seen.add(identity)
        kept.append(track)
    return kept


def _identity(track: CueTrack) -> tuple[str, ...] | None:
    """What makes two entries the same track: the source file, else performer and title."""
    if track.file:
        return ("file", track.file)
    if track.title:
        return ("tag", (track.performer or "").casefold(), track.title.casefold())
    return None


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].strip()
    return value


def _timestamp_s(value: str, hours_minutes_seconds: bool) -> float | None:
    match = _TIMESTAMP.match(value)
    if match is None:
        return None
    a, b, c = (int(g) for g in match.groups())
    if hours_minutes_seconds:
        return a * 3600 + b * 60 + c
    return a * 60 + b + c / _FRAMES_PER_SECOND
