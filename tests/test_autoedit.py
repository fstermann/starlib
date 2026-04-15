"""Tests for the LLM autoedit service."""

import json
from datetime import date
from unittest.mock import AsyncMock, patch

import pytest

from backend.core.services import autoedit
from soundcloud_tools.handler.track import TrackInfo


@pytest.fixture
def track_info() -> TrackInfo:
    return TrackInfo(
        title="TRACK NAME",
        artist="artist name",
        genre="deep house",
    )


@pytest.mark.asyncio
async def test_autoedit_returns_validated_suggestions(track_info: TrackInfo) -> None:
    llm_output = json.dumps({"title": "Track Name", "artist": "Artist Name", "genre": "Deep House"})

    with (
        patch(
            "backend.core.services.autoedit.soundcloud_service.search_tracks_with_token",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "backend.core.services.autoedit.ollama_service.chat",
            new_callable=AsyncMock,
            return_value=llm_output,
        ),
    ):
        result = await autoedit.autoedit(track_info, "artist_name_-_TRACK_NAME.mp3")

    assert result["soundcloud_match"] is None
    suggestions = result["suggestions"]
    assert suggestions.title == "Track Name"
    assert suggestions.artist == "Artist Name"
    assert suggestions.genre == "Deep House"


@pytest.mark.asyncio
async def test_autoedit_drops_unknown_fields_and_empty_values(track_info: TrackInfo) -> None:
    llm_output = json.dumps(
        {
            "title": "Track Name",
            "genre": "",
            "nonsense": "ignored",
            "bpm": None,
        }
    )

    with (
        patch(
            "backend.core.services.autoedit.soundcloud_service.search_tracks_with_token",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "backend.core.services.autoedit.ollama_service.chat",
            new_callable=AsyncMock,
            return_value=llm_output,
        ),
    ):
        result = await autoedit.autoedit(track_info, "file.mp3")

    dumped = result["suggestions"].model_dump(exclude_unset=True)
    assert dumped == {"title": "Track Name"}


@pytest.mark.asyncio
async def test_autoedit_recovers_from_junk_around_json(track_info: TrackInfo) -> None:
    llm_output = 'Sure, here you go: {"title": "Clean Title"} — hope that helps!'

    with (
        patch(
            "backend.core.services.autoedit.soundcloud_service.search_tracks_with_token",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "backend.core.services.autoedit.ollama_service.chat",
            new_callable=AsyncMock,
            return_value=llm_output,
        ),
    ):
        result = await autoedit.autoedit(track_info, "file.mp3")

    assert result["suggestions"].title == "Clean Title"


@pytest.mark.asyncio
async def test_autoedit_continues_when_soundcloud_search_fails(track_info: TrackInfo) -> None:
    with (
        patch(
            "backend.core.services.autoedit.soundcloud_service.search_tracks_with_token",
            new_callable=AsyncMock,
            side_effect=RuntimeError("SC down"),
        ),
        patch(
            "backend.core.services.autoedit.ollama_service.chat",
            new_callable=AsyncMock,
            return_value="{}",
        ),
    ):
        result = await autoedit.autoedit(track_info, "file.mp3", access_token="tok")

    assert result["soundcloud_match"] is None
    assert result["suggestions"].model_dump(exclude_unset=True) == {}


def test_parse_llm_output_handles_raw_json() -> None:
    assert autoedit._parse_llm_output('{"a": 1}') == {"a": 1}


def test_parse_llm_output_returns_empty_on_garbage() -> None:
    assert autoedit._parse_llm_output("no json here") == {}


def test_current_metadata_for_prompt_serializes_dates() -> None:
    info = TrackInfo(title="T", release_date=date(2024, 1, 2))
    out = autoedit._current_metadata_for_prompt(info)
    assert out["title"] == "T"
    assert out["release_date"] == "2024-01-02"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "patched"),
    [
        ("ollama", "backend.core.services.autoedit.ollama_service.chat"),
        ("anthropic", "backend.core.services.autoedit.anthropic_service.chat"),
        ("claude_code", "backend.core.services.autoedit.claude_code_service.chat"),
    ],
)
async def test_autoedit_dispatches_to_configured_provider(
    track_info: TrackInfo,
    provider: str,
    patched: str,
) -> None:
    from backend.schemas.ai import AiSettings
    from backend.schemas.settings import Settings

    settings = Settings(ai=AiSettings(provider=provider))  # type: ignore[arg-type]

    with (
        patch(
            "backend.core.services.autoedit.settings_service.load",
            return_value=settings,
        ),
        patch(
            "backend.core.services.autoedit.soundcloud_service.search_tracks_with_token",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(patched, new_callable=AsyncMock, return_value="{}") as mock_chat,
    ):
        await autoedit.autoedit(track_info, "file.mp3")

    mock_chat.assert_awaited_once()
