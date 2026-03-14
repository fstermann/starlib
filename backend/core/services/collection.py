"""
Collection Service - File listing and folder operations.

This module handles file system operations for the music collection.
No UI framework dependencies.
"""

import logging
from collections import Counter
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from soundcloud_tools.handler.folder import FolderHandler
from soundcloud_tools.handler.track import TrackHandler
from soundcloud_tools.utils import load_tracks

logger = logging.getLogger(__name__)


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


def load_all_track_infos(folder: Path):
    """
    Load TrackInfo for all tracks in a folder.

    Parameters
    ----------
    folder : Path
        Folder containing audio files

    Returns
    -------
    list[TrackInfo]
        List of track information objects
    """
    return [handler.track_info for handler in TrackHandler.load_all(folder)]


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


def get_collection_metadata_stats(folder: Path) -> dict[str, Counter]:
    """
    Get statistics about metadata in a collection.

    Parameters
    ----------
    folder : Path
        Folder containing tracks

    Returns
    -------
    dict[str, Counter]
        Dictionary with keys:
        - "genres": Counter of genres
        - "artists": Counter of artists
        - "keys": Counter of keys
        - "bpms": Counter of BPM values
        - "versions": Counter of version strings from comments
    """
    track_infos = load_all_track_infos(folder)

    genres = Counter(t.genre for t in track_infos)

    # Flatten artists (handles both str and list[str])
    all_artists = []
    for t in track_infos:
        if isinstance(t.artist, list):
            all_artists.extend(t.artist)
        else:
            all_artists.append(t.artist)
    artists = Counter(all_artists)

    keys = Counter(t.key for t in track_infos if t.key)
    bpms = Counter(t.bpm for t in track_infos if t.bpm)
    versions = Counter(t.comment.version for t in track_infos if t.comment and t.comment.version)

    return {
        "genres": genres,
        "artists": artists,
        "keys": keys,
        "bpms": bpms,
        "versions": versions,
    }
