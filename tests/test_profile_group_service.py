"""Tests for the ProfileGroup service (CRUD + persistence via consolidated settings)."""

from pathlib import Path
from unittest.mock import patch

import pytest

from backend.core.services import profile_group as svc
from backend.schemas.profile_group import ProfileGroupMember


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


def _member(urn: str = "soundcloud:users:1", username: str = "alice") -> ProfileGroupMember:
    return ProfileGroupMember(
        user_urn=urn,
        permalink=username,
        username=username,
        avatar_url=None,
    )


# ---------------------------------------------------------------------------
# load_groups
# ---------------------------------------------------------------------------


def test_load_groups_empty_on_first_run(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        config = svc.load_groups()

    assert config.items == []
    assert config.active_group_id == ""


# ---------------------------------------------------------------------------
# create_group
# ---------------------------------------------------------------------------


def test_create_group_adds_to_config(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        new_group, config = svc.create_group(
            name="DJs I follow", members=[_member()]
        )

    assert new_group.name == "DJs I follow"
    assert new_group.id  # non-empty UUID
    assert len(new_group.members) == 1
    assert any(g.id == new_group.id for g in config.items)


def test_create_group_persists(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        new_group, _ = svc.create_group(name="Saved", members=[])
        reloaded = svc.load_groups()

    assert any(g.id == new_group.id for g in reloaded.items)


# ---------------------------------------------------------------------------
# update_group
# ---------------------------------------------------------------------------


def test_update_group_name_and_members(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_group(name="Original", members=[])
        updated = svc.update_group(
            created.id,
            name="Renamed",
            members=[_member("soundcloud:users:2", "bob")],
        )

    assert updated.name == "Renamed"
    assert len(updated.members) == 1
    assert updated.members[0].username == "bob"
    assert updated.updated_at > created.created_at


def test_update_group_raises_for_missing_id(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(KeyError):
        svc.update_group("does-not-exist", name="X", members=None)


def test_update_group_partial_keeps_other_fields(tmp_path: Path) -> None:
    """Passing name=None preserves the existing name; members=None preserves members."""
    with _patch_paths(tmp_path):
        created, _ = svc.create_group(name="Keep", members=[_member()])
        updated = svc.update_group(created.id, name="Renamed", members=None)

    assert updated.name == "Renamed"
    assert len(updated.members) == 1


# ---------------------------------------------------------------------------
# delete_group
# ---------------------------------------------------------------------------


def test_delete_group_removes_it(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_group(name="Temp", members=[])
        svc.delete_group(created.id)
        config = svc.load_groups()

    assert not any(g.id == created.id for g in config.items)


def test_delete_group_raises_for_missing_id(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(KeyError):
        svc.delete_group("ghost-id")


def test_delete_active_group_clears_active(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_group(name="Active one", members=[])
        svc.set_active(created.id)
        svc.delete_group(created.id)
        config = svc.load_groups()

    assert config.active_group_id == ""


# ---------------------------------------------------------------------------
# set_active / get_active_group
# ---------------------------------------------------------------------------


def test_set_active_updates_config(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_group(name="Mine", members=[])
        svc.set_active(created.id)
        active = svc.get_active_group()

    assert active is not None
    assert active.id == created.id


def test_set_active_raises_for_missing_id(tmp_path: Path) -> None:
    with _patch_paths(tmp_path), pytest.raises(KeyError):
        svc.set_active("no-such-id")


def test_get_active_group_returns_none_when_unset(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        active = svc.get_active_group()

    assert active is None


# ---------------------------------------------------------------------------
# get_group_by_id
# ---------------------------------------------------------------------------


def test_get_group_by_id_returns_group(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        created, _ = svc.create_group(name="Lookup", members=[])
        found = svc.get_group_by_id(created.id)

    assert found is not None
    assert found.id == created.id


def test_get_group_by_id_returns_none_for_missing(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        result = svc.get_group_by_id("unknown-id")

    assert result is None
