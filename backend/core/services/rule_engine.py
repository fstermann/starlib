"""Rule engine for executing custom finalization rulesets.

Each rule declares an explicit ``input`` reference and produces a set of
**named outputs**. The engine maintains a registry mapping
``"<rule_id>.<output_name>"`` → ``Path`` (seeded with ``"source"`` →
the input file). Subsequent rules consume earlier outputs by reference.

Rule output namespaces:

- ``move`` → ``moved``
- ``copy`` → ``original``, ``copy``
- ``convert`` → ``original`` (always), ``converted`` (only on success)

If a rule's ``input`` resolves to a missing key (e.g. ``convert.converted``
when conversion didn't happen), the rule is skipped. This naturally replaces
the old global ``if_converted`` flag.
"""

import logging
from pathlib import Path
from typing import Any

from backend.schemas.ruleset import Rule, Ruleset
from soundcloud_tools.handler.track import TrackHandler

logger = logging.getLogger(__name__)

SOURCE_KEY = "source"


def execute_ruleset(
    file_path: Path,
    root_folder: Path,
    ruleset: Ruleset,
) -> dict[str, Any]:
    """Execute a ruleset against a single file.

    Parameters
    ----------
    file_path:
        Absolute path to the source audio file.
    root_folder:
        Root of the music library (e.g. ``~/Music/tracks``).
    ruleset:
        The ordered list of rules to run.

    Returns
    -------
    dict
        Keys: ``success`` (bool), ``message`` (str), ``output_path`` (str),
        ``outputs`` (dict[str, str]) — the full registry snapshot.
    """
    registry: dict[str, Path] = {SOURCE_KEY: file_path}
    messages: list[str] = []
    steps: list[dict] = []
    last_new_path: Path = file_path

    for rule in ruleset.rules:
        input_path = registry.get(rule.input)
        if input_path is None:
            logger.debug("Skipping %s rule %r — input %r not in registry", rule.type, rule.id, rule.input)
            messages.append(f"Skipped {rule.type} (input {rule.input!r} unavailable)")
            msg = f"input {rule.input!r} unavailable"
            steps.append({"id": rule.id, "type": rule.type, "status": "skipped", "message": msg})
            continue

        unmet = [ref for ref in rule.requires if ref not in registry]
        if unmet:
            logger.debug("Skipping %s rule %r — required outputs missing: %s", rule.type, rule.id, unmet)
            messages.append(f"Skipped {rule.type} (requires {', '.join(unmet)})")
            msg = f"requires {', '.join(unmet)}"
            steps.append({"id": rule.id, "type": rule.type, "status": "skipped", "message": msg})
            continue

        outputs = _dispatch(rule, input_path, root_folder, messages)
        for name, path in outputs.items():
            registry[f"{rule.id}.{name}"] = path
            if path != input_path:
                last_new_path = path
        steps.append({"id": rule.id, "type": rule.type, "status": "done", "message": messages[-1] if messages else ""})

    return {
        "success": True,
        "message": "; ".join(messages) if messages else "Finalization complete",
        "output_path": str(last_new_path),
        "outputs": {k: str(v) for k, v in registry.items()},
        "steps": steps,
    }


def _dispatch(rule: Rule, input_path: Path, root_folder: Path, messages: list[str]) -> dict[str, Path]:
    if rule.type == "convert":
        return _run_convert(input_path, root_folder, rule.params, messages)
    if rule.type == "copy":
        return _run_copy(input_path, root_folder, rule.params, messages)
    if rule.type == "move":
        return _run_move(input_path, root_folder, rule.params, messages)
    logger.warning("Unknown rule type %r — skipping", rule.type)
    return {}


def _run_convert(input_path: Path, root_folder: Path, params: dict, messages: list[str]) -> dict[str, Path]:
    from typing import Literal, cast

    from backend.core.services import app_settings as app_settings_service

    AudioFormat = Literal["mp3", "aiff"]
    raw_format: str = params.get("format", "preferred")
    target_format = cast(
        AudioFormat,
        app_settings_service.get_preferred_output_format() if raw_format == "preferred" else raw_format,
    )
    quality: int = int(params.get("quality", 320))

    outputs: dict[str, Path] = {"original": input_path}

    current_ext = input_path.suffix.lstrip(".")
    if current_ext == target_format:
        logger.debug("Convert: %s already in %s — no-op", input_path.name, target_format)
        messages.append(f"No conversion needed (already {target_format})")
        outputs["result"] = input_path
        return outputs

    handler = TrackHandler(root_folder=root_folder, file=input_path)
    converted_path = handler.convert(target_format, output_dir=input_path.parent, quality=quality)

    if converted_path is None:
        messages.append(f"Conversion to {target_format} skipped (incompatible source format)")
        outputs["result"] = input_path
        return outputs

    handler.copy_tags_to(converted_path)
    outputs["converted"] = converted_path
    outputs["result"] = converted_path
    messages.append(f"Converted to {target_format}")
    logger.info("Converted %s → %s", input_path.name, converted_path.name)
    return outputs


def _run_copy(input_path: Path, root_folder: Path, params: dict, messages: list[str]) -> dict[str, Path]:
    folder_name: str = params.get("folder", "archive")
    folder = root_folder / folder_name

    if not input_path.exists():
        logger.debug("Copy: %s no longer exists — skipping", input_path)
        messages.append(f"Copy skipped ({input_path.name} not found)")
        return {"original": input_path}

    handler = TrackHandler(root_folder=root_folder, file=input_path)
    copied_path = handler.copy_to(folder)
    messages.append(f"Copied to {folder_name}/")
    logger.info("Copied %s → %s/", input_path.name, folder_name)
    return {"original": input_path, "copy": copied_path}


def _run_move(input_path: Path, root_folder: Path, params: dict, messages: list[str]) -> dict[str, Path]:
    folder_name: str = params.get("folder", "cleaned")
    folder = root_folder / folder_name

    handler = TrackHandler(root_folder=root_folder, file=input_path)
    new_path = handler.move_to(folder)
    messages.append(f"Moved to {folder_name}/")
    logger.info("Moved %s → %s/", input_path.name, folder_name)
    return {"moved": new_path}
