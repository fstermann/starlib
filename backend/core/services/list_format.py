"""Helpers for list-shaped text fields (artist, original_artist, remixer).

Two transformations:

- :func:`normalize_list` parses ``"A & B feat. C"``-style strings into a
  comma-joined canonical form.
- :func:`aggregate_distinct` unions distinct names from multiple sources into
  one comma-joined string, used when several suggesters independently name
  different people.

The split regex is intentionally permissive — DJ release naming varies wildly
(``&``, ``and``, ``feat.``, ``ft.``, ``x``, ``vs.``, multiplication-sign,
plain commas, sometimes mixed). False positives are cheap (a normalized
variant becomes one extra ranked candidate); false negatives mean the user
has to keep typing.
"""

from __future__ import annotations

import re

# Match common DJ-release separators. Word separators (``and``, ``feat.``, ``x``,
# ``vs.``) require a leading word-boundary so a stray ``x`` mid-word doesn't
# split, plus a trailing whitespace-or-end so ``feature`` doesn't false-match.
_SEPARATOR_RE = re.compile(
    r"\s*(?:,|&|×|\b(?:and|feat\.?|ft\.?|x|vs\.?)(?=\s|$))\s*",  # noqa: RUF001
    flags=re.IGNORECASE,
)


def split_list(value: str) -> list[str]:
    """Split a single combined string into canonical individual names."""
    if not value:
        return []
    parts = [p.strip() for p in _SEPARATOR_RE.split(value)]
    return [p for p in parts if p]


def normalize_list(value: str) -> str:
    """Re-render ``value`` with consistent comma separation.

    Returns the input unchanged (whitespace-trimmed) when it doesn't contain
    any recognised separator, so single-name values pass through cleanly.
    """
    if not value:
        return ""
    parts = split_list(value)
    if len(parts) <= 1:
        return value.strip()
    return ", ".join(parts)


def aggregate_distinct(values: list[str]) -> str:
    """Union of distinct names across multiple inputs (case-insensitive dedup).

    Each input is split into its constituent names first, so feeding in
    ``["A & B", "C"]`` yields ``"A, B, C"``. Order follows first-seen.
    Empty/whitespace inputs are dropped.
    """
    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        if not raw:
            continue
        for part in split_list(raw):
            key = part.casefold()
            if key in seen:
                continue
            seen.add(key)
            out.append(part)
    return ", ".join(out)
