"""Tests for the list-field formatter used by suggesters."""

from __future__ import annotations

import pytest

from backend.core.services.list_format import (
    aggregate_distinct,
    normalize_list,
    split_list,
)


@pytest.mark.parametrize(
    "value,expected",
    [
        ("A & B", ["A", "B"]),
        ("A and B", ["A", "B"]),
        ("A, B, C", ["A", "B", "C"]),
        ("A feat. B", ["A", "B"]),
        ("A ft. B", ["A", "B"]),
        ("A ft B", ["A", "B"]),
        ("A x B", ["A", "B"]),
        ("A × B", ["A", "B"]),  # noqa: RUF001
        ("A vs. B", ["A", "B"]),
        ("A vs B", ["A", "B"]),
        ("A & B feat. C", ["A", "B", "C"]),
        ("A,B,  C", ["A", "B", "C"]),
        ("A", ["A"]),
        ("", []),
    ],
)
def test_split_list(value: str, expected: list[str]) -> None:
    assert split_list(value) == expected


def test_normalize_list_joins_with_comma() -> None:
    assert normalize_list("A & B feat. C") == "A, B, C"


def test_normalize_list_passthrough_for_single_name() -> None:
    assert normalize_list("Some Artist") == "Some Artist"


def test_normalize_list_trims_whitespace() -> None:
    assert normalize_list("  Some Artist  ") == "Some Artist"


def test_normalize_list_already_canonical_is_idempotent() -> None:
    canonical = "A, B, C"
    assert normalize_list(canonical) == canonical


def test_normalize_list_empty() -> None:
    assert normalize_list("") == ""


def test_aggregate_distinct_unions_unique_names() -> None:
    assert aggregate_distinct(["A", "B"]) == "A, B"


def test_aggregate_distinct_dedupes_case_insensitively() -> None:
    assert aggregate_distinct(["Foo", "foo", "Bar"]) == "Foo, Bar"


def test_aggregate_distinct_splits_compound_inputs() -> None:
    assert aggregate_distinct(["A & B", "C"]) == "A, B, C"


def test_aggregate_distinct_drops_empties() -> None:
    assert aggregate_distinct(["", "A", "  ", "B"]) == "A, B"


def test_aggregate_distinct_preserves_first_casing() -> None:
    """When the same name appears with different casing, the first wins."""
    assert aggregate_distinct(["DJ Foo", "dj foo"]) == "DJ Foo"


def test_aggregate_distinct_empty_input() -> None:
    assert aggregate_distinct([]) == ""
