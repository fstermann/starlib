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
from abc import ABC, abstractmethod
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .analysis import TrackAnalysis, read_analysis

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

    @abstractmethod
    def get_track_waveform_blue(self, track_id: str) -> bytes | None:
        """Return the raw PWAV monochrome-preview entry bytes, or ``None``."""

    @abstractmethod
    def get_analysis_paths(self, track_id: str) -> tuple[Path | None, Path | None]:
        """Return the ``(.DAT, .EXT)`` ANLZ sidecar paths for a track.

        Either element is ``None`` when the corresponding file is absent (a track
        may have no analysis at all, or an older ``.DAT``-only analysis without
        the ``.EXT`` colour/phrase data). Existence is checked here so callers can
        assume a returned path is readable.
        """

    def get_track_waveform_color_detail(self, track_id: str) -> bytes | None:
        """Return raw PWV5 colour-detail bytes (2 B/column, ~150/s), or ``None``.

        This is the high-resolution waveform used for zoomed playback, decoded on
        the frontend canvas. Lives in the ``.EXT`` sidecar.
        """
        _, ext = self.get_analysis_paths(track_id)
        if ext is None:
            return None
        return read_pwv5(str(ext), ext.stat().st_mtime_ns)

    def get_track_waveform_blue_detail(self, track_id: str) -> bytes | None:
        """Return raw PWV3 monochrome-detail bytes (1 B/column, ~150/s), or ``None``.

        Zoom fallback when no ``.EXT`` colour detail exists. Lives in the ``.DAT``.
        """
        dat, _ = self.get_analysis_paths(track_id)
        if dat is None:
            return None
        return read_pwv3(str(dat), dat.stat().st_mtime_ns)

    def get_track_analysis(self, track_id: str) -> TrackAnalysis:
        """Return the beatgrid, phrase sections, and cues for a track.

        Beatgrid and cues come from the ``.DAT``; phrase sections and extended
        (nxs2) cues from the ``.EXT``. Missing files degrade to empty lists /
        ``None`` sections rather than raising.
        """
        dat, ext = self.get_analysis_paths(track_id)
        return read_analysis(
            str(dat) if dat else None,
            dat.stat().st_mtime_ns if dat else 0,
            str(ext) if ext else None,
            ext.stat().st_mtime_ns if ext else 0,
        )


def extract_soundcloud_id(comment: str | None) -> int | None:
    """Extract a SoundCloud track id stored in the track comment.

    Accepts a plain numeric comment or an ``sc:<id>`` / ``soundcloud:<id>``
    prefix. Note: app-managed SoundCloud metadata now lives in the file's
    ``TXXX:starlib`` tag, which Rekordbox does not import into its database, so
    it is not available from the comment field read here.

    Args:
        comment: The track comment, or ``None``.

    Returns:
        The SoundCloud track id, or ``None`` if the comment holds no id.
    """
    if not comment:
        return None
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


def extract_pwav(data: bytes) -> bytes | None:
    """Extract the PWAV entry bytes from raw ANLZ file contents.

    PWAV is the classic monochrome ("blue") preview waveform, stored in the
    ``.DAT`` file (unlike the colour PWV4/PWV5, which live in ``.EXT``). It is
    400 single-byte columns; each byte packs a 5-bit height (low bits, 0-31)
    and a 3-bit whiteness (high bits, 0-7). Layout after the section header
    (fourcc + len_header + len_tag, all big-endian u32): len_preview + unknown +
    entries.

    Args:
        data: Full contents of an ANLZ ``.DAT`` file.

    Returns:
        The raw entry bytes (``len_preview`` of them, normally 400), or ``None``
        if no PWAV section exists or the file is malformed.
    """
    if len(data) < 8 or data[:4] != b"PMAI":
        return None
    pos = int.from_bytes(data[4:8], "big")
    while pos + 12 <= len(data):
        fourcc = data[pos : pos + 4]
        len_tag = int.from_bytes(data[pos + 8 : pos + 12], "big")
        if len_tag <= 0:
            return None
        if fourcc == b"PWAV":
            if pos + 20 > len(data):
                return None
            len_preview = int.from_bytes(data[pos + 12 : pos + 16], "big")
            start = pos + 20
            end = start + len_preview
            if len_preview <= 0 or end > len(data):
                return None
            return data[start:end]
        pos += len_tag
    return None


