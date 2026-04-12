"""Pydantic schemas for the custom ruleset system.

Each rule has an explicit ``input`` reference identifying which file it operates
on. The token ``"source"`` refers to the original input file; otherwise it is
``"<rule_id>.<output_name>"``, pointing at a named output produced by an earlier
rule in the same ruleset. Rule output namespaces:

- ``move`` → ``moved``
- ``copy`` → ``original``, ``copy``
- ``convert`` → ``original`` (always), ``converted`` (only on successful conversion)

A rule whose ``input`` resolves to a missing output (e.g. ``convert.converted``
when conversion didn't happen) is skipped at runtime. This makes the old
``if_converted`` global flag unnecessary — dependencies are local and explicit.
"""

import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

RuleType = Literal["move", "convert", "copy"]


class Rule(BaseModel):
    """A single step in a finalization pipeline."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    """Stable id within the ruleset. Used by other rules to reference outputs."""
    type: RuleType
    input: str = "source"
    """The file to operate on. Either ``"source"`` or ``"<rule_id>.<output_name>"``."""
    requires: list[str] = Field(default_factory=list)
    """Additional output refs that must exist for the rule to fire. Lets a rule be
    gated on a sibling rule's success without consuming that file as its input
    (e.g. ``copy.input = "convert.original"`` with ``requires = ["convert.converted"]``
    means "copy the original file, but only when conversion produced something")."""
    params: dict[str, Any] = Field(default_factory=dict)


class Ruleset(BaseModel):
    """A named, ordered collection of rules."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    is_builtin: bool = False
    rules: list[Rule] = Field(default_factory=list)


class RulesetsConfig(BaseModel):
    """Container for the rulesets section of the consolidated settings file."""

    items: list[Ruleset] = Field(default_factory=list)
    active_ruleset_id: str = ""


class RulesetCreate(BaseModel):
    """Payload for creating a new ruleset."""

    name: str
    rules: list[Rule] = Field(default_factory=list)


class RulesetUpdate(BaseModel):
    """Payload for updating an existing ruleset."""

    name: str | None = None
    rules: list[Rule] | None = None


class RulesetsResponse(BaseModel):
    """Response listing all rulesets."""

    rulesets: list[Ruleset]
    active_ruleset_id: str
