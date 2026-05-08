"""REST endpoints for managing ProfileGroups."""

import logging

from fastapi import APIRouter, HTTPException, status

from backend.core.services import profile_group as profile_group_service
from backend.schemas.profile_group import (
    ProfileGroup,
    ProfileGroupCreate,
    ProfileGroupsResponse,
    ProfileGroupUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/profile-groups", tags=["profile-groups"])


@router.get("", response_model=ProfileGroupsResponse)
def list_groups() -> ProfileGroupsResponse:
    """Return all groups and the active group id."""
    config = profile_group_service.load_groups()
    return ProfileGroupsResponse(
        groups=config.items,
        active_group_id=config.active_group_id,
    )


@router.get("/active", response_model=ProfileGroup | None)
def get_active_group() -> ProfileGroup | None:
    """Return the currently active group, or null if none is active."""
    return profile_group_service.get_active_group()


@router.post("", response_model=ProfileGroup, status_code=status.HTTP_201_CREATED)
def create_group(body: ProfileGroupCreate) -> ProfileGroup:
    """Create a new ProfileGroup."""
    new_group, _ = profile_group_service.create_group(
        name=body.name,
        members=body.members,
    )
    return new_group


@router.put("/{group_id}", response_model=ProfileGroup)
def update_group(group_id: str, body: ProfileGroupUpdate) -> ProfileGroup:
    """Update a group's name and/or members.

    Raises
    ------
    HTTPException
        404 if not found.
    """
    try:
        return profile_group_service.update_group(
            group_id,
            name=body.name,
            members=body.members,
        )
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_group(group_id: str) -> None:
    """Delete a group.

    Raises
    ------
    HTTPException
        404 if not found.
    """
    try:
        profile_group_service.delete_group(group_id)
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e


@router.put("/{group_id}/activate", response_model=ProfileGroup)
def activate_group(group_id: str) -> ProfileGroup:
    """Set the active group.

    Raises
    ------
    HTTPException
        404 if not found.
    """
    try:
        profile_group_service.set_active(group_id)
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e
    active = profile_group_service.get_active_group()
    if active is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="ProfileGroup activation succeeded but lookup failed",
        )
    return active
