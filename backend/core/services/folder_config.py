"""Folder display config facade over the consolidated settings file."""

from backend.core.services import settings as settings_service
from backend.schemas.folder_config import FoldersConfig


def load_folders() -> FoldersConfig:
    """Return the folder configuration."""
    return settings_service.load().folders


def save_folders(config: FoldersConfig) -> FoldersConfig:
    """Persist the folder configuration."""
    settings = settings_service.load()
    settings.folders = config
    settings_service.save(settings)
    return config


def get_ruleset_id_for_folder(folder_name: str) -> str | None:
    """Return the ruleset id configured for a folder, or ``None`` for the global active."""
    for folder in load_folders().folders:
        if folder.name == folder_name:
            return folder.ruleset_id
    return None
