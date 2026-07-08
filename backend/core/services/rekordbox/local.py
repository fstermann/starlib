"""Local Rekordbox 6 ``master.db`` source.

Lazy, cached wrapper around :mod:`pyrekordbox`. The Rekordbox 6 ``master.db`` is
encrypted; :class:`pyrekordbox.Rekordbox6Database` resolves the key from a local
Rekordbox installation. If no installation is present (or the library is
missing) the source raises :class:`RekordboxUnavailable` so the API layer can
return a clean 503.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from .base import (
    RekordboxPlaylist,
    RekordboxSource,
    RekordboxTrack,
    RekordboxUnavailable,
    extract_soundcloud_id,
    read_pwv4,
)

logger = logging.getLogger(__name__)


class LocalMasterDbSource(RekordboxSource):
    """Read the Rekordbox library from the local ``master.db`` install."""

    def __init__(self) -> None:
        self._db_lock = threading.Lock()
        self._db: Any | None = None
        self._failed_reason: str | None = None

    def _open_db(self) -> Any:
        """Return a cached :class:`pyrekordbox.Rekordbox6Database` instance."""
        if self._db is not None:
            return self._db
        with self._db_lock:
            if self._db is not None:
                return self._db
            if self._failed_reason is not None:
                raise RekordboxUnavailable(self._failed_reason)
            try:
                from pyrekordbox import Rekordbox6Database
            except Exception as exc:  # pragma: no cover - import-time failure
                self._failed_reason = f"pyrekordbox import failed: {exc}"
                raise RekordboxUnavailable(self._failed_reason) from exc
            try:
                self._db = Rekordbox6Database()
            except Exception as exc:
                self._failed_reason = f"Could not open Rekordbox master.db: {exc}"
                logger.warning(self._failed_reason)
                raise RekordboxUnavailable(self._failed_reason) from exc
            return self._db

    def check_available(self) -> None:
        self._open_db()

    def list_playlists(self) -> list[RekordboxPlaylist]:
        """Return all playlists (folders + leaves) as a flat list.

        Rekordbox encodes playlist kind in ``DjmdPlaylist.Attribute``: ``1`` =
        folder, ``4`` = smart playlist; everything else is a regular static
        playlist. For smart playlists the ``Songs`` relationship is empty (the
        contents are resolved by the saved query), so the track count comes from
        a counting query instead.
        """
        db = self._open_db()
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

    def _row_to_track(self, row: Any) -> RekordboxTrack:
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
            soundcloud_id=extract_soundcloud_id(str(comment) if comment else None),
            date_added=str(stock_raw) if stock_raw else None,
            release_date=str(release_raw) if release_raw else None,
            has_artwork=bool(image_path),
            has_waveform=bool(analysis_path),
        )

    def list_playlist_tracks(self, playlist_id: str) -> list[RekordboxTrack]:
        """Return tracks contained in a single playlist.

        Static playlists are walked in Rekordbox track order. Smart playlists
        delegate to :meth:`Rekordbox6Database.get_playlist_contents`, which
        evaluates the saved query for us.
        """
        db = self._open_db()
        pl = db.get_playlist(ID=playlist_id)
        if pl is None:
            return []
        attribute = int(getattr(pl, "Attribute", 0) or 0)
        is_smart = attribute == 4 or bool(getattr(pl, "is_smart_playlist", False))
        if is_smart:
            rows = db.get_playlist_contents(pl).all()
            return [self._row_to_track(r) for r in rows]
        songs = sorted(getattr(pl, "Songs", []) or [], key=lambda s: getattr(s, "TrackNo", 0))
        return [self._row_to_track(s.Content) for s in songs if getattr(s, "Content", None)]

    def _share_dir(self) -> Path:
        """Return the Rekordbox ``share`` directory.

        Artwork JPEGs and ANLZ analysis files referenced by relative paths in
        the DB (e.g. ``/PIONEER/Artwork/.../artwork.jpg``) all live under this
        root.
        """
        db = self._open_db()
        db_dir = getattr(db, "db_directory", None)
        if not db_dir:
            raise RekordboxUnavailable("Rekordbox db_directory not exposed by pyrekordbox")
        return Path(db_dir) / "share"

    def _resolve_relative(self, rel: str) -> Path:
        """Resolve a Rekordbox-relative path (always leading slash) to the share dir."""
        return self._share_dir() / rel.lstrip("/")

    def get_track_artwork(self, track_id: str, *, small: bool = True) -> bytes | None:
        """Read the cached artwork bytes for a track, or ``None`` if absent.

        Rekordbox stores three variants alongside each artwork: ``artwork.jpg``
        (full), ``artwork_m.jpg`` (medium), ``artwork_s.jpg`` (small thumbnail).
        For inline-table use we default to the small variant.
        """
        db = self._open_db()
        row = db.get_content(ID=track_id)
        if row is None:
            return None
        rel = getattr(row, "ImagePath", None)
        if not rel:
            return None
        p = self._resolve_relative(str(rel))
        if small:
            small_p = p.with_name(p.stem + "_s" + p.suffix)
            if small_p.exists():
                p = small_p
        try:
            return p.read_bytes()
        except OSError:
            return None

    def get_track_waveform_preview(self, track_id: str) -> bytes | None:
        """Return the raw PWV4 color preview entry bytes (1200 x 6 bytes).

        The PWV4 tag lives in the ``.EXT`` ANLZ sidecar. Each column is 6 bytes:
        ``d0`` (unknown), ``d1`` (luminance boost), ``d2`` (blue inv. intensity),
        ``d3`` (red, 7-bit), ``d4`` (green, 7-bit), ``d5`` (blue + front height,
        7-bit). The frontend parses these directly onto a canvas.
        """
        db = self._open_db()
        row = db.get_content(ID=track_id)
        if row is None:
            return None
        rel = getattr(row, "AnalysisDataPath", None)
        if not rel:
            return None
        # PWV4 (color preview) lives in the .EXT file, not the .DAT.
        ext = self._resolve_relative(str(rel)).with_suffix(".EXT")
        try:
            mtime_ns = ext.stat().st_mtime_ns
        except OSError:
            return None
        return read_pwv4(str(ext), mtime_ns)

    def list_all_tracks(self, limit: int | None = None) -> list[RekordboxTrack]:
        """Return all tracks in the collection."""
        db = self._open_db()
        rows = db.get_content()
        if limit is not None:
            rows = rows.limit(limit)
        return [self._row_to_track(r) for r in rows]
