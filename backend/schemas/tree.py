"""Schemas for the folder tree API."""

from __future__ import annotations

from pydantic import BaseModel


class TreeNode(BaseModel):
    """A node in the folder tree."""

    id: str
    """Absolute folder path — unique within the tree."""
    name: str
    """Directory basename shown in the UI."""
    children: list[TreeNode] = []
    track_count: int = 0
    """Recursive count of tracks in this folder and all descendants."""
