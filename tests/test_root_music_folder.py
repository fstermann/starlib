"""Tests for root music folder — migration, service, and API endpoint."""

from pathlib import Path
from unittest.mock import patch

from backend.core.services import app_settings as app_settings_svc
from backend.core.services import settings as settings_svc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _patch_paths(tmp_path: Path):
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    return patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
        _LEGACY_CONFIG_FILE=config_dir / "config.env",
    )


# ---------------------------------------------------------------------------
# Migration: config.env → settings.json
# ---------------------------------------------------------------------------


def test_migration_reads_root_from_config_env(tmp_path: Path) -> None:
    """On first load, ROOT_MUSIC_FOLDER in config.env is migrated to settings.json."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    config_env = config_dir / "config.env"
    config_env.write_text("CLIENT_ID=abc\nROOT_MUSIC_FOLDER=/migrated/music\nCLIENT_SECRET=xyz\n")

    # Write a settings.json without root_music_folder (simulates existing install)
    settings_file.write_text(
        '{"app":{"preferred_output_format":"aiff","root_music_folder":""},'
        '"rulesets":{"items":[],"active_ruleset_id":"classic"},'
        '"folders":{"folders":[]}}'
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
        _LEGACY_CONFIG_FILE=config_env,
    ):
        loaded = settings_svc.load()

    assert loaded.app.root_music_folder == "/migrated/music"


def test_migration_removes_key_from_config_env(tmp_path: Path) -> None:
    """After migration, ROOT_MUSIC_FOLDER is removed from config.env."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    config_env = config_dir / "config.env"
    config_env.write_text("CLIENT_ID=abc\nROOT_MUSIC_FOLDER=/migrated/music\nCLIENT_SECRET=xyz\n")

    settings_file.write_text(
        '{"app":{"preferred_output_format":"aiff","root_music_folder":""},'
        '"rulesets":{"items":[],"active_ruleset_id":"classic"},'
        '"folders":{"folders":[]}}'
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
        _LEGACY_CONFIG_FILE=config_env,
    ):
        settings_svc.load()

    remaining = config_env.read_text()
    assert "ROOT_MUSIC_FOLDER" not in remaining
    assert "CLIENT_ID=abc" in remaining
    assert "CLIENT_SECRET=xyz" in remaining


def test_migration_skipped_when_root_already_set(tmp_path: Path) -> None:
    """No migration runs when root_music_folder is already set in settings.json."""
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    config_env = config_dir / "config.env"
    config_env.write_text("ROOT_MUSIC_FOLDER=/old/path\n")

    settings_file.write_text(
        '{"app":{"preferred_output_format":"aiff","root_music_folder":"/already/set"},'
        '"rulesets":{"items":[],"active_ruleset_id":"classic"},'
        '"folders":{"folders":[]}}'
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
        _LEGACY_CONFIG_FILE=config_env,
    ):
        loaded = settings_svc.load()

    # Original value preserved; config.env untouched
    assert loaded.app.root_music_folder == "/already/set"
    assert "ROOT_MUSIC_FOLDER=/old/path" in config_env.read_text()


def test_migration_falls_back_to_home_music_when_config_env_missing(tmp_path: Path) -> None:
    config_dir = tmp_path / "starlib"
    config_dir.mkdir()
    settings_file = config_dir / "settings.json"
    config_env = config_dir / "config.env"  # does not exist

    settings_file.write_text(
        '{"app":{"preferred_output_format":"aiff","root_music_folder":""},'
        '"rulesets":{"items":[],"active_ruleset_id":"classic"},'
        '"folders":{"folders":[]}}'
    )

    with patch.multiple(
        "backend.core.services.settings",
        _CONFIG_DIR=config_dir,
        _SETTINGS_FILE=settings_file,
        _LEGACY_CONFIG_FILE=config_env,
    ):
        loaded = settings_svc.load()

    assert loaded.app.root_music_folder  # non-empty (home/Music default)
    assert "Music" in loaded.app.root_music_folder


# ---------------------------------------------------------------------------
# Service: get / set
# ---------------------------------------------------------------------------


def test_get_root_music_folder(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        # First load creates defaults (which set root_music_folder)
        settings_svc.load()
        root = app_settings_svc.get_root_music_folder()
    assert root  # non-empty
    assert "Music" in root


def test_set_root_music_folder_persists(tmp_path: Path) -> None:
    with _patch_paths(tmp_path):
        app_settings_svc.set_root_music_folder("/custom/music")
        reloaded = settings_svc.load()
    assert reloaded.app.root_music_folder == "/custom/music"


# ---------------------------------------------------------------------------
# API endpoint
# ---------------------------------------------------------------------------


def test_api_get_root_folder(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    with _patch_paths(tmp_path):
        settings_svc.load()  # init defaults
        with patch("backend.core.services.app_settings.get_root_music_folder", return_value="/test/music"):
            client = TestClient(app)
            resp = client.get("/api/settings/root-folder")

    assert resp.status_code == 200
    assert resp.json()["root_music_folder"] == "/test/music"


def test_api_put_root_folder_valid(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    with _patch_paths(tmp_path):
        settings_svc.load()
        with (
            patch("backend.core.services.app_settings.set_root_music_folder") as mock_set,
            patch("backend.core.services.watcher.restart_watcher") as mock_restart,
        ):
            client = TestClient(app)
            resp = client.put("/api/settings/root-folder", json={"root_music_folder": str(tmp_path)})

    assert resp.status_code == 200
    assert resp.json()["root_music_folder"] == str(tmp_path)
    mock_set.assert_called_once_with(str(tmp_path))
    mock_restart.assert_called_once_with(tmp_path)


def test_api_put_root_folder_nonexistent(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    with _patch_paths(tmp_path):
        settings_svc.load()
        client = TestClient(app)
        resp = client.put("/api/settings/root-folder", json={"root_music_folder": "/does/not/exist"})

    assert resp.status_code == 422


def test_api_put_root_folder_empty(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    with _patch_paths(tmp_path):
        settings_svc.load()
        client = TestClient(app)
        resp = client.put("/api/settings/root-folder", json={"root_music_folder": ""})

    assert resp.status_code == 422


def test_api_put_root_folder_file_not_dir(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from backend.main import app

    f = tmp_path / "notadir.txt"
    f.write_text("x")

    with _patch_paths(tmp_path):
        settings_svc.load()
        client = TestClient(app)
        resp = client.put("/api/settings/root-folder", json={"root_music_folder": str(f)})

    assert resp.status_code == 422
