"""Field-suggester registry.

Adding a new field-level suggester:

1. Create a module in this package exposing a class that satisfies
   :class:`backend.core.services.suggestion_engine.FieldSuggester`.
2. Append an instance to ``REGISTRY`` below.

The engine imports ``REGISTRY`` lazily so circular imports don't bite.
"""

from __future__ import annotations

from backend.core.services.suggesters.artist import (
    ArtistSuggester,
    OriginalArtistSuggester,
    RemixerSuggester,
)
from backend.core.services.suggesters.artwork import ArtworkSuggester
from backend.core.services.suggesters.bpm_key import BPMSuggester, KeySuggester
from backend.core.services.suggesters.genre import GenreSuggester
from backend.core.services.suggesters.mix_name import MixNameSuggester
from backend.core.services.suggesters.release import (
    ReleaseDateSuggester,
    ReleaseYearSuggester,
)
from backend.core.services.suggesters.title import TitleSuggester
from backend.core.services.suggestion_engine import FieldSuggester

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
