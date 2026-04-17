"""Schemas for folder display and per-folder ruleset configuration."""

from __future__ import annotations

from pydantic import BaseModel, Field


class FolderConfig(BaseModel):
    """Configuration for a single music folder shortcut."""

    name: str
    """Subdirectory name (e.g. ``"prepare"``). Also used as the URL mode param."""
    label: str
    """Display label shown in the UI shortcut bar."""
    visible: bool = True
    """Whether the folder shortcut is shown in the meta editor."""
    order: int = 0
    """Display order (ascending, lowest first)."""


class FoldersConfig(BaseModel):
    """Top-level container for all folder configs."""

    folders: list[FolderConfig] = Field(default_factory=list)
