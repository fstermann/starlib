"""Keeping the SQLite cache in step with what is on disk.

Owns the per-session scan state: which folders have been walked in this server
process, which are mid-scan. The cache itself survives restarts; this bookkeeping
does not, which is why it lives in module state rather than in the DB.
"""

import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from backend.infra import cache
from backend.infra.audio.folders import load_tracks_recursive
from backend.infra.audio.track_handler import TrackHandler

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-session indexing state
# The DB holds data across restarts; this dict only tracks which folders
# have been scanned in the current server process (for mtime comparison).
# ---------------------------------------------------------------------------
_indexing: set[Path] = set()  # folders with a scan in progress
_indexed_this_session: set[Path] = set()  # folders fully scanned this session
_state_lock = threading.Lock()


def _index_one(root_folder: Path, file: Path) -> None:
    """Index a single file into the DB if its mtime has changed."""
    try:
        stat = file.stat()
        mtime = stat.st_mtime
        if cache.get_track_mtime(file) == mtime:
            return  # unchanged
        handler = TrackHandler(root_folder=root_folder, file=file)
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
        sc_id = track_info.starlib_meta.soundcloud_id if track_info.starlib_meta else None
        cache.upsert_track(
            file_path=file,
            folder=file.parent.resolve(),
            title=track_info.title or None,
            artist_str=track_info.artist_str,
            genre=track_info.genre or None,
            key=track_info.key,
            bpm=track_info.bpm,
            release_date=track_info.release_date,
            has_artwork=track_info.artwork is not None,
            file_size=stat.st_size,
            file_format=file.suffix,
            duration=track_info.length,
            is_complete=track_info.complete,
            missing_fields=missing,
            mtime=mtime,
            soundcloud_id=sc_id,
            original_artist=track_info.original_artist_str or None,
            remixer=track_info.remixer_str or None,
            mix_name=track_info.mix_name,
            release_year=track_info.release_year,
            user_comment=track_info.user_comment,
        )
    except Exception as e:
        logger.warning("Skipping unreadable file %s: %s", file, e)


def _load_folder_to_db(folder: Path, root_folder: Path) -> None:
    """Scan *folder* recursively, indexing new/changed files into the DB."""
    resolved = folder.resolve()
    try:
        audio_files = load_tracks_recursive(folder)
        with ThreadPoolExecutor() as pool:
            futures = [pool.submit(_index_one, root_folder, f) for f in audio_files]
            for _ in as_completed(futures):
                pass
        logger.info("Finished indexing %s (%d files)", folder, len(audio_files))
    except Exception as e:
        logger.error("Failed to index folder %s: %s", folder, e)
    finally:
        with _state_lock:
            _indexing.discard(resolved)
            _indexed_this_session.add(resolved)


def ensure_folder_indexed(folder: Path, root_folder: Path | None = None) -> None:
    """Trigger a background scan of *folder* if not done this session.

    The scan is recursive, so indexing a parent also covers all subfolders.
    If *root_folder* is not given it defaults to *folder* (legacy callers).
    """
    resolved = folder.resolve()
    effective_root = root_folder or folder
    with _state_lock:
        if resolved in _indexed_this_session or resolved in _indexing:
            return
        # A parent folder's recursive scan already covered this subfolder.
        for indexed in _indexed_this_session:
            if resolved != indexed and str(resolved).startswith(str(indexed) + "/"):
                return
        _indexing.add(resolved)
    threading.Thread(target=_load_folder_to_db, args=(folder, effective_root), daemon=True).start()


def is_indexing(folder: Path) -> bool:
    """True while the folder is being indexed in the background."""
    return folder.resolve() in _indexing


def reindex_file(root_folder: Path, file_path: Path) -> None:
    """Re-index a single file immediately without a full folder re-scan."""
    _index_one(root_folder, file_path)


def invalidate_cache(folder: Path | None = None) -> None:
    """Drop cached data for *folder*, or all if None (backwards compat alias)."""
    if folder is None:
        with _state_lock:
            _indexed_this_session.clear()
            _indexing.clear()
    else:
        resolved = folder.resolve()
        cache.invalidate_folder(resolved)
        with _state_lock:
            _indexed_this_session.discard(resolved)
