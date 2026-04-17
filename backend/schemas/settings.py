"""Top-level settings schema.

Persists all user configuration (app settings, rulesets, folders, AI) in a
single ``settings.json`` file.
"""

from pydantic import BaseModel, Field, field_validator

from backend.schemas.ai import AiSettings
from backend.schemas.folder_config import FoldersConfig
from backend.schemas.ruleset import RulesetsConfig


class AppSettings(BaseModel):
    """Application-level user settings."""

    preferred_output_format: str = "aiff"
    root_music_folder: str = ""


class FolderRulesetBinding(BaseModel):
    """A per-folder ruleset assignment.

    ``recursive=True`` means the binding also applies to descendant folders
    that have no explicit binding of their own.
    """

    ruleset_id: str | None = None
    recursive: bool = False


class Settings(BaseModel):
    """Consolidated settings file model."""

    app: AppSettings = Field(default_factory=AppSettings)
    rulesets: RulesetsConfig = Field(default_factory=RulesetsConfig)
    folders: FoldersConfig = Field(default_factory=FoldersConfig)
    ai: AiSettings = Field(default_factory=AiSettings)
    folder_rulesets: dict[str, FolderRulesetBinding] = Field(default_factory=dict)
    """Mapping of absolute folder paths to ruleset bindings.

    Explicit bindings on a folder always win. When a folder has no explicit
    binding, the nearest ancestor with ``recursive=True`` is inherited.
    """

    @field_validator("folder_rulesets", mode="before")
    @classmethod
    def _upgrade_legacy_bindings(cls, value: object) -> object:
        """Accept the legacy ``{path: ruleset_id|None}`` shape on load."""
        if not isinstance(value, dict):
            return value
        upgraded: dict[str, object] = {}
        for path, binding in value.items():
            if binding is None or isinstance(binding, str):
                upgraded[path] = {"ruleset_id": binding, "recursive": False}
            else:
                upgraded[path] = binding
        return upgraded
