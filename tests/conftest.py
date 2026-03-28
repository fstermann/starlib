"""Shared test fixtures for backend tests."""

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi_pagination import add_pagination

from backend.api.metadata import router as metadata_router
from backend.api.setup import router as setup_router


@pytest.fixture
def tmp_music_folder(tmp_path: Path) -> Path:
    """Create a temporary music folder with sub-directories."""
    for sub in ("prepare", "collection", "cleaned"):
        (tmp_path / sub).mkdir()
    return tmp_path


@pytest.fixture
def app(tmp_music_folder: Path) -> FastAPI:
    """Create a test FastAPI app without lifespan (no watchers/DB)."""
    test_app = FastAPI()
    test_app.include_router(setup_router)
    test_app.include_router(metadata_router)
    add_pagination(test_app)

    @test_app.get("/health")
    def health_check() -> dict[str, str]:
        return {"status": "ok"}

    return test_app


@pytest.fixture
def client(app: FastAPI, tmp_music_folder: Path) -> TestClient:
    """Create a test client with mocked settings."""
    with (
        patch("backend.api.deps.get_settings") as mock_settings,
        patch("backend.config.get_backend_settings") as mock_backend_settings,
    ):
        mock_settings.return_value.root_music_folder = str(tmp_music_folder)
        mock_backend_settings.return_value.root_music_folder = str(tmp_music_folder)
        mock_backend_settings.return_value.cache_dir = tmp_music_folder / ".cache"

        yield TestClient(app)
