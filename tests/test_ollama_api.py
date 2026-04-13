"""Tests for the Ollama API endpoints."""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.ollama import router
from backend.schemas.ollama import OllamaModel


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestGetStatus:
    def test_available_with_models(self, client: TestClient) -> None:
        with (
            patch("backend.api.ollama.ollama_service.is_available", new_callable=AsyncMock, return_value=True),
            patch(
                "backend.api.ollama.ollama_service.list_models",
                new_callable=AsyncMock,
                return_value=[OllamaModel(name="gemma4:e2b", size=3_000_000_000, digest="abc")],
            ),
            patch("backend.api.ollama.ollama_service.is_installed", return_value=True),
            patch("backend.api.ollama.ollama_service.started_by_us", return_value=False),
        ):
            resp = client.get("/api/ollama/status")

        assert resp.status_code == 200
        data = resp.json()
        assert data["available"] is True
        assert data["models"] == ["gemma4:e2b"]
        assert data["started_by_us"] is False

    def test_not_available(self, client: TestClient) -> None:
        with (
            patch("backend.api.ollama.ollama_service.is_available", new_callable=AsyncMock, return_value=False),
            patch("backend.api.ollama.ollama_service.is_installed", return_value=True),
            patch("backend.api.ollama.ollama_service.started_by_us", return_value=False),
        ):
            resp = client.get("/api/ollama/status")

        data = resp.json()
        assert data["available"] is False
        assert data["models"] == []


class TestStartOllama:
    def test_auto_starts_and_returns_status(self, client: TestClient) -> None:
        with (
            patch("backend.api.ollama.ollama_service.ensure_running", new_callable=AsyncMock, return_value=True),
            patch(
                "backend.api.ollama.ollama_service.list_models",
                new_callable=AsyncMock,
                return_value=[OllamaModel(name="gemma4:e2b", size=3_000_000_000, digest="abc")],
            ),
            patch("backend.api.ollama.ollama_service.is_installed", return_value=True),
            patch("backend.api.ollama.ollama_service.started_by_us", return_value=True),
        ):
            resp = client.post("/api/ollama/start")

        assert resp.status_code == 200
        data = resp.json()
        assert data["available"] is True
        assert data["started_by_us"] is True

    def test_returns_unavailable_when_start_fails(self, client: TestClient) -> None:
        with (
            patch("backend.api.ollama.ollama_service.ensure_running", new_callable=AsyncMock, return_value=False),
            patch("backend.api.ollama.ollama_service.is_installed", return_value=True),
            patch("backend.api.ollama.ollama_service.started_by_us", return_value=False),
        ):
            resp = client.post("/api/ollama/start")

        data = resp.json()
        assert data["available"] is False
        assert data["models"] == []


class TestStopOllama:
    def test_stops_and_returns_status(self, client: TestClient) -> None:
        with (
            patch("backend.api.ollama.ollama_service.shutdown") as mock_shutdown,
            patch("backend.api.ollama.ollama_service.is_available", new_callable=AsyncMock, return_value=False),
            patch("backend.api.ollama.ollama_service.is_installed", return_value=True),
            patch("backend.api.ollama.ollama_service.started_by_us", return_value=False),
        ):
            resp = client.post("/api/ollama/stop")

        assert resp.status_code == 200
        mock_shutdown.assert_called_once()
        data = resp.json()
        assert data["available"] is False
        assert data["started_by_us"] is False


class TestGetModels:
    def test_returns_model_details(self, client: TestClient) -> None:
        models = [
            OllamaModel(name="gemma4:e2b", size=3_000_000_000, digest="abc"),
            OllamaModel(name="llama3:8b", size=8_000_000_000, digest="def"),
        ]
        with patch("backend.api.ollama.ollama_service.list_models", new_callable=AsyncMock, return_value=models):
            resp = client.get("/api/ollama/models")

        assert resp.status_code == 200
        data = resp.json()
        assert len(data["models"]) == 2
        assert data["models"][0]["name"] == "gemma4:e2b"
        assert data["models"][0]["size"] == 3_000_000_000


class TestSettings:
    def test_get_settings(self, client: TestClient) -> None:
        with patch(
            "backend.api.ollama.ollama_service.get_settings",
            return_value={"url": "http://localhost:11434", "model": "gemma4:e2b"},
        ):
            resp = client.get("/api/ollama/settings")

        assert resp.status_code == 200
        assert resp.json() == {"url": "http://localhost:11434", "model": "gemma4:e2b"}

    def test_update_settings(self, client: TestClient) -> None:
        with patch(
            "backend.api.ollama.ollama_service.update_settings",
            return_value={"url": "http://other:11434", "model": "llama3:8b"},
        ) as mock_update:
            resp = client.post(
                "/api/ollama/settings",
                json={"url": "http://other:11434", "model": "llama3:8b"},
            )

        assert resp.status_code == 200
        mock_update.assert_called_once_with(url="http://other:11434", model="llama3:8b")

    def test_partial_update(self, client: TestClient) -> None:
        with patch(
            "backend.api.ollama.ollama_service.update_settings",
            return_value={"url": "http://localhost:11434", "model": "llama3:8b"},
        ) as mock_update:
            resp = client.post("/api/ollama/settings", json={"model": "llama3:8b"})

        assert resp.status_code == 200
        mock_update.assert_called_once_with(url=None, model="llama3:8b")
