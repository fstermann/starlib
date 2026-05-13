"""Artist suggester.

Builds candidates from four independent sources (SC metadata_artist, SC
uploader name, dash-prefix in the SC title, dash-prefix in the local
filename), ranks them with :func:`rank_artists`, and emits two extra
list-formatting candidates:

- ``list_normalized``: any source value that contains separators (``A & B``)
  re-rendered as ``"A, B"``.
- ``list_aggregated``: union of distinct names across sources, comma-joined.

The aggregated candidate is the one that lets a user click once when they
have a SC track with one artist and a filename with another.
"""

from __future__ import annotations

from backend.core.services.list_format import aggregate_distinct, normalize_list, split_list
from backend.core.services.suggesters._base import candidate, compact
from backend.core.services.suggestion_engine import SuggestionContext
from backend.schemas.suggestions import FieldName, FieldSuggestion, SuggestionSource
from soundcloud_tools.handler.artist_ranking import rank_artists


def _collect_sources(ctx: SuggestionContext) -> list[tuple[str, SuggestionSource, str]]:
    """Return ``[(value, source, label), ...]`` for every non-empty raw input.

    Both the dash-prefix (``first_artist``) and the parens-content
    (``mix_artist``) parsed out of the SC title are emitted — the ranker uses
    them for different roles.
    """
    out: list[tuple[str, SuggestionSource, str]] = []
    sc = ctx.sc_track
    if sc:
        if sc.metadata_artist:
            out.append((sc.metadata_artist, "sc_metadata_artist", "SoundCloud metadata artist"))
        if sc.user and sc.user.username:
            out.append((sc.user.username, "sc_uploader", "SoundCloud uploader"))
        if ctx.sc_parsed:
            if ctx.sc_parsed.first_artist:
                out.append((ctx.sc_parsed.first_artist, "sc_title", "from SoundCloud title (lead)"))
            if ctx.sc_parsed.mix_artist:
                out.append((ctx.sc_parsed.mix_artist, "sc_title", "from SoundCloud title (remix)"))
    if ctx.filename_parsed.artist:
        out.append((ctx.filename_parsed.artist, "filename_parse", "from filename"))
    return out


def _build_artist_candidates(
    ctx: SuggestionContext,
    *,
    role,  # ArtistRole
    sc_title: str | None,
) -> list[FieldSuggestion]:
    sources = _collect_sources(ctx)
    if not sources:
        return []

    # Map value → (source, label) using *first*-write-wins so the highest-
    # priority source for a duplicated value owns the attribution. ``sources``
    # is already in priority order (see ``_collect_sources``).
    by_value: dict[str, tuple[SuggestionSource, str]] = {}
    for value, source, label in sources:
        if value not in by_value:
            by_value[value] = (source, label)
    ranked_values = rank_artists(
        list(by_value.keys()),
        title=sc_title or "",
        role=role,
    )

    base_confidences: dict[SuggestionSource, float] = {
        "sc_metadata_artist": 0.9,
        "sc_title": 0.7,
        "sc_uploader": 0.6,
        "filename_parse": 0.5,
    }

    out: list[FieldSuggestion | None] = []
    for i, value in enumerate(ranked_values):
        source, label = by_value[value]
        # Slight boost for the top-ranked candidate so the engine sorts it
        # above lower-priority sources at the same base confidence.
        boost = 0.05 if i == 0 else 0.0
        out.append(
            candidate(
                value,
                source=source,
                confidence=min(base_confidences[source] + boost, 1.0),
                label=label,
            )
        )

        # Per-source list normalisation when the raw value contains separators.
        normalized = normalize_list(value)
        if normalized != value and len(split_list(value)) > 1:
            out.append(
                candidate(
                    normalized,
                    source="list_normalized",
                    confidence=base_confidences[source] - 0.05,
                    label=f"{label} (comma-joined)",
                )
            )

    # Cross-source aggregation: only emit when the union really differs from
    # the best single source (otherwise it's just a duplicate ranked lower).
    aggregated = aggregate_distinct(ranked_values)
    if aggregated and (not ranked_values or aggregated.casefold() != ranked_values[0].casefold()):
        avg = sum(base_confidences[by_value[v][0]] for v in ranked_values) / len(ranked_values)
        out.append(
            candidate(
                aggregated,
                source="list_aggregated",
                confidence=avg,
                label="combined from all sources",
            )
        )

    return compact(out)


class ArtistSuggester:
    field: FieldName = "artist"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        sc_title = ctx.sc_track.title if ctx.sc_track else None
        return _build_artist_candidates(ctx, role="artist", sc_title=sc_title)


class OriginalArtistSuggester:
    field: FieldName = "original_artist"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        # Only meaningful for remix titles: the dash-prefix is the original.
        if not ctx.sc_parsed or not ctx.sc_parsed.is_remix:
            return []
        sc_title = ctx.sc_track.title if ctx.sc_track else None
        return _build_artist_candidates(ctx, role="original_artist", sc_title=sc_title)


class RemixerSuggester:
    field: FieldName = "remixer"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        if not ctx.sc_parsed or not ctx.sc_parsed.is_remix:
            return []
        sc_title = ctx.sc_track.title if ctx.sc_track else None
        # Single-source ranking: the parens-content artist usually fills this.
        # Reuse the artist pipeline so list normalisation/aggregation works the
        # same way (a remix could be a duo).
        return _build_artist_candidates(ctx, role="remixer", sc_title=sc_title)
