"""
API dependencies - shared utilities for FastAPI routes.

Dependency injection for common operations like settings, clients, etc.
"""

from pathlib import Path

from fastapi import HTTPException, status

from backend.core.services import app_settings as app_settings_service
from backend.core.services import cache_db


def get_root_folder() -> Path:
    """
    Get root music folder from settings.

    Returns
    -------
    Path
        Root folder for music library
    """
    return Path(app_settings_service.get_root_music_folder()).expanduser()


def validate_file_path(file_path: str, root_folder: Path) -> Path:
    """
    Validate that a file path is within the root folder.

    Security check to prevent directory traversal attacks.

    Parameters
    ----------
    file_path : str
        Relative or absolute file path
    root_folder : Path
        Root folder that file must be within

    Returns
    -------
    Path
        Resolved absolute path

    Raises
    ------
    HTTPException
        If path is outside root folder or doesn't exist
    """
    # Convert to Path and resolve
    path = Path(file_path)

    # If relative, make it relative to root
    if not path.is_absolute():
        path = root_folder / path

    path = path.resolve()

    # Security check: must be within root folder (resolve root too to handle symlinks)
    resolved_root = root_folder.resolve()
    try:
        path.relative_to(resolved_root)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="File path is outside allowed directory",
        ) from e

    # Check existence — evict from cache if the file has been deleted
    if not path.exists():
        try:
            cache_db.delete_track(path)
            cache_db.delete_peaks(path)
        except RuntimeError:
            pass  # cache_db not yet initialized
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path.name}")

    return path


def validate_folder_mode(mode: str) -> str:
    """
    Validate folder mode selection.

    Parameters
    ----------
    mode : str
        Subfolder name (e.g. ``"prepare"``) or empty string for the root.
        Must contain only alphanumeric characters, hyphens, or underscores to
        prevent directory traversal.

    Returns
    -------
    str
        Validated mode

    Raises
    ------
    HTTPException
        If mode contains unsafe characters
    """
    import re

    if mode == "" or re.fullmatch(r"[a-zA-Z0-9_-]+", mode):
        return mode
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Invalid mode: must be alphanumeric (hyphens and underscores allowed).",
    )
