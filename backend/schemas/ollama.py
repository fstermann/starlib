"""Ollama integration schemas."""

from pydantic import BaseModel, Field


class OllamaSettings(BaseModel):
    """Persisted Ollama configuration."""

    url: str = "http://localhost:11434"
    model: str = "gemma4:e2b"


class OllamaModel(BaseModel):
    """Single model from Ollama's /api/tags response."""

    name: str
    size: int = 0
    digest: str = ""


class OllamaStatusResponse(BaseModel):
    """Response for GET /ollama/status."""

    available: bool
    installed: bool = False
    models: list[str] = Field(default_factory=list)
    started_by_us: bool = False


class OllamaModelsResponse(BaseModel):
    """Response for GET /ollama/models."""

    models: list[OllamaModel] = Field(default_factory=list)


class OllamaSettingsRequest(BaseModel):
    """Request body for POST /ollama/settings."""

    url: str | None = None
    model: str | None = None


class OllamaPullModelRequest(BaseModel):
    """Request body for POST /ollama/pull-model."""

    name: str


class OllamaPullModelResponse(BaseModel):
    """Response for POST /ollama/pull-model."""

    success: bool
    name: str
    message: str | None = None
