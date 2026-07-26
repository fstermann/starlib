"""USB/SD device export source (Rekordbox Device Library Plus).

Reads a mounted Rekordbox export from its ``exportLibrary.db`` — the Device
Library Plus database written next to ``export.pdb`` under
``<device>/PIONEER/rekordbox/``. Unlike ``export.pdb`` (a bespoke DeviceSQL
binary), ``exportLibrary.db`` is a normal SQLite database sealed with SQLCipher.

The SQLCipher key is a fixed, device-independent constant published by the
community (the same key seals every Device Library Plus export, so CDJs can read
any stick without per-device provisioning). We only ever read the user's own
library off their own device, read-only.

Track/artwork/waveform assets referenced by the DB (``/Contents/...``,
``/PIONEER/Artwork/...``, ``/PIONEER/USBANLZ/...``) are device-root-relative and
resolve against the mount point.
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
    read_pwav,
    read_pwv4,
)

logger = logging.getLogger(__name__)

# Fixed SQLCipher key for every Device Library Plus ``exportLibrary.db``.
# Public, not license- or machine-dependent. SQLCipher 4 defaults.
_DEVICE_LIBRARY_KEY = "r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls"

_EXPORT_DB_REL = Path("PIONEER") / "rekordbox" / "exportLibrary.db"

# One JOIN pulls every field a RekordboxTrack needs; reused for the whole
# collection and for a single playlist (which just adds a WHERE + ORDER BY).
_TRACK_COLUMNS = """
    c.content_id, c.title, c.bpmx100, c.length, c.path, c.djComment,
    c.dateAdded, c.releaseDate, c.image_id, c.analysisDataFilePath,
    ar.name AS artist, al.name AS album, g.name AS genre, k.name AS key_name
    FROM content c
    LEFT JOIN artist ar ON ar.artist_id = c.artist_id_artist
    LEFT JOIN album al ON al.album_id = c.album_id
    LEFT JOIN genre g ON g.genre_id = c.genre_id
    LEFT JOIN key k ON k.key_id = c.key_id
"""


def _clean(value: Any) -> str | None:
    """Return a stripped non-empty string, or ``None``."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


