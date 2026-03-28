"""Shared helpers for metadata route modules."""

from pathlib import Path

from fastapi import HTTPException, status

from backend.api.deps import validate_folder_mode
from backend.core.services import collection
from soundcloud_tools.handler.folder import FolderHandler


def resolve_folder(mode: str, root_folder: Path) -> Path:
    """Resolve a folder mode string to an absolute path, validating it exists."""
    validated_mode = validate_folder_mode(mode)
    folder_handler = FolderHandler(folder=root_folder)

    if validated_mode == "prepare":
        folder_path = folder_handler.get_prepare_folder()
    elif validated_mode == "collection":
        folder_path = folder_handler.get_collection_folder()
    elif validated_mode == "cleaned":
        folder_path = folder_handler.get_cleaned_folder()
    else:
        folder_path = root_folder

    is_valid, errors = collection.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=errors)

    return folder_path
