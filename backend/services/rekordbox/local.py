"""Local Rekordbox 6 ``master.db`` source.

Lazy, cached wrapper around :mod:`pyrekordbox`. The Rekordbox 6 ``master.db`` is
encrypted; :class:`pyrekordbox.Rekordbox6Database` resolves the key from a local
Rekordbox installation. If no installation is present (or the library is
missing) the source raises :class:`RekordboxUnavailable` so the API layer can
return a clean 503.

Playlists can also be created, renamed, and deleted, and regular playlists
edited (add, remove, reorder). Writes only happen while Rekordbox is closed; otherwise
:class:`RekordboxBusy` is raised. The first write of a session backs up
``master.db``; if that fails, :class:`BackupFailed` is raised and nothing changes.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from backend.infra.rekordbox_backup import backup_master_db

from .analysis import Cue, TrackAnalysis, cues_from_db_rows
from .base import (
    BackupFailed,
    PlaylistEditError,
    RekordboxBusy,
    RekordboxPlaylist,
    RekordboxSource,
    RekordboxTrack,
    RekordboxUnavailable,
    read_pwav,
    read_pwv4,
    resolve_soundcloud_id,
)

logger = logging.getLogger(__name__)

_FOLDER = 1
_SMART = 4


def rekordbox_running() -> bool:
    """Return ``True`` while the Rekordbox app is running on this machine."""
    from pyrekordbox.utils import get_rekordbox_pid

    return bool(get_rekordbox_pid())


class LocalMasterDbSource(RekordboxSource):
    """Read the Rekordbox library from the local ``master.db`` install.

    Args:
        backup_dir: Where to back up ``master.db`` before the first write;
            ``None`` skips the backup.
    """

    def __init__(self, backup_dir: Path | None = None) -> None:
        self._db_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._db: Any | None = None
        self._failed_reason: str | None = None
        self._backup_dir = backup_dir
        self._backed_up = False

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
        out = [self._row_to_playlist(db, pl) for pl in db.get_playlist()]
        return out

    def _row_to_playlist(self, db: Any, pl: Any) -> RekordboxPlaylist:
        parent = getattr(pl, "ParentID", None)
        parent_id = str(parent) if parent and str(parent) != "root" else None
        attribute = int(getattr(pl, "Attribute", 0) or 0)
        is_folder = attribute == _FOLDER
        is_smart = attribute == _SMART or bool(getattr(pl, "is_smart_playlist", False))

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

        return RekordboxPlaylist(
            id=str(pl.ID),
            name=str(pl.Name),
            parent_id=parent_id,
            is_folder=is_folder,
            is_smart=is_smart,
            track_count=track_count,
        )

    def _row_to_track(self, row: Any, entry_id: str | None = None) -> RekordboxTrack:
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
        folder_path = getattr(row, "FolderPath", None)
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
            file_path=folder_path,
            comment=str(comment) if comment else None,
            soundcloud_id=resolve_soundcloud_id(
                str(comment) if comment else None, Path(folder_path) if folder_path else None
            ),
            date_added=str(stock_raw) if stock_raw else None,
            release_date=str(release_raw) if release_raw else None,
            has_artwork=bool(image_path),
            has_waveform=bool(analysis_path),
            entry_id=entry_id,
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
        return [self._row_to_track(s.Content, str(s.ID)) for s in songs if getattr(s, "Content", None)]

    @contextmanager
    def _writing(self) -> Iterator[Any]:
        """Yield the database for a write, committing on success.

        Yields:
            Any: The open database.

        Raises:
            RekordboxBusy: If Rekordbox is running.
            Exception: Whatever the write raised, after rolling it back.
        """
        db = self._open_db()
        with self._write_lock:
            if rekordbox_running():
                raise RekordboxBusy("Close Rekordbox to save playlist changes.")
            # Expire cached rows so the write builds on what Rekordbox last saved.
            db.rollback()
            if not self._backed_up and self._backup_dir is not None:
                self._backup(db, self._backup_dir)
            try:
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise

    def _backup(self, db: Any, backup_dir: Path) -> None:
        """Back up ``master.db`` once per session, before its first write.

        Args:
            db: The open database.
            backup_dir: Folder for the backups.

        Raises:
            BackupFailed: If the copy fails; the write is then refused.
        """
        try:
            # Merge the write-ahead log into master.db so the copy is complete.
            with db.engine.connect() as conn:
                conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
            backup_master_db(Path(db.engine.url.database), backup_dir)
        except Exception as exc:
            logger.exception("Rekordbox backup failed")
            raise BackupFailed(f"Couldn't back up the Rekordbox library, so nothing was changed: {exc}") from exc
        self._backed_up = True

    @contextmanager
    def _editing_playlist(self, playlist_id: str) -> Iterator[tuple[Any, Any]]:
        """Yield ``(db, playlist)`` for an edit of a regular playlist.

        Args:
            playlist_id: The playlist to edit.

        Yields:
            tuple[Any, Any]: The open database and the playlist row.

        Raises:
            PlaylistEditError: If the playlist is missing, a folder, or smart.
        """
        with self._writing() as db:
            pl = db.get_playlist(ID=playlist_id)
            if pl is None:
                raise PlaylistEditError(f"Playlist not found: {playlist_id}")
            if int(getattr(pl, "Attribute", 0) or 0) != 0:
                raise PlaylistEditError("Only regular playlists can be edited.")
            yield db, pl

    def create_playlist(self, name: str, parent_id: str | None, *, folder: bool) -> RekordboxPlaylist:
        """Create an empty regular playlist or folder at the end of its parent.

        Args:
            name: The new playlist's name.
            parent_id: The folder to create it in, or ``None`` for the top level.
            folder: Create a folder instead of a playlist.

        Returns:
            The created playlist.

        Raises:
            PlaylistEditError: If the name is blank or the parent is not a folder.
        """
        name = name.strip()
        if not name:
            raise PlaylistEditError("Playlist name can't be empty.")
        with self._writing() as db:
            parent = None
            if parent_id is not None:
                parent = db.get_playlist(ID=parent_id)
                if parent is None or int(getattr(parent, "Attribute", 0) or 0) != _FOLDER:
                    raise PlaylistEditError("Playlists can only be created inside a folder.")
            create = db.create_playlist_folder if folder else db.create_playlist
            pl = create(name, parent=parent)
        return self._row_to_playlist(db, pl)

    def rename_playlist(self, playlist_id: str, name: str) -> RekordboxPlaylist:
        """Rename a playlist, smart playlist, or folder.

        Args:
            playlist_id: The playlist to rename.
            name: The new name.

        Returns:
            The renamed playlist.

        Raises:
            PlaylistEditError: If the name is blank or the playlist doesn't exist.
        """
        name = name.strip()
        if not name:
            raise PlaylistEditError("Playlist name can't be empty.")
        with self._writing() as db:
            pl = db.get_playlist(ID=playlist_id)
            if pl is None:
                raise PlaylistEditError(f"Playlist not found: {playlist_id}")
            db.rename_playlist(pl, name)
        return self._row_to_playlist(db, pl)

    def delete_playlist(self, playlist_id: str) -> None:
        """Delete a playlist, smart playlist, or folder with everything inside it.

        The tracks stay in the collection.

        Args:
            playlist_id: The playlist to delete.

        Raises:
            PlaylistEditError: If the playlist doesn't exist.
        """
        with self._writing() as db:
            pl = db.get_playlist(ID=playlist_id)
            if pl is None:
                raise PlaylistEditError(f"Playlist not found: {playlist_id}")
            db.delete_playlist(pl)

    def add_tracks_to_playlist(self, playlist_id: str, track_ids: list[str]) -> list[RekordboxTrack]:
        """Append tracks to a regular playlist, in the given order.

        Args:
            playlist_id: The target playlist.
            track_ids: Collection track ids to append.

        Returns:
            The playlist's tracks after the edit.

        Raises:
            PlaylistEditError: If a track id is unknown; nothing is added.
        """
        with self._editing_playlist(playlist_id) as (db, pl):
            for track_id in track_ids:
                if db.get_content(ID=track_id) is None:
                    raise PlaylistEditError(f"Track not found: {track_id}")
            for track_id in track_ids:
                db.add_to_playlist(pl, track_id)
        return self.list_playlist_tracks(playlist_id)

    def remove_playlist_entries(self, playlist_id: str, entry_ids: list[str]) -> list[RekordboxTrack]:
        """Remove entries (see :attr:`RekordboxTrack.entry_id`) from a regular playlist.

        Args:
            playlist_id: The playlist to edit.
            entry_ids: The entries to remove.

        Returns:
            The playlist's tracks after the edit.

        Raises:
            PlaylistEditError: If an entry is not in the playlist; nothing is removed.
        """
        with self._editing_playlist(playlist_id) as (db, pl):
            songs = {str(s.ID): s for s in pl.Songs}
            missing = [e for e in entry_ids if e not in songs]
            if missing:
                raise PlaylistEditError(f"Entries not in playlist: {', '.join(missing)}")
            for entry_id in entry_ids:
                db.remove_from_playlist(pl, songs[entry_id])
        return self.list_playlist_tracks(playlist_id)

    def reorder_playlist(self, playlist_id: str, entry_ids: list[str]) -> list[RekordboxTrack]:
        """Put a regular playlist's entries into the given order.

        Args:
            playlist_id: The playlist to edit.
            entry_ids: Every entry of the playlist exactly once, in the new order.

        Returns:
            The playlist's tracks after the edit.

        Raises:
            PlaylistEditError: If ``entry_ids`` is not a permutation of the entries.
        """
        with self._editing_playlist(playlist_id) as (db, pl):
            songs = {str(s.ID): s for s in pl.Songs}
            if sorted(entry_ids) != sorted(songs):
                raise PlaylistEditError("The new order must list every playlist entry exactly once.")
            for track_no, entry_id in enumerate(entry_ids, start=1):
                song = songs[entry_id]
                if song.TrackNo != track_no:
                    db.move_song_in_playlist(pl, song, track_no)
        return self.list_playlist_tracks(playlist_id)

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

    def get_track_waveform_blue(self, track_id: str) -> bytes | None:
        """Return the raw PWAV monochrome preview bytes (400 x 1 byte).

        Each byte packs a 5-bit height (low) and 3-bit whiteness (high). The
        PWAV tag lives in the ``.DAT`` ANLZ file (colour PWV4 is in ``.EXT``).
        """
        db = self._open_db()
        row = db.get_content(ID=track_id)
        if row is None:
            return None
        rel = getattr(row, "AnalysisDataPath", None)
        if not rel:
            return None
        dat = self._resolve_relative(str(rel)).with_suffix(".DAT")
        try:
            mtime_ns = dat.stat().st_mtime_ns
        except OSError:
            return None
        return read_pwav(str(dat), mtime_ns)

    def get_analysis_paths(self, track_id: str) -> tuple[Path | None, Path | None]:
        """Return the ``(.DAT, .EXT)`` ANLZ sidecar paths for a track."""
        db = self._open_db()
        row = db.get_content(ID=track_id)
        if row is None:
            return None, None
        rel = getattr(row, "AnalysisDataPath", None)
        if not rel:
            return None, None
        base = self._resolve_relative(str(rel))
        dat = base.with_suffix(".DAT")
        ext = base.with_suffix(".EXT")
        return (dat if dat.exists() else None, ext if ext.exists() else None)

    def get_track_analysis(self, track_id: str) -> TrackAnalysis:
        """Beatgrid + sections from the ANLZ sidecars, cues from ``master.db``.

        Rekordbox 6 stores cues in the ``djmdCue`` table, leaving the local
        ANLZ ``PCOB``/``PCO2`` tags empty, so the base ANLZ parse returns no
        cues here. We overlay the database cues instead.
        """
        analysis = super().get_track_analysis(track_id)
        cues = self._read_db_cues(track_id)
        if not cues:
            return analysis
        from dataclasses import replace

        return replace(analysis, cues=cues)

    def _read_db_cues(self, track_id: str) -> list[Cue]:
        """Read a track's cues from the ``djmdCue`` table (empty on any error)."""
        try:
            db = self._open_db()
            rows = list(db.get_cue(ContentID=track_id))
        except Exception:
            logger.debug("Failed to read cues for %s", track_id, exc_info=True)
            return []
        return cues_from_db_rows(rows)

    def list_all_tracks(self, limit: int | None = None) -> list[RekordboxTrack]:
        """Return all tracks in the collection."""
        db = self._open_db()
        rows = db.get_content()
        if limit is not None:
            rows = rows.limit(limit)
        return [self._row_to_track(r) for r in rows]
