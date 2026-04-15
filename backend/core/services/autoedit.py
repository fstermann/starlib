"""LLM-driven metadata autoedit pipeline.

Dispatches to the configured AI provider (Ollama, Anthropic, or Claude
Code) to suggest metadata cleanups for tracks based on the current
metadata, the filename, and the top SoundCloud search results.
"""

import json
import logging
from typing import Any

from backend.core.services import anthropic as anthropic_service
from backend.core.services import claude_code as claude_code_service
from backend.core.services import metadata as metadata_service
from backend.core.services import ollama as ollama_service
from backend.core.services import settings as settings_service
from backend.core.services import soundcloud as soundcloud_service
from backend.schemas.metadata import TrackInfoUpdateRequest
from soundcloud_tools.handler.track import TrackInfo

logger = logging.getLogger(__name__)

_MAX_SC_RESULTS = 5

SYSTEM_PROMPT = """You clean up music metadata.

You receive the current metadata of an audio file, its filename, and up to 5
candidate matches from a SoundCloud search. Your job is to propose a cleaned,
normalized version of the metadata.

Rules:
- Fix casing (e.g. "TRACK NAME" -> "Track Name", "deep house" -> "Deep House").
- Extract remix information: "Track (Artist Remix)" -> title "Track",
  remixer ["Artist"], mix_name "Artist Remix".
- Use the SoundCloud match to fill missing fields (genre, release_date) when
  the match looks confident (title + artist align). Never overwrite a
  populated field with a weaker guess.
- Prefer ISO dates ("YYYY-MM-DD") for release_date.
- Only populate fields that should actually change. Omit unchanged fields.
- Output STRICT JSON with keys from this set:
  title, artist, genre, bpm, key, original_artist, remixer, mix_name,
  release_date, release_year, user_comment.
- artist / original_artist / remixer may be a string or a list of strings.
- If nothing is worth changing, return {}."""

FEW_SHOT_EXAMPLES = [
    {
        "input": {
            "filename": "artist_name_-_TRACK_NAME.mp3",
            "current": {"title": "TRACK NAME", "artist": "artist_name", "genre": "deep house"},
            "soundcloud_results": [],
        },
        "output": {
            "title": "Track Name",
            "artist": "Artist Name",
            "genre": "Deep House",
        },
    },
    {
        "input": {
            "filename": "Someone - Track (Remixer Remix).wav",
            "current": {"title": "Track (Remixer Remix)", "artist": "Someone"},
            "soundcloud_results": [],
        },
        "output": {
            "title": "Track",
            "original_artist": "Someone",
            "remixer": ["Remixer"],
            "mix_name": "Remixer Remix",
        },
    },
    {
        "input": {
            "filename": "Artist - Song.mp3",
            "current": {"title": "Song", "artist": "Artist", "genre": None, "release_date": None},
            "soundcloud_results": [
                {"title": "Song", "artist": "Artist", "genre": "Techno", "release_date": "2024-03-12"},
            ],
        },
        "output": {"genre": "Techno", "release_date": "2024-03-12"},
    },
]


_ALLOWED_FIELDS = {
    "title",
    "artist",
    "genre",
    "bpm",
    "key",
    "original_artist",
    "remixer",
    "mix_name",
    "release_date",
    "release_year",
    "user_comment",
}


def _current_metadata_for_prompt(track_info: TrackInfo) -> dict[str, Any]:
    """Flatten the current metadata to plain JSON-safe values for the prompt."""
    data = track_info.model_dump(mode="json", exclude_none=True, include=_ALLOWED_FIELDS)
    return {k: v for k, v in data.items() if k in _ALLOWED_FIELDS}


def _build_messages(
    current: dict[str, Any],
    filename: str,
    sc_results: list[dict[str, Any]],
) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for example in FEW_SHOT_EXAMPLES:
        messages.append({"role": "user", "content": json.dumps(example["input"], ensure_ascii=False)})
        messages.append({"role": "assistant", "content": json.dumps(example["output"], ensure_ascii=False)})
    payload = {"filename": filename, "current": current, "soundcloud_results": sc_results}
    messages.append({"role": "user", "content": json.dumps(payload, ensure_ascii=False)})
    return messages


async def _chat_with_active_provider(messages: list[dict[str, str]]) -> str:
    provider = settings_service.load().ai.provider
    if provider == "anthropic":
        return await anthropic_service.chat(messages, format="json")
    if provider == "claude_code":
        return await claude_code_service.chat(messages, format="json")
    return await ollama_service.chat(messages, format="json")


def _parse_llm_output(raw: str) -> dict[str, Any]:
    """Best-effort JSON extraction; strips accidental prose around the object."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            logger.warning("Failed to recover JSON from LLM output: %r", raw[:200])
    return {}


async def autoedit(
    track_info: TrackInfo,
    filename: str,
    access_token: str | None = None,
) -> dict[str, Any]:
    """Run the autoedit pipeline for a single file.

    Returns a dict with ``suggestions`` (validated ``TrackInfoUpdateRequest``)
    and ``soundcloud_match`` (top SoundCloud candidate, if any).

    ``access_token`` is the user's SoundCloud OAuth token; if omitted, the
    SoundCloud search is skipped.
    """
    current = _current_metadata_for_prompt(track_info)

    query_seed = " ".join(filter(None, [str(track_info.artist or ""), track_info.title or ""])).strip()
    query = metadata_service.prepare_search_query(query_seed or filename)

    sc_results: list[dict[str, Any]] = []
    if query and access_token:
        try:
            sc_results = (await soundcloud_service.search_tracks_with_token(access_token, query))[:_MAX_SC_RESULTS]
        except Exception:
            logger.exception("SoundCloud search failed for autoedit; continuing without it")

    messages = _build_messages(current, filename, sc_results)
    raw = await _chat_with_active_provider(messages)
    parsed = _parse_llm_output(raw)

    filtered = {k: v for k, v in parsed.items() if k in _ALLOWED_FIELDS and v not in (None, "", [])}
    suggestions = TrackInfoUpdateRequest.model_validate(filtered)

    return {
        "suggestions": suggestions,
        "soundcloud_match": sc_results[0] if sc_results else None,
    }
