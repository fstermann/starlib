"""Unified AI settings and response schemas.

Groups per-provider configuration (Ollama, Anthropic) under a single
``AiSettings`` block and provides the request/response shapes for the
consolidated ``/api/ai/*`` endpoints.
"""

from typing import Literal

from pydantic import BaseModel, Field

Provider = Literal["ollama", "anthropic", "claude_code"]


class OllamaSettings(BaseModel):
    url: str = "http://localhost:11434"
    model: str = "gemma4:e2b"


class AnthropicSettings(BaseModel):
    model: str = "claude-haiku-4-5-20251001"


class ClaudeCodeSettings(BaseModel):
    model: str = "haiku"


class AiSettings(BaseModel):
    """Persisted AI configuration (all providers + current selection)."""

    provider: Provider = "ollama"
    ollama: OllamaSettings = Field(default_factory=OllamaSettings)
    anthropic: AnthropicSettings = Field(default_factory=AnthropicSettings)
    claude_code: ClaudeCodeSettings = Field(default_factory=ClaudeCodeSettings)


class AiSettingsRequest(BaseModel):
    """Partial update; only provided fields are persisted."""

    provider: Provider | None = None
    ollama: OllamaSettings | None = None
    anthropic: AnthropicSettings | None = None
    claude_code: ClaudeCodeSettings | None = None


class AiSettingsResponse(BaseModel):
    """Full AI settings payload (API key is never included)."""

    provider: Provider
    ollama: OllamaSettings
    anthropic: AnthropicSettings
    claude_code: ClaudeCodeSettings
    anthropic_has_api_key: bool = False


class AiModel(BaseModel):
    """A single model offered by the active provider."""

    id: str
    display_name: str | None = None
    size: int | None = None


class AiModelsResponse(BaseModel):
    provider: Provider
    models: list[AiModel] = Field(default_factory=list)


class AiStatusResponse(BaseModel):
    """Per-provider readiness. Shape mirrors the previous Ollama status."""

    provider: Provider
    available: bool
    # Ollama-specific
    installed: bool = False
    started_by_us: bool = False
    models: list[str] = Field(default_factory=list)
    # Anthropic-specific
    has_api_key: bool = False
    # Claude Code-specific
    claude_cli_installed: bool = False


class AiCredentialsRequest(BaseModel):
    api_key: str


class OllamaPullRequest(BaseModel):
    name: str
