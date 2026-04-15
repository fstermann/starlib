"""Top-level settings schema.

Persists all user configuration (app settings, rulesets, folders, AI) in a
single ``settings.json`` file.
"""

from pydantic import BaseModel, Field

from backend.schemas.ai import AiSettings
from backend.schemas.folder_config import FoldersConfig
from backend.schemas.ruleset import RulesetsConfig


class AppSettings(BaseModel):
    """Application-level user settings."""

    preferred_output_format: str = "aiff"
    root_music_folder: str = ""


class Settings(BaseModel):
    """Consolidated settings file model."""

    app: AppSettings = Field(default_factory=AppSettings)
    rulesets: RulesetsConfig = Field(default_factory=RulesetsConfig)
    folders: FoldersConfig = Field(default_factory=FoldersConfig)
    ai: AiSettings = Field(default_factory=AiSettings)