@lru_cache(maxsize=1024)
def read_pwav(path: str, mtime_ns: int) -> bytes | None:
    """Read and extract PWAV bytes from an ANLZ ``.DAT`` file, cached.

    Args:
        path: Absolute path to the ``.DAT`` ANLZ file.
        mtime_ns: File modification time; part of the cache key so re-analysis
            invalidates the entry.

    Returns:
        The raw PWAV entry bytes, or ``None`` if absent/unreadable.
    """
    try:
        return extract_pwav(Path(path).read_bytes())
    except OSError:
        return None


def _extract_detail_entries(data: bytes, fourcc: bytes, entry_bytes: int) -> bytes | None:
    """Extract raw entry bytes of a fixed-width detail-waveform tag.

    PWV5 (colour detail, ``.EXT``) and PWV3 (monochrome detail, ``.DAT``) share
    the PWV4 tag layout: a 24-byte header (generic ``fourcc`` + len_header +
    len_tag, then len_entry_bytes + len_entries + unknown) followed by
    ``len_entries`` fixed-width columns. Both carry ~150 columns per second, so a
    multi-minute track yields tens of thousands of columns — enough resolution to
    zoom to a few bars. Walks the section list directly (see :func:`extract_pwv4`)
    rather than construct-parsing the whole file.

    Args:
        data: Full contents of an ANLZ file.
        fourcc: The tag identifier (``b"PWV5"`` or ``b"PWV3"``).
        entry_bytes: Expected bytes per column (2 for PWV5, 1 for PWV3).

    Returns:
        The raw entry bytes, or ``None`` if the tag is absent or malformed.
    """
    if len(data) < 8 or data[:4] != b"PMAI":
        return None
    pos = int.from_bytes(data[4:8], "big")
    while pos + 12 <= len(data):
        tag = data[pos : pos + 4]
        len_tag = int.from_bytes(data[pos + 8 : pos + 12], "big")
        if len_tag <= 0:
            return None
        if tag == fourcc:
            if pos + 24 > len(data):
                return None
            n_bytes = int.from_bytes(data[pos + 12 : pos + 16], "big")
            n_entries = int.from_bytes(data[pos + 16 : pos + 20], "big")
            start = pos + 24
            end = start + n_bytes * n_entries
            if n_bytes != entry_bytes or end > len(data):
                return None
            return data[start:end]
        pos += len_tag
    return None


def extract_pwv5(data: bytes) -> bytes | None:
    """Extract PWV5 colour-detail entry bytes (2 bytes/column) from a ``.EXT``."""
    return _extract_detail_entries(data, b"PWV5", 2)


def extract_pwv3(data: bytes) -> bytes | None:
    """Extract PWV3 monochrome-detail entry bytes (1 byte/column) from a ``.DAT``."""
    return _extract_detail_entries(data, b"PWV3", 1)


@lru_cache(maxsize=256)
def read_pwv5(path: str, mtime_ns: int) -> bytes | None:
    """Read and extract PWV5 colour-detail bytes from an ANLZ ``.EXT``, cached."""
    try:
        return extract_pwv5(Path(path).read_bytes())
    except OSError:
        return None


@lru_cache(maxsize=256)
def read_pwv3(path: str, mtime_ns: int) -> bytes | None:
    """Read and extract PWV3 monochrome-detail bytes from an ANLZ ``.DAT``, cached."""
    try:
        return extract_pwv3(Path(path).read_bytes())
    except OSError:
        return None
