"""REST API for AI provider configuration.

Consolidates the former ``/api/ollama/*`` endpoints under ``/api/ai/*`` and
adds Anthropic (Claude) as a second provider.
"""

import logging

from fastapi import APIRouter, HTTPException, status

from backend.core.services import anthropic as anthropic_service
from backend.core.services import claude_code as claude_code_service
from backend.core.services import credentials
from backend.core.services import ollama as ollama_service
from backend.core.services import settings as settings_service
from backend.schemas.ai import (
    AiCredentialsRequest,
    AiModel,
    AiModelsResponse,
    AiSettingsRequest,
    AiSettingsResponse,
    AiStatusResponse,
    OllamaPullRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def _settings_response() -> AiSettingsResponse:
    ai = settings_service.load().ai
    return AiSettingsResponse(
        provider=ai.provider,
        ollama=ai.ollama,
        anthropic=ai.anthropic,
        claude_code=ai.claude_code,
        anthropic_has_api_key=credentials.has_anthropic_api_key(),
    )


@router.get("/settings", response_model=AiSettingsResponse)
def get_settings() -> AiSettingsResponse:
    """Return the active provider and per-provider configuration."""
    return _settings_response()


@router.post("/settings", response_model=AiSettingsResponse)
def update_settings(body: AiSettingsRequest) -> AiSettingsResponse:
    """Patch the AI settings; only provided fields are persisted."""

    def _mutate(s) -> None:
        if body.provider is not None:
            s.ai.provider = body.provider
        if body.ollama is not None:
            s.ai.ollama = body.ollama
        if body.anthropic is not None:
            s.ai.anthropic = body.anthropic
        if body.claude_code is not None:
            s.ai.claude_code = body.claude_code

    settings_service.update(_mutate)
    return _settings_response()


# ---------------------------------------------------------------------------
# Status / models for the active provider
# ---------------------------------------------------------------------------


@router.get("/status", response_model=AiStatusResponse)
async def get_status() -> AiStatusResponse:
    """Return readiness for the currently selected provider."""
    ai = settings_service.load().ai
    if ai.provider == "ollama":
        available = await ollama_service.is_available()
        models = [m.name for m in await ollama_service.list_models()] if available else []
        return AiStatusResponse(
            provider="ollama",
            available=available,
            installed=ollama_service.is_installed(),
            started_by_us=ollama_service.started_by_us(),
            models=models,
        )
    if ai.provider == "claude_code":
        installed = claude_code_service.is_installed()
        return AiStatusResponse(
            provider="claude_code",
            available=installed,
            claude_cli_installed=installed,
        )
    has_key = credentials.has_anthropic_api_key()
    available = await anthropic_service.validate_api_key() if has_key else False
    return AiStatusResponse(
        provider="anthropic",
        available=available,
        has_api_key=has_key,
    )


@router.get("/models", response_model=AiModelsResponse)
async def get_models() -> AiModelsResponse:
    """List models offered by the currently selected provider."""
    ai = settings_service.load().ai
    if ai.provider == "ollama":
        raw = await ollama_service.list_models()
        return AiModelsResponse(
            provider="ollama",
            models=[AiModel(id=m.name, size=m.size) for m in raw],
        )
    if ai.provider == "claude_code":
        return AiModelsResponse(
            provider="claude_code",
            models=await claude_code_service.list_models(),
        )
    return AiModelsResponse(
        provider="anthropic",
        models=await anthropic_service.list_models(),
    )


# ---------------------------------------------------------------------------
# Ollama process lifecycle (provider-scoped)
# ---------------------------------------------------------------------------


@router.post("/ollama/start", response_model=AiStatusResponse)
async def start_ollama() -> AiStatusResponse:
    """Ensure the Ollama server is running (auto-starting if installed)."""
    available = await ollama_service.ensure_running()
    models = [m.name for m in await ollama_service.list_models()] if available else []
    return AiStatusResponse(
        provider="ollama",
        available=available,
        installed=ollama_service.is_installed(),
        started_by_us=ollama_service.started_by_us(),
        models=models,
    )


@router.post("/ollama/stop", response_model=AiStatusResponse)
async def stop_ollama() -> AiStatusResponse:
    """Stop the Ollama server if we started it."""
    ollama_service.shutdown()
    available = await ollama_service.is_available()
    return AiStatusResponse(
        provider="ollama",
        available=available,
        installed=ollama_service.is_installed(),
        started_by_us=ollama_service.started_by_us(),
    )


@router.post("/ollama/pull-model")
async def pull_ollama_model(body: OllamaPullRequest) -> dict:
    """Pull an Ollama model by name via ``POST /api/pull``."""
    import httpx

    try:
        await ollama_service.pull_model(body.name)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to pull model: {exc}",
        ) from exc
    return {"success": True, "name": body.name, "message": None}


# ---------------------------------------------------------------------------
# Anthropic credentials (provider-scoped)
# ---------------------------------------------------------------------------


@router.post("/anthropic/credentials", response_model=AiSettingsResponse)
async def set_anthropic_credentials(body: AiCredentialsRequest) -> AiSettingsResponse:
    """Store the Anthropic API key in the OS keychain."""
    if not body.api_key.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="API key must not be empty.",
        )
    if not credentials.set_anthropic_api_key(body.api_key.strip()):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Keychain unavailable on this system.",
        )
    return _settings_response()


@router.delete("/anthropic/credentials", response_model=AiSettingsResponse)
def delete_anthropic_credentials() -> AiSettingsResponse:
    """Remove the Anthropic API key from the OS keychain."""
    credentials.delete_anthropic_api_key()
    return _settings_response()
