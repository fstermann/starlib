"""REST API for folder display and per-folder ruleset configuration."""

from __future__ import annotations

from fastapi import APIRouter

from backend.core.services import folder_config as folder_config_service
from backend.schemas.folder_config import FoldersConfig

router = APIRouter(prefix="/api/folders", tags=["folders"])


@router.get("/config", response_model=FoldersConfig)
def get_folders_config() -> FoldersConfig:
    """Return the folder display and ruleset configuration."""
    return folder_config_service.load_folders()


@router.put("/config", response_model=FoldersConfig)
def update_folders_config(config: FoldersConfig) -> FoldersConfig:
    """Replace the folder display and ruleset configuration."""
    return folder_config_service.save_folders(config)
