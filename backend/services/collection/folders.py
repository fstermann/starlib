"""Folder-level operations on the library: listing audio files, validation."""

import logging
from pathlib import Path

from backend.infra.audio.folders import load_tracks

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
