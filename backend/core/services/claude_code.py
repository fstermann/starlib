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


async def chat(  # noqa: C901
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
    turns: list[tuple[str, str]] = []
    for m in messages:
        role = m.get("role", "")
        content = m.get("content", "")
        if role == "system":
            system_prompt = content
        else:
            turns.append((role, content))

    # Fold the few-shot pairs into labeled examples, with the final user turn
    # as the live input. Claude treats this as regular text (not turns) since
    # `claude -p` is single-shot, so labels are what make the structure legible.
    example_pairs: list[str] = []
    i = 0
    while i < len(turns) - 1:
        u_role, u_content = turns[i]
        a_role, a_content = turns[i + 1]
        if u_role == "user" and a_role == "assistant":
            example_pairs.append(f"Example input:\n{u_content}\n\nExample output:\n{a_content}")
            i += 2
        else:
            break
    live_input = turns[-1][1] if turns and turns[-1][0] == "user" else ""

    parts: list[str] = []
    if example_pairs:
        parts.append("Here are examples of the task:\n\n" + "\n\n---\n\n".join(example_pairs))
    parts.append(f"Now apply the same task to this input:\n{live_input}")
    if format == "json":
        parts.append("Respond with only a single JSON object. No prose, no code fences.")
    prompt = "\n\n".join(parts)

    # `--system-prompt` replaces Claude Code's default agentic prompt, so the
    # model treats this as a pure instruction-following task.
    args = ["claude", "-p", prompt, "--model", model]
    if system_prompt:
        args += ["--system-prompt", system_prompt]

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
