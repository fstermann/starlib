"""REST API for Ollama integration."""

import logging

import httpx
from fastapi import APIRouter, HTTPException, status

from backend.core.services import ollama as ollama_service
from backend.schemas.ollama import (
    OllamaModelsResponse,
    OllamaPullModelRequest,
    OllamaPullModelResponse,
    OllamaSettingsRequest,
    OllamaStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ollama", tags=["ollama"])


def _status_fields(available: bool, models: list[str]) -> OllamaStatusResponse:
    return OllamaStatusResponse(
        available=available,
        installed=ollama_service.is_installed(),
        models=models,
        started_by_us=ollama_service.started_by_us(),
    )


@router.get("/status", response_model=OllamaStatusResponse)
async def get_status() -> OllamaStatusResponse:
    """Check if Ollama is reachable and return available model names."""
    available = await ollama_service.is_available()
    models: list[str] = []
    if available:
        model_list = await ollama_service.list_models()
        models = [m.name for m in model_list]
    return _status_fields(available, models)


@router.post("/start", response_model=OllamaStatusResponse)
async def start_ollama() -> OllamaStatusResponse:
    """Ensure Ollama is running, auto-starting it if necessary."""
    available = await ollama_service.ensure_running()
    models: list[str] = []
    if available:
        model_list = await ollama_service.list_models()
        models = [m.name for m in model_list]
    return _status_fields(available, models)


@router.post("/stop", response_model=OllamaStatusResponse)
async def stop_ollama() -> OllamaStatusResponse:
    """Stop Ollama if we started it."""
    ollama_service.shutdown()
    available = await ollama_service.is_available()
    return _status_fields(available, [])


@router.get("/models", response_model=OllamaModelsResponse)
async def get_models() -> OllamaModelsResponse:
    """Return installed models with details (name, size, digest)."""
    models = await ollama_service.list_models()
    return OllamaModelsResponse(models=models)


@router.post("/pull-model", response_model=OllamaPullModelResponse)
async def pull_model(body: OllamaPullModelRequest) -> OllamaPullModelResponse:
    """Download an Ollama model by name. Blocks until the pull finishes."""
    try:
        await ollama_service.pull_model(body.name)
    except httpx.HTTPError as exc:
        logger.warning("Ollama pull failed for %s: %s", body.name, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to pull model {body.name!r}: {exc}",
        ) from exc
    return OllamaPullModelResponse(success=True, name=body.name)


@router.get("/settings")
def get_settings() -> dict:
    """Return current Ollama settings."""
    return ollama_service.get_settings()


@router.post("/settings")
def update_settings(body: OllamaSettingsRequest) -> dict:
    """Update Ollama URL and/or selected model."""
    return ollama_service.update_settings(url=body.url, model=body.model)
