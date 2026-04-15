"""Ollama-native response shapes (used by the internal client)."""

from pydantic import BaseModel


class OllamaModel(BaseModel):
    """Single model from Ollama's /api/tags response."""

    name: str
    size: int = 0
    digest: str = ""
