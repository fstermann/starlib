"""ProfileGroup CRUD facade over the consolidated settings file.

Persists into ``settings.json`` via [settings.py](settings.py). No built-in
groups; deleting the active group clears ``active_group_id``.
"""

import uuid
from datetime import UTC, datetime

from backend.core.services import settings as settings_service
from backend.schemas.profile_group import (
    ProfileGroup,
    ProfileGroupMember,
    ProfileGroupsConfig,
)

__all__ = [
    "create_group",
    "delete_group",
    "get_active_group",
    "get_group_by_id",
    "load_groups",
    "set_active",
    "update_group",
]


def _utcnow() -> datetime:
    return datetime.now(UTC)


def load_groups() -> ProfileGroupsConfig:
    """Return the profile_groups section of the settings file."""
    return settings_service.load().profile_groups


def get_active_group() -> ProfileGroup | None:
    """Return the currently active group, or None if none is active or matched."""
    config = load_groups()
    if not config.active_group_id:
        return None
    for group in config.items:
        if group.id == config.active_group_id:
            return group
    return None


def get_group_by_id(group_id: str) -> ProfileGroup | None:
    """Return a specific group by id, or None if not found."""
    for group in load_groups().items:
        if group.id == group_id:
            return group
    return None


def create_group(
    name: str,
    members: list[ProfileGroupMember] | None = None,
) -> tuple[ProfileGroup, ProfileGroupsConfig]:
    """Create a new group and return it together with the updated config."""
    now = _utcnow()
    new_group = ProfileGroup(
        id=str(uuid.uuid4()),
        name=name,
        members=members or [],
        created_at=now,
        updated_at=now,
    )

    def _add(s):
        s.profile_groups.items.append(new_group)

    updated = settings_service.update(_add)
    return new_group, updated.profile_groups


def update_group(
    group_id: str,
    name: str | None,
    members: list[ProfileGroupMember] | None,
) -> ProfileGroup:
    """Update a group's name and/or members.

    Raises
    ------
    KeyError
        If no group with that id exists.
    """
    settings = settings_service.load()
    items = settings.profile_groups.items
    for i, g in enumerate(items):
        if g.id == group_id:
            updates: dict = {"updated_at": _utcnow()}
            if name is not None:
                updates["name"] = name
            if members is not None:
                updates["members"] = members
            updated = g.model_copy(update=updates)
            items[i] = updated
            settings_service.save(settings)
            return updated
    raise KeyError(f"ProfileGroup {group_id!r} not found")


def delete_group(group_id: str) -> None:
    """Delete a group. Clears active_group_id if it was the deleted one.

    Raises
    ------
    KeyError
        If no group with that id exists.
    """
    settings = settings_service.load()
    if not any(g.id == group_id for g in settings.profile_groups.items):
        raise KeyError(f"ProfileGroup {group_id!r} not found")
    settings.profile_groups.items = [
        g for g in settings.profile_groups.items if g.id != group_id
    ]
    if settings.profile_groups.active_group_id == group_id:
        settings.profile_groups.active_group_id = ""
    settings_service.save(settings)


def set_active(group_id: str) -> None:
    """Set the active group by id.

    Raises
    ------
    KeyError
        If no group with that id exists.
    """
    settings = settings_service.load()
    if not any(g.id == group_id for g in settings.profile_groups.items):
        raise KeyError(f"ProfileGroup {group_id!r} not found")
    settings.profile_groups.active_group_id = group_id
    settings_service.save(settings)
