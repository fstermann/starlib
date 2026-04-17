"""Folder display config facade over the consolidated settings file."""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.services import settings as settings_service
from backend.schemas.folder_config import FoldersConfig
from backend.schemas.settings import FolderRulesetBinding


@dataclass(frozen=True)
class ResolvedBinding:
    """Result of resolving a ruleset binding for a folder path."""

    ruleset_id: str | None
    recursive: bool
    source_path: str | None
    """The path the binding is actually stored at (may be an ancestor)."""


def load_folders() -> FoldersConfig:
    """Return the folder configuration."""
    return settings_service.load().folders


def save_folders(config: FoldersConfig) -> FoldersConfig:
    """Persist the folder configuration."""
    settings = settings_service.load()
    settings.folders = config
    settings_service.save(settings)
    return config


def resolve_ruleset_for_path(path: str) -> ResolvedBinding:
    """Resolve the effective binding for ``path``.

    Exact match wins. Otherwise walks ancestors looking for the nearest
    binding with ``recursive=True``. Returns an empty binding if none found.
    """
    bindings = settings_service.load().folder_rulesets
    if path in bindings:
        b = bindings[path]
        return ResolvedBinding(b.ruleset_id, b.recursive, path)
    # Walk up ancestors
    parts = path.rstrip("/").split("/")
    for i in range(len(parts) - 1, 0, -1):
        ancestor = "/".join(parts[:i]) or "/"
        ancestor_binding = bindings.get(ancestor)
        if ancestor_binding is not None and ancestor_binding.recursive:
            return ResolvedBinding(ancestor_binding.ruleset_id, ancestor_binding.recursive, ancestor)
    return ResolvedBinding(None, False, None)


def set_ruleset_for_path(path: str, ruleset_id: str | None, recursive: bool = False) -> None:
    """Bind a ruleset to an absolute folder path."""

    def _mutate(s):
        s.folder_rulesets[path] = FolderRulesetBinding(
            ruleset_id=ruleset_id,
            recursive=recursive,
        )

    settings_service.update(_mutate)


def delete_ruleset_for_path(path: str) -> None:
    """Remove the ruleset binding for a folder path."""

    def _mutate(s):
        s.folder_rulesets.pop(path, None)

    settings_service.update(_mutate)


def get_all_folder_rulesets() -> dict[str, FolderRulesetBinding]:
    """Return the full path→binding mapping (direct bindings only)."""
    return dict(settings_service.load().folder_rulesets)
