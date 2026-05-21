"""Shared helpers for field suggesters.

Suggesters are intentionally small — one per field — but every one of them
needs the same handful of trivial utilities (clean, build a candidate, dedupe
by value while preserving order). Putting them here keeps the suggester
modules below a screen each.
"""

from __future__ import annotations

from typing import Any

from backend.schemas.suggestions import FieldSuggestion, SuggestionSource


def clean(value: Any) -> Any:
    """Normalise empty/whitespace strings to ``None``; pass through other types."""
    if isinstance(value, str):
        s = value.strip()
        return s or None
    return value


def candidate(
    value: Any,
    *,
    source: SuggestionSource,
    confidence: float,
    label: str,
) -> FieldSuggestion | None:
    """Build a :class:`FieldSuggestion`, returning ``None`` when ``value`` is empty.

    Suggesters call this for every potential candidate and filter ``None`` at
    the end with :func:`compact`. The pattern keeps the call site readable
    without conditionals on every line.
    """
    cleaned = clean(value)
    if cleaned is None or cleaned == "":
        return None
    return FieldSuggestion(
        value=cleaned,
        source=source,
        confidence=confidence,
        label=label,
    )


def compact(values: list[FieldSuggestion | None]) -> list[FieldSuggestion]:
    """Drop ``None`` and dedupe by value (case-insensitive for strings).

    Order is preserved so a suggester can express "this candidate beats that
    one" by listing it earlier — duplicates after the first are dropped.
    """
    seen: set[Any] = set()
    out: list[FieldSuggestion] = []
    for s in values:
        if s is None:
            continue
        key = s.value.casefold() if isinstance(s.value, str) else s.value
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out
