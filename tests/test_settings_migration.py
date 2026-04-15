"""Tests for settings-schema migrations."""

import json
from pathlib import Path
from unittest.mock import patch

from backend.core.services import settings as settings_service


def test_legacy_ollama_block_moves_under_ai(tmp_path: Path) -> None:
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(
        json.dumps(
            {
                "app": {"preferred_output_format": "aiff", "root_music_folder": str(tmp_path)},
                "rulesets": {"items": [], "active_ruleset_id": "classic"},
                "folders": {"folders": []},
                "ollama": {"url": "http://legacy:11434", "model": "llama3:8b"},
            }
        )
    )

    with (
        patch.object(settings_service, "_SETTINGS_FILE", settings_file),
        patch.object(settings_service, "_CONFIG_DIR", tmp_path),
    ):
        loaded = settings_service.load()

    assert loaded.ai.ollama.url == "http://legacy:11434"
    assert loaded.ai.ollama.model == "llama3:8b"
    assert loaded.ai.provider == "ollama"

    persisted = json.loads(settings_file.read_text())
    assert "ollama" not in persisted
    assert persisted["ai"]["ollama"]["url"] == "http://legacy:11434"
