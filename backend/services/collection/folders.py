"""Folder-level operations on the library: validation, layout, bulk moves.

Note: most of this module currently has no callers inside the backend — see the
audit note in BACKEND-RESTRUCTURE.md. It is kept as-is rather than deleted.
"""

import logging
from collections import Counter
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from backend.infra.audio.folders import FolderHandler, load_tracks

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
