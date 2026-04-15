"""API-level tests for the autoedit endpoint and the ollama pull-model endpoint."""

from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.ollama import router as ollama_router
from backend.schemas.metadata import TrackInfoUpdateRequest
from soundcloud_tools.handler.track import TrackInfo


@pytest.fixture
def ollama_client() -> TestClient:
    app = FastAPI()
    app.include_router(ollama_router)
    return TestClient(app)


class TestPullModel:
    def test_pull_succeeds(self, ollama_client: TestClient) -> None:
        with patch("backend.api.ollama.ollama_service.pull_model", new_callable=AsyncMock) as mock_pull:
            resp = ollama_client.post("/api/ollama/pull-model", json={"name": "gemma4:e2b"})
        assert resp.status_code == 200
        assert resp.json() == {"success": True, "name": "gemma4:e2b", "message": None}
        mock_pull.assert_awaited_once_with("gemma4:e2b")

    def test_pull_returns_502_on_http_error(self, ollama_client: TestClient) -> None:
        with patch(
            "backend.api.ollama.ollama_service.pull_model",
            new_callable=AsyncMock,
            side_effect=httpx.HTTPError("nope"),
        ):
            resp = ollama_client.post("/api/ollama/pull-model", json={"name": "gemma4:e2b"})
        assert resp.status_code == 502


class TestAutoeditEndpoint:
    def _make_file(self, root: Path) -> Path:
        sub = root / "prepare"
        sub.mkdir(exist_ok=True)
        file = sub / "track.mp3"
        file.write_bytes(b"fake")
        return file

    def test_returns_503_when_ollama_unavailable(self, client: TestClient, tmp_music_folder: Path) -> None:
        file_path = self._make_file(tmp_music_folder)
        with patch(
            "backend.api.metadata.files.ollama_service.is_available",
            new_callable=AsyncMock,
            return_value=False,
        ):
            resp = client.post(f"/api/metadata/files/{file_path}/autoedit")
        assert resp.status_code == 503

    def test_returns_suggestions(self, client: TestClient, tmp_music_folder: Path) -> None:
        file_path = self._make_file(tmp_music_folder)
        track = TrackInfo(title="t", artist="a")
        suggestions = TrackInfoUpdateRequest(title="T", genre="Techno")

        with (
            patch(
                "backend.api.metadata.files.ollama_service.is_available",
                new_callable=AsyncMock,
                return_value=True,
            ),
            patch("backend.api.metadata.files.metadata.get_track_info", return_value=track),
            patch(
                "backend.api.metadata.files.autoedit_service.autoedit",
                new_callable=AsyncMock,
                return_value={
                    "suggestions": suggestions,
                    "soundcloud_match": {
                        "id": 42,
                        "title": "T",
                        "artist": "A",
                        "permalink_url": "https://soundcloud.com/a/t",
                        "artwork_url": None,
                    },
                },
            ),
        ):
            resp = client.post(f"/api/metadata/files/{file_path}/autoedit")

        assert resp.status_code == 200
        data = resp.json()
        assert data["suggestions"]["title"] == "T"
        assert data["suggestions"]["genre"] == "Techno"
        assert data["soundcloud_match"]["id"] == 42