class UsbExportSource(RekordboxSource):
    """Read a mounted Rekordbox export from its ``exportLibrary.db``."""

    def __init__(self, device_root: Path | str) -> None:
        self.device_root = Path(device_root)
        self.db_path = self.device_root / _EXPORT_DB_REL
        self._lock = threading.Lock()
        self._conn: Any | None = None

    def _connect(self) -> Any:
        """Return a cached, unlocked SQLCipher connection to the export DB."""
        if self._conn is not None:
            return self._conn
        if not self.db_path.exists():
            raise RekordboxUnavailable(f"No exportLibrary.db on device: {self.db_path}")
        try:
            from sqlcipher3 import dbapi2 as sqlite
        except Exception as exc:  # pragma: no cover - import-time failure
            raise RekordboxUnavailable(f"sqlcipher3 not available: {exc}") from exc
        try:
            conn = sqlite.connect(str(self.db_path), check_same_thread=False)
            conn.row_factory = sqlite.Row
            conn.execute(f"PRAGMA key = '{_DEVICE_LIBRARY_KEY}'")
            # Force a read so a wrong key / corrupt file fails here, not mid-query.
            conn.execute("SELECT count(*) FROM sqlite_master")
        except Exception as exc:
            raise RekordboxUnavailable(f"Could not open exportLibrary.db: {exc}") from exc
        self._conn = conn
        return conn

    def _query(self, sql: str, params: tuple[Any, ...] = ()) -> list[Any]:
        with self._lock:
            conn = self._connect()
            return conn.execute(sql, params).fetchall()

    def check_available(self) -> None:
        with self._lock:
            self._connect()

    def close(self) -> None:
        """Close the cached DB connection (e.g. before the device is ejected)."""
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # pragma: no cover - best-effort cleanup
                    pass
                self._conn = None

    def _resolve(self, rel: str) -> Path:
        """Resolve a device-root-relative path (leading slash) to the mount."""
        return self.device_root / rel.lstrip("/")

    def _row_to_track(self, row: Any) -> RekordboxTrack:
        comment = _clean(row["djComment"])
        bpm_raw = row["bpmx100"]
        return RekordboxTrack(
            id=str(row["content_id"]),
            title=str(row["title"] or ""),
            artist=_clean(row["artist"]),
            album=_clean(row["album"]),
            genre=_clean(row["genre"]),
            bpm=float(bpm_raw) / 100.0 if bpm_raw else None,
            key=_clean(row["key_name"]),
            duration_seconds=row["length"] or None,
            file_path=_clean(row["path"]),
            comment=comment,
            soundcloud_id=extract_soundcloud_id(comment),
            date_added=_clean(row["dateAdded"]),
            release_date=_clean(row["releaseDate"]),
            has_artwork=bool(row["image_id"]),
            has_waveform=bool(_clean(row["analysisDataFilePath"])),
        )

    def list_all_tracks(self, limit: int | None = None) -> list[RekordboxTrack]:
        sql = f"SELECT {_TRACK_COLUMNS}"
        if limit is not None:
            sql += " LIMIT ?"
            rows = self._query(sql, (limit,))
        else:
            rows = self._query(sql)
        return [self._row_to_track(r) for r in rows]

    def list_playlists(self) -> list[RekordboxPlaylist]:
        """Return all playlists and folders as a flat list.

        Device Library Plus encodes folders as ``attribute == 1`` and smart
        playlists as ``attribute == 4``; everything else is a static list. Smart
        playlists are materialised into ``playlist_content`` on export, so their
        track count comes from the same membership table as static lists.
        """
        counts = {
            r["playlist_id"]: r["n"]
            for r in self._query("SELECT playlist_id, count(*) AS n FROM playlist_content GROUP BY playlist_id")
        }
        rows = self._query("SELECT playlist_id, name, attribute, playlist_id_parent FROM playlist ORDER BY sequenceNo")
        out: list[RekordboxPlaylist] = []
        for r in rows:
            attribute = int(r["attribute"] or 0)
            is_folder = attribute == 1
            parent = r["playlist_id_parent"]
            out.append(
                RekordboxPlaylist(
                    id=str(r["playlist_id"]),
                    name=str(r["name"] or ""),
                    parent_id=str(parent) if parent else None,
                    is_folder=is_folder,
                    is_smart=attribute == 4,
                    track_count=0 if is_folder else counts.get(r["playlist_id"], 0),
                )
            )
        return out

    def list_playlist_tracks(self, playlist_id: str) -> list[RekordboxTrack]:
        """Return a playlist's tracks in user-defined order."""
        rows = self._query(
            f"SELECT {_TRACK_COLUMNS}"
            " JOIN playlist_content pc ON pc.content_id = c.content_id"
            " WHERE pc.playlist_id = ? ORDER BY pc.sequenceNo",
            (playlist_id,),
        )
        return [self._row_to_track(r) for r in rows]

    def get_track_artwork(self, track_id: str, *, small: bool = True) -> bytes | None:
        """Read a track's artwork JPEG from the device, or ``None`` if absent.

        USB exports store a single artwork variant per track (no ``_s``
        thumbnail), so ``small`` is accepted for interface parity but does not
        change which file is served.
        """
        rows = self._query(
            "SELECT img.path FROM content c JOIN image img ON img.image_id = c.image_id WHERE c.content_id = ?",
            (track_id,),
        )
        if not rows:
            return None
        rel = _clean(rows[0]["path"])
        if not rel:
            return None
        try:
            return self._resolve(rel).read_bytes()
        except OSError:
            return None

    def get_track_audio_path(self, track_id: str) -> Path | None:
        """Return the on-device audio file path for a track, or ``None``.

        Resolves the track's device-relative ``path`` against the mount and
        confirms it stays within the device root (guarding against traversal)
        and exists.
        """
        rows = self._query("SELECT path FROM content WHERE content_id = ?", (track_id,))
        if not rows:
            return None
        rel = _clean(rows[0]["path"])
        if not rel:
            return None
        resolved = self._resolve(rel).resolve()
        root = self.device_root.resolve()
        if not resolved.is_relative_to(root) or not resolved.is_file():
            return None
        return resolved

    def get_track_waveform_preview(self, track_id: str) -> bytes | None:
        """Return the raw PWV4 color preview bytes for a track, or ``None``.

        The preview lives in the ``.EXT`` ANLZ sidecar next to the ``.DAT``
        referenced by ``analysisDataFilePath``; decoded by the same scan the
        local source uses.
        """
        rows = self._query("SELECT analysisDataFilePath FROM content WHERE content_id = ?", (track_id,))
        if not rows:
            return None
        rel = _clean(rows[0]["analysisDataFilePath"])
        if not rel:
            return None
        ext = self._resolve(rel).with_suffix(".EXT")
        try:
            mtime_ns = ext.stat().st_mtime_ns
        except OSError:
            return None
        return read_pwv4(str(ext), mtime_ns)

    def get_track_waveform_blue(self, track_id: str) -> bytes | None:
        """Return the raw PWAV monochrome preview bytes for a track, or ``None``.

        The PWAV tag lives in the ``.DAT`` ANLZ file referenced by
        ``analysisDataFilePath`` (the colour PWV4 is in the ``.EXT`` sidecar).
        """
        rows = self._query("SELECT analysisDataFilePath FROM content WHERE content_id = ?", (track_id,))
        if not rows:
            return None
        rel = _clean(rows[0]["analysisDataFilePath"])
        if not rel:
            return None
        dat = self._resolve(rel).with_suffix(".DAT")
        try:
            mtime_ns = dat.stat().st_mtime_ns
        except OSError:
            return None
        return read_pwav(str(dat), mtime_ns)

    def get_analysis_paths(self, track_id: str) -> tuple[Path | None, Path | None]:
        """Return the ``(.DAT, .EXT)`` ANLZ sidecar paths for a track."""
        rows = self._query("SELECT analysisDataFilePath FROM content WHERE content_id = ?", (track_id,))
        if not rows:
            return None, None
        rel = _clean(rows[0]["analysisDataFilePath"])
        if not rel:
            return None, None
        base = self._resolve(rel)
        dat = base.with_suffix(".DAT")
        ext = base.with_suffix(".EXT")
        return (dat if dat.exists() else None, ext if ext.exists() else None)
