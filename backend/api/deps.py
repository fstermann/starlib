"""
API dependencies - shared utilities for FastAPI routes.

Dependency injection for common operations like settings, clients, etc.
"""

from pathlib import Path

from fastapi import HTTPException, status

from soundcloud_tools.settings import get_settings


def get_root_folder() -> Path:
    """
    Get root music folder from settings.

    Returns
    -------
    Path
        Root folder for music library
    """
    settings = get_settings()
    return Path(settings.root_music_folder).expanduser()


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

    # Security check: must be within root folder
    try:
        path.relative_to(root_folder)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="File path is outside allowed directory",
        ) from e

    # Check existence
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path.name}")

    return path


def validate_folder_mode(mode: str) -> str:
    """
    Validate folder mode selection.

    Parameters
    ----------
    mode : str
        Mode: "prepare", "collection", "cleaned", or ""

    Returns
    -------
    str
        Validated mode

    Raises
    ------
    HTTPException
        If mode is invalid
    """
    valid_modes = ["prepare", "collection", "cleaned", ""]
    if mode not in valid_modes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid mode. Must be one of: {', '.join(valid_modes)}"
        )
    return mode
