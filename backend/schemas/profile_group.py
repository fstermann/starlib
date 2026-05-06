"""Pydantic schemas for ProfileGroups.

A ProfileGroup is a user-defined, named, ordered set of SoundCloud profiles
whose likes feeds are merged into one stream in the Discover tab. Today the
Discover tab pins one profile at a time; ProfileGroups generalize that to N
profiles (N=1 is supported and produces the same UX as today).
"""

import uuid
from datetime import UTC, datetime

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(UTC)


class ProfileGroupMember(BaseModel):
    """A SoundCloud profile pinned into a group.

    Cached display fields (`username`, `avatar_url`) snapshot the profile at
    add-time so the UI can render members without a per-row SoundCloud API
    call. They drift over time — we accept that for v1.
    """

    user_urn: str
    permalink: str
    username: str
    avatar_url: str | None = None


class ProfileGroup(BaseModel):
    """A persisted ProfileGroup."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    members: list[ProfileGroupMember] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class ProfileGroupsConfig(BaseModel):
    """Container for the profile_groups section of the consolidated settings file."""

    items: list[ProfileGroup] = Field(default_factory=list)
    active_group_id: str = ""


class ProfileGroupCreate(BaseModel):
    """Payload for creating a new group."""

    name: str
    members: list[ProfileGroupMember] = Field(default_factory=list)


class ProfileGroupUpdate(BaseModel):
    """Payload for updating an existing group."""

    name: str | None = None
    members: list[ProfileGroupMember] | None = None


class ProfileGroupsResponse(BaseModel):
    """Response listing all groups plus the active one."""

    groups: list[ProfileGroup]
    active_group_id: str
