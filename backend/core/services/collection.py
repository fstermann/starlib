"""
Collection Service - File listing and folder operations.

This module handles file system operations for the music collection.
No UI framework dependencies.
"""

import logging
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from backend.core.services import cache_db
from soundcloud_tools.handler.folder import FolderHandler
from soundcloud_tools.handler.track import TrackHandler, TrackInfo
from soundcloud_tools.utils import load_tracks

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-session indexing state
# The DB holds data across restarts; this dict only tracks which folders
# have been scanned in the current server process (for mtime comparison).
# ---------------------------------------------------------------------------
_indexing: set[Path] = set()  # folders with a scan in progress
_indexed_this_session: set[Path] = set()  # folders fully scanned this session
_state_lock = threading.Lock()


def _index_one(folder: Path, file: Path) -> None:
    """Index a single file into the DB if its mtime has changed."""
    try:
        stat = file.stat()
        mtime = stat.st_mtime
        if cache_db.get_track_mtime(file) == mtime:
            return  # unchanged
        handler = TrackHandler(root_folder=folder, file=file)
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
        sc_id = track_info.comment.soundcloud_id if track_info.comment else None
        cache_db.upsert_track(
            file_path=file,
            folder=folder.resolve(),
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
        )
    except Exception as e:
        logger.warning("Skipping unreadable file %s: %s", file, e)


def _load_folder_to_db(folder: Path) -> None:
    """Scan *folder*, indexing new/changed files into the DB."""
    resolved = folder.resolve()
    try:
        audio_files = load_tracks(folder)
        with ThreadPoolExecutor() as pool:
            futures = [pool.submit(_index_one, folder, f) for f in audio_files]
            for _ in as_completed(futures):
                pass
        logger.info("Finished indexing %s (%d files)", folder, len(audio_files))
    except Exception as e:
        logger.error("Failed to index folder %s: %s", folder, e)
    finally:
        with _state_lock:
            _indexing.discard(resolved)
            _indexed_this_session.add(resolved)


def ensure_folder_indexed(folder: Path) -> None:
    """Trigger a background scan of *folder* if not done this session."""
    resolved = folder.resolve()
    with _state_lock:
        if resolved in _indexed_this_session or resolved in _indexing:
            return
        _indexing.add(resolved)
    threading.Thread(target=_load_folder_to_db, args=(folder,), daemon=True).start()


def is_indexing(folder: Path) -> bool:
    """True while the folder is being indexed in the background."""
    return folder.resolve() in _indexing


# Backwards-compatible alias used by the API layer
def is_cache_loading(folder: Path) -> bool:
    return is_indexing(folder)


def get_collection_soundcloud_ids(folder: Path) -> list[int]:
    """Return all SoundCloud track IDs linked to collection tracks."""
    ensure_folder_indexed(folder)
    return cache_db.get_soundcloud_ids(folder)


def invalidate_file(file_path: Path) -> None:
    """Remove a file from the cache so it gets re-indexed on next scan."""
    cache_db.invalidate_file(file_path)
    with _state_lock:
        _indexed_this_session.discard(file_path.parent.resolve())


def invalidate_cache(folder: Path | None = None) -> None:
    """Drop cached data for *folder*, or all if None (backwards compat alias)."""
    if folder is None:
        with _state_lock:
            _indexed_this_session.clear()
            _indexing.clear()
    else:
        resolved = folder.resolve()
        cache_db.invalidate_folder(resolved)
        with _state_lock:
            _indexed_this_session.discard(resolved)


def list_audio_files(folder: Path) -> list[Path]:
    """
    List all audio files in a folder.

    Parameters
    ----------
    folder : Path
        Folder to scan

    Returns
    -------
    list[Path]
        List of audio file paths
    """
    return load_tracks(folder)


def get_folder_stats(folder: Path) -> dict[str, int]:
    """
    Get statistics about audio files in a folder.

    Parameters
    ----------
    folder : Path
        Folder to analyze

    Returns
    -------
    dict[str, int]
        Dictionary mapping file extension to count
        Example: {".mp3": 150, ".aiff": 50, ".wav": 10}
    """
    files = load_tracks(folder)
    suffixes = [f.suffix for f in files]
    return dict(Counter(suffixes))


