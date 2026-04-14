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
    assert next(f for f in loaded.folders if f.name == "prepare").ruleset_id == "classic"


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
