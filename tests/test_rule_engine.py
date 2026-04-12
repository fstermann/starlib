"""Tests for the rule engine (registry-based execution)."""

from pathlib import Path
from unittest.mock import MagicMock, patch

from backend.core.services.rule_engine import execute_ruleset
from backend.schemas.ruleset import Rule, Ruleset

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ruleset(*rules: Rule) -> Ruleset:
    return Ruleset(id="test", name="Test", rules=list(rules))


# ---------------------------------------------------------------------------
# Input resolution / skipping
# ---------------------------------------------------------------------------


def test_rule_skipped_when_input_unavailable(tmp_path: Path) -> None:
    """A rule whose input ref isn't in the registry is skipped, not crashed."""
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")

    move_mock = MagicMock()
    with patch("backend.core.services.rule_engine._run_move", move_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="m1", type="move", input="convert.converted", params={"folder": "cleaned"}),
            ),
        )

    move_mock.assert_not_called()
    assert "Skipped move" in result["message"]


def test_rule_runs_when_input_resolves(tmp_path: Path) -> None:
    """A rule that points at an earlier rule's output runs once that output exists."""
    audio = tmp_path / "track.wav"
    audio.write_bytes(b"fake")
    converted = tmp_path / "track.aiff"

    handler_mock = MagicMock()
    handler_mock.convert.return_value = converted
    handler_mock.copy_tags_to.return_value = None
    handler_mock.move_to.return_value = tmp_path / "cleaned" / "track.aiff"

    with (
        patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock),
        patch("backend.core.services.app_settings.get_preferred_output_format", return_value="aiff"),
    ):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
                Rule(id="mv", type="move", input="conv.converted", params={"folder": "cleaned"}),
            ),
        )

    handler_mock.move_to.assert_called_once()
    assert "conv.converted" in result["outputs"]
    assert "mv.moved" in result["outputs"]


def test_rule_skipped_when_required_ref_missing(tmp_path: Path) -> None:
    """A rule with ``requires`` is skipped when any required ref is absent."""
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")

    handler_mock = MagicMock()  # convert is a no-op (already aiff) → no `converted` output

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
                Rule(
                    id="cp",
                    type="copy",
                    input="conv.original",
                    requires=["conv.converted"],
                    params={"folder": "archive"},
                ),
            ),
        )

    handler_mock.copy_to.assert_not_called()
    assert "cp.copy" not in result["outputs"]
    assert "requires conv.converted" in result["message"]


def test_rule_runs_when_required_ref_present(tmp_path: Path) -> None:
    """A rule with ``requires`` runs once all required refs exist."""
    audio = tmp_path / "track.wav"
    audio.write_bytes(b"fake")
    converted = tmp_path / "track.aiff"

    handler_mock = MagicMock()
    handler_mock.convert.return_value = converted
    handler_mock.copy_tags_to.return_value = None
    handler_mock.copy_to.return_value = tmp_path / "archive" / "track.wav"

    with (
        patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock),
        patch("backend.core.services.app_settings.get_preferred_output_format", return_value="aiff"),
    ):
        execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
                Rule(
                    id="cp",
                    type="copy",
                    input="conv.original",
                    requires=["conv.converted"],
                    params={"folder": "archive"},
                ),
            ),
        )

    handler_mock.copy_to.assert_called_once()


def test_source_input_runs_unconditionally(tmp_path: Path) -> None:
    """Rules pointing at ``source`` always run regardless of other rules."""
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")

    move_mock = MagicMock(return_value={"moved": tmp_path / "cleaned" / "track.aiff"})
    with patch("backend.core.services.rule_engine._run_move", move_mock):
        execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="m1", type="move", input="source", params={"folder": "cleaned"}),
            ),
        )

    move_mock.assert_called_once()


# ---------------------------------------------------------------------------
# Output namespaces
# ---------------------------------------------------------------------------


def test_convert_exposes_original_alias(tmp_path: Path) -> None:
    """Even on no-op conversion, ``convert.original`` is in the registry."""
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")

    handler_mock = MagicMock()
    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
            ),
        )

    handler_mock.convert.assert_not_called()
    assert "conv.original" in result["outputs"]
    assert "conv.converted" not in result["outputs"]
    # result falls back to original when conversion is a no-op
    assert result["outputs"]["conv.result"] == result["outputs"]["conv.original"]
    assert "No conversion needed" in result["message"]


def test_convert_exposes_converted_on_success(tmp_path: Path) -> None:
    audio = tmp_path / "track.wav"
    audio.write_bytes(b"fake")
    converted = tmp_path / "track.aiff"

    handler_mock = MagicMock()
    handler_mock.convert.return_value = converted

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
            ),
        )

    assert result["outputs"]["conv.converted"].endswith("track.aiff")
    assert result["outputs"]["conv.original"].endswith("track.wav")
    # result points at the converted file on success
    assert result["outputs"]["conv.result"] == result["outputs"]["conv.converted"]


def test_convert_skips_when_handler_returns_none(tmp_path: Path) -> None:
    """Incompatible source format → no ``converted`` output, no crash."""
    audio = tmp_path / "track.mp3"
    audio.write_bytes(b"fake")

    handler_mock = MagicMock()
    handler_mock.convert.return_value = None

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
            ),
        )

    assert "conv.converted" not in result["outputs"]
    # result falls back to original on incompatible source
    assert result["outputs"]["conv.result"] == result["outputs"]["conv.original"]
    assert "skipped" in result["message"]


