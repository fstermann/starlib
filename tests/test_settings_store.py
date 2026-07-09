"""Tests for the consolidated settings store: atomic writes + single source.

Regression coverage for the "Path Settings keep resetting" bug, whose root
cause was the frontend UI store and this backend store sharing one file. These
tests lock in the backend-side guarantees of the fix: writes are atomic (no
truncated file / leftover temp), a configured path survives a save/load cycle,
and the preferred output format has exactly one home (the one the rule engine
reads).
"""

import json
from pathlib import Path
from unittest.mock import patch

from backend.core.services import app_settings as app_settings_service
from backend.core.services import settings as settings_service


def _patched(tmp_path: Path):
    return (
        patch.object(settings_service, "_SETTINGS_FILE", tmp_path / "settings.json"),
        patch.object(settings_service, "_CONFIG_DIR", tmp_path),
    )


def test_save_is_atomic_and_leaves_no_temp_file(tmp_path: Path) -> None:
    file_patch, dir_patch = _patched(tmp_path)
    with file_patch, dir_patch:
        settings = settings_service._defaults()
        settings.app.root_music_folder = "/music/library"
        settings_service.save(settings)

        settings_file = tmp_path / "settings.json"
        # A valid, fully-written JSON file — never a truncated fragment.
        assert json.loads(settings_file.read_text())["app"]["root_music_folder"] == "/music/library"
        # The temp file used for the atomic replace is gone.
        assert list(tmp_path.glob("*.tmp")) == []


def test_configured_root_survives_save_load_cycle(tmp_path: Path) -> None:
    file_patch, dir_patch = _patched(tmp_path)
    with file_patch, dir_patch:
        settings = settings_service._defaults()
        settings.app.root_music_folder = "/music/library"
        settings_service.save(settings)

        # Reload from disk — the path must not be reset back to ~/Music.
        reloaded = settings_service.load()
        assert reloaded.app.root_music_folder == "/music/library"


def test_output_format_has_single_source_of_truth(tmp_path: Path) -> None:
    file_patch, dir_patch = _patched(tmp_path)
    with file_patch, dir_patch:
        settings_service.save(settings_service._defaults())

        # Writing via the app-settings facade (what the PUT /api/settings route
        # uses) is exactly what the rule engine reads back.
        app_settings_service.save({"preferred_output_format": "mp3"})
        assert app_settings_service.get_preferred_output_format() == "mp3"
