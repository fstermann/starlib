"""Claude Code (CLI) chat service.

Invokes the ``claude`` binary in non-interactive mode and captures its
response text. Authentication and model choice are delegated to the CLI,
so users already signed into Claude Code don't need a separate API key.
"""

import asyncio
import logging
import shutil
from typing import Any

from backend.core.services import settings as settings_service
from backend.schemas.ai import AiModel

logger = logging.getLogger(__name__)

_TIMEOUT = 180.0

# Model aliases the CLI accepts. Kept as a static list since there's no
# enumerate endpoint — the CLI resolves these to the current Sonnet/Opus/Haiku.
_CLAUDE_CODE_MODELS: list[AiModel] = [
    AiModel(id="haiku", display_name="Claude Haiku (fast, cheap)"),
    AiModel(id="sonnet", display_name="Claude Sonnet (balanced)"),
    AiModel(id="opus", display_name="Claude Opus (most capable)"),
]


def is_installed() -> bool:
    """Return True if the ``claude`` binary is on PATH."""
    return shutil.which("claude") is not None


async def chat(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    format: str | None = None,
) -> str:
    """Spawn ``claude -p`` and return its stdout.

    The message list is split into a single system prompt plus a folded
    user prompt that concatenates all remaining turns. Claude Code handles
    auth and prompt caching itself.
    """
    if not is_installed():
        raise RuntimeError("Claude Code CLI (`claude`) not found on PATH.")

    model = model or settings_service.load().ai.claude_code.model

    system_prompt = ""
    folded: list[str] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "")
        if role == "system":
            system_prompt = content
        elif role == "user":
            folded.append(f"<user>\n{content}\n</user>")
        elif role == "assistant":
            folded.append(f"<assistant>\n{content}\n</assistant>")
    prompt = "\n\n".join(folded)
    if format == "json":
        prompt += "\n\nRespond with a single JSON object and nothing else."

    args = ["claude", "-p", prompt, "--model", model]
    if system_prompt:
        args += ["--append-system-prompt", system_prompt]

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_TIMEOUT)
    except TimeoutError as exc:
        proc.kill()
        raise RuntimeError("Claude Code CLI timed out.") from exc

    if proc.returncode != 0:
        raise RuntimeError(f"Claude Code CLI exited {proc.returncode}: {stderr.decode(errors='replace').strip()}")
    return stdout.decode(errors="replace").strip()


async def list_models() -> list[AiModel]:
    """Return the Claude Code model aliases."""
    return list(_CLAUDE_CODE_MODELS)


async def validate() -> dict[str, Any]:
    """Probe readiness. Available == CLI installed (auth is handled at call time)."""
    return {"installed": is_installed()}
