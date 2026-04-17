"""REST endpoints for managing finalization rulesets."""

import logging

from fastapi import APIRouter, HTTPException, status

from backend.core.services import ruleset as ruleset_service
from backend.schemas.ruleset import (
    Ruleset,
    RulesetCreate,
    RulesetsResponse,
    RulesetUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/rulesets", tags=["rulesets"])


@router.get("", response_model=RulesetsResponse)
def list_rulesets() -> RulesetsResponse:
    """Return all rulesets and the active ruleset id."""
    config = ruleset_service.load_rulesets()
    return RulesetsResponse(
        rulesets=config.items,
        active_ruleset_id=config.active_ruleset_id,
    )


@router.get("/active", response_model=Ruleset)
def get_active_ruleset() -> Ruleset:
    """Return the currently active ruleset."""
    return ruleset_service.get_active_ruleset()


@router.post("", response_model=Ruleset, status_code=status.HTTP_201_CREATED)
def create_ruleset(body: RulesetCreate) -> Ruleset:
    """Create a new user ruleset."""
    new_ruleset, _ = ruleset_service.create_ruleset(
        name=body.name,
        rules=body.rules,
        required_attributes=body.required_attributes,
    )
    return new_ruleset


@router.put("/{ruleset_id}", response_model=Ruleset)
def update_ruleset(ruleset_id: str, body: RulesetUpdate) -> Ruleset:
    """Update a ruleset's name and/or rules.

    Raises
    ------
    HTTPException
        404 if not found, 403 if built-in.
    """
    try:
        return ruleset_service.update_ruleset(
            ruleset_id,
            name=body.name,
            rules=body.rules,
            required_attributes=body.required_attributes,
        )
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e)) from e


@router.delete("/{ruleset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ruleset(ruleset_id: str) -> None:
    """Delete a user ruleset.

    Raises
    ------
    HTTPException
        404 if not found, 403 if built-in.
    """
    try:
        ruleset_service.delete_ruleset(ruleset_id)
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e)) from e


@router.put("/{ruleset_id}/activate", response_model=Ruleset)
def activate_ruleset(ruleset_id: str) -> Ruleset:
    """Set the active ruleset.

    Raises
    ------
    HTTPException
        404 if not found.
    """
    try:
        ruleset_service.set_active(ruleset_id)
    except KeyError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e
    return ruleset_service.get_active_ruleset()
