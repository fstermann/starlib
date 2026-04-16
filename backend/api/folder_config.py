"""REST API for folder display and per-folder ruleset configuration."""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel

from backend.core.services import folder_config as folder_config_service
from backend.schemas.folder_config import FoldersConfig
from backend.schemas.settings import FolderRulesetBinding

router = APIRouter(prefix="/api/folders", tags=["folders"])


@router.get("/config", response_model=FoldersConfig)
def get_folders_config() -> FoldersConfig:
    """Return the folder display and ruleset configuration."""
    return folder_config_service.load_folders()


@router.put("/config", response_model=FoldersConfig)
def update_folders_config(config: FoldersConfig) -> FoldersConfig:
    """Replace the folder display and ruleset configuration."""
    return folder_config_service.save_folders(config)


# ---------------------------------------------------------------------------
# Per-path ruleset bindings
# ---------------------------------------------------------------------------


class FolderRulesetResponse(BaseModel):
    """A resolved folder ruleset binding.

    When the ``source_path`` differs from the requested path, the binding
    was inherited from a recursive ancestor.
    """

    path: str
    ruleset_id: str | None
    recursive: bool = False
    source_path: str | None = None


class FolderRulesetUpdate(BaseModel):
    ruleset_id: str | None
    recursive: bool = False


class FolderRulesetsResponse(BaseModel):
    folder_rulesets: dict[str, FolderRulesetBinding]


@router.get("/rulesets-by-path", response_model=FolderRulesetsResponse)
def get_all_folder_rulesets() -> FolderRulesetsResponse:
    """Return all direct path→binding mappings (no inheritance applied)."""
    return FolderRulesetsResponse(
        folder_rulesets=folder_config_service.get_all_folder_rulesets(),
    )


@router.get("/ruleset", response_model=FolderRulesetResponse)
def get_folder_ruleset(
    path: str = Query(..., description="Absolute folder path"),
) -> FolderRulesetResponse:
    """Return the resolved ruleset binding for an absolute folder path."""
    resolved = folder_config_service.resolve_ruleset_for_path(path)
    return FolderRulesetResponse(
        path=path,
        ruleset_id=resolved.ruleset_id,
        recursive=resolved.recursive,
        source_path=resolved.source_path,
    )


@router.put("/ruleset", response_model=FolderRulesetResponse)
def set_folder_ruleset(
    body: FolderRulesetUpdate,
    path: str = Query(..., description="Absolute folder path"),
) -> FolderRulesetResponse:
    """Bind a ruleset to an absolute folder path."""
    folder_config_service.set_ruleset_for_path(path, body.ruleset_id, body.recursive)
    return FolderRulesetResponse(
        path=path,
        ruleset_id=body.ruleset_id,
        recursive=body.recursive,
        source_path=path,
    )


@router.delete("/ruleset")
def delete_folder_ruleset(
    path: str = Query(..., description="Absolute folder path"),
) -> FolderRulesetResponse:
    """Remove the ruleset binding for a folder path."""
    folder_config_service.delete_ruleset_for_path(path)
    return FolderRulesetResponse(path=path, ruleset_id=None)