def validate_folder(folder: Path) -> tuple[bool, str | None]:
    """
    Validate that a folder exists and is accessible.

    Parameters
    ----------
    folder : Path
        Folder path to validate

    Returns
    -------
    tuple[bool, str | None]
        (is_valid, error_message)
        Returns (True, None) if valid
        Returns (False, error_message) if invalid
    """
    try:
        folder = folder.expanduser()
        if not folder.exists():
            return False, "Folder does not exist"
        if not folder.is_dir():
            return False, "Path is not a directory"
        return True, None
    except Exception as e:
        raise e
        return False, str(e)


def get_folder_path(root_folder: Path, mode: str) -> tuple[Path, str | None]:
    """
    Get the folder path for a given mode.

    Parameters
    ----------
    root_folder : Path
        Root music folder
    mode : str
        Mode: "prepare", "collection", "cleaned", or "" (direct)

    Returns
    -------
    tuple[Path, str | None]
        (folder_path, error_message)
        Returns (path, None) if successful
        Returns (path, error) if validation fails
    """
    folder = root_folder / mode if mode else root_folder

    try:
        FolderHandler(folder=folder)
        return folder, None
    except ValidationError as e:
        return folder, f"Invalid folder: {e}"


def move_files_to_folder(
    source_folder: Path,
    target_folder: Path,
    file_filter=None,
) -> dict[str, list[Path] | int]:
    """
    Move audio files from source to target folder.

    Parameters
    ----------
    source_folder : Path
        Source folder containing files
    target_folder : Path
        Destination folder
    file_filter : callable, optional
        Function to filter files: filter(Path) -> bool

    Returns
    -------
    dict
        Result with keys:
        - "moved_files": list[Path] - Files that were moved
        - "count": int - Number of files moved
    """
    handler = FolderHandler(folder=source_folder)

    filters = [file_filter] if file_filter else []
    files = handler.collect_audio_files(*filters)

    handler.move_all_audio_files(target_folder, *filters)

    return {
        "moved_files": files,
        "count": len(files),
    }


def collect_recent_downloads(root_folder: Path, target_date: date | None = None) -> list[Path]:
    """
    Collect audio files from Downloads folder modified on a specific date.

    Parameters
    ----------
    root_folder : Path
        Root music folder (not used, but kept for consistency)
    target_date : date, optional
        Date to filter by. Defaults to today.

    Returns
    -------
    list[Path]
        List of audio files modified on target_date
    """
    if target_date is None:
        target_date = date.today()

    downloads_folder = Path.home() / "Downloads"
    handler = FolderHandler(folder=downloads_folder)

    filters = [lambda f: FolderHandler.last_modified(f).date() == target_date]
    return handler.collect_audio_files(*filters)


def check_if_folder_has_audio(folder: Path) -> bool:
    """
    Check if a folder contains any audio files.

    Parameters
    ----------
    folder : Path
        Folder to check

    Returns
    -------
    bool
        True if folder contains audio files
    """
    try:
        handler = FolderHandler(folder=folder)
        return handler.has_audio_files
    except ValidationError:
        return False


def load_all_track_infos(folder: Path) -> list[TrackInfo]:
    """Return TrackInfo objects for all tracks in a folder (from DB cache)."""
    ensure_folder_indexed(folder)
    rows = cache_db.get_all_tracks(folder.resolve())
    result: list[TrackInfo] = []
    for row in rows:
        try:
            result.append(
                TrackInfo(
                    title=row["title"] or "",
                    artist=row["artist_str"] or "",
                    genre=row["genre"] or "",
                    key=row["key"],
                    bpm=row["bpm"],
                    release_date=date.fromisoformat(row["release_date"]) if row["release_date"] else None,
                )
            )
        except Exception:
            pass
    return result


