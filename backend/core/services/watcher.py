"""Watchdog file system observer for real-time cache updates.

Monitors the music root folder and updates the SQLite cache immediately
when audio files are created, modified, deleted, or moved — replacing the
5-minute TTL that the old in-memory cache relied on.
"""

import hashlib
import logging
import threading
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from backend.core.services import cache_db
from soundcloud_tools.handler.track import TrackHandler

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".mp3", ".flac", ".aif", ".aiff", ".wav", ".m4a"}
DEBOUNCE_DELAY = 1.5  # seconds — avoid double-triggers from editor saves


class _MusicFolderHandler(FileSystemEventHandler):
    def __init__(self, root_folder: Path) -> None:
        self._root_folder = root_folder
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def _is_audio(self, path: str) -> bool:
        return Path(path).suffix.lower() in AUDIO_EXTENSIONS

    def _schedule(self, key: str, action) -> None:
        with self._lock:
            existing = self._timers.get(key)
            if existing:
                existing.cancel()
            t = threading.Timer(DEBOUNCE_DELAY, action)
            self._timers[key] = t
            t.start()

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory and self._is_audio(event.src_path):
            p = Path(event.src_path)
            self._schedule(str(p), lambda: self._index(p))

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory and self._is_audio(event.src_path):
            p = Path(event.src_path)
            self._schedule(str(p), lambda: self._index(p))

    def on_deleted(self, event: FileSystemEvent) -> None:
        if not event.is_directory and self._is_audio(event.src_path):
            p = Path(event.src_path)
            cache_db.delete_track(p)
            cache_db.delete_peaks(p)
            _delete_artwork_cache(p)
            logger.info("Removed from index: %s", p.name)

    def on_moved(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = Path(event.src_path)
        dest = Path(event.dest_path)
        if self._is_audio(str(src)):
            cache_db.delete_track(src)
        if self._is_audio(str(dest)):
            self._schedule(str(dest), lambda: self._index(dest))

    def _index(self, path: Path) -> None:
        """Read metadata for *path* and upsert into the DB."""
        if not path.exists():
            return
        # Invalidate artwork cache so stale art isn't served after an edit.
        _delete_artwork_cache(path)
        try:
            stat = path.stat()
            handler = TrackHandler(root_folder=self._root_folder, file=path)
            track_info = handler.track_info
            missing: list[str] = []
            if not track_info.title:
                missing.append("title")
            if not track_info.genre:
                missing.append("genre")
            if not track_info.release_date:
                missing.append("release_date")
            if not track_info.artwork:
                missing.append("artwork")
            cache_db.upsert_track(
                file_path=path,
                folder=path.parent.resolve(),
                title=track_info.title or None,
                artist_str=track_info.artist_str,
                genre=track_info.genre or None,
                key=track_info.key,
                bpm=track_info.bpm,
                release_date=track_info.release_date,
                has_artwork=track_info.artwork is not None,
                file_size=stat.st_size,
                file_format=path.suffix,
                duration=track_info.length,
                is_complete=track_info.complete,
                missing_fields=missing,
                mtime=stat.st_mtime,
            )
            logger.info("Indexed: %s", path.name)
        except Exception as e:
            logger.warning("Failed to index %s: %s", path, e)


_observer: Observer | None = None


def start_watcher(root_folder: Path) -> None:
    """Start the FSEvents/inotify observer watching *root_folder* recursively."""
    global _observer
    if _observer is not None:
        return
    _observer = Observer()
    _observer.schedule(_MusicFolderHandler(root_folder), str(root_folder), recursive=True)
    _observer.start()
    logger.info("File watcher started for %s", root_folder)


def stop_watcher() -> None:
    """Stop and join the observer thread."""
    global _observer
    if _observer is not None:
        _observer.stop()
        _observer.join()
        _observer = None
        logger.info("File watcher stopped")


def _delete_artwork_cache(file_path: Path) -> None:
    """Remove the cached artwork file for *file_path*, if any."""
    from backend.config import get_backend_settings

    settings = get_backend_settings()
    key = hashlib.sha256(str(file_path).encode()).hexdigest()
    cached = settings.cache_dir / "artwork" / f"{key}.jpg"
    try:
        cached.unlink(missing_ok=True)
    except OSError:
        pass
