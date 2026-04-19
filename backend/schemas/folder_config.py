"""Schemas for folder display and per-folder ruleset configuration."""

from __future__ import annotations

from pydantic import BaseModel, Field


class FolderConfig(BaseModel):
    """Configuration for a single music folder shortcut."""

    name: str
    """Stable identifier. For legacy/root-child shortcuts this is the subdirectory
    basename (e.g. ``"prepare"``); for shortcuts pointing to arbitrary paths it is
    also the basename, but disambiguated if collisions occur."""
    label: str
    """Display label shown in the UI shortcut bar."""
    visible: bool = True
    """Whether the folder shortcut is shown in the library tree panel."""
    order: int = 0
    """Display order (ascending, lowest first)."""
    path: str | None = None
    """Absolute path of the pinned folder. When ``None``, the folder is assumed
    to be a direct child of the root music folder (``<root>/<name>``) — this is
    the legacy/default shape for the built-in Prepare/Cleaned/Collection entries."""


class FoldersConfig(BaseModel):
    """Top-level container for all folder configs."""

    folders: list[FolderConfig] = Field(default_factory=list)
