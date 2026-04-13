"""Integration tests for the Ollama service against a real Ollama server.

Requires a running Ollama instance at http://localhost:11434 with no models
pulled. Run with: uv run pytest -m integration
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.ollama import router
from backend.core.services import ollama as ollama_service
from backend.core.services import settings as settings_service
from backend.schemas.ollama import OllamaSettings
from backend.schemas.settings import Settings

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _use_default_url(tmp_path):
    """Point settings at the real local Ollama and use a temp settings file."""
    settings = Settings(ollama=OllamaSettings(url="http://localhost:11434", model="gemma4:e2b"))
    original_load = settings_service.load

    def patched_load():
        return settings

    settings_service.load = patched_load
    yield
    settings_service.load = original_load


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestOllamaServerReachable:
    @pytest.mark.asyncio
    async def test_is_available(self) -> None:
        assert await ollama_service.is_available() is True

    @pytest.mark.asyncio
    async def test_list_models_returns_list(self) -> None:
        models = await ollama_service.list_models()
        assert isinstance(models, list)
        # CI has no models pulled, so expect empty
        # (locally you might have models installed — that's fine too)


class TestOllamaApiEndpoints:
    def test_status_shows_available(self, client: TestClient) -> None:
        resp = client.get("/api/ollama/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["available"] is True
        assert isinstance(data["models"], list)

    def test_models_returns_list(self, client: TestClient) -> None:
        resp = client.get("/api/ollama/models")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data["models"], list)

    def test_settings_roundtrip(self, client: TestClient) -> None:
        resp = client.get("/api/ollama/settings")
        assert resp.status_code == 200
        data = resp.json()
        assert "url" in data
        assert "model" in data
