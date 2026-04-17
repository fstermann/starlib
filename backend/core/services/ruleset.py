"""Ruleset CRUD facade over the consolidated settings file.

Persists into ``settings.json`` via [settings.py](settings.py). The built-in
"Classic" ruleset is owned by [settings.py](settings.py) and cannot be deleted.
"""

import uuid

from backend.core.services import settings as settings_service
from backend.core.services.settings import _CLASSIC_RULESET, CLASSIC_RULESET_ID
from backend.schemas.ruleset import RequiredAttribute, Rule, Ruleset, RulesetsConfig

__all__ = [
    "CLASSIC_RULESET_ID",
    "create_ruleset",
    "delete_ruleset",
    "get_active_ruleset",
    "get_ruleset_by_id",
    "load_rulesets",
    "set_active",
    "update_ruleset",
]


def load_rulesets() -> RulesetsConfig:
    """Return the rulesets section of the settings file."""
    return settings_service.load().rulesets


def get_active_ruleset() -> Ruleset:
    """Return the currently active ruleset, falling back to Classic."""
    config = load_rulesets()
    for ruleset in config.items:
        if ruleset.id == config.active_ruleset_id:
            return ruleset
    return _CLASSIC_RULESET


def get_ruleset_by_id(ruleset_id: str) -> Ruleset:
    """Return a specific ruleset by id, falling back to Classic if not found."""
    for ruleset in load_rulesets().items:
        if ruleset.id == ruleset_id:
            return ruleset
    return _CLASSIC_RULESET


def create_ruleset(
    name: str,
    rules: list[Rule],
    required_attributes: list[RequiredAttribute] | None = None,
) -> tuple[Ruleset, RulesetsConfig]:
    """Create a new user ruleset and return it together with the updated config."""
    new_ruleset = Ruleset(
        id=str(uuid.uuid4()),
        name=name,
        is_builtin=False,
        rules=rules,
        required_attributes=required_attributes or [],
    )

    def _add(s):
        s.rulesets.items.append(new_ruleset)

    updated = settings_service.update(_add)
    return new_ruleset, updated.rulesets


def update_ruleset(
    ruleset_id: str,
    name: str | None,
    rules: list[Rule] | None,
    required_attributes: list[RequiredAttribute] | None = None,
) -> Ruleset:
    """Update a user ruleset's name and/or rules.

    Raises
    ------
    ValueError
        If the ruleset is built-in.
    KeyError
        If no ruleset with that id exists.
    """
    settings = settings_service.load()
    items = settings.rulesets.items
    for i, r in enumerate(items):
        if r.id == ruleset_id:
            if r.is_builtin:
                raise ValueError("Cannot modify built-in rulesets")
            updates: dict = {}
            if name is not None:
                updates["name"] = name
            if rules is not None:
                updates["rules"] = rules
            if required_attributes is not None:
                updates["required_attributes"] = required_attributes
            updated = r.model_copy(update=updates)
            items[i] = updated
            settings_service.save(settings)
            return updated
    raise KeyError(f"Ruleset {ruleset_id!r} not found")


def delete_ruleset(ruleset_id: str) -> None:
    """Delete a user ruleset.

    Raises
    ------
    ValueError
        If the ruleset is built-in.
    KeyError
        If no ruleset with that id exists.
    """
    settings = settings_service.load()
    target = next((r for r in settings.rulesets.items if r.id == ruleset_id), None)
    if target is None:
        raise KeyError(f"Ruleset {ruleset_id!r} not found")
    if target.is_builtin:
        raise ValueError("Cannot delete built-in rulesets")

    settings.rulesets.items = [r for r in settings.rulesets.items if r.id != ruleset_id]
    if settings.rulesets.active_ruleset_id == ruleset_id:
        settings.rulesets.active_ruleset_id = CLASSIC_RULESET_ID
    settings_service.save(settings)


def set_active(ruleset_id: str) -> None:
    """Set the active ruleset by id.

    Raises
    ------
    KeyError
        If no ruleset with that id exists.
    """
    settings = settings_service.load()
    if not any(r.id == ruleset_id for r in settings.rulesets.items):
        raise KeyError(f"Ruleset {ruleset_id!r} not found")
    settings.rulesets.active_ruleset_id = ruleset_id
    settings_service.save(settings)
