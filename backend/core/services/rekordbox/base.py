"""Shared Rekordbox source contract and format helpers.

Starlib reads Rekordbox libraries from more than one place: the local
Rekordbox 6 ``master.db`` (see :mod:`.local`) and, eventually, a USB/SD device
export (``export.pdb``). Both expose the same read-only browse surface, so they
implement the :class:`RekordboxSource` interface and return the same
:class:`RekordboxTrack` / :class:`RekordboxPlaylist` dataclasses.

Helpers that only depend on the on-disk formats (ANLZ waveform bytes, the
SoundCloud-id comment convention) live here so both sources reuse them.
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)


class RekordboxUnavailable(RuntimeError):
    """Raised when a Rekordbox source cannot be opened.

    The API layer maps this to a clean 503 so a missing local install or an
    unreadable USB export never surfaces as a 500.
    """


@dataclass(frozen=True)
class RekordboxPlaylist:
    id: str
    name: str
    parent_id: str | None
    is_folder: bool
    is_smart: bool
    track_count: int


@dataclass(frozen=True)
class RekordboxTrack:
    id: str
    title: str
    artist: str | None
    album: str | None
    genre: str | None
    bpm: float | None
    key: str | None
    duration_seconds: int | None
    file_path: str | None
    comment: str | None
    soundcloud_id: int | None
    date_added: str | None
    release_date: str | None
    has_artwork: bool
    has_waveform: bool


class RekordboxSource(ABC):
    """Read-only browse surface over a Rekordbox library.

    Implementations wrap a concrete backing store (local ``master.db``, USB
    ``export.pdb``, …). All methods either return data or raise
    :class:`RekordboxUnavailable` when the store cannot be opened.
    """

    @abstractmethod
    def check_available(self) -> None:
        """Raise :class:`RekordboxUnavailable` if this source cannot be read."""

    def is_available(self) -> bool:
        """Return ``True`` if the source can be opened on this machine."""
        try:
            self.check_available()
        except RekordboxUnavailable:
            return False
        return True

    @abstractmethod
    def list_playlists(self) -> list[RekordboxPlaylist]:
        """Return all playlists (folders + leaves) as a flat list."""

    @abstractmethod
    def list_playlist_tracks(self, playlist_id: str) -> list[RekordboxTrack]:
        """Return tracks contained in a single playlist, in playlist order."""

    @abstractmethod
    def list_all_tracks(self, limit: int | None = None) -> list[RekordboxTrack]:
        """Return all tracks in the collection."""

    @abstractmethod
    def get_track_artwork(self, track_id: str, *, small: bool = True) -> bytes | None:
        """Return the cached artwork JPEG bytes for a track, or ``None``."""

    @abstractmethod
    def get_track_waveform_preview(self, track_id: str) -> bytes | None:
        """Return the raw PWV4 color-preview entry bytes, or ``None``."""


_SOUNDCLOUD_ID_RE = re.compile(r"soundcloud_id\s*=\s*(\d+)", re.IGNORECASE)


def extract_soundcloud_id(comment: str | None) -> int | None:
    """Extract a SoundCloud track id stored in the track comment.

    Convention used by the export-to-SoundCloud flow: the SoundCloud track id
    is written into the Rekordbox comment field. Accepts a structured comment
    holding a ``soundcloud_id=<id>`` key (as written by the export tool, e.g.
    ``version=1.0; soundcloud_id=699524932; soundcloud_permalink=...``), a plain
    numeric comment, or ``sc:<id>`` / ``soundcloud:<id>`` style prefixes.

    Args:
        comment: The track comment, or ``None``.

    Returns:
        The SoundCloud track id, or ``None`` if the comment holds no id.
    """
    if not comment:
        return None
    match = _SOUNDCLOUD_ID_RE.search(comment)
    if match:
        return int(match.group(1))
    text = comment.strip()
    for prefix in ("soundcloud:", "sc:"):
        if text.lower().startswith(prefix):
            text = text[len(prefix) :].strip()
            break
    if text.isdigit():
        return int(text)
    return None


def extract_pwv4(data: bytes) -> bytes | None:
    """Extract the PWV4 entry bytes from raw ANLZ file contents.

    Walks the ANLZ section list directly instead of construct-parsing the
    whole file via ``pyrekordbox.anlz.AnlzFile`` — that parses every tag
    (including the multi-hundred-KB PWV5 detail waveform) and takes ~200ms
    per file, vs ~microseconds for this scan. Layout (all big-endian u32):
    file header ``PMAI`` + len_header + len_file…; then per section:
    fourcc + len_header + len_tag. PWV4 content is len_entry_bytes (always
    6) + len_entries + unknown + entries.

    Args:
        data: Full contents of an ANLZ ``.EXT`` file.

    Returns:
        The raw entry bytes (1200 x 6), or ``None`` if no PWV4 section
        exists or the file is malformed.
    """
    if len(data) < 8 or data[:4] != b"PMAI":
        return None
    pos = int.from_bytes(data[4:8], "big")
    while pos + 12 <= len(data):
        fourcc = data[pos : pos + 4]
        len_tag = int.from_bytes(data[pos + 8 : pos + 12], "big")
        if len_tag <= 0:
            return None
        if fourcc == b"PWV4":
            if pos + 24 > len(data):
                return None
            entry_bytes = int.from_bytes(data[pos + 12 : pos + 16], "big")
            n_entries = int.from_bytes(data[pos + 16 : pos + 20], "big")
            start = pos + 24
            end = start + entry_bytes * n_entries
            if entry_bytes != 6 or end > len(data):
                return None
            return data[start:end]
        pos += len_tag
    return None


@lru_cache(maxsize=1024)
def read_pwv4(path: str, mtime_ns: int) -> bytes | None:
    """Read and extract PWV4 bytes from an ANLZ ``.EXT`` file, cached.

    Args:
        path: Absolute path to the ``.EXT`` ANLZ file.
        mtime_ns: File modification time; part of the cache key so re-analysis
            (in Rekordbox or on a re-exported device) invalidates the entry.

    Returns:
        The raw PWV4 entry bytes, or ``None`` if absent/unreadable.
    """
    try:
        return extract_pwv4(Path(path).read_bytes())
    except OSError:
        return None
