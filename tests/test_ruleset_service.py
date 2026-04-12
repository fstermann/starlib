"""Tests for the ruleset service (CRUD + persistence via consolidated settings)."""

from pathlib import Path
from unittest.mock import patch

import pytest

from backend.core.services import ruleset as svc
from backend.schemas.ruleset import Rule

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _patch_paths(tmp_path: Path):
    """Redirect the consolidated settings file to a temp directory."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    return patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
    )


# ---------------------------------------------------------------------------
# load_rulesets
# ---------------------------------------------------------------------------


def test_load_rulesets_creates_defaults_on_first_run(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        config = svc.load_rulesets()

    assert any(r.id == svc.CLASSIC_RULESET_ID for r in config.items)
    assert config.active_ruleset_id == svc.CLASSIC_RULESET_ID


def test_load_rulesets_always_includes_classic(tmp_path: Path) -> None:
    """Classic ruleset is re-injected even if the settings file lacks it."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"

    settings_file.write_text(
        '{"app":{"preferred_output_format":"aiff"},'
        '"rulesets":{"items":[{"id":"other","name":"Other","is_builtin":false,"rules":[]}],'
        '"active_ruleset_id":"other"},'
        '"folders":{"folders":[]}}'
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
    ):
        loaded = svc.load_rulesets()

    assert any(r.id == svc.CLASSIC_RULESET_ID for r in loaded.items)


# ---------------------------------------------------------------------------
# create_ruleset
# ---------------------------------------------------------------------------


def test_create_ruleset_adds_to_config(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        new_ruleset, config = svc.create_ruleset(
            name="My Workflow",
            rules=[Rule(id="r1", type="move", input="source", params={"folder": "cleaned"})],
        )

    assert new_ruleset.name == "My Workflow"
    assert new_ruleset.is_builtin is False
    assert new_ruleset.id  # non-empty UUID
    assert any(r.id == new_ruleset.id for r in config.items)


def test_create_ruleset_persists(tmp_path: Path) -> None:
    """A second load reflects the created ruleset."""
    with _patch_paths(tmp_path):
        new_ruleset, _ = svc.create_ruleset(name="Saved", rules=[])
        reloaded = svc.load_rulesets()

    assert any(r.id == new_ruleset.id for r in reloaded.items)


# ---------------------------------------------------------------------------
# update_ruleset
# ---------------------------------------------------------------------------


def test_update_ruleset_name_and_rules(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_ruleset("Original", rules=[])
        updated = svc.update_ruleset(
            created.id,
            name="Renamed",
            rules=[Rule(id="r1", type="move", input="source", params={"folder": "out"})],
        )

    assert updated.name == "Renamed"
    assert updated.rules[0].type == "move"


def test_update_ruleset_raises_for_builtin(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(ValueError, match="built-in"):
        svc.update_ruleset(svc.CLASSIC_RULESET_ID, name="Hack", rules=None)


def test_update_ruleset_raises_for_missing_id(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(KeyError):
        svc.update_ruleset("does-not-exist", name="X", rules=None)


# ---------------------------------------------------------------------------
# delete_ruleset
# ---------------------------------------------------------------------------


def test_delete_ruleset_removes_it(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_ruleset("Temp", rules=[])
        svc.delete_ruleset(created.id)
        config = svc.load_rulesets()

    assert not any(r.id == created.id for r in config.items)


def test_delete_ruleset_raises_for_builtin(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(ValueError, match="built-in"):
        svc.delete_ruleset(svc.CLASSIC_RULESET_ID)


def test_delete_ruleset_raises_for_missing_id(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(KeyError):
        svc.delete_ruleset("ghost-id")


def test_delete_active_ruleset_resets_to_classic(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_ruleset("Active one", rules=[])
        svc.set_active(created.id)
        svc.delete_ruleset(created.id)
        config = svc.load_rulesets()

    assert config.active_ruleset_id == svc.CLASSIC_RULESET_ID


# ---------------------------------------------------------------------------
# set_active / get_active_ruleset
# ---------------------------------------------------------------------------


def test_set_active_updates_config(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_ruleset("Mine", rules=[])
        svc.set_active(created.id)
        active = svc.get_active_ruleset()

    assert active.id == created.id


def test_set_active_raises_for_missing_id(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(KeyError):
        svc.set_active("no-such-id")


# ---------------------------------------------------------------------------
# get_ruleset_by_id
# ---------------------------------------------------------------------------


def test_get_ruleset_by_id_returns_ruleset(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_ruleset("Lookup", rules=[])
        found = svc.get_ruleset_by_id(created.id)

    assert found.id == created.id


def test_get_ruleset_by_id_falls_back_to_classic(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        result = svc.get_ruleset_by_id("unknown-id")

    assert result.id == svc.CLASSIC_RULESET_ID


# ---------------------------------------------------------------------------
# Classic ruleset shape
# ---------------------------------------------------------------------------


def test_classic_uses_explicit_input_references(tmp_path: Path) -> None:
    """Classic: convert → move result to cleaned, archive original if converted."""
    with _patch_paths(tmp_path):
        classic = svc.get_ruleset_by_id(svc.CLASSIC_RULESET_ID)

    rules_by_id = {r.id: r for r in classic.rules}
    assert rules_by_id["convert"].input == "source"
    # Move uses convert.result — always resolves (converted or original)
    assert rules_by_id["move"].input == "convert.result"
    # Archive uses convert.original, gated on convert.converted existing
    assert rules_by_id["archive"].input == "convert.original"
    assert rules_by_id["archive"].requires == ["convert.converted"]
    # No legacy field
    assert "condition" not in Rule.model_fields
