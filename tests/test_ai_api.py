"""Tests for the consolidated /api/ai/* endpoints."""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.ai import router
from backend.schemas.ai import AiModel, AiSettings
from backend.schemas.ollama import OllamaModel
from backend.schemas.settings import Settings


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _settings(provider: str = "ollama") -> Settings:
    return Settings(ai=AiSettings(provider=provider))  # type: ignore[arg-type]


class TestGetStatus:
    def test_ollama_available(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("ollama")),
            patch("backend.api.ai.ollama_service.is_available", new_callable=AsyncMock, return_value=True),
            patch(
                "backend.api.ai.ollama_service.list_models",
                new_callable=AsyncMock,
                return_value=[OllamaModel(name="gemma4:e2b", size=3_000_000_000, digest="abc")],
            ),
            patch("backend.api.ai.ollama_service.is_installed", return_value=True),
            patch("backend.api.ai.ollama_service.started_by_us", return_value=False),
        ):
            resp = client.get("/api/ai/status")

        assert resp.status_code == 200
        data = resp.json()
        assert data["provider"] == "ollama"
        assert data["available"] is True
        assert data["models"] == ["gemma4:e2b"]

    def test_anthropic_no_key(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("anthropic")),
            patch("backend.api.ai.credentials.has_anthropic_api_key", return_value=False),
        ):
            resp = client.get("/api/ai/status")

        data = resp.json()
        assert data["provider"] == "anthropic"
        assert data["available"] is False
        assert data["has_api_key"] is False

    def test_anthropic_with_valid_key(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("anthropic")),
            patch("backend.api.ai.credentials.has_anthropic_api_key", return_value=True),
            patch("backend.api.ai.anthropic_service.validate_api_key", new_callable=AsyncMock, return_value=True),
        ):
            resp = client.get("/api/ai/status")

        data = resp.json()
        assert data["provider"] == "anthropic"
        assert data["available"] is True
        assert data["has_api_key"] is True

    def test_claude_code_detects_cli(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("claude_code")),
            patch("backend.api.ai.claude_code_service.is_installed", return_value=True),
        ):
            resp = client.get("/api/ai/status")

        data = resp.json()
        assert data["provider"] == "claude_code"
        assert data["available"] is True
        assert data["claude_cli_installed"] is True

    def test_claude_code_missing_cli(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("claude_code")),
            patch("backend.api.ai.claude_code_service.is_installed", return_value=False),
        ):
            resp = client.get("/api/ai/status")

        data = resp.json()
        assert data["provider"] == "claude_code"
        assert data["available"] is False
        assert data["claude_cli_installed"] is False


class TestGetModels:
    def test_ollama_models(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("ollama")),
            patch(
                "backend.api.ai.ollama_service.list_models",
                new_callable=AsyncMock,
                return_value=[OllamaModel(name="gemma4:e2b", size=3_000_000_000, digest="abc")],
            ),
        ):
            resp = client.get("/api/ai/models")

        data = resp.json()
        assert data["provider"] == "ollama"
        assert data["models"][0]["id"] == "gemma4:e2b"
        assert data["models"][0]["size"] == 3_000_000_000

    def test_anthropic_models(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("anthropic")),
            patch(
                "backend.api.ai.anthropic_service.list_models",
                new_callable=AsyncMock,
                return_value=[AiModel(id="claude-haiku-4-5-20251001", display_name="Claude Haiku 4.5")],
            ),
        ):
            resp = client.get("/api/ai/models")

        data = resp.json()
        assert data["provider"] == "anthropic"
        assert data["models"][0]["id"] == "claude-haiku-4-5-20251001"


class TestSettings:
    def test_get_settings(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.settings_service.load", return_value=_settings("ollama")),
            patch("backend.api.ai.credentials.has_anthropic_api_key", return_value=False),
        ):
            resp = client.get("/api/ai/settings")

        assert resp.status_code == 200
        data = resp.json()
        assert data["provider"] == "ollama"
        assert data["anthropic_has_api_key"] is False

    def test_update_provider(self, client: TestClient) -> None:
        updates: list = []

        def mock_update(mutator):
            s = _settings("ollama")
            mutator(s)
            updates.append(s)
            return s

        with (
            patch("backend.api.ai.settings_service.update", side_effect=mock_update),
            patch("backend.api.ai.settings_service.load", return_value=_settings("anthropic")),
            patch("backend.api.ai.credentials.has_anthropic_api_key", return_value=True),
        ):
            resp = client.post("/api/ai/settings", json={"provider": "anthropic"})

        assert resp.status_code == 200
        assert updates and updates[0].ai.provider == "anthropic"


class TestAnthropicCredentials:
    def test_set_key_success(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.credentials.set_anthropic_api_key", return_value=True) as mock_set,
            patch("backend.api.ai.settings_service.load", return_value=_settings("anthropic")),
            patch("backend.api.ai.credentials.has_anthropic_api_key", return_value=True),
        ):
            resp = client.post("/api/ai/anthropic/credentials", json={"api_key": "sk-ant-xxx"})

        assert resp.status_code == 200
        mock_set.assert_called_once_with("sk-ant-xxx")
        assert resp.json()["anthropic_has_api_key"] is True

    def test_set_key_rejects_empty(self, client: TestClient) -> None:
        resp = client.post("/api/ai/anthropic/credentials", json={"api_key": "   "})
        assert resp.status_code == 400

    def test_delete_key(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.credentials.delete_anthropic_api_key", return_value=True) as mock_del,
            patch("backend.api.ai.settings_service.load", return_value=_settings("anthropic")),
            patch("backend.api.ai.credentials.has_anthropic_api_key", return_value=False),
        ):
            resp = client.delete("/api/ai/anthropic/credentials")

        assert resp.status_code == 200
        mock_del.assert_called_once()
        assert resp.json()["anthropic_has_api_key"] is False


class TestOllamaLifecycle:
    def test_start(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.ollama_service.ensure_running", new_callable=AsyncMock, return_value=True),
            patch(
                "backend.api.ai.ollama_service.list_models",
                new_callable=AsyncMock,
                return_value=[OllamaModel(name="gemma4:e2b")],
            ),
            patch("backend.api.ai.ollama_service.is_installed", return_value=True),
            patch("backend.api.ai.ollama_service.started_by_us", return_value=True),
        ):
            resp = client.post("/api/ai/ollama/start")

        data = resp.json()
        assert data["available"] is True
        assert data["started_by_us"] is True

    def test_stop(self, client: TestClient) -> None:
        with (
            patch("backend.api.ai.ollama_service.shutdown") as mock_shutdown,
            patch("backend.api.ai.ollama_service.is_available", new_callable=AsyncMock, return_value=False),
            patch("backend.api.ai.ollama_service.is_installed", return_value=True),
            patch("backend.api.ai.ollama_service.started_by_us", return_value=False),
        ):
            resp = client.post("/api/ai/ollama/stop")

        assert resp.status_code == 200
        mock_shutdown.assert_called_once()
        assert resp.json()["available"] is False
