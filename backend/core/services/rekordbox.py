"""Rekordbox master DB access.

Lazy, cached wrapper around :mod:`pyrekordbox`. The Rekordbox 6 ``master.db`` is
encrypted; :class:`pyrekordbox.Rekordbox6Database` resolves the key from a
local Rekordbox installation. If no installation is present (or the library is
missing) the helpers in this module raise :class:`RekordboxUnavailable` so the
API layer can return a clean 503.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class RekordboxUnavailable(RuntimeError):
    """Raised when the master DB cannot be opened on this machine."""


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


_db_lock = threading.Lock()
_db: Any | None = None
_failed_reason: str | None = None


def _open_db() -> Any:
    """Return a cached :class:`pyrekordbox.Rekordbox6Database` instance."""
    global _db, _failed_reason
    if _db is not None:
        return _db
    with _db_lock:
        if _db is not None:
            return _db
        if _failed_reason is not None:
            raise RekordboxUnavailable(_failed_reason)
        try:
            from pyrekordbox import Rekordbox6Database
        except Exception as exc:  # pragma: no cover - import-time failure
            _failed_reason = f"pyrekordbox import failed: {exc}"
            raise RekordboxUnavailable(_failed_reason) from exc
        try:
            _db = Rekordbox6Database()
        except Exception as exc:
            _failed_reason = f"Could not open Rekordbox master.db: {exc}"
            logger.warning(_failed_reason)
            raise RekordboxUnavailable(_failed_reason) from exc
        return _db


def is_available() -> bool:
    """Return ``True`` if the master DB can be opened on this machine."""
    try:
        _open_db()
    except RekordboxUnavailable:
        return False
    return True


def _extract_soundcloud_id(comment: str | None) -> int | None:
    """Extract a SoundCloud track id stored in the track comment.

    Convention used by the export-to-SoundCloud flow: the SoundCloud track id
    is written into the Rekordbox ``Commnt`` field. Accepts plain numerics or
    ``sc:<id>`` / ``soundcloud:<id>`` style prefixes.
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


def list_playlists() -> list[RekordboxPlaylist]:
    """Return all playlists (folders + leaves) as a flat list.

    Rekordbox encodes playlist kind in ``DjmdPlaylist.Attribute``: ``1`` = folder,
    ``4`` = smart playlist; everything else is a regular static playlist. For
    smart playlists the ``Songs`` relationship is empty (the contents are
    resolved by the saved query), so the track count comes from a counting
    query instead.
    """
    db = _open_db()
    out: list[RekordboxPlaylist] = []
    for pl in db.get_playlist():
        parent = getattr(pl, "ParentID", None)
        parent_id = str(parent) if parent and str(parent) != "root" else None
        attribute = int(getattr(pl, "Attribute", 0) or 0)
        is_folder = attribute == 1
        is_smart = attribute == 4 or bool(getattr(pl, "is_smart_playlist", False))

        if is_folder:
            track_count = 0
        elif is_smart:
            try:
                track_count = db.get_playlist_contents(pl).count()
            except Exception:  # pragma: no cover - defensive against schema drift
                logger.exception("Could not count smart playlist %s", pl.ID)
                track_count = 0
        else:
            track_count = len(getattr(pl, "Songs", None) or [])

        out.append(
            RekordboxPlaylist(
                id=str(pl.ID),
                name=str(pl.Name),
                parent_id=parent_id,
                is_folder=is_folder,
                is_smart=is_smart,
                track_count=track_count,
            )
        )
    return out


def _row_to_track(row: Any) -> RekordboxTrack:
    artist = getattr(row, "Artist", None)
    album = getattr(row, "Album", None)
    genre = getattr(row, "Genre", None)
    key = getattr(row, "Key", None)
    comment = getattr(row, "Commnt", None)
    bpm_raw = getattr(row, "BPM", None)
    # Rekordbox stores BPM scaled by 100 as an integer.
    bpm = float(bpm_raw) / 100.0 if bpm_raw else None
    image_path = getattr(row, "ImagePath", None) or None
    analysis_path = getattr(row, "AnalysisDataPath", None) or None
    release_raw = getattr(row, "ReleaseDate", None)
    stock_raw = getattr(row, "StockDate", None)
    return RekordboxTrack(
        id=str(row.ID),
        title=str(getattr(row, "Title", "") or ""),
        artist=getattr(artist, "Name", None) if artist else None,
        album=getattr(album, "Name", None) if album else None,
        genre=getattr(genre, "Name", None) if genre else None,
        bpm=bpm,
        key=getattr(key, "ScaleName", None) if key else None,
        duration_seconds=getattr(row, "Length", None),
        file_path=getattr(row, "FolderPath", None),
        comment=str(comment) if comment else None,
        soundcloud_id=_extract_soundcloud_id(str(comment) if comment else None),
        date_added=str(stock_raw) if stock_raw else None,
        release_date=str(release_raw) if release_raw else None,
        has_artwork=bool(image_path),
        has_waveform=bool(analysis_path),
    )


