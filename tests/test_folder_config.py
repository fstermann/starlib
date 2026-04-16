"""Tests for the folder-config heal path in settings.load()."""

from pathlib import Path
from unittest.mock import patch

from backend.core.services import folder_config


def _patch_paths(tmp_path: Path):
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    return patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=config_dir / "settings.json",
    )


def test_first_run_seeds_default_folders(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        loaded = folder_config.load_folders()

    names = [f.name for f in loaded.folders]
    assert names == ["prepare", "cleaned", "collection"]


def test_empty_folders_are_reseeded_on_load(tmp_path: Path) -> None:
    """A half-initialised settings.json with folders:[] gets the defaults back."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    settings_file.write_text(
        '{"app":{"root_music_folder":"/tmp/music"},'
        '"rulesets":{"items":[],"active_ruleset_id":"classic"},'
        '"folders":{"folders":[]}}'
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
    ):
        loaded = folder_config.load_folders()

    assert [f.name for f in loaded.folders] == ["prepare", "cleaned", "collection"]

    # The heal is in-memory only — disk state is untouched so a user who
    # genuinely wants zero folders can still delete + save.
    on_disk = settings_file.read_text()
    assert '"folders":[]' in on_disk.replace(" ", "")


def test_recursive_binding_resolves_for_descendants(tmp_path: Path) -> None:
    """A recursive ancestor binding is inherited by descendants without their own binding."""
    with _patch_paths(tmp_path):
        folder_config.set_ruleset_for_path("/music/collection", "classic", recursive=True)

        # Direct child inherits
        resolved = folder_config.resolve_ruleset_for_path("/music/collection/house")
        assert resolved.ruleset_id == "classic"
        assert resolved.recursive is True
        assert resolved.source_path == "/music/collection"

        # Explicit child binding overrides — even with recursive=False on the child
        folder_config.set_ruleset_for_path("/music/collection/house", None, recursive=False)
        resolved = folder_config.resolve_ruleset_for_path("/music/collection/house")
        assert resolved.ruleset_id is None
        assert resolved.source_path == "/music/collection/house"

        # Non-recursive ancestor does NOT propagate
        folder_config.delete_ruleset_for_path("/music/collection/house")
        folder_config.set_ruleset_for_path("/music/collection", "classic", recursive=False)
        resolved = folder_config.resolve_ruleset_for_path("/music/collection/house")
        assert resolved.ruleset_id is None
        assert resolved.source_path is None


def test_legacy_string_bindings_load_as_non_recursive(tmp_path: Path) -> None:
    """Old-format settings.json with bare string values still loads."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    settings_file.write_text(
        '{"app":{"root_music_folder":"/tmp/music"},'
        '"rulesets":{"items":[],"active_ruleset_id":"classic"},'
        '"folders":{"folders":[]},'
        '"folder_rulesets":{"/music/prepare":"classic","/music/empty":null}}'
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
    ):
        bindings = folder_config.get_all_folder_rulesets()

    assert bindings["/music/prepare"].ruleset_id == "classic"
    assert bindings["/music/prepare"].recursive is False
    assert bindings["/music/empty"].ruleset_id is None
    assert bindings["/music/empty"].recursive is False


def test_non_empty_folders_are_preserved(tmp_path: Path) -> None:
    """User-configured folder list must not be overwritten by the heal."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    settings_file.write_text(
        '{"app":{"root_music_folder":"/tmp/music"},'
        '"rulesets":{"items":[],"active_ruleset_id":"classic"},'
        '"folders":{"folders":['
        '{"name":"inbox","label":"Inbox","visible":true,"order":0,"ruleset_id":null}'
        "]}}"
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
    ):
        loaded = folder_config.load_folders()

    assert [f.name for f in loaded.folders] == ["inbox"]
