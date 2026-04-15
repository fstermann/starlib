"""Single source of truth for the consolidated user settings file.

Owns ``~/.config/starlib/settings.json``. The legacy
``app_settings.json``, ``rulesets.json``, and ``folders.json`` files are
deleted on first load if present.

The three legacy service modules ([app_settings.py][1], [ruleset.py][2],
[folder_config.py][3]) are now thin facades that read/write through this
module. Centralising the file lets us load and persist all sections atomically.

[1]: backend/core/services/app_settings.py
[2]: backend/core/services/ruleset.py
[3]: backend/core/services/folder_config.py
"""

import json
import os
import stat
from collections.abc import Callable
from pathlib import Path

from backend.config import _APP_CONFIG_DIR
from backend.schemas.folder_config import FolderConfig, FoldersConfig
from backend.schemas.ruleset import Rule, Ruleset, RulesetsConfig
from backend.schemas.settings import AppSettings, Settings

_CONFIG_DIR = _APP_CONFIG_DIR
_SETTINGS_FILE = _CONFIG_DIR / "settings.json"

_LEGACY_FILES = ("app_settings.json", "rulesets.json", "folders.json")

CLASSIC_RULESET_ID = "classic"

_CLASSIC_RULESET = Ruleset(
    id=CLASSIC_RULESET_ID,
    name="Classic",
    is_builtin=True,
    rules=[
        Rule(id="convert", type="convert", input="source", params={"format": "preferred"}),
        Rule(
            id="archive",
            type="move",
            input="convert.original",
            requires=["convert.converted"],
            params={"folder": "archive"},
        ),
        Rule(id="move", type="move", input="convert.result", params={"folder": "cleaned"}),
    ],
)

_DEFAULT_FOLDERS = [
    FolderConfig(name="prepare", label="Prepare", visible=True, order=0, ruleset_id="classic"),
    FolderConfig(name="cleaned", label="Cleaned", visible=True, order=1),
    FolderConfig(name="collection", label="Collection", visible=True, order=2),
]


_LEGACY_CONFIG_FILE = _CONFIG_DIR / "config.env"


def _migrate_root_folder_from_config_env() -> str | None:
    """Read ROOT_MUSIC_FOLDER from config.env and remove it, returning the value."""
    if not _LEGACY_CONFIG_FILE.exists():
        return None
    lines = _LEGACY_CONFIG_FILE.read_text().splitlines()
    value: str | None = None
    remaining: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("ROOT_MUSIC_FOLDER="):
            _, _, value = stripped.partition("=")
            value = value.strip()
        else:
            remaining.append(line)
    if value is None:
        return None
    # Rewrite config.env without the migrated key
    try:
        _LEGACY_CONFIG_FILE.write_text("\n".join(remaining) + ("\n" if remaining else ""))
        os.chmod(_LEGACY_CONFIG_FILE, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    return value


def _defaults() -> Settings:
    root = str(Path.home() / "Music")
    return Settings(
        app=AppSettings(root_music_folder=root),
        rulesets=RulesetsConfig(items=[_CLASSIC_RULESET], active_ruleset_id=CLASSIC_RULESET_ID),
        folders=FoldersConfig(folders=list(_DEFAULT_FOLDERS)),
    )


def _cleanup_legacy_files() -> None:
    for name in _LEGACY_FILES:
        legacy = _CONFIG_DIR / name
        if legacy.exists():
            try:
                legacy.unlink()
            except OSError:
                pass


def _migrate_legacy_ollama_block(raw: dict) -> dict:
    """Move a top-level ``ollama`` block under ``ai.ollama``.

    First versions of the settings file stored Ollama config as a top-level
    key. The grouped ``ai.*`` layout now houses both Ollama and Anthropic.
    """
    if "ollama" not in raw:
        return raw
    legacy = raw.pop("ollama")
    ai_block = raw.setdefault("ai", {})
    ai_block.setdefault("ollama", legacy)
    return raw


def load() -> Settings:
    """Read settings from disk, creating defaults on first run."""
    if not _SETTINGS_FILE.exists():
        _cleanup_legacy_files()
        defaults = _defaults()
        save(defaults)
        return defaults

    raw = json.loads(_SETTINGS_FILE.read_text())
    needs_persist = "ollama" in raw
    raw = _migrate_legacy_ollama_block(raw)
    settings = Settings.model_validate(raw)
    if needs_persist:
        save(settings)

    # Always ensure Classic is present and in sync with the built-in definition
    items = settings.rulesets.items
    classic_idx = next((i for i, r in enumerate(items) if r.id == CLASSIC_RULESET_ID), None)
    if classic_idx is None:
        items.insert(0, _CLASSIC_RULESET)
    else:
        items[classic_idx] = _CLASSIC_RULESET

    if not settings.rulesets.active_ruleset_id:
        settings.rulesets.active_ruleset_id = CLASSIC_RULESET_ID

    # Re-seed default folder configs when the list is empty.  The bundled
    # "prepare / cleaned / collection" layout is effectively built-in — users
    # can rename, reorder, or hide entries, but an empty list means the
    # settings file landed in a half-initialised state (legacy migration,
    # first-boot race, or an older version writing an empty default).  Mirror
    # the Classic-ruleset heal: re-inject in memory without persisting so a
    # user who genuinely wants zero folders can still delete-and-save.
    if not settings.folders.folders:
        settings.folders.folders = [fc.model_copy() for fc in _DEFAULT_FOLDERS]

    # One-time migration: move ROOT_MUSIC_FOLDER from config.env → settings.json
    if not settings.app.root_music_folder:
        migrated = _migrate_root_folder_from_config_env()
        settings.app.root_music_folder = migrated or str(Path.home() / "Music")
        save(settings)

    return settings


def save(settings: Settings) -> Settings:
    """Atomically persist settings to disk and return them."""
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _SETTINGS_FILE.write_text(settings.model_dump_json(indent=2))
    try:
        os.chmod(_SETTINGS_FILE, stat.S_IRUSR | stat.S_IWUSR)  # 0o600 — owner-only
    except OSError:
        pass
    return settings


def update(mutator: Callable[[Settings], None]) -> Settings:
    """Load + mutate + persist helper."""
    settings = load()
    mutator(settings)
    return save(settings)
