"""Shared helpers for working with the currently active AI provider."""

from backend.core.services import anthropic as anthropic_service
from backend.core.services import claude_code as claude_code_service
from backend.core.services import credentials
from backend.core.services import ollama as ollama_service
from backend.core.services import settings as settings_service


async def active_provider_ready() -> tuple[bool, str]:
    """Return ``(ready, reason_if_not)`` for the currently selected provider.

    ``reason_if_not`` is an empty string when ready; otherwise a user-facing
    hint suitable for surfacing in a 503 response.
    """
    provider = settings_service.load().ai.provider
    if provider == "ollama":
        if await ollama_service.is_available():
            return True, ""
        return False, "Ollama is not available. Start it from settings and make sure a model is installed."
    if provider == "anthropic":
        if not credentials.has_anthropic_api_key():
            return False, "Anthropic API key not set. Add one in Settings → AI."
        if await anthropic_service.validate_api_key():
            return True, ""
        return False, "Anthropic API key is set but the API is unreachable."
    if provider == "claude_code":
        if claude_code_service.is_installed():
            return True, ""
        return False, "Claude Code CLI (`claude`) not found on PATH."
    return False, f"Unknown AI provider: {provider}"