def filter_tracks_by_metadata(  # noqa: C901
    folder: Path,
    genres: list[str] | None = None,
    artists: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_values: list[int] | None = None,
    bpm_range: tuple[int, int] | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    search_query: str | None = None,
) -> list[int]:
    """
    Filter tracks by metadata criteria.

    Returns indices of tracks that match all specified criteria.

    Parameters
    ----------
    folder : Path
        Folder containing tracks
    genres : list[str], optional
        Filter by genres (OR logic)
    artists : list[str], optional
        Filter by artists (OR logic, substring match)
    keys : list[str], optional
        Filter by keys (OR logic)
    bpm_values : list[int], optional
        Filter by specific BPM values (OR logic)
    bpm_range : tuple[int, int], optional
        Filter by BPM range (inclusive)
    start_date : date, optional
        Minimum release date (inclusive)
    end_date : date, optional
        Maximum release date (inclusive)
    search_query : str, optional
        Search query (case-insensitive, searches title, artist, genre)

    Returns
    -------
    list[int]
        List of indices of tracks that match all criteria
    """
    track_infos = load_all_track_infos(folder)

    # Set defaults
    start_date = start_date or date.min
    end_date = end_date or date.today()

    selected_indices = []

    for i, track in enumerate(track_infos):
        # Genre filter
        if genres and track.genre not in genres:
            continue

        # Artist filter (substring match)
        if artists:
            if not any(artist in track.artist_str for artist in artists):
                continue

        # Key filter
        if keys and track.key not in keys:
            continue

        # BPM value filter
        if bpm_values and track.bpm not in bpm_values:
            continue

        # BPM range filter
        if bpm_range and track.bpm:
            if not (bpm_range[0] <= track.bpm <= bpm_range[1]):
                continue

        # Date range filter
        if track.release_date:
            if not (start_date <= track.release_date <= end_date):
                continue

        # Search query filter
        if search_query:
            search_lower = search_query.lower()
            searchable = [
                track.genre.lower(),
                track.artist_str.lower(),
                track.title.lower(),
            ]
            if not any(search_lower in field for field in searchable):
                continue

        # All filters passed
        selected_indices.append(i)

    return selected_indices


def get_collection_metadata_stats(folder: Path) -> dict:
    """
    Get statistics and filter values for a collection folder.

    Parameters
    ----------
    folder : Path
        Folder containing tracks

    Returns
    -------
    dict
        Keys: total_tracks, complete_tracks, incomplete_tracks, total_artists,
        total_genres, missing_fields, genres, artists, keys, bpm_min, bpm_max
    """
    ensure_folder_indexed(folder)
    return cache_db.get_stats(folder.resolve())


def list_and_filter_tracks(
    folder: Path,
    search_query: str | None = None,
    genres: list[str] | None = None,
    artists: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    sort_by: str = "file_name",
    sort_order: str = "asc",
) -> list:
    """
    List, filter, and sort tracks via SQL. Returns sqlite3.Row items.

    Parameters
    ----------
    folder : Path
        Folder to scan
    search_query : str, optional
        Case-insensitive substring search across title, artist, genre
    genres : list[str], optional
        Exact genre matches (OR logic)
    artists : list[str], optional
        Substring artist matches (OR logic)
    keys : list[str], optional
        Exact key matches (OR logic)
    bpm_min : int, optional
        Minimum BPM (inclusive)
    bpm_max : int, optional
        Maximum BPM (inclusive)
    start_date : date, optional
        Earliest release date (inclusive)
    end_date : date, optional
        Latest release date (inclusive)
    sort_by : str
        Field to sort by: title, artist, genre, bpm, key, release_date, file_name
    sort_order : str
        "asc" or "desc"

    Returns
    -------
    list[sqlite3.Row]
        Filtered and sorted track rows from the DB cache.
    """
    ensure_folder_indexed(folder)
    return cache_db.get_tracks(
        folder.resolve(),
        search_query=search_query,
        genres=genres,
        artists=artists,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
        start_date=start_date,
        end_date=end_date,
        sort_by=sort_by,
        sort_order=sort_order,
    )


def get_folder_filter_values(
    folder: Path,
    *,
    search_query: str | None = None,
    genres: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
) -> dict:
    """
    Get available filter values for a folder (for filter dropdowns).

    Parameters
    ----------
    folder : Path
        Folder to scan
    search_query : str, optional
        Active search filter (used to compute faceted counts)
    genres : list[str], optional
        Active genre filters (excluded from genre facet counts)
    keys : list[str], optional
        Active key filters (excluded from key facet counts)
    bpm_min : int, optional
        Active BPM minimum filter
    bpm_max : int, optional
        Active BPM maximum filter

    Returns
    -------
    dict
        Keys: genres, genre_counts, artists, keys, key_counts, bpm_min, bpm_max
    """
    ensure_folder_indexed(folder)
    return cache_db.get_filter_values(
        folder.resolve(),
        search_query=search_query,
        genres=genres,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
    )
