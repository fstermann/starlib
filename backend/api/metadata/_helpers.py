"""Shared helpers for metadata route modules."""

from pathlib import Path

from fastapi import HTTPException, status

from backend.api.deps import validate_folder_mode
from backend.core.services import collection


def resolve_folder(mode: str, root_folder: Path) -> Path:
    """Resolve a folder mode string to an absolute path, validating it exists."""
    validated_mode = validate_folder_mode(mode)
    folder_path = root_folder / validated_mode if validated_mode else root_folder

    is_valid, errors = collection.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=errors)

    return folder_path
