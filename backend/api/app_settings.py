"""REST API for application-level user settings."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from backend.core.services import app_settings as app_settings_service
from backend.core.services import watcher

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings() -> dict:
    """Return application settings."""
    return app_settings_service.load()


@router.put("")
def update_settings(body: dict) -> dict:
    """Update application settings (partial merge allowed)."""
    current = app_settings_service.load()
    current.update(body)
    return app_settings_service.save(current)


class RootFolderResponse(BaseModel):
    root_music_folder: str


class RootFolderRequest(BaseModel):
    root_music_folder: str


@router.get("/root-folder", response_model=RootFolderResponse)
def get_root_folder() -> RootFolderResponse:
    """Return the current root music folder path."""
    return RootFolderResponse(root_music_folder=app_settings_service.get_root_music_folder())


@router.put("/root-folder", response_model=RootFolderResponse)
def update_root_folder(body: RootFolderRequest) -> RootFolderResponse:
    """Update the root music folder path and hot-reload the file watcher."""
    path = body.root_music_folder.strip()
    if not path:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Path cannot be empty")
    expanded = Path(path).expanduser()
    if not expanded.exists():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Path does not exist: {expanded}",
        )
    if not expanded.is_dir():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Path must be a directory",
        )
    app_settings_service.set_root_music_folder(path)
    watcher.restart_watcher(expanded)
    return RootFolderResponse(root_music_folder=path)
