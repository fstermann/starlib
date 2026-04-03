"""Shared test fixtures for backend tests."""

from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi_pagination import add_pagination

from backend.api.deps import get_root_folder
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
    test_app.dependency_overrides[get_root_folder] = lambda: tmp_music_folder

    @test_app.get("/health")
    def health_check() -> dict[str, str]:
        return {"status": "ok"}

    return test_app


@pytest.fixture
def client(app: FastAPI, tmp_music_folder: Path) -> TestClient:
    """Create a test client with mocked settings."""
    settings = SimpleNamespace(
        root_music_folder=str(tmp_music_folder),
        cache_dir=tmp_music_folder / ".cache",
    )

    with ExitStack() as stack:
        stack.enter_context(patch("backend.api.setup.get_settings"))
        stack.enter_context(patch("backend.api.setup.get_backend_settings", return_value=settings))
        stack.enter_context(patch("backend.api.metadata.audio.get_backend_settings", return_value=settings))
        stack.enter_context(patch("backend.api.metadata.artwork.get_backend_settings", return_value=settings))
        yield TestClient(app)
