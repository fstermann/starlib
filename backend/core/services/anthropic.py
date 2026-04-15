"""Anthropic (Claude) chat service.

Mirrors the ``ollama_service.chat`` contract: takes a list of ``{"role",
"content"}`` dicts and returns the assistant's text reply. Static prefix
(system prompt + few-shot examples) is marked for prompt caching so the
majority of tokens are free on subsequent calls.
"""

import logging
from typing import Any

from anthropic import AsyncAnthropic
from anthropic import AuthenticationError as AnthropicAuthenticationError

from backend.core.services import credentials
from backend.core.services import settings as settings_service
from backend.schemas.ai import AiModel

logger = logging.getLogger(__name__)

_MAX_TOKENS = 1024


class MissingApiKeyError(RuntimeError):
    """Raised when the Anthropic API key is not configured."""


def _client() -> AsyncAnthropic:
    key = credentials.get_anthropic_api_key()
    if not key:
        raise MissingApiKeyError("Anthropic API key not configured.")
    return AsyncAnthropic(api_key=key)


def _split_messages(
    messages: list[dict[str, str]],
) -> tuple[str, list[dict[str, Any]]]:
    """Extract the system prompt and convert remaining messages to Anthropic shape."""
    system = ""
    rest: list[dict[str, Any]] = []
    for m in messages:
        if m["role"] == "system":
            system = m["content"]
            continue
        rest.append({"role": m["role"], "content": m["content"]})
    return system, rest


def _apply_cache_breakpoints(
    system: str,
    rest: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Turn the system prompt and the static few-shot prefix into cached blocks.

    The final ``user`` message is the variable per-call payload; everything
    before it is treated as the cacheable prefix. We set a cache breakpoint
    on the system block and on the last static message.
    """
    system_blocks: list[dict[str, Any]] = (
        [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}] if system else []
    )

    if len(rest) <= 1:
        # Nothing static to cache beyond the system prompt.
        return system_blocks, rest

    cached_messages: list[dict[str, Any]] = []
    for i, m in enumerate(rest):
        if i == len(rest) - 2:
            cached_messages.append(
                {
                    "role": m["role"],
                    "content": [
                        {
                            "type": "text",
                            "text": m["content"],
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                }
            )
        else:
            cached_messages.append(m)
    return system_blocks, cached_messages


async def chat(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    format: str | None = None,
) -> str:
    """Send a chat request to Claude and return the text reply.

    ``format="json"`` prefills the assistant response with ``{`` to bias
    toward a JSON object.
    """
    model = model or settings_service.load().ai.anthropic.model
    system, rest = _split_messages(messages)
    system_blocks, rest = _apply_cache_breakpoints(system, rest)

    if format == "json":
        rest.append({"role": "assistant", "content": "{"})

    async with _client() as client:
        resp = await client.messages.create(
            model=model,
            max_tokens=_MAX_TOKENS,
            system=system_blocks or "",  # type: ignore[arg-type]
            messages=rest,  # type: ignore[arg-type]
        )

    text = "".join(block.text for block in resp.content if block.type == "text")
    if format == "json":
        text = "{" + text
    return text


async def list_models() -> list[AiModel]:
    """Return the Anthropic models available to this API key."""
    try:
        async with _client() as client:
            page = await client.models.list(limit=50)
    except MissingApiKeyError:
        return []
    except AnthropicAuthenticationError as exc:
        logger.warning("Anthropic auth failed when listing models: %s", exc)
        return []
    return [AiModel(id=m.id, display_name=getattr(m, "display_name", None)) for m in page.data]


async def validate_api_key() -> bool:
    """Return True if the stored key can list models."""
    try:
        async with _client() as client:
            await client.models.list(limit=1)
        return True
    except (MissingApiKeyError, AnthropicAuthenticationError):
        return False
    except Exception as exc:
        logger.warning("Unexpected error validating Anthropic key: %s", exc)
        return False