def list_playlist_tracks(playlist_id: str) -> list[RekordboxTrack]:
    """Return tracks contained in a single playlist.

    Static playlists are walked in Rekordbox track order. Smart playlists
    delegate to :meth:`Rekordbox6Database.get_playlist_contents`, which
    evaluates the saved query for us.
    """
    db = _open_db()
    pl = db.get_playlist(ID=playlist_id)
    if pl is None:
        return []
    attribute = int(getattr(pl, "Attribute", 0) or 0)
    is_smart = attribute == 4 or bool(getattr(pl, "is_smart_playlist", False))
    if is_smart:
        rows = db.get_playlist_contents(pl).all()
        return [_row_to_track(r) for r in rows]
    songs = sorted(getattr(pl, "Songs", []) or [], key=lambda s: getattr(s, "TrackNo", 0))
    return [_row_to_track(s.Content) for s in songs if getattr(s, "Content", None)]


def _share_dir() -> Path:
    """Return the Rekordbox ``share`` directory.

    Artwork JPEGs and ANLZ analysis files referenced by relative paths in the
    DB (e.g. ``/PIONEER/Artwork/.../artwork.jpg``) all live under this root.
    """
    db = _open_db()
    db_dir = getattr(db, "db_directory", None)
    if not db_dir:
        raise RekordboxUnavailable("Rekordbox db_directory not exposed by pyrekordbox")
    return Path(db_dir) / "share"


def _resolve_relative(rel: str) -> Path:
    """Resolve a Rekordbox-relative path (always leading slash) to the share dir."""
    return _share_dir() / rel.lstrip("/")


def get_track_artwork(track_id: str, *, small: bool = True) -> bytes | None:
    """Read the cached artwork bytes for a track, or ``None`` if absent.

    Rekordbox stores three variants alongside each artwork: ``artwork.jpg``
    (full), ``artwork_m.jpg`` (medium), ``artwork_s.jpg`` (small thumbnail).
    For inline-table use we default to the small variant.
    """
    db = _open_db()
    row = db.get_content(ID=track_id)
    if row is None:
        return None
    rel = getattr(row, "ImagePath", None)
    if not rel:
        return None
    p = _resolve_relative(str(rel))
    if small:
        small_p = p.with_name(p.stem + "_s" + p.suffix)
        if small_p.exists():
            p = small_p
    try:
        return p.read_bytes()
    except OSError:
        return None


def _extract_pwv4(data: bytes) -> bytes | None:
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
def _read_pwv4(path: str, mtime_ns: int) -> bytes | None:
    """Read and extract PWV4 bytes, cached per (path, mtime).

    Args:
        path: Absolute path to the ``.EXT`` ANLZ file.
        mtime_ns: File modification time; part of the key so re-analysis in
            Rekordbox invalidates the cached entry.

    Returns:
        The raw PWV4 entry bytes, or ``None`` if absent/unreadable.
    """
    try:
        return _extract_pwv4(Path(path).read_bytes())
    except OSError:
        return None


def get_track_waveform_preview(track_id: str) -> bytes | None:
    """Return the raw PWV4 color preview entry bytes (1200 x 6 bytes).

    The PWV4 tag lives in the ``.EXT`` ANLZ sidecar. Each column is 6 bytes:
    ``d0`` (unknown), ``d1`` (luminance boost), ``d2`` (blue inv. intensity),
    ``d3`` (red, 7-bit), ``d4`` (green, 7-bit), ``d5`` (blue + front height,
    7-bit). The frontend parses these directly onto a canvas.
    """
    db = _open_db()
    row = db.get_content(ID=track_id)
    if row is None:
        return None
    rel = getattr(row, "AnalysisDataPath", None)
    if not rel:
        return None
    # PWV4 (color preview) lives in the .EXT file, not the .DAT.
    ext = _resolve_relative(str(rel)).with_suffix(".EXT")
    try:
        mtime_ns = ext.stat().st_mtime_ns
    except OSError:
        return None
    return _read_pwv4(str(ext), mtime_ns)


def list_all_tracks(limit: int | None = None) -> list[RekordboxTrack]:
    """Return all tracks in the collection."""
    db = _open_db()
    rows = db.get_content()
    if limit is not None:
        rows = rows.limit(limit)
    return [_row_to_track(r) for r in rows]
