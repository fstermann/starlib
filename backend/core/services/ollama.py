"""Ollama HTTP client service.

Wraps the Ollama REST API (https://github.com/ollama/ollama/blob/main/docs/api.md)
for health checks, model listing, and chat completions.

If Ollama is not running when needed, the service can auto-start it as a
subprocess and will shut it down when the app exits — but only if *we* started
it. A pre-existing Ollama process is never touched.
"""

import asyncio
import atexit
import logging
import shutil
import signal
import subprocess

import httpx

from backend.core.services import settings as settings_service
from backend.schemas.ollama import OllamaModel

logger = logging.getLogger(__name__)

_TIMEOUT = 5.0  # seconds for health/model requests

# Process lifecycle — only set when *we* spawned Ollama.
_process: subprocess.Popen | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _base_url() -> str:
    return settings_service.load().ollama.url.rstrip("/")


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def is_installed() -> bool:
    """Return True if the ``ollama`` binary is on PATH."""
    return shutil.which("ollama") is not None


async def is_available() -> bool:
    """Return True if the Ollama server is reachable."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(f"{_base_url()}/api/tags")
            return resp.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


# ---------------------------------------------------------------------------
# Process lifecycle
# ---------------------------------------------------------------------------


async def ensure_running() -> bool:
    """Make sure Ollama is reachable, auto-starting it if necessary.

    Returns True if Ollama is available (either already running or
    successfully started).  Tracks whether we spawned the process so
    `shutdown` knows whether to kill it.
    """
    global _process

    if await is_available():
        return True

    # Only attempt auto-start when targeting a local URL.
    url = _base_url()
    if "localhost" not in url and "127.0.0.1" not in url:
        return False

    ollama_bin = shutil.which("ollama")
    if not ollama_bin:
        logger.info("Ollama binary not found on PATH — cannot auto-start")
        return False

    # Spawn a new process (unless we already have one that hasn't exited).
    if _process is None or _process.poll() is not None:
        logger.info("Starting Ollama subprocess: %s serve", ollama_bin)
        _process = subprocess.Popen(
            [ollama_bin, "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # Wait up to 10 s for the server to become reachable.
    for _ in range(20):
        await asyncio.sleep(0.5)
        if await is_available():
            logger.info("Ollama subprocess is ready (PID %s)", _process.pid)
            return True

    logger.warning("Ollama subprocess started but not reachable after 10 s")
    return False


def started_by_us() -> bool:
    """Return True if we spawned the running Ollama process."""
    return _process is not None and _process.poll() is None


def shutdown() -> None:
    """Terminate Ollama if we started it.  No-op otherwise."""
    global _process
    if _process is None:
        return
    if _process.poll() is None:
        logger.info("Stopping Ollama subprocess (PID %s)", _process.pid)
        _process.terminate()
        try:
            _process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logger.warning("Ollama did not exit in time, killing")
            _process.kill()
    _process = None


# Register cleanup so a crash or signal still tears down a child we own.
atexit.register(shutdown)

for _sig in (signal.SIGTERM, signal.SIGINT):
    _prev_handler = signal.getsignal(_sig)

    def _on_signal(
        signum: int,
        frame: object,
        *,
        _prev: object = _prev_handler,
    ) -> None:
        shutdown()
        if callable(_prev) and _prev not in (signal.SIG_DFL, signal.SIG_IGN):
            _prev(signum, frame)

    signal.signal(_sig, _on_signal)


# ---------------------------------------------------------------------------
# Ollama API
# ---------------------------------------------------------------------------


async def list_models() -> list[OllamaModel]:
    """Return models installed on the Ollama server."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(f"{_base_url()}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            return [
                OllamaModel(
                    name=m["name"],
                    size=m.get("size", 0),
                    digest=m.get("digest", ""),
                )
                for m in data.get("models", [])
            ]
    except (httpx.HTTPError, OSError) as exc:
        logger.warning("Failed to list Ollama models: %s", exc)
        return []


async def pull_model(name: str) -> None:
    """Download a model via Ollama's ``/api/pull`` endpoint.

    Blocks until the pull finishes. Raises ``httpx.HTTPError`` on failure.
    """
    await ensure_running()
    url = f"{_base_url()}/api/pull"
    async with httpx.AsyncClient(timeout=None) as client:
        resp = await client.post(url, json={"name": name, "stream": False})
        resp.raise_for_status()


async def chat(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    format: str | None = None,
) -> str:
    """Send a chat completion request and return the assistant message content.

    Parameters
    ----------
    messages:
        List of {"role": ..., "content": ...} dicts.
    model:
        Override the configured model.
    format:
        Optional response format (e.g. "json").
    """
    await ensure_running()

    url = f"{_base_url()}/api/chat"
    model = model or settings_service.load().ollama.model

    body: dict = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    if format:
        body["format"] = format

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, json=body)
        resp.raise_for_status()
        data = resp.json()
        return data["message"]["content"]


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def get_settings() -> dict:
    """Return current Ollama settings as a dict."""
    return settings_service.load().ollama.model_dump()


def update_settings(*, url: str | None = None, model: str | None = None) -> dict:
    """Update persisted Ollama settings."""

    def _mutate(s):
        if url is not None:
            s.ollama.url = url
        if model is not None:
            s.ollama.model = model

    settings_service.update(_mutate)
    return settings_service.load().ollama.model_dump()
