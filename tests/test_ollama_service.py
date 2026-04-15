"""Tests for the Ollama service layer."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from backend.core.services import ollama as ollama_service
from backend.schemas.ollama import OllamaModel


@pytest.fixture(autouse=True)
def _default_settings():
    """Patch settings to return deterministic Ollama config."""
    from backend.schemas.ai import AiSettings, OllamaSettings
    from backend.schemas.settings import Settings

    settings = Settings(ai=AiSettings(ollama=OllamaSettings(url="http://test:11434", model="gemma4:e2b")))

    with patch.object(ollama_service, "settings_service") as mock_ss:
        mock_ss.load.return_value = settings
        yield mock_ss

    # Reset process state to avoid leaking between tests
    ollama_service._process = None


class TestIsAvailable:
    @pytest.mark.asyncio
    async def test_returns_true_when_reachable(self) -> None:
        mock_resp = AsyncMock()
        mock_resp.status_code = 200

        with patch("httpx.AsyncClient.get", return_value=mock_resp):
            assert await ollama_service.is_available() is True

    @pytest.mark.asyncio
    async def test_returns_false_on_connection_error(self) -> None:
        with patch("httpx.AsyncClient.get", side_effect=httpx.ConnectError("refused")):
            assert await ollama_service.is_available() is False

    @pytest.mark.asyncio
    async def test_returns_false_on_non_200(self) -> None:
        mock_resp = AsyncMock()
        mock_resp.status_code = 500

        with patch("httpx.AsyncClient.get", return_value=mock_resp):
            assert await ollama_service.is_available() is False


class TestListModels:
    @pytest.mark.asyncio
    async def test_returns_models(self) -> None:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "models": [
                {"name": "gemma4:e2b", "size": 3_000_000_000, "digest": "abc123"},
                {"name": "llama3:8b", "size": 8_000_000_000, "digest": "def456"},
            ]
        }

        with patch("httpx.AsyncClient.get", return_value=mock_resp):
            models = await ollama_service.list_models()

        assert len(models) == 2
        assert models[0] == OllamaModel(name="gemma4:e2b", size=3_000_000_000, digest="abc123")
        assert models[1].name == "llama3:8b"

    @pytest.mark.asyncio
    async def test_returns_empty_on_error(self) -> None:
        with patch("httpx.AsyncClient.get", side_effect=httpx.ConnectError("refused")):
            models = await ollama_service.list_models()

        assert models == []


class TestChat:
    @pytest.mark.asyncio
    async def test_returns_content(self) -> None:
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"message": {"role": "assistant", "content": "Hello!"}}

        with (
            patch.object(ollama_service, "ensure_running", new_callable=AsyncMock, return_value=True),
            patch("httpx.AsyncClient.post", return_value=mock_resp) as mock_post,
        ):
            result = await ollama_service.chat([{"role": "user", "content": "Hi"}])

        assert result == "Hello!"
        call_kwargs = mock_post.call_args
        body = call_kwargs.kwargs["json"]
        assert body["model"] == "gemma4:e2b"
        assert body["stream"] is False

    @pytest.mark.asyncio
    async def test_uses_override_model(self) -> None:
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"message": {"role": "assistant", "content": "OK"}}

        with (
            patch.object(ollama_service, "ensure_running", new_callable=AsyncMock, return_value=True),
            patch("httpx.AsyncClient.post", return_value=mock_resp) as mock_post,
        ):
            await ollama_service.chat([{"role": "user", "content": "Hi"}], model="llama3:8b")

        body = mock_post.call_args.kwargs["json"]
        assert body["model"] == "llama3:8b"

    @pytest.mark.asyncio
    async def test_passes_format(self) -> None:
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"message": {"role": "assistant", "content": "{}"}}

        with (
            patch.object(ollama_service, "ensure_running", new_callable=AsyncMock, return_value=True),
            patch("httpx.AsyncClient.post", return_value=mock_resp) as mock_post,
        ):
            await ollama_service.chat([{"role": "user", "content": "Hi"}], format="json")

        body = mock_post.call_args.kwargs["json"]
        assert body["format"] == "json"


class TestEnsureRunning:
    @pytest.mark.asyncio
    async def test_already_available_is_noop(self) -> None:
        with patch.object(ollama_service, "is_available", new_callable=AsyncMock, return_value=True):
            assert await ollama_service.ensure_running() is True

    @pytest.mark.asyncio
    async def test_skips_auto_start_for_remote_url(self, _default_settings) -> None:
        """Don't try to start Ollama when the URL points to a remote host."""
        from backend.schemas.ai import AiSettings, OllamaSettings
        from backend.schemas.settings import Settings

        _default_settings.load.return_value = Settings(
            ai=AiSettings(ollama=OllamaSettings(url="http://remote-host:11434", model="gemma4:e2b"))
        )
        with patch.object(ollama_service, "is_available", new_callable=AsyncMock, return_value=False):
            assert await ollama_service.ensure_running() is False

    @pytest.mark.asyncio
    async def test_returns_false_when_binary_not_found(self) -> None:
        with (
            patch.object(ollama_service, "is_available", new_callable=AsyncMock, return_value=False),
            patch("shutil.which", return_value=None),
        ):
            assert await ollama_service.ensure_running() is False


class TestShutdown:
    def test_noop_when_no_process(self) -> None:
        ollama_service._process = None
        ollama_service.shutdown()  # should not raise

    def test_terminates_owned_process(self) -> None:
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None  # still running
        ollama_service._process = mock_proc

        ollama_service.shutdown()

        mock_proc.terminate.assert_called_once()
        mock_proc.wait.assert_called_once_with(timeout=5)
        assert ollama_service._process is None

    def test_kills_on_timeout(self) -> None:
        import subprocess

        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_proc.wait.side_effect = subprocess.TimeoutExpired(cmd="ollama", timeout=5)
        ollama_service._process = mock_proc

        ollama_service.shutdown()

        mock_proc.kill.assert_called_once()
        assert ollama_service._process is None


class TestStartedByUs:
    def test_false_when_no_process(self) -> None:
        ollama_service._process = None
        assert ollama_service.started_by_us() is False

    def test_true_when_process_running(self) -> None:
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        ollama_service._process = mock_proc
        assert ollama_service.started_by_us() is True

    def test_false_when_process_exited(self) -> None:
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0
        ollama_service._process = mock_proc
        assert ollama_service.started_by_us() is False