def test_copy_exposes_original_and_copy(tmp_path: Path) -> None:
    """A ``copy`` rule produces both the original alias and the new copy path."""
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")

    handler_mock = MagicMock()
    handler_mock.copy_to.return_value = tmp_path / "archive" / "track.aiff"

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="cp", type="copy", input="source", params={"folder": "archive"}),
            ),
        )

    handler_mock.copy_to.assert_called_once()
    assert result["outputs"]["cp.original"].endswith("track.aiff")
    assert result["outputs"]["cp.copy"].endswith("archive/track.aiff")


def test_move_produces_moved_output(tmp_path: Path) -> None:
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")
    new_path = tmp_path / "cleaned" / "track.aiff"

    handler_mock = MagicMock()
    handler_mock.move_to.return_value = new_path

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="mv", type="move", input="source", params={"folder": "cleaned"}),
            ),
        )

    assert result["outputs"]["mv.moved"] == str(new_path)
    assert result["output_path"] == str(new_path)


# ---------------------------------------------------------------------------
# Format resolution
# ---------------------------------------------------------------------------


def test_convert_resolves_preferred_from_app_settings(tmp_path: Path) -> None:
    audio = tmp_path / "track.wav"
    audio.write_bytes(b"fake")
    converted = tmp_path / "track.mp3"

    handler_mock = MagicMock()
    handler_mock.convert.return_value = converted
    handler_mock.copy_tags_to.return_value = None

    with (
        patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock),
        patch(
            "backend.core.services.app_settings.get_preferred_output_format",
            return_value="mp3",
        ),
    ):
        execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "preferred"}),
            ),
        )

    handler_mock.convert.assert_called_once_with("mp3", output_dir=tmp_path, quality=320)


def test_convert_uses_explicit_format(tmp_path: Path) -> None:
    audio = tmp_path / "track.wav"
    audio.write_bytes(b"fake")
    converted = tmp_path / "track.aiff"

    handler_mock = MagicMock()
    handler_mock.convert.return_value = converted

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_ruleset(
                Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
            ),
        )

    handler_mock.convert.assert_called_once_with("aiff", output_dir=tmp_path, quality=320)


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


def test_execute_ruleset_returns_expected_keys(tmp_path: Path) -> None:
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")

    result = execute_ruleset(
        file_path=audio,
        root_folder=tmp_path,
        ruleset=_ruleset(),
    )

    assert set(result) == {"success", "message", "output_path", "outputs", "steps"}
    assert result["success"] is True
    assert result["output_path"] == str(audio)
    assert result["outputs"] == {"source": str(audio)}


# ---------------------------------------------------------------------------
# Full Classic workflow
# ---------------------------------------------------------------------------


def _classic_ruleset() -> Ruleset:
    """The Classic ruleset shape (convert → archive original if converted, move result to cleaned)."""
    return Ruleset(
        id="classic",
        name="Classic",
        rules=[
            Rule(id="conv", type="convert", input="source", params={"format": "aiff"}),
            Rule(
                id="arch", type="move", input="conv.original", requires=["conv.converted"], params={"folder": "archive"}
            ),
            Rule(id="mv", type="move", input="conv.result", params={"folder": "cleaned"}),
        ],
    )


def test_classic_workflow_conversion_happened(tmp_path: Path) -> None:
    """When conversion produces a file: converted → cleaned, original → archive."""
    audio = tmp_path / "track.wav"
    audio.write_bytes(b"fake")
    converted = tmp_path / "track.aiff"

    handler_mock = MagicMock()
    handler_mock.convert.return_value = converted
    handler_mock.copy_tags_to.return_value = None
    handler_mock.move_to.side_effect = lambda folder: folder / "track.aiff"

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_classic_ruleset(),
        )

    assert result["success"] is True
    # move_to called twice: archive first (original), then cleaned (converted)
    assert handler_mock.move_to.call_count == 2
    archive_call, cleaned_call = handler_mock.move_to.call_args_list
    assert archive_call.args[0] == tmp_path / "archive"
    assert cleaned_call.args[0] == tmp_path / "cleaned"


def test_classic_workflow_no_conversion(tmp_path: Path) -> None:
    """When file is already target format: original → cleaned, archive skipped."""
    audio = tmp_path / "track.aiff"
    audio.write_bytes(b"fake")
    cleaned_path = tmp_path / "cleaned" / "track.aiff"

    handler_mock = MagicMock()
    handler_mock.move_to.return_value = cleaned_path

    with patch("backend.core.services.rule_engine.TrackHandler", return_value=handler_mock):
        result = execute_ruleset(
            file_path=audio,
            root_folder=tmp_path,
            ruleset=_classic_ruleset(),
        )

    assert result["success"] is True
    # Only one move: the original to cleaned. Archive is skipped.
    handler_mock.move_to.assert_called_once()
    assert handler_mock.move_to.call_args.args[0] == tmp_path / "cleaned"
    assert result["output_path"] == str(cleaned_path)
    assert "requires conv.converted" in result["message"]
