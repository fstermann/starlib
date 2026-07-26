"""Field-suggester registry.

Adding a new field-level suggester:

1. Create a module in this package exposing a class that satisfies
   :class:`backend.domain.suggestions.engine.FieldSuggester`.
2. Append an instance to ``REGISTRY`` below.

The engine imports ``REGISTRY`` lazily so circular imports don't bite.
"""

from __future__ import annotations

from backend.domain.suggestions.suggesters.artist import (
    ArtistSuggester,
    OriginalArtistSuggester,
    RemixerSuggester,
)
from backend.domain.suggestions.suggesters.artwork import ArtworkSuggester
from backend.domain.suggestions.suggesters.bpm_key import BPMSuggester, KeySuggester
from backend.domain.suggestions.suggesters.genre import GenreSuggester
from backend.domain.suggestions.suggesters.mix_name import MixNameSuggester
from backend.domain.suggestions.suggesters.release import (
    ReleaseDateSuggester,
    ReleaseYearSuggester,
)
from backend.domain.suggestions.suggesters.title import TitleSuggester
from backend.domain.suggestions.types import FieldSuggester

REGISTRY: list[FieldSuggester] = [
    TitleSuggester(),
    ArtistSuggester(),
    OriginalArtistSuggester(),
    RemixerSuggester(),
    MixNameSuggester(),
    GenreSuggester(),
    ReleaseDateSuggester(),
    ReleaseYearSuggester(),
    ArtworkSuggester(),
    BPMSuggester(),
    KeySuggester(),
]
